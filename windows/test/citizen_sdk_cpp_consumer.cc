// 沿用 Linux 已安装消费者的生命周期合同；Windows 改用宽字符路径和公开回调屏障。
// 只使用公开头，不重编 Host/Core，也不提供存储或链服务替身。
#include <windows.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

#include <citizen_sdk/citizen_sdk.hpp>

// 安装消费者直接核对根 C ABI；不为链查询复制 C++ Host 成员或业务逻辑。
static_assert(std::is_same_v<decltype(&citizensdk_get_genesis_hash),
    citizensdk_error_code_t (*)(citizensdk_handle_t, uint8_t *)>);
static_assert(std::is_same_v<decltype(&citizensdk_get_finalized_account_balances),
    citizensdk_error_code_t (*)(citizensdk_handle_t, const citizensdk_account_id_t *,
                               uint32_t, citizensdk_request_id_t *)>);
static_assert(std::is_same_v<decltype(&citizensdk_result_get_account_balance_count),
    citizensdk_error_code_t (*)(citizensdk_result_handle_t, uint32_t *)>);
static_assert(std::is_same_v<decltype(&citizensdk_result_get_account_balance_at),
    citizensdk_error_code_t (*)(citizensdk_result_handle_t, uint32_t,
                               citizensdk_account_balance_info_t *)>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::getState),
    citizen_sdk::Operation<citizen_sdk::WalletState> (citizen_sdk::Host::*)()>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::inspect),
    citizen_sdk::Operation<std::shared_ptr<citizen_sdk::WalletInspection>> (citizen_sdk::Host::*)()>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::openPrivateKey),
    std::shared_future<std::shared_ptr<citizen_sdk::PrivateKey>> (citizen_sdk::Host::*)(citizen_sdk::AccountId)>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::openCapture),
    std::shared_future<std::shared_ptr<citizen_sdk::QrCapture>> (citizen_sdk::Host::*)(uint32_t, citizen_sdk::QrCapture::Listener)>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::reviewQrRequest),
    citizen_sdk::Operation<std::shared_ptr<citizen_sdk::QrReview>> (citizen_sdk::Host::*)(std::string)>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::signQrRequest),
    citizen_sdk::Operation<citizen_sdk::QrSigned> (citizen_sdk::Host::*)(const std::shared_ptr<citizen_sdk::QrReview> &)>);
// C++关键字映射及Core真实终态保持唯一接口，不增加兼容删除/消费别名。
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::erase),
    citizen_sdk::Operation<void> (citizen_sdk::Host::*)()>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::reconcileCleanup),
    citizen_sdk::Operation<void> (citizen_sdk::Host::*)()>);
static_assert(std::is_same_v<decltype(&citizen_sdk::Host::consumeExternalSignature),
    citizen_sdk::Operation<citizen_sdk::SigningOutcome> (citizen_sdk::Host::*)(std::string, std::string)>);
static_assert(CITIZENSDK_RESULT_ACCOUNT_BALANCES == 18);
static_assert(CITIZENSDK_RESULT_QR_REVIEW == 19 && CITIZENSDK_RESULT_QR_SIGNED == 20);

#ifdef NDEBUG
#error "CitizenSDK consumer checks must remain enabled in Release"
#endif

namespace {

void require(bool condition, int line) {
  if (!condition) {
    std::fprintf(stderr, "CitizenSDK C++ consumer failed at line %d\n", line);
    std::abort();
  }
}
#define CHECK(condition) require(static_cast<bool>(condition), __LINE__)

void check_fresh_namespace(const std::filesystem::path &root,
                           const std::wstring &application_id) {
  CHECK(root.is_absolute() && root != root.root_path());
  for (const auto &part : root) CHECK(part != L"." && part != L"..");
  const auto child = root / application_id;
  ::SetLastError(ERROR_SUCCESS);
  CHECK(::GetFileAttributesW(child.c_str()) == INVALID_FILE_ATTRIBUTES);
  const DWORD missing = ::GetLastError();
  CHECK(missing == ERROR_FILE_NOT_FOUND || missing == ERROR_PATH_NOT_FOUND);
  // 不创建/改权已有目录；真正的 HANDLE/SID/DACL/FileId 验证由公开 Host 执行。
}

void check_loaded_dll(const std::filesystem::path &runtime, const wchar_t *name) {
  CHECK(runtime.is_absolute() && name != nullptr);
  const HMODULE module = ::GetModuleHandleW(name);
  CHECK(module != nullptr);
  std::vector<wchar_t> actual(32768);
  const DWORD actual_len = ::GetModuleFileNameW(module, actual.data(),
                                               static_cast<DWORD>(actual.size()));
  CHECK(actual_len != 0 && actual_len < actual.size());
  const auto wanted = runtime / name;
  std::vector<wchar_t> expected(32768);
  const DWORD expected_len = ::GetFullPathNameW(wanted.c_str(),
      static_cast<DWORD>(expected.size()), expected.data(), nullptr);
  CHECK(expected_len != 0 && expected_len < expected.size());
  CHECK(::CompareStringOrdinal(actual.data(), -1, expected.data(), -1, TRUE) == CSTR_EQUAL);
}

void check_capabilities(const citizen_sdk::Capabilities &snapshot) {
  CHECK(snapshot.statuses.size() == CITIZENSDK_CAPABILITY_COUNT);
  std::set<citizensdk_capability_name_t> names;
  for (const auto &status : snapshot.statuses) {
    CHECK(status.name >= 1 && status.name <= CITIZENSDK_CAPABILITY_COUNT);
    CHECK(names.insert(status.name).second);
    CHECK(status.reason <= CITIZENSDK_CAPABILITY_REASON_STORAGE_UNAVAILABLE);
    CHECK(!status.ready || (status.supported && status.available &&
          status.enabled && status.reason == CITIZENSDK_CAPABILITY_REASON_NONE));
    if (status.name == CITIZENSDK_CAPABILITY_HARDWARE_VAULT ||
        status.name == CITIZENSDK_CAPABILITY_LOCAL_SIGNING) CHECK(!status.ready);
  }
}

struct Completion final {
  std::mutex lock;
  std::condition_variable changed;
  citizensdk_request_id_t request{};
  citizensdk_result_info_t info{};
  uint64_t last_sequence{};
  unsigned count{};

