// 验证 Windows Host 只读取三个精确命名的普通 CitizenChain 资产文件。
#include <cassert>
#include <filesystem>
#include <fstream>
#include <string>

#include "citizen_sdk_assets.hpp"
#include "citizen_sdk_test_support.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

namespace {

void write(const std::filesystem::path &path, const std::string &value) {
  std::ofstream stream(path, std::ios::binary | std::ios::trunc);
  assert(stream.good());
  stream.write(value.data(), static_cast<std::streamsize>(value.size()));
  assert(stream.good());
}

}  // namespace

int main() {
  using citizen_sdk::windows::Assets;
  using citizen_sdk::windows::HostError;

  citizen_sdk::windows::test::TempDirectory temporary("assets");
  const auto directory = temporary.path() / "chain";
  std::filesystem::create_directories(directory);
  write(directory / "manifest.json", "manifest");
  write(directory / "chainspec.json", "chainspec");
  write(directory / "light_sync_state.json", "sync");
  write(directory / "untrusted-extra.json", "ignored");

  const auto assets = Assets::load(directory);
  assert(std::string(assets.manifest.begin(), assets.manifest.end()) ==
         "manifest");
  assert(std::string(assets.chain_spec.begin(), assets.chain_spec.end()) ==
         "chainspec");
  assert(std::string(assets.light_sync_state.begin(),
                     assets.light_sync_state.end()) == "sync");

  std::filesystem::remove(directory / "manifest.json");
  // 硬链接不要求提升权限，仍必须因多链接的同一文件身份而拒绝。
  std::filesystem::create_hard_link(directory / "chainspec.json",
                                   directory / "manifest.json");
  bool symlink_rejected = false;
  try {
    (void)Assets::load(directory);
  } catch (const HostError &error) {
    symlink_rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY;
  }
  assert(symlink_rejected);

  bool relative_rejected = false;
  try {
    (void)Assets::load("relative-assets");
  } catch (const HostError &error) {
    relative_rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  assert(relative_rejected);
  return 0;
}
