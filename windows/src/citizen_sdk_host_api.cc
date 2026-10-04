#include "citizen_sdk/citizensdk_host.h"

#include <algorithm>
#include <cstring>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <exception>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <thread>
#include <windows.h>
#include "citizen_sdk_host_bridge.hpp"
#include "citizen_sdk_input_limits.hpp"

namespace citizen_sdk::windows {
namespace {

thread_local std::string last_error;
std::mutex &registry_lock() { static auto *value = new std::mutex(); return *value; }


/* 捕获一次保有租约，全部路由/取消闭包共享它；终态不提前释放并发取消仍借用的context。 */
struct HostRequest final {
  citizensdk_host_request_v1_t callbacks;
  citizensdk_handle_t core;
  citizensdk_request_id_t request_id{};
  std::atomic<bool> finished{false};
  HostRequest(const citizensdk_host_request_v1_t &value, citizensdk_handle_t handle)
      : callbacks(value), core(handle) { callbacks.retain(callbacks.context); }
  ~HostRequest() { callbacks.release(callbacks.context); }
};

struct HostEntry final {
  std::shared_ptr<HostBridge> host;
  std::size_t active_calls{};
  bool retiring{false};
  bool abandoned{false};
};

std::unordered_map<citizensdk_host_handle_t, std::shared_ptr<HostEntry>> &registry() {
  static auto *value = new std::unordered_map<citizensdk_host_handle_t,
                                               std::shared_ptr<HostEntry>>();
  return *value;
}
citizensdk_host_handle_t &next_host() {
  static auto *value = new citizensdk_host_handle_t(1); return *value;
}
bool &host_identity_exhausted() {
  static auto *value = new bool(false); return *value;
}

void set_error(const char *message) noexcept {
  try { last_error = message == nullptr ? "CitizenSDK Host failed" : message; }
  catch (...) { last_error.clear(); }
}

void set_error(citizensdk_error_code_t code) noexcept {
  switch (code) {
    case CITIZENSDK_ERROR_INVALID_ARGUMENT: set_error("CitizenSDK Host argument is invalid"); break;
    case CITIZENSDK_ERROR_INVALID_HANDLE: set_error("CitizenSDK Host handle is invalid"); break;
    case CITIZENSDK_ERROR_INVALID_STATE: set_error("CitizenSDK Host state is invalid"); break;
    case CITIZENSDK_ERROR_UNSUPPORTED: set_error("CitizenSDK Host capability is unsupported"); break;
    case CITIZENSDK_ERROR_UNAVAILABLE: set_error("CitizenSDK Host capability is unavailable"); break;
    case CITIZENSDK_ERROR_BUSY: set_error("CitizenSDK Host is busy"); break;
    default: set_error("CitizenSDK Host operation failed"); break;
  }
}

class HostLease final {
 public:
  HostLease() = default;
  HostLease(const HostLease &) = delete;
  HostLease &operator=(const HostLease &) = delete;
  HostLease(HostLease &&other) noexcept
      : entry_(std::move(other.entry_)) {}
  HostLease &operator=(HostLease &&other) noexcept {
    if (this != &other) {
      release();
      entry_ = std::move(other.entry_);
    }
    return *this;
  }
  ~HostLease() { release(); }

  explicit operator bool() const noexcept {
    return entry_ && entry_->host;
  }
  HostBridge *operator->() const noexcept { return entry_->host.get(); }
  const std::shared_ptr<HostEntry> &entry() const noexcept { return entry_; }

