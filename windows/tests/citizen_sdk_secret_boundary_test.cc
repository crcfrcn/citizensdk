// 验证 Windows 新增的 Host/C++ 公共表面没有另造助记词、口令、DEK 或私钥旁路。
#include <cassert>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <set>
#include <string>

#include "input.hpp"

#ifndef CITIZENSDK_WINDOWS_TEST_PUBLIC_HEADER_DIR
#error "CITIZENSDK_WINDOWS_TEST_PUBLIC_HEADER_DIR must point at the public header projection"
#endif
#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

int main() {
  try {
  using citizen_sdk::HostError;
  using citizen_sdk::copy_view;

  // Host 与 Core 的七个公开头由正式构建视图汇总，源码 headers 只有平台头。
  const std::filesystem::path public_headers =
      CITIZENSDK_WINDOWS_TEST_PUBLIC_HEADER_DIR;
  assert(std::filesystem::is_directory(public_headers));
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
             "citizensdk_get_private_key", "citizensdk_result_get_private_key",
             "citizensdk_get_mnemonic", "citizensdk_host_sign_payload",
         }) {
      assert(header.find(forbidden) == std::string::npos);
    }
    headers.insert(entry.path().filename().string());
  }
  const std::set<std::string> expected_headers{
      "citizensdk.h",
      "citizensdk_types.h",
      "citizensdk_host.h",
  };
  assert(headers == expected_headers);

  bool null_rejected = false;
  try {
    (void)copy_view({nullptr, 1}, 8, "null fixture");
  } catch (const HostError &error) {
    null_rejected = error.code == CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  assert(null_rejected);

  const uint8_t fixture[] = {1, 2, 3};
  assert((copy_view({fixture, 3}, 3, "fixture") ==
          citizen_sdk::Bytes{1, 2, 3}));
  bool oversized_rejected = false;
  try {
    (void)copy_view({fixture, 3}, 2, "oversized fixture");
  } catch (const HostError &error) {
    oversized_rejected = error.code == CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  assert(oversized_rejected);

  // 输入容量与公开头的真实秘密边界由上面的行为断言验证。
  return 0;
  } catch (const std::exception &error) {
    std::fprintf(stderr, "CitizenSDK Windows secret-boundary test exception: %s\n",
                 error.what());
    return 1;
  }
}
