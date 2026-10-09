#include "citizen_sdk_lifecycle.hpp"

#include <limits>
#include <exception>

namespace citizen_sdk::linux {



void Lifecycle::begin_service() {
  std::lock_guard<std::mutex> guard(lock_);
  if (state_ == State::kClosing || state_ == State::kClosed) {
    throw HostError(CITIZENSDK_ERROR_INVALID_STATE,
                    "CitizenSDK Host services are closing or closed");
  }
  if (active_services_ == std::numeric_limits<uint64_t>::max()) {
    throw HostError(CITIZENSDK_ERROR_UNAVAILABLE,
                    "CitizenSDK Host service lease capacity is exhausted");
  }
  ++active_services_;
}

void Lifecycle::finish_service() noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  if (active_services_ == 0) std::terminate();
  --active_services_;
}

bool Lifecycle::begin_close() {
  std::lock_guard<std::mutex> guard(lock_);
  if (state_ == State::kClosed) return false;
  if (close_attempt_active_ || active_services_ != 0) {
    throw HostError(CITIZENSDK_ERROR_BUSY,
                    "CitizenSDK Host still owns a service or close attempt");
  }
  state_ = State::kClosing;
  close_attempt_active_ = true;
  return true;
}

void Lifecycle::cancel_close(bool teardown_started) noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  close_attempt_active_ = false;
  if (state_ == State::kClosing && !teardown_started) state_ = State::kOpen;
}

void Lifecycle::commit_closed() noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  close_attempt_active_ = false;
  state_ = State::kClosed;
}


}  // namespace citizen_sdk::linux
