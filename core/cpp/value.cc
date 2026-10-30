// 两平台共同编译这份真实实现；条件块只保留系统调用差异。
#include "value.hpp"
#include <algorithm>
#include <array>
#include <charconv>
#include <cstring>
#include <limits>
#include <string_view>
#if defined(_WIN32) // 系统差异
#include <flutter/standard_method_codec.h>
#else // 系统差异

#endif // 系统差异
namespace citizen_sdk::flutter {
namespace {
#if defined(_WIN32) // 系统差异
constexpr std::size_t kMaximumBytes = 16 * 1024 * 1024,
                      kMaximumRequestCopiedBytes = kMaximumBytes + 4096,
                      kMaximumRequestNodes = 4096,
                      kMaximumWireBytes = kMaximumRequestCopiedBytes +
                                          9 * kMaximumRequestNodes + 6;
#else  // 系统差异
constexpr std::size_t kMaximumBytes = 16 * 1024 * 1024,
                      kMaximumRequestCopiedBytes = kMaximumBytes + 4096,
                      kMaximumRequestNodes = 4096;
constexpr int kLengthPreservingString = 0x4353;
#endif // 系统差异
const char *kMethods[] = {"open",
                          "diagnose",
                          "close",
                          "readDiagnostics",
                          "openPrivateKey",
                          "revealPrivateKey",
                          "closePrivateKey",
                          "cancelOperation",
                          "respondCredential",
                          "cancelCredential",
                          "openQrCapture",
                          "closeQrCapture",
                          "pauseQrCapture",
                          "resumeQrCapture",
                          "setQrCaptureTorch",
                          "qrDecodeImage"};
[[noreturn]] void fail(citizensdk_error_code_t code, const char *message) {
  throw ContractFailure(code, message);
}
void require(bool value, citizensdk_error_code_t code, const char *message) {
  if (!value)
    fail(code, message);
}
[[noreturn]] void invalid() {
  fail(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Invalid platform resource request");
}
struct UnicodeInfo {
  std::size_t scalars{}, utf16{};
  uint32_t first{}, last{};
  bool controls{};
};
#if defined(_WIN32) // 系统差异
bool inspect_utf8(std::string_view text, UnicodeInfo *info) noexcept {
#else  // 系统差异
bool inspect_utf8(const std::string &text, UnicodeInfo *info) noexcept {
#endif // 系统差异
  UnicodeInfo parsed;
  for (std::size_t offset = 0; offset < text.size();) {
    const auto first = static_cast<uint8_t>(text[offset++]);
    uint32_t scalar = first;
    uint32_t minimum = 0;
    unsigned remaining = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      scalar = static_cast<uint32_t>(first & 0x1fU);
      remaining = 1;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      scalar = static_cast<uint32_t>(first & 0x0fU);
      remaining = 2;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      scalar = static_cast<uint32_t>(first & 7U);
      remaining = 3;
      minimum = 0x10000;
    } else if (first >= 0x80) {
      return false;
    }
    if (remaining > text.size() - offset)
      return false;
    for (unsigned index = 0; index < remaining; ++index) {
      const auto next = static_cast<uint8_t>(text[offset++]);
      if ((next & 0xc0) != 0x80)
        return false;
      scalar = (scalar << 6) | static_cast<uint32_t>(next & 0x3fU);
    }
    if (scalar < minimum || scalar > 0x10ffff ||
        (scalar >= 0xd800 && scalar <= 0xdfff))
      return false;
    if (parsed.scalars == 0)
      parsed.first = scalar;
    parsed.last = scalar;
    ++parsed.scalars;
    parsed.utf16 += scalar > 0xffff ? 2 : 1;
    parsed.controls =
        parsed.controls || scalar <= 0x1f || (scalar >= 0x7f && scalar <= 0x9f);
  }
  if (info != nullptr)
    *info = parsed;
  return true;
}
#if defined(_WIN32) // 系统差异
void debit_bytes(std::size_t, std::size_t &);
class WirePreflight final {
public:
  WirePreflight(const uint8_t *message, std::size_t size)
      : message_(message), size_(size) {
    require(message != nullptr && size > 0 && size <= kMaximumWireBytes,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Invalid or oversized method message");
#else  // 系统差异
std::string fl_string(FlValue *value) {
  require(value != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "Expected UTF-8 string");
  std::string text;
  if (fl_value_get_type(value) == FL_VALUE_TYPE_STRING) {
    const char *raw = fl_value_get_string(value);
    require(raw != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "String storage is missing");
    text = raw;
  } else if (fl_value_get_type(value) == FL_VALUE_TYPE_CUSTOM &&
             fl_value_get_custom_type(value) == kLengthPreservingString) {
    const auto *raw =
        static_cast<const std::string *>(fl_value_get_custom_value(value));
    require(raw != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "String storage is missing");
    text = *raw;
  } else {
    fail(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Expected UTF-8 string");
#endif // 系统差异
  }
#if defined(_WIN32) // 系统差异
  void check() {
    require(byte() == 7, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Method name must be a standard string");
    text();
    value(0);
    require(offset_ == size_, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Trailing method message bytes");
  }

private:
  const uint8_t *take(std::size_t count) {
    require(count <= size_ - offset_, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Truncated standard method message");
    const auto *result = message_ + offset_;
    offset_ += count;
    return result;
  }
  uint8_t byte() { return *take(1); }
  std::size_t length() {
    const uint8_t marker = byte();
    if (marker < 254)
      return marker;
    // Flutter 官方 size 使用宿主整数序；Windows 与本机 macOS 验证均为
    // little-endian。 memcpy
    // 不要求输入地址对齐；保留官方允许的两种扩展长度表示。
    if (marker == 254) {
      uint16_t result{};
      std::memcpy(&result, take(sizeof(result)), sizeof(result));
      return result;
#else  // 系统差异
  require(inspect_utf8(text, nullptr), CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "String is not valid UTF-8");
  return text;
}

void destroy_string(gpointer value) {
  delete static_cast<std::string *>(value);
}
FlValue *owned_fl_string(const std::string &text) {
  require(valid_utf8(text), CITIZENSDK_ERROR_INTEGRITY,
          "Public result string is not valid UTF-8");
  if (text.find('\0') == std::string::npos)
    return fl_value_new_string(text.c_str());
  auto storage = std::make_unique<std::string>(text);
  FlValue *value = fl_value_new_custom(kLengthPreservingString, storage.get(),
                                       destroy_string);
  (void)storage.release();
  return value;
}

// This is an internal representation adapter using Flutter's official virtual
// hooks. It never emits a custom wire tag: text remains standard string tag 7.
typedef struct _CitizenSdkStringCodec {
  FlStandardMessageCodec parent_instance;
} CitizenSdkStringCodec;
typedef struct _CitizenSdkStringCodecClass {
  FlStandardMessageCodecClass parent_class;
} CitizenSdkStringCodecClass;
G_DEFINE_TYPE(CitizenSdkStringCodec, citizen_sdk_string_codec,
              fl_standard_message_codec_get_type())

FlValue *read_string_value(FlStandardMessageCodec *codec, GBytes *buffer,
                           size_t *offset, int type, GError **error) {
  try {
    if (type != 7) {
      return FL_STANDARD_MESSAGE_CODEC_CLASS(
                 citizen_sdk_string_codec_parent_class)
          ->read_value_of_type(codec, buffer, offset, type, error);
#endif // 系统差异
    }
#if defined(_WIN32) // 系统差异
    uint32_t result{};
    std::memcpy(&result, take(sizeof(result)), sizeof(result));
    return result;
  }
  void text() {
    const auto count = length();
    debit_bytes(count, remaining_bytes_);
    const auto *data = take(count);
    require(inspect_utf8(
                std::string_view(reinterpret_cast<const char *>(data), count),
                nullptr),
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "String is not valid UTF-8");
  }
  void value(unsigned depth) {
    require(depth <= 32 && remaining_nodes_ > 0,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Invalid or excessively nested method tuple");
    --remaining_nodes_;
    switch (byte()) {
    case 0:
    case 1:
    case 2:
      return; // null / true / false
    case 3:
      (void)take(4);
      return; // int32，无 padding
    case 4:
      (void)take(8);
      return; // int64，无 padding
    case 7:
      text();
      return;
    case 8: {
      const auto count = length();
      require(count <= kMaximumBytes, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Byte value exceeds 16 MiB");
      debit_bytes(count, remaining_bytes_);
      (void)take(count);
      return;
    }
    case 12: {
      const auto count = length();
      require(count <= remaining_nodes_, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "Tuple node count exceeds the public contract");
      for (std::size_t index = 0; index < count; ++index)
        value(depth + 1);
      return;
    }
    default:
      fail(CITIZENSDK_ERROR_INVALID_ARGUMENT,
           "Unsupported standard value type in method tuple");
#else  // 系统差异
    uint32_t length = 0;
    if (!fl_standard_message_codec_read_size(codec, buffer, offset, &length,
                                             error))
      return nullptr;
    gsize size = 0;
    const auto *raw =
        static_cast<const char *>(g_bytes_get_data(buffer, &size));
    if (*offset > size || length > size - *offset || length > kMaximumBytes) {
      g_set_error_literal(error, FL_MESSAGE_CODEC_ERROR,
                          FL_MESSAGE_CODEC_ERROR_FAILED,
                          "CitizenSDK string length is invalid");
      return nullptr;
#endif // 系统差异
    }
#if defined(_WIN32) // 系统差异
#else               // 系统差异
    const std::string text(length == 0 ? "" : raw + *offset, length);
    if (!valid_utf8(text)) {
      g_set_error_literal(error, FL_MESSAGE_CODEC_ERROR,
                          FL_MESSAGE_CODEC_ERROR_FAILED,
                          "CitizenSDK string is not valid UTF-8");
      return nullptr;
    }
    *offset += length;
    return owned_fl_string(text);
  } catch (...) {
    g_set_error_literal(error, FL_MESSAGE_CODEC_ERROR,
                        FL_MESSAGE_CODEC_ERROR_FAILED,
                        "CitizenSDK string decode failed");
    return nullptr;
#endif              // 系统差异
  }
#if defined(_WIN32) // 系统差异
  const uint8_t *message_;
  std::size_t size_;
  std::size_t offset_{};
  std::size_t remaining_nodes_ = kMaximumRequestNodes;
  std::size_t remaining_bytes_ = kMaximumRequestCopiedBytes;
};
#else // 系统差异
}

gboolean write_string_value(FlStandardMessageCodec *codec, GByteArray *buffer,
                            FlValue *value, GError **error) {
  try {
    if (value != nullptr && fl_value_get_type(value) == FL_VALUE_TYPE_CUSTOM) {
      if (fl_value_get_custom_type(value) != kLengthPreservingString) {
        g_set_error_literal(error, FL_MESSAGE_CODEC_ERROR,
                            FL_MESSAGE_CODEC_ERROR_FAILED,
                            "CitizenSDK rejects unknown custom values");
        return FALSE;
      }
      const auto text = fl_string(value);
      if (text.size() > kMaximumBytes) {
        g_set_error_literal(error, FL_MESSAGE_CODEC_ERROR,
                            FL_MESSAGE_CODEC_ERROR_FAILED,
                            "CitizenSDK string length is invalid");
        return FALSE;
      }
      const uint8_t tag = 7;
      g_byte_array_append(buffer, &tag, 1);
      fl_standard_message_codec_write_size(codec, buffer,
                                           static_cast<uint32_t>(text.size()));
      g_byte_array_append(buffer,
                          reinterpret_cast<const uint8_t *>(text.data()),
                          static_cast<guint>(text.size()));
      return TRUE;
    }
    if (value != nullptr && fl_value_get_type(value) == FL_VALUE_TYPE_STRING) {
      (void)fl_string(value); // Reject malformed native UTF-8, too.
    }
    return FL_STANDARD_MESSAGE_CODEC_CLASS(
               citizen_sdk_string_codec_parent_class)
        ->write_value(codec, buffer, value, error);
  } catch (...) {
    g_set_error_literal(error, FL_MESSAGE_CODEC_ERROR,
                        FL_MESSAGE_CODEC_ERROR_FAILED,
                        "CitizenSDK string encode failed");
    return FALSE;
  }
}
void citizen_sdk_string_codec_class_init(CitizenSdkStringCodecClass *klass) {
  auto *codec = FL_STANDARD_MESSAGE_CODEC_CLASS(klass);
  codec->read_value_of_type = read_string_value;
  codec->write_value = write_string_value;
}
void citizen_sdk_string_codec_init(CitizenSdkStringCodec *) {}

#endif // 系统差异

void debit_bytes(std::size_t count, std::size_t &remaining) {
  require(count <= remaining, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "Tuple cumulative byte size exceeds the public contract");
  remaining -= count;
}
#if defined(_WIN32) // 系统差异
Value from_encodable(const ::flutter::EncodableValue &value, unsigned depth,
                     std::size_t &remaining_nodes, std::size_t &remaining_bytes,
                     bool sensitive) {
#else  // 系统差异
Value from_fl(FlValue *value, unsigned depth, std::size_t &remaining_nodes,
              std::size_t &remaining_bytes, bool sensitive) {
#endif // 系统差异
  // 逐叶标记：后续字段复制失败时，已取得的敏感叶也会随栈展开擦除。
  auto owned = [sensitive](Value value) {
    if (sensitive)
      value.mark_sensitive();
    return value;
  };
#if defined(_WIN32) // 系统差异
  require(depth <= 32 && remaining_nodes > 0, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "Invalid or excessively nested tuple");
#else  // 系统差异
  require(value != nullptr && depth <= 32 && remaining_nodes > 0,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "Invalid or excessively nested tuple");
#endif // 系统差异
  --remaining_nodes;
#if defined(_WIN32) // 系统差异
  if (std::holds_alternative<std::monostate>(value))
    return Value::null();
  // StandardMessageCodec 的 bool、int32、int64 是不同类型；禁止将 bool/double
  // 当整数。
  if (const auto *v = std::get_if<bool>(&value))
    return Value::boolean(*v);
  if (const auto *v = std::get_if<int32_t>(&value))
    return Value::integer(*v);
  if (const auto *v = std::get_if<int64_t>(&value))
    return Value::integer(*v);
  if (const auto *v = std::get_if<std::string>(&value)) {
    debit_bytes(v->size(), remaining_bytes);
    require(valid_utf8(*v), CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "String is not valid UTF-8");
    return owned(Value::string(*v));
  }
  if (const auto *v = std::get_if<std::vector<uint8_t>>(&value)) {
    require(v->size() <= kMaximumBytes, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Byte value exceeds 16 MiB");
    debit_bytes(v->size(), remaining_bytes);
    return owned(Value::bytes(*v));
  }
  if (const auto *v = std::get_if<::flutter::EncodableList>(&value)) {
    // 先检查剩余节点再 reserve；所有递归分支共用预算，不能用分支拆分绕过上限。
    require(v->size() <= remaining_nodes, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Tuple list exceeds the public contract");
    Value::List list;
    list.reserve(v->size());
    for (const auto &item : *v) {
      list.push_back(from_encodable(item, depth + 1, remaining_nodes,
                                    remaining_bytes, sensitive));
#else  // 系统差异
  switch (fl_value_get_type(value)) {
  case FL_VALUE_TYPE_NULL:
    return Value::null();
  case FL_VALUE_TYPE_BOOL:
    return Value::boolean(fl_value_get_bool(value));
  case FL_VALUE_TYPE_INT:
    return Value::integer(fl_value_get_int(value));
  case FL_VALUE_TYPE_STRING: {
    const char *text = fl_value_get_string(value);
    require(text != nullptr && g_utf8_validate(text, -1, nullptr),
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "String is not valid UTF-8");
    const std::size_t length = std::strlen(text);
    debit_bytes(length, remaining_bytes);
    return owned(Value::string(std::string(text, length)));
#endif // 系统差异
    }
#if defined(_WIN32) // 系统差异
    return Value::list(std::move(list));
#else  // 系统差异
  case FL_VALUE_TYPE_CUSTOM: {
    require(fl_value_get_custom_type(value) == kLengthPreservingString,
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "Unknown custom value");
    const auto *text =
        static_cast<const std::string *>(fl_value_get_custom_value(value));
    require(text != nullptr && valid_utf8(*text),
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "String is not valid UTF-8");
    debit_bytes(text->size(), remaining_bytes);
    return owned(Value::string(*text));
  }
  case FL_VALUE_TYPE_UINT8_LIST: {
    const auto count = fl_value_get_length(value);
    require(count <= kMaximumBytes, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Byte value exceeds 16 MiB");
    debit_bytes(count, remaining_bytes);
    const auto *bytes = fl_value_get_uint8_list(value);
    return owned(Value::bytes(count == 0 ? Value::Bytes{}
                                         : Value::Bytes(bytes, bytes + count)));
  }
  case FL_VALUE_TYPE_LIST: {
    const auto count = fl_value_get_length(value);
    require(count <= 100000, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Tuple list exceeds the public contract");
    Value::List list;
    list.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
      list.push_back(from_fl(fl_value_get_list_value(value, i), depth + 1,
                             remaining_nodes, remaining_bytes, sensitive));
    }
    return Value::list(std::move(list));
  }
  default:
    fail(CITIZENSDK_ERROR_INVALID_ARGUMENT,
         "Maps, floating-point values and non-byte typed lists are forbidden");
#endif // 系统差异
  }
#if defined(_WIN32) // 系统差异
  fail(CITIZENSDK_ERROR_INVALID_ARGUMENT,
       "Maps, floating-point values, custom values and non-byte typed lists "
       "are forbidden");
#else  // 系统差异
#endif // 系统差异
}
int64_t integer(const Value &v) {
  const auto *p = std::get_if<int64_t>(&v.data);
  if (!p)
    invalid();
  return *p;
}
const std::string &identity(const Value &v) {
  const auto *p = std::get_if<std::string>(&v.data);
  if (!p || p->empty() || p->size() > 128 ||
      !std::all_of(p->begin(), p->end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
               (c >= 'A' && c <= 'Z') || c == '-' || c == '_';
      }))
    invalid();
  return *p;
}
std::optional<RequestEnvelope> envelope(const Value::List &t) {
  if (t.size() < 3 || integer(t[0]) != 2)
    invalid();
  const auto &id = identity(t[1]);
  const auto n = integer(t[2]);
  if (n <= 0)
    invalid();
  return RequestEnvelope{id, n};
}
DecodedRequest decode(const std::string &name, Value value) {
  const auto *t = std::get_if<Value::List>(&value.data);
  if (!t || t->empty() || integer((*t)[0]) != 2)
    invalid();
  DecodedRequest r;
  const auto found = std::find_if(std::begin(kMethods), std::end(kMethods),
                                  [&](const char *n) { return name == n; });
  if (found == std::end(kMethods))
    fail(CITIZENSDK_ERROR_UNSUPPORTED, "Unsupported platform operation");
  r.method = static_cast<Method>(found - std::begin(kMethods));
  if (r.method == Method::open) {
    if (t->size() != 3)
      invalid();
    const auto mask = integer((*t)[1]);
    const auto *p = std::get_if<bool>(&(*t)[2].data);
    if (mask <= 0 || mask > UINT32_MAX || !p)
      invalid();
    r.modules = static_cast<uint32_t>(mask);
    r.has_credential_provider = *p;
    return r;
  }
  if (r.method == Method::diagnose) {
    if (t->size() != 3)
      invalid();
    r.session = identity((*t)[1]);
    const auto *row = std::get_if<Value::List>(&(*t)[2].data);
    if (!row || row->size() != 6)
      invalid();
    const auto *method = std::get_if<std::string>(&(*row)[0].data),
               *phase = std::get_if<std::string>(&(*row)[1].data),
               *point = std::get_if<std::string>(&(*row)[4].data);
    const std::vector<std::string>
        allowed = {"open",
                   "start",
                   "stop",
                   "getSyncStatus",
                   "getWalletState",
                   "inspectWallets",
                   "releaseWalletInspection",
                   "cancelOperation"},
        phases = {"BEGIN", "ADMISSION", "DECODE", "COMPLETE"},
        points = {"NONE",    "ADMISSION", "LOCAL_READ",    "RESULT_READY",
                  "RESTORE", "BEGIN",     "PUBLISH_BEGIN", "PROVIDER_START",
                  "REFRESH", "COMPLETE",  "SERVICES",      "PUBLISH_COMPLETE"};
    if (!method || !phase || !point ||
        std::find(allowed.begin(), allowed.end(), *method) == allowed.end() ||
        std::find(phases.begin(), phases.end(), *phase) == phases.end() ||
        std::find(points.begin(), points.end(), *point) == points.end() ||
        integer((*row)[2]) < 0 || integer((*row)[2]) > 22 ||
        integer((*row)[3]) < 0 || integer((*row)[3]) > 8 ||
        integer((*row)[5]) < 0 || integer((*row)[5]) > 86400000)
      invalid();
    r.diagnostic = (*t)[2];
    return r;
  }
  const auto outer = envelope(*t);
  r.session = outer->session;
  r.sequence = outer->sequence;
  if (r.method == Method::close || r.method == Method::read_diagnostics) {
    if (t->size() != 3)
      invalid();
    return r;
  }
  if (r.method == Method::open_private_key) {
    if (t->size() != 4)
      invalid();
    const auto *s = std::get_if<std::string>(&(*t)[3].data);
    if (!s || s->size() != 66 || s->substr(0, 2) != "0x")
      invalid();
    auto nibble = [](char c) -> uint8_t {
      if (c >= '0' && c <= '9')
        return static_cast<uint8_t>(c - '0');
      if (c >= 'a' && c <= 'f')
        return static_cast<uint8_t>(c - 'a' + 10);
      invalid();
    };
    for (std::size_t i = 0; i < 32; ++i)
      r.account_id.bytes[i] = static_cast<uint8_t>(
          nibble((*s)[2 + i * 2]) * 16 + nibble((*s)[3 + i * 2]));
    return r;
  }
  if (r.method == Method::open_qr_capture ||
      r.method == Method::qr_decode_image) {
    const bool image = r.method == Method::qr_decode_image;
    if (t->size() != (image ? 5U : 4U))
      invalid();
    const auto purpose = integer((*t)[image ? 4U : 3U]);
    if (purpose < 1 || purpose > 8 || purpose == 6)
      invalid();
    r.qr_purpose = static_cast<uint32_t>(purpose);
    if (image) {
      const auto *p = std::get_if<Value::Bytes>(&(*t)[3].data);
      if (!p || p->empty() || p->size() > kMaximumBytes)
        invalid();
      r.payload = *p;
    }
    return r;
  }
  if (r.method == Method::set_qr_capture_torch) {
    if (t->size() != 5)
      invalid();
    r.resource_id = identity((*t)[3]);
    const auto *p = std::get_if<bool>(&(*t)[4].data);
    if (!p)
      invalid();
    r.torch = *p;
    return r;
  }
  const bool credential = r.method == Method::respond_credential;
  if (t->size() != (credential ? 5U : 4U))
    invalid();
  r.resource_id = identity((*t)[3]);
  if (r.method == Method::respond_credential ||
      r.method == Method::cancel_credential) {
    const auto &text = r.resource_id;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(),
                                        r.host_operation_id);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() ||
        r.host_operation_id == 0 || (text.size() > 1 && text[0] == '0'))
      invalid();
    if (credential && !std::holds_alternative<std::monostate>((*t)[4].data)) {
      const auto *p = std::get_if<Value::Bytes>(&(*t)[4].data);
      if (!p || p->size() > 1024)
        invalid();
      r.credential.emplace(*p);
    }
  }
  return r;
}
} // namespace
ContractFailure::ContractFailure(citizensdk_error_code_t error_code,
                                 std::string message,
                                 std::optional<std::string> session_id,
                                 std::optional<int64_t> request_sequence,
                                 citizensdk_failure_stage_t failure_stage)
    : std::runtime_error(std::move(message)), code(error_code),
      session(std::move(session_id)), sequence(request_sequence),
      stage(failure_stage == 0 ? flutter_default_failure_stage(error_code)
                               : failure_stage) {}
// 非法方法值必须失败，不能转换为另一个有效资源操作。
const char *method_name(Method method) {
  const auto index = static_cast<std::size_t>(method);
  require(index < std::size(kMethods), CITIZENSDK_ERROR_INTEGRITY,
          "Invalid platform method");
  return kMethods[index];
}
bool is_method_name(const std::string &name) noexcept {
  return std::any_of(std::begin(kMethods), std::end(kMethods),
                     [&](const char *n) { return name == n; });
}
bool valid_utf8(const std::string &text) noexcept {
  return inspect_utf8(text, nullptr);
}
#if defined(_WIN32) // 系统差异
std::unique_ptr<::flutter::MethodCall<::flutter::EncodableValue>>
decode_method_call(const uint8_t *message, std::size_t size) {
  WirePreflight(message, size).check();
  auto result = ::flutter::StandardMethodCodec::GetInstance().DecodeMethodCall(
      message, size);
  require(result != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "Invalid standard method call");
  return result;
#else  // 系统差异
FlStandardMethodCodec *new_method_codec() {
  auto *message_codec = FL_STANDARD_MESSAGE_CODEC(
      g_object_new(citizen_sdk_string_codec_get_type(), nullptr));
  auto *codec = fl_standard_method_codec_new_with_message_codec(message_codec);
  g_object_unref(message_codec);
  return codec;
#endif // 系统差异
}
#if defined(_WIN32) // 系统差异
Value from_encodable_value(const ::flutter::EncodableValue &value,
                           bool sensitive) {
#else  // 系统差异
Value from_fl_value(FlValue *value, bool sensitive) {
#endif // 系统差异
  // 总节点/总字节共享递归预算，先扣减再复制；保留 16 MiB payload 的固定 tuple
  // 余量。
#if defined(_WIN32) // 系统差异
  // A valid request has at most 1,995 nodes. The 4,096-node limit bounds
  // recursive copies without changing any supported method's input range.
#else  // 系统差异
  // The largest valid request has 1,995 nodes. A 4,096-node budget rejects
  // exponentially nested or irrelevant input before copying it. The byte
  // budget preserves a maximum 16 MiB signing payload plus its small fixed
  // tuple fields, while rejecting aggregate bulk values above that contract.
#endif // 系统差异
  std::size_t remaining_nodes = kMaximumRequestNodes;
  std::size_t remaining_bytes = kMaximumRequestCopiedBytes;
#if defined(_WIN32) // 系统差异
  return from_encodable(value, 0, remaining_nodes, remaining_bytes, sensitive);
#else  // 系统差异
  return from_fl(value, 0, remaining_nodes, remaining_bytes, sensitive);
#endif // 系统差异
}
#if defined(_WIN32) // 系统差异
::flutter::EncodableValue to_encodable_value(const Value &value) {
  if (std::holds_alternative<std::monostate>(value.data))
    return ::flutter::EncodableValue();
  if (const auto *v = std::get_if<bool>(&value.data))
    return ::flutter::EncodableValue(*v);
  if (const auto *v = std::get_if<int64_t>(&value.data))
    return ::flutter::EncodableValue(*v);
  if (const auto *v = std::get_if<std::string>(&value.data)) {
    require(valid_utf8(*v), CITIZENSDK_ERROR_INTEGRITY,
            "Public result string is not valid UTF-8");
    return ::flutter::EncodableValue(*v);
  }
#else  // 系统差异
FlValuePtr to_fl_value(const Value &value) {
  if (std::holds_alternative<std::monostate>(value.data))
    return FlValuePtr(fl_value_new_null());
  if (const auto *v = std::get_if<bool>(&value.data))
    return FlValuePtr(fl_value_new_bool(*v));
  if (const auto *v = std::get_if<int64_t>(&value.data))
    return FlValuePtr(fl_value_new_int(*v));
  if (const auto *v = std::get_if<std::string>(&value.data))
    return FlValuePtr(owned_fl_string(*v));
#endif // 系统差异
  if (const auto *v = std::get_if<Value::Bytes>(&value.data)) {
#if defined(_WIN32) // 系统差异
    return ::flutter::EncodableValue(*v);
#else  // 系统差异
    return FlValuePtr(fl_value_new_uint8_list(v->data(), v->size()));
#endif // 系统差异
  }
#if defined(_WIN32) // 系统差异
  ::flutter::EncodableList result;
  const auto &items = std::get<Value::List>(value.data);
  result.reserve(items.size());
  for (const auto &item : items)
    result.push_back(to_encodable_value(item));
  return ::flutter::EncodableValue(std::move(result));
#else  // 系统差异
  FlValuePtr result(fl_value_new_list());
  for (const auto &item : std::get<Value::List>(value.data)) {
    auto child = to_fl_value(item);
    fl_value_append_take(result.get(), child.release());
  }
  return result;
#endif // 系统差异
}
#if defined(_WIN32) // 系统差异
std::optional<RequestEnvelope>
decode_request_envelope(const std::string &name,
                        const ::flutter::EncodableValue *args) {
  if (name == "open" || name == "diagnose")
    return {};
  if (!args)
    invalid();
  const auto *list = std::get_if<::flutter::EncodableList>(args);
  if (!list || list->size() < 3)
    invalid();
  Value::List t;
  for (std::size_t i = 0; i < 3; ++i)
    t.push_back(from_encodable_value((*list)[i]));
  return envelope(t);
}
DecodedRequest decode_request(const std::string &name,
                              const ::flutter::EncodableValue *args) {
  return decode(name, args ? from_encodable_value(*args, true) : Value{});
}
bool decode_subscription(const ::flutter::EncodableValue *args) {
  try {
    const auto value = args ? from_encodable_value(*args, true) : Value{};
    const auto *t = std::get_if<Value::List>(&value.data);
    return t && t->size() == 1 && integer((*t)[0]) == 2;
  } catch (...) {
    return false;
  }
}
#else  // 系统差异
std::optional<RequestEnvelope> decode_request_envelope(const std::string &name,
                                                       FlValue *args) {
  if (name == "open" || name == "diagnose")
    return {};
  if (!args || fl_value_get_type(args) != FL_VALUE_TYPE_LIST ||
      fl_value_get_length(args) < 3)
    invalid();
  Value::List t;
  for (std::size_t i = 0; i < 3; ++i)
    t.push_back(from_fl_value(fl_value_get_list_value(args, i)));
  return envelope(t);
}
DecodedRequest decode_request(const std::string &name, FlValue *args) {
  return decode(name, from_fl_value(args, true));
}
bool decode_subscription(FlValue *args) {
  try {
    const auto value = from_fl_value(args, true);
    const auto *t = std::get_if<Value::List>(&value.data);
    return t && t->size() == 1 && integer((*t)[0]) == 2;
  } catch (...) {
    return false;
  }
}
#endif // 系统差异
const char *error_name(citizensdk_error_code_t code) noexcept {
  constexpr const char *names[] = {"ok",
                                   "invalidArgument",
                                   "invalidHandle",
                                   "invalidState",
                                   "unsupported",
                                   "unavailable",
                                   "notReady",
                                   "notFound",
                                   "conflict",
                                   "integrity",
                                   "authenticationCancelled",
                                   "authenticationRequired",
                                   "keyInvalidated",
                                   "permissionDenied",
                                   "storage",
                                   "network",
                                   "decode",
                                   "timeout",
                                   "busy",
                                   "queueFull",
                                   "internal",
                                   "panic",
                                   "cancelled"};
  return code >= 0 && static_cast<std::size_t>(code) < std::size(names)
             ? names[static_cast<std::size_t>(code)]
             : "integrity";
}
Value response(const std::string &s, int64_t n, Value value) {
  return Value::list({Value::integer(2), Value::string(s), Value::integer(n),
                      std::move(value)});
}
Value event(const std::string &s, int64_t n, const std::string &type,
            Value value) {
  return Value::list({Value::integer(2), Value::string(s), Value::integer(n),
                      Value::string(type), std::move(value)});
}
Value error_details(citizensdk_error_code_t code, const std::string &message,
                    std::optional<std::string> s, std::optional<int64_t> n,
                    const std::string &method,
                    citizensdk_failure_stage_t stage) {
  return Value::list(
      {Value::integer(2), s ? Value::string(*s) : Value::null(),
       n ? Value::integer(*n) : Value::null(), Value::integer(code),
       Value::integer(stage ? stage : flutter_default_failure_stage(code)),
       Value::string(method), Value::string(message)});
}
Value lifecycle(citizensdk_lifecycle_t value) {
  constexpr const char *names[] = {"created", "importingState", "starting",
                                   "running", "startFailed",    "stopped",
                                   "disposed"};
  require(value >= 1 && value <= std::size(names), CITIZENSDK_ERROR_INTEGRITY,
          "Unknown Core lifecycle");
  return Value::string(names[value - 1]);
}
} // namespace citizen_sdk::flutter
