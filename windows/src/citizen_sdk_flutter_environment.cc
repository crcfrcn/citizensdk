#include "citizen_sdk_flutter_environment.hpp"

#include <commctrl.h>
#include <shlobj.h>

#include <array>
#include <exception>
#include <regex>
#include <thread>
#include <utility>
#include <vector>

#include "citizen_sdk_flutter_codec.hpp"

#ifndef CITIZENSDK_APPLICATION_ID
#error "Windows Flutter requires the embedding application's CITIZENSDK_APPLICATION_ID"
#endif

namespace citizen_sdk::flutter {
namespace {

void require(bool value, citizensdk_error_code_t code, const char *message) {
  if (!value) throw ContractFailure(code, message);
}

void absolute_path(const std::filesystem::path &path) {
  const std::wstring native = path.native();
  const std::wstring drive = path.root_name().native();
  require(path.is_absolute() && path != path.root_path() && drive.size() == 2 &&
              ((drive[0] >= L'A' && drive[0] <= L'Z') ||
               (drive[0] >= L'a' && drive[0] <= L'z')) && drive[1] == L':' &&
              native.find(L'\0') == std::wstring::npos,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK requires an absolute local native path");
  for (const auto &part : path.relative_path()) {
    const auto name = part.native();
    require(!name.empty() && name != L"." && name != L".." &&
                name.back() != L'.' && name.back() != L' ' &&
                name.find_first_of(L":*?\"<>|") == std::wstring::npos,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK native path contains an unsafe component");
  }
}

void ordinary_path(const std::filesystem::path &path, bool directory) {
  std::filesystem::path current = path.root_path();
  for (const auto &part : path.relative_path()) {
    current /= part;
    const DWORD attributes = GetFileAttributesW(current.c_str());
    const bool expected_directory = current != path || directory;
    require(attributes != INVALID_FILE_ATTRIBUTES &&
                (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
                ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == expected_directory,
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK native environment path is missing or unsafe");
  }
}

std::filesystem::path executable_path() {
  for (DWORD capacity = 512; capacity <= 32768; capacity *= 2) {
    std::vector<wchar_t> buffer(capacity);
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), capacity);
    require(length != 0, CITIZENSDK_ERROR_UNAVAILABLE,
            "CitizenSDK executable location is unavailable");
    if (length < capacity) {
      return std::filesystem::path(std::wstring(buffer.data(), length));
    }
  }
  throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                        "CitizenSDK executable location exceeds the native limit");
}

std::filesystem::path user_data_path() {
  PWSTR value = nullptr;
  const HRESULT status = SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &value);
  const auto release = [](wchar_t *pointer) { CoTaskMemFree(pointer); };
  const std::unique_ptr<wchar_t, decltype(release)> owned(value, release);
  require(SUCCEEDED(status) && value != nullptr && value[0] != L'\0',
          CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK current-user data directory is unavailable");
  return std::filesystem::path(value);
}

bool same_ui_window(HWND window, DWORD thread) noexcept {
  DWORD process = 0;
  return window != nullptr && IsWindow(window) &&
      GetWindowThreadProcessId(window, &process) == thread &&
      process == GetCurrentProcessId();
}

}  // namespace

struct FlutterEnvironment::State final {
  struct Watch final {
    HWND window{};
    std::shared_ptr<State> *owner{};
  };
  std::thread::id ui_thread = std::this_thread::get_id();
  DWORD thread = GetCurrentThreadId();
  HWND parent{};
  bool had_view{};
  bool alive{true};
  bool detached{};
  std::array<Watch, 2> watches{};

  static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp,
                                       UINT_PTR identity, DWORD_PTR data) noexcept {
    auto *watch = reinterpret_cast<Watch *>(data);
    const auto state = *watch->owner;
    if (message == WM_DESTROY) state->alive = false;
    if (message == WM_NCDESTROY) {
      state->alive = false;
      auto *owner = watch->owner;
      watch->owner = nullptr;
      watch->window = nullptr;
      (void)RemoveWindowSubclass(hwnd, window_proc, identity);
      const LRESULT result = DefSubclassProc(hwnd, message, wp, lp);
      delete owner;
      return result;
    }
    return DefSubclassProc(hwnd, message, wp, lp);
  }

