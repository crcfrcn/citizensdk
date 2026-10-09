#include "citizen_sdk_host_record.hpp"

#include <exception>
#include <limits>
#include <new>

namespace citizen_sdk::windows {

HostRecord HostRecord::absent(citizensdk_host_record_domain_t domain) {
  return {domain, CITIZENSDK_OK, false, 0, {}};
}

HostRecord HostRecord::value(citizensdk_host_record_domain_t domain,
                             uint64_t revision, Bytes record) {
  return {domain, CITIZENSDK_OK, true, revision, std::move(record)};
}

HostRecord HostRecord::failure(citizensdk_host_record_domain_t domain,
                               citizensdk_error_code_t code) {
  return {domain, code, false, 0, {}};
}

citizensdk_error_code_t map_exception() noexcept {
  try {
    throw;
  } catch (const HostError &error) {
    return error.code();
  } catch (const std::bad_alloc &) {
    return CITIZENSDK_ERROR_UNAVAILABLE;
  } catch (...) {
    return CITIZENSDK_ERROR_INTERNAL;
  }
}

void require(bool condition, citizensdk_error_code_t code,
             const char *message) {
  if (!condition) throw HostError(code, message);
}

Bytes copy_view(citizensdk_bytes_view_t view, uint64_t maximum,
                const char *label) {
  require(view.len <= maximum, CITIZENSDK_ERROR_INVALID_ARGUMENT, label);
  require(view.len == 0 || view.data != nullptr,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, label);
  if (view.len == 0) return {};
  return Bytes(view.data, view.data + static_cast<std::size_t>(view.len));
}

}  // namespace citizen_sdk::windows
