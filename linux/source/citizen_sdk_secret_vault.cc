#include "citizen_sdk_secret_vault.hpp"

#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::linux {

SecretVault::SecretVault(SecureStore &secure_store)
    : secure_store_(secure_store) {}

citizensdk_host_vault_availability_t SecretVault::availability() const noexcept {
  const TpmAvailability tpm = tpm_.availability();
  if (tpm == TpmAvailability::kUnsupported) {
    return CITIZENSDK_HOST_VAULT_UNSUPPORTED;
  }
  if (tpm == TpmAvailability::kUnavailable) {
    return CITIZENSDK_HOST_VAULT_UNAVAILABLE;
  }
  if (!user_auth_.available()) {
    return CITIZENSDK_HOST_VAULT_NO_STRONG_USER_AUTHENTICATION;
  }
  return CITIZENSDK_HOST_VAULT_AVAILABLE;
}

// 不持有代际锁等待用户；认证前后重新核对同一代际，退休时绝不恢复钥。
void SecretVault::authorize_add_accounts(uint64_t host_operation_id, const WalletKey &key,
    const std::array<uint8_t, 16> &operation_id) {
  require(host_operation_id != 0 && std::any_of(operation_id.begin(), operation_id.end(),
      [](uint8_t value) { return value != 0; }), CITIZENSDK_ERROR_INVALID_ARGUMENT, "追加认证身份无效");
  require(operations_.accept(host_operation_id), CITIZENSDK_ERROR_CONFLICT, "追加认证操作重复");
  try {
    require(has_wallet_kek(key), CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet key is unavailable");
    const auto code = user_auth_.authorize_add_accounts(host_operation_id);
    require(code == CITIZENSDK_OK, code, "账户追加认证未完成");
    require(has_wallet_kek(key), CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet key changed during authentication");
    operations_.finish(host_operation_id);
  } catch (...) { operations_.finish(host_operation_id); throw; }
}

void SecretVault::ensure_wallet_kek(
    uint64_t host_operation_id, const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  require(key.wallet_index == 0, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "only CitizenSDK wallet index 0 is supported");
  if (availability() != CITIZENSDK_HOST_VAULT_AVAILABLE) {
    throw HostError(CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED,
                    "TPM 2.0 and a credential provider are required");
  }
  if (!secure_store_.ensure_generation(key, operation_id)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                    "wallet generation is retired or owned by another operation");
  }
  if (const auto existing = secure_store_.load_vault_object(key)) {
    (void)tpm_.validate_key(*existing);
    if (!secure_store_.generation_owned_by(key, operation_id) ||
        !secure_store_.vault_object_is_active(key, *existing)) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                      "wallet TPM object is no longer owned by provisioning");
    }
    return;
  }
  AuthenticationResult authentication = user_auth_.create_vault_password(host_operation_id);
  if (authentication.code != CITIZENSDK_OK) {
    throw HostError(authentication.code,
                    "CitizenSDK device-vault password creation was cancelled");
  }
  if (!secure_store_.generation_owned_by(key, operation_id)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                    "wallet generation was retired while authenticating");
  }
  VaultObject object = tpm_.create_key(authentication.password);
  authentication.password.clear();
  try {
    secure_store_.store_vault_object_if_owned(key, operation_id, object);
  } catch (const HostError &error) {
    if (error.code() == CITIZENSDK_ERROR_STORAGE &&
        secure_store_.load_vault_object(key).has_value()) {
      throw HostError(CITIZENSDK_ERROR_CONFLICT,
                      "wallet TPM object was provisioned concurrently");
    }
    throw;
  }
}

bool SecretVault::has_any_wallet_key(uint32_t wallet_index) {
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  return secure_store_.has_any_wallet_key(wallet_index);
}

bool SecretVault::has_wallet_kek(const WalletKey &key) {
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  if (!secure_store_.is_generation_active(key)) return false;
  const auto object = secure_store_.load_vault_object(key);
  if (!object) return false;
  if (!secure_store_.vault_object_is_active(key, *object)) return false;
  return tpm_.validate_key(*object);
}

