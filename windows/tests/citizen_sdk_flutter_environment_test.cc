#include <windows.h>

#include <cassert>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>

#include "citizen_sdk_flutter_environment.hpp"
#include "citizen_sdk_flutter_test_support.hpp"

namespace csf = citizen_sdk::flutter;

namespace {
void write_file(const std::filesystem::path &path, const char *content = "public fixture") {
  std::ofstream stream(path, std::ios::binary);
  stream << content;
  assert(stream.good());
}

class Window final {
 public:
  explicit Window(HWND parent = nullptr) {
    value = CreateWindowExW(0, L"STATIC", L"CitizenSDK public test window",
        parent == nullptr ? WS_OVERLAPPEDWINDOW : WS_CHILD,
        0, 0, 32, 32, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    assert(value != nullptr);
  }
  ~Window() { if (value != nullptr) assert(DestroyWindow(value)); }
  void destroy() { assert(value != nullptr && DestroyWindow(value)); value = nullptr; }
  HWND value{};
};
}  // namespace

int main() {
  const char *stage = "fixture";
  const auto mark = [&](const char *value) { stage = value; std::fprintf(stderr, "WINDOWS_ENV_STAGE stage=%s\n", stage); std::fflush(stderr); };
  try {
  mark("fixture");
  using csf::test::expect_failure;
  csf::test::TempDirectory temporary("flutter-environment");
  const auto bundle = temporary.path() / L"bundle";
  const auto executable = bundle / L"fixture.exe";
  const auto assets = bundle / L"data" / L"flutter_assets" / L"packages" /
      L"citizen_sdk" / L"chain";
  const auto user_data = temporary.path() / L"user-data";
  std::filesystem::create_directories(assets);
  std::filesystem::create_directory(user_data);
  write_file(executable);
  for (const auto *name : {L"manifest.json", L"chainspec.json", L"light_sync_state.json"})
    write_file(assets / name);
  const csf::NativeEnvironmentInputs inputs{executable, user_data, "org.example.fixture"};
  mark("resolve");
  const auto config = csf::FlutterEnvironment::resolve(inputs);
  assert(config.application_id == inputs.application_id);
  assert(config.storage_root == user_data && config.asset_root == assets);
  assert(config.parent == nullptr && config.modules == CITIZENSDK_MODULE_FULL);

  mark("invalid_application_id");
  // 这些是装配预检夹具，不冒充通过 Core 的 manifest/链锚验真。
  for (const auto &identifier : {std::string{}, std::string("shared-default"),
       std::string("Org.Example.App"), std::string("org.example_app"),
       std::string("org.example.\0app", 16), std::string(254, 'a')}) {
    auto invalid = inputs;
    invalid.application_id = identifier;
    expect_failure([&] { (void)csf::FlutterEnvironment::resolve(invalid); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  mark("invalid_storage_root");
  for (const auto &path : {std::filesystem::path(L"relative"), inputs.user_data.root_path(),
       inputs.user_data / L"..", std::filesystem::path(L"\\\\server\\share\\state"),
       inputs.user_data / L"space "}) {
    auto invalid = inputs;
    invalid.user_data = path;
    expect_failure([&] { (void)csf::FlutterEnvironment::resolve(invalid); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  mark("invalid_assets");
  for (const auto *name : {L"manifest.json", L"chainspec.json", L"light_sync_state.json"}) {
    const auto path = assets / name;
    assert(std::filesystem::remove(path));
    assert(csf::FlutterEnvironment::resolve(inputs, CITIZENSDK_MODULE_WALLET).modules == CITIZENSDK_MODULE_WALLET);
    assert(csf::FlutterEnvironment::resolve(inputs, CITIZENSDK_MODULE_SIGNING).modules == CITIZENSDK_MODULE_SIGNING);
    expect_failure([&] { (void)csf::FlutterEnvironment::resolve(inputs); }, CITIZENSDK_ERROR_INTEGRITY);
    write_file(path, "");
    expect_failure([&] { (void)csf::FlutterEnvironment::resolve(inputs); }, CITIZENSDK_ERROR_INTEGRITY);
    assert(std::filesystem::remove(path));
    assert(std::filesystem::create_directory(path));
    expect_failure([&] { (void)csf::FlutterEnvironment::resolve(inputs); }, CITIZENSDK_ERROR_INTEGRITY);
    assert(std::filesystem::remove(path));
    write_file(path);
  }

  // 使用真实 Win32 父/子窗口调用生产观察者；不是测试专用的窗口状态机。
  mark("parent_view");
  Window parent;
  Window view(parent.value);
  csf::FlutterEnvironment environment(view.value);
  const auto opened = environment.open(inputs);
  assert(opened.config.parent == parent.value && opened.ui_parent_lease);
  mark("foreign_thread");
  std::thread worker([&] {
    expect_failure([&] { (void)environment.open(inputs); }, CITIZENSDK_ERROR_INVALID_STATE);
    expect_failure([&] { csf::FlutterEnvironment foreign(view.value); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  });
  worker.join();
  mark("view_destroyed");
  view.destroy();
  assert(IsWindow(parent.value));
  expect_failure([&] { (void)environment.open(inputs); }, CITIZENSDK_ERROR_INVALID_STATE);
  environment.detach();

  mark("root_window");
  Window root;
  csf::FlutterEnvironment root_environment(root.value);
  assert(root_environment.open(inputs).config.parent == root.value);
  root.destroy();
  expect_failure([&] { (void)root_environment.open(inputs); }, CITIZENSDK_ERROR_INVALID_STATE);

  mark("rootless");
  csf::FlutterEnvironment rootless(nullptr);
  assert(rootless.open(inputs).config.parent == nullptr);
  rootless.detach();
  expect_failure([&] { (void)rootless.open(inputs); }, CITIZENSDK_ERROR_INVALID_STATE);
  return 0;
  } catch (const csf::ContractFailure &error) {
    std::fprintf(stderr, "WINDOWS_ENV_FAILURE stage=%s contract_code=%d\n", stage, static_cast<int>(error.code));
  } catch (const std::exception &) {
    std::fprintf(stderr, "WINDOWS_ENV_FAILURE stage=%s exception=true\n", stage);
  }
  std::fflush(stderr); return 1;
}
