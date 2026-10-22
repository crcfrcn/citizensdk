#include "citizen_sdk_flutter_sessions.hpp"

#include <sys/random.h>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <future>
#include <cerrno>
#include <exception>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>
#include <vector>
#include "citizen_sdk/citizen_sdk.hpp"
#include "citizensdk_qr_image.h"

namespace citizen_sdk::flutter {
namespace {

citizensdk_bytes_view_t view(const std::vector<uint8_t> &bytes) noexcept {
  return {bytes.empty() ? nullptr : bytes.data(), static_cast<uint64_t>(bytes.size())};
}

template <typename Call>
std::vector<uint8_t> qr_core_output(Call call, uint64_t maximum = 65536) {
  uint64_t required = 0;
  auto code = call(nullptr, 0, &required);
  if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK QR output query failed");
  if (required == 0 || required > maximum)
    throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK QR output length is invalid");
  std::vector<uint8_t> output(static_cast<std::size_t>(required));
  code = call(output.data(), required, &required);
  if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK QR output copy failed");
  if (required != output.size())
    throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK QR output length changed");
  return output;
}

// 只检查真实Core结果的ABI/类型/错误阶段，不从展示文本推断成功。
void require_result(citizensdk_result_handle_t result, citizensdk_result_kind_t kind) {
  citizensdk_result_info_t info{};
  info.struct_size = sizeof(info); info.abi_version = CITIZENSDK_ABI_VERSION;
  const auto code = citizensdk_result_get_info(result, &info);
  if (code != CITIZENSDK_OK) throw Error(code, "Core result inspection failed");
  if (info.struct_size != sizeof(info) || info.abi_version != CITIZENSDK_ABI_VERSION)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core result ABI is invalid");
  if (info.error_code != CITIZENSDK_OK) {
    citizensdk_failure_stage_t stage{};
    const auto stage_code = citizensdk_result_get_failure_stage(result, &stage);
    if (stage_code != CITIZENSDK_OK) throw Error(stage_code, "Core result stage query failed");
    throw Error(info.error_code, "Core operation failed", stage);
  }
  if (info.kind != kind) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core result kind is invalid");
}

std::string random_session_id();

// This adapter contains no chain/wallet algorithm. Every accepted method goes
// directly to the same installed Host/Core used by the native C/C++ binding.
class HostTransport final : public NativeTransport, public std::enable_shared_from_this<HostTransport> {
 public:
  HostTransport(const Config &config,Scheduler queue,TextureFactory textures):host_(std::make_unique<Host>(config)),schedule_(std::move(queue)),textures_(std::move(textures)){host_->open();}
  citizensdk_handle_t ffi_handle() override{return host_->native_handle();}
  citizensdk_error_code_t accept_request_sequence(uint64_t sequence) override {if(!host_)return CITIZENSDK_ERROR_INVALID_STATE;const auto core=host_->native_handle();if(core==0&&close_attempted_)return CITIZENSDK_OK;return citizensdk_accept_request_sequence(core,sequence);}
  void require_open(){if(!host_||host_->native_handle()==0)throw Error(CITIZENSDK_ERROR_INVALID_STATE,"Host closed");}
    void observe_resources(ResourceObserver observer) override {
    std::lock_guard<std::mutex> guard(private_keys_->lock);
    private_keys_->observer = std::move(observer);
  }
  void private_key(const DecodedRequest &r, PrivateKeyResource::Completion completion) override {
    if (!host_ || host_->native_handle() == 0)
      throw Error(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Host is closed");
    const auto registry = private_keys_;
    if (r.method == Method::open_private_key) {
      const auto id = random_session_id();
      const std::weak_ptr<PrivateKeys> weak = registry;
      auto resource = std::make_shared<PrivateKeyResource>(host_->native_handle(), id, std::move(completion),
          [weak, id](bool granted) {
            ResourceObserver observer;
            if (const auto owner = weak.lock()) {
              {
                std::lock_guard<std::mutex> guard(owner->lock);
                observer = owner->observer;
                if (!granted) owner->values.erase(id);
              }
              if (observer) observer(granted ? "privateKeyClosed" : "",
                  granted ? Value::list({Value::string(id)}) : Value::list({}));
            }
          });
      {
        std::lock_guard<std::mutex> guard(registry->lock);
        if (!registry->values.emplace(id, resource).second)
          throw Error(CITIZENSDK_ERROR_CONFLICT, "Private key identity collision");
      }
      citizensdk_request_id_t request = 0;
      citizensdk_error_code_t code;
      try {
        code = host_->submit_request(
            [resource, account = r.account_id](citizensdk_handle_t core, citizensdk_request_id_t *out) {
              const auto receiver = resource->receiver();
              uint64_t secret = 0;
              const auto status = citizensdk_private_key_open(core, &account, &receiver, &secret, out);
              if (status == CITIZENSDK_OK) resource->bind(secret);
              return status;
            },
            [resource](citizensdk_request_id_t, citizensdk_result_handle_t result) {
              detail::EventResultScope owned(result);
              citizensdk_error_code_t status = CITIZENSDK_OK;
              try { require_result(result, CITIZENSDK_RESULT_EMPTY); }
              catch (const Error &error) { status = error.code(); }
              catch (...) { status = CITIZENSDK_ERROR_INTERNAL; }
              resource->terminal(status);
            },
            [resource](citizensdk_handle_t) { resource->request_close(); }, &request);
      } catch (...) {
        resource->terminal(CITIZENSDK_ERROR_INTERNAL); return;
      }
      if (code != CITIZENSDK_OK) resource->terminal(code);
      return;
    }
    std::shared_ptr<PrivateKeyResource> resource;
    {
      std::lock_guard<std::mutex> guard(registry->lock);
      const auto found = registry->values.find(r.resource_id);
      if (found == registry->values.end())
        throw Error(CITIZENSDK_ERROR_NOT_FOUND, "Private key resource is not owned by this session");
      resource = found->second;
    }
    if (r.method == Method::reveal_private_key) {
      resource->reveal(std::move(completion)); return;
    }
    if (r.method != Method::close_private_key)
      throw Error(CITIZENSDK_ERROR_UNSUPPORTED, "Unsupported private key control");
    const auto id = r.resource_id;
    const std::weak_ptr<PrivateKeys> weak = registry;
    resource->close([weak, resource, id, completion = std::move(completion)](std::function<Value()> project) {
      completion([weak, resource, id, project = std::move(project)] {
        auto value = project();
        if (!resource->is_closed())
          throw Error(CITIZENSDK_ERROR_INTEGRITY, "Private key close has no real terminal");
        if (const auto owner = weak.lock()) {
          std::lock_guard<std::mutex> guard(owner->lock);
          const auto found = owner->values.find(id);
          if (found != owner->values.end() && found->second == resource) owner->values.erase(found);
        }
        return value;
      });
    });
  }
  void close_private_keys() override {
    std::vector<std::shared_ptr<PrivateKeyResource>> resources;
    {
      std::lock_guard<std::mutex> guard(private_keys_->lock);
      for (const auto &entry : private_keys_->values) resources.push_back(entry.second);
    }
    std::exception_ptr first;
    for (const auto &resource : resources) {
      try { resource->request_close(); } catch (...) { if (!first) first = std::current_exception(); }
    }
    if (first) std::rethrow_exception(first);
  }
  bool private_keys_closed() override {
    std::lock_guard<std::mutex> guard(private_keys_->lock);
    for (const auto &entry : private_keys_->values) if (!entry.second->is_closed()) return false;
    return true;
  }
  void capture(const DecodedRequest &r, PrivateKeyResource::Completion completion) override {
    if (r.method == Method::qr_decode_image) {
      if (image_jobs_ >= 4) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "图片解码任务已达上限");
      ++image_jobs_;
      const auto self = shared_from_this();
      try {
        std::thread worker([self, bytes = r.payload, purpose = r.qr_purpose, completion = std::move(completion)]() mutable {
          std::optional<Value> result;
          std::exception_ptr failure;
          try {
            const auto packet = qr_core_output([&](uint8_t *buffer, uint64_t capacity, uint64_t *required) {
              return citizensdk_host_decode_qr_image(self->host_->host_handle(), view(bytes), purpose, buffer, capacity, required);
            }, 4U * 1024U * 1024U + 260);
            std::size_t offset = 0;
            const auto read_u32 = [&]() {
              if (packet.size() - offset < 4) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片结果长度被截断");
              uint32_t value = 0;
              for (unsigned shift = 0; shift < 32; shift += 8) value |= static_cast<uint32_t>(packet[offset++]) << shift;
              return value;
            };
            const auto count = read_u32();
            if (count > 64) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片二维码数量超限");
            Value::List documents;
            for (uint32_t index = 0; index < count; ++index) {
              const auto length = read_u32();
              if (length == 0 || length > 65536 || packet.size() - offset < length)
                throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片文档大小无效");
              documents.push_back(Value::string(std::string(reinterpret_cast<const char *>(packet.data() + offset), length)));
              offset += length;
            }
            if (offset != packet.size()) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片结果有多余字节");
            result = Value::list({Value::list(std::move(documents))});
          } catch (...) { failure = std::current_exception(); }
          // 有限worker拥有Host至两个同步投影返回；关闭仍由同一路由等待此终态。
          --self->image_jobs_;
          completion([result = std::move(result), failure]() mutable {
            if (failure) std::rethrow_exception(failure);
            return std::move(*result);
          });
        });
        worker.detach();
      } catch (...) { --image_jobs_; throw; }
      return;
    }
    if (r.method == Method::open_qr_capture) {
      if (!textures_) throw Error(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注册器不可用");
      if (captures_.size() >= 4) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "采集资源已达上限");
      const auto id = random_session_id();
      const std::weak_ptr<HostTransport> weak = shared_from_this();
      auto resource = std::make_shared<CaptureResource>(host_->host_handle(), id, r.qr_purpose, schedule_, textures_,
          [weak](std::string type, Value value) {
            if (const auto owner = weak.lock()) owner->resource_event(std::move(type), std::move(value));
          },
          [weak, id](bool granted) {
            if (const auto owner = weak.lock()) {
              owner->captures_.erase(id);
              owner->resource_event(granted ? "qrCaptureClosed" : "",
                  granted ? Value::list({Value::string(id)}) : Value::list({}));
            }
          });
      if (!captures_.emplace(id, resource).second) throw Error(CITIZENSDK_ERROR_CONFLICT, "采集资源编号冲突");
      try { resource->open(std::move(completion)); }
      catch (...) { captures_.erase(id); throw; }
      return;
    }
    const auto found = captures_.find(r.resource_id);
    if (found == captures_.end()) throw Error(CITIZENSDK_ERROR_NOT_FOUND, "采集资源不属于本实例");
    const auto resource = found->second;
    resource->control(r.method, r.torch, std::move(completion));
  }
  void close_captures() override {
    std::vector<std::shared_ptr<CaptureResource>> resources;
    for (const auto &entry : captures_) resources.push_back(entry.second);
    std::exception_ptr failure;
    for (const auto &resource : resources) {
      try { resource->request_close(); } catch (...) { if (!failure) failure = std::current_exception(); }
    }
    if (failure) std::rethrow_exception(failure);
  }
  bool captures_closed() override { return captures_.empty() && image_jobs_.load() == 0; }
  void resource_event(std::string type, Value value) {
    ResourceObserver observer;
    { std::lock_guard<std::mutex> guard(private_keys_->lock); observer = private_keys_->observer; }
    if (observer) observer(std::move(type), std::move(value));
  }
  void cancel_credential(uint64_t id) override {
    const auto code = citizensdk_host_cancel_credential(host_->host_handle(), id);
    if (code != CITIZENSDK_OK && code != CITIZENSDK_ERROR_INVALID_STATE &&
        code != CITIZENSDK_ERROR_NOT_FOUND)
      throw Error(code, "CitizenSDK credential cancellation failed");
  }
  bool cancel(citizensdk_request_id_t request) override {
    const auto code = citizensdk_cancel_request(host_->native_handle(), request);
    if (code != CITIZENSDK_OK && code != CITIZENSDK_ERROR_NOT_FOUND &&
        code != CITIZENSDK_ERROR_INVALID_HANDLE)
      throw Error(code, "CitizenSDK request cancellation failed");
    return code == CITIZENSDK_OK;
  }
  citizensdk_lifecycle_t lifecycle_state() override {
    if(!host_)throw Error(CITIZENSDK_ERROR_INVALID_STATE,"Host retired");
    const auto core=host_->native_handle();if(core==0&&close_attempted_)return checkpoint_state_;
    citizensdk_lifecycle_t state{};const auto code=citizensdk_get_lifecycle(core,&state);if(code)throw Error(code,"Core lifecycle failed");return state;
  }
  citizensdk_error_code_t stop(Completion completion,citizensdk_request_id_t *out) override {
    const auto self=shared_from_this();return host_->submit_request(citizensdk_stop,[self,completion=std::move(completion)](uint64_t id,uint64_t result){auto owned=std::make_shared<detail::EventResultScope>(result);completion(id,[self,owned]{require_result(owned->value,CITIZENSDK_RESULT_EMPTY);return Value::list({lifecycle(self->lifecycle_state())});});},[](uint64_t){},out);
  }
  void close() override {if(!close_attempted_){checkpoint_state_=lifecycle_state();if(checkpoint_state_!=CITIZENSDK_LIFECYCLE_CREATED&&checkpoint_state_!=CITIZENSDK_LIFECYCLE_STOPPED&&checkpoint_state_!=CITIZENSDK_LIFECYCLE_START_FAILED)throw Error(CITIZENSDK_ERROR_INVALID_STATE,"Core requires stop");close_attempted_=true;}host_->close();host_.reset();}
  void retire() noexcept override {host_.reset();}
 private:
  struct PrivateKeys final {std::mutex lock;std::map<std::string,std::shared_ptr<PrivateKeyResource>> values;ResourceObserver observer;};
  std::shared_ptr<PrivateKeys> private_keys_{std::make_shared<PrivateKeys>()};
  std::unique_ptr<Host> host_;Scheduler schedule_;TextureFactory textures_;
  std::map<std::string,std::shared_ptr<CaptureResource>> captures_;std::atomic<uint32_t> image_jobs_{0};
  bool close_attempted_{};citizensdk_lifecycle_t checkpoint_state_{CITIZENSDK_LIFECYCLE_CREATED};
};
std::string random_session_id() {
  std::array<uint8_t, 16> bytes{};
  std::size_t done = 0;
  while (done < bytes.size()) {
    const auto count = getrandom(bytes.data() + done, bytes.size() - done, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                                         "CitizenSDK session entropy is unavailable");
    done += static_cast<std::size_t>(count);
  }
  static constexpr char hex[] = "0123456789abcdef";
  std::string value; value.reserve(32);
  for (const auto byte : bytes) {
    value.push_back(hex[static_cast<std::size_t>(byte >> 4)]);
    value.push_back(hex[static_cast<std::size_t>(byte & 15)]);
  }
  return value;
}
Reply failure(citizensdk_error_code_t code, const std::string &message,
              const DecodedRequest &request, citizensdk_failure_stage_t stage = 0) {
  const bool open = request.method == Method::open;
  return {false, error_details(code, message,
          open ? std::optional<std::string>{} : request.session,
          open ? std::optional<int64_t>{} : request.sequence,
          method_name(request.method), stage), code, message};
}
Reply success(const DecodedRequest &request,Value payload){return{true,response(request.session,request.sequence,std::move(payload)),CITIZENSDK_OK,{}};}
} // namespace

PrivateKeyResource::PrivateKeyResource(citizensdk_handle_t core, std::string id,
    Completion opened, Closed closed)
    : PrivateKeyResource(core, std::move(id), std::move(opened), std::move(closed),
          {citizensdk_private_key_reveal, citizensdk_private_key_cancel, citizensdk_private_key_finish}) {}

PrivateKeyResource::PrivateKeyResource(citizensdk_handle_t core, std::string id,
    Completion opened, Closed closed, PrivateKeyControls controls)
    : core_(core), controls_(std::move(controls)), id_(std::move(id)),
      opened_(std::move(opened)), closed_(std::move(closed)) {
  if (!controls_.reveal || !controls_.cancel || !controls_.finish)
    throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Private key control table is incomplete");
}

citizensdk_private_key_receiver_v1_t PrivateKeyResource::receiver() noexcept {
  return {sizeof(citizensdk_private_key_receiver_v1_t), CITIZENSDK_ABI_VERSION, this,
          receive, settled, authorizing};
}

void PrivateKeyResource::bind(uint64_t secret) {
  bool revoked;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (secret == 0 || (secret_ != 0 && secret_ != secret)) std::terminate();
    secret_ = secret; revoked = revoked_;
  }
  if (revoked) { try { request_close(); } catch (...) { /* 保留所有权，Host关闭钩子继续请求。 */ } }
}

