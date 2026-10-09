// 普通测试不创建 TPM key。真实授权测试必须显式选择隔离 TPM 与防猜测预算。
#include <windows.h>
#include <bcrypt.h>
#include <ncrypt.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <optional>
#include <stdexcept>
#include <string>
#include "citizen_sdk_cng.hpp"
#include "citizen_sdk_directory.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

namespace {
using namespace citizen_sdk::windows;

void expect(bool condition) {
  if (!condition) throw std::runtime_error("CitizenSDK isolated TPM contract failed");
}

SensitiveBuffer test_password() {
  // 公开合成输入，不是生产口令、账户材料或可恢复真实机密的夹具。
  constexpr uint8_t input[] = {'s', 'y', 'n', 't', 'h', 'e', 't', 'i', 'c', '-', 't', 'p', 'm'};
  return SensitiveBuffer(input, sizeof(input));
}

bool isolated_tpm_enabled() {
  wchar_t value[128]{};
  const DWORD length = ::GetEnvironmentVariableW(L"CITIZENSDK_WINDOWS_ISOLATED_TPM_TEST",
                                                  value, 128);
  return length > 0 && length < 128 &&
      std::wstring(value, length) == L"isolated-tpm-and-dictionary-attack-budget";
}

struct NcryptHandle final {
  NCRYPT_HANDLE value{};
  ~NcryptHandle() { if (value != 0) (void)::NCryptFreeObject(value); }
};

void require_authentication_failure(SECURITY_STATUS status) {
  const auto mapped = map_cng_error(static_cast<uint32_t>(status), CITIZENSDK_ERROR_INTERNAL);
  // 锁定、坏格式或丢失 key 不算认证检查通过，避免“全都坏了”形成假阳性。
  expect(status != ERROR_SUCCESS && mapped.code == CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED &&
      !mapped.dictionary_attack_lockout);
}

void unauthorized_decrypt(NCRYPT_PROV_HANDLE provider, const VaultObject &object,
                          const Bytes &wrapped, bool wrong_password) {
  NcryptHandle key;
  const std::wstring name(object.key_name.begin(), object.key_name.end());
  const SECURITY_STATUS opened = ::NCryptOpenKey(provider, &key.value, name.c_str(), 0,
                                                NCRYPT_SILENT_FLAG);
  if (opened != ERROR_SUCCESS) {
    require_authentication_failure(opened);
    return;
  }
  if (wrong_password) {
    // 仅隔离 opt-in 路径提交一次错误授权；生产 availability/open/sign 不运行此探针。
    wchar_t wrong[] = L"synthetic-wrong-authorization";
    const SECURITY_STATUS set = ::NCryptSetProperty(key.value, NCRYPT_PIN_PROPERTY,
        reinterpret_cast<PBYTE>(wrong), static_cast<DWORD>(sizeof(wrong)), NCRYPT_SILENT_FLAG);
    ::SecureZeroMemory(wrong, sizeof(wrong));
    if (set != ERROR_SUCCESS) {
      require_authentication_failure(set);
      return;
    }
  }
  SensitiveBuffer output(32);
  BCRYPT_OAEP_PADDING_INFO padding{BCRYPT_SHA256_ALGORITHM, nullptr, 0};
  DWORD written = 0;
  require_authentication_failure(::NCryptDecrypt(key.value,
      const_cast<PBYTE>(wrapped.data()), static_cast<DWORD>(wrapped.size()),
      &padding, output.data(), 32, &written, NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG));
}

int cold_process_child(int count, wchar_t **arguments) {
  // 子模式也独立检查 opt-in，不能因父进程的参数或缺少环境变量静默跳过后返回成功。
  if (count != 5 || std::wstring(arguments[1]) != L"--isolated-decrypt" ||
      !isolated_tpm_enabled()) return 2;
  try {
    const std::wstring name(arguments[2]);
    const std::wstring ciphertext(arguments[3]);
    const std::wstring mode(arguments[4]);
    const auto hex_digit = [](wchar_t value) -> int {
      if (value >= L'0' && value <= L'9') return value - L'0';
      if (value >= L'a' && value <= L'f') return value - L'a' + 10;
      return -1;
    };
    expect(name.size() == 43 && name.compare(0, 11, L"citizensdk.") == 0 &&
        std::all_of(name.begin() + 11, name.end(),
            [&](wchar_t value) { return hex_digit(value) >= 0; }) &&
        ciphertext.size() == 512 && (mode == L"no-pin" || mode == L"wrong-pin"));
    Bytes wrapped(256);
    for (std::size_t index = 0; index < wrapped.size(); ++index) {
      const int high = hex_digit(ciphertext[index * 2]);
      const int low = hex_digit(ciphertext[index * 2 + 1]);
      expect(high >= 0 && low >= 0);
      wrapped[index] = static_cast<uint8_t>((high << 4) | low);
    }
    VaultObject object;
    object.key_name.reserve(name.size());
    for (const wchar_t value : name) object.key_name.push_back(static_cast<char>(value));
    NcryptHandle provider;
    expect(::NCryptOpenStorageProvider(&provider.value,
        MS_PLATFORM_KEY_STORAGE_PROVIDER, 0) == ERROR_SUCCESS);
    // 冷进程没有父进程的 provider/key 句柄与正确口令；只打开公开名称并尝试一次解密。
    // 只有明确的认证拒绝才成功，锁定、启动失败、无 key 或其它错误均不能冒充通过。
    unauthorized_decrypt(provider.value, object, wrapped, mode == L"wrong-pin");
    return 0;
  } catch (...) { return 1; }
}

void cold_process_rejection(const VaultObject &object, const Bytes &wrapped,
                            bool wrong_password) {
  expect(isolated_tpm_enabled() && wrapped.size() == 256);
  std::array<wchar_t, 32768> executable{};
  const DWORD length = ::GetModuleFileNameW(nullptr, executable.data(),
                                           static_cast<DWORD>(executable.size()));
  expect(length > 0 && length < executable.size());
  std::wstring ciphertext;
  ciphertext.reserve(wrapped.size() * 2);
  constexpr wchar_t digits[] = L"0123456789abcdef";
  for (const uint8_t byte : wrapped) {
    ciphertext.push_back(digits[byte >> 4]);
    ciphertext.push_back(digits[byte & 15]);
  }
  // 命令行仅携带公开 key_name 与 RSA 封装密文；不传 DEK、PIN、口令或账户秘密。
  const std::wstring name(object.key_name.begin(), object.key_name.end());
  std::wstring command = L"\"" + std::wstring(executable.data(), length) +
      L"\" --isolated-decrypt " + name + L" " + ciphertext +
      (wrong_password ? L" wrong-pin" : L" no-pin");
  STARTUPINFOW startup{};
  startup.cb = static_cast<DWORD>(sizeof(startup));
  PROCESS_INFORMATION information{};
  expect(::CreateProcessW(executable.data(), command.data(), nullptr, nullptr, FALSE,
      CREATE_NO_WINDOW, nullptr, nullptr, &startup, &information));
  UniqueHandle process(information.hProcess);
  UniqueHandle thread(information.hThread);
  const DWORD waited = ::WaitForSingleObject(process.get(), 30000);
  if (waited != WAIT_OBJECT_0) {
    // 只终止本次启动且尚未结束的测试子进程；超时从不视作认证拒绝。
    (void)::TerminateProcess(process.get(), 3);
    (void)::WaitForSingleObject(process.get(), 30000);
    expect(false);
  }
  DWORD exit_code = 1;
  expect(::GetExitCodeProcess(process.get(), &exit_code) && exit_code == 0);
}

void isolated_tpm_contract() {
  Cng cng;
  expect(cng.availability() == CngAvailability::kAvailable);
  WalletKey wallet{};
  expect(::BCryptGenRandom(nullptr, wallet.generation.data(),
      static_cast<ULONG>(wallet.generation.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0);
  std::optional<VaultObject> object;
  bool deleted = false;
  try {
    SensitiveBuffer password = test_password();
    object = cng.create_key(wallet, password);
    expect(cng.validate_key(*object));
    SensitiveBuffer input(32);
    expect(::BCryptGenRandom(nullptr, input.data(), 32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0);
    const Bytes wrapped = cng.encrypt_dek(*object, input.data());
    expect(wrapped.size() == 256);
    const auto positive = [&] {
      SensitiveBuffer output(32);
      cng.decrypt_dek(*object, wrapped, password, output.data());
      expect(std::memcmp(output.data(), input.data(), 32) == 0);
    };
    positive();
    // warm 后同 provider 重开、跨 provider 重开、显式错误授权都必须被拒绝。
    // 每个负向之后再跑正确口令，不能把 TPM 全局锁定误判为安全认证。
    NcryptHandle provider;
    expect(::NCryptOpenStorageProvider(&provider.value, MS_PLATFORM_KEY_STORAGE_PROVIDER, 0) == ERROR_SUCCESS);
    unauthorized_decrypt(provider.value, *object, wrapped, false);
    positive();
    unauthorized_decrypt(provider.value, *object, wrapped, true);
    positive();
    {
      NcryptHandle another;
      expect(::NCryptOpenStorageProvider(&another.value, MS_PLATFORM_KEY_STORAGE_PROVIDER, 0) == ERROR_SUCCESS);
      unauthorized_decrypt(another.value, *object, wrapped, false);
    }
    positive();
    // 再用两个独立冷进程覆盖无授权/错误授权；每次后续正向检查保护 DA 失败判定。
    cold_process_rejection(*object, wrapped, false);
    positive();
    cold_process_rejection(*object, wrapped, true);
    positive();
    const VaultObject recovered = cng.create_key(wallet, password);
    expect(recovered.key_name == object->key_name && recovered.public_blob == object->public_blob &&
        recovered.name == object->name && recovered.auth_salt == object->auth_salt);
    VaultObject changed = *object;
    changed.name.back() ^= 1;
    bool rejected = false;
    try { (void)cng.validate_key(changed); }
    catch (const HostError &error) { rejected = error.code() == CITIZENSDK_ERROR_KEY_INVALIDATED; }
    expect(rejected);
    cng.delete_key(wallet, object);
    deleted = true;
    cng.delete_key(wallet, object);  // 精确删除可重试，不扫描其它 key。
  } catch (...) {
    // 异常退出也只清理本测试随机 generation 的 key，不清 TPM、不重置 DA、不枚举。
    if (!deleted) { try { cng.delete_key(wallet, object); } catch (...) {} }
    throw;
  }
}

}  // namespace

int wmain(int count, wchar_t **arguments) {
  if (count > 1) return cold_process_child(count, arguments);
  using namespace citizen_sdk::windows;
  constexpr auto failure = CITIZENSDK_ERROR_INTEGRITY;
  const auto success = map_cng_error(ERROR_SUCCESS, failure);
  assert(success.code == CITIZENSDK_OK && !success.dictionary_attack_lockout);
  for (const auto status : {TPM_E_PCP_AUTHENTICATION_FAILED, TPM_E_KEY_NOT_AUTHENTICATED,
                            TPM_20_E_BAD_AUTH, TPM_20_E_AUTH_FAIL, NTE_SILENT_CONTEXT}) {
    const auto mapped = map_cng_error(static_cast<uint32_t>(status), failure);
    assert(mapped.code == CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED && !mapped.dictionary_attack_lockout);
  }
  for (const auto status : {TPM_E_LOCKED_OUT, TPM_20_E_LOCKOUT, TPM_E_PCP_AUTHENTICATION_IGNORED}) {
    const auto mapped = map_cng_error(static_cast<uint32_t>(status), failure);
    assert(mapped.code == CITIZENSDK_ERROR_UNAVAILABLE && mapped.dictionary_attack_lockout);
  }
  assert(map_cng_error(static_cast<uint32_t>(NTE_USER_CANCELLED), failure).code ==
      CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED);
  assert(map_cng_error(static_cast<uint32_t>(NTE_BAD_KEYSET), failure).code ==
      CITIZENSDK_ERROR_KEY_INVALIDATED);
  assert(map_cng_error(static_cast<uint32_t>(NTE_EXISTS), failure).code == CITIZENSDK_ERROR_CONFLICT);
  assert(map_cng_error(0xdeadbeefu, failure).code == failure);

  const CngKeyProperties valid{2048, 0, NCRYPT_ALLOW_DECRYPT_FLAG, 0,
      NCRYPT_PCP_ENCRYPTION_KEY, true, false};
  validate_cng_key_properties(valid);
  for (int field = 0; field < 7; ++field) {
    auto changed = valid;
    switch (field) {
      case 0: changed.length = 1024; break;
      case 1: changed.key_type = NCRYPT_MACHINE_KEY_FLAG; break;
      case 2: changed.key_usage |= NCRYPT_ALLOW_SIGNING_FLAG; break;
      case 3: changed.export_policy = NCRYPT_ALLOW_EXPORT_FLAG; break;
      case 4: changed.pcp_key_usage = NCRYPT_PCP_GENERIC_KEY; break;
      case 5: changed.password_required = false; break;
      case 6: changed.export_allowed = true; break;
    }
    bool rejected = false;
    try { validate_cng_key_properties(changed); }
    catch (const HostError &error) { rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY; }
    assert(rejected);
  }

  // 格式边界使用公开合成模数；这不是可用 RSA key，也不宣称执行过 TPM。
  const BCRYPT_RSAKEY_BLOB header{BCRYPT_RSAPUBLIC_MAGIC, 2048, 3, 256, 0, 0};
  Bytes public_blob(sizeof(header) + 3 + 256, 0);
  std::memcpy(public_blob.data(), &header, sizeof(header));
  public_blob[sizeof(header)] = 1;
  public_blob[sizeof(header) + 2] = 1;
  public_blob[sizeof(header) + 3] = 0x80;
  public_blob.back() = 1;
  validate_cng_public_blob(public_blob);
  for (int field = 0; field < 6; ++field) {
    auto changed = public_blob;
    switch (field) {
      case 0: changed.pop_back(); break;
      case 1: changed.push_back(0); break;
      case 2: changed[0] ^= 1; break;
      case 3: changed[sizeof(header) + 2] = 3; break;
      case 4: changed[sizeof(header) + 3] = 0; break;
      case 5: changed.back() = 0; break;
    }
    bool invalid = false;
    try { validate_cng_public_blob(changed); }
    catch (const HostError &error) { invalid = error.code() == CITIZENSDK_ERROR_INTEGRITY; }
    assert(invalid);
  }

  WalletKey wallet{};
  wallet.generation[0] = 0x12;
  assert(cng_key_name(wallet) == "citizensdk.12000000000000000000000000000000");
  wallet.wallet_index = 1;
  bool rejected = false;
  try { (void)cng_key_name(wallet); }
  catch (const HostError &error) { rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT; }
  assert(rejected);
  std::array<uint8_t, 32> output{};
  output.fill(0xa5);
  rejected = false;
  try { Cng().decrypt_dek(VaultObject{}, Bytes{}, SensitiveBuffer{}, output.data()); }
  catch (const HostError &error) { rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT; }
  assert(rejected && std::all_of(output.begin(), output.end(), [](uint8_t byte) { return byte == 0; }));
  if (isolated_tpm_enabled()) {
    try { isolated_tpm_contract(); }
    catch (...) { return 1; }
    std::fputs("Windows TPM hardware tests PASSED (isolated opt-in)\n", stdout);
  } else {
    std::fputs("Windows TPM hardware tests NOT RUN (isolated opt-in required)\n", stdout);
  }
  if (std::fflush(stdout) != 0) return 1;
  return 0;
}
