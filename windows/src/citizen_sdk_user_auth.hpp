#ifndef CITIZENSDK_WINDOWS_USER_AUTH_HPP
#define CITIZENSDK_WINDOWS_USER_AUTH_HPP

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <thread>
#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>
#include "secret.hpp"
#include "citizensdk_host.h"

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
  citizensdk_error_code_t authorize_add_accounts(uint64_t host_operation_id,
      const std::function<bool(const std::atomic_bool &)> &foreground);
  AuthenticationResult create_vault_password(uint64_t host_operation_id);
  AuthenticationResult unlock_vault_password(uint64_t host_operation_id);
  citizensdk_error_code_t respond(uint64_t host_operation_id, citizensdk_bytes_view_t credential);
  citizensdk_error_code_t cancel(uint64_t host_operation_id);
  void cancel_all();

 private:
  friend struct UserAuthTest;
  // OS只借用context；UserAuth保有状态至全部真实完成，不能把超时/取消当作回调排空。
  struct Biometric final : std::enable_shared_from_this<Biometric> {
    std::atomic_bool cancelled{false};
    std::mutex mutex;
    std::condition_variable ready;
    std::thread worker;
    std::uintptr_t session{};
    bool verify_accepted{false},verified{false},matched{false};
    bool close_accepted{false},close_completed{false},closed{false};
    bool callbacks_drained{false},draining{false};
    bool drained() const noexcept {
      return session==0 || (closed && (!verify_accepted || verified) && callbacks_drained);
    }
  };
  // 调用者已持lock_；只有map成为最后属主且全部完成时才回收context。
  void prune_biometrics_locked() const {
    for(auto entry=biometric_.begin();entry!=biometric_.end();){
      bool done=false;
      {std::lock_guard<std::mutex> guard(entry->second->mutex);done=entry->second.use_count()==1 && entry->second->drained();}
      // 最后一个状态必须在释放其自身mutex之后析构。
      if(done){
        // 回调和工作引用已全部离开；join确认线程真正退出，再释放状态或允许Host销毁。
        if(entry->second->worker.joinable())entry->second->worker.join();
        entry=biometric_.erase(entry);
      }else ++entry;
    }
  }
  static void close_biometric(const std::shared_ptr<Biometric> &state);
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
  mutable std::unordered_map<uint64_t, std::shared_ptr<Biometric>> biometric_;
};

}  // namespace citizen_sdk::windows
#endif
