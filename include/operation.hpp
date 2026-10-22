#ifndef CITIZENSDK_OPERATION_HPP
#define CITIZENSDK_OPERATION_HPP

#include <condition_variable>
#include <functional>
#include <mutex>
#include <map>
#include <exception>
#include <utility>
#include <vector>
#include "input.hpp"
#include <unordered_set>
#include "citizensdk_types.h"

namespace citizen_sdk {

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



inline bool OperationTracker::accept(uint64_t operation_id) {
  if (operation_id == 0) return false;
  std::lock_guard<std::mutex> guard(lock_);
  return pending_.insert(operation_id).second;
}

inline void OperationTracker::finish(uint64_t operation_id) noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  pending_.erase(operation_id);
}

inline bool OperationTracker::empty() const noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  return pending_.empty();
}

inline void RequestRouter::prime(Handler handler, Cancellation cancel) {
  require(static_cast<bool>(handler), CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK private request route is invalid");
  std::lock_guard<std::mutex> guard(lock_);
  require(routes_.find(0) == routes_.end(), CITIZENSDK_ERROR_CONFLICT,
          "CitizenSDK private admission is already occupied");
  // 唯一可能分配的节点在调用Core前建立；已有资源继续保有各自回调。
  routes_.emplace(0, Callbacks{std::move(handler), std::move(cancel)});
}

inline void RequestRouter::bind(citizensdk_request_id_t request) noexcept {
  try {
    std::lock_guard<std::mutex> guard(lock_);
    auto reserved = routes_.extract(0);
    if (request == 0 || reserved.empty() || !reserved.mapped().handler ||
        routes_.find(request) != routes_.end()) std::terminate();
    reserved.key() = request;
    if (!routes_.insert(std::move(reserved)).inserted) std::terminate();
  } catch (...) { std::terminate(); }
}

inline void RequestRouter::cancel_primed() noexcept {
  try {
    // 捕获对象析构可能回到Host；必须在释放路由锁后销毁预约。
    decltype(routes_)::node_type reserved;
    {
      std::lock_guard<std::mutex> guard(lock_);
      reserved = routes_.extract(0);
      if (reserved.empty()) std::terminate();
    }
  } catch (...) { std::terminate(); }
}

inline void RequestRouter::cancel_all() {
  std::vector<Cancellation> cancellations;
  {
    std::lock_guard<std::mutex> guard(lock_);
    cancellations.reserve(routes_.size());
    for (const auto &entry : routes_) {
      if (entry.second.cancel) cancellations.push_back(entry.second.cancel);
    }
  }
  std::exception_ptr first;
  for (const auto &cancel : cancellations) {
    try { cancel(); } catch (...) { if (!first) first = std::current_exception(); }
  }
  if (first) std::rethrow_exception(first);
}

inline RequestRouter::Handler RequestRouter::take(const citizensdk_event_t &event) {
  if (event.event_type != CITIZENSDK_EVENT_REQUEST_COMPLETED || event.request_id == 0) return {};
  decltype(routes_)::node_type completed;
  {
    std::lock_guard<std::mutex> guard(lock_);
    completed = routes_.extract(event.request_id);
  }
  Handler handler;
  if (!completed.empty()) handler.swap(completed.mapped().handler);
  // handler与取消闭包的析构都在锁外；回调重入不会释放别的请求。
  return handler;
}

inline bool RequestRouter::empty() const noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  return routes_.empty();
}

inline void CompletionAdmission::begin() {
  std::lock_guard<std::mutex> guard(lock_);
  require(!in_progress_,
          CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK completion admission is already occupied");
  in_progress_ = true;
}

inline void CompletionAdmission::publish_route() noexcept {
  try {
    {
      std::lock_guard<std::mutex> guard(lock_);
      if (!in_progress_) std::terminate();
      in_progress_ = false;
    }
    ready_.notify_all();
  } catch (...) {
    std::terminate();
  }
}

inline void CompletionAdmission::await_route(
    citizensdk_request_id_t) noexcept {
  try {
    std::unique_lock<std::mutex> guard(lock_);
    ready_.wait(guard, [&] { return !in_progress_; });
  } catch (...) {
    std::terminate();
  }
}

inline bool CompletionAdmission::idle() const noexcept {
  try {
    std::lock_guard<std::mutex> guard(lock_);
    return !in_progress_;
  } catch (...) {
    std::terminate();
  }
}


} // namespace citizen_sdk

#endif