int32_t PrivateKeyResource::authorizing(void *raw, uint64_t secret, uint64_t operation) noexcept {
  auto *self = static_cast<PrivateKeyResource *>(raw);
  if (!self || secret == 0 || operation == 0) return CITIZENSDK_ERROR_INTEGRITY;
  try {
    std::lock_guard<std::mutex> guard(self->lock_);
    if (self->revoked_ || self->terminal_) return CITIZENSDK_ERROR_CANCELLED;
    if (!self->revealing_ || self->host_operation_ != 0 ||
        (self->secret_ != 0 && self->secret_ != secret)) return CITIZENSDK_ERROR_INTEGRITY;
    self->secret_ = secret; self->host_operation_ = operation;
    // 此OK仅接纳准确授权关联；后续实际Vault仍须使用真实凭据完成解密，绝非认证成功。
    return CITIZENSDK_OK;
  } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
}

int32_t PrivateKeyResource::receive(void *raw, uint64_t secret, citizensdk_bytes_view_t bytes) noexcept {
  auto *self = static_cast<PrivateKeyResource *>(raw);
  if (!self || secret == 0 || !bytes.data || bytes.len != 32) return CITIZENSDK_ERROR_INTEGRITY;
  try {
    std::lock_guard<std::mutex> guard(self->lock_);
    if (self->revoked_ || self->terminal_) return CITIZENSDK_ERROR_CANCELLED;
    if (self->secret_ != secret || !self->revealing_ || self->host_operation_ == 0 ||
        self->received_) return CITIZENSDK_ERROR_INTEGRITY;
    self->bytes_.emplace(bytes.data, 32);
    self->received_ = true;
    return CITIZENSDK_OK;
  } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
}