  void remove_watches() noexcept {
    for (auto &watch : watches) {
      if (watch.owner == nullptr) continue;
      if (!RemoveWindowSubclass(watch.window, window_proc,
                                reinterpret_cast<UINT_PTR>(&watch))) {
        // 未能注销时保留观察者到 WM_NCDESTROY，不能留下悬空 subclass 数据。
        continue;
      }
      auto *owner = watch.owner;
      watch.owner = nullptr;
      watch.window = nullptr;
      delete owner;
    }
  }
};

FlutterEnvironment::FlutterEnvironment(HWND view) : state_(std::make_shared<State>()) {
  if (view == nullptr) return;
  require(same_ui_window(view, state_->thread), CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK registrar view does not belong to the current UI thread");
  const HWND parent = GetAncestor(view, GA_ROOT);
  require(same_ui_window(parent, state_->thread), CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK registrar parent does not belong to the current UI thread");
  state_->parent = parent;
  state_->had_view = true;
  try {
    const std::array<HWND, 2> windows{view, parent == view ? nullptr : parent};
    for (std::size_t index = 0; index < windows.size(); ++index) {
      if (windows[index] == nullptr) continue;
      auto &watch = state_->watches[index];
      auto owner = std::make_unique<std::shared_ptr<State>>(state_);
      watch.window = windows[index];
      watch.owner = owner.get();
      if (!SetWindowSubclass(watch.window, State::window_proc,
                             reinterpret_cast<UINT_PTR>(&watch),
                             reinterpret_cast<DWORD_PTR>(&watch))) {
        watch.owner = nullptr;
        watch.window = nullptr;
        throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                              "CitizenSDK could not observe the registrar window");
      }
      (void)owner.release();
    }
  } catch (...) {
    state_->detached = true;
    state_->remove_watches();
    throw;
  }
}

FlutterEnvironment::~FlutterEnvironment() { detach(); }

void FlutterEnvironment::detach() noexcept {
  // 私有环境只由 UI 所有者释放；不允许 worker 直接注销另一个线程的 HWND。
  if (std::this_thread::get_id() != state_->ui_thread) std::terminate();
  state_->detached = true;
  state_->remove_watches();
}

Config FlutterEnvironment::resolve(const NativeEnvironmentInputs &inputs, uint32_t modules) {
  absolute_path(inputs.executable);
  absolute_path(inputs.user_data);
  // 此处是打包/装配预检；精确存储权限与资产信任仍由已安装 Host/Core 验证。
  static const std::regex identifier(
      R"(^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$)");
  require(inputs.application_id.size() >= 3 && inputs.application_id.size() <= 253 &&
              std::regex_match(inputs.application_id, identifier),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK application_id must be an explicit lowercase reverse-DNS identifier");
  ordinary_path(inputs.executable, false);
  ordinary_path(inputs.user_data, true);
  const auto assets = inputs.executable.parent_path() / L"data" / L"flutter_assets" /
      L"packages" / L"citizen_sdk" / L"chain";
  // 未选择链时不得探测包内链资产。
  if ((modules & CITIZENSDK_MODULE_CHAIN) != 0) {
    ordinary_path(assets, true);
    for (const auto *name : {L"manifest.json", L"chainspec.json", L"light_sync_state.json"}) {
      const auto path = assets / name;
      ordinary_path(path, false);
      std::error_code error;
      const auto size = std::filesystem::file_size(path, error);
      require(!error && size > 0, CITIZENSDK_ERROR_INTEGRITY,
              "CitizenSDK Flutter chain asset is empty or unreadable");
    }
  }
  Config config;
  config.storage_root = inputs.user_data;
  config.asset_root = assets;
  config.application_id = inputs.application_id;
  config.modules = modules;
  return config;
}

OpenEnvironment FlutterEnvironment::open(uint32_t modules) const {
  return open({executable_path(), user_data_path(), CITIZENSDK_APPLICATION_ID}, modules);
}

OpenEnvironment FlutterEnvironment::open(const NativeEnvironmentInputs &inputs, uint32_t modules) const {
  require(std::this_thread::get_id() == state_->ui_thread,
          CITIZENSDK_ERROR_INVALID_STATE,
          "CitizenSDK Flutter environment requires its UI thread");
  require(!state_->detached && state_->alive, CITIZENSDK_ERROR_INVALID_STATE,
          "CitizenSDK Flutter environment or registrar window is detached");
  require(!state_->had_view || same_ui_window(state_->parent, state_->thread),
          CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Flutter parent is no longer available");
  auto config = resolve(inputs, modules);
  // 初始无 view 可以明确 rootless；曾经拥有的 view/父窗口销毁后必须拒绝，不能改成 rootless。
  config.hwnd = (modules & (CITIZENSDK_MODULE_WALLET | CITIZENSDK_MODULE_SIGNING | CITIZENSDK_MODULE_QR)) != 0
      ? state_->parent : nullptr;
  return {std::move(config), state_};
}

}  // namespace citizen_sdk::flutter
