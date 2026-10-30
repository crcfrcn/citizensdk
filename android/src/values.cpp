// Core结果直接构造实际Kotlin模型；不产生第二份二进制业务协议。
#include "citizensdk_host_bridge.hpp"
#include "citizensdk_jni_support.hpp"
#include <array>
#include <climits>
#include <limits>
#include <string>
#include <vector>

namespace citizen::sdk::jni {
namespace {
struct JavaFailure {};
void checked(JNIEnv *env) {
  if (env->ExceptionCheck())
    throw JavaFailure{};
}
void require(JNIEnv *env, int32_t code) {
  if (code != CITIZENSDK_OK) {
    throw_sdk(env, code, "Core结果读取失败");
    throw JavaFailure{};
  }
}
template <class T> T output() {
  T value{};
  value.struct_size = sizeof(T);
  value.abi_version = CITIZENSDK_ABI_VERSION;
  return value;
}
jclass type(JNIEnv *env, const char *name) {
  auto value = env->FindClass(name);
  checked(env);
  if (!value)
    throw JavaFailure{};
  return value;
}
template <class... A>
jobject model(JNIEnv *env, const char *name, const char *signature, A... args) {
  auto clazz = type(env, (std::string("org/citizen/sdk/") + name).c_str());
  const auto init = env->GetMethodID(clazz, "<init>", signature);
  checked(env);
  auto value = env->NewObject(clazz, init, args...);
  env->DeleteLocalRef(clazz);
  checked(env);
  return value;
}
jstring decimal(JNIEnv *env, uint64_t value) {
  auto out = env->NewStringUTF(std::to_string(value).c_str());
  checked(env);
  return out;
}
jbyteArray bytes(JNIEnv *env, const uint8_t *data, uint64_t length) {
  if (length > INT_MAX) {
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core字节长度超界");
    throw JavaFailure{};
  }
  auto value = env->NewByteArray(static_cast<jsize>(length));
  checked(env);
  if (length)
    env->SetByteArrayRegion(value, 0, static_cast<jsize>(length),
                            reinterpret_cast<const jbyte *>(data));
  checked(env);
  return value;
}
jstring text(JNIEnv *env, const uint8_t *data, uint64_t length) {
  // Java String(byte[], UTF_8)正确处理NUL和非BMP字符，不把UTF-8误当modified
  // UTF-8。
  auto encoded = bytes(env, data, length);
  auto charset = type(env, "java/nio/charset/StandardCharsets");
  auto key =
      env->GetStaticFieldID(charset, "UTF_8", "Ljava/nio/charset/Charset;");
  checked(env);
  auto utf8 = env->GetStaticObjectField(charset, key);
  auto clazz = type(env, "java/lang/String");
  auto init =
      env->GetMethodID(clazz, "<init>", "([BLjava/nio/charset/Charset;)V");
  checked(env);
  auto value = static_cast<jstring>(env->NewObject(clazz, init, encoded, utf8));
  env->DeleteLocalRef(encoded);
  env->DeleteLocalRef(utf8);
  env->DeleteLocalRef(charset);
  env->DeleteLocalRef(clazz);
  checked(env);
  return value;
}
jstring text(JNIEnv *env, const std::vector<uint8_t> &value) {
  return text(env, value.data(), value.size());
}
jstring hex(JNIEnv *env, const uint8_t *data, size_t length) {
  constexpr char digits[] = "0123456789abcdef";
  std::string value = "0x";
  value.reserve(2 + length * 2);
  for (size_t i = 0; i < length; ++i) {
    value += digits[data[i] >> 4];
    value += digits[data[i] & 15];
  }
  auto result = env->NewStringUTF(value.c_str());
  checked(env);
  return result;
}
jobject number(JNIEnv *env, uint64_t value) {
  auto clazz = type(env, "java/lang/Long");
  auto method = env->GetStaticMethodID(clazz, "valueOf", "(J)Ljava/lang/Long;");
  checked(env);
  auto result =
      env->CallStaticObjectMethod(clazz, method, static_cast<jlong>(value));
  env->DeleteLocalRef(clazz);
  checked(env);
  return result;
}
jobject enumeration(JNIEnv *env, const char *name, uint32_t value,
                    uint32_t first = 1) {
  auto full = std::string("org/citizen/sdk/") + name;
  auto clazz = type(env, full.c_str());
  const auto signature = std::string("()[L") + full + ";";
  auto method = env->GetStaticMethodID(clazz, "values", signature.c_str());
  checked(env);
  auto all =
      static_cast<jobjectArray>(env->CallStaticObjectMethod(clazz, method));
  checked(env);
  auto count = env->GetArrayLength(all);
  if (value < first || value - first >= static_cast<uint32_t>(count)) {
    env->DeleteLocalRef(all);
    env->DeleteLocalRef(clazz);
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core枚举值超界");
    throw JavaFailure{};
  }
  auto result =
      env->GetObjectArrayElement(all, static_cast<jsize>(value - first));
  env->DeleteLocalRef(all);
  env->DeleteLocalRef(clazz);
  checked(env);
  return result;
}
struct List {
  JNIEnv *env;
  jobject value;
  jmethodID add;
  explicit List(JNIEnv *environment, uint32_t capacity) : env(environment) {
    if (capacity > INT_MAX) {
      throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core列表长度超界");
      throw JavaFailure{};
    }
    auto clazz = type(env, "java/util/ArrayList");
    auto init = env->GetMethodID(clazz, "<init>", "(I)V");
    add = env->GetMethodID(clazz, "add", "(Ljava/lang/Object;)Z");
    checked(env);
    value = env->NewObject(clazz, init, static_cast<jint>(capacity));
    env->DeleteLocalRef(clazz);
    checked(env);
  }
  void push(jobject item) {
    env->CallBooleanMethod(value, add, item);
    checked(env);
  }
};
struct Local {
  JNIEnv *env;
  explicit Local(JNIEnv *value) : env(value) {
    if (env->PushLocalFrame(64) < 0)
      throw JavaFailure{};
  }
  ~Local() { env->PopLocalFrame(nullptr); }
};
template <class Call>
std::vector<uint8_t> copy(JNIEnv *env, Call call,
                          uint64_t maximum = 64U * 1024U * 1024U) {
  uint64_t size = 0;
  require(env, call(nullptr, 0, &size));
  if (size > maximum || size > INT_MAX) {
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core缓冲长度超界");
    throw JavaFailure{};
  }
  std::vector<uint8_t> value(static_cast<size_t>(size));
  require(env, call(value.empty() ? nullptr : value.data(), size, &size));
  if (size != value.size()) {
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core缓冲长度变化");
    throw JavaFailure{};
  }
  return value;
}
jobject block(JNIEnv *env, const citizensdk_block_ref_t &value) {
  return model(env, "CitizenBlockRef",
               "([BLjava/lang/String;Lorg/citizen/sdk/CitizenFinality;)V",
               bytes(env, value.hash, 32), decimal(env, value.number),
               enumeration(env, "CitizenFinality", value.finality));
}
jobject amount(JNIEnv *env, const citizensdk_u128_t &value) {
  std::array<uint8_t, 16> magnitude{};
  for (size_t i = 0; i < 8; ++i) {
    magnitude[15 - i] = static_cast<uint8_t>(value.low >> (i * 8));
    magnitude[7 - i] = static_cast<uint8_t>(value.high >> (i * 8));
  }
  auto clazz = type(env, "java/math/BigInteger");
  auto init = env->GetMethodID(clazz, "<init>", "(I[B)V");
  auto method = env->GetMethodID(clazz, "toString", "()Ljava/lang/String;");
  checked(env);
  auto integer = env->NewObject(clazz, init, 1,
                                bytes(env, magnitude.data(), magnitude.size()));
  checked(env);
  auto decimalValue =
      static_cast<jstring>(env->CallObjectMethod(integer, method));
  checked(env);
  auto result =
      model(env, "CitizenU128", "(Ljava/lang/String;)V", decimalValue);
  env->DeleteLocalRef(clazz);
  env->DeleteLocalRef(integer);
  return result;
}
jobject balance(JNIEnv *env, const citizensdk_account_balance_info_t &value) {
  return model(
      env, "CitizenAccountBalance",
      "(Lorg/citizen/sdk/CitizenBlockRef;[BLorg/citizen/sdk/CitizenU128;Lorg/"
      "citizen/sdk/CitizenU128;Lorg/citizen/sdk/CitizenU128;)V",
      block(env, value.block), bytes(env, value.account_id.bytes, 32),
      amount(env, value.free_fen), amount(env, value.reserved_fen),
      amount(env, value.total_fen));
}
jobject execution(JNIEnv *env, const citizensdk_execution_info_t &value) {
  return model(
      env, "CitizenExecution",
      "(Lorg/citizen/sdk/CitizenExecutionStatus;JLorg/citizen/sdk/"
      "CitizenBlockRef;Ljava/lang/Long;Ljava/lang/Long;Ljava/lang/Long;)V",
      enumeration(env, "CitizenExecutionStatus", value.status),
      static_cast<jlong>(value.reason_or_dispatch_variant),
      value.has_block ? block(env, value.block) : nullptr,
      value.has_extrinsic_index ? number(env, value.extrinsic_index) : nullptr,
      value.has_module ? number(env, value.pallet_index) : nullptr,
      value.has_module ? number(env, value.error_index) : nullptr);
}
jobject profile(JNIEnv *env, uint64_t result) {
  auto info = output<citizensdk_wallet_profile_info_t>();
  require(env, citizensdk_result_get_wallet_profile(result, &info));
  if (!info.present)
    return nullptr;
  List accounts(env, info.account_count);
  for (uint32_t i = 0; i < info.account_count; ++i) {
    Local local(env);
    auto value = output<citizensdk_wallet_account_info_t>();
    uint64_t addressSize = 0, nameSize = 0;
    require(env, citizensdk_result_get_wallet_account(result, i, &value,
                                                      nullptr, 0, &addressSize,
                                                      nullptr, 0, &nameSize));
    if (addressSize > 128 || nameSize > 120) {
      throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core账户文本超界");
      throw JavaFailure{};
    }
    std::vector<uint8_t> address(static_cast<size_t>(addressSize)),
        name(static_cast<size_t>(nameSize));
    require(env, citizensdk_result_get_wallet_account(
                     result, i, &value, address.data(), addressSize,
                     &addressSize, name.data(), nameSize, &nameSize));
    accounts.push(model(
        env, "CitizenWalletAccount",
        "(J[BLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Z)V",
        static_cast<jlong>(value.index), bytes(env, value.account_id.bytes, 32),
        text(env, address), name.empty() ? nullptr : text(env, name),
        decimal(env, value.created_at_millis),
        static_cast<jboolean>(value.is_active)));
  }
  auto name = copy(
      env,
      [&](auto b, auto n, auto r) {
        return citizensdk_wallet_profile_copy_name(result, b, n, r);
      },
      120);
  return model(env, "CitizenWalletProfile",
               "(Lorg/citizen/sdk/CitizenWalletOrigin;JLjava/lang/"
               "String;[B[BLjava/util/List;Ljava/lang/String;)V",
               enumeration(env, "CitizenWalletOrigin", info.origin),
               static_cast<jlong>(info.wallet_index),
               decimal(env, info.created_at_millis),
               bytes(env, info.master_account_id.bytes, 32),
               bytes(env, info.active_account_id.bytes, 32), accounts.value,
               text(env, name));
}
jobject wallet(JNIEnv *env, uint64_t result) {
  auto info = output<citizensdk_wallet_state_info_t>();
  require(env, citizensdk_result_get_wallet_state(result, &info));
  List accounts(env, info.account_count);
  for (uint32_t i = 0; i < info.account_count; ++i) {
    Local local(env);
    auto value = output<citizensdk_wallet_state_account_info_t>();
    uint64_t addressSize = 0, nameSize = 0;
    require(env, citizensdk_result_get_wallet_state_account(
                     result, i, &value, nullptr, 0, &addressSize, nullptr, 0,
                     &nameSize));
    if (addressSize > 128 || nameSize > 120) {
      throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core账户文本超界");
      throw JavaFailure{};
    }
    std::vector<uint8_t> address(static_cast<size_t>(addressSize)),
        name(static_cast<size_t>(nameSize));
    require(env, citizensdk_result_get_wallet_state_account(
                     result, i, &value, address.data(), addressSize,
                     &addressSize, name.data(), nameSize, &nameSize));
    accounts.push(model(
        env, "CitizenWalletStateAccount",
        "(Lorg/citizen/sdk/CitizenWalletSignMode;JLjava/lang/Long;[BLjava/lang/"
        "String;Ljava/lang/String;Ljava/lang/String;Z)V",
        enumeration(env, "CitizenWalletSignMode", value.sign_mode),
        static_cast<jlong>(value.wallet_index),
        value.has_account_index ? number(env, value.account_index) : nullptr,
        bytes(env, value.account_id.bytes, 32), text(env, address),
        text(env, name), decimal(env, value.created_at_millis),
        static_cast<jboolean>(value.is_default)));
  }
  uint32_t initialization = 0, count = 0, selected = 0;
  uint8_t pending = 0, present = 0;
  require(env, citizensdk_wallet_state_get_initialization(
                   result, &initialization, &pending));
  require(env, citizensdk_wallet_state_get_active_wallet(result, &present,
                                                         &selected));
  require(env, citizensdk_wallet_state_get_diagnostic_count(result, &count));
  List diagnostics(env, count);
  for (uint32_t i = 0; i < count; ++i) {
    Local local(env);
    auto value = output<citizensdk_wallet_diagnostic_info_v1_t>();
    require(env, citizensdk_wallet_state_get_diagnostic_at(result, i, &value));
    auto name = copy(
        env,
        [&](auto b, auto n, auto r) {
          return citizensdk_wallet_state_copy_diagnostic_text(result, i, 1, b,
                                                              n, r);
        },
        120);
    std::vector<uint8_t> address;
    if (value.has_ss58_address)
      address = copy(
          env,
          [&](auto b, auto n, auto r) {
            return citizensdk_wallet_state_copy_diagnostic_text(result, i, 2, b,
                                                                n, r);
          },
          128);
    jobject cleanup = nullptr;
    if (value.cleanup_account_count || value.delete_wallet_wide_key) {
      List identities(env, value.cleanup_account_count);
      for (uint32_t j = 0; j < value.cleanup_account_count; ++j) {
        Local item(env);
        citizensdk_account_id_t id{};
        require(env, citizensdk_wallet_state_get_diagnostic_cleanup_account(
                         result, i, j, &id));
        identities.push(bytes(env, id.bytes, 32));
      }
      cleanup = model(env, "CitizenWalletCleanupTargets",
                      "(Ljava/util/List;Z)V", identities.value,
                      static_cast<jboolean>(value.delete_wallet_wide_key));
    }
    diagnostics.push(model(
        env, "CitizenWalletDiagnostic",
        "(JLjava/lang/String;[BLjava/lang/String;ILorg/citizen/sdk/"
        "CitizenWalletSignMode;Lorg/citizen/sdk/CitizenWalletCleanupTargets;)V",
        static_cast<jlong>(value.wallet_index), text(env, name),
        bytes(env, value.account_id.bytes, 32),
        value.has_ss58_address ? text(env, address) : nullptr,
        static_cast<jint>(value.diagnostic_reason),
        value.sign_mode
            ? enumeration(env, "CitizenWalletSignMode", value.sign_mode)
            : nullptr,
        cleanup));
  }
  return model(env, "CitizenWalletState",
               "(Ljava/lang/String;Lorg/citizen/sdk/CitizenWalletProfile;Ljava/"
               "util/List;IZLjava/lang/Long;Ljava/util/List;)V",
               decimal(env, info.revision), profile(env, result),
               accounts.value, static_cast<jint>(initialization),
               static_cast<jboolean>(pending),
               present ? number(env, selected) : nullptr, diagnostics.value);
}
jobject signing(JNIEnv *env, uint64_t result, bool change) {
  uint32_t status = 0, transport = 0;
  uint64_t expires = 0, revision = 0;
  const uint8_t *account = nullptr;
  const uint8_t *hash = nullptr;
  auto normal = output<citizensdk_signing_outcome_info_t>();
  auto next = output<citizensdk_default_account_change_info_t>();
  uint64_t signatureSize = 0, sessionSize = 0, requestSize = 0;
  if (change) {
    require(env, citizensdk_result_get_default_account_change(
                     result, &next, nullptr, 0, &sessionSize, nullptr, 0,
                     &requestSize));
    status = next.status;
    transport = next.transport;
    expires = next.expires_at;
    revision = next.committed_revision;
    account = next.current_default_account_id.bytes;
    hash = next.payload_hash;
  } else {
    require(env, citizensdk_result_get_signing_outcome(
                     result, &normal, nullptr, 0, &signatureSize, nullptr, 0,
                     &sessionSize, nullptr, 0, &requestSize));
    status = normal.status;
    transport = normal.transport;
    expires = normal.expires_at;
    account = normal.account_id.bytes;
    hash = normal.payload_hash;
  }
  if (signatureSize > 64 || sessionSize > 128 || requestSize > 2331) {
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core签名文本超界");
    throw JavaFailure{};
  }
  std::vector<uint8_t> signature(static_cast<size_t>(signatureSize)),
      session(static_cast<size_t>(sessionSize)),
      request(static_cast<size_t>(requestSize));
  if (change)
    require(env, citizensdk_result_get_default_account_change(
                     result, &next, session.data(), sessionSize, &sessionSize,
                     request.data(), requestSize, &requestSize));
  else
    require(env, citizensdk_result_get_signing_outcome(
                     result, &normal, signature.data(), signatureSize,
                     &signatureSize, session.data(), sessionSize, &sessionSize,
                     request.data(), requestSize, &requestSize));
  auto id = bytes(env, account, 32), digest = bytes(env, hash, 32);
  const char *prefix =
      change ? "CitizenDefaultAccountChangeOutcome$" : "CitizenSigningOutcome$";
  if (status == CITIZENSDK_SIGNING_COMPLETED) {
    if (change)
      return model(env, (std::string(prefix) + "Completed").c_str(),
                   "([B[BLjava/lang/String;)V", id, digest,
                   decimal(env, revision));
    return model(env, (std::string(prefix) + "Completed").c_str(),
                 "([B[BLorg/citizen/sdk/CitizenSignature;)V", id, digest,
                 model(env, "CitizenSignature", "([B)V",
                       bytes(env, signature.data(), signature.size())));
  }
  return model(env, (std::string(prefix) + "ExternalPending").c_str(),
               "([B[BLorg/citizen/sdk/CitizenExternalSignerTransport;Ljava/"
               "lang/String;Ljava/lang/String;Ljava/lang/String;)V",
               id, digest,
               enumeration(env, "CitizenExternalSignerTransport", transport),
               decimal(env, expires), text(env, session), text(env, request));
}
jobject history(JNIEnv *env, uint64_t result) {
  auto page = output<citizensdk_transaction_history_page_info_t>();
  require(env, citizensdk_result_get_transaction_history_page(result, &page));
  List records(env, page.record_count);
  for (uint32_t i = 0; i < page.record_count; ++i) {
    Local local(env);
    auto item = output<citizensdk_transaction_history_record_info_t>();
    auto reason = copy(
        env,
        [&](auto b, auto n, auto r) {
          return citizensdk_result_get_transaction_history_record(
              result, i, &item, b, n, r);
        },
        4096);
    records.push(model(
        env, "CitizenTransactionHistoryRecord",
        "([B[B[B[BLorg/citizen/sdk/CitizenTransactionHistoryStatus;Lorg/"
        "citizen/sdk/CitizenBlockRef;Lorg/citizen/sdk/CitizenExecution;[BLjava/"
        "lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        bytes(env, item.execution_id.bytes, 16),
        bytes(env, item.source_account_id.bytes, 32),
        bytes(env, item.call_data_hash, 32),
        bytes(env, item.transaction_hash, 32),
        enumeration(env, "CitizenTransactionHistoryStatus", item.status),
        item.has_block ? block(env, item.block) : nullptr,
        item.has_execution ? execution(env, item.execution) : nullptr,
        item.has_replacement_hash ? bytes(env, item.replacement_hash, 32)
                                  : nullptr,
        decimal(env, item.created_at_millis),
        decimal(env, item.updated_at_millis),
        reason.empty() ? nullptr : text(env, reason)));
  }
  return model(env, "CitizenTransactionHistoryPage",
               "(Ljava/lang/String;Ljava/util/List;[B)V",
               decimal(env, page.revision), records.value,
               page.has_next_before_execution_id
                   ? bytes(env, page.next_before_execution_id.bytes, 16)
                   : nullptr);
}
jobject transaction(JNIEnv *env, uint64_t result) {
  auto value = output<citizensdk_transaction_execution_info_t>();
  uint64_t sessionSize = 0, requestSize = 0, reasonSize = 0;
  require(env, citizensdk_result_get_transaction_execution(
                   result, &value, nullptr, 0, &sessionSize, nullptr, 0,
                   &requestSize, nullptr, 0, &reasonSize));
  if (sessionSize > 128 || requestSize > 2331 || reasonSize > 4096) {
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core交易文本超界");
    throw JavaFailure{};
  }
  std::vector<uint8_t> session(static_cast<size_t>(sessionSize)),
      request(static_cast<size_t>(requestSize)),
      reason(static_cast<size_t>(reasonSize));
  require(env, citizensdk_result_get_transaction_execution(
                   result, &value, session.data(), sessionSize, &sessionSize,
                   request.data(), requestSize, &requestSize, reason.data(),
                   reasonSize, &reasonSize));
  auto id = hex(env, value.execution_id, 16);
  auto source = bytes(env, value.source_account_id.bytes, 32);
  auto hash = bytes(env, value.call_data_hash, 32);
  if (value.status == CITIZENSDK_TRANSACTION_EXECUTION_EXTERNAL_PENDING)
    return model(
        env, "CitizenTransactionExecution$ExternalSigningPending",
        "(Ljava/lang/String;[B[BLjava/lang/String;Ljava/lang/String;)V", id,
        source, hash, decimal(env, value.expires_at), text(env, request));
  jobject conclusion = nullptr;
  if (value.status != CITIZENSDK_TRANSACTION_EXECUTION_POOL_REJECTED) {
    auto info = output<citizensdk_execution_info_t>();
    info.status =
        value.status == CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_SUCCESS
            ? CITIZENSDK_EXECUTION_SUCCESS
            : CITIZENSDK_EXECUTION_FAILED;
    info.reason_or_dispatch_variant = value.dispatch_variant;
    info.has_block = value.has_block;
    info.block = value.block;
    info.has_extrinsic_index = value.has_extrinsic_index;
    info.extrinsic_index = value.extrinsic_index;
    info.has_module = static_cast<uint8_t>(value.has_module_failure);
    info.pallet_index = value.pallet_index;
    info.error_index = value.error_index;
    conclusion = execution(env, info);
  }
  return model(
      env, "CitizenTransactionExecution$Completed",
      "(Ljava/lang/String;[B[B[BLorg/citizen/sdk/"
      "CitizenTransactionResolution;Lorg/citizen/sdk/CitizenExecution;Ljava/"
      "lang/String;[B)V",
      id, source, hash, bytes(env, value.transaction_hash, 32),
      enumeration(env, "CitizenTransactionResolution", value.status - 1),
      conclusion, reason.empty() ? nullptr : text(env, reason),
      value.has_replacement_hash ? bytes(env, value.replacement_hash, 32)
                                 : nullptr);
}
void failure(JNIEnv *env, uint64_t result, int32_t code) {
  auto message = copy(
      env,
      [&](auto b, auto n, auto r) {
        return citizensdk_result_copy_error_message(result, b, n, r);
      },
      65536);
  citizensdk_failure_stage_t stage = 0;
  require(env, citizensdk_result_get_failure_stage(result, &stage));
  auto exception = model(
      env, "CitizenSdkException",
      "(Lorg/citizen/sdk/CitizenSdkErrorCode;Ljava/lang/String;Ljava/lang/"
      "Throwable;Lorg/citizen/sdk/CitizenSdkFailureStage;Ljava/lang/"
      "String;Ljava/lang/String;Ljava/lang/Long;)V",
      enumeration(env, "CitizenSdkErrorCode", static_cast<uint32_t>(code), 0),
      text(env, message), nullptr,
      enumeration(env, "CitizenSdkFailureStage", stage), nullptr, nullptr,
      nullptr);
  env->Throw(static_cast<jthrowable>(exception));
  throw JavaFailure{};
}
jobject result_value(JNIEnv *env, CitizenSdkHostBridge *bridge,
                     uint64_t result) {
  auto info = output<citizensdk_result_info_t>();
  require(env, citizensdk_result_get_info(result, &info));
  if (info.error_code != CITIZENSDK_OK)
    failure(env, result, info.error_code);
  switch (info.kind) {
  case CITIZENSDK_RESULT_EMPTY: {
    auto clazz = type(env, "kotlin/Unit");
    auto field = env->GetStaticFieldID(clazz, "INSTANCE", "Lkotlin/Unit;");
    checked(env);
    auto value = env->GetStaticObjectField(clazz, field);
    env->DeleteLocalRef(clazz);
    checked(env);
    return value;
  }
  case CITIZENSDK_RESULT_BLOCK_REF: {
    auto value = output<citizensdk_block_ref_t>();
    require(env, citizensdk_result_get_block_ref(result, &value));
    return block(env, value);
  }
  case CITIZENSDK_RESULT_STORAGE_VALUE: {
    uint8_t present = 0;
    auto value = copy(env, [&](auto b, auto n, auto r) {
      return citizensdk_result_copy_storage(result, &present, b, n, r);
    });
    return present ? bytes(env, value.data(), value.size()) : nullptr;
  }
  case CITIZENSDK_RESULT_STORAGE_BATCH: {
    uint32_t count = 0;
    require(env, citizensdk_result_get_storage_batch_count(result, &count));
    List values(env, count);
    for (uint32_t i = 0; i < count; ++i) {
      Local local(env);
      uint8_t present = 0;
      auto value = copy(env, [&](auto b, auto n, auto r) {
        return citizensdk_result_copy_storage_batch_item(result, i, &present, b,
                                                         n, r);
      });
      values.push(present ? bytes(env, value.data(), value.size()) : nullptr);
    }
    return values.value;
  }
  case CITIZENSDK_RESULT_RUNTIME_CONTEXT: {
    auto value = output<citizensdk_runtime_context_info_t>();
    auto metadata = copy(env, [&](auto b, auto n, auto r) {
      return citizensdk_result_get_runtime_context(result, &value, b, n, r);
    });
    return model(env, "CitizenRuntimeContext",
                 "(Lorg/citizen/sdk/CitizenBlockRef;JJ[B)V",
                 block(env, value.block),
                 static_cast<jlong>(value.spec_version),
                 static_cast<jlong>(value.transaction_version),
                 bytes(env, metadata.data(), metadata.size()));
  }
  case CITIZENSDK_RESULT_EXPORTED_STATE: {
    auto value = output<citizensdk_exported_state_info_t>();
    auto database = copy(
        env,
        [&](auto b, auto n, auto r) {
          return citizensdk_result_get_exported_state(result, &value, b, n, r);
        },
        256U * 1024U);
    return model(
        env, "CitizenChainState", "(JLorg/citizen/sdk/CitizenBlockRef;[B)V",
        static_cast<jlong>(value.format_version), block(env, value.finalized),
        bytes(env, database.data(), database.size()));
  }
  case CITIZENSDK_RESULT_ACCOUNT_BALANCE: {
    auto value = output<citizensdk_account_balance_info_t>();
    require(env, citizensdk_result_get_account_balance(result, &value));
    return balance(env, value);
  }
  case CITIZENSDK_RESULT_ACCOUNT_NONCE: {
    auto value = output<citizensdk_account_nonce_info_t>();
    require(env, citizensdk_result_get_account_nonce(result, &value));
    return model(env, "CitizenAccountNonce",
                 "(Lorg/citizen/sdk/CitizenBlockRef;[BLjava/lang/String;)V",
                 block(env, value.best_block),
                 bytes(env, value.account_id.bytes, 32),
                 decimal(env, value.nonce));
  }
  case CITIZENSDK_RESULT_FEE_SNAPSHOT: {
    auto value = output<citizensdk_fee_snapshot_info_t>();
    require(env, citizensdk_result_get_fee_snapshot(result, &value));
    return model(env, "CitizenFeeSnapshot",
                 "(Lorg/citizen/sdk/CitizenBlockRef;JLorg/citizen/sdk/"
                 "CitizenU128;Lorg/citizen/sdk/CitizenU128;)V",
                 block(env, value.best_block),
                 static_cast<jlong>(value.fee_rate_parts),
                 amount(env, value.minimum_fee_fen),
                 amount(env, value.existential_deposit_fen));
  }
  case CITIZENSDK_RESULT_WALLET_PROFILE:
    return profile(env, result);
  case CITIZENSDK_RESULT_WALLET_ACCOUNTS: {
    uint32_t count = 0;
    require(env, citizensdk_result_get_wallet_account_count(result, &count));
    List accounts(env, count);
    for (uint32_t i = 0; i < count; ++i) {
      Local local(env);
      auto value = output<citizensdk_wallet_account_info_t>();
      uint64_t addressSize = 0, nameSize = 0;
      require(env, citizensdk_result_get_wallet_account(
                       result, i, &value, nullptr, 0, &addressSize, nullptr, 0,
                       &nameSize));
      if (addressSize > 128 || nameSize > 120) {
        throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core账户文本超界");
        throw JavaFailure{};
      }
      std::vector<uint8_t> address(static_cast<size_t>(addressSize)),
          name(static_cast<size_t>(nameSize));
      require(env, citizensdk_result_get_wallet_account(
                       result, i, &value, address.data(), addressSize,
                       &addressSize, name.data(), nameSize, &nameSize));
      accounts.push(
          model(env, "CitizenWalletAccount",
                "(J[BLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Z)V",
                static_cast<jlong>(value.index),
                bytes(env, value.account_id.bytes, 32), text(env, address),
                name.empty() ? nullptr : text(env, name),
                decimal(env, value.created_at_millis),
                static_cast<jboolean>(value.is_active)));
    }
    return accounts.value;
  }
  case CITIZENSDK_RESULT_SIGNATURE: {
    std::array<uint8_t, 64> value{};
    require(env, citizensdk_result_get_signature(result, value.data()));
    return model(env, "CitizenSignature", "([B)V",
                 bytes(env, value.data(), value.size()));
  }
  case CITIZENSDK_RESULT_PREPARED_WALLET: {
    auto value = output<citizensdk_prepared_wallet_info_t>();
    require(env, citizensdk_result_get_prepared_wallet(result, &value));
    bridge->remember_prepared(value.prepared_wallet, value.prepared_wallet);
    return number(env, value.prepared_wallet);
  }
  case CITIZENSDK_RESULT_TRANSACTION_HISTORY_PAGE:
    return history(env, result);
  case CITIZENSDK_RESULT_ACCOUNT_BALANCES: {
    uint32_t count = 0;
    require(env, citizensdk_result_get_account_balance_count(result, &count));
    List values(env, count);
    for (uint32_t i = 0; i < count; ++i) {
      Local local(env);
      auto value = output<citizensdk_account_balance_info_t>();
      require(env, citizensdk_result_get_account_balance_at(result, i, &value));
      values.push(balance(env, value));
    }
    return values.value;
  }
  case CITIZENSDK_RESULT_QR_REVIEW:
  case CITIZENSDK_RESULT_QR_SIGNED:
    return text(env, copy(
                         env,
                         [&](auto b, auto n, auto r) {
                           return citizensdk_result_copy_qr(result, b, n, r);
                         },
                         65536));
  case CITIZENSDK_RESULT_WALLET_STATE:
    return wallet(env, result);
  case CITIZENSDK_RESULT_SIGNING_OUTCOME:
    return signing(env, result, false);
  case CITIZENSDK_RESULT_DEFAULT_ACCOUNT_CHANGE:
    return signing(env, result, true);
  case CITIZENSDK_RESULT_CHAIN_SYNC_STATUS: {
    auto value = output<citizensdk_chain_sync_status_info_t>();
    require(env, citizensdk_result_get_sync_status(result, &value));
    return model(env, "CitizenChainSyncStatus",
                 "(Ljava/lang/String;ZZLorg/citizen/sdk/CitizenBlockRef;Lorg/"
                 "citizen/sdk/CitizenBlockRef;)V",
                 decimal(env, value.peer_count),
                 static_cast<jboolean>(value.is_syncing),
                 static_cast<jboolean>(value.is_usable), block(env, value.best),
                 block(env, value.finalized));
  }
  case CITIZENSDK_RESULT_BLOCK_HEADER: {
    auto value = output<citizensdk_block_header_info_t>();
    auto digest = copy(
        env,
        [&](auto b, auto n, auto r) {
          return citizensdk_result_get_block_header(result, &value, b, n, r);
        },
        1024U * 1024U);
    return model(env, "CitizenBlockHeader",
                 "(Lorg/citizen/sdk/CitizenBlockRef;[B[B[B[B)V",
                 block(env, value.block), bytes(env, value.parent_hash, 32),
                 bytes(env, value.state_root, 32),
                 bytes(env, value.extrinsics_root, 32),
                 bytes(env, digest.data(), digest.size()));
  }
  case CITIZENSDK_RESULT_BLOCK_BODY: {
    auto value = output<citizensdk_block_body_info_t>();
    require(env, citizensdk_result_get_block_body_info(result, &value));
    List extrinsics(env, value.extrinsic_count);
    for (uint32_t i = 0; i < value.extrinsic_count; ++i) {
      Local local(env);
      auto item = copy(env, [&](auto b, auto n, auto r) {
        return citizensdk_result_copy_block_body_extrinsic(result, i, b, n, r);
      });
      extrinsics.push(bytes(env, item.data(), item.size()));
    }
    return model(env, "CitizenBlockBody",
                 "(Lorg/citizen/sdk/CitizenBlockRef;Ljava/util/List;)V",
                 block(env, value.block), extrinsics.value);
  }
  case CITIZENSDK_RESULT_PREPARED_TRANSACTION: {
    auto value = output<citizensdk_prepared_transaction_info_t>();
    require(env, citizensdk_result_get_prepared_transaction(result, &value));
    return model(env, "CitizenPreparedTransaction",
                 "(Ljava/lang/String;[B[BLorg/citizen/sdk/"
                 "CitizenBlockRef;JJLjava/lang/String;J)V",
                 hex(env, value.preparation_id, 16),
                 bytes(env, value.source_account_id.bytes, 32),
                 bytes(env, value.call_data_hash, 32),
                 block(env, value.best_block),
                 static_cast<jlong>(value.runtime_spec_number),
                 static_cast<jlong>(value.transaction_format_number),
                 decimal(env, value.nonce),
                 static_cast<jlong>(value.prepared_transaction));
  }
  case CITIZENSDK_RESULT_TRANSACTION_EXECUTION:
    return transaction(env, result);
  default:
    throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core结果类型不匹配");
    throw JavaFailure{};
  }
}
} // namespace
jobject read_result(JNIEnv *env, CitizenSdkHostBridge *bridge,
                    uint64_t result) {
  try {
    return result_value(env, bridge, result);
  } catch (const JavaFailure &) {
    return nullptr;
  } catch (...) {
    throw_sdk(env, CITIZENSDK_ERROR_INTERNAL, "Core结果构造失败");
    return nullptr;
  }
}

jobject read_capabilities(JNIEnv *env, uint64_t handle) {
  try {
    auto value = output<citizensdk_capability_snapshot_t>();
    require(env, citizensdk_get_capabilities(handle, &value));
    if (value.count != CITIZENSDK_CAPABILITY_COUNT) {
      throw_sdk(env, CITIZENSDK_ERROR_INTEGRITY, "Core能力数量不匹配");
      throw JavaFailure{};
    }
    List statuses(env, value.count);
    for (uint32_t i = 0; i < value.count; ++i) {
      Local local(env);
      const auto &item = value.statuses[i];
      statuses.push(
          model(env, "CitizenCapabilityStatus",
                "(Lorg/citizen/sdk/CitizenCapabilityName;Lorg/citizen/sdk/"
                "CitizenCapabilityReason;ZZZZ)V",
                enumeration(env, "CitizenCapabilityName", item.name),
                enumeration(env, "CitizenCapabilityReason", item.reason, 0),
                static_cast<jboolean>(item.supported),
                static_cast<jboolean>(item.available),
                static_cast<jboolean>(item.enabled),
                static_cast<jboolean>(item.ready)));
    }
    return model(env, "CitizenSdkCapabilities",
                 "(Ljava/lang/String;Ljava/util/List;)V",
                 decimal(env, value.revision), statuses.value);
  } catch (const JavaFailure &) {
    return nullptr;
  } catch (...) {
    throw_sdk(env, CITIZENSDK_ERROR_INTERNAL, "Core能力构造失败");
    return nullptr;
  }
}
} // namespace citizen::sdk::jni
