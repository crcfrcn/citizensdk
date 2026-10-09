#include "citizensdk_jni_support.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "citizensdk_host_bridge.hpp"
#include "citizensdk_internal.h"
#include "citizensdk_qr_image.h"

// Android 专用内部 Core 入口；Context 仅用于系统证书验证器初始化，不进入公开 C ABI。
extern "C" int32_t citizensdk_android_init_tls(void *env, void *context);

namespace citizen::sdk::jni {
namespace {

constexpr uint32_t kWireVersion = 1;
constexpr int32_t kOk = CITIZENSDK_OK;
constexpr jsize kMaxWalletSecretBytes = 1024;
constexpr jsize kMaxWalletAccountIndices = 1989;
// 热派生范围独立于批次和冷账户容量，按实际输入增长集合。
constexpr uint32_t kMaxWalletAccountIndex = 19890604;
constexpr uint32_t kMaxWalletAccounts = kMaxWalletAccountIndex + 1;
constexpr uint32_t kMaxColdAccounts = 1990;
constexpr uint32_t kMaxCatalogAccounts = kMaxWalletAccounts + kMaxColdAccounts;
constexpr size_t kMaxQrTextBytes = 2331;
constexpr size_t kMaxQrReviewBytes = 1920;
constexpr size_t kMaxQrImageBytes = 16U * 1024U * 1024U;
std::mutex g_bridges_mutex;
std::unordered_map<intptr_t, std::shared_ptr<CitizenSdkHostBridge>> g_bridges;

// 私有显示 context 不进入公开头或普通结果编码；只在 Core 全生命周期请求结束后释放。
struct PrivateKeyViewContext {
  JavaVM *vm;
  jobject owner;
  jmethodID display;
  jmethodID settled;
  jmethodID authorizing;
};

class PrivateKeyViewEnv final {
 public:
  explicit PrivateKeyViewEnv(JavaVM *vm) : vm_(vm) {
    const jint code = vm_->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
    if (code == JNI_EDETACHED) attached_ = vm_->AttachCurrentThread(&env, nullptr) == JNI_OK;
    else if (code != JNI_OK) env = nullptr;
  }
  ~PrivateKeyViewEnv() { if (attached_) vm_->DetachCurrentThread(); }
  JNIEnv *env = nullptr;
 private:
  JavaVM *vm_;
  bool attached_ = false;
};

int32_t private_key_display(void *raw, uint64_t view_id, citizensdk_bytes_view_t bytes) {
  auto *context = static_cast<PrivateKeyViewContext *>(raw);
  if (bytes.len != 32 || bytes.data == nullptr) return CITIZENSDK_ERROR_INTEGRITY;
  PrivateKeyViewEnv scope(context->vm);
  if (scope.env == nullptr) return CITIZENSDK_ERROR_UNAVAILABLE;
  // direct buffer 仅在同步调用期间借用 Rust 内存；JVM 立即转入 SDK 自有可擦字符数组。
  auto buffer = scope.env->NewDirectByteBuffer(const_cast<uint8_t *>(bytes.data), 32);
  if (buffer == nullptr) { scope.env->ExceptionClear(); return CITIZENSDK_ERROR_INTERNAL; }
  const jint code = scope.env->CallIntMethod(context->owner, context->display,
                                            static_cast<jlong>(view_id), buffer);
  scope.env->DeleteLocalRef(buffer);
  if (scope.env->ExceptionCheck()) { scope.env->ExceptionClear(); return CITIZENSDK_ERROR_INTERNAL; }
  return code;
}

void private_key_settled(void *raw, uint64_t view_id, int32_t code) {
  auto *context = static_cast<PrivateKeyViewContext *>(raw);
  PrivateKeyViewEnv scope(context->vm);
  if (scope.env == nullptr) return;
  scope.env->CallVoidMethod(context->owner, context->settled, static_cast<jlong>(view_id), code);
  if (scope.env->ExceptionCheck()) scope.env->ExceptionClear();
}

int32_t private_key_authorizing(void *raw, uint64_t view_id, uint64_t operation_id) {
  auto *context = static_cast<PrivateKeyViewContext *>(raw);
  PrivateKeyViewEnv scope(context->vm);
  if (scope.env == nullptr) return CITIZENSDK_ERROR_UNAVAILABLE;
  const jint code = scope.env->CallIntMethod(context->owner, context->authorizing,
      static_cast<jlong>(view_id), static_cast<jlong>(operation_id));
  if (scope.env->ExceptionCheck()) { scope.env->ExceptionClear(); return CITIZENSDK_ERROR_INTERNAL; }
  return code;
}

std::shared_ptr<CitizenSdkHostBridge> bridge_from(JNIEnv *env, jlong raw) {
  const intptr_t key = static_cast<intptr_t>(raw);
  std::lock_guard<std::mutex> lock(g_bridges_mutex);
  const auto found = g_bridges.find(key);
  if (key == 0 || found == g_bridges.end()) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_HANDLE,
              "CitizenSDK native session is closed");
    return {};
  }
  return found->second;
}

citizensdk_bytes_view_t view(const std::vector<uint8_t> &bytes) {
  return {bytes.empty() ? nullptr : bytes.data(),
          static_cast<uint64_t>(bytes.size())};
}

void secure_zero(std::vector<uint8_t> *bytes) {
  volatile uint8_t *cursor = bytes->data();
  for (size_t index = 0; index < bytes->size(); ++index) cursor[index] = 0;
  bytes->clear();
}

/** Owns a JNI secret copy and clears it on every success/error return path. */
class SensitiveBytes final {
 public:
  SensitiveBytes() = default;
  ~SensitiveBytes() { secure_zero(&value_); }
  SensitiveBytes(const SensitiveBytes &) = delete;
  SensitiveBytes &operator=(const SensitiveBytes &) = delete;

  std::vector<uint8_t> *out() { return &value_; }
  const std::vector<uint8_t> &value() const { return value_; }

 private:
  std::vector<uint8_t> value_;
};

bool take_wallet_secret(JNIEnv *env, jbyteArray source,
                        std::vector<uint8_t> *out) {
  if (source == nullptr) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Wallet secret must not be null");
    return false;
  }
  const jsize length = env->GetArrayLength(source);
  if (env->ExceptionCheck()) return false;
  if (length < 0 || length > kMaxWalletSecretBytes) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Wallet secret exceeds 1024 UTF-8 bytes");
    return false;
  }
  out->resize(static_cast<size_t>(length));
  if (length != 0) {
    env->GetByteArrayRegion(source, 0, length,
                            reinterpret_cast<jbyte *>(out->data()));
  }
  return !env->ExceptionCheck();
}

template <typename Info>
Info info_value() {
  Info value{};
  value.struct_size = sizeof(Info);
  value.abi_version = CITIZENSDK_ABI_VERSION;
  return value;
}

bool copy_error(citizensdk_result_handle_t result,
                std::vector<uint8_t> *message) {
  uint64_t required = 0;
  int32_t code = citizensdk_result_copy_error_message(result, nullptr, 0,
                                                       &required);
  if (code != kOk || required > 64 * 1024) return false;
  message->resize(static_cast<size_t>(required));
  return citizensdk_result_copy_error_message(
             result, message->empty() ? nullptr : message->data(), required,
             &required) == kOk;
}

bool copy_wallet_account(citizensdk_result_handle_t result, uint32_t index,
                         citizensdk_wallet_account_info_t *info,
                         std::vector<uint8_t> *ss58,
                         std::vector<uint8_t> *name) {
  uint64_t ss58_required = 0;
  uint64_t name_required = 0;
  *info = info_value<citizensdk_wallet_account_info_t>();
  int32_t code = citizensdk_result_get_wallet_account(
      result, index, info, nullptr, 0, &ss58_required, nullptr, 0,
      &name_required);
  if (code != kOk || ss58_required > 1024 || name_required > 1024) return false;
  ss58->resize(static_cast<size_t>(ss58_required));
  name->resize(static_cast<size_t>(name_required));
  *info = info_value<citizensdk_wallet_account_info_t>();
  return citizensdk_result_get_wallet_account(
             result, index, info, ss58->empty() ? nullptr : ss58->data(),
             ss58_required, &ss58_required,
             name->empty() ? nullptr : name->data(), name_required,
             &name_required) == kOk;
}

bool write_wallet_account(citizensdk_result_handle_t result, uint32_t index,
                          WireWriter *payload) {
  citizensdk_wallet_account_info_t account{};
  std::vector<uint8_t> ss58;
  std::vector<uint8_t> name;
  if (!copy_wallet_account(result, index, &account, &ss58, &name)) return false;
  payload->u32(account.index);
  payload->fixed(account.account_id.bytes, 32);
  payload->text(ss58);
  payload->u8(name.empty() ? 0 : 1);
  if (!name.empty()) payload->text(name);
  payload->u64(account.created_at_millis);
  payload->u8(account.is_active == 0 ? 0 : 1);
  return true;
}

// 名称从同一Core结果有界复制，不能拿账户0标签替代钱包名称。
bool write_wallet_name(citizensdk_result_handle_t result, WireWriter *payload) {
  uint64_t required = 0;
  if (citizensdk_wallet_profile_copy_name(result, nullptr, 0, &required) != kOk || required == 0 || required > 120) return false;
  std::vector<uint8_t> name(static_cast<size_t>(required));
  const auto capacity = required;
  if (citizensdk_wallet_profile_copy_name(result, name.data(), capacity, &required) != kOk || required != capacity) return false;
  payload->text(name);
  return true;
}

bool write_wallet_profile(citizensdk_result_handle_t result,
                          WireWriter *payload) {
  auto info = info_value<citizensdk_wallet_profile_info_t>();
  if (citizensdk_result_get_wallet_profile(result, &info) != kOk) return false;
  payload->u8(info.present == 0 ? 0 : 1);
  if (info.present == 0) return true;
  uint32_t count = 0;
  if (citizensdk_result_get_wallet_account_count(result, &count) != kOk ||
      count != info.account_count || count > kMaxWalletAccounts) {
    return false;
  }
  payload->u32(info.origin);
  payload->u32(info.wallet_index);
  payload->u64(info.created_at_millis);
  payload->fixed(info.master_account_id.bytes, 32);
  payload->fixed(info.active_account_id.bytes, 32);
  payload->u32(count);
  for (uint32_t index = 0; index < count; ++index) {
    if (!write_wallet_account(result, index, payload)) return false;
  }
  return write_wallet_name(result, payload);
}

bool write_wallet_accounts(citizensdk_result_handle_t result,
                           WireWriter *payload) {
  uint32_t count = 0;
  if (citizensdk_result_get_wallet_account_count(result, &count) != kOk ||
      count > kMaxWalletAccounts) {
    return false;
  }
  payload->u32(count);
  for (uint32_t index = 0; index < count; ++index) {
    if (!write_wallet_account(result, index, payload)) return false;
  }
  return true;
}

bool write_wallet_state(citizensdk_result_handle_t result,
                        WireWriter *payload) {
  auto state = info_value<citizensdk_wallet_state_info_t>();
  auto profile = info_value<citizensdk_wallet_profile_info_t>();
  if (citizensdk_result_get_wallet_state(result, &state) != kOk ||
      citizensdk_result_get_wallet_profile(result, &profile) != kOk ||
      state.account_count > kMaxCatalogAccounts || profile.account_count > kMaxWalletAccounts ||
      profile.present > 1 || state.has_default_account > 1 ||
      ((state.account_count == 0) != (state.has_default_account == 0)) ||
      (profile.present != 0 &&
       (profile.wallet_index != 0 ||
        (profile.origin != CITIZENSDK_WALLET_ORIGIN_CREATED &&
         profile.origin != CITIZENSDK_WALLET_ORIGIN_IMPORTED)))) {
    return false;
  }
  payload->u64(state.revision);
  payload->u8(profile.present == 0 ? 0 : 1);
  if (profile.present != 0) {
    payload->u32(profile.origin);
    payload->u32(profile.wallet_index);
    payload->u64(profile.created_at_millis);
    payload->fixed(profile.master_account_id.bytes, 32);
    payload->fixed(profile.active_account_id.bytes, 32);
    payload->u32(profile.account_count);
    if (!write_wallet_name(result, payload)) return false;
  }
  payload->u32(state.account_count);
  for (uint32_t index = 0; index < state.account_count; ++index) {
    auto account = info_value<citizensdk_wallet_state_account_info_t>();
    uint64_t ss58_required = 0;
    uint64_t name_required = 0;
    int32_t code = citizensdk_result_get_wallet_state_account(
        result, index, &account, nullptr, 0, &ss58_required, nullptr, 0,
        &name_required);
    if (code != kOk || ss58_required > 1024 || name_required > 1024 ||
        account.has_account_index > 1 || account.is_default > 1 ||
        account.is_default != (index == 0 ? 1U : 0U) ||
        (index == 0 && state.has_default_account != 0 &&
         std::memcmp(account.account_id.bytes, state.default_account_id.bytes, 32) != 0) ||
        !((account.sign_mode == CITIZENSDK_WALLET_SIGN_HOT &&
           account.wallet_index == 0 && account.has_account_index == 1) ||
          (account.sign_mode == CITIZENSDK_WALLET_SIGN_COLD &&
           account.wallet_index > 0 && account.has_account_index == 0))) return false;
    std::vector<uint8_t> ss58(static_cast<size_t>(ss58_required));
    std::vector<uint8_t> name(static_cast<size_t>(name_required));
    account = info_value<citizensdk_wallet_state_account_info_t>();
    code = citizensdk_result_get_wallet_state_account(
        result, index, &account, ss58.empty() ? nullptr : ss58.data(),
        ss58_required, &ss58_required, name.empty() ? nullptr : name.data(),
        name_required, &name_required);
    if (code != kOk || account.has_account_index > 1 || account.is_default > 1 ||
        account.is_default != (index == 0 ? 1U : 0U)) return false;
    payload->u32(account.sign_mode);
    payload->u32(account.wallet_index);
    payload->u8(account.has_account_index == 0 ? 0 : 1);
    if (account.has_account_index != 0) payload->u32(account.account_index);
    payload->fixed(account.account_id.bytes, 32);
    payload->text(ss58);
    payload->text(name);
    payload->u64(account.created_at_millis);
    payload->u8(account.is_default == 0 ? 0 : 1);
  }
  uint32_t diagnostic_count = 0;
  if (citizensdk_wallet_state_get_diagnostic_count(result, &diagnostic_count) != kOk || diagnostic_count > 1991) return false;
  uint32_t initialization = 0;
  uint8_t cleanup = 0;
  if (citizensdk_wallet_state_get_initialization(result, &initialization, &cleanup) != kOk ||
      initialization > 2 || cleanup > 1 ||
      ((initialization == 1) != (state.account_count != 0 || diagnostic_count != 0)) || (initialization == 0 && cleanup != 0)) return false;
  payload->u32(initialization);
  payload->u8(cleanup);
  uint8_t present = 0;
  uint32_t wallet_index = 0;
  if (citizensdk_wallet_state_get_active_wallet(result, &present, &wallet_index) != kOk || present > 1) return false;
  payload->u8(present);
  if (present != 0) payload->u32(wallet_index);
  payload->u32(diagnostic_count);
  for (uint32_t index = 0; index < diagnostic_count; ++index) {
    auto info = info_value<citizensdk_wallet_diagnostic_info_v1_t>();
    if (citizensdk_wallet_state_get_diagnostic_at(result, index, &info) != kOk ||
        info.has_ss58_address > 1 || info.sign_mode > 2 || info.diagnostic_reason < 1 || info.diagnostic_reason > 3 ||
        info.cleanup_account_count > kMaxWalletAccounts || info.delete_wallet_wide_key > 1 ||
        (info.cleanup_account_count == 0 && info.delete_wallet_wide_key != 0) ||
        info.wallet_name_len == 0 || info.wallet_name_len > 120 || info.ss58_address_len > 128 ||
        (info.has_ss58_address == 0 && info.ss58_address_len != 0)) return false;
    auto text = [&](uint32_t field, uint64_t required) {
      std::vector<uint8_t> bytes(static_cast<size_t>(required));
      uint64_t confirmed = required;
      if (citizensdk_wallet_state_copy_diagnostic_text(result, index, field,
          bytes.empty() ? nullptr : bytes.data(), required, &confirmed) != kOk || confirmed != required) return false;
      payload->text(bytes); return true;
    };
    payload->u32(info.wallet_index);
    if (!text(1, info.wallet_name_len)) return false;
    payload->fixed(info.account_id.bytes, 32);
    payload->u8(info.has_ss58_address != 0 ? 1 : 0);
    if (info.has_ss58_address != 0 && !text(2, info.ss58_address_len)) return false;
    payload->u32(info.diagnostic_reason);
    payload->u32(info.sign_mode);
    payload->u32(info.cleanup_account_count);
    payload->u8(info.delete_wallet_wide_key != 0 ? 1 : 0);
    for (uint32_t account_index = 0; account_index < info.cleanup_account_count; ++account_index) {
      citizensdk_account_id_t account{};
      if (citizensdk_wallet_state_get_diagnostic_cleanup_account(result, index, account_index, &account) != kOk) return false;
      payload->fixed(account.bytes, 32);
    }
  }
  return true;
}

