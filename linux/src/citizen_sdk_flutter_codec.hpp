#ifndef CITIZENSDK_LINUX_FLUTTER_CODEC_HPP
#define CITIZENSDK_LINUX_FLUTTER_CODEC_HPP

#include <flutter_linux/flutter_linux.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "citizensdk.h"

namespace citizen_sdk::flutter {

inline citizensdk_failure_stage_t flutter_default_failure_stage(
    citizensdk_error_code_t code) noexcept {
  switch (code) {
    case CITIZENSDK_ERROR_INVALID_ARGUMENT: case CITIZENSDK_ERROR_DECODE:
      return CITIZENSDK_FAILURE_STAGE_VALIDATION;
    case CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED:
    case CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED:
    case CITIZENSDK_ERROR_KEY_INVALIDATED: case CITIZENSDK_ERROR_PERMISSION_DENIED:
      return CITIZENSDK_FAILURE_STAGE_AUTHENTICATION;
    case CITIZENSDK_ERROR_STORAGE: return CITIZENSDK_FAILURE_STAGE_PERSISTENCE;
    case CITIZENSDK_ERROR_UNAVAILABLE: case CITIZENSDK_ERROR_NETWORK:
    case CITIZENSDK_ERROR_TIMEOUT: return CITIZENSDK_FAILURE_STAGE_PROVIDER;
    case CITIZENSDK_ERROR_INTEGRITY: return CITIZENSDK_FAILURE_STAGE_VERIFICATION;
    case CITIZENSDK_ERROR_CANCELLED: return CITIZENSDK_FAILURE_STAGE_CANCELLATION;
    case CITIZENSDK_ERROR_INTERNAL: case CITIZENSDK_ERROR_PANIC:
      return CITIZENSDK_FAILURE_STAGE_TEARDOWN;
    default: return CITIZENSDK_FAILURE_STAGE_ADMISSION;
  }
}

inline constexpr const char *kMethodChannel = "citizen/sdk/core/v2";
inline constexpr const char *kEventChannel = "citizen/sdk/events/v2";
inline constexpr int64_t kProtocolVersion = 2;

// SDK私有open只借用Core句柄；owner仍在原生SDK，公开模型只携带不透明资源标识。
// 凭据和显式取钥允许短时敏感副本；Value标记在析构/覆盖时擦除。
// 本机值树可跨线程转交；官方Flutter值和messenger只在平台线程访问。
struct Value final {
  using Bytes = std::vector<uint8_t>;
  using List = std::vector<Value>;
  std::variant<std::monostate, bool, int64_t, std::string, Bytes, List> data;
  mutable bool sensitive{false};

  Value() = default;
  template <typename T> explicit Value(T value) : data(std::move(value)) {}
  Value(const Value &) = default;
  Value(Value &&) noexcept = default;
  Value &operator=(const Value &other) {
    if (this != &other) { clear_sensitive(); data = other.data; sensitive = other.sensitive; }
    return *this;
  }
  Value &operator=(Value &&other) noexcept {
    if (this != &other) {
      clear_sensitive(); data = std::move(other.data); sensitive = other.sensitive;
      other.sensitive = false;
    }
    return *this;
  }
  ~Value() { clear_sensitive(); }
  // 此标记只属于本机内存所有权，不进入Flutter tuple或事件。
  void mark_sensitive() const noexcept { sensitive = true; }
  void clear_sensitive() noexcept {
    if (!sensitive) return;
    if (auto *bytes = std::get_if<Bytes>(&data)) {
      volatile uint8_t *target = bytes->data();
      for (std::size_t i = 0; i < bytes->size(); ++i) target[i] = 0;
    }
    if (auto *text = std::get_if<std::string>(&data)) {
      volatile char *target = text->data();
      for (std::size_t i = 0; i < text->size(); ++i) target[i] = 0;
    }
    if (auto *items = std::get_if<List>(&data)) {
      for (auto &item : *items) { item.mark_sensitive(); item.clear_sensitive(); }
    }
    sensitive = false;
  }
  static Value sensitive_bytes(Bytes bytes) {
    Value value = Value::bytes(std::move(bytes));
    value.mark_sensitive();
    return value;
  }