void PrivateKeyResource::settled(void *raw, uint64_t secret, int32_t code) noexcept {
  if (!raw) std::terminate();
  try { static_cast<PrivateKeyResource *>(raw)->stage(secret, code); }
  catch (...) { std::terminate(); } // 不能跨C边界抛出或丢弃仍由Core借用的context。
}

void PrivateKeyResource::deliver_failure(Completion completion, citizensdk_error_code_t code) {
  if (!completion) return;
  const auto self = shared_from_this();
  completion([self, code]() -> Value {
    // producer由平台线程领取；不在receiver借用回调内反调Core。
    try { self->request_close(); } catch (...) { /* 打开/查看交付原错误，关闭仍可重试。 */ }
    throw Error(code, "Private key resource did not become available");
  });
}

void PrivateKeyResource::stage(uint64_t secret, citizensdk_error_code_t code) {
  Completion completion;
  bool opening = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (secret == 0 || (secret_ != 0 && secret_ != secret)) code = CITIZENSDK_ERROR_INTEGRITY;
    else secret_ = secret;
    if (!prepared_) {
      prepared_ = true; opening = true; completion = std::move(opened_);
    } else if (revealing_) {
      completion = std::move(revealed_);
      if (code == CITIZENSDK_OK && !received_) code = CITIZENSDK_ERROR_INTEGRITY;
    }
    if (revoked_ && code == CITIZENSDK_OK) code = CITIZENSDK_ERROR_CANCELLED;
    if (code != CITIZENSDK_OK) { revoked_ = true; bytes_.reset(); }
  }
  if (!completion) return;
  if (code != CITIZENSDK_OK) { deliver_failure(std::move(completion), code); return; }
  const auto self = shared_from_this();
  completion([self, opening] { return opening ? self->grant() : self->take_secret(); });
}

Value PrivateKeyResource::grant() {
  auto value = Value::list({Value::string(id_)});
  std::lock_guard<std::mutex> guard(lock_);
  if (revoked_ || terminal_) throw Error(CITIZENSDK_ERROR_CANCELLED, "Private key resource was revoked");
  granted_ = true;
  return value;
}

Value PrivateKeyResource::take_secret() {
  std::lock_guard<std::mutex> guard(lock_);
  if (revoked_ || terminal_) throw Error(CITIZENSDK_ERROR_CANCELLED, "Private key delivery was revoked");
  if (delivered_ || !bytes_ || bytes_->value.size() != 32)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Private key delivery is invalid");
  // 只在平台线程最终领取时交付，排队阶段不持有脱离撤销控制的明文结果。
  auto result = Value::list({Value::sensitive_bytes(std::move(bytes_->value))});
  bytes_.reset(); delivered_ = true;
  return result;
}

void PrivateKeyResource::reveal(Completion completion) {
  uint64_t secret;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (!prepared_ || revealing_ || revoked_ || terminal_)
      throw Error(CITIZENSDK_ERROR_INVALID_STATE, "Private key resource is not ready for reveal");
    revealing_ = true; revealed_ = std::move(completion); secret = secret_;
  }
  const auto code = controls_.reveal(core_, secret);
  if (code != CITIZENSDK_OK) {
    Completion rejected;
    { std::lock_guard<std::mutex> guard(lock_); rejected = std::move(revealed_); revoked_ = true; }
    deliver_failure(std::move(rejected), code);
  }
}

void PrivateKeyResource::request_close() {
  uint64_t secret;
  {
    std::lock_guard<std::mutex> guard(lock_);
    revoked_ = true; bytes_.reset();
    if (terminal_) return;
    secret = secret_;
  }
  if (secret == 0) return; // 接纳仍未返回；bind负责补发已登记的关闭。
  const auto cancel = controls_.cancel(core_, secret);
  if (cancel != CITIZENSDK_OK && cancel != CITIZENSDK_ERROR_NOT_FOUND)
    throw Error(cancel, "Private key cancellation failed");
  const auto finish = controls_.finish(core_, secret);
  if (finish != CITIZENSDK_OK && finish != CITIZENSDK_ERROR_NOT_FOUND)
    throw Error(finish, "Private key finish was not accepted");
  // NOT_FOUND也必须等待该请求真实terminal，不能在这里补造closed。
}

void PrivateKeyResource::close(Completion completion) {
  const auto delivered = std::make_shared<std::atomic<bool>>(false);
  Completion once = [completion = std::move(completion), delivered](std::function<Value()> value) {
    if (!delivered->exchange(true)) completion(std::move(value));
  };
  bool ended;
  {
    std::lock_guard<std::mutex> guard(lock_);
    ended = terminal_;
    if (!ended) closing_.push_back(once);
  }
  if (ended) { once([] { return Value::list({}); }); return; }
  try { request_close(); }
  catch (const Error &error) {
    const auto code = error.code(); const auto stage = error.stage();
    once([code, stage]() -> Value { throw Error(code, "Private key close must be retried", stage); });
  } catch (...) {
    once([]() -> Value { throw Error(CITIZENSDK_ERROR_INTERNAL, "Private key close failed"); });
  }
}