bool write_signing_outcome(citizensdk_result_handle_t result,
                           WireWriter *payload) {
  auto info = info_value<citizensdk_signing_outcome_info_t>();
  uint64_t signature_required = 0, session_required = 0, request_required = 0;
  int32_t code = citizensdk_result_get_signing_outcome(
      result, &info, nullptr, 0, &signature_required, nullptr, 0,
      &session_required, nullptr, 0, &request_required);
  if (code != kOk || signature_required > 64 || session_required > 128 ||
      request_required > kMaxQrTextBytes) return false;
  std::vector<uint8_t> signature(static_cast<size_t>(signature_required));
  std::vector<uint8_t> session(static_cast<size_t>(session_required));
  std::vector<uint8_t> request(static_cast<size_t>(request_required));
  info = info_value<citizensdk_signing_outcome_info_t>();
  code = citizensdk_result_get_signing_outcome(
      result, &info, signature.empty() ? nullptr : signature.data(),
      signature.size(), &signature_required,
      session.empty() ? nullptr : session.data(), session.size(),
      &session_required, request.empty() ? nullptr : request.data(),
      request.size(), &request_required);
  if (code != kOk || (info.status == CITIZENSDK_SIGNING_COMPLETED &&
      (signature.size() != 64 || !session.empty() || !request.empty())) ||
      (info.status == CITIZENSDK_SIGNING_EXTERNAL_PENDING &&
      (!signature.empty() || session.size() < 16 || request.empty() ||
       info.transport != CITIZENSDK_EXTERNAL_SIGNER_QR_V1))) return false;
  payload->u32(info.status);
  payload->fixed(info.account_id.bytes, 32);
  payload->fixed(info.payload_hash, 32);
  if (info.status == CITIZENSDK_SIGNING_COMPLETED) {
    payload->fixed(signature.data(), signature.size());
  } else if (info.status == CITIZENSDK_SIGNING_EXTERNAL_PENDING) {
    payload->u64(info.expires_at); payload->text(session); payload->text(request);
  } else return false;
  return true;
}

bool write_default_account_change(citizensdk_result_handle_t result,
                                  WireWriter *payload) {
  auto info = info_value<citizensdk_default_account_change_info_t>();
  uint64_t session_required = 0, request_required = 0;
  int32_t code = citizensdk_result_get_default_account_change(
      result, &info, nullptr, 0, &session_required, nullptr, 0,
      &request_required);
  if (code != kOk || session_required > 128 || request_required > kMaxQrTextBytes)
    return false;
  std::vector<uint8_t> session(static_cast<size_t>(session_required));
  std::vector<uint8_t> request(static_cast<size_t>(request_required));
  info = info_value<citizensdk_default_account_change_info_t>();
  code = citizensdk_result_get_default_account_change(
      result, &info, session.empty() ? nullptr : session.data(), session.size(),
      &session_required, request.empty() ? nullptr : request.data(), request.size(),
      &request_required);
  if (code != kOk || (info.status == CITIZENSDK_SIGNING_COMPLETED &&
      (!session.empty() || !request.empty() || info.committed_revision == 0)) ||
      (info.status == CITIZENSDK_SIGNING_EXTERNAL_PENDING &&
      (session.size() < 16 || request.empty() ||
       info.transport != CITIZENSDK_EXTERNAL_SIGNER_QR_V1))) return false;
  payload->u32(info.status);
  payload->fixed(info.current_default_account_id.bytes, 32);
  payload->fixed(info.payload_hash, 32);
  if (info.status == CITIZENSDK_SIGNING_COMPLETED) {
    payload->u64(info.committed_revision);
  } else if (info.status == CITIZENSDK_SIGNING_EXTERNAL_PENDING) {
    payload->u64(info.expires_at); payload->text(session); payload->text(request);
  } else return false;
  return true;
}

bool copy_transaction_history_record(citizensdk_result_handle_t result,
                                     uint32_t index, WireWriter *payload) {
  auto info = info_value<citizensdk_transaction_history_record_info_t>();
  uint64_t reason_required = 0;
  int32_t code = citizensdk_result_get_transaction_history_record(
      result, index, &info, nullptr, 0, &reason_required);
  if (code != kOk || reason_required > 512) return false;
  std::vector<uint8_t> reason(static_cast<size_t>(reason_required));
  info = info_value<citizensdk_transaction_history_record_info_t>();
  if (citizensdk_result_get_transaction_history_record(
          result, index, &info, reason.empty() ? nullptr : reason.data(),
          reason.size(), &reason_required) != kOk) return false;
  payload->fixed(info.execution_id.bytes, 16);
  payload->fixed(info.source_account_id.bytes, 32);
  payload->fixed(info.call_data_hash, 32);
  payload->fixed(info.transaction_hash, 32);
  payload->u32(info.status);
  payload->u8(info.has_block == 0 ? 0 : 1);
  if (info.has_block != 0) write_block(payload, info.block);
  payload->u8(info.has_execution == 0 ? 0 : 1);
  if (info.has_execution != 0) write_execution(payload, info.execution);
  payload->u8(info.has_replacement_hash == 0 ? 0 : 1);
  if (info.has_replacement_hash != 0) payload->fixed(info.replacement_hash, 32);
  payload->u64(info.created_at_millis);
  payload->u64(info.updated_at_millis);
  payload->u8(reason.empty() ? 0 : 1);
  if (!reason.empty()) payload->text(reason);
  return true;
}

bool write_transaction_history_page(citizensdk_result_handle_t result,
                                    WireWriter *payload) {
  auto info = info_value<citizensdk_transaction_history_page_info_t>();
  if (citizensdk_result_get_transaction_history_page(result, &info) != kOk ||
      info.record_count > 100) return false;
  payload->u64(info.revision);
  payload->u32(info.record_count);
  for (uint32_t index = 0; index < info.record_count; ++index) {
    if (!copy_transaction_history_record(result, index, payload)) return false;
  }
  payload->u8(info.has_next_before_execution_id == 0 ? 0 : 1);
  if (info.has_next_before_execution_id != 0) {
    payload->fixed(info.next_before_execution_id.bytes, 16);
  }
  return true;
}

void write_failure(WireWriter *writer, int32_t code, uint32_t stage, uint32_t kind,
                   const std::vector<uint8_t> &message) {
  writer->u32(kWireVersion);
  writer->i32(code);
  writer->u32(stage);
  writer->u32(kind);
  writer->text(message);
}

void write_internal_decode_failure(WireWriter *writer) {
  static const std::vector<uint8_t> message = {
      'J','N','I',' ','c','o','u','l','d',' ','n','o','t',' ','d','e','c','o','d','e',' ',
      't','h','e',' ','C','o','r','e',' ','r','e','s','u','l','t'};
  write_failure(writer, CITIZENSDK_ERROR_INTEGRITY,
                CITIZENSDK_FAILURE_STAGE_VERIFICATION, 0, message);
}

template <typename Call>
jlong begin_request(JNIEnv *env,
                    const std::shared_ptr<CitizenSdkHostBridge> &bridge,
                    Call call) {
  citizensdk_request_id_t request = 0;
  const int32_t code = call(bridge->handle(), &request);
  if (code != kOk || request == 0 ||
      request > static_cast<uint64_t>(std::numeric_limits<jlong>::max())) {
    if (code == kOk && request != 0) {
      // The Core accepted the work but its identity cannot cross the Java
      // boundary. Cancel that exact request instead of creating an orphan.
      citizensdk_cancel_request(bridge->handle(), request);
    }
    throw_sdk(env, code == kOk ? CITIZENSDK_ERROR_INTERNAL : code,
              "CitizenSDK request was rejected");
    return 0;
  }
  return static_cast<jlong>(request);
}

bool account(JNIEnv *env, jbyteArray source, citizensdk_account_id_t *out) {
  std::vector<uint8_t> bytes;
  if (!take_bytes(env, source, &bytes) || bytes.size() != 32) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "CitizenChain AccountId must contain 32 bytes");
    return false;
  }
  std::memcpy(out->bytes, bytes.data(), 32);
  return true;
}

bool block_ref(JNIEnv *env, jbyteArray hash, jlong number, jint finality,
               citizensdk_block_ref_t *out) {
  std::vector<uint8_t> bytes;
  if (!take_bytes(env, hash, &bytes) || bytes.size() != 32 ||
      (finality != CITIZENSDK_FINALITY_BEST &&
       finality != CITIZENSDK_FINALITY_FINALIZED)) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "CitizenChain block reference is invalid");
    return false;
  }
  *out = info_value<citizensdk_block_ref_t>();
  std::memcpy(out->hash, bytes.data(), 32);
  out->number = static_cast<uint64_t>(number);
  out->finality = static_cast<uint32_t>(finality);
  return true;
}

bool accounts(JNIEnv *env, jbyteArray source, jint count,
              std::vector<citizensdk_account_id_t> *out, bool allow_empty = false,
              jint maximum = 1990) {
  std::vector<uint8_t> bytes;
  if (count < 0 || (!allow_empty && count == 0) || count > maximum || !take_bytes(env, source, &bytes) ||
      bytes.size() != static_cast<size_t>(count) * 32) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "CitizenChain account array is invalid");
    return false;
  }
  out->resize(static_cast<size_t>(count));
  if (!bytes.empty()) std::memcpy(out->data(), bytes.data(), bytes.size());
  return true;
}

// JNI methods ----------------------------------------------------------------

jlong native_create(JNIEnv *env, jobject, jobject context, jobject host_services,
                    jbyteArray manifest, jbyteArray chain_spec,
                    jbyteArray sync_state, jint modules) {
  std::vector<uint8_t> manifest_bytes;
  std::vector<uint8_t> chain_bytes;
  std::vector<uint8_t> sync_bytes;
  if (context == nullptr || host_services == nullptr || !take_bytes(env, manifest, &manifest_bytes) ||
      !take_bytes(env, chain_spec, &chain_bytes) ||
      !take_bytes(env, sync_state, &sync_bytes)) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "CitizenSDK assets or host services are invalid");
    return 0;
  }
  // 链实例创建前完成 Android 系统证书验证器初始化；异常统一封闭成固定 SDK 错误。
  if ((static_cast<uint32_t>(modules) & CITIZENSDK_MODULE_CHAIN) != 0) {
    jclass verifier = env->FindClass("org/rustls/platformverifier/CertificateVerifier");
    if (verifier == nullptr) {
      if (env->ExceptionCheck()) env->ExceptionClear();
      throw_sdk(env, CITIZENSDK_ERROR_UNAVAILABLE,
                "Android TLS verifier component is missing");
      return 0;
    }
    env->DeleteLocalRef(verifier);
    if (citizensdk_android_init_tls(env, context) != CITIZENSDK_OK) {
      if (env->ExceptionCheck()) env->ExceptionClear();
      throw_sdk(env, CITIZENSDK_ERROR_UNAVAILABLE,
                "Android TLS verifier initialization failed");
      return 0;
    }
  }
  JavaVM *vm = nullptr;
  if (env->GetJavaVM(&vm) != JNI_OK) return 0;
  auto bridge = std::shared_ptr<CitizenSdkHostBridge>(
      new (std::nothrow) CitizenSdkHostBridge(vm, env, host_services));
  if (!bridge) {
    throw_sdk(env, CITIZENSDK_ERROR_INTERNAL, "CitizenSDK JNI allocation failed");
    return 0;
  }
  if (!bridge->create(env, manifest_bytes, chain_bytes, sync_bytes, static_cast<uint32_t>(modules))) {
    return 0;
  }
  {
    std::lock_guard<std::mutex> lock(g_bridges_mutex);
    g_bridges.emplace(reinterpret_cast<intptr_t>(bridge.get()), bridge);
  }
  return static_cast<jlong>(reinterpret_cast<intptr_t>(bridge.get()));
}

void native_bind(JNIEnv *env, jobject owner, jlong raw) {
  if (auto bridge = bridge_from(env, raw)) bridge->bind(env, owner);
}

jint native_lifecycle(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr) return 0;
  citizensdk_lifecycle_t lifecycle = 0;
  const int32_t code = citizensdk_get_lifecycle(bridge->handle(), &lifecycle);
  if (code != kOk) {
    throw_sdk(env, code, "CitizenSDK lifecycle query failed");
    return 0;
  }
  return static_cast<jint>(lifecycle);
}

jbyteArray native_capabilities(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr) return nullptr;
  WireWriter writer;
  if (!encode_capabilities(bridge->handle(), &writer)) {
    throw_sdk(env, CITIZENSDK_ERROR_INTERNAL,
              "CitizenSDK capability query failed");
    return nullptr;
  }
  return to_byte_array(env, writer.data());
}

