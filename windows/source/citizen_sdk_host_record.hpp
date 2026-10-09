#ifndef CITIZENSDK_WINDOWS_HOST_RECORD_HPP
#define CITIZENSDK_WINDOWS_HOST_RECORD_HPP

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "citizensdk_types.h"

namespace citizen_sdk::windows {

using Bytes = std::vector<uint8_t>;

class HostError final : public std::runtime_error {
 public:
  HostError(citizensdk_error_code_t code, std::string message)
      : std::runtime_error(std::move(message)), code_(code) {}
  citizensdk_error_code_t code() const noexcept { return code_; }

 private:
  citizensdk_error_code_t code_;
};

struct HostRecord final {
  citizensdk_host_record_domain_t domain{};
  citizensdk_error_code_t error_code{CITIZENSDK_OK};
  bool present{false};
  uint64_t revision{0};
  Bytes record;

  static HostRecord absent(citizensdk_host_record_domain_t domain);
  static HostRecord value(citizensdk_host_record_domain_t domain,
                          uint64_t revision, Bytes record);
  static HostRecord failure(citizensdk_host_record_domain_t domain,
                            citizensdk_error_code_t code);
};

citizensdk_error_code_t map_exception() noexcept;
void require(bool condition, citizensdk_error_code_t code,
             const char *message);
Bytes copy_view(citizensdk_bytes_view_t view, uint64_t maximum,
                const char *label);

}  // namespace citizen_sdk::windows

#endif