void PrivateKeyResource::terminal(citizensdk_error_code_t code) {
  Completion opened, revealed;
  std::vector<Completion> closing;
  Closed closed;
  bool granted;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (terminal_) return;
    terminal_ = true; revoked_ = true; bytes_.reset();
    opened = std::move(opened_); revealed = std::move(revealed_);
    closing.swap(closing_); closed = std::move(closed_); granted = granted_;
  }
  const auto failure = code == CITIZENSDK_OK ? CITIZENSDK_ERROR_CANCELLED : code;
  deliver_failure(std::move(opened), failure);
  deliver_failure(std::move(revealed), failure);
  // 业务错误已由打开/查看交付；真实Core请求结束才使close成功，认证取消不是关闭失败。
  for (auto &completion : closing) completion([] { return Value::list({}); });
  if (closed) { try { closed(granted); } catch (...) { /* 真实终态已记录；下一次平台入口继续排空。 */ } }
}

bool PrivateKeyResource::is_closed() const {
  std::lock_guard<std::mutex> guard(lock_);
  return terminal_;
}


struct CaptureResource::State final {
  citizensdk_host_handle_t host;
  std::string id;
  uint32_t purpose;
  Scheduler schedule;
  TextureFactory textures;
  Observer observer;
  Closed closed;
  CaptureControls controls;
  uint64_t native{}, operation{};
  uint32_t width{}, height{}, rotation{};
  bool revoked{}, published{}, host_released{}, texture_closing{}, texture_drained{true}, finished{}, paused{true};
  citizensdk_error_code_t terminal{CITIZENSDK_OK};
  Completion opening;
  std::map<uint64_t, std::pair<Method, Completion>> pending;
  std::vector<Completion> closing;
  std::shared_ptr<CaptureTexture> texture;
  // 只有anchor、最新帧及交付代际跨线程；业务/Flutter状态始终只在平台线程读写。
  std::mutex lock;
  std::shared_ptr<CaptureResource> anchor;
  std::shared_ptr<const std::vector<uint8_t>> latest;
  bool frame_queued{}, document_queued{}, error_queued{};
  std::atomic<uint64_t> delivery_epoch{0};

  State(citizensdk_host_handle_t value, std::string identity, uint32_t use, Scheduler queue,
        TextureFactory factory, Observer events, Closed done, CaptureControls calls)
      : host(value), id(std::move(identity)), purpose(use), schedule(std::move(queue)),
        textures(std::move(factory)), observer(std::move(events)), closed(std::move(done)), controls(std::move(calls)) {}
  static void complete(Completion callback, citizensdk_error_code_t code) {
    if (callback) callback([code] {
      if (code != CITIZENSDK_OK) throw Error(code, "采集资源操作失败");
      return Value::list({});
    });
  }
};

CaptureResource::CaptureResource(citizensdk_host_handle_t host, std::string id, uint32_t purpose,
    Scheduler schedule, TextureFactory textures, Observer observer, Closed closed)
    : CaptureResource(host, std::move(id), purpose, std::move(schedule), std::move(textures),
        std::move(observer), std::move(closed), {citizensdk_host_open_qr_capture, citizensdk_host_control_qr_capture}) {}
CaptureResource::CaptureResource(citizensdk_host_handle_t host, std::string id, uint32_t purpose,
    Scheduler schedule, TextureFactory textures, Observer observer, Closed closed, CaptureControls controls)
    : state_(std::make_unique<State>(host, std::move(id), purpose, std::move(schedule), std::move(textures),
        std::move(observer), std::move(closed), std::move(controls))) {
  if (!host || state_->id.empty() || purpose < 1 || purpose > 8 || !state_->schedule ||
      !state_->textures || !state_->closed || !state_->controls.open || !state_->controls.control)
    throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集资源配置不完整");
}
CaptureResource::~CaptureResource() = default;