jlong native_refresh_capabilities(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(
      env, bridge, [](auto handle, auto *out) {
        return citizensdk_refresh_capabilities(handle, out);
      });
}

void native_accept_request_sequence(JNIEnv *env, jobject, jlong raw, jlong sequence) {
  // 通道序号与原生请求ID独立，唯一顺序判断归Core；不复制接纳算法。
  auto bridge = bridge_from(env, raw);
  if (!bridge) return;
  const auto code = citizensdk_accept_request_sequence(bridge->handle(), static_cast<uint64_t>(sequence));
  if (code != kOk) throw_sdk(env, code, "CitizenSDK request sequence admission failed");
}

jlong native_start(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(
      env, bridge, [](auto handle, auto *out) { return citizensdk_start(handle, out); });
}

jlong native_stop(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(
      env, bridge, [](auto handle, auto *out) { return citizensdk_stop(handle, out); });
}

jboolean native_cancel(JNIEnv *env, jobject, jlong raw, jlong request_id) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr || request_id <= 0) return JNI_FALSE;
  const int32_t code = citizensdk_cancel_request(
      bridge->handle(), static_cast<uint64_t>(request_id));
  if (code == kOk) return JNI_TRUE;
  if (code == CITIZENSDK_ERROR_NOT_FOUND || code == CITIZENSDK_ERROR_INVALID_STATE)
    return JNI_FALSE;
  throw_sdk(env, code, "CitizenSDK request cannot be cancelled");
  return JNI_FALSE;
}

jlong native_finalized_head(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(
      env, bridge, [](auto handle, auto *out) { return citizensdk_get_finalized_head(handle, out); });
}

jlong native_sync_status(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(
      env, bridge, [](auto handle, auto *out) { return citizensdk_get_sync_status(handle, out); });
}

jlong native_best_head(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(
      env, bridge, [](auto handle, auto *out) { return citizensdk_get_best_head(handle, out); });
}

jlong native_finalized_block_at(JNIEnv *env, jobject, jlong raw, jlong number) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [number](auto handle, auto *out) {
    return citizensdk_get_finalized_block_at(handle, static_cast<uint64_t>(number), out);
  });
}

jlong native_resolve_finalized_block(JNIEnv *env, jobject, jlong raw,
                                     jbyteArray hash, jlong number) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> bytes;
  if (bridge == nullptr || !take_bytes(env, hash, &bytes) || bytes.size() != 32) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "block hash must contain 32 bytes");
    return 0;
  }
  return begin_request(env, bridge, [&bytes, number](auto handle, auto *out) {
    return citizensdk_resolve_finalized_block(handle, bytes.data(), static_cast<uint64_t>(number), out);
  });
}

template <typename Call>
jlong native_block_request(JNIEnv *env, jlong raw, jbyteArray hash, jlong number,
                           jint finality, Call call) {
  auto bridge = bridge_from(env, raw);
  citizensdk_block_ref_t block{};
  if (bridge == nullptr || !block_ref(env, hash, number, finality, &block)) return 0;
  return begin_request(env, bridge, [&block, &call](auto handle, auto *out) {
    return call(handle, &block, out);
  });
}

jlong native_block_header(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                          jlong number, jint finality) {
  return native_block_request(env, raw, hash, number, finality,
      [](auto handle, auto *block, auto *out) { return citizensdk_get_block_header_at(handle, block, out); });
}

jlong native_block_body(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                        jlong number, jint finality) {
  return native_block_request(env, raw, hash, number, finality,
      [](auto handle, auto *block, auto *out) { return citizensdk_get_block_body_at(handle, block, out); });
}

jlong native_runtime_context(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                             jlong number, jint finality) {
  return native_block_request(env, raw, hash, number, finality,
      [](auto handle, auto *block, auto *out) { return citizensdk_get_runtime_context_at(handle, block, out); });
}

jlong native_system_events(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                           jlong number, jint finality) {
  return native_block_request(env, raw, hash, number, finality,
      [](auto handle, auto *block, auto *out) { return citizensdk_get_system_events_at(handle, block, out); });
}

jlong native_storage(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                     jlong number, jint finality, jbyteArray key) {
  auto bridge = bridge_from(env, raw);
  citizensdk_block_ref_t block{};
  std::vector<uint8_t> bytes;
  if (bridge == nullptr || !block_ref(env, hash, number, finality, &block) ||
      !take_bytes(env, key, &bytes) || bytes.empty() || bytes.size() > 4096) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "storage key is invalid");
    return 0;
  }
  return begin_request(env, bridge, [&block, &bytes](auto handle, auto *out) {
    return citizensdk_get_storage_at(handle, &block, view(bytes), out);
  });
}

jlong native_storage_batch(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                           jlong number, jint finality, jobjectArray keys) {
  auto bridge = bridge_from(env, raw);
  citizensdk_block_ref_t block{};
  if (bridge == nullptr || !block_ref(env, hash, number, finality, &block) || keys == nullptr) return 0;
  const jsize count = env->GetArrayLength(keys);
  if (env->ExceptionCheck() || count <= 0 || count > 1024) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "storage key batch is invalid");
    return 0;
  }
  std::vector<std::vector<uint8_t>> owned(static_cast<size_t>(count));
  size_t total = 0;
  for (jsize index = 0; index < count; ++index) {
    auto item = static_cast<jbyteArray>(env->GetObjectArrayElement(keys, index));
    const bool copied = item != nullptr && take_bytes(env, item, &owned[static_cast<size_t>(index)]);
    if (item != nullptr) env->DeleteLocalRef(item);
    const size_t length = owned[static_cast<size_t>(index)].size();
    if (!copied || length == 0 || length > 4096 || total > 1024U * 1024U - length) {
      if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "storage key batch is invalid");
      return 0;
    }
    total += length;
  }
  std::vector<citizensdk_bytes_view_t> views;
  views.reserve(owned.size());
  for (const auto &item : owned) views.push_back(view(item));
  return begin_request(env, bridge, [&block, &views](auto handle, auto *out) {
    return citizensdk_get_storage_batch_at(
        handle, &block, views.data(), static_cast<uint32_t>(views.size()), out);
  });
}

jlong native_storage_keys_paged(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                                 jlong number, jint finality, jbyteArray prefix,
                                 jbyteArray start_key, jint limit) {
  auto bridge = bridge_from(env, raw);
  citizensdk_block_ref_t block{};
  std::vector<uint8_t> prefix_bytes;
  std::vector<uint8_t> start_bytes;
  if (bridge == nullptr || !block_ref(env, hash, number, finality, &block) ||
      !take_bytes(env, prefix, &prefix_bytes) || prefix_bytes.empty() ||
      prefix_bytes.size() > 4096 || limit <= 0 || limit > 1000 ||
      (start_key != nullptr && (!take_bytes(env, start_key, &start_bytes) ||
                                start_bytes.empty() || start_bytes.size() > 4096))) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
                                         "storage keys page request is invalid");
    return 0;
  }
  return begin_request(env, bridge, [&block, &prefix_bytes, &start_bytes, start_key, limit](auto handle, auto *out) {
    return citizensdk_get_storage_keys_paged(
        handle, &block, view(prefix_bytes), start_key == nullptr ? 0 : 1,
        view(start_bytes), static_cast<uint32_t>(limit), out);
  });
}

jlong native_runtime_api(JNIEnv *env, jobject, jlong raw, jbyteArray hash,
                         jlong number, jint finality, jbyteArray method,
                         jbyteArray arguments) {
  auto bridge = bridge_from(env, raw);
  citizensdk_block_ref_t block{};
  std::vector<uint8_t> method_bytes;
  std::vector<uint8_t> argument_bytes;
  if (bridge == nullptr || !block_ref(env, hash, number, finality, &block) ||
      !take_bytes(env, method, &method_bytes) || method_bytes.empty() ||
      method_bytes.size() > 128 || !take_bytes(env, arguments, &argument_bytes) ||
      argument_bytes.size() > 1024U * 1024U) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
                                         "runtime API request is invalid");
    return 0;
  }
  return begin_request(env, bridge, [&block, &method_bytes, &argument_bytes](auto handle, auto *out) {
    return citizensdk_call_runtime_api(
        handle, &block, view(method_bytes), view(argument_bytes), out);
  });
}

jlong native_export_state(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(
      env, bridge, [](auto handle, auto *out) { return citizensdk_export_state(handle, out); });
}

jlong native_import_state(JNIEnv *env, jobject, jlong raw, jint format_version,
                          jbyteArray hash, jlong number, jint finality,
                          jbyteArray database) {
  auto bridge = bridge_from(env, raw);
  citizensdk_block_ref_t block{};
  std::vector<uint8_t> bytes;
  if (bridge == nullptr || !block_ref(env, hash, number, finality, &block) ||
      block.finality != CITIZENSDK_FINALITY_FINALIZED ||
      !take_bytes(env, database, &bytes) || bytes.empty() || bytes.size() > 256U * 1024U) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "chain state is invalid");
    return 0;
  }
  return begin_request(env, bridge, [&block, &bytes, format_version](auto handle, auto *out) {
    return citizensdk_import_state(
        handle, &block, static_cast<uint32_t>(format_version), view(bytes), out);
  });
}

jbyteArray native_genesis_hash(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr) return nullptr;
  std::vector<uint8_t> output(32);
  const int32_t code = citizensdk_get_genesis_hash(bridge->handle(), output.data());
  if (code != kOk) {
    throw_sdk(env, code, "CitizenSDK genesis hash query failed");
    return nullptr;
  }
  return to_byte_array(env, output);
}

jlong native_balance(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  if (bridge == nullptr || !account(env, account_bytes, &value)) return 0;
  return begin_request(env, bridge, [&value](auto handle, auto *out) {
    return citizensdk_get_finalized_account_balance(handle, &value, out);
  });
}

jlong native_balances(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes, jint count) {
  auto bridge = bridge_from(env, raw);
  std::vector<citizensdk_account_id_t> values;
  if (bridge == nullptr || !accounts(env, account_bytes, count, &values, true)) return 0;
  // 空列表也提交 Core，让模块与生命周期校验沿同一入口执行。
  return begin_request(env, bridge, [&values](auto handle, auto *out) {
    return citizensdk_get_finalized_account_balances(
        handle, values.data(), static_cast<uint32_t>(values.size()), out);
  });
}

jlong native_nonce(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  if (bridge == nullptr || !account(env, account_bytes, &value)) return 0;
  return begin_request(env, bridge, [&value](auto handle, auto *out) {
    return citizensdk_get_account_nonce(handle, &value, out);
  });
}

jlong native_fee(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [](auto handle, auto *out) {
    return citizensdk_get_best_fee_snapshot(handle, out);
  });
}

jlong native_wallet_profile(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [](auto handle, auto *out) {
    return citizensdk_get_wallet_profile(handle, out);
  });
}

jlong native_wallet_state(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [](auto handle, auto *out) {
    return citizensdk_get_wallet_state(handle, out);
  });
}

jlong native_inspect_wallets(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [&](auto, auto *out) {
    return bridge->inspect_wallets(out);
  });
}

void native_release_wallet_inspection(JNIEnv *env, jobject, jlong raw, jlong token) {
  auto bridge = bridge_from(env, raw);
  if (!bridge) return;
  const auto code = token > 0 ? bridge->release_wallet_inspection(static_cast<uint64_t>(token)) : CITIZENSDK_ERROR_INVALID_HANDLE;
  if (code != kOk) throw_sdk(env, code, "钱包检查资源释放失败");
}

jlong native_change_diagnostic(JNIEnv *env, jobject, jlong raw, jlong token, jlong index, jint action, jbyteArray name_bytes) {
  auto bridge = bridge_from(env, raw);
  if (!bridge) return 0;
  if (token <= 0 || index < 0 || static_cast<uint64_t>(index) > UINT32_MAX ||
      action < 1 || action > 3 || !bridge->has_wallet_inspection(static_cast<uint64_t>(token))) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "钱包检查引用或目标无效"); return 0;
  }
  std::vector<uint8_t> name;
  if (action == 2 && (name_bytes == nullptr || env->GetArrayLength(name_bytes) > 120 || !take_bytes(env, name_bytes, &name))) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "钱包名称无效");
    return 0;
  }
  return begin_request(env, bridge, [&](auto handle, auto *out) {
    if (action == 1) return citizensdk_repair_hot_wallet(handle, token, static_cast<uint32_t>(index), out);
    if (action == 2) return citizensdk_rename_diagnostic_wallet(handle, token, static_cast<uint32_t>(index), view(name), out);
    return citizensdk_delete_diagnostic_wallet(handle, token, static_cast<uint32_t>(index), out);
  });
}

jlong native_import_cold_id(JNIEnv *env, jobject, jlong raw,
                            jbyteArray account_bytes, jbyteArray name_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  std::vector<uint8_t> name;
  if (bridge == nullptr || !account(env, account_bytes, &value) ||
      !take_bytes(env, name_bytes, &name)) return 0;
  return begin_request(env, bridge, [&value, &name](auto handle, auto *out) {
    return citizensdk_import_cold_account_id(handle, &value, view(name), out);
  });
}

jlong native_import_cold_ss58(JNIEnv *env, jobject, jlong raw,
                              jbyteArray address_bytes, jbyteArray name_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> address;
  std::vector<uint8_t> name;
  if (bridge == nullptr || !take_bytes(env, address_bytes, &address) ||
      !take_bytes(env, name_bytes, &name)) return 0;
  return begin_request(env, bridge, [&address, &name](auto handle, auto *out) {
    return citizensdk_import_cold_account_ss58(handle, view(address), view(name), out);
  });
}

jlong native_reorder_wallet(JNIEnv *env, jobject, jlong raw, jlong revision,
                            jbyteArray account_bytes, jint count) {
  auto bridge = bridge_from(env, raw);
  std::vector<citizensdk_account_id_t> values;
  if (bridge == nullptr || !accounts(env, account_bytes, count, &values, false, kMaxCatalogAccounts)) return 0;
  return begin_request(env, bridge, [&values, revision](auto handle, auto *out) {
    return citizensdk_reorder_wallet_accounts_without_default_change(
        handle, static_cast<uint64_t>(revision), values.data(),
        static_cast<uint32_t>(values.size()), out);
  });
}

jlong native_select_wallet(JNIEnv *env, jobject, jlong raw, jlong revision, jlong index) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr) return 0;
  if (index < 0 || static_cast<uint64_t>(index) > UINT32_MAX) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Wallet index exceeds u32"); return 0;
  }
  return begin_request(env, bridge, [revision, index](auto handle, auto *out) {
    return citizensdk_set_active_wallet(handle, static_cast<uint64_t>(revision), static_cast<uint32_t>(index), out);
  });
}

