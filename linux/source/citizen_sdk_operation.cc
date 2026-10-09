#include "citizen_sdk_operation.hpp"

#include <exception>
#include <utility>
#include <vector>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::linux {

bool OperationTracker::accept(uint64_t operation_id) {
  if (operation_id == 0) return false;
  std::lock_guard<std::mutex> guard(lock_);
  return pending_.insert(operation_id).second;
}

void OperationTracker::finish(uint64_t operation_id) noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  pending_.erase(operation_id);
}

bool OperationTracker::empty() const noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  return pending_.empty();
}

void RequestRouter::prime(Handler handler, Cancellation cancel) {
  require(static_cast<bool>(handler), CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK private request route is invalid");
  std::lock_guard<std::mutex> guard(lock_);
  require(routes_.find(0) == routes_.end(), CITIZENSDK_ERROR_CONFLICT,
          "CitizenSDK private admission is already occupied");
  // 唯一可能分配的节点在调用Core前建立；已有资源继续保有各自回调。
  routes_.emplace(0, Callbacks{std::move(handler), std::move(cancel)});
}

void RequestRouter::bind(citizensdk_request_id_t request) noexcept {
  try {
    std::lock_guard<std::mutex> guard(lock_);
    auto reserved = routes_.extract(0);
    if (request == 0 || reserved.empty() || !reserved.mapped().handler ||
        routes_.find(request) != routes_.end()) std::terminate();
    reserved.key() = request;
    if (!routes_.insert(std::move(reserved)).inserted) std::terminate();
  } catch (...) { std::terminate(); }
}

void RequestRouter::cancel_primed() noexcept {
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

void RequestRouter::cancel_all() {
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

RequestRouter::Handler RequestRouter::take(const citizensdk_event_t &event) {
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

bool RequestRouter::empty() const noexcept {
  std::lock_guard<std::mutex> guard(lock_);
  return routes_.empty();
}

void CompletionAdmission::begin() {
  std::lock_guard<std::mutex> guard(lock_);
  require(!in_progress_,
          CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK completion admission is already occupied");
  in_progress_ = true;
}

void CompletionAdmission::publish_route() noexcept {
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

void CompletionAdmission::await_route(
    citizensdk_request_id_t) noexcept {
  try {
    std::unique_lock<std::mutex> guard(lock_);
    ready_.wait(guard, [&] { return !in_progress_; });
  } catch (...) {
    std::terminate();
  }
}

bool CompletionAdmission::idle() const noexcept {
  try {
    std::lock_guard<std::mutex> guard(lock_);
    return !in_progress_;
  } catch (...) {
    std::terminate();
  }
}

}  // namespace citizen_sdk::linux