  static Value null() { return {}; }
  static Value boolean(bool value) { return Value{value}; }
  static Value integer(int64_t value) { return Value{value}; }
  static Value string(std::string value) { return Value{std::move(value)}; }
  static Value bytes(Bytes value) { return Value{std::move(value)}; }
  static Value list(List value) { return Value{std::move(value)}; }
};

enum class Method {open,diagnose,close,read_diagnostics,open_private_key,reveal_private_key,close_private_key,cancel_operation,respond_credential,cancel_credential,open_qr_capture,close_qr_capture,pause_qr_capture,resume_qr_capture,set_qr_capture_torch,qr_decode_image};
const char *method_name(Method);
bool is_method_name(const std::string&) noexcept;
struct CredentialBytes final {
  std::vector<uint8_t> value;
  explicit CredentialBytes(const std::vector<uint8_t> &source) : value(source) {}
  CredentialBytes(const uint8_t *source, std::size_t size) : value(source, source + size) {}
  explicit CredentialBytes(const std::string &source) : value(source.begin(), source.end()) {}
  CredentialBytes(const CredentialBytes &other) : value(other.value) {}
  CredentialBytes(CredentialBytes &&other) noexcept : value(std::move(other.value)) {}
  CredentialBytes &operator=(const CredentialBytes &other) {
    if (this != &other) { clear(); value = other.value; }
    return *this;
  }
  CredentialBytes &operator=(CredentialBytes &&other) noexcept {
    if (this != &other) { clear(); value = std::move(other.value); }
    return *this;
  }
  ~CredentialBytes() { clear(); }
  void clear() noexcept {
    volatile uint8_t *data = value.data();
    for (std::size_t i = 0; i < value.size(); ++i) data[i] = 0;
    value.clear();
  }
};


struct DecodedRequest final {Method method{Method::open};std::string session;int64_t sequence{};uint32_t modules{CITIZENSDK_MODULE_FULL};Value diagnostic;bool has_credential_provider{};uint64_t host_operation_id{};std::optional<CredentialBytes> credential;citizensdk_account_id_t account_id{};std::string resource_id;uint32_t qr_purpose{};bool torch{};std::vector<uint8_t> payload;};
class ContractFailure final : public std::runtime_error {
 public:
  ContractFailure(citizensdk_error_code_t code, std::string message,
                  std::optional<std::string> session = {},
                  std::optional<int64_t> sequence = {},
                  citizensdk_failure_stage_t stage = 0);
  citizensdk_error_code_t code;
  std::optional<std::string> session;
  std::optional<int64_t> sequence;
  citizensdk_failure_stage_t stage;
};

struct FlValueDeleter {
  void operator()(FlValue *value) const noexcept {
    if (value != nullptr) fl_value_unref(value);
  }
};
using FlValuePtr = std::unique_ptr<FlValue, FlValueDeleter>;

FlStandardMethodCodec *new_method_codec();
FlValuePtr to_fl_value(const Value &value);
Value from_fl_value(FlValue *value, bool sensitive = false);
struct RequestEnvelope { std::string session; int64_t sequence{}; };
std::optional<RequestEnvelope> decode_request_envelope(const std::string &method, FlValue *arguments);
DecodedRequest decode_request(const std::string &method, FlValue *arguments);
bool decode_subscription(FlValue *arguments);

Value response(const std::string &session, int64_t sequence, Value value);
Value event(const std::string &session, int64_t sequence,
            const std::string &type, Value payload);
Value error_details(citizensdk_error_code_t code, const std::string &message,
                    std::optional<std::string> session = {},
                    std::optional<int64_t> sequence = {},
                    const std::string &method = "open",
                    citizensdk_failure_stage_t stage = 0);
const char *error_name(citizensdk_error_code_t code) noexcept;

Value lifecycle(citizensdk_lifecycle_t value);
bool valid_utf8(const std::string&) noexcept;
} // namespace citizen_sdk::flutter
#endif