jlong native_rename_wallet(JNIEnv *env, jobject, jlong raw, jlong revision, jlong index, jbyteArray bytes) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr) return 0;
  if (index < 0 || static_cast<uint64_t>(index) > UINT32_MAX) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Wallet index exceeds u32"); return 0;
  }
  std::vector<uint8_t> name;
  if (!take_bytes(env, bytes, &name)) return 0;
  return begin_request(env, bridge, [revision, index, &name](auto handle, auto *out) {
    return citizensdk_rename_wallet(handle, static_cast<uint64_t>(revision), static_cast<uint32_t>(index), view(name), out);
  });
}

jlong native_rename_any(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes,
                        jbyteArray name_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  std::vector<uint8_t> name;
  if (bridge == nullptr || !account(env, account_bytes, &value) ||
      !take_bytes(env, name_bytes, &name)) return 0;
  return begin_request(env, bridge, [&value, &name](auto handle, auto *out) {
    return citizensdk_rename_account(handle, &value, view(name), out);
  });
}

jlong native_delete_any(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  if (bridge == nullptr || !account(env, account_bytes, &value)) return 0;
  return begin_request(env, bridge, [&value](auto handle, auto *out) {
    return citizensdk_delete_account(handle, &value, out);
  });
}

jlongArray native_open_private_key_view(JNIEnv *env, jobject, jlong raw,
                                       jbyteArray account_bytes, jobject owner) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  if (!bridge || owner == nullptr || !account(env, account_bytes, &value)) return nullptr;
  auto output = env->NewLongArray(3);
  if (output == nullptr) return nullptr;
  auto type = env->GetObjectClass(owner);
  auto display = env->GetMethodID(type, "receive", "(JLjava/nio/ByteBuffer;)I");
  auto settled = env->GetMethodID(type, "settled", "(JI)V");
  auto authorizing = env->GetMethodID(type, "authorizing", "(JJ)I");
  env->DeleteLocalRef(type);
  if (env->ExceptionCheck()) return nullptr;
  auto context = std::unique_ptr<PrivateKeyViewContext>(new (std::nothrow) PrivateKeyViewContext{
      bridge->vm(), env->NewGlobalRef(owner), display, settled, authorizing});
  if (!context || context->owner == nullptr) return nullptr;
  citizensdk_private_key_receiver_v1_t view{};
  view.struct_size = sizeof(view); view.abi_version = 1; view.context = context.get();
  view.receive = private_key_display; view.settled = private_key_settled;
  view.authorizing = private_key_authorizing;
  uint64_t view_id = 0;
  citizensdk_request_id_t request_id = 0;
  const int32_t code = citizensdk_private_key_open(
      bridge->handle(), &value, &view, &view_id, &request_id);
  if (code != CITIZENSDK_OK) {
    env->DeleteGlobalRef(context->owner);
    throw_sdk(env, code, "Private key view admission failed");
    return nullptr;
  }
  const jlong identities[] = {static_cast<jlong>(request_id), static_cast<jlong>(view_id),
      static_cast<jlong>(reinterpret_cast<intptr_t>(context.release()))};
  env->SetLongArrayRegion(output, 0, 3, identities);
  return output;
}

void native_reveal_private_key_view(JNIEnv *env, jobject, jlong raw, jlong view_id) {
  auto bridge = bridge_from(env, raw);
  if (!bridge) return;
  const int32_t code = citizensdk_private_key_reveal(bridge->handle(), view_id);
  if (code != CITIZENSDK_OK) throw_sdk(env, code, "Private key view reveal failed");
}
void native_cancel_private_key_view(JNIEnv *env, jobject, jlong raw, jlong view_id) {
  auto bridge = bridge_from(env, raw);
  if (!bridge) return;
  const int32_t code = citizensdk_private_key_cancel(bridge->handle(), view_id);
  if (code != CITIZENSDK_OK) throw_sdk(env, code, "Private key view cancellation failed");
}
void native_finish_private_key_view(JNIEnv *env, jobject, jlong raw, jlong view_id) {
  auto bridge = bridge_from(env, raw);
  if (!bridge) return;
  const int32_t code = citizensdk_private_key_finish(bridge->handle(), view_id);
  if (code != CITIZENSDK_OK) throw_sdk(env, code, "Private key view finish failed");
}
void native_release_private_key_view_context(JNIEnv *env, jobject, jlong raw) {
  auto context = std::unique_ptr<PrivateKeyViewContext>(reinterpret_cast<PrivateKeyViewContext *>(raw));
  if (context) env->DeleteGlobalRef(context->owner);
}

jlong native_set_active(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  if (bridge == nullptr || !account(env, account_bytes, &value)) return 0;
  return begin_request(env, bridge, [&value](auto handle, auto *out) {
    return citizensdk_set_active_wallet_account(handle, &value, out);
  });
}

jlong native_rename(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes,
                    jbyteArray name_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  std::vector<uint8_t> name;
  if (bridge == nullptr || !account(env, account_bytes, &value) ||
      !take_bytes(env, name_bytes, &name)) return 0;
  return begin_request(env, bridge, [&value, &name](auto handle, auto *out) {
    return citizensdk_rename_wallet_account(handle, &value, view(name), out);
  });
}

jlong native_delete_account(JNIEnv *env, jobject, jlong raw,
                            jbyteArray account_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  if (bridge == nullptr || !account(env, account_bytes, &value)) return 0;
  return begin_request(env, bridge, [&value](auto handle, auto *out) {
    return citizensdk_delete_wallet_account(handle, &value, out);
  });
}

jlong native_delete_wallet(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [](auto handle, auto *out) {
    return citizensdk_delete_wallet(handle, out);
  });
}

// 普通清除与用户主动“签名并删除”共用 Core 清理，仅后者要求真实授权签名。
jlong native_sign_and_delete_wallet(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [](auto handle, auto *out) {
    return citizensdk_sign_and_delete_wallet(handle, out);
  });
}

jlong native_reconcile(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  return bridge == nullptr ? 0 : begin_request(env, bridge, [](auto handle, auto *out) {
    return citizensdk_reconcile_wallet_cleanup(handle, out);
  });
}

jlong native_sign(JNIEnv *env, jobject, jlong raw, jbyteArray account_bytes,
                  jbyteArray message_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t value{};
  std::vector<uint8_t> message;
  if (message_bytes == nullptr ||
      env->GetArrayLength(message_bytes) > 16 * 1024 * 1024) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Sign payload exceeds 16 MiB");
    return 0;
  }
  if (bridge == nullptr || !account(env, account_bytes, &value) ||
      !take_bytes(env, message_bytes, &message)) return 0;
  return begin_request(env, bridge, [&value, &message](auto handle, auto *out) {
    return citizensdk_sign_wallet_payload(handle, &value, view(message), out);
  });
}

// Generic signing deliberately treats payload/domain/action as application-owned
// opaque values. Core alone selects hot Vault signing or a cold external session.
jlong native_begin_signing(JNIEnv *env, jobject, jlong raw,
                           jbyteArray account_bytes, jbyteArray payload_bytes,
                           jint transform, jbyteArray domain_bytes,
                           jint transport, jint action, jlong ttl_seconds) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t account_id{};
  std::vector<uint8_t> payload;
  std::vector<uint8_t> domain;
  if (payload_bytes == nullptr ||
      env->GetArrayLength(payload_bytes) > 16 * 1024 * 1024 ||
      domain_bytes == nullptr || env->GetArrayLength(domain_bytes) > 32 ||
      action < 0 || action > 0xffff || ttl_seconds < 0) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Generic signing input is invalid");
    return 0;
  }
  if (bridge == nullptr || !account(env, account_bytes, &account_id) ||
      !take_bytes(env, payload_bytes, &payload) ||
      !take_bytes(env, domain_bytes, &domain)) return 0;
  return begin_request(env, bridge,
      [&account_id, &payload, transform, &domain, transport, action,
       ttl_seconds](auto handle, auto *out) {
        return citizensdk_begin_signing(
            handle, &account_id, view(payload),
            static_cast<citizensdk_signing_transform_t>(transform), view(domain),
            static_cast<citizensdk_external_signer_transport_t>(transport),
            static_cast<uint16_t>(action), static_cast<uint64_t>(ttl_seconds), out);
      });
}

jlong native_consume_external_signature(JNIEnv *env, jobject, jlong raw,
                                        jbyteArray session_bytes,
                                        jbyteArray response_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> session;
  std::vector<uint8_t> response;
  if (bridge == nullptr || !take_bytes(env, session_bytes, &session) ||
      !take_bytes(env, response_bytes, &response)) return 0;
  return begin_request(env, bridge, [&session, &response](auto handle, auto *out) {
    return citizensdk_consume_external_signature(handle, view(session),
                                                  view(response), out);
  });
}

jboolean native_cancel_signing_session(JNIEnv *env, jobject, jlong raw,
                                       jbyteArray session_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> session;
  if (bridge == nullptr || !take_bytes(env, session_bytes, &session)) return JNI_FALSE;
  uint8_t cancelled = 0;
  const int32_t code = citizensdk_cancel_signing_session(
      bridge->handle(), view(session), &cancelled);
  if (code != kOk || cancelled > 1) {
    throw_sdk(env, code == kOk ? CITIZENSDK_ERROR_INTEGRITY : code,
              "Generic signing session cancellation failed");
    return JNI_FALSE;
  }
  return cancelled == 0 ? JNI_FALSE : JNI_TRUE;
}

jlong native_begin_default_account_change(JNIEnv *env, jobject, jlong raw,
                                          jlong expected_revision,
                                          jbyteArray account_bytes, jint count,
                                          jlong ttl_seconds) {
  auto bridge = bridge_from(env, raw);
  std::vector<citizensdk_account_id_t> values;
  if (ttl_seconds < 0 || bridge == nullptr ||
      !accounts(env, account_bytes, count, &values, false, 256)) return 0;
  return begin_request(env, bridge,
      [expected_revision, &values, ttl_seconds](auto handle, auto *out) {
        return citizensdk_begin_default_account_change(
            handle, static_cast<uint64_t>(expected_revision), values.data(),
            static_cast<uint32_t>(values.size()), static_cast<uint64_t>(ttl_seconds), out);
      });
}

jlong native_consume_default_account_change(JNIEnv *env, jobject, jlong raw,
                                            jbyteArray session_bytes,
                                            jbyteArray response_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> session;
  std::vector<uint8_t> response;
  if (bridge == nullptr || !take_bytes(env, session_bytes, &session) ||
      !take_bytes(env, response_bytes, &response)) return 0;
  return begin_request(env, bridge, [&session, &response](auto handle, auto *out) {
    return citizensdk_consume_default_account_change(handle, view(session),
                                                      view(response), out);
  });
}

void native_validate_modules(JNIEnv *env, jclass, jint modules) {
  const int32_t code = citizensdk_validate_modules(static_cast<uint32_t>(modules));
  if (code != CITIZENSDK_OK) throw_sdk(env, code, "Invalid CitizenSDK modules");
}

// 验签无实例和金库依赖；JNI 只做有界公开输入复制与结果投影。
jboolean native_verify(JNIEnv *env, jclass, jbyteArray account_bytes,
                       jbyteArray signature_bytes, jbyteArray message_bytes) {
  citizensdk_account_id_t value{};
  std::vector<uint8_t> signature;
  std::vector<uint8_t> message;
  if (signature_bytes == nullptr || env->GetArrayLength(signature_bytes) != 64 ||
      message_bytes == nullptr || env->GetArrayLength(message_bytes) > 16 * 1024 * 1024) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Verification input length is invalid");
    return JNI_FALSE;
  }
  if (!account(env, account_bytes, &value) ||
      !take_bytes(env, signature_bytes, &signature) || !take_bytes(env, message_bytes, &message)) return JNI_FALSE;
  uint8_t valid = 0;
  const int32_t code = citizensdk_verify_signature(&value, view(signature), view(message), &valid);
  if (code != CITIZENSDK_OK) {
    throw_sdk(env, code, "CitizenSDK signature verification failed");
    return JNI_FALSE;
  }
  if (valid > 1) {
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Invalid Core verification result");
    return JNI_FALSE;
  }
  return valid == 1 ? JNI_TRUE : JNI_FALSE;
}

jlong native_prepare_transaction(JNIEnv *env, jobject, jlong raw,
                                 jbyteArray source_bytes,
                                 jbyteArray call_data_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t source{};
  std::vector<uint8_t> call_data;
  if (call_data_bytes == nullptr || env->GetArrayLength(call_data_bytes) <= 0 ||
      env->GetArrayLength(call_data_bytes) > 1024 * 1024) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Transaction callData must contain 1..1 MiB bytes");
    return 0;
  }
  if (bridge == nullptr || !account(env, source_bytes, &source) ||
      !take_bytes(env, call_data_bytes, &call_data)) return 0;
  return begin_request(env, bridge, [&source, &call_data](auto handle, auto *out) {
    return citizensdk_prepare_transaction(handle, &source, view(call_data), out);
  });
}

void native_release_prepared_transaction(JNIEnv *env, jobject, jlong raw,
                                         jlong token) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr || token <= 0) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_HANDLE,
              "Prepared transaction handle is invalid");
    return;
  }
  const int32_t code = citizensdk_prepared_transaction_release(
      bridge->handle(), static_cast<uint64_t>(token));
  if (code != kOk) {
    throw_sdk(env, code, "Prepared transaction release failed");
  }
}

jlong native_execute_prepared_transaction(JNIEnv *env, jobject, jlong raw, jlong token) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr || token <= 0) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_HANDLE, "Prepared transaction handle is invalid");
    return 0;
  }
  return begin_request(env, bridge, [token](auto handle, auto *out) {
    return citizensdk_execute_prepared_transaction(handle, static_cast<uint64_t>(token), out);
  });
}

jlong native_consume_prepared_transaction_qr(JNIEnv *env, jobject, jlong raw,
                                              jbyteArray id_bytes,
                                              jbyteArray response_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> id;
  std::vector<uint8_t> response;
  if (bridge == nullptr || !take_bytes(env, id_bytes, &id) || id.size() != 16 ||
      !take_bytes(env, response_bytes, &response) || response.empty()) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Execution id/QR_V1 response is invalid");
    return 0;
  }
  citizensdk_transaction_execution_id_t execution{};
  std::copy(id.begin(), id.end(), execution.bytes);
  return begin_request(env, bridge, [&execution, &response](auto handle, auto *out) {
    return citizensdk_transaction_execution_consume_qr_response(
        handle, &execution, view(response), out);
  });
}

void native_cancel_prepared_transaction_execution(JNIEnv *env, jobject, jlong raw,
                                                   jbyteArray id_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> id;
  if (bridge == nullptr || !take_bytes(env, id_bytes, &id) || id.size() != 16) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Execution id is invalid");
    return;
  }
  citizensdk_transaction_execution_id_t execution{};
  std::copy(id.begin(), id.end(), execution.bytes);
  const auto code = citizensdk_transaction_execution_cancel(bridge->handle(), &execution);
  if (code != kOk) throw_sdk(env, code, "Transaction execution cancel failed");
}

