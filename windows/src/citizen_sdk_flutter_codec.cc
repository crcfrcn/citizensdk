#include "citizen_sdk_flutter_codec.hpp"
#include <algorithm>
#include <array>
#include <charconv>
#include <cstring>
#include <limits>
#include <string_view>
#include <flutter/standard_method_codec.h>
namespace citizen_sdk::flutter {
namespace {
constexpr std::size_t kMaximumBytes=16*1024*1024,kMaximumRequestCopiedBytes=kMaximumBytes+4096,kMaximumRequestNodes=4096,kMaximumWireBytes=kMaximumRequestCopiedBytes+9*kMaximumRequestNodes+6;
const char *kMethods[]={"open","diagnose","close","readDiagnostics","openPrivateKey","revealPrivateKey","closePrivateKey","cancelOperation","respondCredential","cancelCredential","openQrCapture","closeQrCapture","pauseQrCapture","resumeQrCapture","setQrCaptureTorch","qrDecodeImage"};
[[noreturn]] void fail(citizensdk_error_code_t code,const char *message){throw ContractFailure(code,message);}
void require(bool value,citizensdk_error_code_t code,const char *message){if(!value)fail(code,message);}
[[noreturn]] void invalid(){fail(CITIZENSDK_ERROR_INVALID_ARGUMENT,"Invalid platform resource request");}
struct UnicodeInfo {std::size_t scalars{},utf16{};uint32_t first{},last{};bool controls{};};
bool inspect_utf8(std::string_view text, UnicodeInfo *info) noexcept {
  UnicodeInfo parsed;
  for (std::size_t offset = 0; offset < text.size();) {
    const auto first = static_cast<uint8_t>(text[offset++]);
    uint32_t scalar = first;
    uint32_t minimum = 0;
    unsigned remaining = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      scalar = static_cast<uint32_t>(first & 0x1fU); remaining = 1; minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      scalar = static_cast<uint32_t>(first & 0x0fU); remaining = 2; minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      scalar = static_cast<uint32_t>(first & 7U); remaining = 3; minimum = 0x10000;
    } else if (first >= 0x80) {
      return false;
    }
    if (remaining > text.size() - offset) return false;
    for (unsigned index = 0; index < remaining; ++index) {
      const auto next = static_cast<uint8_t>(text[offset++]);
      if ((next & 0xc0) != 0x80) return false;
      scalar = (scalar << 6) | static_cast<uint32_t>(next & 0x3fU);
    }
    if (scalar < minimum || scalar > 0x10ffff ||
        (scalar >= 0xd800 && scalar <= 0xdfff)) return false;
    if (parsed.scalars == 0) parsed.first = scalar;
    parsed.last = scalar;
    ++parsed.scalars;
    parsed.utf16 += scalar > 0xffff ? 2 : 1;
    parsed.controls = parsed.controls || scalar <= 0x1f ||
                      (scalar >= 0x7f && scalar <= 0x9f);
  }
  if (info != nullptr) *info = parsed;
  return true;
}
void debit_bytes(std::size_t,std::size_t&);
class WirePreflight final {
 public:
  WirePreflight(const uint8_t *message, std::size_t size) : message_(message), size_(size) {
    require(message != nullptr && size > 0 && size <= kMaximumWireBytes,
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "Invalid or oversized method message");
  }
  void check() {
    require(byte() == 7, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Method name must be a standard string");
    text();
    value(0);
    require(offset_ == size_, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Trailing method message bytes");
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
    if (marker < 254) return marker;
    // Flutter 官方 size 使用宿主整数序；Windows 与本机 macOS 验证均为 little-endian。
    // memcpy 不要求输入地址对齐；保留官方允许的两种扩展长度表示。
    if (marker == 254) {
      uint16_t result{};
      std::memcpy(&result, take(sizeof(result)), sizeof(result));
      return result;
    }
    uint32_t result{};
    std::memcpy(&result, take(sizeof(result)), sizeof(result));
    return result;
  }
  void text() {
    const auto count = length();
    debit_bytes(count, remaining_bytes_);
    const auto *data = take(count);
    require(inspect_utf8(std::string_view(reinterpret_cast<const char *>(data), count), nullptr),
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "String is not valid UTF-8");
  }
  void value(unsigned depth) {
    require(depth <= 32 && remaining_nodes_ > 0, CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "Invalid or excessively nested method tuple");
    --remaining_nodes_;
    switch (byte()) {
      case 0: case 1: case 2: return;  // null / true / false
      case 3: (void)take(4); return;  // int32，无 padding
      case 4: (void)take(8); return;  // int64，无 padding
      case 7: text(); return;
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
        for (std::size_t index = 0; index < count; ++index) value(depth + 1);
        return;
      }
      default:
        fail(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Unsupported standard value type in method tuple");
    }
  }
  const uint8_t *message_;
  std::size_t size_;
  std::size_t offset_{};
  std::size_t remaining_nodes_ = kMaximumRequestNodes;
  std::size_t remaining_bytes_ = kMaximumRequestCopiedBytes;
};

void debit_bytes(std::size_t count, std::size_t &remaining) {
  require(count <= remaining, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "Tuple cumulative byte size exceeds the public contract");
  remaining -= count;
}
Value from_encodable(const ::flutter::EncodableValue &value, unsigned depth,
                     std::size_t &remaining_nodes, std::size_t &remaining_bytes, bool sensitive) {
  // 逐叶标记：后续字段复制失败时，已取得的敏感叶也会随栈展开擦除。
  auto owned = [sensitive](Value value) {
    if (sensitive) value.mark_sensitive();
    return value;
  };
  require(depth <= 32 && remaining_nodes > 0,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "Invalid or excessively nested tuple");
  --remaining_nodes;
  if (std::holds_alternative<std::monostate>(value)) return Value::null();
  // StandardMessageCodec 的 bool、int32、int64 是不同类型；禁止将 bool/double 当整数。
  if (const auto *v = std::get_if<bool>(&value)) return Value::boolean(*v);
  if (const auto *v = std::get_if<int32_t>(&value)) return Value::integer(*v);
  if (const auto *v = std::get_if<int64_t>(&value)) return Value::integer(*v);
  if (const auto *v = std::get_if<std::string>(&value)) {
    debit_bytes(v->size(), remaining_bytes);
    require(valid_utf8(*v), CITIZENSDK_ERROR_INVALID_ARGUMENT, "String is not valid UTF-8");
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
      list.push_back(from_encodable(item, depth + 1, remaining_nodes, remaining_bytes, sensitive));
    }
    return Value::list(std::move(list));
  }
  fail(CITIZENSDK_ERROR_INVALID_ARGUMENT,
       "Maps, floating-point values, custom values and non-byte typed lists are forbidden");
}
int64_t integer(const Value&v){const auto *p=std::get_if<int64_t>(&v.data);if(!p)invalid();return *p;}
const std::string &identity(const Value&v){const auto*p=std::get_if<std::string>(&v.data);if(!p||p->empty()||p->size()>128||!std::all_of(p->begin(),p->end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='z')||(c>='A'&&c<='Z')||c=='-'||c=='_';}))invalid();return*p;}
std::optional<RequestEnvelope> envelope(const Value::List&t){if(t.size()<3||integer(t[0])!=2)invalid();const auto &id=identity(t[1]);const auto n=integer(t[2]);if(n<=0)invalid();return RequestEnvelope{id,n};}
DecodedRequest decode(const std::string&name,Value value){const auto*t=std::get_if<Value::List>(&value.data);if(!t||t->empty()||integer((*t)[0])!=2)invalid();DecodedRequest r;
 const auto found=std::find_if(std::begin(kMethods),std::end(kMethods),[&](const char*n){return name==n;});if(found==std::end(kMethods))fail(CITIZENSDK_ERROR_UNSUPPORTED,"Unsupported platform operation");r.method=static_cast<Method>(found-std::begin(kMethods));
 if(r.method==Method::open){if(t->size()!=3)invalid();const auto mask=integer((*t)[1]);const auto*p=std::get_if<bool>(&(*t)[2].data);if(mask<=0||mask>UINT32_MAX||!p)invalid();r.modules=static_cast<uint32_t>(mask);r.has_credential_provider=*p;return r;}
 if(r.method==Method::diagnose){if(t->size()!=3)invalid();r.session=identity((*t)[1]);const auto *row=std::get_if<Value::List>(&(*t)[2].data);if(!row||row->size()!=6)invalid();const auto *method=std::get_if<std::string>(&(*row)[0].data),*phase=std::get_if<std::string>(&(*row)[1].data),*point=std::get_if<std::string>(&(*row)[4].data);const std::vector<std::string> allowed={"open","start","stop","getSyncStatus","getWalletState","inspectWallets","releaseWalletInspection","cancelOperation"},phases={"BEGIN","ADMISSION","DECODE","COMPLETE"},points={"NONE","ADMISSION","LOCAL_READ","RESULT_READY","RESTORE","BEGIN","PUBLISH_BEGIN","PROVIDER_START","REFRESH","COMPLETE","SERVICES","PUBLISH_COMPLETE"};if(!method||!phase||!point||std::find(allowed.begin(),allowed.end(),*method)==allowed.end()||std::find(phases.begin(),phases.end(),*phase)==phases.end()||std::find(points.begin(),points.end(),*point)==points.end()||integer((*row)[2])<0||integer((*row)[2])>22||integer((*row)[3])<0||integer((*row)[3])>8||integer((*row)[5])<0||integer((*row)[5])>86400000)invalid();r.diagnostic=(*t)[2];return r;}
 const auto outer=envelope(*t);r.session=outer->session;r.sequence=outer->sequence;
 if(r.method==Method::close||r.method==Method::read_diagnostics){if(t->size()!=3)invalid();return r;}
 if(r.method==Method::open_private_key){if(t->size()!=4)invalid();const auto *s=std::get_if<std::string>(&(*t)[3].data);if(!s||s->size()!=66||s->substr(0,2)!="0x")invalid();auto nibble=[](char c)->uint8_t{if(c>='0'&&c<='9')return static_cast<uint8_t>(c-'0');if(c>='a'&&c<='f')return static_cast<uint8_t>(c-'a'+10);invalid();};for(std::size_t i=0;i<32;++i)r.account_id.bytes[i]=static_cast<uint8_t>(nibble((*s)[2+i*2])*16+nibble((*s)[3+i*2]));return r;}
 if(r.method==Method::open_qr_capture||r.method==Method::qr_decode_image){const bool image=r.method==Method::qr_decode_image;if(t->size()!=(image?5U:4U))invalid();const auto purpose=integer((*t)[image?4U:3U]);if(purpose<1||purpose>8||purpose==6)invalid();r.qr_purpose=static_cast<uint32_t>(purpose);if(image){const auto*p=std::get_if<Value::Bytes>(&(*t)[3].data);if(!p||p->empty()||p->size()>kMaximumBytes)invalid();r.payload=*p;}return r;}
 if(r.method==Method::set_qr_capture_torch){if(t->size()!=5)invalid();r.resource_id=identity((*t)[3]);const auto*p=std::get_if<bool>(&(*t)[4].data);if(!p)invalid();r.torch=*p;return r;}
 const bool credential=r.method==Method::respond_credential;if(t->size()!=(credential?5U:4U))invalid();r.resource_id=identity((*t)[3]);
 if(r.method==Method::respond_credential||r.method==Method::cancel_credential){const auto &text=r.resource_id;const auto parsed=std::from_chars(text.data(),text.data()+text.size(),r.host_operation_id);if(parsed.ec!=std::errc{}||parsed.ptr!=text.data()+text.size()||r.host_operation_id==0||(text.size()>1&&text[0]=='0'))invalid();if(credential&&!std::holds_alternative<std::monostate>((*t)[4].data)){const auto*p=std::get_if<Value::Bytes>(&(*t)[4].data);if(!p||p->size()>1024)invalid();r.credential.emplace(*p);}}
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
      stage(failure_stage == 0 ? flutter_default_failure_stage(error_code) : failure_stage) {}
// 非法方法值必须失败，不能转换为另一个有效资源操作。
const char *method_name(Method method) {
  const auto index = static_cast<std::size_t>(method);
  require(index < std::size(kMethods), CITIZENSDK_ERROR_INTEGRITY,
          "Invalid platform method");
  return kMethods[index];
}
bool is_method_name(const std::string&name) noexcept{return std::any_of(std::begin(kMethods),std::end(kMethods),[&](const char*n){return name==n;});}
bool valid_utf8(const std::string&text) noexcept{return inspect_utf8(text,nullptr);}
std::unique_ptr<::flutter::MethodCall<::flutter::EncodableValue>> decode_method_call(
    const uint8_t *message, std::size_t size) {
  WirePreflight(message, size).check();
  auto result = ::flutter::StandardMethodCodec::GetInstance().DecodeMethodCall(message, size);
  require(result != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT, "Invalid standard method call");
  return result;
}
Value from_encodable_value(const ::flutter::EncodableValue &value, bool sensitive) {
  // 总节点/总字节共享递归预算，先扣减再复制；保留 16 MiB payload 的固定 tuple 余量。
  // A valid request has at most 1,995 nodes. The 4,096-node limit bounds
  // recursive copies without changing any supported method's input range.
  std::size_t remaining_nodes = kMaximumRequestNodes;
  std::size_t remaining_bytes = kMaximumRequestCopiedBytes;
  return from_encodable(value, 0, remaining_nodes, remaining_bytes, sensitive);
}
::flutter::EncodableValue to_encodable_value(const Value &value) {
  if (std::holds_alternative<std::monostate>(value.data)) return ::flutter::EncodableValue();
  if (const auto *v = std::get_if<bool>(&value.data)) return ::flutter::EncodableValue(*v);
  if (const auto *v = std::get_if<int64_t>(&value.data)) return ::flutter::EncodableValue(*v);
  if (const auto *v = std::get_if<std::string>(&value.data)) {
    require(valid_utf8(*v), CITIZENSDK_ERROR_INTEGRITY,
            "Public result string is not valid UTF-8");
    return ::flutter::EncodableValue(*v);
  }
  if (const auto *v = std::get_if<Value::Bytes>(&value.data)) {
    return ::flutter::EncodableValue(*v);
  }
  ::flutter::EncodableList result;
  const auto &items = std::get<Value::List>(value.data);
  result.reserve(items.size());
  for (const auto &item : items) result.push_back(to_encodable_value(item));
  return ::flutter::EncodableValue(std::move(result));
}
std::optional<RequestEnvelope> decode_request_envelope(const std::string &name,const ::flutter::EncodableValue *args){if(name=="open"||name=="diagnose")return{};if(!args)invalid();const auto *list=std::get_if<::flutter::EncodableList>(args);if(!list||list->size()<3)invalid();Value::List t;for(std::size_t i=0;i<3;++i)t.push_back(from_encodable_value((*list)[i]));return envelope(t);}
DecodedRequest decode_request(const std::string&name,const ::flutter::EncodableValue *args){return decode(name,args?from_encodable_value(*args,true):Value{});}
bool decode_subscription(const ::flutter::EncodableValue *args){try{const auto value=args?from_encodable_value(*args,true):Value{};const auto*t=std::get_if<Value::List>(&value.data);return t&&t->size()==1&&integer((*t)[0])==2;}catch(...){return false;}}
const char *error_name(citizensdk_error_code_t code) noexcept {
  constexpr const char *names[] = {"ok", "invalidArgument", "invalidHandle", "invalidState",
      "unsupported", "unavailable", "notReady", "notFound", "conflict", "integrity",
      "authenticationCancelled", "authenticationRequired", "keyInvalidated", "permissionDenied",
      "storage", "network", "decode", "timeout", "busy", "queueFull", "internal", "panic", "cancelled"};
  return code >= 0 && static_cast<std::size_t>(code) < std::size(names)
             ? names[static_cast<std::size_t>(code)] : "integrity";
}
Value response(const std::string&s,int64_t n,Value value){return Value::list({Value::integer(2),Value::string(s),Value::integer(n),std::move(value)});}
Value event(const std::string&s,int64_t n,const std::string&type,Value value){return Value::list({Value::integer(2),Value::string(s),Value::integer(n),Value::string(type),std::move(value)});}
Value error_details(citizensdk_error_code_t code,const std::string&message,std::optional<std::string>s,std::optional<int64_t>n,const std::string&method,citizensdk_failure_stage_t stage){return Value::list({Value::integer(2),s?Value::string(*s):Value::null(),n?Value::integer(*n):Value::null(),Value::integer(code),Value::integer(stage?stage:flutter_default_failure_stage(code)),Value::string(method),Value::string(message)});}
Value lifecycle(citizensdk_lifecycle_t value) {
  constexpr const char *names[] = {"created", "importingState", "starting", "running",
                                  "startFailed", "stopped", "disposed"};
  require(value >= 1 && value <= std::size(names), CITIZENSDK_ERROR_INTEGRITY,
          "Unknown Core lifecycle");
  return Value::string(names[value - 1]);
}
} // namespace
