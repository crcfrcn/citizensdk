#include "citizen_sdk_window.hpp"

#include <windows.h>
#include <commctrl.h>
#include <exception>
#include <limits>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::windows {

struct WindowParent final {
  HWND hwnd{};
  bool alive{false};
  std::shared_ptr<WindowParent> *callback_owner{};
};

struct WindowState final {
  std::mutex lock;
  std::thread::id ui_thread;
  DWORD thread_id{};
  HWND dispatcher{};
  HINSTANCE module{};
  std::wstring class_name;  // 仅非秘密的 Win32 类标识。
  bool registered{false};
  std::shared_ptr<WindowParent> parent;
  std::unordered_map<UINT_PTR, std::function<void()>> pending;
  UINT_PTR next{1};
  std::size_t leases{};
  std::size_t dispatching{};
  bool enabled{false};
  bool visible{false};
  bool closing{false};
  bool retirement_queued{false};
  bool retiring_ui{false};
  bool retired{false};
};

namespace {
constexpr UINT kInvoke = WM_APP + 1;
constexpr UINT kRetire = WM_APP + 2;

LRESULT CALLBACK parent_proc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp,
                             UINT_PTR identity, DWORD_PTR data) noexcept {
  auto *owner = reinterpret_cast<std::shared_ptr<WindowParent> *>(data);
  const auto parent = *owner;
  if (message == WM_DESTROY) parent->alive = false;
  if (message == WM_NCDESTROY) {
    parent->alive = false;
    parent->hwnd = nullptr;
    parent->callback_owner = nullptr;
    RemoveWindowSubclass(hwnd, parent_proc, identity);
    const LRESULT result = DefSubclassProc(hwnd, message, wp, lp);
    delete owner;
    return result;
  }
  return DefSubclassProc(hwnd, message, wp, lp);
}

bool remove_parent(const std::shared_ptr<WindowParent> &parent) noexcept {
  if (!parent || parent->callback_owner == nullptr) return true;
  if (!RemoveWindowSubclass(parent->hwnd, parent_proc,
                            reinterpret_cast<UINT_PTR>(parent.get()))) {
    return false;
  }
  delete parent->callback_owner;
  parent->callback_owner = nullptr;
  parent->alive = false;
  parent->hwnd = nullptr;
  return true;
}

citizensdk_error_code_t retire_on_ui(WindowState &state) noexcept {
  if (std::this_thread::get_id() != state.ui_thread) return CITIZENSDK_ERROR_BUSY;
  std::shared_ptr<WindowParent> parent;
  HWND dispatcher{};
  {
    std::lock_guard<std::mutex> guard(state.lock);
    state.retirement_queued = false;
    if (state.retired) return CITIZENSDK_OK;
    if (state.leases != 0 || state.dispatching != 0 || !state.pending.empty()) return CITIZENSDK_ERROR_BUSY;
    state.retiring_ui = true;
    parent = state.parent;
    dispatcher = state.dispatcher;
  }
  const auto retryable = [&state]() noexcept {
    std::lock_guard<std::mutex> guard(state.lock);
    state.retiring_ui = false;
    return CITIZENSDK_ERROR_UNAVAILABLE;
  };
  if (!remove_parent(parent)) return retryable();
  if (dispatcher != nullptr) {
    MSG obsolete{};
    // 门禁已拒绝新投递，且 pending 为空；只移除该 SDK 窗口自己的旧通知。
    while (PeekMessageW(&obsolete, dispatcher, kInvoke, kRetire, PM_REMOVE)) {}
  }
  if (dispatcher != nullptr && !DestroyWindow(dispatcher)) {
    return retryable();
  }
  if (state.registered && !UnregisterClassW(state.class_name.c_str(), state.module)) {
    return retryable();
  }
  state.registered = false;
  std::lock_guard<std::mutex> guard(state.lock);
  state.dispatcher = nullptr;
  state.parent.reset();
  state.retired = true;
  return CITIZENSDK_OK;
}