jlong native_get_transaction_history(JNIEnv *env, jobject, jlong raw,
                                     jbyteArray before_bytes, jint limit) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr || limit < 1 || limit > 100) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
                                         "Transaction history limit is invalid");
    return 0;
  }
  citizensdk_transaction_execution_id_t before{};
  std::vector<uint8_t> bytes;
  const bool has_before = before_bytes != nullptr;
  if (has_before && (!take_bytes(env, before_bytes, &bytes) || bytes.size() != 16)) {
    if (!env->ExceptionCheck()) throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
                                         "Transaction history cursor is invalid");
    return 0;
  }
  if (has_before) std::copy(bytes.begin(), bytes.end(), before.bytes);
  return begin_request(env, bridge, [&before, has_before, limit](auto handle, auto *out) {
    return citizensdk_get_transaction_history(
        handle, has_before ? &before : nullptr, static_cast<uint32_t>(limit), out);
  });
}

jlong native_sync_transaction_history(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr) return 0;
  return begin_request(env, bridge, [](auto handle, auto *out) {
    return citizensdk_sync_transaction_history(handle, out);
  });
}

// 输入检查无持久化副作用，错误消息来自 Core 固定模板，不回显秘密。
void wallet_input_error(JNIEnv *env, int32_t code) {
  if (code == kOk) return;
  uint64_t required = 0;
  std::vector<uint8_t> message;
  if (citizensdk_last_error_copy(nullptr, 0, &required) == kOk && required < 4096) {
    message.resize(static_cast<size_t>(required) + 1, 0);
    if (citizensdk_last_error_copy(message.data(), required, &required) == kOk) {
      throw_sdk(env, code, reinterpret_cast<const char *>(message.data()));
      return;
    }
  }
  throw_sdk(env, code, "Wallet input validation failed");
}

jintArray native_validate_wallet_input(JNIEnv *env, jobject, jint kind,
                                       jbyteArray input, jint words) {
  SensitiveBytes bytes;
  if (!take_wallet_secret(env, input, bytes.out())) return nullptr;
  auto validation = info_value<citizensdk_wallet_input_validation_v1_t>();
  const auto code = citizensdk_validate_wallet_input(
      static_cast<uint32_t>(kind), view(bytes.value()),
      static_cast<uint32_t>(words), &validation);
  if (code != kOk) { wallet_input_error(env, code); return nullptr; }
  const jint values[] = {static_cast<jint>(validation.reason),
      validation.position == UINT32_MAX ? -1 : static_cast<jint>(validation.position)};
  auto result = env->NewIntArray(2);
  if (result != nullptr) env->SetIntArrayRegion(result, 0, 2, values);
  return result;
}

jbyteArray native_word_suggestions(JNIEnv *env, jobject, jbyteArray input) {
  SensitiveBytes bytes;
  if (!take_wallet_secret(env, input, bytes.out())) return nullptr;
  uint64_t required = 0;
  auto code = citizensdk_wallet_word_suggestions(view(bytes.value()), nullptr, 0, &required);
  if (code != kOk) { wallet_input_error(env, code); return nullptr; }
  if (required > 128) { throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Wallet suggestions exceed limit"); return nullptr; }
  SensitiveBytes output;
  output.out()->resize(static_cast<size_t>(required));
  code = citizensdk_wallet_word_suggestions(view(bytes.value()), output.out()->data(), required, &required);
  if (code != kOk) { wallet_input_error(env, code); return nullptr; }
  auto result = env->NewByteArray(static_cast<jsize>(required));
  if (result != nullptr && required != 0) env->SetByteArrayRegion(result, 0, static_cast<jsize>(required), reinterpret_cast<const jbyte *>(output.value().data()));
  return result;
}

jlong native_prepare(JNIEnv *env, jobject, jlong raw, jint words,
                     jbyteArray password_bytes) {
  auto bridge = bridge_from(env, raw);
  SensitiveBytes password;
  if (bridge == nullptr || !take_wallet_secret(env, password_bytes, password.out())) return 0;
  return begin_request(env, bridge, [&password, words](auto handle, auto *out) {
    return citizensdk_prepare_wallet_creation(handle, static_cast<uint32_t>(words),
                                              view(password.value()), out);
  });
}

jlong native_import(JNIEnv *env, jobject, jlong raw, jbyteArray mnemonic_bytes,
                    jbyteArray password_bytes) {
  auto bridge = bridge_from(env, raw);
  SensitiveBytes mnemonic;
  SensitiveBytes password;
  if (bridge == nullptr ||
      !take_wallet_secret(env, mnemonic_bytes, mnemonic.out()) ||
      !take_wallet_secret(env, password_bytes, password.out())) return 0;
  return begin_request(env, bridge,
                                     [&mnemonic, &password](auto handle, auto *out) {
    return citizensdk_import_wallet(handle, view(mnemonic.value()),
                                    view(password.value()), out);
  });
}

jlong native_add_accounts(JNIEnv *env, jobject, jlong raw,
                          jbyteArray mnemonic_bytes, jbyteArray password_bytes,
                          jintArray index_values) {
  auto bridge = bridge_from(env, raw);
  SensitiveBytes mnemonic;
  SensitiveBytes password;
  std::vector<uint32_t> indices;
  if (bridge == nullptr ||
      !take_wallet_secret(env, mnemonic_bytes, mnemonic.out()) ||
      !take_wallet_secret(env, password_bytes, password.out()) ||
      !take_ints(env, index_values, &indices)) return 0;
  return begin_request(
      env, bridge, [&mnemonic, &password, &indices](auto handle, auto *out) {
        return citizensdk_add_wallet_accounts(
            handle, view(mnemonic.value()), view(password.value()), indices.data(),
            static_cast<uint32_t>(indices.size()), out);
      });
}

jlong native_add_next_account(JNIEnv *env, jobject, jlong raw,
                              jbyteArray mnemonic_bytes, jbyteArray password_bytes) {
  auto bridge = bridge_from(env, raw);
  SensitiveBytes mnemonic;
  SensitiveBytes password;
  if (bridge == nullptr ||
      !take_wallet_secret(env, mnemonic_bytes, mnemonic.out()) ||
      !take_wallet_secret(env, password_bytes, password.out())) return 0;
  return begin_request(env, bridge, [&mnemonic, &password](auto handle, auto *out) {
    return citizensdk_add_next_wallet_account(
        handle, view(mnemonic.value()), view(password.value()), out);
  });
}

jbyteArray native_copy_prepared(JNIEnv *env, jobject, jlong raw, jlong token) {
  auto bridge = bridge_from(env, raw);
  citizensdk_prepared_wallet_handle_t prepared = 0;
  if (bridge == nullptr || !bridge->prepared(static_cast<uint64_t>(token), &prepared)) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_HANDLE,
              "Prepared wallet is unknown or consumed");
    return nullptr;
  }
  uint64_t required = 0;
  int32_t code = citizensdk_prepared_wallet_copy_mnemonic(
      bridge->handle(), prepared, nullptr, 0, &required);
  if (code != kOk || required > 1024) {
    throw_sdk(env, code == kOk ? CITIZENSDK_ERROR_INTEGRITY : code,
              "Prepared recovery phrase is invalid");
    return nullptr;
  }
  std::vector<uint8_t> bytes(static_cast<size_t>(required));
  code = citizensdk_prepared_wallet_copy_mnemonic(
      bridge->handle(), prepared, bytes.data(), required, &required);
  if (code != kOk) {
    secure_zero(&bytes);
    throw_sdk(env, code, "Prepared recovery phrase could not be copied");
    return nullptr;
  }
  jbyteArray result = to_byte_array(env, bytes);
  secure_zero(&bytes);
  return result;
}

jlong native_commit_prepared(JNIEnv *env, jobject, jlong raw, jlong token) {
  auto bridge = bridge_from(env, raw);
  citizensdk_prepared_wallet_handle_t prepared = 0;
  if (bridge == nullptr || !bridge->prepared(static_cast<uint64_t>(token), &prepared)) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_HANDLE,
              "Prepared wallet is unknown or consumed");
    return 0;
  }
  citizensdk_request_id_t request = 0;
  const int32_t code = citizensdk_commit_wallet_creation(
      bridge->handle(), prepared, &request);
  if (code != kOk) {
    throw_sdk(env, code, "Prepared wallet commit was rejected");
    return 0;
  }
  citizensdk_prepared_wallet_handle_t removed = 0;
  bridge->forget_prepared(static_cast<uint64_t>(token), &removed);
  if (request == 0 ||
      request > static_cast<citizensdk_request_id_t>(
                    std::numeric_limits<jlong>::max())) {
    if (request != 0) citizensdk_cancel_request(bridge->handle(), request);
    throw_sdk(env, CITIZENSDK_ERROR_INTERNAL,
              "Core returned a request ID outside the Android contract");
    return 0;
  }
  return static_cast<jlong>(request);
}

void native_release_prepared(JNIEnv *env, jobject, jlong raw, jlong token) {
  auto bridge = bridge_from(env, raw);
  citizensdk_prepared_wallet_handle_t prepared = 0;
  if (bridge == nullptr ||
      !bridge->forget_prepared(static_cast<uint64_t>(token), &prepared)) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_HANDLE,
              "Prepared wallet is unknown or consumed");
    return;
  }
  const int32_t code = citizensdk_prepared_wallet_release(bridge->handle(), prepared);
  if (code != kOk) {
    // A rejected release did not consume the Core handle. Restore the opaque
    // facade token so the caller can retry instead of orphaning the secret.
    bridge->remember_prepared(static_cast<uint64_t>(token), prepared);
    throw_sdk(env, code, "Prepared wallet release failed");
  }
}

template <typename Call>
jbyteArray qr_core_bytes(JNIEnv *env,
                         const std::shared_ptr<CitizenSdkHostBridge> &bridge,
                         Call call, size_t prefix = 0, size_t maximum = kMaxQrTextBytes) {
  (void)bridge;  // 保持 Host/Core 租约贯穿两次变长输出调用。
  uint64_t required = 0;
  int32_t code = call(nullptr, 0, &required);
  if (code != kOk || required == 0 || required > maximum || prefix > 32) {
    throw_sdk(env, code == kOk ? CITIZENSDK_ERROR_INTEGRITY : code,
              "CitizenSDK QR output query failed");
    return nullptr;
  }
  std::vector<uint8_t> output(prefix + static_cast<size_t>(required));
  code = call(output.data() + prefix, required, &required);
  if (code != kOk || prefix + required != output.size()) {
    throw_sdk(env, code == kOk ? CITIZENSDK_ERROR_INTEGRITY : code,
              "CitizenSDK QR output copy failed");
    return nullptr;
  }
  return to_byte_array(env, output);
}

bool qr_input(JNIEnv *env, jbyteArray source, size_t maximum,
              std::vector<uint8_t> *out, const char *message) {
  if (source == nullptr || env->GetArrayLength(source) <= 0 ||
      static_cast<size_t>(env->GetArrayLength(source)) > maximum ||
      !take_bytes(env, source, out)) {
    if (!env->ExceptionCheck())
      throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, message);
    return false;
  }
  return true;
}

jboolean native_encrypted_secret_record_has_secret(JNIEnv *env, jclass, jbyteArray account_bytes,
    jlong revision, jbyteArray record_bytes) {
  citizensdk_account_id_t value{};
  if (!account(env, account_bytes, &value)) return JNI_FALSE;
  if (revision < 0 || record_bytes == nullptr || env->GetArrayLength(record_bytes) > 65536) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "密文存在性输入边界无效"); return JNI_FALSE;
  }
  std::vector<uint8_t> record;
  if (!take_bytes(env, record_bytes, &record)) return JNI_FALSE;
  uint8_t present = 0;
  const auto code = citizensdk_encrypted_secret_record_has_secret(&value, static_cast<uint64_t>(revision), view(record), &present);
  if (code != CITIZENSDK_OK || present > 1) {
    throw_sdk(env, code == CITIZENSDK_OK ? CITIZENSDK_ERROR_INTEGRITY : code, "密文存在性检查失败");
    return JNI_FALSE;
  }
  return present ? JNI_TRUE : JNI_FALSE;
}

jbyteArray native_encode_signing_payload(JNIEnv *env, jclass, jint kind,
    jbyteArray fields_bytes, jbyteArray payload_bytes) {
  std::vector<uint8_t> fields, payload;
  if (kind < 1 || kind > 6 || fields_bytes == nullptr || payload_bytes == nullptr ||
      env->GetArrayLength(fields_bytes) > 4096 || env->GetArrayLength(payload_bytes) > 16 * 1024 * 1024) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Payload input boundary is invalid");
    return nullptr;
  }
  if (!take_bytes(env, fields_bytes, &fields) || !take_bytes(env, payload_bytes, &payload)) return nullptr;
  // 复用同一变长结果复制路径；纯编码没有Host/Core实例租约。
  return qr_core_bytes(env, nullptr, [&](uint8_t *out, uint64_t capacity, uint64_t *required) {
    return citizensdk_encode_signing_payload(static_cast<uint32_t>(kind), view(fields), view(payload), out, capacity, required);
  }, 0, 16 * 1024 * 1024);
}

jbyteArray native_qr_encode_document(JNIEnv *env, jobject, jlong raw, jbyteArray input_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> input;
  if (!bridge || !qr_input(env, input_bytes, 65536, &input, "QR content boundary is invalid")) return nullptr;
  return qr_core_bytes(env, bridge, [&](uint8_t *out, uint64_t capacity, uint64_t *required) {
    return citizensdk_qr_encode_document(bridge->handle(), view(input), out, capacity, required);
  }, 0, 65536);
}

jbyteArray native_qr_prepare_account_authorization(JNIEnv *env, jobject, jlong raw,
    jint action, jbyteArray payload_bytes, jbyteArray account_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> payload, account;
  if (!bridge) return nullptr;
  if (payload_bytes == nullptr || account_bytes == nullptr ||
      env->GetArrayLength(payload_bytes) > 1920 || env->GetArrayLength(account_bytes) > 1024) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Authorization input boundary is invalid");
    return nullptr;
  }
  if (!take_bytes(env, payload_bytes, &payload) || !take_bytes(env, account_bytes, &account)) return nullptr;
  return qr_core_bytes(env, bridge, [&](uint8_t *out, uint64_t capacity, uint64_t *required) {
    return citizensdk_qr_prepare_account_authorization(bridge->handle(), static_cast<uint32_t>(action),
        view(payload), view(account), out, capacity, required);
  }, 0, 65536);
}

jbyteArray native_qr_parse(JNIEnv *env, jobject, jlong raw, jbyteArray text_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> text;
  if (!bridge ||
      !qr_input(env, text_bytes, kMaxQrTextBytes, &text, "QR text is invalid")) return nullptr;
  return qr_core_bytes(env, bridge,
      [&](uint8_t *output, uint64_t capacity, uint64_t *required) {
        return citizensdk_qr_parse(bridge->handle(), view(text), output, capacity, required);
      }, 0, 65536);
}

