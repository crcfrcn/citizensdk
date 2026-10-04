#ifndef CITIZENSDK_LINUX_LIFECYCLE_HPP
#define CITIZENSDK_LINUX_LIFECYCLE_HPP

#include <cstdint>
#include <mutex>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::linux {

class Lifecycle final {
 public:
  // 实际服务租约保有存储/金库；等待宿主凭据期间不持Host互斥锁。
  void begin_service();
  void finish_service() noexcept;
  bool begin_close();
  void cancel_close(bool teardown_started) noexcept;
  void commit_closed() noexcept;

 private:
  enum class State { kOpen, kClosing, kClosed };
  mutable std::mutex lock_;
  State state_{State::kOpen};
  uint64_t active_services_{};
  bool close_attempt_active_{false};
};

}  // namespace citizen_sdk::linux

#endif
