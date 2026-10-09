#ifndef CITIZENSDK_WINDOWS_SECRET_VAULT_HPP
#define CITIZENSDK_WINDOWS_SECRET_VAULT_HPP

#include <array>
#include <vector>
#include <functional>
#include <memory>
#include <mutex>
#include "citizen_sdk_cng.hpp"
#include "citizen_sdk_operation.hpp"
#include "citizen_sdk_secure_store.hpp"
#include "citizen_sdk_user_auth.hpp"
#include "citizen_sdk_window.hpp"

namespace citizen_sdk::windows {

// 跨 Host/进程/登录会话串行化同一 TPM generation 的持久副作用。
// 只用受当前 SID 保护的内核 mutex，不创建锁文件，不保留认证状态。
class GenerationLock final {
 public:
  explicit GenerationLock(const WalletKey &key, uint32_t timeout_ms = 30000);
  GenerationLock(const GenerationLock &) = delete;
  GenerationLock &operator=(const GenerationLock &) = delete;
  ~GenerationLock();

 private:
  void *handle_{};
};

// 私有依赖接缝：测试只替换 OS 交互，仍执行生产 generation/墓碑状态机。
// 不导出，不接受自定义 signer；凭据仍经UserAuth交给真实CNG操作。
struct SecretVaultServices final {
  std::function<CngAvailability()> availability;
  std::function<std::vector<std::string>()> enumerate_wallet_keys;
  std::function<bool()> authentication_available;
  std::function<citizensdk_error_code_t(uint64_t)> authorize_add_accounts;
  std::function<AuthenticationResult(uint64_t)> create_password;
  std::function<AuthenticationResult(uint64_t)> unlock_password;
  std::function<VaultObject(const WalletKey &, const SensitiveBuffer &)> create_key;
  std::function<bool(const VaultObject &)> validate_key;
  std::function<Bytes(const VaultObject &, const uint8_t *)> encrypt_dek;
  std::function<void(const VaultObject &, const Bytes &, const SensitiveBuffer &, uint8_t *)> decrypt_dek;
  std::function<void(const WalletKey &, const std::optional<VaultObject> &)> delete_key;
};

class SecretVault final {
 public:
  SecretVault(SecureStore &secure_store, WindowRef &parent);
  SecretVault(SecureStore &secure_store, SecretVaultServices services);
  citizensdk_host_vault_availability_t availability() const noexcept;
  void authorize_add_accounts(uint64_t host_operation_id, const WalletKey &key,
      const std::array<uint8_t, 16> &operation_id);
  void ensure_wallet_kek(uint64_t host_operation_id, const WalletKey &key,
                         const std::array<uint8_t, 16> &operation_id);
  bool has_any_wallet_key(uint32_t wallet_index);
  bool has_wallet_kek(const WalletKey &key);
  Bytes wrap_dek(uint64_t host_operation_id, const WalletKey &key,
                 const std::array<uint8_t, 16> &operation_id,
                 const uint8_t plaintext_dek[32]);
  void unwrap_dek(uint64_t host_operation_id, const WalletKey &key,
                  const Bytes &wrapped_dek, uint8_t plaintext_dek_out[32]);
  void retire_wallet_kek(const WalletKey &key,
                         const std::array<uint8_t, 16> &operation_id);
  bool idle() const noexcept;
  citizensdk_error_code_t set_credential_provider(const citizensdk_credential_provider_v1_t *provider);
  citizensdk_error_code_t respond_credential(uint64_t host_operation_id, citizensdk_bytes_view_t credential);
  citizensdk_error_code_t cancel_credential(uint64_t host_operation_id);
  void cancel_credentials();

 private:
  SecureStore &secure_store_;
  WindowRef *parent_{};
  Cng cng_;
  std::unique_ptr<UserAuth> user_auth_;
  SecretVaultServices services_;
  OperationTracker operations_;
  mutable std::recursive_mutex generation_lock_;
};

}  // namespace citizen_sdk::windows
#endif