jbyteArray native_qr_create_request(JNIEnv *env, jobject, jlong raw, jint action,
                                    jbyteArray account_bytes, jbyteArray payload_bytes,
                                    jlong ttl) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t signer{};
  std::vector<uint8_t> payload;
  if (!bridge || action <= 0 || action > 0xffff || ttl <= 0 || ttl > 300 ||
      !account(env, account_bytes, &signer) ||
      !qr_input(env, payload_bytes, kMaxQrReviewBytes, &payload, "QR review payload is invalid")) return nullptr;
  return qr_core_bytes(env, bridge,
      [&](uint8_t *output, uint64_t capacity, uint64_t *required) {
        return citizensdk_qr_create_sign_request(
            bridge->handle(), static_cast<uint16_t>(action), &signer, view(payload),
            static_cast<uint64_t>(ttl), output, capacity, required);
      });
}

jlong native_review_qr_request(JNIEnv *env, jobject, jlong raw, jbyteArray text_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> text;
  if (!bridge || !qr_input(env, text_bytes, kMaxQrTextBytes, &text, "QR sign request is invalid")) return 0;
  return begin_request(env, bridge, [&text](auto handle, auto *out) {
    return citizensdk_review_qr_sign_request(handle, view(text), out);
  });
}

jlong native_sign_qr_request(JNIEnv *env, jobject, jlong raw, jlong token) {
  auto bridge = bridge_from(env, raw);
  if (!bridge) return 0;
  if (token <= 0 || !bridge->has_qr_review(static_cast<uint64_t>(token))) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "QR review is not owned by this SDK");
    return 0;
  }
  return begin_request(env, bridge, [token](auto handle, auto *out) {
    return citizensdk_sign_qr_request(handle, static_cast<uint64_t>(token), out);
  });
}

void native_release_qr_review(JNIEnv *env, jobject, jlong raw, jlong token) {
  auto bridge = bridge_from(env, raw);
  if (bridge && token > 0) bridge->release_qr_review(static_cast<uint64_t>(token));
}

// 非消费预检只调用同一Core验证，不把宿主布尔结果视为验签。
void native_qr_validate_response(JNIEnv *env, jobject, jlong raw, jbyteArray session_bytes, jbyteArray text_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> session, text;
  if (!bridge || !qr_input(env, session_bytes, 128, &session, "QR session ID is invalid") ||
      !qr_input(env, text_bytes, kMaxQrTextBytes, &text, "QR response is invalid")) return;
  const auto code = citizensdk_qr_validate_sign_response(bridge->handle(), view(session), view(text));
  if (code != kOk) throw_sdk(env, code, "QR response preflight failed");
}

jbyteArray native_qr_consume_response(JNIEnv *env, jobject, jlong raw, jbyteArray text_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> text;
  if (!bridge || !qr_input(env, text_bytes, kMaxQrTextBytes, &text, "QR sign response is invalid")) return nullptr;
  std::vector<uint8_t> signature(64);
  const auto code = citizensdk_qr_consume_sign_response(
      bridge->handle(), view(text), signature.data());
  if (code != kOk) { throw_sdk(env, code, "QR sign response was rejected"); return nullptr; }
  return to_byte_array(env, signature);
}

jboolean native_qr_cancel_request(JNIEnv *env, jobject, jlong raw,
                                  jbyteArray request_bytes) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> request;
  if (!bridge || !qr_input(env, request_bytes, 128, &request, "QR request ID is invalid")) return JNI_FALSE;
  uint8_t cancelled = 0;
  const auto code = citizensdk_qr_cancel_sign_request(bridge->handle(), view(request), &cancelled);
  if (code != kOk || cancelled > 1) {
    throw_sdk(env, code == kOk ? CITIZENSDK_ERROR_INTEGRITY : code, "QR request cancellation failed");
    return JNI_FALSE;
  }
  return cancelled == 1 ? JNI_TRUE : JNI_FALSE;
}

jbyteArray native_qr_encode_account(JNIEnv *env, jobject, jlong raw,
                                    jbyteArray account_bytes) {
  auto bridge = bridge_from(env, raw);
  citizensdk_account_id_t account_id{};
  if (!bridge || !account(env, account_bytes, &account_id)) return nullptr;
  return qr_core_bytes(env, bridge,
      [&](uint8_t *output, uint64_t capacity, uint64_t *required) {
        return citizensdk_qr_encode_account_id(bridge->handle(), &account_id,
                                               output, capacity, required);
      });
}

citizensdk_error_code_t qr_image_error(citizensdk_qr_image_status_t status) {
  switch (status) {
    case CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT:
    case CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED: return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    case CITIZENSDK_QR_IMAGE_NO_CODE: return CITIZENSDK_ERROR_NOT_FOUND;
    case CITIZENSDK_QR_IMAGE_MULTIPLE_CODES: return CITIZENSDK_ERROR_CONFLICT;
    case CITIZENSDK_QR_IMAGE_INVALID_UTF8: return CITIZENSDK_ERROR_DECODE;
    default: return CITIZENSDK_ERROR_INTERNAL;
  }
}

jbyteArray native_qr_decode_luminance(JNIEnv *env, jobject, jlong raw,
    jbyteArray data_bytes, jint width, jint height, jint stride, jboolean all) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> data;
  if (!bridge || width <= 0 || height <= 0 || stride <= 0 ||
      data_bytes == nullptr || env->GetArrayLength(data_bytes) <= 0 ||
      env->GetArrayLength(data_bytes) > static_cast<jsize>(kMaxQrImageBytes) ||
      !take_bytes(env, data_bytes, &data)) return nullptr;
  size_t required = 0;
  const auto decode = all == JNI_TRUE ? citizensdk_qr_image_decode_luminance_all : citizensdk_qr_image_decode_luminance;
  const size_t maximum = all == JNI_TRUE ? 4 + 64 * (4 + kMaxQrTextBytes) : kMaxQrTextBytes;
  auto status = decode(data.data(), data.size(),
      static_cast<uint32_t>(width), static_cast<uint32_t>(height), static_cast<uint32_t>(stride),
      nullptr, 0, &required);
  if (status != CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL || required == 0 || required > maximum) {
    throw_sdk(env, qr_image_error(status), "ZXing-C++ QR decode failed"); return nullptr;
  }
  std::vector<uint8_t> output(required);
  status = decode(data.data(), data.size(),
      static_cast<uint32_t>(width), static_cast<uint32_t>(height), static_cast<uint32_t>(stride),
      output.data(), output.size(), &required);
  if (status != CITIZENSDK_QR_IMAGE_OK) {
    throw_sdk(env, qr_image_error(status), "ZXing-C++ QR decode failed"); return nullptr;
  }
  return to_byte_array(env, output);
}

jbyteArray native_qr_encode_image(JNIEnv *env, jobject, jlong raw,
                                  jbyteArray text_bytes, jint scale) {
  auto bridge = bridge_from(env, raw);
  std::vector<uint8_t> text;
  if (!bridge || scale < 1 || scale > 16 ||
      !qr_input(env, text_bytes, kMaxQrTextBytes, &text, "QR text is invalid")) {
    if (!env->ExceptionCheck() && (scale < 1 || scale > 16))
      throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT, "QR scale must be 1..16");
    return nullptr;
  }
  uint32_t width = 0, height = 0;
  size_t required = 0;
  auto status = citizensdk_qr_image_encode_text(text.data(), text.size(),
      static_cast<uint32_t>(scale), nullptr, 0, &width, &height, &required);
  if (status != CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL || required == 0 || required > kMaxQrImageBytes) {
    throw_sdk(env, qr_image_error(status), "ZXing-C++ QR encode failed"); return nullptr;
  }
  std::vector<uint8_t> output(required + 8);
  for (uint32_t index = 0; index < 4; ++index) {
    output[index] = static_cast<uint8_t>(width >> (index * 8));
    output[index + 4] = static_cast<uint8_t>(height >> (index * 8));
  }
  status = citizensdk_qr_image_encode_text(text.data(), text.size(),
      static_cast<uint32_t>(scale), output.data() + 8, required, &width, &height, &required);
  if (status != CITIZENSDK_QR_IMAGE_OK) {
    throw_sdk(env, qr_image_error(status), "ZXing-C++ QR encode failed"); return nullptr;
  }
  return to_byte_array(env, output);
}

void native_destroy(JNIEnv *env, jobject, jlong raw) {
  auto bridge = bridge_from(env, raw);
  if (bridge == nullptr || !bridge->destroy(env)) return;
  {
    std::lock_guard<std::mutex> lock(g_bridges_mutex);
    g_bridges.erase(static_cast<intptr_t>(raw));
  }
}

void native_complete_vault_status(JNIEnv *env, jclass, jlong raw,
                            jlong operation_id, jint error_code) {
  if (auto bridge = bridge_from(env, raw)) {
    bridge->complete_vault_status(static_cast<uint64_t>(operation_id), error_code);
  }
}

