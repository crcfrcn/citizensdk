#include "citizen_sdk_cng.hpp"

#include <windows.h>
#include <bcrypt.h>
#include <ncrypt.h>
#include <tbs.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <utility>
#include "citizen_sdk_directory.hpp"

namespace citizen_sdk::windows {
namespace {

constexpr std::size_t kRsaBytes = 256;
constexpr std::size_t kSaltBytes = 16;
constexpr std::size_t kMaximumNameBytes = 1024;

void check(SECURITY_STATUS status, citizensdk_error_code_t failure,
           const char *message) {
  if (status == ERROR_SUCCESS) return;
  const auto mapped = map_cng_error(static_cast<uint32_t>(status), failure);
  throw HostError(mapped.code, mapped.dictionary_attack_lockout
      ? "CitizenSDK TPM authorization is locked; no automatic retry is allowed"
      : message);
}

class NcryptObject final {
 public:
  NcryptObject() = default;
  NcryptObject(const NcryptObject &) = delete;
  NcryptObject &operator=(const NcryptObject &) = delete;
  ~NcryptObject() { if (value != 0) (void)::NCryptFreeObject(value); }
  NCRYPT_HANDLE value{};
};

class Algorithm final {
 public:
  explicit Algorithm(LPCWSTR name, ULONG flags = 0) {
    require(::BCryptOpenAlgorithmProvider(&value, name, nullptr, flags) >= 0,
            CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK CNG algorithm is unavailable");
  }
  ~Algorithm() { (void)::BCryptCloseAlgorithmProvider(value, 0); }
  Algorithm(const Algorithm &) = delete;
  Algorithm &operator=(const Algorithm &) = delete;
  BCRYPT_ALG_HANDLE value{};
};

template <class T>
T property(NCRYPT_HANDLE object, LPCWSTR name) {
  T result{};
  DWORD written = 0;
  check(::NCryptGetProperty(object, name, reinterpret_cast<PBYTE>(&result),
                            static_cast<DWORD>(sizeof(result)), &written, NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK required CNG property is unavailable");
  require(written == sizeof(result), CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK CNG property length differs from its official type");
  return result;
}

Bytes property_bytes(NCRYPT_HANDLE object, LPCWSTR name, DWORD maximum,
                      DWORD flags = NCRYPT_SILENT_FLAG) {
  DWORD length = 0;
  check(::NCryptGetProperty(object, name, nullptr, 0, &length, flags),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK required CNG property is unavailable");
  require(length > 0 && length <= maximum, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK CNG property exceeds its bounded representation");
  Bytes result(length);
  DWORD written = 0;
  check(::NCryptGetProperty(object, name, result.data(), length, &written, flags),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK CNG property read failed");
  require(written == length, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK CNG property changed while reading");
  return result;
}

void set_dword(NCRYPT_HANDLE object, LPCWSTR name, DWORD value) {
  check(::NCryptSetProperty(object, name, reinterpret_cast<PBYTE>(&value),
                            static_cast<DWORD>(sizeof(value)), NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK required CNG key policy failed");
}

void open_provider(NcryptObject &provider) {
  TPM_DEVICE_INFO device{};
  require(::Tbsi_GetDeviceInfo(static_cast<UINT32>(sizeof(device)), &device) == TBS_SUCCESS &&
              device.tpmVersion == TPM_VERSION_20,
          CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK requires an available TPM 2.0");
  // 固定 PCP；不使用默认提供程序，不转向 Software KSP、DPAPI 或 Hello。
  check(::NCryptOpenStorageProvider(&provider.value,
                                    MS_PLATFORM_KEY_STORAGE_PROVIDER, 0),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Platform Crypto Provider is unavailable");
  const DWORD implementation = property<DWORD>(provider.value, NCRYPT_IMPL_TYPE_PROPERTY);
  require((implementation & NCRYPT_IMPL_HARDWARE_FLAG) != 0 &&
              (implementation & NCRYPT_IMPL_SOFTWARE_FLAG) == 0 &&
              property<DWORD>(provider.value, NCRYPT_SECURITY_DESCR_SUPPORT_PROPERTY) == 1,
          CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK requires hardware PCP with persistent key access control");
}

std::wstring public_key_name(const std::string &name) {
  require(name.size() == 43 && name.compare(0, 11, "citizensdk.") == 0 &&
              std::all_of(name.begin() + 11, name.end(), [](char value) {
                return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
              }),
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK TPM key name is invalid");
  return std::wstring(name.begin(), name.end());
}

void check_object(const VaultObject &object) {
  (void)public_key_name(object.key_name);
  validate_cng_public_blob(object.public_blob);
  require(!object.name.empty() && object.name.size() <= kMaximumNameBytes &&
              object.auth_salt.size() == kSaltBytes,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK TPM object metadata is invalid");
  constexpr char digits[] = "0123456789abcdef";
  for (std::size_t index = 0; index < kSaltBytes; ++index) {
    require(object.key_name[11 + index * 2] == digits[object.auth_salt[index] >> 4] &&
                object.key_name[12 + index * 2] == digits[object.auth_salt[index] & 15],
            CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK TPM salt and generation differ");
  }
}

void set_private_security(NCRYPT_KEY_HANDLE key) {
  const Bytes sid = current_user_sid();
  Bytes acl_bytes(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid.size());
  auto *acl = reinterpret_cast<ACL *>(acl_bytes.data());
  SECURITY_DESCRIPTOR descriptor{};
  require(::InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
              ::InitializeAcl(acl, static_cast<DWORD>(acl_bytes.size()), ACL_REVISION) &&
              ::AddAccessAllowedAceEx(acl, ACL_REVISION, 0, GENERIC_ALL,
                                      const_cast<uint8_t *>(sid.data())) &&
              ::SetSecurityDescriptorOwner(&descriptor, const_cast<uint8_t *>(sid.data()), FALSE) &&
              ::SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) &&
              ::SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK key security descriptor failed");
  // KSP 属性传递完整的自相对描述符，不能只传包含进程内 ACL/SID 指针的结构体长度。
  DWORD relative_length = 0;
  require(!::MakeSelfRelativeSD(&descriptor, nullptr, &relative_length) &&
              ::GetLastError() == ERROR_INSUFFICIENT_BUFFER &&
              relative_length > 0 && relative_length <= 65536,
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK key descriptor size failed");
  Bytes relative(relative_length);
  require(::MakeSelfRelativeSD(&descriptor, relative.data(), &relative_length),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK key descriptor encoding failed");
  check(::NCryptSetProperty(key, NCRYPT_SECURITY_DESCR_PROPERTY,
                            relative.data(), relative_length,
                            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
                                NCRYPT_PERSIST_FLAG | NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK private key access control failed");
}

void validate_private_security(NCRYPT_KEY_HANDLE key) {
  const Bytes sid = current_user_sid();
  Bytes descriptor = property_bytes(key, NCRYPT_SECURITY_DESCR_PROPERTY, 65536,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | NCRYPT_SILENT_FLAG);
  require(::IsValidSecurityDescriptor(descriptor.data()), CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK key security descriptor is invalid");
  PSID owner = nullptr;
  PACL acl = nullptr;
  BOOL defaulted = FALSE;
  BOOL present = FALSE;
  SECURITY_DESCRIPTOR_CONTROL control{};
  DWORD revision = 0;
  require(::GetSecurityDescriptorOwner(descriptor.data(), &owner, &defaulted) &&
              owner != nullptr && ::IsValidSid(owner) &&
              ::EqualSid(owner, const_cast<uint8_t *>(sid.data())) &&
              ::GetSecurityDescriptorDacl(descriptor.data(), &present, &acl, &defaulted) &&
              present && acl != nullptr && ::IsValidAcl(acl) && acl->AceCount == 1 &&
              ::GetSecurityDescriptorControl(descriptor.data(), &control, &revision) &&
              (control & SE_DACL_PROTECTED) != 0,
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK key owner or protected DACL differs");
  void *raw = nullptr;
  require(::GetAce(acl, 0, &raw), CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK key ACE is unavailable");
  const auto *ace = static_cast<const ACCESS_ALLOWED_ACE *>(raw);
  require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0 &&
              ace->Header.AceSize >= sizeof(ACCESS_ALLOWED_ACE) && ace->Mask != 0 &&
              ::IsValidSid(const_cast<DWORD *>(&ace->SidStart)) &&
              ::EqualSid(const_cast<DWORD *>(&ace->SidStart), const_cast<uint8_t *>(sid.data())),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK key must grant access only to its user");
}

Bytes public_blob(NCRYPT_KEY_HANDLE key) {
  DWORD length = 0;
  check(::NCryptExportKey(key, 0, BCRYPT_RSAPUBLIC_BLOB, nullptr, nullptr, 0,
                          &length, NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK RSA public key read failed");
  require(length >= 281 && length <= 288, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK RSA public key length is invalid");
  Bytes result(length);
  DWORD written = 0;
  check(::NCryptExportKey(key, 0, BCRYPT_RSAPUBLIC_BLOB, nullptr, result.data(),
                          length, &written, NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK RSA public key read failed");
  require(written == length, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK RSA public key changed while reading");
  validate_cng_public_blob(result);
  return result;
}

VaultObject inspect_key(NCRYPT_KEY_HANDLE key, const std::string &name,
                         const Bytes &salt) {
  const Bytes algorithm = property_bytes(key, NCRYPT_ALGORITHM_PROPERTY, 64);
  constexpr wchar_t rsa[] = BCRYPT_RSA_ALGORITHM;
  require(algorithm.size() == sizeof(rsa) &&
              std::memcmp(algorithm.data(), rsa, sizeof(rsa)) == 0,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK KEK must use RSA");
  const std::wstring expected_name = public_key_name(name);
  const Bytes actual_name = property_bytes(key, NCRYPT_NAME_PROPERTY, 1024);
  require(actual_name.size() == (expected_name.size() + 1) * sizeof(wchar_t) &&
              std::memcmp(actual_name.data(), expected_name.c_str(), actual_name.size()) == 0,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK persisted key name differs");
  // PCP 文档将这两项定义为 BOOLEAN，不能按 DWORD 读取碰巧相同的低字节。
  const BOOLEAN required = property<BOOLEAN>(key, NCRYPT_PCP_PASSWORD_REQUIRED_PROPERTY);
  const BOOLEAN exportable = property<BOOLEAN>(key, NCRYPT_PCP_EXPORT_ALLOWED_PROPERTY);
  require(required <= TRUE && exportable <= TRUE, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK PCP Boolean property is invalid");
  validate_cng_key_properties(CngKeyProperties{
      property<DWORD>(key, NCRYPT_LENGTH_PROPERTY),
      property<DWORD>(key, NCRYPT_KEY_TYPE_PROPERTY),
      property<DWORD>(key, NCRYPT_KEY_USAGE_PROPERTY),
      property<DWORD>(key, NCRYPT_EXPORT_POLICY_PROPERTY),
      property<DWORD>(key, NCRYPT_PCP_KEY_USAGE_POLICY_PROPERTY),
      required != FALSE, exportable != FALSE});
  validate_private_security(key);
  VaultObject object{name, public_blob(key),
      property_bytes(key, NCRYPT_PCP_TPM2BNAME_PROPERTY,
                       static_cast<DWORD>(kMaximumNameBytes)), salt};
  check_object(object);
  return object;
}

void open_key(NcryptObject &provider, NcryptObject &key,
               const VaultObject &expected) {
  check_object(expected);
  open_provider(provider);
  const std::wstring name = public_key_name(expected.key_name);
  check(::NCryptOpenKey(provider.value, &key.value, name.c_str(), 0, NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_KEY_INVALIDATED, "CitizenSDK TPM key is unavailable");
  const VaultObject actual = inspect_key(key.value, expected.key_name, expected.auth_salt);
  require(actual.public_blob == expected.public_blob && actual.name == expected.name,
          CITIZENSDK_ERROR_KEY_INVALIDATED, "CitizenSDK TPM key identity changed");
}

SensitiveBuffer derive_pin(const SensitiveBuffer &password, const Bytes &salt) {
  require(!password.empty() && password.size() <= 4096 && salt.size() == kSaltBytes,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK device-vault password or salt is invalid");
  Algorithm algorithm(BCRYPT_SHA256_ALGORITHM, BCRYPT_ALG_HANDLE_HMAC_FLAG);
  SensitiveBuffer derived(32);
  require(::BCryptDeriveKeyPBKDF2(algorithm.value,
              const_cast<PUCHAR>(password.data()), static_cast<ULONG>(password.size()),
              const_cast<PUCHAR>(salt.data()), static_cast<ULONG>(salt.size()),
              600000, derived.data(), static_cast<ULONG>(derived.size()), 0) >= 0,
          CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK device-vault authorization derivation failed");
  // PIN 采用官方 UTF-16 字符串合同；不臆造 PCP 内部 authValue 长度/哈希算法。
  // 派生值及编码只存在可清零缓冲区，不创建明文 std::string/std::wstring。
  SensitiveBuffer pin((64 + 1) * sizeof(wchar_t));
  constexpr wchar_t digits[] = L"0123456789abcdef";
  for (std::size_t index = 0; index < derived.size(); ++index) {
    wchar_t high = digits[derived.data()[index] >> 4];
    wchar_t low = digits[derived.data()[index] & 15];
    std::memcpy(pin.data() + index * 2 * sizeof(wchar_t), &high, sizeof(high));
    std::memcpy(pin.data() + (index * 2 + 1) * sizeof(wchar_t), &low, sizeof(low));
    secure_zero(&high, sizeof(high));
    secure_zero(&low, sizeof(low));
  }
  derived.clear();
  return pin;
}

void authorize(NCRYPT_KEY_HANDLE key, SensitiveBuffer &pin) {
  check(::NCryptSetProperty(key, NCRYPT_PIN_PROPERTY, pin.data(),
                            static_cast<DWORD>(pin.size()), NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, "CitizenSDK TPM authorization failed");
  // 不设置 PERSIST，不复用授权句柄；FreeObject 不被宣称为系统缓存清除证明。
  pin.clear();
}

Bytes encrypt(NCRYPT_KEY_HANDLE key, const uint8_t plaintext[32]) {
  BCRYPT_OAEP_PADDING_INFO padding{BCRYPT_SHA256_ALGORITHM, nullptr, 0};
  Bytes result(kRsaBytes);
  DWORD written = 0;
  check(::NCryptEncrypt(key, const_cast<PBYTE>(plaintext), 32, &padding,
                        result.data(), static_cast<DWORD>(result.size()), &written,
                        NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK TPM OAEP-SHA256 encryption failed");
  require(written == kRsaBytes, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK wrapped DEK must be an RSA-2048 block");
  return result;
}

void decrypt(NCRYPT_KEY_HANDLE key, const Bytes &wrapped, uint8_t output[32]) {
  BCRYPT_OAEP_PADDING_INFO padding{BCRYPT_SHA256_ALGORITHM, nullptr, 0};
  DWORD written = 0;
  check(::NCryptDecrypt(key, const_cast<PBYTE>(wrapped.data()),
                        static_cast<DWORD>(wrapped.size()), &padding, output, 32, &written,
                        NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG),
        CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK TPM OAEP-SHA256 decryption failed");
  require(written == 32, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK unwrapped DEK must be exactly 32 bytes");
}

}  // namespace

CngErrorMapping map_cng_error(uint32_t status,
                              citizensdk_error_code_t failure) noexcept {
  if (status == ERROR_SUCCESS) return {CITIZENSDK_OK, false};
  if (status == static_cast<uint32_t>(TPM_E_LOCKED_OUT) ||
      status == static_cast<uint32_t>(TPM_20_E_LOCKOUT) ||
      status == static_cast<uint32_t>(TPM_E_PCP_AUTHENTICATION_IGNORED)) {
    return {CITIZENSDK_ERROR_UNAVAILABLE, true};
  }
  if (status == static_cast<uint32_t>(TPM_E_PCP_AUTHENTICATION_FAILED) ||
      status == static_cast<uint32_t>(TPM_E_KEY_NOT_AUTHENTICATED) ||
      status == static_cast<uint32_t>(TPM_20_E_BAD_AUTH) ||
      status == static_cast<uint32_t>(TPM_20_E_AUTH_FAIL) ||
      status == static_cast<uint32_t>(NTE_SILENT_CONTEXT)) {
    return {CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, false};
  }
  if (status == static_cast<uint32_t>(NTE_USER_CANCELLED)) {
    return {CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED, false};
  }
  if (status == static_cast<uint32_t>(NTE_EXISTS)) return {CITIZENSDK_ERROR_CONFLICT, false};
  if (status == static_cast<uint32_t>(NTE_BAD_KEYSET) ||
      status == static_cast<uint32_t>(NTE_NOT_FOUND)) return {CITIZENSDK_ERROR_KEY_INVALIDATED, false};
  if (status == static_cast<uint32_t>(NTE_PERM)) return {CITIZENSDK_ERROR_PERMISSION_DENIED, false};
  if (status == static_cast<uint32_t>(NTE_DEVICE_NOT_READY) ||
      status == static_cast<uint32_t>(TPM_E_PCP_DEVICE_NOT_READY) ||
      status == static_cast<uint32_t>(NTE_NOT_SUPPORTED) ||
      status == static_cast<uint32_t>(TPM_E_PCP_NOT_SUPPORTED)) {
    return {CITIZENSDK_ERROR_UNAVAILABLE, false};
  }
  return {failure, false};
}

void validate_cng_key_properties(const CngKeyProperties &value) {
  require(value.length == 2048 && value.key_type == 0 &&
              value.key_usage == NCRYPT_ALLOW_DECRYPT_FLAG && value.export_policy == 0 &&
              value.pcp_key_usage == NCRYPT_PCP_ENCRYPTION_KEY &&
              value.password_required && !value.export_allowed,
          CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK requires a user-owned non-exportable password-bound TPM RSA KEK");
}

void validate_cng_public_blob(const Bytes &blob) {
  require(blob.size() >= 281 && blob.size() <= 288, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK RSA public key length is invalid");
  BCRYPT_RSAKEY_BLOB header{};
  std::memcpy(&header, blob.data(), sizeof(header));
  require(header.Magic == BCRYPT_RSAPUBLIC_MAGIC && header.BitLength == 2048 &&
              header.cbPublicExp >= 1 && header.cbPublicExp <= 8 &&
              header.cbModulus == kRsaBytes && header.cbPrime1 == 0 && header.cbPrime2 == 0 &&
              blob.size() == sizeof(header) + header.cbPublicExp + header.cbModulus,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK RSA public key format is invalid");
  uint64_t exponent = 0;
  for (std::size_t index = 0; index < header.cbPublicExp; ++index) {
    exponent = (exponent << 8) | blob[sizeof(header) + index];
  }
  require(exponent == 65537 && (blob[sizeof(header) + header.cbPublicExp] & 0x80) != 0 &&
              (blob.back() & 1) != 0,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK RSA public key parameters are invalid");
}

std::string cng_key_name(const WalletKey &key) {
  require(key.wallet_index == 0 &&
              std::any_of(key.generation.begin(), key.generation.end(),
                          [](uint8_t byte) { return byte != 0; }),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK wallet generation is invalid");
  constexpr char digits[] = "0123456789abcdef";
  std::string result = "citizensdk.";
  for (const uint8_t byte : key.generation) {
    result.push_back(digits[byte >> 4]);
    result.push_back(digits[byte & 15]);
  }
  return result;
}

CngAvailability Cng::availability() const noexcept {
  try {
    TPM_DEVICE_INFO device{};
    if (::Tbsi_GetDeviceInfo(static_cast<UINT32>(sizeof(device)), &device) != TBS_SUCCESS) {
      return CngAvailability::kUnavailable;
    }
    if (device.tpmVersion != TPM_VERSION_20) return CngAvailability::kUnsupported;
    NcryptObject provider;
    open_provider(provider);
    return CngAvailability::kAvailable;
  } catch (...) {
    return CngAvailability::kUnavailable;
  }
}

VaultObject Cng::create_key(const WalletKey &wallet,
                            const SensitiveBuffer &password) const {
  const std::string name = cng_key_name(wallet);
  const Bytes salt(wallet.generation.begin(), wallet.generation.end());
  SensitiveBuffer pin = derive_pin(password, salt);
  NcryptObject provider;
  NcryptObject key;
  open_provider(provider);
  const std::wstring wide_name = public_key_name(name);
  const SECURITY_STATUS created = ::NCryptCreatePersistedKey(provider.value, &key.value,
      NCRYPT_RSA_ALGORITHM, wide_name.c_str(), 0, 0);
  const bool new_key = created == ERROR_SUCCESS;
  if (created == NTE_EXISTS) {
    // 只有上层已核验的 generation owner 能到达此处；不覆盖重试前已持久化的 KEK。
    check(::NCryptOpenKey(provider.value, &key.value, wide_name.c_str(), 0, NCRYPT_SILENT_FLAG),
          CITIZENSDK_ERROR_KEY_INVALIDATED, "CitizenSDK existing TPM key is unavailable");
  } else {
    check(created, CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK TPM key creation failed");
  }
  try {
    if (new_key) {
      set_dword(key.value, NCRYPT_LENGTH_PROPERTY, 2048);
      set_dword(key.value, NCRYPT_KEY_USAGE_PROPERTY, NCRYPT_ALLOW_DECRYPT_FLAG);
      set_dword(key.value, NCRYPT_PCP_KEY_USAGE_POLICY_PROPERTY, NCRYPT_PCP_ENCRYPTION_KEY);
      authorize(key.value, pin);
      set_private_security(key.value);
      check(::NCryptFinalizeKey(key.value, NCRYPT_SILENT_FLAG),
            CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK TPM key finalization failed");
    }
    VaultObject result = inspect_key(key.value, name, salt);
    // 正向随机 DEK 检查不注入错误授权；证明本次口令能使用恢复的持久对象。
    // 这不是认证缓存/错误口令测试，也不能代替隔离 Windows TPM 验收。
    SensitiveBuffer challenge(32);
    require(::BCryptGenRandom(nullptr, challenge.data(), 32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0,
            CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK random DEK check is unavailable");
    const Bytes wrapped = encrypt(key.value, challenge.data());
    if (!new_key) authorize(key.value, pin);
    SensitiveBuffer recovered(32);
    decrypt(key.value, wrapped, recovered.data());
    unsigned difference = 0;
    for (std::size_t index = 0; index < 32; ++index) {
      difference |= challenge.data()[index] ^ recovered.data()[index];
    }
    require(difference == 0, CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK TPM DEK check differs");
    return result;
  } catch (...) {
    // 仅清理由本调用新建且尚未交付的 key；绝不删除 NTE_EXISTS 恢复对象。
    if (new_key && key.value != 0 && ::NCryptDeleteKey(key.value, NCRYPT_SILENT_FLAG) == ERROR_SUCCESS) {
      key.value = 0;
    }
    throw;
  }
}

bool Cng::validate_key(const VaultObject &object) const {
  NcryptObject provider;
  NcryptObject key;
  open_key(provider, key, object);
  return true;
}

Bytes Cng::encrypt_dek(const VaultObject &object, const uint8_t plaintext[32]) const {
  require(plaintext != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK DEK must be an exact Rust-owned 32-byte view");
  NcryptObject provider;
  NcryptObject key;
  open_key(provider, key, object);
  return encrypt(key.value, plaintext);
}

void Cng::decrypt_dek(const VaultObject &object, const Bytes &wrapped,
                      const SensitiveBuffer &password, uint8_t output[32]) const {
  require(output != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK DEK output must be an exact Rust-owned 32-byte view");
  secure_zero(output, 32);
  try {
    require(wrapped.size() == kRsaBytes, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK wrapped DEK must be an RSA-2048 block");
    SensitiveBuffer pin = derive_pin(password, object.auth_salt);
    // 每次使用新 provider/key handle，且明确传入本次口令；没有 SDK 授权缓存。
    // 不调用未经 PCP 文档确认的清缓存属性，不声称操作系统缓存已被证明清空。
    NcryptObject provider;
    NcryptObject key;
    open_key(provider, key, object);
    authorize(key.value, pin);
    decrypt(key.value, wrapped, output);  // 输出直接写 Core 持有的 Rust buffer。
  } catch (...) {
    secure_zero(output, 32);
    throw;
  }
}

void Cng::delete_key(const WalletKey &wallet,
                      const std::optional<VaultObject> &expected) const {
  const std::string name = cng_key_name(wallet);
  if (expected) {
    check_object(*expected);
    require(expected->key_name == name, CITIZENSDK_ERROR_KEY_INVALIDATED,
            "CitizenSDK retired key generation differs");
  }
  NcryptObject provider;
  NcryptObject key;
  open_provider(provider);
  const std::wstring wide_name = public_key_name(name);
  const SECURITY_STATUS opened = ::NCryptOpenKey(provider.value, &key.value,
      wide_name.c_str(), 0, NCRYPT_SILENT_FLAG);
  if (opened == NTE_BAD_KEYSET || opened == NTE_NOT_FOUND) return;
  check(opened, CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK retired TPM key open failed");
  const VaultObject actual = inspect_key(key.value, name,
      Bytes(wallet.generation.begin(), wallet.generation.end()));
  require(!expected || (actual.public_blob == expected->public_blob && actual.name == expected->name),
          CITIZENSDK_ERROR_KEY_INVALIDATED, "CitizenSDK retired TPM key identity changed");
  check(::NCryptDeleteKey(key.value, NCRYPT_SILENT_FLAG), CITIZENSDK_ERROR_UNAVAILABLE,
        "CitizenSDK retired TPM key deletion failed");
  key.value = 0;  // DeleteKey 成功已释放句柄；失败路径才交给 RAII FreeObject。
}

}  // namespace citizen_sdk::windows
