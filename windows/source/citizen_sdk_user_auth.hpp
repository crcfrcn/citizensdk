#ifndef CITIZENSDK_WINDOWS_USER_AUTH_HPP
#define CITIZENSDK_WINDOWS_USER_AUTH_HPP

#include <condition_variable>
#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>
#include "citizen_sdk_sensitive_buffer.hpp"
#include "citizen_sdk/citizensdk_host.h"

namespace citizen_sdk::windows {

struct AuthenticationResult final {
  citizensdk_error_code_t code{CITIZENSDK_ERROR_INTERNAL};
  SensitiveBuffer password;
};

// 管理设备凭据与独立追加生物认证；没有认证成功缓存或替代签名器。
class UserAuth final {
 public:
  UserAuth() = default;
  UserAuth(const UserAuth &) = delete;
  UserAuth &operator=(const UserAuth &) = delete;
  citizensdk_error_code_t configure(const citizensdk_credential_provider_v1_t *provider);
  bool available() const noexcept;
  bool idle() const noexcept;
  citizensdk_error_code_t authorize_add_accounts(uint64_t host_operation_id);
  AuthenticationResult create_vault_password(uint64_t host_operation_id);
  AuthenticationResult unlock_vault_password(uint64_t host_operation_id);
  citizensdk_error_code_t respond(uint64_t host_operation_id, citizensdk_bytes_view_t credential);
  citizensdk_error_code_t cancel(uint64_t host_operation_id);
  void cancel_all();

 private:
  struct Provider final {
    explicit Provider(const citizensdk_credential_provider_v1_t &source) : value(source) {
      value.retain(value.context);
    }
    ~Provider() { value.release(value.context); }
    const citizensdk_credential_provider_v1_t value;
  };
  struct Pending final {
    std::condition_variable ready;
    bool done{false};
    AuthenticationResult result;
  };
  AuthenticationResult request(uint32_t key_purpose, uint64_t host_operation_id);
  // 独立回调锁保证request先于cancel；允许宿主同步回包或重入取消。
  std::recursive_mutex callback_lock_;
  mutable std::mutex lock_;
  std::shared_ptr<Provider> provider_;
  std::unordered_map<uint64_t, std::shared_ptr<Pending>> pending_;
  std::unordered_map<uint64_t, std::shared_ptr<std::atomic_bool>> biometric_;
};

}  // namespace citizen_sdk::windows
#endif