  void receive(const citizensdk_event_t &event) {
    CHECK(event.struct_size >= sizeof(event) && event.abi_version == CITIZENSDK_ABI_VERSION);
    std::lock_guard<std::mutex> guard(lock);
    CHECK(event.sequence > last_sequence);
    last_sequence = event.sequence;
    if (event.event_type != CITIZENSDK_EVENT_REQUEST_COMPLETED) {
      CHECK(event.result == 0);
      return;
    }
    CHECK(count == 0 && event.request_id != 0 && event.result != 0);
    info.struct_size = sizeof(info);
    info.abi_version = CITIZENSDK_ABI_VERSION;
    CHECK(citizensdk_result_get_info(event.result, &info) == CITIZENSDK_OK);
    request = event.request_id;
    ++count;
    changed.notify_all();
    // C++ 回调只借用 result；仅复制公开 info/id，不保存句柄或 event 指针。
    // 公开 Host trampoline 在返回后唯一释放，消费者绝不手动 release。
  }

  void prepare(citizen_sdk::Host &host) {
    {
      std::lock_guard<std::mutex> guard(lock);
      request = 0;
      info = {};
      count = 0;
    }
    host.set_event_observer([this](const citizensdk_event_t &event) { receive(event); });
  }

  void await(citizen_sdk::Host &host, citizensdk_request_id_t accepted,
             citizensdk_error_code_t expected = CITIZENSDK_OK) {
    {
      std::unique_lock<std::mutex> guard(lock);
      CHECK(changed.wait_for(guard, std::chrono::seconds(60), [&] { return count == 1; }));
      CHECK(accepted != 0 && request == accepted && info.error_code == expected);
      if (expected == CITIZENSDK_OK) CHECK(info.kind == CITIZENSDK_RESULT_EMPTY);
    }
    // notify 早于回调返回。公开 clear 是同步屏障，成功后 trampoline 已经
    // 释放结果；不把借用句柄带出回调轮询，也不和最后一个回调竞态 close。
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    for (;;) {
      try {
        host.set_event_observer({});
        return;
      } catch (const citizen_sdk::Error &error) {
        CHECK(error.code() == CITIZENSDK_ERROR_BUSY);
        CHECK(std::chrono::steady_clock::now() < deadline);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    }
  }
};

citizensdk_request_id_t accept_request(citizensdk_handle_t sdk,
    citizensdk_error_code_t (*operation)(citizensdk_handle_t, citizensdk_request_id_t *)) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  for (;;) {
    citizensdk_request_id_t request = 0;
    const auto code = operation(sdk, &request);
    if (code == CITIZENSDK_OK) {
      CHECK(request != 0);
      return request;
    }
    CHECK(code == CITIZENSDK_ERROR_BUSY && request == 0);
    CHECK(std::chrono::steady_clock::now() < deadline);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

void close_with_retry(citizen_sdk::Host &host) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  for (;;) {
    try {
      host.close();
      return;
    } catch (const citizen_sdk::Error &error) {
      CHECK(error.code() == CITIZENSDK_ERROR_BUSY);
      CHECK(std::chrono::steady_clock::now() < deadline);
      // 关闭已开始后仅重试关闭，不能将 teardown-only 句柄重新投入使用。
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
}

}  // namespace

int wmain(int argc, wchar_t **argv) {
  CHECK(argc == 4);
  try {
    check_loaded_dll(argv[3], L"citizensdk.dll");
    check_loaded_dll(argv[3], L"citizensdk_host.dll");
    citizen_sdk::Config config;
    config.storage_root = argv[1];
    config.asset_root = argv[2];
    config.application_id = "org.citizensdk.cppconsumer";
    config.hwnd = nullptr;
    config.modules = CITIZENSDK_MODULE_CHAIN | CITIZENSDK_MODULE_TRANSACTIONS | CITIZENSDK_MODULE_HISTORY;
    check_fresh_namespace(config.storage_root, L"org.citizensdk.cppconsumer");
    CHECK(config.asset_root.is_absolute());
    CHECK(citizensdk_abi_version() == CITIZENSDK_ABI_VERSION);
    CHECK(citizensdk_host_abi_version() == CITIZENSDK_HOST_ABI_VERSION);
    CHECK(citizensdk_create_options_size() == sizeof(citizensdk_create_options_t));
    CHECK(citizensdk_host_config_size() == sizeof(citizensdk_host_config_v1_t));

    Completion completion;  // 比 Host 长寿；成功关闭/同步清回调后才销毁上下文。
    citizen_sdk::Host original(config);
    CHECK(original.host_handle() != 0 && original.native_handle() == 0);
    bool unopened_rejected = false;
    try { (void)original.capabilities(); }
    catch (const citizen_sdk::Error &error) {
      unopened_rejected = error.code() == CITIZENSDK_ERROR_INVALID_HANDLE;
    }
    CHECK(unopened_rejected);
    citizen_sdk::Host host(std::move(original));
    CHECK(original.host_handle() == 0 && original.native_handle() == 0);
    CHECK(host.vault_availability() == CITIZENSDK_HOST_VAULT_UNSUPPORTED);
    host.open();
    const citizensdk_handle_t sdk = host.native_handle();
    CHECK(sdk != 0);
    host.open();
    CHECK(host.native_handle() == sdk);
    citizensdk_lifecycle_t lifecycle = 0;
    // 同步创世身份不要求 start，也不应改变 Created 状态或越过输出边界。
    uint8_t genesis_hash[34]{};
    genesis_hash[0] = genesis_hash[33] = UINT8_C(0x5a);
    CHECK(citizensdk_get_genesis_hash(sdk, genesis_hash + 1) == CITIZENSDK_OK);
    CHECK(genesis_hash[0] == UINT8_C(0x5a) && genesis_hash[33] == UINT8_C(0x5a));
    unsigned genesis_nonzero = 0;
    for (unsigned index = 1; index <= 32; ++index) genesis_nonzero |= genesis_hash[index];
    CHECK(genesis_nonzero != 0);
    CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK);
    CHECK(lifecycle == CITIZENSDK_LIFECYCLE_CREATED);
    check_capabilities(host.capabilities());
    // 当前实例未选择钱包/签名；实际Cpp请求必须给出Core拒绝且不留资源。
    {
      const auto operation = host.getState();
      CHECK(operation.operationId() == "1");
      CHECK(operation.result().wait_for(std::chrono::seconds(5)) == std::future_status::ready);
      bool rejected = false;
      try { (void)operation.result().get(); } catch (const citizen_sdk::Error &error) { rejected = error.code() == CITIZENSDK_ERROR_UNSUPPORTED; }
      CHECK(rejected && !operation.cancel());
      const auto private_key = host.openPrivateKey(citizen_sdk::AccountId{});
      CHECK(private_key.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
      rejected = false;
      try { (void)private_key.get(); } catch (const citizen_sdk::Error &error) {
        rejected = error.code() == CITIZENSDK_ERROR_UNSUPPORTED || error.code() == CITIZENSDK_ERROR_NOT_READY;
      }
      CHECK(rejected);
    }

    completion.prepare(host);
    auto request = accept_request(sdk, citizensdk_get_finalized_head);
    completion.await(host, request, CITIZENSDK_ERROR_NOT_READY);

    completion.prepare(host);
    request = accept_request(sdk, citizensdk_start);
    completion.await(host, request);
    CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK);
    CHECK(lifecycle == CITIZENSDK_LIFECYCLE_RUNNING);
    check_capabilities(host.capabilities());
    const citizensdk_host_handle_t original_host = host.host_handle();
    bool running_close_rejected = false;
    try { host.close(); }
    catch (const citizen_sdk::Error &error) {
      running_close_rejected = error.code() == CITIZENSDK_ERROR_BUSY;
    }
    CHECK(running_close_rejected && host.host_handle() == original_host &&
          host.native_handle() == sdk);

    completion.prepare(host);
    request = accept_request(sdk, citizensdk_stop);
    completion.await(host, request);
    CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK);
    CHECK(lifecycle == CITIZENSDK_LIFECYCLE_STOPPED);
    // 只验证公开 stop 的 durable checkpoint 成功，不绕过 Host 检查私有数据库。
    check_capabilities(host.capabilities());
    close_with_retry(host);
    CHECK(host.host_handle() == 0 && host.native_handle() == 0);
    host.close();
    CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_ERROR_INVALID_HANDLE);
    CHECK(citizensdk_host_destroy(original_host) == CITIZENSDK_ERROR_INVALID_HANDLE);
    std::puts("CitizenSDK C++ consumer passed");
    return 0;
  } catch (...) {
    // 不输出异常正文、目录或潜在秘密；非零退出不能被成功字符串覆盖。
    std::fputs("CitizenSDK C++ consumer failed\n", stderr);
    return 1;
  }
}