LRESULT CALLBACK dispatch_proc(HWND hwnd, UINT message, WPARAM wp,
                               LPARAM lp) noexcept {
  auto *state = reinterpret_cast<WindowState *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    auto *create = reinterpret_cast<CREATESTRUCTW *>(lp);
    state = static_cast<WindowState *>(create->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
  }
  if (state != nullptr && message == kInvoke) {
    std::function<void()> action;
    try {
      {
        std::lock_guard<std::mutex> guard(state->lock);
        const auto found = state->pending.find(static_cast<UINT_PTR>(wp));
        if (found == state->pending.end()) return 0;
        action = std::move(found->second);
        state->pending.erase(found);
        ++state->dispatching;
      }
      action();
      {
        std::lock_guard<std::mutex> guard(state->lock);
        --state->dispatching;
      }
    } catch (...) { std::terminate(); }
    return 0;
  }
  if (state != nullptr && message == kRetire) {
    (void)retire_on_ui(*state);
    return 0;
  }
  if (state != nullptr && message == WM_NCDESTROY) {
    std::lock_guard<std::mutex> guard(state->lock);
    // 未经 retire 销毁调度窗口不能静默遗弃唯一的清理回调。
    if (state->leases != 0 || state->dispatching != 0 || !state->pending.empty()) {
      std::terminate();
    }
    state->dispatcher = nullptr;
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
  }
  return DefWindowProcW(hwnd, message, wp, lp);
}

bool post(const std::shared_ptr<WindowState> &state,
          std::function<void()> action) noexcept {
  if (!state || !action) return false;
  try {
    // UI 调用也排队：不能在 WM_DESTROY 栈中执行完成回调并提前释放 WndProc owner。
    std::unique_lock<std::mutex> guard(state->lock);
    if (state->retired || state->retiring_ui || state->dispatcher == nullptr || state->next == 0) return false;
    const UINT_PTR identity = state->next;
    state->next = identity == std::numeric_limits<UINT_PTR>::max() ? 0 : identity + 1;
    state->pending.emplace(identity, std::move(action));
    if (!PostMessageW(state->dispatcher, kInvoke, identity, 0)) {
      action = std::move(state->pending.at(identity));
      state->pending.erase(identity);
      guard.unlock();
      return false;
    }
    return true;
  } catch (...) { return false; }
}
}  // namespace

WindowLease::WindowLease(std::shared_ptr<WindowState> state,
                         std::shared_ptr<WindowParent> parent)
    : state_(std::move(state)), parent_(std::move(parent)) {}
WindowLease::WindowLease(WindowLease &&other) noexcept
    : state_(std::move(other.state_)), parent_(std::move(other.parent_)) {}
WindowLease &WindowLease::operator=(WindowLease &&other) noexcept {
  if (this != &other) { clear(); state_ = std::move(other.state_); parent_ = std::move(other.parent_); }
  return *this;
}
WindowLease::~WindowLease() { clear(); }
void WindowLease::clear() noexcept {
  if (state_) {
    std::lock_guard<std::mutex> guard(state_->lock);
    if (state_->leases == 0) std::terminate();
    --state_->leases;
  }
  parent_.reset();
  state_.reset();
}
bool WindowLease::on_ui_thread() const noexcept {
  return state_ && std::this_thread::get_id() == state_->ui_thread;
}
bool WindowLease::valid() const noexcept {
  return on_ui_thread() && parent_ && parent_->alive;
}
void *WindowLease::get() const noexcept { return valid() ? parent_->hwnd : nullptr; }
bool WindowLease::invoke(std::function<void()> action) const noexcept {
  return post(state_, std::move(action));
}

