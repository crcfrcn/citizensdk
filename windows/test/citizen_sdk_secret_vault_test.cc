// 使用真实 SecureStore 与生产 Vault 状态机；替身仅取代 TPM/交互，不冒充硬件验收。
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <chrono>
#include <future>
#include <stdexcept>
#include <vector>
#include <array>
#include <cassert>
#include <cstring>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include "citizen_sdk_directory.hpp"
#include "citizen_sdk_secret_vault.hpp"
#include "citizen_sdk_test_support.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

namespace {
using namespace citizen_sdk::windows;

template <class Function>
void fails(citizensdk_error_code_t expected, Function &&function) {
  bool rejected = false;
  try { function(); }
  catch (const HostError &error) { rejected = error.code() == expected; }
  assert(rejected);
}

AuthenticationResult authenticated() {
  constexpr uint8_t value[] = {'s', 'y', 'n', 't', 'h', 'e', 't', 'i', 'c'};
  return {CITIZENSDK_OK, SensitiveBuffer(value, sizeof(value))};
}

VaultObject synthetic_object(const WalletKey &key) {
  BCRYPT_RSAKEY_BLOB header{BCRYPT_RSAPUBLIC_MAGIC, 2048, 3, 256, 0, 0};
  Bytes public_blob(sizeof(header) + 3 + 256, 0);
  std::memcpy(public_blob.data(), &header, sizeof(header));
  public_blob[sizeof(header)] = 1;
  public_blob[sizeof(header) + 2] = 1;
  public_blob[sizeof(header) + 3] = 0x80;
  public_blob.back() = 1;
  return {cng_key_name(key), std::move(public_blob), Bytes{1, 2, 3, 4},
      Bytes(key.generation.begin(), key.generation.end())};
}

struct FakeSystem final {
  CngAvailability available{CngAvailability::kAvailable};
  bool authentication_available{true};
  bool cancel{false};
  bool delete_fails{false};
  bool enumerate_fails{false};
  bool decrypt_fails{false};
  unsigned created{};
  unsigned deleted{};
  unsigned decrypted{};
  unsigned prompted{};
  std::map<std::string, VaultObject> keys;
  std::function<void()> on_create;
  std::function<void()> on_unlock;
  std::function<void()> on_decrypt;