const JNINativeMethod kMethods[] = {
    {const_cast<char *>("encryptedSecretRecordHasSecret"), const_cast<char *>("([BJ[B)Z"), reinterpret_cast<void *>(native_encrypted_secret_record_has_secret)},
    {const_cast<char *>("validateModules"), const_cast<char *>("(I)V"), reinterpret_cast<void *>(native_validate_modules)},
    {const_cast<char *>("verifySignature"), const_cast<char *>("([B[B[B)Z"), reinterpret_cast<void *>(native_verify)},
    {const_cast<char *>("encodeSigningPayload"), const_cast<char *>("(I[B[B)[B"), reinterpret_cast<void *>(native_encode_signing_payload)},
    {const_cast<char *>("nativeCreate"),
     const_cast<char *>("(Landroid/content/Context;Lorg/citizen/sdk/internal/CitizenSdkHostServices;[B[B[BI)J"),
     reinterpret_cast<void *>(native_create)},
    {const_cast<char *>("nativeBind"), const_cast<char *>("(J)V"), reinterpret_cast<void *>(native_bind)},
    {const_cast<char *>("nativeLifecycle"), const_cast<char *>("(J)I"), reinterpret_cast<void *>(native_lifecycle)},
    {const_cast<char *>("nativeCapabilities"), const_cast<char *>("(J)[B"), reinterpret_cast<void *>(native_capabilities)},
    {const_cast<char *>("nativeRefreshCapabilities"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_refresh_capabilities)},
    {const_cast<char *>("nativeStart"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_start)},
    {const_cast<char *>("nativeAcceptRequestSequence"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_accept_request_sequence)},
    {const_cast<char *>("nativeStop"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_stop)},
    {const_cast<char *>("nativeCancel"), const_cast<char *>("(JJ)Z"), reinterpret_cast<void *>(native_cancel)},
    {const_cast<char *>("nativeGetFinalizedHead"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_finalized_head)},
    {const_cast<char *>("nativeGetSyncStatus"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_sync_status)},
    {const_cast<char *>("nativeGetBestHead"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_best_head)},
    {const_cast<char *>("nativeGetFinalizedBlockAt"), const_cast<char *>("(JJ)J"), reinterpret_cast<void *>(native_finalized_block_at)},
    {const_cast<char *>("nativeResolveFinalizedBlock"), const_cast<char *>("(J[BJ)J"), reinterpret_cast<void *>(native_resolve_finalized_block)},
    {const_cast<char *>("nativeGetBlockHeader"), const_cast<char *>("(J[BJI)J"), reinterpret_cast<void *>(native_block_header)},
    {const_cast<char *>("nativeGetBlockBody"), const_cast<char *>("(J[BJI)J"), reinterpret_cast<void *>(native_block_body)},
    {const_cast<char *>("nativeGetRuntimeContext"), const_cast<char *>("(J[BJI)J"), reinterpret_cast<void *>(native_runtime_context)},
    {const_cast<char *>("nativeGetStorage"), const_cast<char *>("(J[BJI[B)J"), reinterpret_cast<void *>(native_storage)},
    {const_cast<char *>("nativeGetStorageBatch"), const_cast<char *>("(J[BJI[[B)J"), reinterpret_cast<void *>(native_storage_batch)},
    {const_cast<char *>("nativeGetStorageKeysPaged"), const_cast<char *>("(J[BJI[B[BI)J"), reinterpret_cast<void *>(native_storage_keys_paged)},
    {const_cast<char *>("nativeCallRuntimeApi"), const_cast<char *>("(J[BJI[B[B)J"), reinterpret_cast<void *>(native_runtime_api)},
    {const_cast<char *>("nativeGetSystemEvents"), const_cast<char *>("(J[BJI)J"), reinterpret_cast<void *>(native_system_events)},
    {const_cast<char *>("nativeExportState"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_export_state)},
    {const_cast<char *>("nativeImportState"), const_cast<char *>("(JI[BJI[B)J"), reinterpret_cast<void *>(native_import_state)},
    {const_cast<char *>("nativeGetGenesisHash"), const_cast<char *>("(J)[B"), reinterpret_cast<void *>(native_genesis_hash)},
    {const_cast<char *>("nativeGetAccountBalance"), const_cast<char *>("(J[B)J"), reinterpret_cast<void *>(native_balance)},
    {const_cast<char *>("nativeGetAccountBalances"), const_cast<char *>("(J[BI)J"), reinterpret_cast<void *>(native_balances)},
    {const_cast<char *>("nativeGetAccountNonce"), const_cast<char *>("(J[B)J"), reinterpret_cast<void *>(native_nonce)},
    {const_cast<char *>("nativeGetFeeSnapshot"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_fee)},
    {const_cast<char *>("nativeGetWalletProfile"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_wallet_profile)},
    {const_cast<char *>("nativeGetWalletState"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_wallet_state)},
    {const_cast<char *>("nativeInspectWallets"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_inspect_wallets)},
    {const_cast<char *>("nativeReleaseWalletInspection"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_release_wallet_inspection)},
    {const_cast<char *>("nativeChangeDiagnostic"), const_cast<char *>("(JJJI[B)J"), reinterpret_cast<void *>(native_change_diagnostic)},
    {const_cast<char *>("nativeImportColdAccountId"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_import_cold_id)},
    {const_cast<char *>("nativeImportColdAccountSs58"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_import_cold_ss58)},
    {const_cast<char *>("nativeReorderWalletAccounts"), const_cast<char *>("(JJ[BI)J"), reinterpret_cast<void *>(native_reorder_wallet)},
    {const_cast<char *>("nativeSetActiveWallet"), const_cast<char *>("(JJJ)J"), reinterpret_cast<void *>(native_select_wallet)},
    {const_cast<char *>("nativeRenameWallet"), const_cast<char *>("(JJJ[B)J"), reinterpret_cast<void *>(native_rename_wallet)},
    {const_cast<char *>("nativeRenameAccount"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_rename_any)},
    {const_cast<char *>("nativeDeleteAccount"), const_cast<char *>("(J[B)J"), reinterpret_cast<void *>(native_delete_any)},
    {const_cast<char *>("nativeOpenPrivateKeyView"), const_cast<char *>("(J[BLorg/citizen/sdk/CitizenSdkPrivateKeyReceiver;)[J"), reinterpret_cast<void *>(native_open_private_key_view)},
    {const_cast<char *>("nativeRevealPrivateKeyView"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_reveal_private_key_view)},
    {const_cast<char *>("nativeCancelPrivateKeyView"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_cancel_private_key_view)},
    {const_cast<char *>("nativeFinishPrivateKeyView"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_finish_private_key_view)},
    {const_cast<char *>("nativeReleasePrivateKeyViewContext"), const_cast<char *>("(J)V"), reinterpret_cast<void *>(native_release_private_key_view_context)},
    {const_cast<char *>("nativeSetActiveWalletAccount"), const_cast<char *>("(J[B)J"), reinterpret_cast<void *>(native_set_active)},
    {const_cast<char *>("nativeRenameWalletAccount"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_rename)},
    {const_cast<char *>("nativeDeleteWalletAccount"), const_cast<char *>("(J[B)J"), reinterpret_cast<void *>(native_delete_account)},
    {const_cast<char *>("nativeDeleteWallet"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_delete_wallet)},
    {const_cast<char *>("nativeSignAndDeleteWallet"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_sign_and_delete_wallet)},
    {const_cast<char *>("nativeReconcileWalletCleanup"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_reconcile)},
    {const_cast<char *>("nativeSignWalletPayload"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_sign)},
    {const_cast<char *>("nativeBeginSigning"), const_cast<char *>("(J[B[BI[BIIJ)J"), reinterpret_cast<void *>(native_begin_signing)},
    {const_cast<char *>("nativeConsumeExternalSignature"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_consume_external_signature)},
    {const_cast<char *>("nativeCancelSigningSession"), const_cast<char *>("(J[B)Z"), reinterpret_cast<void *>(native_cancel_signing_session)},
    {const_cast<char *>("nativeBeginDefaultAccountChange"), const_cast<char *>("(JJ[BIJ)J"), reinterpret_cast<void *>(native_begin_default_account_change)},
    {const_cast<char *>("nativeConsumeDefaultAccountChange"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_consume_default_account_change)},
    {const_cast<char *>("nativeQrParse"), const_cast<char *>("(J[B)[B"), reinterpret_cast<void *>(native_qr_parse)},
    {const_cast<char *>("nativeQrEncodeDocument"), const_cast<char *>("(J[B)[B"), reinterpret_cast<void *>(native_qr_encode_document)},
    {const_cast<char *>("nativeQrPrepareAccountAuthorization"), const_cast<char *>("(JI[B[B)[B"), reinterpret_cast<void *>(native_qr_prepare_account_authorization)},
    {const_cast<char *>("nativeQrCreateSignRequest"), const_cast<char *>("(JI[B[BJ)[B"), reinterpret_cast<void *>(native_qr_create_request)},
    {const_cast<char *>("nativeReviewQrSignRequest"), const_cast<char *>("(J[B)J"), reinterpret_cast<void *>(native_review_qr_request)},
    {const_cast<char *>("nativeSignQrRequest"), const_cast<char *>("(JJ)J"), reinterpret_cast<void *>(native_sign_qr_request)},
    {const_cast<char *>("nativeReleaseQrReview"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_release_qr_review)},
    {const_cast<char *>("nativeQrValidateSignResponse"), const_cast<char *>("(J[B[B)V"), reinterpret_cast<void *>(native_qr_validate_response)},
    {const_cast<char *>("nativeQrConsumeSignResponse"), const_cast<char *>("(J[B)[B"), reinterpret_cast<void *>(native_qr_consume_response)},
    {const_cast<char *>("nativeQrCancelSignRequest"), const_cast<char *>("(J[B)Z"), reinterpret_cast<void *>(native_qr_cancel_request)},
    {const_cast<char *>("nativeQrEncodeAccountId"), const_cast<char *>("(J[B)[B"), reinterpret_cast<void *>(native_qr_encode_account)},
    {const_cast<char *>("nativeQrDecodeLuminance"), const_cast<char *>("(J[BIIIZ)[B"), reinterpret_cast<void *>(native_qr_decode_luminance)},
    {const_cast<char *>("nativeQrEncode"), const_cast<char *>("(J[BI)[B"), reinterpret_cast<void *>(native_qr_encode_image)},
    {const_cast<char *>("nativePrepareTransaction"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_prepare_transaction)},
    {const_cast<char *>("nativeReleasePreparedTransaction"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_release_prepared_transaction)},
    {const_cast<char *>("nativeExecutePreparedTransaction"), const_cast<char *>("(JJ)J"), reinterpret_cast<void *>(native_execute_prepared_transaction)},
    {const_cast<char *>("nativeConsumePreparedTransactionQrResponse"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_consume_prepared_transaction_qr)},
    {const_cast<char *>("nativeCancelPreparedTransactionExecution"), const_cast<char *>("(J[B)V"), reinterpret_cast<void *>(native_cancel_prepared_transaction_execution)},
    {const_cast<char *>("nativeGetTransactionHistory"), const_cast<char *>("(J[BI)J"), reinterpret_cast<void *>(native_get_transaction_history)},
    {const_cast<char *>("nativeSyncTransactionHistory"), const_cast<char *>("(J)J"), reinterpret_cast<void *>(native_sync_transaction_history)},
    {const_cast<char *>("nativePrepareWalletCreation"), const_cast<char *>("(JI[B)J"), reinterpret_cast<void *>(native_prepare)},
    {const_cast<char *>("nativeValidateWalletInput"), const_cast<char *>("(I[BI)[I"), reinterpret_cast<void *>(native_validate_wallet_input)},
    {const_cast<char *>("nativeWalletWordSuggestions"), const_cast<char *>("([B)[B"), reinterpret_cast<void *>(native_word_suggestions)},
    {const_cast<char *>("nativeImportWallet"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_import)},
    {const_cast<char *>("nativeAddWalletAccounts"), const_cast<char *>("(J[B[B[I)J"), reinterpret_cast<void *>(native_add_accounts)},
    {const_cast<char *>("nativeAddNextWalletAccount"), const_cast<char *>("(J[B[B)J"), reinterpret_cast<void *>(native_add_next_account)},
    {const_cast<char *>("nativeCopyPreparedMnemonic"), const_cast<char *>("(JJ)[B"), reinterpret_cast<void *>(native_copy_prepared)},
    {const_cast<char *>("nativeCommitPreparedWallet"), const_cast<char *>("(JJ)J"), reinterpret_cast<void *>(native_commit_prepared)},
    {const_cast<char *>("nativeReleasePreparedWallet"), const_cast<char *>("(JJ)V"), reinterpret_cast<void *>(native_release_prepared)},
    {const_cast<char *>("nativeDestroy"), const_cast<char *>("(J)V"), reinterpret_cast<void *>(native_destroy)},
    {const_cast<char *>("completeVaultStatus"), const_cast<char *>("(JJI)V"), reinterpret_cast<void *>(native_complete_vault_status)},
};

}  // namespace

void throw_sdk(JNIEnv *env, citizensdk_error_code_t code,
               const char *fallback_message) {
  jclass code_class = env->FindClass("org/citizen/sdk/CitizenSdkErrorCode");
  jmethodID from = code_class == nullptr
                       ? nullptr
                       : env->GetStaticMethodID(
                             code_class, "fromValue",
                             "(I)Lorg/citizen/sdk/CitizenSdkErrorCode;");
  jobject code_value = from == nullptr
                           ? nullptr
                           : env->CallStaticObjectMethod(code_class, from, code);
  jclass exception_class = env->FindClass("org/citizen/sdk/CitizenSdkException");
  jmethodID constructor = exception_class == nullptr
                              ? nullptr
                              : env->GetMethodID(
                                    exception_class, "<init>",
                                    "(Lorg/citizen/sdk/CitizenSdkErrorCode;Ljava/lang/String;Ljava/lang/Throwable;)V");
  jstring message = env->NewStringUTF(fallback_message);
  if (!env->ExceptionCheck() && constructor != nullptr && code_value != nullptr &&
      message != nullptr) {
    jobject exception = env->NewObject(exception_class, constructor, code_value,
                                       message, nullptr);
    if (exception != nullptr) env->Throw(static_cast<jthrowable>(exception));
  }
  if (!env->ExceptionCheck()) {
    jclass fallback = env->FindClass("java/lang/IllegalStateException");
    if (fallback != nullptr) env->ThrowNew(fallback, fallback_message);
  }
}

bool take_bytes(JNIEnv *env, jbyteArray source, std::vector<uint8_t> *out) {
  if (source == nullptr) return false;
  const jsize length = env->GetArrayLength(source);
  out->resize(static_cast<size_t>(length));
  if (length != 0) {
    env->GetByteArrayRegion(source, 0, length,
                            reinterpret_cast<jbyte *>(out->data()));
  }
  return !env->ExceptionCheck();
}

bool take_ints(JNIEnv *env, jintArray source, std::vector<uint32_t> *out) {
  if (source == nullptr) return false;
  const jsize length = env->GetArrayLength(source);
  if (length <= 0 || length > kMaxWalletAccountIndices) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Wallet index list must contain 1..1989 items");
    return false;
  }
  std::vector<jint> values(static_cast<size_t>(length));
  env->GetIntArrayRegion(source, 0, length, values.data());
  if (env->ExceptionCheck()) return false;
  out->reserve(values.size());
  std::unordered_set<jint> seen;
  seen.reserve(values.size());
  for (const jint value : values) {
    if (value < 1 || static_cast<uint32_t>(value) > kMaxWalletAccountIndex || !seen.insert(value).second) {
      throw_sdk(env, CITIZENSDK_ERROR_INVALID_ARGUMENT,
                "Wallet indices must be unique values in 1..19890604");
      return false;
    }
    out->push_back(static_cast<uint32_t>(value));
  }
  return true;
}

jbyteArray to_byte_array(JNIEnv *env, const std::vector<uint8_t> &bytes) {
  if (bytes.size() > static_cast<size_t>(std::numeric_limits<jsize>::max())) return nullptr;
  jbyteArray result = env->NewByteArray(static_cast<jsize>(bytes.size()));
  if (result != nullptr && !bytes.empty()) {
    env->SetByteArrayRegion(result, 0, static_cast<jsize>(bytes.size()),
                            reinterpret_cast<const jbyte *>(bytes.data()));
  }
  return result;
}

void WireWriter::u8(uint8_t value) { data_.push_back(value); }
void WireWriter::u32(uint32_t value) {
  for (uint32_t shift = 0; shift < 32; shift += 8)
    data_.push_back(static_cast<uint8_t>(value >> shift));
}
void WireWriter::i32(int32_t value) { u32(static_cast<uint32_t>(value)); }
void WireWriter::u64(uint64_t value) {
  for (uint32_t shift = 0; shift < 64; shift += 8)
    data_.push_back(static_cast<uint8_t>(value >> shift));
}
void WireWriter::fixed(const uint8_t *bytes, size_t length) {
  if (length == 0) return;
  data_.insert(data_.end(), bytes, bytes + length);
}
void WireWriter::bytes(const uint8_t *value, size_t length) {
  u32(static_cast<uint32_t>(length));
  if (length != 0) fixed(value, length);
}
void WireWriter::text(const std::vector<uint8_t> &value) {
  bytes(value.data(), value.size());
}

void write_block(WireWriter *writer, const citizensdk_block_ref_t &block) {
  writer->fixed(block.hash, 32);
  writer->u64(block.number);
  writer->u32(block.finality);
}

void write_execution(WireWriter *writer,
                     const citizensdk_execution_info_t &execution) {
  writer->u32(execution.status);
  writer->u32(execution.reason_or_dispatch_variant);
  writer->u8(execution.has_block == 0 ? 0 : 1);
  if (execution.has_block != 0) write_block(writer, execution.block);
  writer->u8(execution.has_extrinsic_index == 0 ? 0 : 1);
  if (execution.has_extrinsic_index != 0) writer->u32(execution.extrinsic_index);
  writer->u8(execution.has_module == 0 ? 0 : 1);
  if (execution.has_module != 0) {
    writer->u32(execution.pallet_index);
    writer->u32(execution.error_index);
  }
}

// 单项与批量只共享公开余额结构的编码，不在 JNI 计算或查询链状态。
void write_balance(WireWriter *writer, const citizensdk_account_balance_info_t &value) {
  write_block(writer, value.block);
  writer->fixed(value.account_id.bytes, 32);
  writer->u64(value.free_fen.low); writer->u64(value.free_fen.high);
  writer->u64(value.reserved_fen.low); writer->u64(value.reserved_fen.high);
  writer->u64(value.total_fen.low); writer->u64(value.total_fen.high);
}

