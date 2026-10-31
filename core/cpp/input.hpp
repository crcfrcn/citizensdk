#ifndef CITIZENSDK_INPUT_HPP
#define CITIZENSDK_INPUT_HPP

#include "citizensdk_types.h"
#include <cstddef>
#include <cstdint>
#include <exception>
#include <new>
#include <regex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace citizen_sdk {
class HostError final : public std::runtime_error {
public:
  HostError(citizensdk_error_code_t code, std::string message)
      : std::runtime_error(std::move(message)), code_(code) {}
  citizensdk_error_code_t code() const noexcept { return code_; }

private:
  citizensdk_error_code_t code_;
};

inline void require(bool value, citizensdk_error_code_t code,
                    const char *message) {
  if (!value)
    throw HostError(code, message);
}
using Bytes = std::vector<uint8_t>;
inline citizensdk_error_code_t map_exception() noexcept {
  try {
    throw;
  } catch (const HostError &e) {
    return e.code();
  } catch (const std::bad_alloc &) {
    return CITIZENSDK_ERROR_UNAVAILABLE;
  } catch (...) {
    return CITIZENSDK_ERROR_INTERNAL;
  }
}
inline Bytes copy_view(citizensdk_bytes_view_t value, uint64_t maximum,
                       const char *message) {
  require(value.len <= maximum && (value.len == 0 || value.data),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, message);
  if (value.len == 0)
    return {};
  return Bytes(value.data, value.data + static_cast<size_t>(value.len));
}
namespace input_limits {

inline constexpr uint64_t kMaximumAssetBytes = UINT64_C(128) * 1024 * 1024;
inline constexpr uint64_t kMaximumPathBytes = 4096;
inline constexpr std::size_t kMaximumUnlockPasswordBytes = 1024;
inline std::string validate_application_id(citizensdk_bytes_view_t value) {
  require(value.len <= 253 && (value.len == 0 || value.data != nullptr),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "application_id is too long");
  const std::string identifier(
      value.len == 0 ? "" : reinterpret_cast<const char *>(value.data),
      static_cast<size_t>(value.len));
  static const std::regex pattern(
      R"(^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$)",
      std::regex::ECMAScript);
  require(identifier.size() >= 3 && std::regex_match(identifier, pattern),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "application_id must be a lowercase reverse-DNS identifier");
  return identifier;
}

} // namespace input_limits
} // namespace citizen_sdk

#endif
