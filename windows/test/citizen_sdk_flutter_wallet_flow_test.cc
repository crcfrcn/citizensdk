// 旧窗口协调测试改为真实生产codec的无UI钱包参数/资源边界；不再构造窗口Presenter。
#include <cassert>
#include <string>
#include <vector>
#include "citizen_sdk_flutter_codec.hpp"
#include "citizen_sdk_flutter_test_support.hpp"
#ifdef NDEBUG
#error "CitizenSDK Flutter contract assertions must remain enabled"
#endif
namespace csf = citizen_sdk::flutter;
using citizen_sdk::flutter::test::fl;
using citizen_sdk::flutter::test::list;
using citizen_sdk::flutter::test::expect_failure;

csf::DecodedRequest decode(const char *method, csf::Value value) {
  auto native = fl(value);
  return csf::decode_request(method, &native);
}

int main() {
  const auto request = [](csf::Value::List fields) {
    csf::Value::List value{csf::Value::integer(2), csf::Value::string("sdk"), csf::Value::integer(1)};
    value.insert(value.end(), fields.begin(), fields.end());
    return csf::Value::list(std::move(value));
  };
  for (auto count : {12, 18, 24}) {
    const auto prepared = decode("prepareWalletCreation", request({csf::Value::integer(count), csf::Value::string("")}));
    assert(prepared.method == csf::Method::prepare_wallet_creation && prepared.word_count == static_cast<uint32_t>(count));
    assert(prepared.password && prepared.password->value.empty());
  }
  for (auto count : {0, 15, 21, 25})
    expect_failure([&] { (void)decode("prepareWalletCreation", request({csf::Value::integer(count), csf::Value::string("")})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  const auto imported = decode("importWallet", request({csf::Value::string("synthetic"), csf::Value::string("example")}));
  assert(imported.mnemonic && imported.password);
  assert(imported.mnemonic->value == csf::Value::Bytes({'s','y','n','t','h','e','t','i','c'}));
  const auto added = decode("addWalletAccounts", request({csf::Value::string("synthetic"), csf::Value::string(""),
      list({csf::Value::integer(1), csf::Value::integer(1989)})}));
  assert((added.indices == std::vector<uint32_t>{1, 1989}));
  const auto next = decode("addNextWalletAccount", request({csf::Value::string("synthetic"), csf::Value::string("")}));
  assert(next.indices.empty()); // 原子分配由Core负责，界面不提交推算编号。
  expect_failure([&] { (void)decode("importWallet", request({csf::Value::string(std::string(1025, 'a')), csf::Value::string("")})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode("addNextWalletAccount", request({csf::Value::string("synthetic"), csf::Value::string(""),
      csf::Value::integer(1)})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (const char *old : {"createWallet", "initializeWallet", "importColdAccountWithUi",
                         "viewAccountPrivateKey", "getWalletProfile", "qrScan"})
    expect_failure([&] { (void)decode(old, request({})); }, CITIZENSDK_ERROR_UNSUPPORTED);
  for (const char *method : {"copyRecoveryPhrase", "commitWalletCreation", "releasePreparedWallet",
                            "revealPrivateKey", "closePrivateKey"}) {
    assert(decode(method, request({csf::Value::string("opaque-owned-resource")})).resource_id == "opaque-owned-resource");
    expect_failure([&] { (void)decode(method, request({csf::Value::integer(7)})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
    expect_failure([&] { (void)decode(method, request({csf::Value::string("a/b")})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  // 只有显式资源方法可返回敏感字节；普通签名仍只接收64字节公开签名。
  csf::validate_public_value(csf::Method::reveal_private_key, list({csf::Value::bytes(csf::Value::Bytes(32, 7))}));
  expect_failure([&] { csf::validate_public_value(csf::Method::reveal_private_key,
      list({csf::Value::bytes(csf::Value::Bytes(31))})); }, CITIZENSDK_ERROR_INTEGRITY);
  csf::validate_public_value(csf::Method::sign_wallet_payload, list({csf::Value::bytes(csf::Value::Bytes(64))}));
  expect_failure([&] { csf::validate_public_value(csf::Method::sign_wallet_payload,
      list({csf::Value::bytes(csf::Value::Bytes(32))})); }, CITIZENSDK_ERROR_INTEGRITY);
  return 0;
}