bool encode_result(citizensdk_result_handle_t result, uint64_t prepared_token,
                   WireWriter *writer,
                   citizensdk_prepared_wallet_handle_t *prepared, bool *qr_review, bool *inspection) {
  const bool requested_inspection = inspection != nullptr && *inspection;
  if (inspection != nullptr) *inspection = false;
  *prepared = 0;
  *qr_review = false;
  auto info = info_value<citizensdk_result_info_t>();
  if (citizensdk_result_get_info(result, &info) != kOk) {
    write_internal_decode_failure(writer);
    return true;
  }
  std::vector<uint8_t> message;
  if (!copy_error(result, &message)) {
    write_internal_decode_failure(writer);
    return true;
  }
  if (info.error_code != kOk) {
    citizensdk_failure_stage_t stage = 0;
    if (citizensdk_result_get_failure_stage(result, &stage) != kOk) {
      write_internal_decode_failure(writer);
      return true;
    }
    write_failure(writer, info.error_code, stage, info.kind, message);
    return true;
  }

  WireWriter payload;
  bool valid = true;
  switch (info.kind) {
    case CITIZENSDK_RESULT_EMPTY:
      break;
    case CITIZENSDK_RESULT_BLOCK_REF: {
      auto block = info_value<citizensdk_block_ref_t>();
      valid = citizensdk_result_get_block_ref(result, &block) == kOk;
      if (valid) write_block(&payload, block);
      break;
    }
    case CITIZENSDK_RESULT_STORAGE_VALUE: {
      uint8_t present = 0;
      uint64_t required = 0;
      valid = citizensdk_result_copy_storage(result, &present, nullptr, 0, &required) == kOk &&
              required <= 64U * 1024U * 1024U;
      std::vector<uint8_t> bytes(valid ? static_cast<size_t>(required) : 0);
      if (valid) valid = citizensdk_result_copy_storage(
          result, &present, bytes.empty() ? nullptr : bytes.data(), required, &required) == kOk &&
          required == bytes.size() && present <= 1;
      if (valid) {
        payload.u8(present);
        if (present != 0) payload.bytes(bytes.data(), bytes.size());
      }
      break;
    }
    case CITIZENSDK_RESULT_STORAGE_BATCH: {
      uint32_t count = 0;
      valid = citizensdk_result_get_storage_batch_count(result, &count) == kOk && count <= 1024;
      if (valid) payload.u32(count);
      uint64_t total = 0;
      for (uint32_t index = 0; valid && index < count; ++index) {
        uint8_t present = 0;
        uint64_t required = 0;
        valid = citizensdk_result_copy_storage_batch_item(
            result, index, &present, nullptr, 0, &required) == kOk && present <= 1;
        valid = valid && required <= 64U * 1024U * 1024U - total;
        if (valid) total += required;
        std::vector<uint8_t> bytes(valid ? static_cast<size_t>(required) : 0);
        if (valid) valid = citizensdk_result_copy_storage_batch_item(
            result, index, &present, bytes.empty() ? nullptr : bytes.data(), required, &required) == kOk &&
            required == bytes.size();
        if (valid) {
          payload.u8(present);
          if (present != 0) payload.bytes(bytes.data(), bytes.size());
        }
      }
      break;
    }
    case CITIZENSDK_RESULT_RUNTIME_CONTEXT: {
      auto value = info_value<citizensdk_runtime_context_info_t>();
      uint64_t required = 0;
      valid = citizensdk_result_get_runtime_context(result, &value, nullptr, 0, &required) == kOk &&
              required > 0 && required <= 64U * 1024U * 1024U;
      std::vector<uint8_t> metadata(valid ? static_cast<size_t>(required) : 0);
      if (valid) valid = citizensdk_result_get_runtime_context(
          result, &value, metadata.data(), required, &required) == kOk && required == metadata.size();
      if (valid) {
        write_block(&payload, value.block);
        payload.u32(value.spec_version);
        payload.u32(value.transaction_version);
        payload.bytes(metadata.data(), metadata.size());
      }
      break;
    }
    case CITIZENSDK_RESULT_EXPORTED_STATE: {
      auto value = info_value<citizensdk_exported_state_info_t>();
      uint64_t required = 0;
      valid = citizensdk_result_get_exported_state(result, &value, nullptr, 0, &required) == kOk &&
              required > 0 && required <= 256U * 1024U;
      std::vector<uint8_t> database(valid ? static_cast<size_t>(required) : 0);
      if (valid) valid = citizensdk_result_get_exported_state(
          result, &value, database.data(), required, &required) == kOk && required == database.size();
      if (valid) {
        payload.u32(value.format_version);
        write_block(&payload, value.finalized);
        payload.bytes(database.data(), database.size());
      }
      break;
    }
    case CITIZENSDK_RESULT_ACCOUNT_BALANCE: {
      auto value = info_value<citizensdk_account_balance_info_t>();
      valid = citizensdk_result_get_account_balance(result, &value) == kOk;
      if (valid) write_balance(&payload, value);
      break;
    }
    case CITIZENSDK_RESULT_ACCOUNT_BALANCES: {
      uint32_t count = 0;
      valid = citizensdk_result_get_account_balance_count(result, &count) == kOk && count <= 1990;
      if (valid) payload.u32(count);
      for (uint32_t index = 0; valid && index < count; ++index) {
        auto value = info_value<citizensdk_account_balance_info_t>();
        valid = citizensdk_result_get_account_balance_at(result, index, &value) == kOk;
        if (valid) write_balance(&payload, value);
      }
      break;
    }
    case CITIZENSDK_RESULT_ACCOUNT_NONCE: {
      auto value = info_value<citizensdk_account_nonce_info_t>();
      valid = citizensdk_result_get_account_nonce(result, &value) == kOk;
      if (valid) {
        write_block(&payload, value.best_block);
        payload.fixed(value.account_id.bytes, 32);
        payload.u64(value.nonce);
      }
      break;
    }
    case CITIZENSDK_RESULT_FEE_SNAPSHOT: {
      auto value = info_value<citizensdk_fee_snapshot_info_t>();
      valid = citizensdk_result_get_fee_snapshot(result, &value) == kOk;
      if (valid) {
        write_block(&payload, value.best_block);
        payload.u32(value.fee_rate_parts);
        payload.u64(value.minimum_fee_fen.low); payload.u64(value.minimum_fee_fen.high);
        payload.u64(value.existential_deposit_fen.low); payload.u64(value.existential_deposit_fen.high);
      }
      break;
    }
    case CITIZENSDK_RESULT_WALLET_PROFILE:
      valid = write_wallet_profile(result, &payload);
      break;
    case CITIZENSDK_RESULT_WALLET_ACCOUNTS:
      valid = write_wallet_accounts(result, &payload);
      break;
    case CITIZENSDK_RESULT_SIGNATURE: {
      uint8_t signature[64]{};
      valid = citizensdk_result_get_signature(result, signature) == kOk;
      if (valid) payload.fixed(signature, sizeof(signature));
      std::memset(signature, 0, sizeof(signature));
      break;
    }
    case CITIZENSDK_RESULT_PREPARED_WALLET: {
      auto value = info_value<citizensdk_prepared_wallet_info_t>();
      const bool copied = citizensdk_result_get_prepared_wallet(result, &value) == kOk;
      if (copied) {
        *prepared = value.prepared_wallet;
      }
      valid = copied && prepared_token != 0;
      if (valid) {
        payload.u64(prepared_token);
      }
      break;
    }
    case CITIZENSDK_RESULT_TRANSACTION_HISTORY_PAGE:
      valid = write_transaction_history_page(result, &payload);
      break;
    case CITIZENSDK_RESULT_QR_REVIEW:
    case CITIZENSDK_RESULT_QR_SIGNED: {
      uint64_t required = 0;
      valid = citizensdk_result_copy_qr(result, nullptr, 0, &required) == kOk && required > 0 && required <= 65536;
      std::vector<uint8_t> json(valid ? static_cast<size_t>(required) : 0);
      if (valid) valid = citizensdk_result_copy_qr(result, json.data(), required, &required) == kOk && required == json.size();
      if (valid && info.kind == CITIZENSDK_RESULT_QR_REVIEW) {
        valid = result > 0 && result <= static_cast<uint64_t>(INT64_MAX);
        if (valid) payload.u64(result);
      }
      if (valid) payload.text(json);
      break;
    }
    case CITIZENSDK_RESULT_WALLET_STATE:
      valid = !requested_inspection || (result > 0 && result <= static_cast<uint64_t>(INT64_MAX));
      payload.u64(requested_inspection ? result : 0);
      if (valid) valid = write_wallet_state(result, &payload);
      break;
    case CITIZENSDK_RESULT_SIGNING_OUTCOME:
      valid = write_signing_outcome(result, &payload);
      break;
    case CITIZENSDK_RESULT_DEFAULT_ACCOUNT_CHANGE:
      valid = write_default_account_change(result, &payload);
      break;
    case CITIZENSDK_RESULT_CHAIN_SYNC_STATUS: {
      auto value = info_value<citizensdk_chain_sync_status_info_t>();
      valid = citizensdk_result_get_sync_status(result, &value) == kOk &&
              value.is_syncing <= 1 && value.is_usable <= 1;
      if (valid) {
        payload.u64(value.peer_count);
        payload.u8(value.is_syncing);
        payload.u8(value.is_usable);
        write_block(&payload, value.best);
        write_block(&payload, value.finalized);
      }
      break;
    }
    case CITIZENSDK_RESULT_BLOCK_HEADER: {
      auto value = info_value<citizensdk_block_header_info_t>();
      uint64_t required = 0;
      valid = citizensdk_result_get_block_header(result, &value, nullptr, 0, &required) == kOk &&
              required <= 1024U * 1024U;
      std::vector<uint8_t> digest(valid ? static_cast<size_t>(required) : 0);
      if (valid) valid = citizensdk_result_get_block_header(
          result, &value, digest.empty() ? nullptr : digest.data(), required, &required) == kOk &&
          required == digest.size();
      if (valid) {
        write_block(&payload, value.block);
        payload.fixed(value.parent_hash, 32);
        payload.fixed(value.state_root, 32);
        payload.fixed(value.extrinsics_root, 32);
        payload.bytes(digest.data(), digest.size());
      }
      break;
    }
    case CITIZENSDK_RESULT_BLOCK_BODY: {
      auto value = info_value<citizensdk_block_body_info_t>();
      valid = citizensdk_result_get_block_body_info(result, &value) == kOk &&
              value.extrinsic_count <= 16384 && value.total_bytes <= 64U * 1024U * 1024U;
      if (valid) {
        write_block(&payload, value.block);
        payload.u32(value.extrinsic_count);
      }
      uint64_t total = 0;
      for (uint32_t index = 0; valid && index < value.extrinsic_count; ++index) {
        uint64_t required = 0;
        valid = citizensdk_result_copy_block_body_extrinsic(
            result, index, nullptr, 0, &required) == kOk && required > 0;
        valid = valid && required <= value.total_bytes - total;
        if (valid) total += required;
        std::vector<uint8_t> extrinsic(valid ? static_cast<size_t>(required) : 0);
        if (valid) valid = citizensdk_result_copy_block_body_extrinsic(
            result, index, extrinsic.data(), required, &required) == kOk &&
            required == extrinsic.size();
        if (valid) payload.bytes(extrinsic.data(), extrinsic.size());
      }
      valid = valid && total == value.total_bytes;
      break;
    }
    case CITIZENSDK_RESULT_PREPARED_TRANSACTION: {
      auto value = info_value<citizensdk_prepared_transaction_info_t>();
      valid = citizensdk_result_get_prepared_transaction(result, &value) == kOk &&
              value.prepared_transaction > 0 &&
              value.prepared_transaction <= static_cast<uint64_t>(INT64_MAX) &&
              value.best_block.finality == CITIZENSDK_FINALITY_BEST;
      if (valid) {
        payload.u64(value.prepared_transaction);
        payload.fixed(value.preparation_id, 16);
        payload.fixed(value.source_account_id.bytes, 32);
        payload.fixed(value.call_data_hash, 32);
        write_block(&payload, value.best_block);
        payload.u32(value.runtime_spec_number);
        payload.u32(value.transaction_format_number);
        payload.u64(value.nonce);
      }
      break;
    }
    case CITIZENSDK_RESULT_TRANSACTION_EXECUTION: {
      auto value = info_value<citizensdk_transaction_execution_info_t>();
      uint64_t session_required = 0, request_required = 0, reason_required = 0;
      valid = citizensdk_result_get_transaction_execution(
          result, &value, nullptr, 0, &session_required, nullptr, 0,
          &request_required, nullptr, 0, &reason_required) == kOk &&
          session_required <= 128 && request_required <= kMaxQrTextBytes && reason_required <= 4096;
      std::vector<uint8_t> session(valid ? static_cast<size_t>(session_required) : 0);
      std::vector<uint8_t> request(valid ? static_cast<size_t>(request_required) : 0);
      std::vector<uint8_t> reason(valid ? static_cast<size_t>(reason_required) : 0);
      if (valid) valid = citizensdk_result_get_transaction_execution(
          result, &value, session.empty() ? nullptr : session.data(), session.size(),
          &session_required, request.empty() ? nullptr : request.data(), request.size(),
          &request_required, reason.empty() ? nullptr : reason.data(), reason.size(),
          &reason_required) == kOk;
      if (valid) {
        payload.u32(value.status);
        payload.fixed(value.execution_id, 16);
        payload.fixed(value.source_account_id.bytes, 32);
        payload.fixed(value.call_data_hash, 32);
        payload.fixed(value.transaction_hash, 32);
        payload.u64(value.expires_at);
        const bool has_execution = value.status == CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_SUCCESS ||
                                   value.status == CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_FAILED;
        payload.u8(has_execution ? 1 : 0);
        if (has_execution) {
          citizensdk_execution_info_t execution{};
          execution.status = value.status == CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_SUCCESS ? 1U : 2U;
          execution.reason_or_dispatch_variant = value.dispatch_variant;
          execution.has_block = value.has_block;
          execution.block = value.block;
          execution.has_extrinsic_index = value.has_extrinsic_index;
          execution.extrinsic_index = value.extrinsic_index;
          execution.has_module = value.has_module_failure;
          execution.pallet_index = value.pallet_index;
          execution.error_index = value.error_index;
          write_execution(&payload, execution);
        }
        payload.u8(reason.empty() ? 0 : 1);
        if (!reason.empty()) payload.text(reason);
        payload.u8(value.has_replacement_hash == 0 ? 0 : 1);
        if (value.has_replacement_hash != 0) payload.fixed(value.replacement_hash, 32);
        payload.u8(request.empty() ? 0 : 1);
        if (!request.empty()) payload.text(request);
      }
      break;
    }
    default:
      valid = false;
      break;
  }
  if (!valid) {
    write_internal_decode_failure(writer);
    return true;
  }
  writer->u32(kWireVersion);
  writer->i32(kOk);
  writer->u32(0);
  writer->u32(info.kind);
  writer->text(message);
  writer->fixed(payload.data().data(), payload.data().size());
  *qr_review = info.kind == CITIZENSDK_RESULT_QR_REVIEW;
  if (inspection != nullptr) *inspection = requested_inspection && info.kind == CITIZENSDK_RESULT_WALLET_STATE;
  return true;
}

bool encode_capabilities(citizensdk_handle_t handle, WireWriter *writer) {
  auto snapshot = info_value<citizensdk_capability_snapshot_t>();
  if (citizensdk_get_capabilities(handle, &snapshot) != kOk ||
      snapshot.count != CITIZENSDK_CAPABILITY_COUNT) return false;
  writer->u32(kWireVersion);
  writer->u64(snapshot.revision);
  writer->u32(snapshot.count);
  for (uint32_t index = 0; index < snapshot.count; ++index) {
    const auto &status = snapshot.statuses[index];
    writer->u32(status.name);
    writer->u32(status.reason);
    writer->u8(status.supported); writer->u8(status.available);
    writer->u8(status.enabled); writer->u8(status.ready);
  }
  return true;
}

bool encode_watch(citizensdk_result_handle_t result, WireWriter *writer) {
  auto info = info_value<citizensdk_watch_event_info_t>();
  if (citizensdk_result_get_watch_event(result, &info) != kOk) return false;
  writer->u32(kWireVersion);
  writer->u32(info.status);
  writer->u32(info.peer_count);
  writer->u8(info.has_block == 0 ? 0 : 1);
  if (info.has_block != 0) write_block(writer, info.block);
  writer->u8(info.has_replacement_hash == 0 ? 0 : 1);
  if (info.has_replacement_hash != 0)
    writer->fixed(info.replacement_hash, 32);
  return true;
}

}  // namespace citizen::sdk::jni

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  JNIEnv *env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK)
    return JNI_ERR;
  jclass type = env->FindClass("org/citizen/sdk/internal/CitizenSdkNative");
  if (type == nullptr) return JNI_ERR;
  const jint result = env->RegisterNatives(
      type, citizen::sdk::jni::kMethods,
      static_cast<jint>(sizeof(citizen::sdk::jni::kMethods) /
                        sizeof(citizen::sdk::jni::kMethods[0])));
  env->DeleteLocalRef(type);
  return result == JNI_OK ? JNI_VERSION_1_6 : JNI_ERR;
}
