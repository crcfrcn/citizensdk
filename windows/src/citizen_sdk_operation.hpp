#ifndef CITIZENSDK_WINDOWS_OPERATION_HPP
#define CITIZENSDK_WINDOWS_OPERATION_HPP

#include <condition_variable>
#include <functional>
#include <mutex>
#include <map>
#include <unordered_set>
#include "citizensdk_types.h"

namespace citizen_sdk::windows {

class OperationTracker final {
 public:
  bool accept(uint64_t operation_id);
  void finish(uint64_t operation_id) noexcept;
  bool empty() const noexcept;

 private:
  mutable std::mutex lock_;
  std::unordered_set<uint64_t> pending_;
};

class RequestRouter final {
 public:
  /* Routing transfers ownership of every nonzero result handle to Handler
   * before invocation. Production handlers are noexcept and must release that
   * handle exactly once, including every failure path. */
  using Handler = std::function<void(citizensdk_result_handle_t)>;
  using Cancellation = std::function<void()>;
  // 多个无UI资源各自保有终态回调；先分配占位节点，再接纳Core请求。
  // bind只转移预分配map节点，不在Core接纳后分配内存或丢弃真实请求。
  void prime(Handler handler, Cancellation cancel = {});
  // 只请求各资源真实取消；不会移除终态路由或冒充排空。回调在路由锁外调用。
  void cancel_all();
  void bind(citizensdk_request_id_t request) noexcept;
  void cancel_primed() noexcept;
  Handler take(const citizensdk_event_t &event);
  bool empty() const noexcept;

 private:
  mutable std::mutex lock_;
  // key=0仅表示当前尚未接纳的预约；真实Core请求编号永不为0。
  struct Callbacks { Handler handler; Cancellation cancel; };
  std::map<citizensdk_request_id_t, Callbacks> routes_;
};

// Serializes the short interval in which Core has accepted a request but has
// not yet returned its identity to the submitter. Core's dedicated dispatch
// thread waits here, preserving callback-thread affinity without a bounded
// event buffer. Tests can drive arbitrarily many waiters through this internal
// contract; production has one Core dispatch waiter per SDK instance.
class CompletionAdmission final {
 public:
  void begin();
  void publish_route() noexcept;
  void await_route(citizensdk_request_id_t request) noexcept;
  bool idle() const noexcept;

 private:
  mutable std::mutex lock_;
  std::condition_variable ready_;
  bool in_progress_{false};
};

}  // namespace citizen_sdk::windows

#endif