Bytes SecretVault::wrap_dek(
    uint64_t host_operation_id, const WalletKey &key, const std::array<uint8_t, 16> &operation_id,
    const uint8_t plaintext_dek[32]) {
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  require(plaintext_dek != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "wallet DEK must be an exact Rust-owned 32-byte view");
  // 使用既有钥；缺失或退休时失败，不重新认证创建另一把钥。
  (void)host_operation_id;
  require(key.wallet_index == 0 &&
              std::any_of(operation_id.begin(), operation_id.end(), [](uint8_t value) { return value != 0; }),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "wallet vault identity is invalid");
  if (!secure_store_.is_generation_active(key)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet generation is not active");
  }
  const auto object = secure_store_.load_vault_object(key);
  if (!object) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                    "wallet TPM object is unavailable");
  }
  if (!secure_store_.vault_object_is_active(key, *object)) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                    "wallet TPM object is no longer active");
  }
  require(tpm_.validate_key(*object), CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM key is unavailable");
  Bytes wrapped = tpm_.encrypt_dek(*object, plaintext_dek);
  require(secure_store_.vault_object_is_active(key, *object),
          CITIZENSDK_ERROR_KEY_INVALIDATED, "wallet TPM object was retired while wrapping");
  return wrapped;
}

void SecretVault::unwrap_dek(uint64_t host_operation_id, const WalletKey &key,
                             const Bytes &wrapped_dek,
                             uint8_t plaintext_dek_out[32]) {
  require(plaintext_dek_out != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "wallet DEK output must be an exact Rust-owned 32-byte view");
  if (!operations_.accept(host_operation_id)) {
    throw HostError(CITIZENSDK_ERROR_CONFLICT,
                    "duplicate vault operation identity");
  }
  try {
    std::lock_guard<std::recursive_mutex> guard(generation_lock_);
    if (!secure_store_.is_generation_active(key)) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                      "wallet generation is retired");
    }
    const auto object = secure_store_.load_vault_object(key);
    if (!object) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                      "wallet TPM object is unavailable");
    }
    AuthenticationResult authentication = user_auth_.unlock_vault_password(host_operation_id);
    if (authentication.code != CITIZENSDK_OK) {
      throw HostError(authentication.code,
                      "CitizenSDK device-vault unlock was cancelled");
    }
    // 宿主凭据等待期间可能发生退休或替换；取得字节后必须重新核对
    // 持久墓碑及准确TPM对象身份，不能用已失效代际的凭据继续解密。
    if (!secure_store_.vault_object_is_active(key, *object)) {
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                      "wallet TPM object was retired while authenticating");
    }
    tpm_.decrypt_dek(*object, wrapped_dek, authentication.password,
                     plaintext_dek_out);
    authentication.password.clear();
    if (!secure_store_.vault_object_is_active(key, *object)) {
      secure_zero(plaintext_dek_out, 32);
      throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                      "wallet TPM object was retired while decrypting");
    }
    operations_.finish(host_operation_id);
  } catch (...) {
    secure_zero(plaintext_dek_out, 32);
    operations_.finish(host_operation_id);
    throw;
  }
}

void SecretVault::retire_wallet_kek(
    const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  std::lock_guard<std::recursive_mutex> guard(generation_lock_);
  // The tombstone is the irreversible commit point. Physical TPM blobs are
  // removed only afterwards, so a crash can never resurrect the generation.
  secure_store_.retire_generation(key, operation_id);
  secure_store_.delete_vault_object(key);
}

bool SecretVault::idle() const noexcept { return operations_.empty() && user_auth_.idle(); }

citizensdk_error_code_t SecretVault::set_credential_provider(
    const citizensdk_credential_provider_v1_t *provider) {
  return user_auth_.configure(provider);
}
citizensdk_error_code_t SecretVault::respond_credential(
    uint64_t host_operation_id, citizensdk_bytes_view_t credential) {
  return user_auth_.respond(host_operation_id, credential);
}
citizensdk_error_code_t SecretVault::cancel_credential(uint64_t host_operation_id) {
  return user_auth_.cancel(host_operation_id);
}
void SecretVault::cancel_credentials() {
  user_auth_.cancel_all();
}

}  // namespace citizen_sdk::linux
