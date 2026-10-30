#include "citizensdk_host.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <future>
#include <thread>

static_assert(sizeof(citizensdk_host_config_v1_t) == 64, "Host ABI2 layout");

#ifdef NDEBUG
#error "CitizenSDK assertions must remain enabled"
#endif

namespace {
citizensdk_bytes_view_t view(const char *text) {
  return {reinterpret_cast<const uint8_t *>(text),
          static_cast<uint64_t>(std::strlen(text))};
}
struct Work {
  std::promise<void> entered;
  std::atomic<bool> released{false}, completed{false};
  std::atomic<unsigned> references{0};
  std::atomic<uint64_t> request{0};
};
void retain(void *value) {
  static_cast<Work *>(value)->references.fetch_add(1);
}
void release(void *value) {
  assert(static_cast<Work *>(value)->references.fetch_sub(1) > 0);
}
citizensdk_error_code_t accept(void *, citizensdk_handle_t core,
                               citizensdk_request_id_t *request) {
  return citizensdk_get_sync_status(core, request);
}
void cancel(void *, citizensdk_handle_t) {}
void complete(void *context, citizensdk_request_id_t request,
              citizensdk_result_handle_t result) {
  // 完成回调真实保有结果；BUSY不能伪装关闭，解除屏障后归还同一结果。
  auto &work = *static_cast<Work *>(context);
  try {
    assert(request != 0 && result != 0);
    work.request.store(request);
    citizensdk_result_info_t info{};
    info.struct_size = sizeof(info);
    info.abi_version = CITIZENSDK_ABI_VERSION;
    assert(citizensdk_result_get_info(result, &info) == CITIZENSDK_OK);
    work.entered.set_value();
    while (!work.released.load())
      std::this_thread::yield();
    assert(citizensdk_result_release(result) == CITIZENSDK_OK);
    work.completed.store(true);
  } catch (...) {
    std::abort();
  }
}
} // namespace

int main(int argc, char **argv) {
  assert(argc == 3);
  assert(citizensdk_abi_version() == CITIZENSDK_ABI_VERSION);
  assert(citizensdk_host_abi_version() == CITIZENSDK_HOST_ABI_VERSION);
  citizensdk_host_config_v1_t config{};
  config.struct_size = sizeof(config);
  config.abi_version = CITIZENSDK_HOST_ABI_VERSION;
  config.storage_root_utf8 = view(argv[1]);
  config.asset_root_utf8 = view(argv[2]);
  config.application_id_utf8 = view("org.citizensdk.cppconsumer");
  citizensdk_host_handle_t host = 0;
  assert(citizensdk_host_create(
             &config, CITIZENSDK_MODULE_CHAIN | CITIZENSDK_MODULE_TRANSACTIONS,
             &host) == CITIZENSDK_OK);
  citizensdk_handle_t core = 0;
  assert(citizensdk_host_create_sdk(host, &core) == CITIZENSDK_OK && core != 0);
  Work work;
  auto entered = work.entered.get_future();
  const citizensdk_host_request_v1_t callbacks{sizeof(callbacks),
                                               CITIZENSDK_HOST_ABI_VERSION,
                                               &work,
                                               accept,
                                               complete,
                                               cancel,
                                               retain,
                                               release};
  citizensdk_request_id_t request = 0;
  assert(citizensdk_host_submit_request(host, &callbacks, &request) ==
             CITIZENSDK_OK &&
         request != 0);
  assert(entered.wait_for(std::chrono::seconds(30)) ==
         std::future_status::ready);
  assert(work.request.load() == request);
  assert(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_BUSY);
  work.released.store(true);
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (!work.completed.load() || work.references.load() != 0) {
    assert(std::chrono::steady_clock::now() < deadline);
    std::this_thread::yield();
  }
  auto code = CITIZENSDK_ERROR_BUSY;
  while (code == CITIZENSDK_ERROR_BUSY) {
    assert(std::chrono::steady_clock::now() < deadline);
    code = citizensdk_host_destroy(host);
    if (code == CITIZENSDK_ERROR_BUSY)
      std::this_thread::yield();
  }
  assert(code == CITIZENSDK_OK);
  assert(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_INVALID_HANDLE);
  citizensdk_lifecycle_t lifecycle = 0;
  assert(citizensdk_get_lifecycle(core, &lifecycle) ==
         CITIZENSDK_ERROR_INVALID_HANDLE);
  std::puts("CitizenSDK direct C++ consumer passed");
}