 private:
  friend HostLease acquire_host(citizensdk_host_handle_t, bool) noexcept;
  explicit HostLease(std::shared_ptr<HostEntry> entry) noexcept
      : entry_(std::move(entry)) {}
  void release() noexcept {
    if (!entry_) return;
    try {
      std::lock_guard<std::mutex> guard(registry_lock());
      if (entry_->active_calls == 0) std::terminate();
      --entry_->active_calls;
    } catch (...) {
      std::terminate();
    }
    entry_.reset();
  }
  std::shared_ptr<HostEntry> entry_;
};

HostLease acquire_host(citizensdk_host_handle_t handle,
                       bool include_retiring = false) noexcept {
  try {
    std::lock_guard<std::mutex> guard(registry_lock());
    const auto found = registry().find(handle);
    if (found == registry().end() || !found->second ||
        (!include_retiring && found->second->retiring)) {
      return {};
    }
    ++found->second->active_calls;
    return HostLease(found->second);
  } catch (...) {
    // A C ABI lookup must never propagate a C++ synchronization exception.
    return {};
  }
}

citizensdk_error_code_t begin_retirement(
    citizensdk_host_handle_t handle, const HostLease &lease,
    bool abandon) {
  std::lock_guard<std::mutex> guard(registry_lock());
  const auto found = registry().find(handle);
  if (found == registry().end() || found->second != lease.entry()) {
    return CITIZENSDK_ERROR_INVALID_HANDLE;
  }
  const auto &entry = found->second;
  if (entry->retiring) {
    return abandon && entry->abandoned ? CITIZENSDK_OK
                                       : CITIZENSDK_ERROR_BUSY;
  }
  // Never wait for another public call here. A callback-registration call may
  // itself be waiting for this callback thread, and Win32 calls may be needed
  // to finish a provider. Returning BUSY keeps both callers able to unwind.
  if (!abandon && entry->active_calls != 1) return CITIZENSDK_ERROR_BUSY;
  entry->retiring = true;
  // Do not advertise successful supervision until its callback barrier and
  // worker admission have both committed. Concurrent abandon calls are BUSY
  // while this first caller still has a fallible admission step to perform.
  entry->abandoned = false;
  return CITIZENSDK_OK;
}

void cancel_retirement(const std::shared_ptr<HostEntry> &entry) noexcept {
  try {
    std::lock_guard<std::mutex> guard(registry_lock());
    entry->retiring = false;
    entry->abandoned = false;
  } catch (...) {
    std::terminate();
  }
}

std::string required_utf8(citizensdk_bytes_view_t view, uint64_t maximum,
                          const char *label) {
  const Bytes bytes = copy_view(view, maximum, label);
  require(!bytes.empty() && std::find(bytes.begin(), bytes.end(), 0) == bytes.end() &&
              bytes.size() <= static_cast<std::size_t>(std::numeric_limits<int>::max()) &&
              MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                  reinterpret_cast<const char *>(bytes.data()),
                  static_cast<int>(bytes.size()), nullptr, 0) > 0,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, label);
  return std::string(bytes.begin(), bytes.end());
}

citizensdk_error_code_t expose(citizensdk_error_code_t code) noexcept {
  if (code != CITIZENSDK_OK) set_error(code);
  else last_error.clear();
  return code;
}

void supervise_abandoned_host(
    citizensdk_host_handle_t host_handle,
    const std::shared_ptr<HostEntry> &entry) noexcept {
  const std::shared_ptr<HostBridge> host = entry->host;
  auto delay = std::chrono::milliseconds(10);
  for (;;) {
    bool leases_retired = false;
    try {
      std::lock_guard<std::mutex> guard(registry_lock());
      leases_retired = entry->abandoned && entry->active_calls == 0;
    } catch (...) {}
    if (!leases_retired) {
      try { std::this_thread::sleep_for(delay); } catch (...) {}
      delay = std::min(delay * 2, std::chrono::milliseconds(5000));
      continue;
    }
    try { (void)host->set_event_callback(nullptr, nullptr); } catch (...) {}
    const citizensdk_handle_t sdk = host->sdk();
    if (sdk != 0) {
      citizensdk_lifecycle_t lifecycle = 0;
      if (citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK &&
          lifecycle == CITIZENSDK_LIFECYCLE_RUNNING) {
        citizensdk_request_id_t request = 0;
        (void)citizensdk_stop(sdk, &request);
      }
    }
    if (host->close() == CITIZENSDK_OK) {
      try {
        std::lock_guard<std::mutex> guard(registry_lock());
        const auto found = registry().find(host_handle);
        if (found != registry().end() && found->second == entry) {
          registry().erase(found);
        }
        return;
      } catch (...) {
        // Keep the supervisor's shared ownership and retry registry retirement.
      }
    }
    try { std::this_thread::sleep_for(delay); } catch (...) {}
    delay = std::min(delay * 2, std::chrono::milliseconds(5000));
  }
}

}  // namespace
}  // namespace citizen_sdk::windows

