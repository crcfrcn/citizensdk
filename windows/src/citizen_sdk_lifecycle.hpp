#ifndef CITIZENSDK_WINDOWS_LIFECYCLE_HPP
#define CITIZENSDK_WINDOWS_LIFECYCLE_HPP

#include <cstdint>
#include <mutex>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::windows {

class Lifecycle final {
 public:
  // A service lease retains stores/vault across a provider call without
  // holding a Host mutex while that call waits for Win32 authentication.
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

}  // namespace citizen_sdk::windows

#endif