void CaptureResource::enqueue(std::function<void()> action) noexcept {
  try { state_->schedule(std::move(action)); }
  catch (...) {
    // 排队失败不等于设备/纹理已释放；保有资源，禁止虚报完成或继续裸指针析构。
    std::lock_guard<std::mutex> guard(state_->lock);
    if (!state_->anchor) state_->anchor = shared_from_this();
  }
}
void CaptureResource::retain(void *raw) noexcept {
  auto &self = *static_cast<CaptureResource *>(raw);
  std::lock_guard<std::mutex> guard(self.state_->lock);
  self.state_->anchor = self.shared_from_this();
}
void CaptureResource::release(void *raw) noexcept {
  auto &self = *static_cast<CaptureResource *>(raw);
  std::shared_ptr<CaptureResource> owner;
  { std::lock_guard<std::mutex> guard(self.state_->lock); owner = std::move(self.state_->anchor); }
  if (!owner) return;
  // Host已经归还自身租约；这里只排队，不从release反调Host。
  self.enqueue([owner] { owner->state_->host_released = true; owner->finish_close(); });
}
void CaptureResource::open(Completion completion) {
  auto &s = *state_;
  if (s.opening || s.native || s.finished || s.revoked) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "采集资源不可重复打开");
  s.opening = std::move(completion);
  const citizensdk_qr_capture_callbacks_v1_t callbacks{sizeof(citizensdk_qr_capture_callbacks_v1_t),
      CITIZENSDK_HOST_ABI_VERSION, this, opened, frame, document, error, controlled, closed, retain, release};
  uint64_t id = 0;
  const auto code = s.controls.open(s.host, s.purpose, &callbacks, &id);
  if (code != CITIZENSDK_OK) {
    s.terminal = code; s.host_released = true; s.revoked = true; finish_close(); return;
  }
  if (id == 0) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Host采集接纳返回空编号");
  s.native = id;
}
void CaptureResource::opened(void *raw, uint64_t native, citizensdk_error_code_t code,
    uint32_t width, uint32_t height, uint32_t rotation) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  self->enqueue([self, native, code, width, height, rotation] {
    auto &s = *self->state_;
    if (native != s.native) { s.terminal = CITIZENSDK_ERROR_INTEGRITY; self->request_close(); return; }
    if (code != CITIZENSDK_OK) { s.terminal = code; return; } // 失败也等Host最终release。
    if (s.revoked) return;
    try {
      if (width == 0 || width > 4096 || height == 0 || height > 4096 || rotation > 270 || rotation % 90)
        throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集预览规格无效");
      s.width = width; s.height = height; s.rotation = rotation;
      s.texture = s.textures(width, height);
      if (s.texture) s.texture_drained = false;
      if (!s.texture || s.texture->id() < 0) throw Error(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理不可用");
      auto completion = std::move(s.opening);
      if (completion) completion([self] {
        auto &current = *self->state_;
        if (current.revoked || current.finished || !current.texture)
          throw Error(CITIZENSDK_ERROR_CANCELLED, "采集打开交付已撤销");
        current.published = true;
        return Value::list({Value::string(current.id), Value::integer(current.texture->id()),
            Value::integer(current.width), Value::integer(current.height), Value::integer(current.rotation)});
      });
    } catch (const Error &failure) { s.terminal = failure.code(); self->request_close(); }
    catch (const ContractFailure &failure) { s.terminal = failure.code; self->request_close(); }
    catch (...) { s.terminal = CITIZENSDK_ERROR_INTERNAL; self->request_close(); }
  });
}
void CaptureResource::frame(void *raw, uint64_t, const citizensdk_qr_frame_v1_t *value) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  try {
    if (!value || value->struct_size != sizeof(*value) || value->abi_version != CITIZENSDK_HOST_ABI_VERSION ||
        value->width == 0 || value->width > 4096 || value->height == 0 || value->height > 4096 ||
        !value->rgba.data || value->rgba.len != static_cast<uint64_t>(value->width) * value->height * 4)
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集像素规格无效");
    auto pixels = std::make_shared<const std::vector<uint8_t>>(value->rgba.data, value->rgba.data + value->rgba.len);
    {
      std::lock_guard<std::mutex> guard(self->state_->lock);
      self->state_->latest = std::move(pixels);
      if (self->state_->frame_queued) return;
      self->state_->frame_queued = true;
    }
    self->enqueue([self] {
      std::shared_ptr<const std::vector<uint8_t>> latest;
      {
        std::lock_guard<std::mutex> guard(self->state_->lock);
        latest = std::move(self->state_->latest); self->state_->frame_queued = false;
      }
      auto &s = *self->state_;
      if (s.revoked || !s.texture || !latest) return;
      try { s.texture->update(std::move(latest)); }
      catch (...) { s.terminal = CITIZENSDK_ERROR_UNAVAILABLE; self->request_close(); }
    });
  } catch (...) {
    self->enqueue([self] { self->state_->terminal = CITIZENSDK_ERROR_INTEGRITY; self->request_close(); });
  }
}
void CaptureResource::document(void *raw, uint64_t native, uint64_t, citizensdk_bytes_view_t bytes) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  try {
    if (!bytes.data || bytes.len == 0 || bytes.len > 65536) throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集文档大小无效");
    { std::lock_guard<std::mutex> guard(self->state_->lock);
      if (self->state_->document_queued) return;
      self->state_->document_queued = true; }
    const auto epoch = self->state_->delivery_epoch.load();
    std::string json(reinterpret_cast<const char *>(bytes.data), static_cast<std::size_t>(bytes.len));
    self->enqueue([self, native, epoch, json = std::move(json)] {
      { std::lock_guard<std::mutex> guard(self->state_->lock); self->state_->document_queued = false; }
      auto &s = *self->state_;
      if (native != s.native || s.revoked || s.paused || !s.published || epoch != s.delivery_epoch.load()) return;
      if (s.observer) s.observer("qrCaptureResult", Value::list({
          Value::string(s.id), Value::integer(s.purpose), Value::string(json)}));
    });
  } catch (...) {
    { std::lock_guard<std::mutex> guard(self->state_->lock); self->state_->document_queued = false; }
    error(raw, native, CITIZENSDK_ERROR_INTEGRITY);
  }
}
void CaptureResource::report_error(citizensdk_error_code_t code) {
  if (code == CITIZENSDK_OK || !state_->published || state_->revoked || !state_->observer) return;
  state_->observer("qrCaptureError", Value::list({Value::string(state_->id), Value::integer(code),
      Value::string(error_name(code)), Value::integer(flutter_default_failure_stage(code))}));
}
void CaptureResource::error(void *raw, uint64_t native, citizensdk_error_code_t code) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  { std::lock_guard<std::mutex> guard(self->state_->lock);
    if (self->state_->error_queued) return;
    self->state_->error_queued = true; }
  const auto epoch = self->state_->delivery_epoch.load();
  self->enqueue([self, native, epoch, code] {
    { std::lock_guard<std::mutex> guard(self->state_->lock); self->state_->error_queued = false; }
    if (native == self->state_->native && epoch == self->state_->delivery_epoch.load()) self->report_error(code);
  });
}
void CaptureResource::controlled(void *raw, uint64_t native, uint64_t operation, citizensdk_error_code_t code) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  self->enqueue([self, native, operation, code] {
    auto &s = *self->state_;
    if (native != s.native) return;
    const auto found = s.pending.find(operation);
    if (found == s.pending.end()) return;
    const auto method = found->second.first;
    auto completion = std::move(found->second.second); s.pending.erase(found);
    if (method == Method::resume_qr_capture && code == CITIZENSDK_OK && !s.revoked &&
        operation == s.delivery_epoch.load()) s.paused = false;
    State::complete(std::move(completion), code);
  });
}
void CaptureResource::closed(void *raw, uint64_t native, citizensdk_error_code_t code) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  self->enqueue([self, native, code] {
    auto &s = *self->state_;
    if (native != s.native) s.terminal = CITIZENSDK_ERROR_INTEGRITY;
    else if (code != CITIZENSDK_OK) s.terminal = code;
    self->report_error(s.terminal);
    s.revoked = true; s.paused = true;
    self->begin_texture_close(); self->finish_close();
  });
}
void CaptureResource::begin_texture_close() {
  auto &s = *state_;
  if (!s.texture || s.texture_closing || s.texture_drained) return;
  s.texture_closing = true;
  const auto self = shared_from_this();
  try {
    s.texture->close([self] {
      self->enqueue([self] {
        self->state_->texture_drained = true;
        self->state_->texture.reset();
        self->finish_close();
      });
    });
  } catch (...) { s.texture_closing = false; throw; } // 注销失败仍保有纹理，可再次关闭。
}
void CaptureResource::request_close() {
  auto &s = *state_;
  if (s.finished) return;
  s.revoked = true; s.paused = true;
  if (s.native && !s.host_released) {
    if (s.operation == UINT64_MAX) throw Error(CITIZENSDK_ERROR_UNAVAILABLE, "采集控制编号耗尽");
    const auto operation = ++s.operation; s.delivery_epoch.store(operation);
    const auto code = s.controls.control(s.host, s.native, operation, 4, 0);
    // 已从Host表移除的资源仍要等已排队release，不能直接认定关闭。
    if (code != CITIZENSDK_OK && code != CITIZENSDK_ERROR_NOT_FOUND)
      throw Error(code, "采集关闭接纳失败");
  }
  begin_texture_close(); finish_close();
}
void CaptureResource::control(Method method, bool enabled, Completion completion) {
  auto &s = *state_;
  if (method == Method::close_qr_capture) {
    if (s.finished) { State::complete(std::move(completion), s.terminal); return; }
    if (s.closing.size() >= 64) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "采集关闭等待已达上限");
    s.closing.push_back(std::move(completion));
    try { request_close(); }
    catch (...) { if (!s.closing.empty()) s.closing.pop_back(); throw; }
    return;
  }
  if (s.revoked || s.finished || !s.native || !s.published)
    throw Error(CITIZENSDK_ERROR_INVALID_STATE, "采集资源未就绪或已关闭");
  const uint32_t action = method == Method::pause_qr_capture ? 1 : method == Method::resume_qr_capture ? 2 :
      method == Method::set_qr_capture_torch ? 3 : 0;
  if (!action) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集控制无效");
  if (s.pending.size() >= 64 || s.operation == UINT64_MAX) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "采集控制已达上限");
  const auto operation = ++s.operation;
  s.pending.emplace(operation, std::make_pair(method, std::move(completion)));
  const auto code = s.controls.control(s.host, s.native, operation, action, action == 3 && enabled ? 1 : 0);
  if (code != CITIZENSDK_OK) {
    auto callback = std::move(s.pending.at(operation).second); s.pending.erase(operation);
    State::complete(std::move(callback), code); return;
  }
  if (action == 1 || action == 2) {
    s.delivery_epoch.store(operation); s.paused = true;
  }
}
void CaptureResource::finish_close() {
  auto &s = *state_;
  if (s.finished || !s.host_released || !s.texture_drained) return;
  s.finished = true; s.revoked = true;
  State::complete(std::move(s.opening), s.terminal == CITIZENSDK_OK ? CITIZENSDK_ERROR_CANCELLED : s.terminal);
  auto controls = std::move(s.pending);
  for (auto &entry : controls) State::complete(std::move(entry.second.second), CITIZENSDK_ERROR_CANCELLED);
  auto closing = std::move(s.closing);
  for (auto &completion : closing) State::complete(std::move(completion), s.terminal);
  auto done = std::move(s.closed);
  if (done) done(s.published);
}
bool CaptureResource::is_closed() const noexcept { return state_->finished; }

struct Sessions::State final : std::enable_shared_from_this<State> {
  struct Route final {
    DecodedRequest request;
    ReplyCallback reply;
    citizensdk_request_id_t native_id{};
    std::optional<Reply> ready;
    std::function<Value()> projection;
    bool accepting{};
    bool terminal_seen{};
    bool completed{};
    bool close_stop{};
  };
  struct CredentialReply;
  struct Session final {
    std::string id;
    // 只保存闭集方法、阶段和错误码，不保存route、参数或异常文本。
    std::vector<Value> diagnostics;
    std::shared_ptr<NativeTransport> transport;

    int64_t next_event{1};
    std::mutex lock;
    std::map<int64_t, std::shared_ptr<Route>> routes;
    std::map<uint64_t, std::shared_ptr<CredentialReply>> credentials;
    bool closing{};
    bool retired{};
    std::optional<DecodedRequest> close_request;
    ReplyCallback close_reply;
  };

