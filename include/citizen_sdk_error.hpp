#ifndef CITIZENSDK_CPP_ERROR_HPP
#define CITIZENSDK_CPP_ERROR_HPP

#include <stdexcept>
#include <optional>
#include <string>
#include <utility>
#include <vector>
#include "citizen_sdk/citizensdk_host.h"

namespace citizen_sdk {

inline citizensdk_failure_stage_t default_failure_stage(citizensdk_error_code_t code) noexcept {
  switch (code) {
    case CITIZENSDK_ERROR_INVALID_ARGUMENT: case CITIZENSDK_ERROR_DECODE:
      return CITIZENSDK_FAILURE_STAGE_VALIDATION;
    case CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED:
    case CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED:
    case CITIZENSDK_ERROR_KEY_INVALIDATED: case CITIZENSDK_ERROR_PERMISSION_DENIED:
      return CITIZENSDK_FAILURE_STAGE_AUTHENTICATION;
    case CITIZENSDK_ERROR_STORAGE: return CITIZENSDK_FAILURE_STAGE_PERSISTENCE;
    case CITIZENSDK_ERROR_UNAVAILABLE: case CITIZENSDK_ERROR_NETWORK:
    case CITIZENSDK_ERROR_TIMEOUT: return CITIZENSDK_FAILURE_STAGE_PROVIDER;
    case CITIZENSDK_ERROR_INTEGRITY: return CITIZENSDK_FAILURE_STAGE_VERIFICATION;
    case CITIZENSDK_ERROR_CANCELLED: return CITIZENSDK_FAILURE_STAGE_CANCELLATION;
    case CITIZENSDK_ERROR_INTERNAL: case CITIZENSDK_ERROR_PANIC:
      return CITIZENSDK_FAILURE_STAGE_TEARDOWN;
    default: return CITIZENSDK_FAILURE_STAGE_ADMISSION;
  }
}

class Error final : public std::runtime_error {
 public:
  Error(citizensdk_error_code_t code, std::string message,
        citizensdk_failure_stage_t stage = 0, std::string method = {},
        std::optional<std::string> session = {}, std::optional<int64_t> sequence = {})
      : std::runtime_error(std::move(message)), code_(code),
        stage_(stage == 0 ? default_failure_stage(code) : stage), method_(std::move(method)),
        session_(std::move(session)), sequence_(sequence) {}
  citizensdk_error_code_t code() const noexcept { return code_; }
  citizensdk_failure_stage_t stage() const noexcept { return stage_; }
  const std::string &method() const noexcept { return method_; }
  const std::optional<std::string> &session() const noexcept { return session_; }
  const std::optional<int64_t> &sequence() const noexcept { return sequence_; }

 private:
  citizensdk_error_code_t code_;
  citizensdk_failure_stage_t stage_;
  std::string method_;
  std::optional<std::string> session_;
  std::optional<int64_t> sequence_;
};

inline std::string last_host_error(const char *fallback) {
  uint64_t needed = 0;
  if (citizensdk_host_last_error_copy(nullptr, 0, &needed) != CITIZENSDK_OK || needed == 0) {
    return fallback;
  }
  std::vector<uint8_t> bytes(static_cast<std::size_t>(needed));
  if (citizensdk_host_last_error_copy(bytes.data(), needed, &needed) != CITIZENSDK_OK) {
    return fallback;
  }
  return std::string(bytes.begin(), bytes.end());
}

inline void throw_if_error(citizensdk_error_code_t code, const char *fallback) {
  if (code != CITIZENSDK_OK) throw Error(code, last_host_error(fallback));
}

}  // namespace citizen_sdk

#endif