WindowRef::WindowRef(void *hwnd, std::thread::id ui_thread, bool enable_wallet)
    : state_(std::make_shared<WindowState>()) {
  state_->ui_thread = ui_thread;
  state_->thread_id = GetCurrentThreadId();
  state_->enabled = enable_wallet;
  if (!enable_wallet) {
    require(hwnd == nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "chain-only Host must not configure a wallet window");
    state_->retired = true;
    return;
  }
  require(on_ui_thread(), CITIZENSDK_ERROR_BUSY, "wallet Host requires its UI thread");
  try {
  HINSTANCE module{};
  require(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCWSTR>(&dispatch_proc), &module) != FALSE,
          CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK module is unavailable");
  state_->module = module;
  state_->class_name = L"CitizenSDK.Dispatcher." + std::to_wstring(reinterpret_cast<UINT_PTR>(state_.get()));
  WNDCLASSEXW type{};
  type.cbSize = sizeof(type);
  type.hInstance = module;
  type.lpfnWndProc = dispatch_proc;
  type.lpszClassName = state_->class_name.c_str();
  require(RegisterClassExW(&type) != 0, CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK dispatcher class is unavailable");
  state_->registered = true;
  state_->dispatcher = CreateWindowExW(0, state_->class_name.c_str(), L"", 0, 0, 0, 0, 0,
                                       HWND_MESSAGE, nullptr, module, state_.get());
  require(state_->dispatcher != nullptr, CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK dispatcher window is unavailable");
  USEROBJECTFLAGS flags{};
  DWORD required{};
  state_->visible = GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS,
      &flags, sizeof(flags), &required) != FALSE && (flags.dwFlags & WSF_VISIBLE) != 0;
  const auto code = set(hwnd);
  if (code != CITIZENSDK_OK) {
    throw HostError(code, "CitizenSDK parent window is invalid");
  }
  } catch (...) {
    state_->closing = true;
    if (retire_on_ui(*state_) != CITIZENSDK_OK) std::terminate();
    throw;
  }
}

WindowRef::~WindowRef() {
  if (state_ && retire() != CITIZENSDK_OK) std::terminate();
}
bool WindowRef::on_ui_thread() const noexcept {
  return std::this_thread::get_id() == state_->ui_thread;
}
bool WindowRef::available() const noexcept {
  std::lock_guard<std::mutex> guard(state_->lock);
  return state_->enabled && state_->visible && !state_->closing && !state_->retired;
}
bool WindowRef::invoke(std::function<void()> action) const noexcept {
  return post(state_, std::move(action));
}
citizensdk_error_code_t WindowRef::set(void *value) noexcept {
  if (!state_->enabled) return value == nullptr ? CITIZENSDK_OK : CITIZENSDK_ERROR_UNSUPPORTED;
  if (!on_ui_thread()) return CITIZENSDK_ERROR_BUSY;
  try {
    {
      std::lock_guard<std::mutex> guard(state_->lock);
      if (state_->closing || state_->retired) return CITIZENSDK_ERROR_INVALID_STATE;
      if (state_->leases != 0) return CITIZENSDK_ERROR_BUSY;
    }
    const HWND hwnd = static_cast<HWND>(value);
    if (hwnd != nullptr) {
      DWORD process{};
      const DWORD thread = GetWindowThreadProcessId(hwnd, &process);
      if (thread != state_->thread_id || process != GetCurrentProcessId() ||
          GetAncestor(hwnd, GA_ROOT) != hwnd) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    }
    const auto parent = std::make_shared<WindowParent>();
    parent->hwnd = hwnd;
    parent->alive = true;
    if (hwnd != nullptr) {
      parent->callback_owner = new std::shared_ptr<WindowParent>(parent);
      if (!SetWindowSubclass(hwnd, parent_proc, reinterpret_cast<UINT_PTR>(parent.get()),
                             reinterpret_cast<DWORD_PTR>(parent->callback_owner))) {
        delete parent->callback_owner;
        parent->callback_owner = nullptr;
        return CITIZENSDK_ERROR_UNAVAILABLE;
      }
    }
    if (!remove_parent(state_->parent)) {
      if (!remove_parent(parent)) std::terminate();
      return CITIZENSDK_ERROR_UNAVAILABLE;
    }
    state_->parent = parent;
    return CITIZENSDK_OK;
  } catch (...) { return map_exception(); }
}
WindowLease WindowRef::acquire() const noexcept {
  if (!on_ui_thread()) return {};
  try {
    std::lock_guard<std::mutex> guard(state_->lock);
    if (!state_->enabled || state_->closing || state_->retired ||
        !state_->parent || !state_->parent->alive) return {};
    ++state_->leases;
    return WindowLease(state_, state_->parent);
  } catch (...) { return {}; }
}
citizensdk_error_code_t WindowRef::retire() noexcept {
  try {
    {
      std::lock_guard<std::mutex> guard(state_->lock);
      if (state_->retired) return CITIZENSDK_OK;
      if (state_->retiring_ui) return CITIZENSDK_ERROR_BUSY;
      state_->closing = true;
      if (!on_ui_thread()) {
        if (!state_->retirement_queued) {
          if (!PostMessageW(state_->dispatcher, kRetire, 0, 0)) {
            return CITIZENSDK_ERROR_UNAVAILABLE;
          }
          state_->retirement_queued = true;
        }
        return CITIZENSDK_ERROR_BUSY;
      }
    }
    return retire_on_ui(*state_);
  } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
}

}  // namespace citizen_sdk::windows