  State(EnvironmentFactory source, Scheduler queue, TransportFactory make)
      : environment(std::move(source)), schedule(std::move(queue)),
        factory(std::move(make)), owner(std::this_thread::get_id()) {}
  EnvironmentFactory environment;
  Scheduler schedule;
  TransportFactory factory;
  std::thread::id owner;
  std::map<std::string, std::shared_ptr<Session>> sessions;
  EventSink sink;
  // 仅系统资源控制留在平台线程，普通业务已由Dart直接调用Core。

  // The callback thread snapshots epoch under this lock; all Flutter objects
  // remain UI-owned and are never accessed from that thread.
  std::mutex epoch_lock;
  uint64_t epoch{};
  bool detached{};
  std::shared_ptr<State> detached_owner;
  void retain_detached_state() {
    // detach 只撤销 Flutter 回调，不等于原生操作完成。自保活无需新增线程或
    // 分配全局队列；待已接受请求排空后解除，再交既有 Host supervisor。
    if (!detached_owner) detached_owner = shared_from_this();
  }
  void release_detached_state_if_empty() {
    if (sessions.empty()) detached_owner.reset();
  }

  void require_owner() const {
    if (std::this_thread::get_id() != owner)
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE,
                            "CitizenSDK Flutter entry point requires the UI thread");
  }

  uint64_t snapshot_epoch() {
    std::lock_guard<std::mutex> guard(epoch_lock);
    return epoch;
  }
  void advance_epoch(bool detach_now = false) {
    std::lock_guard<std::mutex> guard(epoch_lock);
    if (epoch == std::numeric_limits<uint64_t>::max()) {
      detached = true;
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                            "CitizenSDK subscription generation is exhausted");
    }
    ++epoch;
    if (detach_now) detached = true;
  }
  bool is_detached() {
    std::lock_guard<std::mutex> guard(epoch_lock);
    return detached;
  }

  bool current(const std::shared_ptr<Session> &session) const {
    const auto found = sessions.find(session->id);
    return found != sessions.end() && found->second == session && !session->retired;
  }
  void emit(const std::shared_ptr<Session> &session, const std::string &type,
            Value payload, uint64_t expected) {
    if (is_detached() || expected != snapshot_epoch() || !sink || !current(session)) return;
    if (session->next_event == std::numeric_limits<int64_t>::max()) {
      // Fail closed instead of wrapping/reusing an event sequence.
      cancel_events();
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                            "CitizenSDK event sequence is exhausted");
    }
    const auto sequence = session->next_event++;
    auto callback = sink;
    callback(event(session->id, sequence, type, std::move(payload)));
  }


  void post_drain(const std::shared_ptr<Session> &session) noexcept {
    try {
      std::weak_ptr<State> weak = shared_from_this();
      std::weak_ptr<Session> target = session;
      schedule([weak, target] {
        if (const auto state = weak.lock()) if (const auto value = target.lock()) {
          try { state->drain(value); } catch (...) {}
        }
      });
    } catch (...) {
      // Route::ready remains authoritative until the next UI dispatch/drain.
      // No borrowed result or callback pointer is stored in this recovery path.
    }
  }

  using CredentialValue = std::optional<std::vector<uint8_t>>;
  struct CredentialReply final { std::promise<CredentialValue> result; };

  static void wipe_credential(CredentialValue &value) noexcept {
    if (!value) return;
    volatile uint8_t *data = value->data();
    for (std::size_t i = 0; i < value->size(); ++i) data[i] = 0;
    value.reset();
  }
  static bool settle_credential(const std::shared_ptr<Session> &session,
                                uint64_t id, CredentialValue value) {
    std::shared_ptr<CredentialReply> reply;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      const auto found = session->credentials.find(id);
      if (found == session->credentials.end()) { wipe_credential(value); return false; }
      reply = found->second;
      session->credentials.erase(found);
    }
    try { reply->result.set_value(std::move(value)); }
    catch (...) { wipe_credential(value); throw; }
    return true;
  }

  std::future<CredentialValue> credential(const std::shared_ptr<Session> &session,
                                         const CredentialChallenge &challenge) {
    auto reply = std::make_shared<CredentialReply>();
    auto result = reply->result.get_future();
    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (session->credentials.size() >= 64 ||
          !session->credentials.emplace(challenge.host_operation_id, reply).second)
        throw ContractFailure(CITIZENSDK_ERROR_CONFLICT, "Credential challenge admission failed");
    }
    std::weak_ptr<State> weak = shared_from_this();
    std::weak_ptr<Session> target = session;
    const auto expected = snapshot_epoch();
    try {
      schedule([weak, target, expected, challenge] {
        const auto state = weak.lock(); const auto session = target.lock();
        if (!session) return;
        if (!state || !state->current(session) || state->is_detached() ||
            session->closing || !state->sink || expected != state->snapshot_epoch()) {
          settle_credential(session, challenge.host_operation_id, std::nullopt);
          return;
        }
        try {
          state->emit(session, "credentialRequest", Value::list({
              Value::string(std::to_string(challenge.host_operation_id)),
              Value::string(challenge.key_purpose), Value::null()}), expected);
        } catch (...) { settle_credential(session, challenge.host_operation_id, std::nullopt); }
      });
      // deferred复用C++凭据适配器的既有等待线程，不为Flutter另开一个等待线程。
      return std::async(std::launch::deferred,
          [weak, target, challenge, result = std::move(result)]() mutable -> CredentialValue {
        for (;;) {
          if (challenge.cancelled.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready) {
            if (const auto session = target.lock())
              settle_credential(session, challenge.host_operation_id, std::nullopt);
            if (result.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready) {
              try { auto late = result.get(); wipe_credential(late); } catch (...) {}
            }
            if (const auto state = weak.lock()) {
              try {
                state->schedule([weak, target, id = challenge.host_operation_id] {
                  if (const auto state = weak.lock()) if (const auto session = target.lock())
                    state->emit(session, "credentialCancelled",
                        Value::list({Value::string(std::to_string(id))}), state->snapshot_epoch());
                });
              } catch (...) {}
            }
            return std::nullopt;
          }
          if (result.wait_for(std::chrono::milliseconds(20)) == std::future_status::ready)
            return result.get();
        }
      });
    } catch (...) {
      settle_credential(session, challenge.host_operation_id, std::nullopt);
      throw;
    }
  }

  void cancel_credentials(const std::shared_ptr<Session> &session) {
    std::vector<uint64_t> ids;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      for (const auto &entry : session->credentials) ids.push_back(entry.first);
    }
    for (const auto id : ids) {
      session->transport->cancel_credential(id);
      (void)settle_credential(session, id, std::nullopt);
    }
  }

  void open(DecodedRequest request, ReplyCallback reply) {
    std::shared_ptr<Session> session;
    std::optional<Reply> outcome;
    try {
      const auto module_code = citizensdk_validate_modules(request.modules);
      if (module_code != CITIZENSDK_OK)
        throw ContractFailure(module_code, "CitizenSDK module selection is invalid");
      auto source = environment(request.modules); // keeps upgraded parent alive through Host creation
      session = std::make_shared<Session>();
      session->id = random_session_id();
      source.config.modules = request.modules;
      if (request.has_credential_provider) {
        std::weak_ptr<State> weak = shared_from_this();
        std::weak_ptr<Session> target = session;
        source.config.credentialProvider = [weak, target](const CredentialChallenge &challenge) {
          const auto state = weak.lock(); const auto session = target.lock();
          if (!state || !session) {
            std::promise<CredentialValue> cancelled;
            cancelled.set_value(std::nullopt);
            return cancelled.get_future();
          }
          return state->credential(session, challenge);
        };
      }
      session->transport = factory(source.config);
      if (!session->transport) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                                                     "CitizenSDK native Host is unavailable");
      std::weak_ptr<State> weak = shared_from_this();
      std::weak_ptr<Session> target = session;
      session->transport->observe_resources([weak, target](std::string type, Value payload) {
        if (const auto state = weak.lock()) {
          const auto expected = state->snapshot_epoch();
          state->schedule([weak, target, expected, type = std::move(type), payload = std::move(payload)]() mutable {
            if (const auto state = weak.lock()) if (const auto session = target.lock()) {
              if (!state->current(session)) return;
              if (!type.empty()) state->emit(session, type, std::move(payload), expected);
              state->drain(session);
            }
          });
        }
      });
      const auto initial_state = session->transport->lifecycle_state();
      // open 的固定合同是 created / eventSequence 1；其它合法生命周期也
      // 不能冒充新 session，否则 Dart 会拒绝响应并失去该原生实例的身份。
      if (initial_state != CITIZENSDK_LIFECYCLE_CREATED)
        throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                              "CitizenSDK open requires a newly created native instance");
      if (!sessions.emplace(session->id, session).second)
        throw ContractFailure(CITIZENSDK_ERROR_CONFLICT, "CitizenSDK session identity collision");
      request.session = session->id;
      const auto state = lifecycle(initial_state);
      outcome = success(request, Value::list({state, Value::integer(1),Value::string(std::to_string(session->transport->ffi_handle()))}));
    } catch (const ContractFailure &error) {
      if (session && session->transport) { sessions.erase(session->id); session->transport->retire(); }
      outcome = failure(error.code, error.what(), request, error.stage);
    } catch (const Error &error) {
      if (session && session->transport) { sessions.erase(session->id); session->transport->retire(); }
      outcome = failure(error.code(), error.what(), request, error.stage());
    } catch (...) {
      if (session && session->transport) { sessions.erase(session->id); session->transport->retire(); }
      outcome = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK open failed", request);
    }
    // User/messenger code is outside native resource rollback. Once a session
    // was inserted, a throwing test callback must not make us reply twice.
    reply(std::move(*outcome));
    // Match the other official bindings: publish the open response before the
    // first session events, so Dart learns the random session ID first. A
    // reentrant close removes the session and makes snapshots a no-op.

  }

  void submit(const std::shared_ptr<Session> &session,const std::shared_ptr<Route> &route){
    route->accepting=true;const std::weak_ptr<State> weak=shared_from_this();const std::weak_ptr<Session> target=session;
    const auto code=session->transport->stop([weak,target,route](uint64_t id,std::function<Value()> project){if(const auto state=weak.lock())if(const auto session=target.lock()){std::lock_guard<std::mutex> guard(session->lock);route->native_id=id;route->projection=std::move(project);route->completed=true;state->post_drain(session);}},&route->native_id);
    route->accepting=false;if(code){route->completed=true;route->ready=failure(code,"Core stop rejected",route->request);}drain(session);
  }

  void resource_operation(const std::shared_ptr<Session> &session, const std::shared_ptr<Route> &route) {
    { std::lock_guard<std::mutex> guard(session->lock); route->accepting = true; }
    const std::weak_ptr<State> weak = shared_from_this();
    const std::weak_ptr<Session> target = session;
    try {
      auto completion = [weak, target, route](std::function<Value()> project) {
            const auto state = weak.lock(); const auto session = target.lock();
            if (!state || !session) return;
            {
              std::lock_guard<std::mutex> guard(session->lock);
              if (route->terminal_seen) return;
              // 这里只结束该资源控制调用；长期Core/相机/纹理所有权分别保有至真实排空。
              route->projection = std::move(project);
              route->terminal_seen = true; route->completed = true;
            }
            state->post_drain(session);
          };
      const auto method = route->request.method;
      if (method == Method::open_private_key || method == Method::reveal_private_key || method == Method::close_private_key)
        session->transport->private_key(route->request, std::move(completion));
      else session->transport->capture(route->request, std::move(completion));
    } catch (...) {
      { std::lock_guard<std::mutex> guard(session->lock); route->accepting = false; }
      throw;
    }
    { std::lock_guard<std::mutex> guard(session->lock); route->accepting = false; }
    drain(session);
  }

  void retire_detached_session_if_idle(const std::shared_ptr<Session> &session) {
    if (!is_detached() || !current(session)) return;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (!session->routes.empty()) return;
    }
    if (!session->transport->private_keys_closed() || !session->transport->captures_closed()) return;
    session->transport->retire();
    session->retired = true;
    sessions.erase(session->id);
    release_detached_state_if_empty();
  }

  void drain(const std::shared_ptr<Session> &session){
    if(!current(session))return;
    for(;;){std::shared_ptr<Route> route;{std::lock_guard<std::mutex> guard(session->lock);for(auto it=session->routes.begin();it!=session->routes.end();++it)if(it->second->completed&&!it->second->accepting){route=it->second;session->routes.erase(it);break;}}
      if(!route)break;
      if(route->projection&&!is_detached()){auto project=std::move(route->projection);try{route->ready=success(route->request,project());}catch(const Error &e){route->ready=failure(e.code(),e.what(),route->request,e.stage());}catch(const ContractFailure&e){route->ready=failure(e.code,e.what(),route->request,e.stage);}catch(...){route->ready=failure(CITIZENSDK_ERROR_INTERNAL,"Platform resource failed",route->request);}}else route->projection={};
      auto result=route->ready?std::move(*route->ready):failure(CITIZENSDK_ERROR_INTERNAL,"Platform resource failed",route->request);
      if(route->close_stop){if(!result.success)close_failed(session,result.error_code,result.message);}else if(!is_detached()&&route->reply){auto reply=std::move(route->reply);reply(std::move(result));}
    }
    if(is_detached()){retire_detached_session_if_idle(session);return;}if(session->closing)progress_close(session);
  }

  void close_failed(const std::shared_ptr<Session> &session,
                    citizensdk_error_code_t code, const std::string &message) {
    if (!session->close_request) return;
    auto request = std::move(*session->close_request);
    auto reply = std::move(session->close_reply);
    session->close_request.reset();
    session->closing = false;
    if (!is_detached() && reply) reply(failure(code, message, request));
  }

  void progress_close(const std::shared_ptr<Session> &session) {
    if (!current(session) || !session->closing || !session->close_request) return;
    try { cancel_credentials(session); session->transport->close_private_keys(); session->transport->close_captures(); }
    catch (const Error &error) { close_failed(session, error.code(), error.what()); return; }
    catch (const ContractFailure &error) { close_failed(session, error.code, error.what()); return; }
    catch (...) { close_failed(session, CITIZENSDK_ERROR_INTERNAL, "Credential cancellation failed"); return; }

    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (!session->routes.empty()) return;
    }
    if (!session->transport->private_keys_closed() || !session->transport->captures_closed()) return;
    try {
      const auto state = session->transport->lifecycle_state();
      if (state == CITIZENSDK_LIFECYCLE_RUNNING || state == CITIZENSDK_LIFECYCLE_STARTING ||
          state == CITIZENSDK_LIFECYCLE_IMPORTING_STATE) {
        auto route = std::make_shared<Route>();
        route->request = *session->close_request;
        route->close_stop = true;
        {
          std::lock_guard<std::mutex> guard(session->lock);
          session->routes.emplace(route->request.sequence, route);
        }
        submit(session, route);
        return;
      }
      // Host::close rejects still-live result/callback frames as BUSY. This is
      // retryable and retains all ownership; never report disposed beforehand.
      session->transport->close();
      session->retired = true;
      sessions.erase(session->id);
      auto request = std::move(*session->close_request);
      auto reply = std::move(session->close_reply);
      session->close_request.reset();
      if (!is_detached() && reply) reply(success(request, Value::list({Value::string("disposed")})));
    } catch (const ContractFailure &error) { close_failed(session, error.code, error.what()); }
    catch (const Error &error) { close_failed(session, error.code(), error.what()); }
    catch (...) { close_failed(session, CITIZENSDK_ERROR_INTERNAL, "CitizenSDK close failed"); }
  }

  void cancel_requests(const std::shared_ptr<Session> &session) {
    std::vector<citizensdk_request_id_t> ids;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      for (const auto &entry : session->routes)
        if (!entry.second->terminal_seen && entry.second->native_id != 0)
          ids.push_back(entry.second->native_id);
    }
    // 快照后锁外请求取消，真实completion仍保有对应路由和所有权。
    for (const auto id : ids) (void)session->transport->cancel(id);
  }

  void begin_close(const std::shared_ptr<Session> &session,
                   const DecodedRequest &request, ReplyCallback reply) {
    try { cancel_credentials(session); }
    catch (const Error &error) { reply(failure(error.code(), error.what(), request, error.stage())); return; }
    catch (const ContractFailure &error) { reply(failure(error.code, error.what(), request, error.stage)); return; }
    catch (...) { reply(failure(CITIZENSDK_ERROR_INTERNAL, "Credential cancellation failed", request)); return; }

    session->closing = true;
    session->close_request = request;
    session->close_reply = std::move(reply);
    std::exception_ptr first;
    try { cancel_requests(session); } catch (...) { if (!first) first = std::current_exception(); }
    if (first) {
      try { std::rethrow_exception(first); }
      catch (const Error &error) { close_failed(session, error.code(), error.what()); }
      catch (...) { close_failed(session, CITIZENSDK_ERROR_INTERNAL, "CitizenSDK cancellation failed"); }
      return;
    }
    drain(session);
  }

  void accept_request_sequence(const RequestEnvelope &request) {
    require_owner();
    if (is_detached()) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter engine is detached",
                                            request.session, request.sequence);
    const auto found = sessions.find(request.session);
    if (found == sessions.end()) throw ContractFailure(CITIZENSDK_ERROR_NOT_FOUND, "CitizenSDK session was not found",
                                                       request.session, request.sequence);
    const auto session = found->second;
    if (session->closing) throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK session is closing",
                                                request.session, request.sequence);
    const auto code = session->transport->accept_request_sequence(static_cast<uint64_t>(request.sequence));
    if (code != CITIZENSDK_OK) throw ContractFailure(code, "CitizenSDK request sequence admission failed",
                                                    request.session, request.sequence);
  }

  void dispatch(DecodedRequest request,ReplyCallback reply){
    require_owner();if(!reply)throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT,"Reply required");if(is_detached()){reply(failure(CITIZENSDK_ERROR_UNAVAILABLE,"Engine detached",request));return;}
    if(request.method==Method::open){open(std::move(request),std::move(reply));return;}
    const auto found=sessions.find(request.session);if(found==sessions.end()){reply(failure(CITIZENSDK_ERROR_NOT_FOUND,"Session missing",request));return;}const auto session=found->second;
    if(request.method==Method::close){begin_close(session,request,std::move(reply));return;}
    if(session->closing){reply(failure(CITIZENSDK_ERROR_INVALID_STATE,"Session closing",request));return;}
    if(request.method==Method::diagnose){session->diagnostics.push_back(std::move(request.diagnostic));if(session->diagnostics.size()>128)session->diagnostics.erase(session->diagnostics.begin());reply(success(request,Value::list({})));return;}
    if(request.method==Method::read_diagnostics){reply(success(request,Value::list({Value::list(session->diagnostics)})));return;}
    if(request.method==Method::respond_credential||request.method==Method::cancel_credential){const bool ok=settle_credential(session,request.host_operation_id,request.credential?CredentialValue(request.credential->value):std::nullopt);reply(ok?success(request,Value::list({})):failure(CITIZENSDK_ERROR_NOT_FOUND,"Credential missing",request));return;}
    if (request.method == Method::cancel_operation) {
      std::optional<Reply> result;
      try {
        uint64_t sequence = 0;
        const auto &id = request.resource_id;
        const auto parsed = std::from_chars(id.data(), id.data() + id.size(), sequence);
        if (id.empty() || id.front() == '0' || parsed.ec != std::errc{} ||
            parsed.ptr != id.data() + id.size() || sequence == 0)
          throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Operation identity is invalid");
        citizensdk_request_id_t native = 0;
        {
          std::lock_guard<std::mutex> guard(session->lock);
          if (sequence <= static_cast<uint64_t>(INT64_MAX)) {
            const auto found = session->routes.find(static_cast<int64_t>(sequence));
            if (found != session->routes.end() && !found->second->terminal_seen)
              native = found->second->native_id;
          }
        }
        const bool accepted = native != 0 && session->transport->cancel(native);
        result = success(request, Value::list({Value::boolean(accepted)}));
      } catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "Operation cancellation failed", request); }
      reply(std::move(*result)); return;
    }
    auto route=std::make_shared<Route>();route->request=std::move(request);route->reply=std::move(reply);{std::lock_guard<std::mutex>guard(session->lock);if(session->routes.size()>=64)throw ContractFailure(CITIZENSDK_ERROR_QUEUE_FULL,"UI requests full");session->routes.emplace(route->request.sequence,route);}
    try{resource_operation(session,route);}catch(const Error&e){route->completed=true;route->ready=failure(e.code(),e.what(),route->request,e.stage());drain(session);}catch(const ContractFailure&e){route->completed=true;route->ready=failure(e.code,e.what(),route->request,e.stage);drain(session);}catch(...){route->completed=true;route->ready=failure(CITIZENSDK_ERROR_INTERNAL,"Platform request failed",route->request);drain(session);}
  }

  void listen(EventSink value) {
    require_owner();
    if (is_detached()) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter engine is detached");
    if (!value) throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK event sink is required");
    if (sink) throw ContractFailure(CITIZENSDK_ERROR_BUSY, "CitizenSDK event subscription is already active");
    advance_epoch(); sink = std::move(value);

  }
  void cancel_events() {
    require_owner();
    if (is_detached()) { sink = {}; return; }
    advance_epoch(); sink = {};
    // 失去唯一凭据回包通道后撤销本实例实际挑战，不能无限保留一个不可见等待。
    for (const auto &entry : sessions) cancel_credentials(entry.second);
  }

  void detach() noexcept {
    // This method is called synchronously by plugin dispose on its owner
    // thread, before messenger handles are retired. Host callbacks never wait
    // for this UI thread, so Host's callback barrier cannot deadlock it.
    if (is_detached()) return;
    try { advance_epoch(true); } catch (...) {}
    sink = {};
    if (!sessions.empty()) retain_detached_state();
    for (auto found = sessions.begin(); found != sessions.end();) {
      const auto session = (found++)->second;
      session->closing = true;
      (void)citizensdk_detach(session->transport->ffi_handle());
      session->close_reply = {};
      try { cancel_credentials(session); } catch (...) {}
      try { session->transport->close_private_keys(); } catch (...) {}
      try { session->transport->close_captures(); } catch (...) {}
      try { cancel_requests(session); } catch (...) {}
      {
        std::lock_guard<std::mutex> guard(session->lock);
        for (auto &route_pair : session->routes) route_pair.second->reply = {};
      }
      try { drain(session); } catch (...) {}
    }
    release_detached_state_if_empty();
  }
};