extern "C" {

uint32_t citizensdk_host_abi_version(void) {
  return CITIZENSDK_HOST_ABI_VERSION;
}

uint32_t citizensdk_host_config_size(void) {
  return static_cast<uint32_t>(sizeof(citizensdk_host_config_v1_t));
}

citizensdk_error_code_t citizensdk_host_create(
    const citizensdk_host_config_v1_t *config,
    citizensdk_host_handle_t *out_host) {
  const uint32_t modules = config != nullptr && config->enable_wallet != 0
      ? CITIZENSDK_MODULE_FULL
      : CITIZENSDK_MODULE_CHAIN | CITIZENSDK_MODULE_TRANSACTIONS | CITIZENSDK_MODULE_HISTORY;
  return citizensdk_host_create_with_modules(config, modules, out_host);
}

citizensdk_error_code_t citizensdk_host_create_with_modules(
    const citizensdk_host_config_v1_t *config, uint32_t modules,
    citizensdk_host_handle_t *out_host) {
  using namespace citizen_sdk::windows;
  if (out_host == nullptr) return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  *out_host = 0;
  try {
    require(config != nullptr && config->struct_size >= sizeof(*config) &&
                config->abi_version == CITIZENSDK_HOST_ABI_VERSION &&
                config->enable_wallet <= 1 &&
                (config->enable_wallet != 0) ==
                    ((modules & (CITIZENSDK_MODULE_WALLET | CITIZENSDK_MODULE_SIGNING)) != 0) &&
                std::all_of(std::begin(config->reserved),
                            std::end(config->reserved),
                            [](uint8_t byte) { return byte == 0; }),
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK Host configuration ABI is invalid");
    const auto module_code = citizensdk_validate_modules(modules);
    require(module_code == CITIZENSDK_OK, module_code,
            "CitizenSDK module selection is invalid");
    const std::string storage = required_utf8(
        config->storage_root_utf8, input_limits::kMaximumPathBytes,
        "CitizenSDK storage root is invalid UTF-8");
    const std::string assets = (modules & CITIZENSDK_MODULE_CHAIN) != 0 ? required_utf8(
        config->asset_root_utf8, input_limits::kMaximumPathBytes,
        "CitizenSDK asset root is invalid UTF-8") : std::string{};
    const std::string application_id =
        input_limits::validate_application_id(config->application_id_utf8);
    require(std::filesystem::u8path(storage).is_absolute() &&
                ((modules & CITIZENSDK_MODULE_CHAIN) == 0 ||
                 std::filesystem::u8path(assets).is_absolute()),
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK storage and asset roots must be absolute");
    auto bridge = std::make_shared<HostBridge>(
        std::filesystem::u8path(storage), std::filesystem::u8path(assets),
        application_id, config->hwnd,
        modules);
    std::lock_guard<std::mutex> guard(registry_lock());
    require(!host_identity_exhausted(), CITIZENSDK_ERROR_UNAVAILABLE,
            "CitizenSDK Host identity space is exhausted");
    const citizensdk_host_handle_t handle = next_host();
    if (next_host() == std::numeric_limits<citizensdk_host_handle_t>::max()) {
      host_identity_exhausted() = true;
    } else {
      ++next_host();
    }
    auto entry = std::make_shared<HostEntry>();
    entry->host = std::move(bridge);
    require(registry().emplace(handle, std::move(entry)).second,
            CITIZENSDK_ERROR_UNAVAILABLE,
            "CitizenSDK Host identity space is exhausted");
    *out_host = handle;
    last_error.clear();
    return CITIZENSDK_OK;
  } catch (const HostError &error) {
    set_error(error.what()); return error.code();
  } catch (...) {
    set_error("CitizenSDK Host creation failed");
    return CITIZENSDK_ERROR_INTERNAL;
  }
}

citizensdk_error_code_t citizensdk_host_create_sdk(
    citizensdk_host_handle_t host_handle, citizensdk_handle_t *out_sdk) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(host_handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  return expose(host->create_sdk(out_sdk));
}

citizensdk_error_code_t citizensdk_host_sdk(
    citizensdk_host_handle_t host_handle, citizensdk_handle_t *out_sdk) {
  using namespace citizen_sdk::windows;
  if (out_sdk == nullptr) return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto host = acquire_host(host_handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  *out_sdk = host->public_sdk();
  return expose(*out_sdk == 0 ? CITIZENSDK_ERROR_NOT_READY : CITIZENSDK_OK);
}

citizensdk_error_code_t citizensdk_host_set_event_callback(
    citizensdk_host_handle_t host_handle, citizensdk_event_callback_t callback,
    void *context) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(host_handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try {
    return expose(host->set_event_callback(callback, context));
  } catch (...) {
    set_error("CitizenSDK Host callback barrier failed");
    return CITIZENSDK_ERROR_INTERNAL;
  }
}


citizensdk_error_code_t citizensdk_host_submit_request(
    citizensdk_host_handle_t handle, const citizensdk_host_request_v1_t *request,
    citizensdk_request_id_t *out_request_id) {
  using namespace citizen_sdk::windows;
  if (out_request_id == nullptr) return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  *out_request_id = 0;
  if (request == nullptr || request->struct_size != sizeof(*request) ||
      request->abi_version != CITIZENSDK_HOST_ABI_VERSION ||
      request->accept == nullptr || request->complete == nullptr ||
      request->retain == nullptr || request->release == nullptr)
    return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto host = acquire_host(handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try {
    const auto core = host->public_sdk();
    if (core == 0) return expose(CITIZENSDK_ERROR_INVALID_STATE);
    auto state = std::make_shared<HostRequest>(*request, core);
    const auto code = host->submit_private(
        [state](citizensdk_request_id_t *out) {
          return state->callbacks.accept(state->callbacks.context, state->core, out);
        },
        [state](citizensdk_result_handle_t result) noexcept {
          state->finished.store(true);
          // 原Core结果所有权转交一次；接收者必须按其真实种类释放或保有。
          state->callbacks.complete(state->callbacks.context, state->request_id, result);
        },
        &state->request_id,
        [state] {
          if (!state->finished.load() && state->callbacks.cancel != nullptr)
            state->callbacks.cancel(state->callbacks.context, state->core);
        });
    *out_request_id = state->request_id;
    return expose(code);
  } catch (...) { return expose(map_exception()); }
}

citizensdk_error_code_t citizensdk_host_set_credential_provider(
    citizensdk_host_handle_t handle, const citizensdk_credential_provider_v1_t *provider) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try { return expose(host->set_credential_provider(provider)); }
  catch (...) { return expose(map_exception()); }
}
citizensdk_error_code_t citizensdk_host_respond_credential(
    citizensdk_host_handle_t handle, uint64_t host_operation_id,
    citizensdk_bytes_view_t credential) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try { return expose(host->respond_credential(host_operation_id, credential)); }
  catch (...) { return expose(map_exception()); }
}
citizensdk_error_code_t citizensdk_host_cancel_credential(
    citizensdk_host_handle_t handle, uint64_t host_operation_id) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try { return expose(host->cancel_credential(host_operation_id)); }
  catch (...) { return expose(map_exception()); }
}

citizensdk_error_code_t citizensdk_host_set_parent_window(
    citizensdk_host_handle_t host_handle, void *hwnd) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(host_handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  return expose(host->set_parent_window(hwnd));
}

citizensdk_error_code_t citizensdk_host_vault_availability(
    citizensdk_host_handle_t host_handle,
    citizensdk_host_vault_availability_t *out_availability) {
  using namespace citizen_sdk::windows;
  if (out_availability == nullptr) return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto host = acquire_host(host_handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  *out_availability = host->vault_availability();
  return expose(CITIZENSDK_OK);
}

citizensdk_error_code_t citizensdk_host_destroy(
    citizensdk_host_handle_t host_handle) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(host_handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  bool retirement_started = false;
  try {
    citizensdk_error_code_t code = begin_retirement(host_handle, host, false);
    if (code != CITIZENSDK_OK) return expose(code);
    retirement_started = true;
    code = host->close();
    if (code != CITIZENSDK_OK) {
      cancel_retirement(host.entry());
      return expose(code);
    }
    std::lock_guard<std::mutex> guard(registry_lock());
    const auto found = registry().find(host_handle);
    if (found == registry().end() || found->second != host.entry()) {
      set_error("CitizenSDK closed Host registry ownership is inconsistent");
      return CITIZENSDK_ERROR_INTERNAL;
    }
    // begin_retirement admitted destroy with exactly its own lease and closed
    // all ordinary entries. A later include_retiring abandon probe may hold a
    // registry-only lease, but sees retiring/non-abandoned and cannot borrow
    // HostBridge. Its shared_ptr keeps the entry alive after this erase; it
    // must not strand a successfully closed Host in a permanent retiring state.
    registry().erase(found);
  } catch (...) {
    if (retirement_started) cancel_retirement(host.entry());
    set_error("CitizenSDK closed Host registry retirement failed");
    return CITIZENSDK_ERROR_INTERNAL;
  }
  return expose(CITIZENSDK_OK);
}

citizensdk_error_code_t citizensdk_host_abandon(
    citizensdk_host_handle_t host_handle) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(host_handle, true);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try {
    {
      std::lock_guard<std::mutex> guard(registry_lock());
      if (host.entry()->abandoned) return expose(CITIZENSDK_OK);
    }
    const citizensdk_error_code_t retirement =
        begin_retirement(host_handle, host, true);
    if (retirement != CITIZENSDK_OK) return expose(retirement);
  } catch (...) {
    set_error("CitizenSDK Host supervision admission failed");
    return CITIZENSDK_ERROR_INTERNAL;
  }
  try {
    const auto clear = host->set_event_callback(nullptr, nullptr);
    if (clear != CITIZENSDK_OK) {
      cancel_retirement(host.entry());
      return expose(clear);
    }
  } catch (...) {
    cancel_retirement(host.entry());
    set_error("CitizenSDK Host callback could not be retired for supervision");
    return CITIZENSDK_ERROR_INTERNAL;
  }
  std::thread supervisor;
  try {
    // The worker cannot observe the entry before this lock is released. The
    // committed flag therefore means both detach and the callback barrier
    // succeeded; no second abandon can report success for a failed attempt.
    std::lock_guard<std::mutex> guard(registry_lock());
    supervisor = std::thread(
        [host_handle, entry = host.entry()] {
          supervise_abandoned_host(host_handle, entry);
        });
    supervisor.detach();
    host.entry()->abandoned = true;
  } catch (...) {
    if (supervisor.joinable()) std::terminate();
    cancel_retirement(host.entry());
    set_error("CitizenSDK Host supervisor thread is unavailable");
    return CITIZENSDK_ERROR_UNAVAILABLE;
  }
  return expose(CITIZENSDK_OK);
}

citizensdk_error_code_t citizensdk_host_last_error_copy(
    uint8_t *buffer, uint64_t capacity, uint64_t *out_required) {
  using namespace citizen_sdk::windows;
  if (out_required == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  *out_required = static_cast<uint64_t>(last_error.size());
  if (buffer == nullptr) return capacity == 0 ? CITIZENSDK_OK
                                              : CITIZENSDK_ERROR_INVALID_ARGUMENT;
  if (capacity < last_error.size()) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  std::copy(last_error.begin(), last_error.end(), buffer);
  return CITIZENSDK_OK;
}


citizensdk_error_code_t citizensdk_host_open_qr_capture(citizensdk_host_handle_t handle,
    uint32_t purpose, const citizensdk_qr_capture_callbacks_v1_t *callbacks, uint64_t *out_resource) {
  using namespace citizen_sdk::windows;
  if (!out_resource) return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  *out_resource = 0;
  if (!callbacks || callbacks->struct_size != sizeof(*callbacks) ||
      callbacks->abi_version != CITIZENSDK_HOST_ABI_VERSION)
    return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto host = acquire_host(handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try { return expose(host->open_qr_capture(purpose, *callbacks, out_resource)); }
  catch (...) { return expose(map_exception()); }
}
citizensdk_error_code_t citizensdk_host_control_qr_capture(citizensdk_host_handle_t handle,
    uint64_t resource, uint64_t operation, uint32_t action, uint8_t enabled) {
  using namespace citizen_sdk::windows;
  auto host = acquire_host(handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try { return expose(host->control_qr_capture(resource, operation, action, enabled)); }
  catch (...) { return expose(map_exception()); }
}
citizensdk_error_code_t citizensdk_host_decode_qr_image(citizensdk_host_handle_t handle,
    citizensdk_bytes_view_t encoded, uint32_t purpose, uint8_t *buffer, uint64_t capacity, uint64_t *out_required) {
  using namespace citizen_sdk::windows;
  if (!out_required || (!buffer && capacity != 0)) return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto host = acquire_host(handle);
  if (!host) return expose(CITIZENSDK_ERROR_INVALID_HANDLE);
  try {
    const auto bytes = host->decode_qr_image(encoded, purpose);
    if (buffer && capacity < bytes.size()) return expose(CITIZENSDK_ERROR_INVALID_ARGUMENT);
    if (buffer && !bytes.empty()) std::memcpy(buffer, bytes.data(), bytes.size());
    *out_required = static_cast<uint64_t>(bytes.size());
    return expose(CITIZENSDK_OK);
  } catch (...) { return expose(map_exception()); }
}

}  // extern "C"
