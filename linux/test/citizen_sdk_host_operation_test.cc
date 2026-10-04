// 验证请求路由、Host operation 身份和同步早到 completion 的无损准入门。
#include <atomic>
#include <cassert>
#include <condition_variable>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "citizen_sdk_operation.hpp"
#include "citizen_sdk_host_record.hpp"

#ifndef CITIZENSDK_LINUX_TEST_SOURCE_DIR
#error "CITIZENSDK_LINUX_TEST_SOURCE_DIR must point at the Linux source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif

namespace {

constexpr std::size_t kConcurrentCompletions = 96;

void run_completion_wave(
    citizen_sdk::linux::CompletionAdmission &admission) {
  std::mutex gate_lock;
  std::condition_variable gate_ready;
  std::size_t ready = 0;
  bool proceed = false;
  std::atomic<std::size_t> completed{0};
  std::vector<std::thread> workers;
  workers.reserve(kConcurrentCompletions);

  admission.begin();
  for (std::size_t index = 0; index < kConcurrentCompletions; ++index) {
    workers.emplace_back([&, index] {
      {
        std::unique_lock<std::mutex> guard(gate_lock);
        ++ready;
        gate_ready.notify_all();
        gate_ready.wait(guard, [&] { return proceed; });
      }
      const auto request = static_cast<citizensdk_request_id_t>(index + 1);
      admission.await_route(request);
      completed.fetch_add(1, std::memory_order_release);
    });
  }
  {
    std::unique_lock<std::mutex> guard(gate_lock);
    gate_ready.wait(guard, [&] { return ready == kConcurrentCompletions; });
    proceed = true;
  }
  gate_ready.notify_all();

  // begin() 尚未发布时，所有参与者已经抵达等待边界且无一能够完成。
  assert(completed.load(std::memory_order_acquire) == 0);
  admission.publish_route();
  for (auto &worker : workers) worker.join();
  assert(completed.load(std::memory_order_acquire) ==
         kConcurrentCompletions);
  assert(admission.idle());
}

}  // namespace

