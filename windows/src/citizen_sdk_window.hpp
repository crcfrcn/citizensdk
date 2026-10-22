#ifndef CITIZENSDK_WINDOWS_WINDOW_HPP
#define CITIZENSDK_WINDOWS_WINDOW_HPP

#include <functional>
#include <memory>
#include <thread>
#include "citizensdk_types.h"

namespace citizen_sdk::windows {

struct WindowState;
struct WindowParent;

// 租约保活 SDK 调度状态，不保活 HWND。valid() 将主动 rootless 与已销毁
// 的 owner 区分；invoke() 总是排队，即使 owner 消失仍可完成 UI 线程上的秘密清理。
class WindowLease final {
 public:
  WindowLease() = default;
  WindowLease(const WindowLease &) = delete;
  WindowLease &operator=(const WindowLease &) = delete;
  WindowLease(WindowLease &&other) noexcept;
  WindowLease &operator=(WindowLease &&other) noexcept;
  ~WindowLease();
  void *get() const noexcept;
  bool valid() const noexcept;
  bool on_ui_thread() const noexcept;
  bool invoke(std::function<void()> action) const noexcept;

 private:
  friend class WindowRef;
  WindowLease(std::shared_ptr<WindowState>, std::shared_ptr<WindowParent>);
  void clear() noexcept;
  std::shared_ptr<WindowState> state_;
  std::shared_ptr<WindowParent> parent_;
};

class WindowRef final {
 public:
  WindowRef(void *hwnd, std::thread::id ui_thread, bool enable_wallet = true);
  WindowRef(const WindowRef &) = delete;
  WindowRef &operator=(const WindowRef &) = delete;
  ~WindowRef();
  citizensdk_error_code_t set(void *hwnd) noexcept;
  WindowLease acquire() const noexcept;
  bool on_ui_thread() const noexcept;
  bool available() const noexcept;
  bool invoke(std::function<void()> action) const noexcept;
  // worker 首次请求返回 BUSY；UI 确认注销 subclass 和 dispatcher 后返回 OK。
  // Host 必须在丢弃最后一个所有者前完成此握手，不能在后台销毁 HWND。
  citizensdk_error_code_t retire() noexcept;

 private:
  std::shared_ptr<WindowState> state_;
};

}  // namespace citizen_sdk::windows
#endif
