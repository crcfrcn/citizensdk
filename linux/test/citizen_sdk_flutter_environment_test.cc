#include <cassert>
#include <filesystem>
#include <fstream>
#include <string>

#include "citizen_sdk_flutter_environment.hpp"
#include "citizen_sdk_flutter_test_support.hpp"

namespace {

void write_asset(const std::filesystem::path &path) {
  std::ofstream stream(path, std::ios::binary);
  stream << "fixture";
  assert(stream.good());
}

}  // namespace

int main() {
  using citizen_sdk::flutter::FlutterEnvironment;
  using citizen_sdk::flutter::NativeEnvironmentInputs;
  using citizen_sdk::flutter::test::TempDirectory;
  using citizen_sdk::flutter::test::expect_failure;
  TempDirectory temporary("flutter-environment");
  const auto executable = temporary.path() / "bundle" / "citizen_fixture";
  const auto assets = executable.parent_path() / "data" / "flutter_assets" /
                      "packages" / "citizen_sdk" / "chain";
  std::filesystem::create_directories(assets);
  write_asset(assets / "manifest.json");
  write_asset(assets / "chainspec.json");
  write_asset(assets / "light_sync_state.json");

  const NativeEnvironmentInputs inputs{
      executable, temporary.path() / "xdg-data", "org.example.fixture"};
  const auto config = FlutterEnvironment::resolve(inputs);
  assert(config.application_id == "org.example.fixture");
  assert(config.storage_root == temporary.path() / "xdg-data");
  assert(config.asset_root == assets);
  assert(config.gtk_parent_window == nullptr);
  assert(config.modules == CITIZENSDK_MODULE_FULL);

  auto invalid = inputs;
  invalid.application_id = "shared-default";
  expect_failure([&] { (void)FlutterEnvironment::resolve(invalid); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  invalid = inputs;
  invalid.user_data = "relative";
  expect_failure([&] { (void)FlutterEnvironment::resolve(invalid); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);

  std::filesystem::remove(assets / "manifest.json");
  assert(FlutterEnvironment::resolve(inputs, CITIZENSDK_MODULE_WALLET).modules == CITIZENSDK_MODULE_WALLET);
  assert(FlutterEnvironment::resolve(inputs, CITIZENSDK_MODULE_SIGNING).modules == CITIZENSDK_MODULE_SIGNING);
  expect_failure([&] { (void)FlutterEnvironment::resolve(inputs); },
                 CITIZENSDK_ERROR_INTEGRITY);
  write_asset(assets / "manifest.json");
  std::filesystem::remove(assets / "chainspec.json");
  std::filesystem::create_symlink(assets / "manifest.json",
                                  assets / "chainspec.json");
  expect_failure([&] { (void)FlutterEnvironment::resolve(inputs); },
                 CITIZENSDK_ERROR_INTEGRITY);

  // A headless registrar has no invented active/default GTK parent. It may
  // resolve chain configuration, while an actual wallet flow remains Host's
  // explicit native-UI decision.
  FlutterEnvironment headless(nullptr);
  headless.detach();

  return 0;
}