  SecretVaultServices services() {
    return {
      [this] { return available; },
      [this] {
        if (enumerate_fails) throw HostError(CITIZENSDK_ERROR_UNAVAILABLE, "合成系统枚举失败");
        std::vector<std::string> names;
        for (const auto &entry : keys) names.push_back(entry.first);
        return names;
      },
      [this] { return authentication_available; },
      [this](uint64_t id) {
        assert(id != 0); ++prompted;
        if (on_unlock) on_unlock();
        return cancel ? CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED : CITIZENSDK_OK;
      },
      [this](uint64_t host_operation_id) {
        assert(host_operation_id != 0);
        ++prompted;
        return cancel ? AuthenticationResult{CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED, {}}
                      : authenticated();
      },
      [this](uint64_t host_operation_id) {
        assert(host_operation_id != 0);
        ++prompted;
        if (on_unlock) on_unlock();
        return cancel ? AuthenticationResult{CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED, {}}
                      : authenticated();
      },
      [this](const WalletKey &key, const SensitiveBuffer &password) {
        assert(!password.empty());
        ++created;
        const auto object = synthetic_object(key);
        keys.emplace(object.key_name, object);
        if (on_create) on_create();
        return object;
      },
      [this](const VaultObject &object) {
        return keys.count(object.key_name) == 1;
      },
      [](const VaultObject &, const uint8_t *input) {
        assert(input != nullptr);
        return Bytes(256, 0x2a);
      },
      [this](const VaultObject &object, const Bytes &wrapped,
              const SensitiveBuffer &password, uint8_t *output) {
        assert(keys.count(object.key_name) == 1 && wrapped.size() == 256 && !password.empty());
        ++decrypted;
        std::fill_n(output, 32, 0x3c);
        if (on_decrypt) on_decrypt();
        if (decrypt_fails) throw HostError(CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, "synthetic failure");
      },
      [this](const WalletKey &key, const std::optional<VaultObject> &) {
        ++deleted;
        if (delete_fails) throw HostError(CITIZENSDK_ERROR_UNAVAILABLE, "synthetic deletion failure");
        keys.erase(cng_key_name(key));
      }
    };
  }
};

void expect(bool value) {
  if (!value) throw std::runtime_error("CitizenSDK generation serialization test failed");
}

int retire_child(int count, wchar_t **arguments) {
  if (count != 6) return 2;
  WalletKey wallet{};
  const std::wstring generation(arguments[3]);
  if (generation.size() != 32) return 2;
  for (std::size_t index = 0; index < 16; ++index) {
    const auto digit = [](wchar_t value) -> int {
      if (value >= L'0' && value <= L'9') return value - L'0';
      if (value >= L'a' && value <= L'f') return value - L'a' + 10;
      return -1;
    };
    const int high = digit(generation[index * 2]);
    const int low = digit(generation[index * 2 + 1]);
    if (high < 0 || low < 0) return 2;
    wallet.generation[index] = static_cast<uint8_t>((high << 4) | low);
  }
  UniqueHandle blocked(::OpenEventW(EVENT_MODIFY_STATE, FALSE, arguments[4]));
  UniqueHandle proceed(::OpenEventW(SYNCHRONIZE, FALSE, arguments[5]));
  if (!blocked || !proceed) return 2;
  bool busy = false;
  try { GenerationLock denied(wallet, 0); }
  catch (const HostError &error) { busy = error.code() == CITIZENSDK_ERROR_BUSY; }
  if (!busy || !::SetEvent(blocked.get()) ||
      ::WaitForSingleObject(proceed.get(), 30000) != WAIT_OBJECT_0) return 3;
  try {
    SecureStore store{std::filesystem::path(arguments[2])};
    FakeSystem system;
    auto services = system.services();
    bool deleted = false;
    services.delete_key = [&](const WalletKey &key, const std::optional<VaultObject> &object) {
      // 进入物理删除时必须已经看到父进程写完的对象与本次退休墓碑。
      expect(object.has_value() && !store.is_generation_active(key));
      deleted = true;
    };
    SecretVault vault(store, std::move(services));
    std::array<uint8_t, 16> operation{};
    operation[0] = 10;
    vault.retire_wallet_kek(wallet, operation);
    expect(deleted && !store.load_vault_object(wallet));
    return 0;
  } catch (...) { return 4; }
}

void cross_process_retirement(SecureStore &store, const std::filesystem::path &directory) {
  WalletKey wallet{};
  expect(::BCryptGenRandom(nullptr, wallet.generation.data(),
      static_cast<ULONG>(wallet.generation.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0);
  const std::string narrow_generation = cng_key_name(wallet).substr(11);
  const std::wstring generation(narrow_generation.begin(), narrow_generation.end());
  const std::wstring event_root = L"Local\\citizensdk.test." +
      std::to_wstring(::GetCurrentProcessId()) + L"." + generation;
  const std::wstring blocked_name = event_root + L".blocked";
  const std::wstring proceed_name = event_root + L".proceed";
  UniqueHandle blocked(::CreateEventW(nullptr, TRUE, FALSE, blocked_name.c_str()));
  UniqueHandle proceed(::CreateEventW(nullptr, TRUE, FALSE, proceed_name.c_str()));
  expect(blocked && proceed);
  std::array<wchar_t, 32768> executable{};
  const DWORD length = ::GetModuleFileNameW(nullptr, executable.data(),
                                           static_cast<DWORD>(executable.size()));
  expect(length > 0 && length < executable.size());
  std::wstring command = L"\"" + std::wstring(executable.data(), length) +
      L"\" --retire \"" + directory.native() + L"\" " + generation +
      L" \"" + blocked_name + L"\" \"" + proceed_name + L"\"";
  FakeSystem system;
  SecretVault vault(store, system.services());
  UniqueHandle process;
  UniqueHandle thread;
  system.on_create = [&] {
    STARTUPINFOW startup{};
    startup.cb = static_cast<DWORD>(sizeof(startup));
    PROCESS_INFORMATION information{};
    expect(::CreateProcessW(executable.data(), command.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &information));
    process.reset(information.hProcess);
    thread.reset(information.hThread);
    // 子进程确实尝试取得同一 production mutex 并返回 BUSY，而非仅依赖延时猜测。
    expect(::WaitForSingleObject(blocked.get(), 30000) == WAIT_OBJECT_0);
  };
  std::array<uint8_t, 16> operation{};
  operation[0] = 9;
  try {
    vault.ensure_wallet_kek(101, wallet, operation);
    expect(store.load_vault_object(wallet).has_value());
    expect(::SetEvent(proceed.get()));
    expect(::WaitForSingleObject(process.get(), 30000) == WAIT_OBJECT_0);
    DWORD exit_code = 1;
    expect(::GetExitCodeProcess(process.get(), &exit_code) && exit_code == 0);
    expect(!store.is_generation_active(wallet) && !store.load_vault_object(wallet));
  } catch (...) {
    (void)::SetEvent(proceed.get());
    if (process && ::WaitForSingleObject(process.get(), 30000) != WAIT_OBJECT_0) {
      (void)::TerminateProcess(process.get(), 5);
      (void)::WaitForSingleObject(process.get(), 30000);
    }
    throw;
  }
}

}  // namespace


namespace {
// 仅使用合成凭据；不访问真实钱包和设备认证界面。
void headless_credential_contract() {
  using namespace citizen_sdk::windows;
  UserAuth auth;
  assert(!auth.available());
  assert(auth.create_vault_password(41).code == CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED);
  assert(auth.unlock_vault_password(0).code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  struct Provider final {
    UserAuth *auth{};
    std::vector<uint8_t> bytes = std::vector<uint8_t>(12, 'a');
    uint64_t id{};
    uint32_t purpose{};
    unsigned cancellations{}, references{};
    bool provider_idle{true};
    bool hold{}, revoke{}, cancelled{}, throws{};
    std::promise<void> accepted;
    citizensdk_error_code_t response{};
  } provider;
  provider.auth = &auth;
  citizensdk_credential_provider_v1_t binding{
      sizeof(citizensdk_credential_provider_v1_t), 1, &provider,
      +[](void *context, const citizensdk_credential_challenge_v1_t *challenge) {
        auto &p = *static_cast<Provider *>(context);
        assert(challenge->struct_size == sizeof(*challenge) && challenge->abi_version == 1);
        assert(challenge->reserved == 0 && challenge->host_operation_id != 0);
        p.id = challenge->host_operation_id; p.purpose = challenge->key_purpose;
        if (p.throws) throw std::runtime_error("synthetic provider failure");
        if (p.hold) { p.accepted.set_value(); return; }
        const uint8_t nonnull_empty = 0;
        p.response = p.auth->respond(p.id, p.cancelled ? citizensdk_bytes_view_t{nullptr, 0}
            : citizensdk_bytes_view_t{p.bytes.empty() ? &nonnull_empty : p.bytes.data(),
                                     static_cast<uint64_t>(p.bytes.size())});
        if (p.revoke) assert(p.auth->cancel(p.id) == CITIZENSDK_OK);
      },
      +[](void *context, uint64_t id) {
        auto &p = *static_cast<Provider *>(context);
        assert(id == p.id); ++p.cancellations;
      },
      +[](void *context) { ++static_cast<Provider *>(context)->references; },
      +[](void *context) { --static_cast<Provider *>(context)->references; },
      +[](void *context) -> uint8_t {
        return static_cast<Provider *>(context)->provider_idle ? 1 : 0;
      }};
  auto malformed = binding;
  malformed.cancel = nullptr;
  assert(auth.configure(&malformed) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(!auth.available());
  assert(auth.configure(&binding) == CITIZENSDK_OK && auth.available());
  assert(provider.references == 1);
  auto created = auth.create_vault_password(41);
  assert(provider.id == 41 && provider.purpose == 1);
  assert(created.code == CITIZENSDK_OK && created.password.size() == 12);
  provider.bytes[0] = 'b';
  assert(created.password.data()[0] == 'a'); // 回调返回后独立持有可擦除副本。
  created.password.clear();
  assert(auth.respond(41, {provider.bytes.data(), 12}) == CITIZENSDK_ERROR_INVALID_STATE);
  provider.bytes.assign(1024, 'a');
  auto unlocked = auth.unlock_vault_password(42);
  assert(provider.id == 42 && provider.purpose == 2);
  assert(unlocked.code == CITIZENSDK_OK && unlocked.password.size() == 1024);
  unlocked.password.clear();
  for (const auto length : {0, 11, 1025}) {
    provider.bytes.assign(static_cast<std::size_t>(length), 'a');
    provider.bytes.reserve(1); // 非NULL空输入不能冒充null取消。
    const auto invalid = auth.unlock_vault_password(43);
    assert(invalid.code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(provider.response == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  provider.bytes.assign(12, 'a');
  provider.bytes[2] = 0xc0;
  assert(auth.unlock_vault_password(44).code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  provider.bytes[2] = 0;
  assert(auth.unlock_vault_password(45).code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  provider.bytes[2] = 'a';
  provider.cancelled = true;
  assert(auth.unlock_vault_password(46).code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED);
  provider.cancelled = false;
  provider.revoke = true;
  auto revoked = auth.unlock_vault_password(47);
  assert(revoked.code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED && revoked.password.empty());
  provider.revoke = false;
  provider.throws = true;
  assert(auth.unlock_vault_password(48).code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED);
  provider.throws = false;
  // Host隔离、真实请求号、取消和迟到回包不以UI是否显示为判断依据。
  provider.hold = true;
  auto accepted = provider.accepted.get_future();
  auto pending = std::async(std::launch::async, [&] { return auth.unlock_vault_password(49); });
  assert(accepted.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  assert(!auth.idle());
  assert(auth.configure(nullptr) == CITIZENSDK_ERROR_BUSY);
  assert(auth.unlock_vault_password(49).code == CITIZENSDK_ERROR_CONFLICT);
  UserAuth other;
  assert(other.respond(49, {provider.bytes.data(), 12}) == CITIZENSDK_ERROR_INVALID_STATE);
  auth.cancel_all();
  assert(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  auto stopped = pending.get();
  assert(stopped.code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED && stopped.password.empty());
  assert(auth.respond(49, {provider.bytes.data(), 12}) == CITIZENSDK_ERROR_INVALID_STATE);
  assert(auth.idle() && provider.cancellations == 3);
  provider.provider_idle = false;
  assert(!auth.idle()); // 已取消Core等待，不等于提供者异步资源排空。
  assert(auth.configure(nullptr) == CITIZENSDK_ERROR_BUSY);
  provider.provider_idle = true;
  assert(auth.configure(nullptr) == CITIZENSDK_OK && !auth.available());
  assert(provider.references == 0);
}
}  // namespace

int wmain(int count, wchar_t **arguments) {
  if (count > 1 && std::wstring(arguments[1]) == L"--retire") return retire_child(count, arguments);
  headless_credential_contract();
  using namespace citizen_sdk::windows;
  citizen_sdk::windows::test::TempDirectory temporary("secret-vault");
  SecureStore store(temporary.path() / "state");
  SecureStore other_store(temporary.path() / "state");
  FakeSystem system;
  SecretVault vault(store, system.services());
  SecretVault other(other_store, system.services());
  std::array<uint8_t, 16> operation{};
  operation[0] = 7;
  auto competing = operation;
  competing[0] = 8;
  WalletKey wallet{};
  wallet.generation[0] = 1;
  std::array<uint8_t, 32> output{};
  const auto zero = [&] {
    return std::all_of(output.begin(), output.end(), [](uint8_t byte) { return byte == 0; });
  };

  assert(vault.availability() == CITIZENSDK_HOST_VAULT_AVAILABLE);
  system.authentication_available = false;
  assert(vault.availability() == CITIZENSDK_HOST_VAULT_NO_STRONG_USER_AUTHENTICATION);
  fails(CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, [&] { vault.ensure_wallet_kek(101, wallet, operation); });
  assert(system.created == 0);
  system.authentication_available = true;
  system.available = CngAvailability::kUnsupported;
  assert(vault.availability() == CITIZENSDK_HOST_VAULT_UNSUPPORTED);
  system.available = CngAvailability::kUnavailable;
  assert(vault.availability() == CITIZENSDK_HOST_VAULT_UNAVAILABLE);
  system.available = CngAvailability::kAvailable;
  assert(!vault.has_wallet_kek(wallet));
  assert(!vault.has_any_wallet_key(0));
  system.enumerate_fails = true;
  fails(CITIZENSDK_ERROR_UNAVAILABLE, [&] { (void)vault.has_any_wallet_key(0); });
  system.enumerate_fails = false;
  output.fill(0xa5);
  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { vault.unwrap_dek(1, wallet, Bytes(256), output.data()); });
  assert(zero() && vault.idle());
  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { vault.wrap_dek(102, wallet, operation, output.data()); });
  assert(!store.is_generation_active(wallet) && system.created == 0);

  system.cancel = true;
  fails(CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED, [&] { vault.ensure_wallet_kek(101, wallet, operation); });
  assert(system.created == 0 && !store.load_vault_object(wallet));
  system.cancel = false;
  vault.ensure_wallet_kek(101, wallet, operation);
  assert(vault.has_wallet_kek(wallet) && system.created == 1);
  assert(vault.has_any_wallet_key(0) && !vault.has_any_wallet_key(UINT32_MAX));
  // 独立认证一次，不读取旧DEK；取消和重试各自拥有独立认证结果。
  const unsigned before_add = system.prompted;
  vault.authorize_add_accounts(111, wallet, competing);
  assert(system.prompted == before_add + 1 && system.decrypted == 0 && vault.idle());
  system.cancel = true;
  fails(CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED, [&] { vault.authorize_add_accounts(112, wallet, competing); });
  system.cancel = false;
  vault.authorize_add_accounts(113, wallet, competing);
  assert(system.prompted == before_add + 3 && system.decrypted == 0 && vault.idle());
  const unsigned prompts = system.prompted;
  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { other.ensure_wallet_kek(101, wallet, competing); });
  assert(system.created == 1 && system.deleted == 0 && system.prompted == prompts);
  vault.ensure_wallet_kek(101, wallet, operation);
  assert(system.created == 1);

  // 新追加操作复用原钥，不能触发创建认证或改变创建归属。
  const Bytes wrapped = vault.wrap_dek(102, wallet, competing, output.data());
  assert(system.created == 1 && system.prompted == prompts);
  assert(wrapped.size() == 256);
  vault.unwrap_dek(2, wallet, wrapped, output.data());
  assert(output[0] == 0x3c && vault.idle());
  system.cancel = true;
  fails(CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED, [&] { vault.unwrap_dek(3, wallet, wrapped, output.data()); });
  assert(zero() && vault.idle());
  system.cancel = false;
  system.decrypt_fails = true;
  fails(CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, [&] { vault.unwrap_dek(4, wallet, wrapped, output.data()); });
  assert(zero() && vault.idle());
  system.decrypt_fails = false;

  // 同一操作重入不能消费/结束原操作的租约；拒绝路径仍清空它自己的输出。
  system.on_unlock = [&] {
    std::array<uint8_t, 32> another_output{};
    another_output.fill(0xa5);
    fails(CITIZENSDK_ERROR_CONFLICT, [&] { vault.unwrap_dek(5, wallet, wrapped, another_output.data()); });
    assert(!vault.idle() && std::all_of(another_output.begin(), another_output.end(),
        [](uint8_t byte) { return byte == 0; }));
  };
  vault.unwrap_dek(5, wallet, wrapped, output.data());
  system.on_unlock = {};
  assert(vault.idle());

  // 合成认证回调同步重入另一实例退休：禁止解封旧 key，墓碑阻止再次 ensure。
  const unsigned decryptions = system.decrypted;
  system.on_unlock = [&] { other.retire_wallet_kek(wallet, competing); };
  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { vault.unwrap_dek(6, wallet, wrapped, output.data()); });
  system.on_unlock = {};
  assert(zero() && system.decrypted == decryptions && vault.idle() && !vault.has_wallet_kek(wallet));
  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { vault.ensure_wallet_kek(101, wallet, operation); });

  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { vault.wrap_dek(102, wallet, competing, output.data()); });

  wallet.generation[0] = 2;
  vault.ensure_wallet_kek(101, wallet, operation);
  system.on_decrypt = [&] { other.retire_wallet_kek(wallet, competing); };
  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { vault.unwrap_dek(7, wallet, wrapped, output.data()); });
  system.on_decrypt = {};
  assert(zero() && vault.idle());

  wallet.generation[0] = 3;
  vault.ensure_wallet_kek(101, wallet, operation);
  system.delete_fails = true;
  fails(CITIZENSDK_ERROR_UNAVAILABLE, [&] { vault.retire_wallet_kek(wallet, operation); });
  assert(!store.is_generation_active(wallet) && store.load_vault_object(wallet) &&
      system.keys.count(cng_key_name(wallet)) == 1 && !vault.has_wallet_kek(wallet));
  assert(vault.has_any_wallet_key(0)); // 元数据退休但系统删除失败，钥仍实际存在。
  system.delete_fails = false;
  vault.retire_wallet_kek(wallet, operation);
  assert(!store.load_vault_object(wallet) && system.keys.count(cng_key_name(wallet)) == 0);
  vault.retire_wallet_kek(wallet, operation);

  // 模拟 PCP 已持久化但对象行尚未写入便崩溃；generation 定址仍能清理。
  wallet.generation[0] = 4;
  assert(store.ensure_generation(wallet, operation));
  const auto orphan = synthetic_object(wallet);
  system.keys.emplace(orphan.key_name, orphan);
  assert(vault.has_any_wallet_key(0)); // 即使对象行尚未写入，也从系统枚举发现实际钥。
  vault.retire_wallet_kek(wallet, operation);
  assert(system.keys.count(orphan.key_name) == 0 && !store.ensure_generation(wallet, operation));

  // 对象已被同操作写入：生产 CAS 重复/写后错误路径确认同一提交，不删除成功方。
  wallet.generation[0] = 5;
  const unsigned deletions = system.deleted;
  system.on_create = [&] { other_store.store_vault_object_if_owned(wallet, operation, synthetic_object(wallet)); };
  vault.ensure_wallet_kek(101, wallet, operation);
  system.on_create = {};
  assert(vault.has_wallet_kek(wallet) && system.deleted == deletions);
  vault.retire_wallet_kek(wallet, operation);

  // CNG 返回后 ownership 被撤销：条件写入失败，不能在失败方路径擅自删 key。
  wallet.generation[0] = 6;
  system.on_create = [&] { other_store.retire_generation(wallet, competing); };
  const unsigned before_failure = system.deleted;
  fails(CITIZENSDK_ERROR_KEY_INVALIDATED, [&] { vault.ensure_wallet_kek(101, wallet, operation); });
  system.on_create = {};
  assert(system.deleted == before_failure && system.keys.count(cng_key_name(wallet)) == 1);
  vault.retire_wallet_kek(wallet, operation);
  assert(system.keys.empty() && vault.idle() && other.idle());
  assert(!vault.has_any_wallet_key(0));
  const std::string unknown = "citizensdk." + std::string(32, 'f');
  system.keys.emplace(unknown, VaultObject{});
  fails(CITIZENSDK_ERROR_INTEGRITY, [&] { (void)vault.has_any_wallet_key(0); });
  system.keys.erase(unknown);
  auto first = wallet; first.generation[0] = 7;
  auto second = wallet; second.generation[0] = 8;
  vault.ensure_wallet_kek(103, first, operation);
  vault.ensure_wallet_kek(104, second, competing);
  vault.retire_wallet_kek(first, operation);
  assert(vault.has_any_wallet_key(0));
  vault.retire_wallet_kek(second, competing);
  assert(!vault.has_any_wallet_key(0));
  try { cross_process_retirement(store, temporary.path() / "state"); }
  catch (...) { return 1; }
  return 0;
}
