#include "citizen_sdk_secret_vault.hpp"

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <ncrypt.h>
#include <map>
#include <algorithm>
#include <utility>
#include "citizen_sdk_directory.hpp"
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::windows {
namespace {

// 元数据枚举不触发认证窗口，不打开或导出私钥；只返回SDK自己的非秘密钥名称。
std::vector<std::string> enumerate_wallet_keys() {
  struct Provider {
    NCRYPT_PROV_HANDLE value{};
    ~Provider() { if (value) (void)::NCryptFreeObject(value); }
  } provider;
  const auto opened = ::NCryptOpenStorageProvider(&provider.value, MS_PLATFORM_CRYPTO_PROVIDER, 0);
  require(opened == ERROR_SUCCESS, map_cng_error(static_cast<uint32_t>(opened), CITIZENSDK_ERROR_UNAVAILABLE).code,
      "系统金库枚举不可用");
  struct Enumeration {
    void *value{};
    ~Enumeration() { if (value) (void)::NCryptFreeBuffer(value); }
  } enumeration;
  std::vector<std::string> names;
  std::size_t count = 0;
  for (;;) {
    struct Name {
      NCryptKeyName *value{};
      ~Name() { if (value) (void)::NCryptFreeBuffer(value); }
    } name;
    const auto code = ::NCryptEnumKeys(provider.value, nullptr, &name.value, &enumeration.value, NCRYPT_SILENT_FLAG);
    if (code == NTE_NO_MORE_ITEMS) break;
    require(code == ERROR_SUCCESS, map_cng_error(static_cast<uint32_t>(code), CITIZENSDK_ERROR_UNAVAILABLE).code,
        "系统金库枚举失败");
    require(++count <= 65536 && name.value && name.value->pszName,
        CITIZENSDK_ERROR_INTEGRITY, "系统金库枚举边界无效");
    const auto length = wcsnlen_s(name.value->pszName, 4097);
    require(length <= 4096, CITIZENSDK_ERROR_INTEGRITY, "系统金库名称超过上限");
    const std::wstring wide(name.value->pszName, length);
    if (wide.rfind(L"citizensdk.", 0) != 0) continue;
    require(std::all_of(wide.begin(), wide.end(), [](wchar_t value) { return static_cast<uint32_t>(value) <= 127U; }),
        CITIZENSDK_ERROR_INTEGRITY, "SDK金库名称格式无效");
    std::string name_ascii; name_ascii.reserve(wide.size());
    for (const auto value : wide) name_ascii.push_back(static_cast<char>(value));
    names.push_back(std::move(name_ascii));
  }
  return names;
}

void validate_identity(const WalletKey &key,
                        const std::array<uint8_t, 16> &operation_id) {
  (void)cng_key_name(key);
  require(std::any_of(operation_id.begin(), operation_id.end(),
                     [](uint8_t byte) { return byte != 0; }),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK vault operation identity is invalid");
}

void validate_generation(const WalletKey &key, const VaultObject &object) {
  require(object.key_name == cng_key_name(key) &&
              object.auth_salt == Bytes(key.generation.begin(), key.generation.end()),
          CITIZENSDK_ERROR_KEY_INVALIDATED, "CitizenSDK TPM object belongs to another generation");
}

bool same_object(const VaultObject &left, const VaultObject &right) {
  return left.key_name == right.key_name && left.public_blob == right.public_blob &&
      left.name == right.name && left.auth_salt == right.auth_salt;
}

void require_worker(const WindowRef *parent) {
  require(parent == nullptr || !parent->on_ui_thread(), CITIZENSDK_ERROR_BUSY,
          "CitizenSDK vault operations must not block the UI thread");
}

}  // namespace

GenerationLock::GenerationLock(const WalletKey &key, uint32_t timeout_ms) {
  const std::string key_name = cng_key_name(key);
  Bytes sid = current_user_sid();
  LPWSTR raw_sid = nullptr;
  require(::ConvertSidToStringSidW(sid.data(), &raw_sid), CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK generation lock user identity is unavailable");
  std::wstring name;
  try {
    name = L"Global\\citizensdk." + std::wstring(raw_sid) + L"." +
        std::wstring(key_name.begin() + 11, key_name.end());
  } catch (...) {
    ::LocalFree(raw_sid);
    throw;
  }
  ::LocalFree(raw_sid);
  require(name.size() < MAX_PATH, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK generation lock name is too long");
  Bytes acl_bytes(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid.size());
  auto *acl = reinterpret_cast<ACL *>(acl_bytes.data());
  SECURITY_DESCRIPTOR descriptor{};
  require(::InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
              ::InitializeAcl(acl, static_cast<DWORD>(acl_bytes.size()), ACL_REVISION) &&
              ::AddAccessAllowedAceEx(acl, ACL_REVISION, 0, MUTEX_ALL_ACCESS, sid.data()) &&
              ::SetSecurityDescriptorOwner(&descriptor, sid.data(), FALSE) &&
              ::SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) &&
              ::SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK generation lock security failed");
  SECURITY_ATTRIBUTES attributes{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), &descriptor, FALSE};
  UniqueHandle mutex(::CreateMutexExW(&attributes, name.c_str(), 0,
                                      SYNCHRONIZE | MUTEX_MODIFY_STATE | READ_CONTROL));
  require(static_cast<bool>(mutex), CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK protected generation lock is unavailable");
  PSECURITY_DESCRIPTOR existing = nullptr;
  PSID owner = nullptr;
  PACL existing_acl = nullptr;
  const DWORD queried = ::GetSecurityInfo(mutex.get(), SE_KERNEL_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &existing_acl, nullptr, &existing);
  try {
    SECURITY_DESCRIPTOR_CONTROL control{};
    DWORD revision = 0;
    require(queried == ERROR_SUCCESS && existing != nullptr && owner != nullptr &&
                ::IsValidSid(owner) && ::EqualSid(owner, sid.data()) && existing_acl != nullptr &&
                ::IsValidAcl(existing_acl) && existing_acl->AceCount == 1 &&
                ::GetSecurityDescriptorControl(existing, &control, &revision) &&
                (control & SE_DACL_PROTECTED) != 0,
            CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK generation lock owner or DACL differs");
    void *raw_ace = nullptr;
    require(::GetAce(existing_acl, 0, &raw_ace), CITIZENSDK_ERROR_PERMISSION_DENIED,
            "CitizenSDK generation lock ACE is unavailable");
    const auto *ace = static_cast<const ACCESS_ALLOWED_ACE *>(raw_ace);
    require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0 &&
                ace->Header.AceSize >= sizeof(ACCESS_ALLOWED_ACE) && ace->Mask == MUTEX_ALL_ACCESS &&
                ::IsValidSid(const_cast<DWORD *>(&ace->SidStart)) &&
                ::EqualSid(const_cast<DWORD *>(&ace->SidStart), sid.data()),
            CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK generation lock is not private to its user");
  } catch (...) {
    if (existing != nullptr) ::LocalFree(existing);
    throw;
  }
  ::LocalFree(existing);
  const DWORD wait = ::WaitForSingleObject(mutex.get(), timeout_ms);
  require(wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED, wait == WAIT_TIMEOUT
              ? CITIZENSDK_ERROR_BUSY : CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK generation lock could not be acquired");
  // 前进程崩溃后 mutex 可被接管；调用者仍必须重新读取 SQLite 墓碑、owner、PCP 身份。
  // 不根据 abandoned 状态猜测前一次创建/删除是否成功。
  handle_ = mutex.release();
}

GenerationLock::~GenerationLock() {
  if (handle_ != nullptr) {
    (void)::ReleaseMutex(handle_);
    (void)::CloseHandle(handle_);
  }
}

SecretVault::SecretVault(SecureStore &store, WindowRef &parent)
    : secure_store_(store), parent_(&parent), user_auth_(std::make_unique<UserAuth>()) {
  services_.availability = [this] { return cng_.availability(); };
  services_.authentication_available = [this] { return user_auth_->available(); };
  services_.authorize_add_accounts = [this](uint64_t id) {
    require_worker(parent_);
    auto parent = parent_->acquire();
    require(parent.valid() && parent.get() != nullptr &&
        ::GetForegroundWindow() == static_cast<HWND>(parent.get()),
        CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, "追加认证需要前台窗口");
    return user_auth_->authorize_add_accounts(id);
  };
  services_.create_password = [this](uint64_t id) { return user_auth_->create_vault_password(id); };
  services_.unlock_password = [this](uint64_t host_operation_id) {
    return user_auth_->unlock_vault_password(host_operation_id);
  };
  services_.create_key = [this](const WalletKey &key, const SensitiveBuffer &password) {
    return cng_.create_key(key, password);
  };
  services_.validate_key = [this](const VaultObject &object) { return cng_.validate_key(object); };
  services_.enumerate_wallet_keys = [] { return enumerate_wallet_keys(); };
  services_.encrypt_dek = [this](const VaultObject &object, const uint8_t *input) {
    return cng_.encrypt_dek(object, input);
  };
  services_.decrypt_dek = [this](const VaultObject &object, const Bytes &wrapped,
                                const SensitiveBuffer &password, uint8_t *output) {
    cng_.decrypt_dek(object, wrapped, password, output);
  };
  services_.delete_key = [this](const WalletKey &key, const std::optional<VaultObject> &object) {
    cng_.delete_key(key, object);
  };
}

SecretVault::SecretVault(SecureStore &store, SecretVaultServices services)
    : secure_store_(store), services_(std::move(services)) {
  require(services_.availability && services_.enumerate_wallet_keys && services_.authentication_available &&
              services_.authorize_add_accounts && services_.create_password && services_.unlock_password &&
              services_.create_key && services_.validate_key && services_.encrypt_dek &&
              services_.decrypt_dek && services_.delete_key,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK private vault services are incomplete");
}

citizensdk_host_vault_availability_t SecretVault::availability() const noexcept {
  try {
    const CngAvailability cng = services_.availability();
    if (cng == CngAvailability::kUnsupported) return CITIZENSDK_HOST_VAULT_UNSUPPORTED;
    if (cng != CngAvailability::kAvailable) return CITIZENSDK_HOST_VAULT_UNAVAILABLE;
    if (!services_.authentication_available()) {
      return CITIZENSDK_HOST_VAULT_NO_STRONG_USER_AUTHENTICATION;
    }
    return CITIZENSDK_HOST_VAULT_AVAILABLE;
  } catch (...) {
    return CITIZENSDK_HOST_VAULT_UNAVAILABLE;
  }
}

// 不持有代际锁等待用户；认证前后重新核对同一代际，退休时绝不恢复钥。
void SecretVault::authorize_add_accounts(uint64_t host_operation_id, const WalletKey &key,
    const std::array<uint8_t, 16> &operation_id) {
  require(host_operation_id != 0 && std::any_of(operation_id.begin(), operation_id.end(),
      [](uint8_t value) { return value != 0; }), CITIZENSDK_ERROR_INVALID_ARGUMENT, "追加认证身份无效");
  require(operations_.accept(host_operation_id), CITIZENSDK_ERROR_CONFLICT, "追加认证操作重复");
  try {
    require(has_wallet_kek(key), CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet key is unavailable");
    const auto code = services_.authorize_add_accounts(host_operation_id);
    require(code == CITIZENSDK_OK, code, "账户追加认证未完成");
    require(has_wallet_kek(key), CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet key changed during authentication");
    operations_.finish(host_operation_id);
  } catch (...) { operations_.finish(host_operation_id); throw; }
}

void SecretVault::ensure_wallet_kek(
    uint64_t host_operation_id, const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  validate_identity(key, operation_id);
  require_worker(parent_);
  GenerationLock shared_guard(key);
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  if (availability() != CITIZENSDK_HOST_VAULT_AVAILABLE) {
    throw HostError(CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED,
                    "TPM 2.0 and a credential provider are required");
  }
  if (!secure_store_.ensure_generation(key, operation_id)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                    "wallet generation is retired or owned by another operation");
  }
  if (const auto existing = secure_store_.load_vault_object(key)) {
    validate_generation(key, *existing);
    require(services_.validate_key(*existing), CITIZENSDK_ERROR_KEY_INVALIDATED,
            "wallet TPM object is unavailable");
    if (!secure_store_.generation_owned_by(key, operation_id) ||
        !secure_store_.vault_object_is_active(key, *existing)) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                      "wallet TPM object is no longer owned by provisioning");
    }
    return;
  }
  AuthenticationResult authentication = services_.create_password(host_operation_id);
  if (authentication.code != CITIZENSDK_OK) {
    throw HostError(authentication.code, "CitizenSDK device-vault password creation was cancelled");
  }
  require(!authentication.password.empty(), CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED,
          "CitizenSDK device-vault password is required");
  if (!secure_store_.generation_owned_by(key, operation_id)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                    "wallet generation was retired while authenticating");
  }
  VaultObject object = services_.create_key(key, authentication.password);
  authentication.password.clear();
  validate_generation(key, object);
  try {
    secure_store_.store_vault_object_if_owned(key, operation_id, object);
  } catch (const HostError &error) {
    // 持久 PCP key 不属于失败方的临时资源。CAS/提交后报错不能删除成功方 KEK。
    // 若是同一公开对象且本操作仍持有 generation，允许确认已落盘的同一结果。
    const auto stored = secure_store_.load_vault_object(key);
    if (stored && same_object(*stored, object) &&
        secure_store_.generation_owned_by(key, operation_id) &&
        secure_store_.vault_object_is_active(key, *stored)) return;
    if (error.code() == CITIZENSDK_ERROR_STORAGE && stored) {
      throw HostError(CITIZENSDK_ERROR_CONFLICT, "wallet TPM object was provisioned concurrently");
    }
    throw;
  }
  require(secure_store_.generation_owned_by(key, operation_id) &&
              secure_store_.vault_object_is_active(key, object),
          CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM object was retired during provisioning");
}

bool SecretVault::has_any_wallet_key(uint32_t wallet_index) {
  require_worker(parent_);
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  std::map<std::string, uint32_t> known;
  for (const auto &key : secure_store_.vault_generations()) known.emplace(cng_key_name(key), key.wallet_index);
  const auto names = services_.enumerate_wallet_keys();
  require(names.size() <= 65536, CITIZENSDK_ERROR_UNAVAILABLE, "物理钥数量超过上限");
  for (const auto &name : names) {
    const auto found = known.find(name);
    require(found != known.end(), CITIZENSDK_ERROR_INTEGRITY, "存在无法归属的SDK物理钥");
    if (found->second == wallet_index) return true;
  }
  return false;
}

bool SecretVault::has_wallet_kek(const WalletKey &key) {
  require_worker(parent_);
  GenerationLock shared_guard(key);
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  (void)cng_key_name(key);
  if (!secure_store_.is_generation_active(key)) return false;
  const auto object = secure_store_.load_vault_object(key);
  if (!object || !secure_store_.vault_object_is_active(key, *object)) return false;
  validate_generation(key, *object);
  const bool valid = services_.validate_key(*object);
  return valid && secure_store_.vault_object_is_active(key, *object);
}

Bytes SecretVault::wrap_dek(uint64_t host_operation_id, const WalletKey &key,
                            const std::array<uint8_t, 16> &operation_id,
                            const uint8_t plaintext_dek[32]) {
  require_worker(parent_);
  GenerationLock shared_guard(key);
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  require(plaintext_dek != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "wallet DEK must be an exact Rust-owned 32-byte view");
  // 初始化属于新钱包操作；追加只复用已存在且仍活动的硬件钥。
  (void)host_operation_id;
  validate_identity(key, operation_id);
  if (!secure_store_.is_generation_active(key)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet generation is not active");
  }
  const auto object = secure_store_.load_vault_object(key);
  if (!object || !secure_store_.vault_object_is_active(key, *object)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM object is no longer active");
  }
  validate_generation(key, *object);
  Bytes wrapped = services_.encrypt_dek(*object, plaintext_dek);
  require(secure_store_.vault_object_is_active(key, *object),
          CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM object was retired while wrapping");
  return wrapped;
}

void SecretVault::unwrap_dek(uint64_t host_operation_id, const WalletKey &key,
                             const Bytes &wrapped_dek, uint8_t output[32]) {
  require(output != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "wallet DEK output must be an exact Rust-owned 32-byte view");
  secure_zero(output, 32);
  if (!operations_.accept(host_operation_id)) {
    throw HostError(CITIZENSDK_ERROR_CONFLICT, "duplicate vault operation identity");
  }
  try {
    require_worker(parent_);
    GenerationLock shared_guard(key);
    std::lock_guard<std::recursive_mutex> guard(generation_lock_);
    (void)cng_key_name(key);
    if (!secure_store_.is_generation_active(key)) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet generation is retired");
    }
    const auto object = secure_store_.load_vault_object(key);
    if (!object) throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM object is unavailable");
    validate_generation(key, *object);
    if (availability() != CITIZENSDK_HOST_VAULT_AVAILABLE) {
      throw HostError(CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED,
                      "TPM 2.0 and a credential provider are required");
    }
    AuthenticationResult authentication = services_.unlock_password(host_operation_id);
    if (authentication.code != CITIZENSDK_OK) {
      throw HostError(authentication.code, "CitizenSDK device-vault unlock was cancelled");
    }
    require(!authentication.password.empty(), CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED,
            "CitizenSDK device-vault password is required");
    // 跨线程/进程退休由同一 mutex 串行化；仍在锁内复核状态，防御同步重入或已落墓碑。
    // 本次口令不能授权旧 generation 或被替换的 key。
    if (!secure_store_.vault_object_is_active(key, *object)) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM object was retired while authenticating");
    }
    services_.decrypt_dek(*object, wrapped_dek, authentication.password, output);
    authentication.password.clear();
    if (!secure_store_.vault_object_is_active(key, *object)) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM object was retired while decrypting");
    }
    operations_.finish(host_operation_id);
  } catch (...) {
    // 取消不等于解封完成；所有失败均在通知 Core 前清空 Rust 输出并结算一次操作。
    secure_zero(output, 32);
    operations_.finish(host_operation_id);
    throw;
  }
}

void SecretVault::retire_wallet_kek(
    const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  validate_identity(key, operation_id);
  require_worker(parent_);
  GenerationLock shared_guard(key);
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  // 墓碑先落盘；PCP 删除失败必须保留对象身份，供同一 generation 精确重试。
  // 即使创建后尚未存入对象行便崩溃，也能按 generation 定址，不枚举/批量删 key。
  secure_store_.retire_generation(key, operation_id);
  const auto object = secure_store_.load_vault_object(key);
  if (object) validate_generation(key, *object);
  services_.delete_key(key, object);
  secure_store_.delete_vault_object(key);
}

bool SecretVault::idle() const noexcept { return operations_.empty() && (!user_auth_ || user_auth_->idle()); }

citizensdk_error_code_t SecretVault::set_credential_provider(
    const citizensdk_credential_provider_v1_t *provider) {
  if (!user_auth_) return CITIZENSDK_ERROR_UNSUPPORTED;
  return user_auth_->configure(provider);
}
citizensdk_error_code_t SecretVault::respond_credential(
    uint64_t host_operation_id, citizensdk_bytes_view_t credential) {
  if (!user_auth_) return CITIZENSDK_ERROR_UNSUPPORTED;
  return user_auth_->respond(host_operation_id, credential);
}
citizensdk_error_code_t SecretVault::cancel_credential(uint64_t host_operation_id) {
  if (!user_auth_) return CITIZENSDK_ERROR_UNSUPPORTED;
  return user_auth_->cancel(host_operation_id);
}
void SecretVault::cancel_credentials() {
  if (user_auth_) user_auth_->cancel_all();
}

}  // namespace citizen_sdk::windows
