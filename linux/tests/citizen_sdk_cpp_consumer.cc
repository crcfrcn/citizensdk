// 只消费已安装的 C++ 公开 Host；没有私有头、测试 Core 或平台服务替身。
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <set>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <type_traits>
#include <unistd.h>
#include <utility>

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

void check_root(const std::filesystem::path &root,
                const std::string &application_id) {
  CHECK(root.is_absolute() && root != root.root_path());
  std::filesystem::path current;
  for (const auto &part : root) {
    CHECK(part != "." && part != "..");
    current /= part;
    CHECK(std::filesystem::is_directory(std::filesystem::symlink_status(current)));
  }
  struct stat status {};
  CHECK(::lstat(root.c_str(), &status) == 0 && S_ISDIR(status.st_mode));
  CHECK(status.st_uid == ::geteuid() && (status.st_mode & 07777) == 0700);
  CHECK(!std::filesystem::exists(std::filesystem::symlink_status(root / application_id)));
  // 此处验证传入边界；Host 自己仍通过 no-follow fd 打开、隔离并管理存储。
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
    // 结果只在回调内借用；公开 Host trampoline 在返回后唯一释放。
    // 消费者不释放它，也不保存 event 指针或读取秘密载荷。
  }

  void prepare() {
    std::lock_guard<std::mutex> guard(lock);
    request = 0;
    info = {};
    count = 0;
  }

  void await(citizen_sdk::Host &host, citizensdk_request_id_t accepted,
             citizensdk_error_code_t expected = CITIZENSDK_OK) {
    {
      std::unique_lock<std::mutex> guard(lock);
      CHECK(changed.wait_for(guard, std::chrono::seconds(60), [&] { return count == 1; }));
      CHECK(request == accepted && accepted != 0 && info.error_code == expected);
      if (expected == CITIZENSDK_OK) CHECK(info.kind == CITIZENSDK_RESULT_EMPTY);
    }
    // 清观察者是公开回调屏障；不把借用结果句柄带出回调后轮询。
    host.set_event_observer({});
    host.set_event_observer([this](const citizensdk_event_t &event) { receive(event); });
  }
};

void close_with_retry(citizen_sdk::Host &host) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  for (;;) {
    try {
      host.close();
      return;
    } catch (const citizen_sdk::Error &error) {
      CHECK(error.code() == CITIZENSDK_ERROR_BUSY);
      CHECK(std::chrono::steady_clock::now() < deadline);
      // 失败关闭不丢弃句柄；此处只重试关闭，不把半收口实例重新投入业务。
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
}

}  // namespace

int main(int argc, char **argv) {
  CHECK(argc == 3);
  try {
    citizen_sdk::Config config;
    config.storage_root = argv[1];
    config.asset_root = argv[2];
    config.application_id = "org.citizensdk.cppconsumer";
    config.modules = CITIZENSDK_MODULE_CHAIN | CITIZENSDK_MODULE_TRANSACTIONS | CITIZENSDK_MODULE_HISTORY;
    check_root(config.storage_root, config.application_id);
    CHECK(config.asset_root.is_absolute());
    CHECK(citizensdk_abi_version() == CITIZENSDK_ABI_VERSION);
    CHECK(citizensdk_host_abi_version() == CITIZENSDK_HOST_ABI_VERSION);

    Completion completion;  // 必须比 Host 长寿；成功 close 后才允许销毁回调上下文。
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
    CHECK(host.native_handle() == sdk);  // 公开 C++ open 是幂等，而非重复建立 Core。
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
    host.set_event_observer([&](const citizensdk_event_t &event) { completion.receive(event); });

    completion.prepare();
    citizensdk_request_id_t request = 0;
    CHECK(citizensdk_get_finalized_head(sdk, &request) == CITIZENSDK_OK);
    completion.await(host, request, CITIZENSDK_ERROR_NOT_READY);

    // 只启动轻节点并验证 checkpoint，不发送 extrinsic、不建立钱包、不操作 TPM。
    completion.prepare();
    CHECK(citizensdk_start(sdk, &request) == CITIZENSDK_OK);
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

    completion.prepare();
    CHECK(citizensdk_stop(sdk, &request) == CITIZENSDK_OK);
    completion.await(host, request);
    CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK);
    CHECK(lifecycle == CITIZENSDK_LIFECYCLE_STOPPED);
    check_capabilities(host.capabilities());
    close_with_retry(host);
    CHECK(host.host_handle() == 0 && host.native_handle() == 0);
    host.close();
    CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_ERROR_INVALID_HANDLE);
    CHECK(citizensdk_host_destroy(original_host) == CITIZENSDK_ERROR_INVALID_HANDLE);
    std::puts("CitizenSDK C++ consumer passed");
    return 0;
  } catch (...) {
    // 不把原生错误正文、目录或任何潜在秘密写入验收输出。
    std::fputs("CitizenSDK C++ consumer failed\n", stderr);
    return 1;
  }
}
