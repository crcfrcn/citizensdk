// 验证 Windows 新增的 Host/C++ 公共表面没有另造助记词、口令、DEK 或私钥旁路。
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <set>
#include <string>

#include "citizen_sdk_host_record.hpp"

#ifndef CITIZENSDK_WINDOWS_TEST_SOURCE_DIR
#error "CITIZENSDK_WINDOWS_TEST_SOURCE_DIR must point at the Windows source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

int main() {
  using citizen_sdk::windows::HostError;
  using citizen_sdk::windows::copy_view;

  const std::filesystem::path public_headers =
      std::filesystem::path(CITIZENSDK_WINDOWS_TEST_SOURCE_DIR) / "include" /
      "citizen_sdk";
  std::set<std::string> headers;
  for (const auto &entry : std::filesystem::directory_iterator(public_headers)) {
    if (!std::filesystem::is_regular_file(entry.symlink_status())) continue;
    const auto extension = entry.path().extension();
    if (extension != ".h" && extension != ".hpp") continue;
    std::ifstream stream(entry.path(), std::ios::binary);
    assert(stream.good());
    const std::string header((std::istreambuf_iterator<char>(stream)),
                             std::istreambuf_iterator<char>());
    for (const char *forbidden : {
             "plaintext_dek", "unlock_password",
             "mnemonic_utf8", "signed_extrinsic", "getAccountPrivateKey",
         }) {
      assert(header.find(forbidden) == std::string::npos);
    }
    headers.insert(entry.path().filename().string());
  }
  const std::set<std::string> expected_headers{
      "citizensdk_host.h",
      "citizen_sdk.hpp",
      "citizen_sdk_config.hpp",
      "citizen_sdk_error.hpp",
      "citizen_sdk_events.hpp",
      "citizen_sdk_models.hpp",
      "citizen_sdk_plugin.h",
  };
  assert(headers == expected_headers);

  bool null_rejected = false;
  try {
    (void)copy_view({nullptr, 1}, 8, "null fixture");
  } catch (const HostError &error) {
    null_rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  assert(null_rejected);

  const uint8_t fixture[] = {1, 2, 3};
  assert((copy_view({fixture, 3}, 3, "fixture") ==
          citizen_sdk::windows::Bytes{1, 2, 3}));
  bool oversized_rejected = false;
  try {
    (void)copy_view({fixture, 3}, 2, "oversized fixture");
  } catch (const HostError &error) {
    oversized_rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  assert(oversized_rejected);

  // 补全/输入与显式秘密资源走无UI绑定，不能复活窗口Presenter或无租约导出。
  std::ifstream source_stream(std::filesystem::path(CITIZENSDK_WINDOWS_TEST_SOURCE_DIR)
      / "src" / "citizen_sdk_flutter_sessions.cc", std::ios::binary);
  assert(source_stream.good());
  const std::string source((std::istreambuf_iterator<char>(source_stream)), std::istreambuf_iterator<char>());
  assert(source.find("citizensdk_validate_wallet_input") != std::string::npos);
  assert(source.find("citizensdk_wallet_word_suggestions") != std::string::npos);
  for (const char *forbidden : {"present_wallet_flow", "WalletWindow", "FlutterWalletFlows", "exportPrivateKey"})
    assert(source.find(forbidden) == std::string::npos);
  return 0;
}