Sessions::Sessions(std::shared_ptr<State> state) : state_(std::move(state)) {}
std::shared_ptr<Sessions> Sessions::create(EnvironmentFactory environment,
                                          Scheduler scheduler, TransportFactory factory, TextureFactory textures) {
  if (!environment || !scheduler)
    throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK environment and scheduler are required");
  if (!factory) factory = [scheduler, textures = std::move(textures)](const Config &config) {
    return std::make_shared<HostTransport>(config, scheduler, textures);
  };
  return std::shared_ptr<Sessions>(new Sessions(
      std::make_shared<State>(std::move(environment), std::move(scheduler), std::move(factory))));
}
Sessions::~Sessions() { state_->detach(); }
void Sessions::accept_request_sequence(const RequestEnvelope &request) { state_->accept_request_sequence(request); }
void Sessions::dispatch(DecodedRequest request, ReplyCallback reply) { state_->dispatch(std::move(request), std::move(reply)); }
void Sessions::listen(EventSink sink) { state_->listen(std::move(sink)); }
void Sessions::cancel_events() { state_->cancel_events(); }
void Sessions::detach() noexcept { state_->detach(); }
std::size_t Sessions::session_count() const { state_->require_owner(); return state_->sessions.size(); }

}  // namespace citizen_sdk::flutter