int main() {
  using citizen_sdk::linux::CompletionAdmission;
  using citizen_sdk::linux::HostError;
  using citizen_sdk::linux::OperationTracker;
  using citizen_sdk::linux::RequestRouter;

  OperationTracker operations;
  assert(!operations.accept(0));
  assert(operations.accept(7));
  assert(!operations.accept(7));
  assert(!operations.empty());
  operations.finish(7);
  operations.finish(7);
  assert(operations.empty());

  // request 与 host operation 使用独立身份；错身份或另一认证的完成
  // 不能消耗当前认证租约，取消后的晚完成只退休它自身的真实操作。
  assert(operations.accept(71) && operations.accept(72));
  operations.finish(9);
  operations.finish(72);
  assert(!operations.empty());
  assert(!operations.accept(71));
  operations.finish(71);
  assert(operations.empty());

  RequestRouter router;
  int completions = 0;
  citizensdk_result_handle_t delivered = 0;
  router.prime([&](citizensdk_result_handle_t result) {
    ++completions;
    delivered = result;
  });
  bool duplicate_rejected = false;
  try {
    router.prime([](citizensdk_result_handle_t) {});
  } catch (const HostError &error) {
    duplicate_rejected = error.code() == CITIZENSDK_ERROR_CONFLICT;
  }
  assert(duplicate_rejected);

  citizensdk_event_t unrelated{};
  unrelated.event_type = CITIZENSDK_EVENT_CAPABILITIES_CHANGED;
  unrelated.request_id = 9;
  assert(!router.take(unrelated));
  assert(completions == 0);

  router.bind(9);
  citizensdk_event_t crossed{};
  crossed.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
  crossed.request_id = 10;
  crossed.result = 12;
  assert(!router.take(crossed));

  citizensdk_event_t completion{};
  completion.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
  completion.request_id = 9;
  completion.result = 11;
  auto handler = router.take(completion);
  assert(static_cast<bool>(handler));
  // 移交本身必须清空路由，不能等 callback 执行或局部 handler 析构才释放。
  assert(router.empty());
  handler(completion.result);
  assert(!router.take(completion));
  assert(completions == 1);
  assert(delivered == 11);
  assert(router.empty());
  router.prime([](citizensdk_result_handle_t) {});
  router.cancel_primed();
  assert(router.empty());

  // 回调重入可立即提交下一请求；旧 completion 不能消费新路由。
  router.prime([&](citizensdk_result_handle_t result) {
    assert(router.empty());
    ++completions;
    delivered = result;
    router.prime([&](citizensdk_result_handle_t next_result) {
      assert(router.empty());
      ++completions;
      delivered = next_result;
    });
    router.bind(11);
  });
  router.bind(10);
  auto second = router.take(crossed);
  assert(static_cast<bool>(second) && router.empty());
  second(crossed.result);
  assert(completions == 2 && delivered == 12);
  assert(!router.empty());
  assert(!router.take(completion) && !router.take(crossed));
  citizensdk_event_t next = completion;
  next.request_id = 11;
  next.result = 13;
  auto third = router.take(next);
  assert(static_cast<bool>(third) && router.empty());
  third(next.result);
  assert(completions == 3 && delivered == 13);
  assert(!router.take(next) && router.empty());

  // 无UI资源不能共用一个旧窗口槽：多请求乱序结束仍逐个移交，失败预约不清旧请求。
  int resource_completions = 0;
  for (uint64_t id = 100; id < 196; ++id) {
    router.prime([&, id](citizensdk_result_handle_t result) {
      assert(result == id + 1000);
      ++resource_completions;
    });
    router.bind(id);
  }
  router.prime([](citizensdk_result_handle_t) {});
  router.cancel_primed();
  assert(!router.empty());
  for (uint64_t id = 196; id-- > 100;) {
    citizensdk_event_t event{};
    event.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
    event.request_id = id;
    event.result = id + 1000;
    auto owned = router.take(event);
    assert(static_cast<bool>(owned));
    assert(!router.take(event));
    owned(event.result);
  }
  assert(resource_completions == 96 && router.empty());

  // 关闭发取消但不能伪造完成；取消回调允许重入只读状态，证明不持有路由锁。
  int cancellations = 0;
  router.prime([](citizensdk_result_handle_t) {}, [&] { ++cancellations; assert(!router.empty()); });
  router.bind(300);
  router.cancel_all();
  assert(cancellations == 1 && !router.empty());
  citizensdk_event_t cancelled{};
  cancelled.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
  cancelled.request_id = 300;
  auto cancellation_terminal = router.take(cancelled);
  assert(static_cast<bool>(cancellation_terminal) && router.empty());
  router.cancel_all();
  assert(cancellations == 1);

  // 96 个并发等待者明确超过旧固定 64 槽边界。准入门不缓存 result，
  // route 发布后每个 completion 都继续，且门可回到完整 idle 状态。
  CompletionAdmission admission;
  assert(admission.idle());
  run_completion_wave(admission);

  const std::string source_path =
      std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
      "/src/citizen_sdk_host_bridge.cc";
  std::ifstream stream(source_path, std::ios::binary);
  assert(stream.good());
  const std::string source((std::istreambuf_iterator<char>(stream)),
                           std::istreambuf_iterator<char>());
  const auto dispatch = source.find("HostBridge::dispatch_core_event");
  const auto await_route =
      source.find("completion_admission_.await_route(event.request_id)",
                  dispatch);
  const auto routed = source.find("dispatch_routed_event(event)", await_route);
  const auto submit = source.find("HostBridge::submit_private");
  const auto prime = source.find("private_requests_.prime", submit);
  const auto begin = source.find("completion_admission_.begin()", prime);
  const auto accept = source.find("accept(&request)", begin);
  const auto cancel = source.find("private_requests_.cancel_primed()", accept);
  const auto bind = source.find("private_requests_.bind(request)", cancel);
  const auto publish_route =
      source.find("completion_admission_.publish_route()", bind);
  assert(dispatch != std::string::npos && await_route != std::string::npos &&
         routed != std::string::npos && submit != std::string::npos &&
         prime != std::string::npos && begin != std::string::npos &&
         accept != std::string::npos && cancel != std::string::npos &&
         bind != std::string::npos && publish_route != std::string::npos);
  assert(dispatch < await_route && await_route < routed && routed < submit);
  assert(submit < prime && prime < begin && begin < accept &&
         accept < cancel && cancel < bind && bind < publish_route);
  assert(source.find("early_events_") == std::string::npos);
  assert(source.find("publish_discard") == std::string::npos);
  // 自己的 callback 清除先于一般 callback-update admission；否则另一
  // setter 等 callback 返回时，callback 内析构会 BUSY/互相等待。
  const auto set_callback = source.find("HostBridge::set_event_callback(");
  const auto self_retirement = source.find(
      "callback_thread_ == std::this_thread::get_id()", set_callback);
  const auto clear_self = source.find("public_callback_ = nullptr", self_retirement);
  const auto update_gate = source.find(
      "if (callback_update_in_progress_) return CITIZENSDK_ERROR_BUSY", clear_self);
  assert(set_callback != std::string::npos &&
         self_retirement != std::string::npos && clear_self != std::string::npos &&
         update_gate != std::string::npos && set_callback < self_retirement &&
         self_retirement < clear_self && clear_self < update_gate);
  return 0;
}
