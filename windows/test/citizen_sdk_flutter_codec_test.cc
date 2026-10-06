#include <flutter/standard_method_codec.h>

// 验证 Windows 官方 StandardMethodCodec 与唯一 v2 tuple，且不会截断 UTF-8/NUL。
// 公开结果夹具沿用 Linux；不伪造 Core 句柄，不引入 Host 私有源码。
#include <any>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <set>
#include <string>

#include "citizen_sdk_flutter_codec.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows codec contract assertions must remain enabled"
#endif

namespace {
using citizen_sdk::flutter::ContractFailure;
using citizen_sdk::flutter::DecodedRequest;
using citizen_sdk::flutter::Method;
using citizen_sdk::flutter::Value;

Value list(Value::List items) { return Value::list(std::move(items)); }
template <class Callback>
void expect_failure(Callback callback, citizensdk_error_code_t expected) {
  try { callback(); } catch (const ContractFailure &error) {
    assert(error.code == expected); return;
  }
  assert(false && "Expected a contract failure");
}

std::string account(char digit) { return "0x" + std::string(64, digit); }

DecodedRequest decode(const char *method, Value request) {
  auto native = citizen_sdk::flutter::to_encodable_value(request);
  const auto &codec = ::flutter::StandardMethodCodec::GetInstance();
  const auto wire = codec.EncodeMethodCall(::flutter::MethodCall<::flutter::EncodableValue>(
      method, std::make_unique<::flutter::EncodableValue>(std::move(native))));
  assert(wire != nullptr);
  const auto call = citizen_sdk::flutter::decode_method_call(wire->data(), wire->size());
  assert(call != nullptr);
  return citizen_sdk::flutter::decode_request(call->method_name(), call->arguments());
}

const Value::List &as_list(const Value &value) {
  const auto *result = std::get_if<Value::List>(&value.data);
  assert(result != nullptr);
  return *result;
}
const std::string &as_string(const Value &value) {
  const auto *result = std::get_if<std::string>(&value.data);
  assert(result != nullptr);
  return *result;
}


// 本测试只验证通道结构和敏感副本，不冒充Core钱包、认证或真实摄像头验收。
void test_headless_contract() {
  {
    // 敏感标记在递归复制每个叶时建立，不等整棵树成功后才补标。
    auto native = citizen_sdk::flutter::to_encodable_value(
        list({Value::string("synthetic"), list({Value::bytes({1, 2})})}));
    auto owned = citizen_sdk::flutter::from_encodable_value(native, true);
    const auto &fields = as_list(owned);
    assert(fields[0].sensitive && as_list(fields[1])[0].sensitive);
    auto &mutable_fields = std::get<Value::List>(owned.data);
    mutable_fields[0].clear_sensitive();
    assert(as_string(mutable_fields[0]) == std::string(9, '\0'));
  }
  using citizen_sdk::flutter::validate_public_value;
  const auto request = [](Value::List fields) {
    Value::List result{Value::integer(2), Value::string("s"), Value::integer(1)};
    result.insert(result.end(), fields.begin(), fields.end());
    return Value::list(std::move(result));
  };
  // 原付款选择不携带账户顺序或签名；修订是完整u64而非有符号截断。
  const auto selected = decode("setActiveWallet", request({Value::string("18446744073709551615"), Value::integer(UINT32_MAX)}));
  assert(selected.wallet_revision == UINT64_MAX && selected.wallet_index == UINT32_MAX);
  assert(decode("renameWallet", request({Value::string("7"), Value::integer(0), Value::string("钱包名")})).name == "钱包名");
  for (const auto &bad_revision : {"01", "-1", "18446744073709551616"})
    expect_failure([&] { (void)decode("setActiveWallet", request({Value::string(bad_revision), Value::integer(0)})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (auto index : {int64_t{-1}, int64_t{UINT32_MAX} + 1})
    expect_failure([&] { (void)decode("setActiveWallet", request({Value::string("1"), Value::integer(index)})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (const char *bad_name : {"", " leading", "trailing "})
    expect_failure([&] { (void)decode("renameWallet", request({Value::string("1"), Value::integer(0), Value::string(bad_name)})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto profile = list({Value::integer(0), Value::string("created"), Value::string("1"),
    Value::string(account('1')), Value::string(account('1')),
    list({list({Value::integer(0), Value::string(account('1')), Value::string("address"), Value::string("账户名"), Value::string("1"), Value::boolean(true)})}), Value::string("钱包名")});
  auto state = list({Value::string("7"), profile,
    list({list({Value::string("hot"), Value::integer(0), Value::integer(0), Value::string(account('1')),
      Value::string("address"), Value::string("账户名"), Value::string("1"), Value::boolean(true)})}),
    Value::integer(1), Value::boolean(false), Value::integer(0), list({})});
  validate_public_value(Method::set_active_wallet, list({state}));
  validate_public_value(Method::rename_wallet, list({state}));
  auto stale_selection = state;
  std::get<Value::List>(stale_selection.data)[5] = Value::integer(99);
  expect_failure([&] { validate_public_value(Method::get_wallet_state, list({stale_selection})); }, CITIZENSDK_ERROR_INTEGRITY);
  auto old_tuple = state; std::get<Value::List>(old_tuple.data).pop_back();
  expect_failure([&] { validate_public_value(Method::get_wallet_state, list({old_tuple})); }, CITIZENSDK_ERROR_INTEGRITY);
  auto drifted = state;
  std::get<Value::List>(std::get<Value::List>(std::get<Value::List>(drifted.data)[2].data)[0].data)[5] = Value::string("另一个名");
  expect_failure([&] { validate_public_value(Method::get_wallet_state, list({drifted})); }, CITIZENSDK_ERROR_INTEGRITY);
  for (const char *method : {"copyRecoveryPhrase", "commitWalletCreation", "releasePreparedWallet",
       "revealPrivateKey", "closePrivateKey", "signQrRequest", "releaseQrReview", "releaseWalletInspection",
       "closeQrCapture", "pauseQrCapture", "resumeQrCapture"}) {
    assert(decode(method, request({Value::string("opaque-resource_1")})).resource_id == "opaque-resource_1");
    assert(decode(method, request({Value::string(std::string(128, 'a'))})).resource_id.size() == 128);
    for (const std::string &bad : {std::string(""), std::string(" 1"), std::string("a/b"), std::string(129, 'a')})
      expect_failure([&] { (void)decode(method, request({Value::string(bad)})); },
                     CITIZENSDK_ERROR_INVALID_ARGUMENT);
    expect_failure([&] { (void)decode(method, request({Value::integer(1)})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  assert(decode("cancelOperation", request({Value::string("18446744073709551615")})).resource_id == "18446744073709551615");
  for (const char *bad : {"0", "01", "-1", "18446744073709551616", "opaque"})
    expect_failure([&] { (void)decode("cancelOperation", request({Value::string(bad)})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (const char *method : {"importWallet", "addNextWalletAccount"}) {
    const auto decoded = decode(method, request({Value::string("synthetic"), Value::string("")}));
    assert(decoded.mnemonic && decoded.mnemonic->value.size() == 9 &&
           decoded.password && decoded.password->value.empty());
    expect_failure([&] { (void)decode(method, request({Value::string("synthetic")})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  // 1024按UTF-8字节计数，不按UTF-16字符数放宽；内容有效性仍交给Core。
  assert(decode("validateWalletPassword", request({Value::string(std::string(1024, 'a'))})).password->value.size() == 1024);
  for (const char *method : {"validateWalletPassword", "walletWordSuggestions"}) {
    expect_failure([&] { (void)decode(method, request({Value::string(std::string(1025, 'a'))})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
    expect_failure([&] { (void)decode(method, request({Value::bytes({1})})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  std::string multibyte;
  for (unsigned i = 0; i < 342; ++i) multibyte += "中";
  expect_failure([&] { (void)decode("validateWalletMnemonic", request({Value::string(multibyte), Value::integer(18)})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (int purpose = 1; purpose <= 8; ++purpose) {
    assert(decode("openQrCapture", request({Value::integer(purpose)})).qr_purpose == static_cast<uint32_t>(purpose));
    const auto image = decode("qrDecodeImage", request({Value::bytes({1}), Value::integer(purpose)}));
    assert(image.payload.size() == 1 && image.qr_purpose == static_cast<uint32_t>(purpose));
  }
  for (int purpose : {0, 9})
    expect_failure([&] { (void)decode("openQrCapture", request({Value::integer(purpose)})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode("qrDecodeImage", request({Value::bytes({}), Value::integer(1)})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  const auto torch = decode("setQrCaptureTorch", request({Value::string("7"), Value::boolean(true)}));
  assert(torch.resource_id == "7" && torch.torch);
  expect_failure([&] { (void)decode("setQrCaptureTorch", request({Value::string("7"), Value::integer(1)})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (const char *method : {"importColdAccountId", "importColdAccountSs58", "importColdAccountCode"}) {
    const auto input = method == std::string("importColdAccountId") ? account('1') : "synthetic";
    assert(decode(method, request({Value::string(input), Value::string("")})).name.empty());
  }
  expect_failure([&] { (void)decode("renameAccount", request({Value::string(account('1')), Value::string("")})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  // v1不可再作为有效通道或open二元组恢复。
  expect_failure([&] { (void)decode("open", list({Value::integer(1), Value::integer(63), Value::boolean(false)})); },
                 CITIZENSDK_ERROR_UNSUPPORTED);
  expect_failure([&] { (void)decode("open", list({Value::integer(2), Value::integer(63)})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (int reason = 0; reason <= 8; ++reason)
    validate_public_value(Method::validate_wallet_mnemonic,
        list({Value::integer(reason), reason == 3 ? Value::integer(23) : Value::null()}));
  for (auto invalid : {list({Value::integer(9), Value::null()}),
                       list({Value::integer(0), Value::integer(0)}),
                       list({Value::integer(3), Value::null()}),
                       list({Value::integer(3), Value::integer(24)})})
    expect_failure([&] { validate_public_value(Method::validate_wallet_mnemonic, invalid); },
                   CITIZENSDK_ERROR_INTEGRITY);
  validate_public_value(Method::wallet_word_suggestions, list({list({Value::string("synthetic")})}));
  expect_failure([&] { validate_public_value(Method::wallet_word_suggestions,
      list({list({Value::string("UPPER")})})); }, CITIZENSDK_ERROR_INTEGRITY);
  for (Method method : {Method::delete_wallet, Method::sign_and_delete_wallet, Method::close_private_key,
       Method::release_prepared_wallet, Method::release_qr_review, Method::release_wallet_inspection, Method::close_qr_capture,
       Method::pause_qr_capture, Method::resume_qr_capture, Method::set_qr_capture_torch}) {
    validate_public_value(method, list({}));
    expect_failure([&] { validate_public_value(method, list({Value::null()})); }, CITIZENSDK_ERROR_INTEGRITY);
  }
  for (auto malformed : {Value::integer(1), Value::string(""), Value::string("bad/id")})
    expect_failure([&] { validate_public_value(Method::open_private_key, list({malformed})); },
                   CITIZENSDK_ERROR_INTEGRITY);
  auto secret = list({Value::bytes(Value::Bytes(32, 7))});
  validate_public_value(Method::reveal_private_key, secret);
  assert(as_list(secret)[0].sensitive);
  expect_failure([&] { validate_public_value(Method::reveal_private_key, list({Value::bytes(Value::Bytes(31))})); },
                 CITIZENSDK_ERROR_INTEGRITY);
  validate_public_value(Method::open_qr_capture,
      list({Value::string("1"), Value::integer(0), Value::integer(640), Value::integer(480), Value::integer(270)}));
  expect_failure([&] { validate_public_value(Method::open_qr_capture,
      list({Value::string("1"), Value::integer(0), Value::integer(640), Value::integer(480), Value::integer(1)})); },
                 CITIZENSDK_ERROR_INTEGRITY);
  validate_public_value(Method::get_wallet_state,
      list({list({Value::string("0"), Value::null(), list({}), Value::integer(0), Value::boolean(false), Value::null(), list({})})}));
  for (auto bad : {list({Value::string("0"), Value::null(), list({}), Value::integer(1), Value::boolean(false)}),
                   list({Value::string("0"), Value::null(), list({}), Value::integer(0), Value::boolean(true)})})
    expect_failure([&] { validate_public_value(Method::get_wallet_state, list({bad})); },
                   CITIZENSDK_ERROR_INTEGRITY);
}

void test_inspection_contract() {
  using citizen_sdk::flutter::validate_public_value;
  const auto id = Value::string(account('1'));
  const auto targets = list({list({id, Value::string(account('2'))}), Value::boolean(true)});
  const auto diagnostic = list({Value::integer(0), Value::string("异常"), id, Value::null(),
      Value::integer(3), Value::string("hot"), targets});
  const auto state = list({Value::string("7"), Value::null(), list({}),
      Value::integer(1), Value::boolean(false), Value::integer(0), list({diagnostic})});
  validate_public_value(Method::get_wallet_state, list({state}));
  validate_public_value(Method::inspect_wallets, list({Value::string("inspection-1"), state}));
  for (const auto method : {Method::repair_hot_wallet, Method::rename_diagnostic_wallet, Method::delete_diagnostic_wallet})
    validate_public_value(method, list({state}));
  for (const char *method : {"repairHotWallet", "deleteDiagnosticWallet", "renameDiagnosticWallet"}) {
    auto fields = list({Value::integer(2), Value::string("s"), Value::integer(1), Value::string("inspection-1"), Value::integer(UINT32_MAX)});
    if (std::string(method) == "renameDiagnosticWallet") std::get<Value::List>(fields.data).push_back(Value::string("名字"));
    const auto decoded = decode(method, fields);
    assert(decoded.resource_id == "inspection-1" && decoded.wallet_index == UINT32_MAX);
    std::get<Value::List>(fields.data).push_back(Value::boolean(true));
    expect_failure([&] { (void)decode(method, fields); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  for (const auto &invalid : {Value::string("unknown"), Value::integer(1)}) {
    auto bad = diagnostic; std::get<Value::List>(bad.data)[5] = invalid;
    auto copy = state; std::get<Value::List>(copy.data)[6] = list({bad});
    expect_failure([&] { validate_public_value(Method::get_wallet_state, list({copy})); }, CITIZENSDK_ERROR_INTEGRITY);
  }
  auto bad = diagnostic;
  std::get<Value::List>(bad.data)[6] = list({list({id, id}), Value::boolean(true)});
  auto copy = state; std::get<Value::List>(copy.data)[6] = list({bad});
  expect_failure([&] { validate_public_value(Method::get_wallet_state, list({copy})); }, CITIZENSDK_ERROR_INTEGRITY);
}

void test_method_closure_and_requests() {
  constexpr Method all[] = {
      Method::open,
      Method::start,
      Method::stop,
      Method::close,
      Method::get_capabilities,
      Method::get_finalized_head,
      Method::get_sync_status,
      Method::get_best_head,
      Method::get_finalized_block_at,
      Method::resolve_finalized_block,
      Method::get_block_header,
      Method::get_block_body,
      Method::get_runtime_context,
      Method::get_storage,
      Method::get_storage_batch,
      Method::get_storage_keys_paged,
      Method::call_runtime_api,
      Method::get_system_events,
      Method::export_state,
      Method::import_state,
      Method::get_genesis_hash,
      Method::get_account_balance,
      Method::get_account_balances,
      Method::get_account_nonce,
      Method::get_fee_snapshot,
      Method::get_wallet_state,
      Method::inspect_wallets, Method::release_wallet_inspection, Method::repair_hot_wallet,
      Method::rename_diagnostic_wallet, Method::delete_diagnostic_wallet,
      Method::validate_wallet_password,
      Method::validate_wallet_mnemonic,
      Method::wallet_word_suggestions,
      Method::prepare_wallet_creation,
      Method::copy_recovery_phrase,
      Method::commit_wallet_creation,
      Method::release_prepared_wallet,
      Method::open_private_key,
      Method::reveal_private_key,
      Method::close_private_key,
      Method::cancel_operation,
      Method::respond_credential,
      Method::cancel_credential,
      Method::add_next_wallet_account,
      Method::sign_and_delete_wallet,
      Method::import_cold_account_code,
      Method::import_cold_account_id,
      Method::import_cold_account_ss58,
      Method::reorder_wallet_accounts_without_default_change,
      Method::set_active_wallet,
      Method::rename_wallet,
      Method::rename_account,
      Method::delete_account,
      Method::import_wallet,
      Method::add_wallet_accounts,
      Method::set_active_wallet_account,
      Method::delete_wallet,
      Method::reconcile_wallet_cleanup,
      Method::sign_wallet_payload,
      Method::begin_signing,
      Method::consume_external_signature,
      Method::cancel_signing,
      Method::begin_default_account_change,
      Method::consume_default_account_change,
      Method::verify_signature,
      Method::encode_signing_payload,
      Method::qr_encode_document,
      Method::qr_prepare_account_authorization,
      Method::prepare_transaction,
      Method::cancel_prepared_transaction,
      Method::execute_prepared_transaction,
      Method::consume_prepared_transaction_qr_response,
      Method::cancel_prepared_transaction_execution,
      Method::get_transaction_history,
      Method::sync_transaction_history,
      Method::qr_parse,
      Method::qr_create_sign_request,
      Method::qr_validate_sign_response,
      Method::qr_consume_sign_response,
      Method::qr_cancel_sign_request,
      Method::qr_encode_account_id,
      Method::qr_decode_luminance,
      Method::qr_encode,
      Method::review_qr_request,
      Method::release_qr_review,
      Method::open_qr_capture,
      Method::close_qr_capture,
      Method::pause_qr_capture,
      Method::resume_qr_capture,
      Method::set_qr_capture_torch,
      Method::qr_decode_image,
      Method::sign_qr_request,
  };
  std::set<std::string> names;
  for (Method method : all) {
    const auto *name = citizen_sdk::flutter::method_name(method);
    names.insert(name);
    const auto failure = citizen_sdk::flutter::error_details(CITIZENSDK_ERROR_INVALID_ARGUMENT,
        "synthetic", std::string("s"), int64_t{1}, name);
    assert(as_string(as_list(failure)[5]) == name);
  }
  assert(names.size() == 94 && names.count("open") == 1 &&
         names.count("getTransactionHistory") == 1);

  assert(decode("open", list({Value::integer(2), Value::integer(63), Value::boolean(false)})).modules == 63);
  assert(decode("open", list({Value::integer(2), Value::integer(2), Value::boolean(false)})).modules == 2);
  expect_failure([&] { (void)decode("open", list({Value::integer(2)})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (const auto invalid : {int64_t{0}, int64_t{-1}, int64_t{UINT32_MAX} + 1}) {
    expect_failure([&] { (void)decode("open", list({Value::integer(2), Value::integer(invalid), Value::boolean(false)})); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  for (const char *method : {"start", "stop", "close", "getCapabilities",
       "getFinalizedHead", "getSyncStatus", "getBestHead", "exportState",
       "getGenesisHash", "getFeeSnapshot", "getWalletState", "inspectWallets", "signAndDeleteWallet",
       "deleteWallet", "reconcileWalletCleanup"}) {
    auto value = decode(method, list({Value::integer(2), Value::string("s"),
                                      Value::integer(1)}));
    assert(value.session == "s" && value.sequence == 1);
  }
  const auto finalized = list({Value::string(account('1')), Value::string("1"),
                               Value::string("finalized")});
  assert(decode("getFinalizedBlockAt", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("1")})).block_number == 1);
  assert(decode("resolveFinalizedBlock", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string(account('1')), Value::string("1")})).block_number == 1);
  for (const char *method : {"getBlockHeader", "getBlockBody", "getRuntimeContext",
                             "getSystemEvents"})
    assert(decode(method, list({Value::integer(2), Value::string("s"),
        Value::integer(1), finalized})).block.finality == CITIZENSDK_FINALITY_FINALIZED);
  assert(decode("getStorage", list({Value::integer(2), Value::string("s"), Value::integer(1),
      finalized, Value::bytes({1})})).payload.size() == 1);
  assert(decode("getStorageBatch", list({Value::integer(2), Value::string("s"), Value::integer(1),
      finalized, list({Value::bytes({1}), Value::bytes({2})})})).storage_keys.size() == 2);
  const auto keys_page = decode("getStorageKeysPaged", list({Value::integer(2),
      Value::string("s"), Value::integer(1), finalized, Value::bytes({1}),
      Value::null(), Value::integer(1000)}));
  assert(keys_page.storage_keys_limit == 1000 && !keys_page.storage_start_key);
  const auto runtime = decode("callRuntimeApi", list({Value::integer(2), Value::string("s"),
      Value::integer(1), finalized, Value::string("CitizenApi_items"), Value::bytes({})}));
  assert(runtime.runtime_api_method == "CitizenApi_items" && runtime.payload.empty());
  assert(decode("importState", list({Value::integer(2), Value::string("s"), Value::integer(1),
      Value::integer(1), finalized, Value::bytes({1})})).state_database.size() == 1);
  for (const char *method : {"getAccountBalance", "getAccountNonce",
       "setActiveWalletAccount", "deleteAccount", "openPrivateKey"}) {
    assert(decode(method, list({Value::integer(2), Value::string("s"),
        Value::integer(1), Value::string(account('0'))})).account_id.bytes[0] == 0);
  }
  citizen_sdk::flutter::validate_public_value(Method::open_private_key, list({Value::string("1")}));
  expect_failure([&] { citizen_sdk::flutter::validate_public_value(
      Method::open_private_key, list({Value::bytes(Value::Bytes(32))})); }, CITIZENSDK_ERROR_INTEGRITY);
  expect_failure([&] { (void)decode("openPrivateKey", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::string(account('0')), Value::integer(1)})); },
      CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (int words : {12, 18, 24})
    assert(decode("prepareWalletCreation", list({Value::integer(2), Value::string("s"),
        Value::integer(1), Value::integer(words), Value::string("")})).word_count == static_cast<uint32_t>(words));
  assert((decode("addWalletAccounts", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("synthetic"), Value::string(""),
      list({Value::integer(1), Value::integer(19890604)})})).indices == std::vector<uint32_t>{1, 19890604}));
  // 原上界后的序号合法，超过新上界的混合批次整体拒绝。
  assert(decode("addWalletAccounts", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("synthetic"), Value::string(""),
      list({Value::integer(1990)})})).indices[0] == 1990);
  expect_failure([&] { (void)decode("addWalletAccounts", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::string("synthetic"), Value::string(""),
      list({Value::integer(8), Value::integer(19890605)})})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(decode("renameAccount", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string(account('1')), Value::string("冷账户") })).name == "冷账户");
  assert(decode("importColdAccountId", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string(account('1')), Value::string("冷账户") })).name == "冷账户");
  assert(decode("importColdAccountSs58", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("w5CZACAABUbK4jspzPB5be9trhtSgRCRZFafGe7kvFPvxq8M2"),
      Value::string("冷账户") })).name == "冷账户");
  const auto reordered = decode("reorderWalletAccountsWithoutDefaultChange", list({
      Value::integer(2), Value::string("s"), Value::integer(1), Value::string("7"),
      list({Value::string(account('1')), Value::string(account('2'))})}));
  assert(reordered.wallet_revision == 7 && reordered.account_ids.size() == 2);
  assert(decode("signWalletPayload", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string(account('2')), Value::bytes({1, 2})})).payload.size() == 2);
  const auto signing = decode("beginSigning", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string(account('2')), Value::bytes({1, 2}), Value::string("raw"),
      Value::bytes({}), Value::string("none"), Value::integer(0), Value::integer(120)}));
  assert(signing.signing_transform == CITIZENSDK_SIGNING_TRANSFORM_RAW &&
         signing.external_signer_transport == CITIZENSDK_EXTERNAL_SIGNER_NONE);
  assert(decode("consumeExternalSignature", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("signing-session"), Value::string("{}")})).signing_response == "{}");
  assert(decode("cancelSigning", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("signing-session")})).signing_session_id == "signing-session");
  const auto default_change = decode("beginDefaultAccountChange", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::string("7"),
      list({Value::string(account('2')), Value::string(account('1'))}), Value::integer(120)}));
  assert(default_change.wallet_revision == 7 && default_change.account_ids.size() == 2);
  assert(decode("consumeDefaultAccountChange", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("signing-session"), Value::string("{}")})).signing_response == "{}");
  const auto verification = decode("verifySignature", list({Value::integer(2),
      Value::string(account('2')), Value::bytes(Value::Bytes(64)), Value::bytes({})}));
  assert(verification.signature.size() == 64 && verification.session.empty() &&
         verification.sequence == 0);
  const auto prepared = decode("prepareTransaction", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::string(account('2')),
      Value::bytes({1, 2})}));
  assert(prepared.account_id.bytes[0] == 0x22 && prepared.payload.size() == 2);
  assert(decode("cancelPreparedTransaction", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("0x00112233445566778899aabbccddeeff")})).preparation_id ==
      "0x00112233445566778899aabbccddeeff");
  assert(decode("executePreparedTransaction", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("0x00112233445566778899aabbccddeeff")})).preparation_id ==
      "0x00112233445566778899aabbccddeeff");
  assert(decode("consumePreparedTransactionQrResponse", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("0x112233445566778899aabbccddeeff00"),
      Value::string("QR_V1")})).signing_response == "QR_V1");
  assert(decode("cancelPreparedTransactionExecution", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("0x112233445566778899aabbccddeeff00")})).execution_id.bytes[0] == 0x11);

  assert(decode("openQrCapture", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::integer(1)})).qr_purpose == 1);
  assert(decode("signQrRequest", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("9")})).resource_id == "9");
  expect_failure([&] { (void)decode("qrParse", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::string("{}"), Value::integer(10)})); },
      CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (const char *removed : {"qrSigningInput", "qrCreateSignResponse", "qrEncodeImage",
       "getWalletProfile", "viewAccountPrivateKey", "initializeWallet", "importColdAccountWithUi",
       "createWallet", "renameWalletAccount", "deleteWalletAccount", "qrScan"})
    expect_failure([&] { (void)decode(removed, list({Value::integer(2),
        Value::string("s"), Value::integer(1)})); }, CITIZENSDK_ERROR_UNSUPPORTED);
  citizen_sdk::flutter::validate_public_value(Method::qr_consume_sign_response,
      list({Value::bytes(Value::Bytes(64))}));
  expect_failure([&] { citizen_sdk::flutter::validate_public_value(Method::qr_consume_sign_response,
      list({})); }, CITIZENSDK_ERROR_INTEGRITY);
  expect_failure([&] { citizen_sdk::flutter::validate_public_value(Method::qr_consume_sign_response,
      list({Value::bytes(Value::Bytes(63))})); }, CITIZENSDK_ERROR_INTEGRITY);
  citizen_sdk::flutter::validate_public_value(Method::review_qr_request, list({Value::string("1"), Value::string("{}")}));
  assert(decode("qrParse", list({Value::integer(2), Value::string("s"), Value::integer(2),
      Value::string("{}")})).qr_text == "{}");
  assert(decode("qrCreateSignRequest", list({Value::integer(2), Value::string("s"),
      Value::integer(3), Value::integer(0x0400), Value::string(account('2')),
      Value::bytes({4, 0}), Value::integer(120)})).qr_action == 0x0400);
  assert(decode("qrEncode", list({Value::integer(2), Value::string("s"),
      Value::integer(4), Value::string("{}"), Value::integer(4)})).qr_scale == 4);
  expect_failure([&] { (void)decode("verifySignature", list({Value::integer(2),
      Value::string(account('2')), Value::bytes(Value::Bytes(63)), Value::bytes({})}));
  }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode("verifySignature", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::string(account('2')),
      Value::bytes(Value::Bytes(64)), Value::bytes({})}));
  }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  citizen_sdk::flutter::validate_public_value(Method::verify_signature, list({Value::boolean(false)}));
  expect_failure([&] { citizen_sdk::flutter::validate_public_value(
      Method::verify_signature, list({Value::integer(0)})); }, CITIZENSDK_ERROR_INTEGRITY);
  for (const std::size_t count : {std::size_t{0}, std::size_t{2}, std::size_t{1990}}) {
    const auto batch = decode("getAccountBalances", list({Value::integer(2), Value::string("s"),
        Value::integer(1), Value::list(Value::List(count, Value::string(account('2'))))}));
    assert(batch.account_ids.size() == count);
  }
  expect_failure([&] { (void)decode("getAccountBalances", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::list(Value::List(1991, Value::string(account('2'))))}));
  }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode("getAccountBalances", list({Value::integer(2), Value::string("s"),
      Value::integer(1), list({Value::string("invalid")})}));
  }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  const auto anchor = list({Value::string(account('3')), Value::string("9"), Value::string("finalized")});
  const auto balance = list({Value::string(account('2')), anchor, Value::string("1"),
                            Value::string("0"), Value::string("1")});
  citizen_sdk::flutter::validate_public_value(Method::get_genesis_hash, list({Value::string(account('3'))}));
  expect_failure([&] { citizen_sdk::flutter::validate_public_value(
      Method::get_genesis_hash, list({Value::string("invalid")})); }, CITIZENSDK_ERROR_INTEGRITY);
  auto request = decode("getAccountBalances", list({Value::integer(2), Value::string("s"),
      Value::integer(1), list({Value::string(account('2')), Value::string(account('2'))})}));
  citizen_sdk::flutter::validate_account_balances(request, list({list({balance, balance})}));
  expect_failure([&] { citizen_sdk::flutter::validate_account_balances(
      request, list({list({balance})})); }, CITIZENSDK_ERROR_INTEGRITY);
  auto wrong_account = balance;
  std::get<Value::List>(wrong_account.data)[0] = Value::string(account('1'));
  expect_failure([&] { citizen_sdk::flutter::validate_account_balances(
      request, list({list({balance, wrong_account})})); }, CITIZENSDK_ERROR_INTEGRITY);
  auto wrong_block = balance;
  std::get<Value::List>(wrong_block.data)[1] =
      list({Value::string(account('3')), Value::string("10"), Value::string("finalized")});
  expect_failure([&] { citizen_sdk::flutter::validate_account_balances(
      request, list({list({balance, wrong_block})})); }, CITIZENSDK_ERROR_INTEGRITY);
  const auto history = decode("getTransactionHistory", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::null(), Value::integer(100)}));
  assert(!history.before_execution_id.has_value() && history.history_limit == 100);
  const auto paged = decode("getTransactionHistory", list({Value::integer(2),
      Value::string("s"), Value::integer(2),
      Value::string("0x00112233445566778899aabbccddeeff"), Value::integer(25)}));
  assert(paged.before_execution_id.has_value() && paged.history_limit == 25);
  assert(decode("syncTransactionHistory", list({Value::integer(2), Value::string("s"),
      Value::integer(3)})).method == Method::sync_transaction_history);
}

void test_strict_failures() {
  expect_failure([&] { (void)decode("open", list({Value::boolean(true)})); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode("unknown", list({Value::integer(2)})); },
                 CITIZENSDK_ERROR_UNSUPPORTED);
  for (const int64_t words : {int64_t{15}, int64_t{21}}) {
    expect_failure([&] { (void)decode("prepareWalletCreation", list({Value::integer(2), Value::string("s"),
        Value::integer(1), Value::integer(words), Value::string("")})); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  expect_failure([&] { (void)decode("addWalletAccounts", list({Value::integer(2), Value::string("s"),
      Value::integer(1), Value::string("synthetic"), Value::string(""),
      list({Value::integer(1), Value::integer(1)})})); },
      CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode("getTransactionHistory", list({Value::integer(2),
      Value::string("s"), Value::integer(1), Value::null(), Value::integer(101)})); },
      CITIZENSDK_ERROR_INVALID_ARGUMENT);

  Value nested = Value::integer(1);
  for (int i = 0; i < 34; ++i) nested = list({std::move(nested)});
  auto native = citizen_sdk::flutter::to_encodable_value(nested);
  expect_failure([&] { (void)citizen_sdk::flutter::from_encodable_value(native); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);

  Value::List too_many;
  too_many.reserve(4097);
  for (int i = 0; i < 4097; ++i) too_many.push_back(Value::null());
  native = citizen_sdk::flutter::to_encodable_value(Value::list(std::move(too_many)));
  expect_failure([&] { (void)citizen_sdk::flutter::from_encodable_value(native); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);

  Value::Bytes bulk(9 * 1024 * 1024, 7);
  native = citizen_sdk::flutter::to_encodable_value(list({Value::bytes(bulk), Value::bytes(std::move(bulk))}));
  expect_failure([&] { (void)citizen_sdk::flutter::from_encodable_value(native); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);

  const ::flutter::EncodableValue custom(::flutter::CustomEncodableValue(std::any(999)));
  expect_failure([&] { (void)citizen_sdk::flutter::from_encodable_value(custom); },
                 CITIZENSDK_ERROR_INVALID_ARGUMENT);
}

void test_standard_wire_preserves_nul_and_unicode() {
  using ::flutter::EncodableValue;
  const auto &codec = ::flutter::StandardMethodCodec::GetInstance();
  const std::string exact("途\0遇", 7);
  auto arguments = citizen_sdk::flutter::to_encodable_value(list({
      Value::integer(2), Value::string("session"), Value::integer(8), Value::string(exact)}));
  const ::flutter::MethodCall<EncodableValue> call(
      "qrParse", std::make_unique<EncodableValue>(arguments));
  const auto wire = codec.EncodeMethodCall(call);
  assert(wire != nullptr);
  const auto decoded = citizen_sdk::flutter::decode_method_call(wire->data(), wire->size());
  assert(decoded != nullptr && decoded->arguments() != nullptr);
  const auto request = citizen_sdk::flutter::decode_request(
      decoded->method_name(), decoded->arguments());
  assert(request.qr_text.size() == exact.size() &&
         std::memcmp(request.qr_text.data(), exact.data(), exact.size()) == 0);
  // 真实官方编解码往返必须逐字节相同；Windows 无 custom wire tag 或 NUL 特例。
  const auto second_wire = codec.EncodeMethodCall(*decoded);
  assert(second_wire != nullptr && *wire == *second_wire);

  // 独立标准线格式夹具：tag 7 方法名、tag 12 tuple、tag 3 int32。
  const std::vector<uint8_t> open_wire{7, 4, 'o', 'p', 'e', 'n', 12, 3, 3, 2, 0, 0, 0, 3, 63, 0, 0, 0, 2};
  const auto open = citizen_sdk::flutter::decode_method_call(open_wire.data(), open_wire.size());
  assert(open != nullptr && citizen_sdk::flutter::decode_request(
      open->method_name(), open->arguments()).method == Method::open);
  const auto reencoded_open = codec.EncodeMethodCall(*open);
  assert(reencoded_open != nullptr && *reencoded_open == open_wire);

  // StandardMethodCodec 将字符串保存为带长度字节；业务转换仍须拒绝畸形 UTF-8。
  std::get<::flutter::EncodableList>(arguments)[3] =
      EncodableValue(std::string("\xc3\x28", 2));
  const auto malformed_wire = codec.EncodeMethodCall(::flutter::MethodCall<EncodableValue>(
      "qrParse", std::make_unique<EncodableValue>(arguments)));
  assert(malformed_wire != nullptr);
  expect_failure([&] { (void)citizen_sdk::flutter::decode_method_call(
      malformed_wire->data(), malformed_wire->size()); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
}

void test_raw_wire_bounds() {
  using citizen_sdk::flutter::decode_method_call;
  const auto rejects = [](const std::vector<uint8_t> &wire) {
    expect_failure([&] { (void)decode_method_call(wire.data(), wire.size()); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
  };
  expect_failure([&] { (void)decode_method_call(nullptr, 0); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode_method_call(nullptr, 1); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  const std::vector<uint8_t> prefix{7, 4, 'o', 'p', 'e', 'n'};
  const auto argument_wire = [&](std::initializer_list<uint8_t> bytes) {
    auto wire = prefix; wire.insert(wire.end(), bytes.begin(), bytes.end()); return wire;
  };
  rejects({});
  rejects({0, 12, 1, 0});  // 方法名不是 string。
  rejects(prefix);         // 没有 arguments。
  rejects({7, 254, 4});    // size 的 uint16 本身截断。
  rejects({7, 255, 4, 0});
  rejects({7, 4, 'o'});   // 方法名 payload 截断。
  rejects({7, 255, 255, 255, 255, 255}); // 巨长 string 声明必须在分配前失败。
  rejects(argument_wire({12, 1, 3, 1, 0, 0})); // int32 截断。
  rejects(argument_wire({12, 1, 4, 1, 0, 0, 0, 0, 0, 0})); // int64 截断。
  rejects(argument_wire({12, 1, 7, 3, 'a', 'b'})); // 截断不能被补 NUL。
  rejects(argument_wire({12, 1, 8, 3, 1, 2}));
  rejects(argument_wire({12, 1, 7, 255, 255, 255, 255, 255}));
  rejects(argument_wire({12, 1, 8, 255, 255, 255, 255, 255}));
  rejects(argument_wire({12, 255, 255, 255, 255, 255}));
  rejects(argument_wire({12, 1, 3, 1, 0, 0, 0, 0})); // 尾随零字节也不能忽略。
  rejects(argument_wire({12, 1, 7, 2, 0xc3, 0x28}));
  for (const uint8_t tag : {uint8_t{5}, uint8_t{6}, uint8_t{9}, uint8_t{10},
                           uint8_t{11}, uint8_t{13}, uint8_t{14}, uint8_t{255}}) {
    rejects(argument_wire({12, 1, tag}));
  }

  auto deeply_nested = prefix;
  for (unsigned index = 0; index < 34; ++index) {
    deeply_nested.push_back(12); deeply_nested.push_back(1);
  }
  deeply_nested.push_back(0);
  rejects(deeply_nested);
  // 根节点 + 4,096 子节点超过共享预算，不得先 reserve 再拒绝。
  auto many_nodes = argument_wire({12, 254, 0, 16});
  many_nodes.insert(many_nodes.end(), 4096, 0);
  rejects(many_nodes);

  // 官方 int32/int64 两种合法字宽均接受；不能拿转成 Value 后的再编码当门禁。
  for (const auto &wire : {argument_wire({12, 3, 3, 2, 0, 0, 0, 3, 31, 0, 0, 0, 2}),
                          argument_wire({12, 3, 4, 2, 0, 0, 0, 0, 0, 0, 0, 3, 31, 0, 0, 0, 2})}) {
    const auto call = decode_method_call(wire.data(), wire.size());
    assert(call != nullptr && citizen_sdk::flutter::decode_request(
        call->method_name(), call->arguments()).method == Method::open);
  }
  // 官方允许的扩展 size 表示不属于截断/尾随；预检不另订长度编码协议。
  const std::vector<uint8_t> extended_size{
      7, 254, 4, 0, 'o', 'p', 'e', 'n', 12, 255, 3, 0, 0, 0, 3, 2, 0, 0, 0, 3, 31, 0, 0, 0, 2};
  const auto extended = decode_method_call(extended_size.data(), extended_size.size());
  assert(extended != nullptr && citizen_sdk::flutter::decode_request(
      extended->method_name(), extended->arguments()).method == Method::open);

  const auto &codec = ::flutter::StandardMethodCodec::GetInstance();
  for (const char *method : {"listen", "cancel"}) {
    auto args = citizen_sdk::flutter::to_encodable_value(list({Value::integer(2)}));
    const auto wire = codec.EncodeMethodCall(::flutter::MethodCall<::flutter::EncodableValue>(
        method, std::make_unique<::flutter::EncodableValue>(std::move(args))));
    assert(wire != nullptr);
    const auto call = decode_method_call(wire->data(), wire->size());
    assert(call != nullptr && citizen_sdk::flutter::decode_subscription(call->arguments()));
  }

  // 从真实有效消息删除最后一个字节，防止官方零填充把截断解释成另一条合法请求。
  for (const bool signing : {false, true}) {
    auto args = signing
        ? list({Value::integer(2), Value::string("s"), Value::integer(1),
            Value::string(account('0')), Value::bytes({1, 2, 3})})
        : list({Value::integer(2), Value::string("s"), Value::integer(1),
            Value::string("abc")});
    const auto wire = codec.EncodeMethodCall(::flutter::MethodCall<::flutter::EncodableValue>(
        signing ? "signWalletPayload" : "qrParse",
        std::make_unique<::flutter::EncodableValue>(citizen_sdk::flutter::to_encodable_value(args))));
    assert(wire != nullptr && !wire->empty());
    auto truncated = *wire; truncated.pop_back(); rejects(truncated);
  }
  auto bulk = citizen_sdk::flutter::to_encodable_value(list({
      Value::bytes(Value::Bytes(9 * 1024 * 1024)), Value::bytes(Value::Bytes(9 * 1024 * 1024))}));
  const auto bulk_wire = codec.EncodeMethodCall(::flutter::MethodCall<::flutter::EncodableValue>(
      "open", std::make_unique<::flutter::EncodableValue>(std::move(bulk))));
  assert(bulk_wire != nullptr); rejects(*bulk_wire);
  // 线格式总量仍在外层预算内，但两个合法单项合计越过复制预算，须在第二项分配前拒绝。
  auto aggregate = citizen_sdk::flutter::to_encodable_value(list({
      Value::bytes(Value::Bytes(8 * 1024 * 1024)),
      Value::bytes(Value::Bytes(8 * 1024 * 1024 + 8192))}));
  const auto aggregate_wire = codec.EncodeMethodCall(::flutter::MethodCall<::flutter::EncodableValue>(
      "open", std::make_unique<::flutter::EncodableValue>(std::move(aggregate))));
  assert(aggregate_wire != nullptr); rejects(*aggregate_wire);
}

class CapturedResult final : public ::flutter::MethodResult<::flutter::EncodableValue> {
 public:
  unsigned successes{}, errors{}, not_implemented{};
  Value value;
  std::string code, message;
 protected:
  void SuccessInternal(const ::flutter::EncodableValue *result) override {
    ++successes;
    value = result == nullptr ? Value::null() : citizen_sdk::flutter::from_encodable_value(*result);
  }
  void ErrorInternal(const std::string &error_code, const std::string &error_message,
                     const ::flutter::EncodableValue *details) override {
    ++errors; code = error_code; message = error_message;
    value = details == nullptr ? Value::null() : citizen_sdk::flutter::from_encodable_value(*details);
  }
  void NotImplementedInternal() override { ++not_implemented; }
};

void test_windows_value_types_and_limits() {
  using namespace citizen_sdk::flutter;
  using ::flutter::EncodableValue;
  for (const auto &integer : {EncodableValue(int32_t{1}), EncodableValue(int64_t{1})}) {
    EncodableValue arguments(::flutter::EncodableList{integer, EncodableValue(int32_t{31})});
    assert(decode_request("open", &arguments).method == Method::open);
    EncodableValue subscription_arguments(::flutter::EncodableList{integer});
    assert(decode_subscription(&subscription_arguments));
  }
  for (const auto &wrong : {EncodableValue(true), EncodableValue(1.0),
       EncodableValue(std::vector<int32_t>{1}), EncodableValue(std::vector<int64_t>{1}),
       EncodableValue(std::vector<float>{1}), EncodableValue(std::vector<double>{1}),
       EncodableValue(::flutter::EncodableMap{})}) {
    EncodableValue arguments(::flutter::EncodableList{wrong});
    expect_failure([&] { (void)decode_request("open", &arguments); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
    expect_failure([&] { (void)decode_subscription(&arguments); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  expect_failure([&] { (void)decode_request("open", nullptr); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  expect_failure([&] { (void)decode_subscription(nullptr); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto subscription = to_encodable_value(list({Value::integer(1)}));
  expect_failure([&] { (void)decode_subscription(&subscription); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  auto open = to_encodable_value(list({Value::integer(1)}));
  expect_failure([&] { (void)decode_request(std::string("open\0extra", 10), &open); },
                 CITIZENSDK_ERROR_UNSUPPORTED);
  for (const std::string &invalid : {std::string("\xc0\x80", 2), std::string("\xed\xa0\x80", 3),
       std::string("\xf4\x90\x80\x80", 4), std::string("\xe2\x82", 2)}) {
    assert(!valid_utf8(invalid));
    expect_failure([&] { (void)from_encodable_value(EncodableValue(invalid)); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
    expect_failure([&] { (void)to_encodable_value(Value::string(invalid)); },
                   CITIZENSDK_ERROR_INTEGRITY);
  }
  assert(valid_utf8(std::string("a\0b", 3)) && valid_utf8("公民😀"));

  // 最大签名消息仍合法；单项和累计预算分别有负例，不用缩小已有 16 MiB 合同。
  auto maximum = to_encodable_value(list({Value::integer(2), Value::string("s"),
      Value::integer(INT64_MAX), Value::string(account('0')),
      Value::bytes(Value::Bytes(16 * 1024 * 1024, 7))}));
  assert(decode_request("signWalletPayload", &maximum).payload.size() == 16 * 1024 * 1024);
  assert(decode_request("signWalletPayload", &maximum).sequence == INT64_MAX);
  const auto maximum_wire = ::flutter::StandardMethodCodec::GetInstance().EncodeMethodCall(
      ::flutter::MethodCall<EncodableValue>("signWalletPayload",
          std::make_unique<EncodableValue>(maximum)));
  assert(maximum_wire != nullptr);
  const auto maximum_call = decode_method_call(maximum_wire->data(), maximum_wire->size());
  assert(maximum_call != nullptr && decode_request(maximum_call->method_name(),
      maximum_call->arguments()).payload.size() == 16 * 1024 * 1024);
  EncodableValue too_large(std::vector<uint8_t>(16 * 1024 * 1024 + 1));
  expect_failure([&] { (void)from_encodable_value(too_large); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  EncodableValue strings(::flutter::EncodableList{
      EncodableValue(std::string(9 * 1024 * 1024, 'a')),
      EncodableValue(std::string(9 * 1024 * 1024, 'b'))});
  expect_failure([&] { (void)from_encodable_value(strings); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);

  try {
    (void)decode("prepareWalletCreation", list({Value::integer(2), Value::string("tracked"),
        Value::integer(3), Value::integer(15), Value::string("")}));
    assert(false);
  } catch (const ContractFailure &error) {
    assert(error.code == CITIZENSDK_ERROR_INVALID_ARGUMENT &&
           error.session == "tracked" && error.sequence == 3);
  }
}

void test_envelopes_and_decimal() {
  using namespace citizen_sdk::flutter;
  assert(decimal_u128(parse_u128("0")) == "0");
  assert(decimal_u128(parse_u128("340282366920938463463374607431768211455")) ==
         "340282366920938463463374607431768211455");
  const auto envelope = response("s", 7, list({Value::string("running")}));
  assert(as_list(envelope).size() == 4 && as_string(as_list(envelope)[1]) == "s");
  const auto failure = error_details(CITIZENSDK_ERROR_BUSY, "busy", "s", 7, "getStorage");
  assert(as_list(failure).size() == 7 && as_integer(as_list(failure)[4]) ==
         CITIZENSDK_FAILURE_STAGE_ADMISSION &&
         as_string(as_list(failure)[5]) == "getStorage" &&
         as_string(as_list(failure)[6]) == "busy");
  assert(std::string(error_name(CITIZENSDK_ERROR_BUSY)) == "busy");
  std::set<std::string> codes;
  for (citizensdk_error_code_t code = 0; code <= CITIZENSDK_ERROR_CANCELLED; ++code) {
    codes.insert(error_name(code));
  }
  assert(codes.size() == 23 && std::string(error_name(-1)) == "integrity");
  for (const char *invalid : {"", "01", "+1", "-1", "1 ", " 1",
       "340282366920938463463374607431768211456"}) {
    expect_failure([&] { (void)parse_u128(invalid); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  const auto &codec = ::flutter::StandardMethodCodec::GetInstance();
  auto success_value = to_encodable_value(envelope);
  const auto success_wire = codec.EncodeSuccessEnvelope(&success_value);
  assert(success_wire != nullptr);
  CapturedResult success;
  assert(codec.DecodeAndProcessResponseEnvelope(success_wire->data(), success_wire->size(), &success));
  assert(success.successes == 1 && success.errors == 0 && success.not_implemented == 0 &&
         as_string(as_list(success.value)[1]) == "s");
  auto error_value = to_encodable_value(failure);
  const auto error_wire = codec.EncodeErrorEnvelope("busy", "busy", &error_value);
  assert(error_wire != nullptr);
  CapturedResult error;
  assert(codec.DecodeAndProcessResponseEnvelope(error_wire->data(), error_wire->size(), &error));
  assert(error.errors == 1 && error.successes == 0 && error.not_implemented == 0 &&
         error.code == "busy" && error.message == "busy" &&
         as_string(as_list(error.value)[4]) == "busy");
  auto event_value = to_encodable_value(event("s", 9, "lifecycleChanged",
      list({lifecycle(CITIZENSDK_LIFECYCLE_RUNNING)})));
  const auto event_wire = codec.EncodeSuccessEnvelope(&event_value);
  assert(event_wire != nullptr);
  CapturedResult received_event;
  assert(codec.DecodeAndProcessResponseEnvelope(event_wire->data(), event_wire->size(), &received_event));
  assert(received_event.successes == 1 && as_list(received_event.value).size() == 5 &&
         as_string(as_list(received_event.value)[3]) == "lifecycleChanged");
  expect_failure([&] { (void)event("s", 9, "unknown", list({})); }, CITIZENSDK_ERROR_INTEGRITY);
  expect_failure([&] { (void)response("s", 9, Value::string("not a tuple")); },
                 CITIZENSDK_ERROR_INTEGRITY);
}

Value::List &mutable_list(Value &value) { return std::get<Value::List>(value.data); }
Value block_fixture(char hash = '1', const char *number = "7", bool finalized = true) {
  return list({Value::string(account(hash)), Value::string(number),
               Value::string(finalized ? "finalized" : "best")});
}
Value execution_fixture(bool success = true) {
  return list({Value::string(success ? "success" : "failed"), block_fixture(),
      Value::integer(0), success ? Value::null() : Value::integer(0), Value::null(), Value::null()});
}
Value profile_fixture() {
  // Public AccountId/SS58 golden pair from citizenchain-wallet-derivation-v1;
  // no mnemonic, child seed or password is copied into this fixture.
  constexpr const char *id = "0x2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972";
  constexpr const char *address = "w5CZACAABUbK4jspzPB5be9trhtSgRCRZFafGe7kvFPvxq8M2";
  auto item = list({Value::integer(0), Value::string(id), Value::string(address),
      Value::string("主账户"), Value::string("0"), Value::boolean(true)});
  return list({Value::integer(0), Value::string("created"), Value::string("0"),
      Value::string(id), Value::string(id), list({std::move(item)})});
}
Value history_fixture() {
  const auto id = Value::string("0x00112233445566778899aabbccddeeff");
  auto record = list({id, Value::string(account('1')), Value::string(account('2')),
      Value::string(account('3')), Value::string("pending"), Value::null(),
      Value::null(), Value::null(), Value::string("1"), Value::string("1"), Value::null()});
  return list({Value::string("1"), list({std::move(record)}), id});
}

void test_profile_semantics() {
  using citizen_sdk::flutter::validate_public_value;
  const auto good = profile_fixture();
  validate_public_value(Method::commit_wallet_creation, list({good}));
  for (unsigned kind = 0; kind < 7; ++kind) {
    auto bad = good; auto &profile = mutable_list(bad);
    auto &accounts = mutable_list(profile[5]); auto &first = mutable_list(accounts[0]);
    switch (kind) {
      case 0: first[2] = Value::string(""); break;
      case 1: accounts.push_back(accounts[0]); break;
      case 2: first[0] = Value::integer(1); break;
      case 3: profile[4] = Value::string(account('1')); break;
      case 4: first[3] = Value::string("\xc2\xa0"); break;
      case 5: profile[0] = Value::integer(1); break;
      case 6: profile[1] = Value::string("unknown"); break;
    }
    expect_failure([&] { validate_public_value(Method::commit_wallet_creation, list({bad})); },
                   CITIZENSDK_ERROR_INTEGRITY);
  }
}

void test_history_semantics() {
  using citizen_sdk::flutter::validate_public_value;
  const auto good = history_fixture();
  validate_public_value(Method::sync_transaction_history, list({good}));
  for (unsigned kind = 0; kind < 6; ++kind) {
    auto bad = good; auto &history = mutable_list(bad);
    auto &records = mutable_list(history[1]);
    switch (kind) {
      case 0: records.push_back(records[0]); break;
      case 1: mutable_list(records[0])[4] = Value::string("finalizedSuccess"); break;
      case 2: mutable_list(records[0])[9] = Value::string("0"); break;
      case 3: history[2] = Value::string("0xffffffffffffffffffffffffffffffff"); break;
      case 4: mutable_list(records[0])[3] = Value::string("invalid"); break;
      case 5: mutable_list(records[0])[0] = Value::string("invalid"); break;
    }
    expect_failure([&] { validate_public_value(Method::sync_transaction_history, list({bad})); },
                   CITIZENSDK_ERROR_INTEGRITY);
  }
}

void test_balance_nonce_fee_semantics() {
  using citizen_sdk::flutter::validate_public_value;
  auto balance = list({Value::string(account('1')), block_fixture(),
      Value::string("3"), Value::string("2"), Value::string("5")});
  validate_public_value(Method::get_account_balance, list({balance}));
  mutable_list(balance)[4] = Value::string("4");
  expect_failure([&] { validate_public_value(Method::get_account_balance, list({balance})); },
                 CITIZENSDK_ERROR_INTEGRITY);
  const auto nonce = list({Value::string(account('1')), block_fixture(), Value::string("0")});
  expect_failure([&] { validate_public_value(Method::get_account_nonce, list({nonce})); },
                 CITIZENSDK_ERROR_INTEGRITY);
  const auto fee = list({block_fixture('1', "7", false), Value::integer(0), Value::string("1"), Value::string("0")});
  expect_failure([&] { validate_public_value(Method::get_fee_snapshot, list({fee})); },
                 CITIZENSDK_ERROR_INTEGRITY);

  citizensdk_capability_snapshot_t snapshot{};
  snapshot.struct_size = sizeof(snapshot); snapshot.abi_version = CITIZENSDK_ABI_VERSION;
  snapshot.count = CITIZENSDK_CAPABILITY_COUNT;
  for (uint32_t i = 0; i < snapshot.count; ++i) {
    snapshot.statuses[i].name = i + 1;
    snapshot.statuses[i].reason = CITIZENSDK_CAPABILITY_REASON_BUILD_UNSUPPORTED;
  }
  (void)citizen_sdk::flutter::capabilities(snapshot);
  snapshot.statuses[0].ready = 1;
  expect_failure([&] { (void)citizen_sdk::flutter::capabilities(snapshot); },
                 CITIZENSDK_ERROR_INTEGRITY);
  snapshot.statuses[0].ready = 0;
  snapshot.statuses[1].name = snapshot.statuses[0].name;
  expect_failure([&] { (void)citizen_sdk::flutter::capabilities(snapshot); },
                 CITIZENSDK_ERROR_INTEGRITY);
}
}  // namespace

int main() {
  {
    // 参数尚未解码时已能取得外壳，生产按此调用唯一Core接纳；无会话方法不占序号。
    auto native = citizen_sdk::flutter::to_encodable_value(list({Value::integer(2), Value::string("synthetic"), Value::integer(1)}));
    const auto envelope = citizen_sdk::flutter::decode_request_envelope("getStorageKeysPaged", &native);
    assert(envelope && envelope->session == "synthetic" && envelope->sequence == 1);
    expect_failure([&] { (void)citizen_sdk::flutter::decode_request("getStorageKeysPaged", &native); },
                   CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(!citizen_sdk::flutter::decode_request_envelope("verifySignature", nullptr));
  }


  {
    const auto id = Value::string("capture_1");
    for (int purpose = 1; purpose <= 8; ++purpose)
      (void)citizen_sdk::flutter::event("s", purpose, "qrCaptureResult",
          Value::list({id, Value::integer(purpose), Value::string("{}")}));
    (void)citizen_sdk::flutter::event("s", 9, "qrCaptureClosed", Value::list({id}));
    (void)citizen_sdk::flutter::event("s", 10, "qrCapturePreview",
        Value::list({id, Value::integer(4096), Value::integer(1), Value::integer(270)}));
    (void)citizen_sdk::flutter::event("s", 11, "qrCaptureError",
        Value::list({id, Value::integer(CITIZENSDK_ERROR_PERMISSION_DENIED),
          Value::string(citizen_sdk::flutter::error_name(CITIZENSDK_ERROR_PERMISSION_DENIED)),
          Value::integer(CITIZENSDK_FAILURE_STAGE_AUTHENTICATION)}));
    const auto reject = [&](const char *type, Value payload) {
      expect_failure([&] { (void)citizen_sdk::flutter::event("s", 12, type, payload); }, CITIZENSDK_ERROR_INTEGRITY);
    };
    reject("qrCaptureClosed", Value::list({Value::string("not/owned")}));
    reject("qrCaptureClosed", Value::list({id, Value::integer(0)}));
    reject("qrCaptureResult", Value::list({id, Value::integer(0), Value::string("{}")}));
    reject("qrCaptureResult", Value::list({id, Value::integer(9), Value::string("{}")}));
    reject("qrCaptureResult", Value::list({id, Value::integer(1), Value::string(std::string(65537, 'a'))}));
    reject("qrCapturePreview", Value::list({id, Value::integer(0), Value::integer(1), Value::integer(0)}));
    reject("qrCapturePreview", Value::list({id, Value::integer(2), Value::integer(2), Value::integer(45)}));
    reject("qrCaptureError", Value::list({id, Value::integer(0), Value::string("internal"), Value::integer(1)}));
    reject("qrCaptureError", Value::list({id, Value::integer(23), Value::string("internal"), Value::integer(1)}));
    reject("qrCaptureError", Value::list({id, Value::integer(CITIZENSDK_ERROR_PERMISSION_DENIED),
        Value::string("internal"), Value::integer(1)}));
  }

  {
    // SDK自己的敏感值副本显式清零；普通公开值不被误擦，标记不增加tuple字段。
    auto secret = Value::sensitive_bytes({1, 2, 3});
    auto copy = secret;
    secret.clear_sensitive();
    assert(std::get<Value::Bytes>(secret.data) == Value::Bytes({0, 0, 0}));
    assert(std::get<Value::Bytes>(copy.data) == Value::Bytes({1, 2, 3}));
    copy.clear_sensitive();
    assert(std::get<Value::Bytes>(copy.data) == Value::Bytes({0, 0, 0}));
    auto nested = Value::list({Value::string("synthetic"), Value::bytes({4, 5})});
    nested.mark_sensitive(); nested.clear_sensitive();
    const auto &items = std::get<Value::List>(nested.data);
    assert(std::get<std::string>(items[0].data) == std::string(9, '\0'));
    assert(std::get<Value::Bytes>(items[1].data) == Value::Bytes({0, 0}));
    auto public_value = Value::bytes({7}); public_value.clear_sensitive();
    assert(std::get<Value::Bytes>(public_value.data) == Value::Bytes({7}));
  }
  {
    const auto request = decode("qrValidateSignResponse", list({Value::integer(2), Value::string("sdk"),
        Value::integer(1), Value::string("request"), Value::string("{}")}));
    assert(request.method == Method::qr_validate_sign_response);
    assert(request.qr_request_id == "request" && request.qr_text == "{}");
    expect_failure([] {
      (void)decode("qrValidateSignResponse", list({Value::integer(2), Value::string("sdk"),
          Value::integer(2), Value::string(""), Value::string("{}")}));
    }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
    expect_failure([] {
      (void)decode("qrValidateSignResponse", list({Value::integer(2), Value::string("sdk"),
          Value::integer(2), Value::string("request"), Value::string("{}"), Value::integer(100)}));
    }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
    citizen_sdk::flutter::validate_public_value(Method::qr_validate_sign_response, list({}));
  }
  {
    // 新入口只投影结构；实际编码由Core完成，静态载荷不需要session。
    const auto payload = decode("encodeSigningPayload", list({
        Value::integer(2), Value::integer(1), Value::string("{\"op_tag\":16}"), Value::bytes({})}));
    assert(payload.method == Method::encode_signing_payload && payload.session.empty());
    assert(payload.payload_kind == 1 && payload.payload.empty());
    const auto document = decode("qrEncodeDocument", list({
        Value::integer(2), Value::string("s"), Value::integer(1), Value::string("{}")}));
    assert(document.method == Method::qr_encode_document && document.input_json == "{}");
    const auto authorization = decode("qrPrepareAccountAuthorization", list({
        Value::integer(2), Value::string("s"), Value::integer(2), Value::integer(10),
        Value::bytes({}), Value::string("")}));
    assert(authorization.qr_action == 10 && authorization.account_id_text.empty());
    expect_failure([] {
      (void)decode("encodeSigningPayload", list({Value::integer(2), Value::integer(7),
          Value::string("{}"), Value::bytes({})}));
    }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
    expect_failure([] {
      (void)decode("encodeSigningPayload", list({Value::integer(1), Value::integer(1),
          Value::string("{}"), Value::bytes({})}));
    }, CITIZENSDK_ERROR_UNSUPPORTED);
    expect_failure([] {
      (void)decode("qrPrepareAccountAuthorization", list({Value::integer(2), Value::string("s"),
          Value::integer(3), Value::integer(10), Value::bytes(std::vector<uint8_t>(1921)), Value::string("")}));
    }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  (void)citizen_sdk::flutter::event("s", 1, "historyChanged", Value::list({}));
  (void)citizen_sdk::flutter::event(
      "s", 2, "finalizedBlockChanged", Value::list({block_fixture('3', "7", true)}));
  expect_failure([] {
    (void)citizen_sdk::flutter::event(
        "s", 2, "finalizedBlockChanged", Value::list({block_fixture('3', "7", false)}));
  }, CITIZENSDK_ERROR_INTEGRITY);
  expect_failure([] {
    (void)citizen_sdk::flutter::event("s", 1, "historyChanged", Value::list({Value::integer(1)}));
  }, CITIZENSDK_ERROR_INTEGRITY);
  test_headless_contract();
  test_method_closure_and_requests();
  test_inspection_contract();
  test_strict_failures();
  test_standard_wire_preserves_nul_and_unicode();
  test_raw_wire_bounds();
  test_envelopes_and_decimal();
  test_windows_value_types_and_limits();
  test_profile_semantics();
  test_history_semantics();
  test_balance_nonce_fee_semantics();
  return 0;
}
