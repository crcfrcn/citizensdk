// 显式输入、备份和私钥查看可有受控字节；路径/应用身份/裸句柄不能来自Dart。
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>
#include "citizen_sdk_flutter_codec.hpp"
#include "citizen_sdk_flutter_test_support.hpp"
#ifdef NDEBUG
#error "CitizenSDK contract assertions must remain enabled"
#endif
namespace csf = citizen_sdk::flutter;
int main() {
  const auto decode = [](const char *method, csf::Value value) {
    auto native = csf::test::fl(value);
    return csf::decode_request(method, native.get());
  };
  auto input = decode("importWallet", csf::test::list({csf::Value::integer(2), csf::Value::string("sdk"),
      csf::Value::integer(1), csf::Value::string("synthetic"), csf::Value::string("password")}));
  assert(input.mnemonic && input.password);
  assert(input.mnemonic->value.size() == 9 && input.password->value.size() == 8);
  assert(input.payload.empty()); // 不把输入复用成普通签名载荷或输出槽。
  auto owned = *input.password;
  input.password.reset();
  assert(owned.value == csf::Value::Bytes({'p','a','s','s','w','o','r','d'}));
  owned = csf::CredentialBytes(csf::Value::Bytes{});
  assert(owned.value.empty());
  csf::test::expect_failure([&] {
    (void)decode("open", csf::test::list({csf::Value::integer(2), csf::Value::integer(63),
        csf::Value::boolean(false), csf::Value::string("org.example.injected")}));
  }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  csf::test::expect_failure([&] {
    (void)decode("revealPrivateKey", csf::test::list({csf::Value::integer(2), csf::Value::string("sdk"),
        csf::Value::integer(2), csf::Value::integer(7)}));
  }, CITIZENSDK_ERROR_INVALID_ARGUMENT);

  // 下面只是源码额外门禁；上面实际生产解码和所有权断言才验证行为。
  const std::filesystem::path root(CITIZENSDK_LINUX_TEST_SOURCE_DIR);
  for (const auto *relative : {"citizen_sdk/citizen_sdk_plugin.h", "src/citizen_sdk_plugin.cc",
      "src/citizen_sdk_flutter_environment.hpp", "src/citizen_sdk_flutter_environment.cc",
      "src/citizen_sdk_flutter_codec.hpp", "src/citizen_sdk_flutter_sessions.hpp"}) {
    std::ifstream stream(root / relative, std::ios::binary);
    assert(stream.good());
    const std::string source((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    for (const auto *forbidden : {"dart_asset_root", "dart_storage_root", "dart_application_id",
        "dart_hwnd", "dart_gtk_parent", "exportMnemonic", "exportPrivateKey", "prepared_wallet_handle",
        "plaintext_dek", "citizen_sdk_secret_vault.hpp", "citizen_sdk_cng.hpp"})
      assert(source.find(forbidden) == std::string::npos);
  }
  return 0;
}
