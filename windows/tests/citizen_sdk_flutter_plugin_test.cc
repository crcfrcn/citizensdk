#include <flutter/binary_messenger.h>
#include <flutter/method_call.h>
#include <flutter/method_result.h>
#include <flutter/plugin_registrar.h>
#include <flutter/standard_method_codec.h>
#include <flutter/texture_registrar.h>
#include <windows.h>

#include <cassert>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "citizen_sdk_flutter_test_support.hpp"

namespace citizen_sdk::flutter {
// 私有符号直接连接正式生产实现，不把测试注入入口放进安装头或 DLL 导出。
std::unique_ptr<::flutter::Plugin> register_plugin(::flutter::BinaryMessenger *, HWND,
    EnvironmentFactory, TransportFactory, ::flutter::TextureRegistrar * = nullptr);
TextureRegistration create_texture_registration(::flutter::TextureRegistrar *);
std::size_t plugin_pending_reply_count(const ::flutter::Plugin &);
std::size_t plugin_dispatcher_count() noexcept;
}  // namespace citizen_sdk::flutter

namespace csf = citizen_sdk::flutter;
namespace {
const auto &codec() { return ::flutter::StandardMethodCodec::GetInstance(); }


class TextureRegistrarFixture final : public ::flutter::TextureRegistrar {
 public:
  ::flutter::TextureVariant *texture{};
  std::function<void()> unregister;
  bool reject_register{}, reject_frame{};
  int registrations{}, frames{}, unregistrations{};
  int64_t RegisterTexture(::flutter::TextureVariant *value) override {
    if (reject_register) return -1;
    assert(!texture); texture = value; ++registrations; return 11;
  }
  bool MarkTextureFrameAvailable(int64_t id) override {
    assert(id == 11 && texture); ++frames; return !reject_frame;
  }
  void UnregisterTexture(int64_t id, std::function<void()> done) override {
    assert(id == 11 && texture && !unregister); ++unregistrations; unregister = std::move(done);
  }
  bool UnregisterTexture(int64_t) override { assert(false); return false; }
  const FlutterDesktopPixelBuffer *copy() {
    return std::get<::flutter::PixelBufferTexture>(*texture).CopyPixelBuffer(2, 2);
  }
  void finish_unregister() {
    texture = nullptr; auto done = std::move(unregister); done();
  }
};
void texture_contract() {
  TextureRegistrarFixture registrar;
  auto registration = csf::create_texture_registration(&registrar);
  for (const uint32_t width : {0U, 4097U}) {
    bool invalid = false;
    try { (void)registration.open(width, 2); } catch (const csf::ContractFailure &) { invalid = true; }
    assert(invalid);
  }
  registrar.reject_register = true;
  bool refused = false;
  try { (void)registration.open(2, 2); } catch (const csf::ContractFailure &) { refused = true; }
  assert(refused && !registrar.texture);
  registrar.reject_register = false;
  auto texture = registration.open(2, 2);
  assert(!registrar.copy()); // 无首帧时不伪造设备像素。
  texture->update(std::make_shared<const std::vector<uint8_t>>(16, 3));
  const auto *first = registrar.copy();
  assert(first && first->width == 2 && first->height == 2 && first->buffer[0] == 3);
  texture->update(std::make_shared<const std::vector<uint8_t>>(16, 9));
  const auto *second = registrar.copy(), *third = registrar.copy();
  assert(second && third && !registrar.copy() && first->buffer[0] == 3 && second->buffer[0] == 9);
  bool wrong_size = false;
  try { texture->update(std::make_shared<const std::vector<uint8_t>>(15)); }
  catch (const csf::ContractFailure &) { wrong_size = true; }
  assert(wrong_size);
  registrar.reject_frame = true;
  bool frame_failed = false;
  try { texture->update(std::make_shared<const std::vector<uint8_t>>(16)); }
  catch (const csf::ContractFailure &) { frame_failed = true; }
  assert(frame_failed);
  int drained = 0;
  texture->close([&] { ++drained; });
  assert(drained == 0 && registrar.unregistrations == 1);
  first->release_callback(first->release_context);
  registrar.finish_unregister();
  assert(drained == 0 && second->buffer[0] == 9);
  second->release_callback(second->release_context);
  assert(drained == 0);
  third->release_callback(third->release_context);
  assert(drained == 1);
  registration.detach();
  bool late = false;
  try { (void)registration.open(2, 2); } catch (const csf::ContractFailure &) { late = true; }
  assert(late && registrar.registrations == 1);

  // detach必须在registrar仍活着时发起异步注销；迟到资源不再使用该注册器。
  TextureRegistrarFixture second_registrar;
  auto other = csf::create_texture_registration(&second_registrar);
  auto active = other.open(1, 1);
  active->update(std::make_shared<const std::vector<uint8_t>>(4));
  other.detach();
  assert(second_registrar.unregistrations == 1);
  int detached = 0; active->close([&] { ++detached; });
  assert(detached == 0);
  second_registrar.finish_unregister(); assert(detached == 1);
}

class Response final : public ::flutter::MethodResult<::flutter::EncodableValue> {
 public:
  int wire_calls{};
  int results{};
  bool success{};
  std::string code;
  ::flutter::EncodableValue value;
 protected:
  void SuccessInternal(const ::flutter::EncodableValue *result) override {
    ++results; success = true;
    value = result == nullptr ? ::flutter::EncodableValue{} : *result;
  }
  void ErrorInternal(const std::string &error_code, const std::string &,
                     const ::flutter::EncodableValue *details) override {
    ++results; success = false; code = error_code;
    value = details == nullptr ? ::flutter::EncodableValue{} : *details;
  }
  void NotImplementedInternal() override { ++results; code = "notImplemented"; }
};

class Messenger final : public ::flutter::BinaryMessenger {
 public:
  void Send(const std::string &channel, const uint8_t *message, std::size_t size,
            ::flutter::BinaryReply = nullptr) const override {
    assert(std::this_thread::get_id() == owner);
    assert(channel == csf::kEventChannel && message != nullptr && size != 0);
    Response response;
    assert(codec().DecodeAndProcessResponseEnvelope(message, size, &response));
    assert(response.success && response.results == 1);
    events.push_back(response.value);
  }
  void SetMessageHandler(const std::string &channel,
                         ::flutter::BinaryMessageHandler handler) override {
    assert(std::this_thread::get_id() == owner);
    assert(!destroying);
    // 先取得旧 handler，销毁栈内禁止插件答复或修改其它 channel。
    ::flutter::BinaryMessageHandler old;
    const auto found = handlers.find(channel);
    if (found != handlers.end()) { old.swap(found->second); handlers.erase(found); }
    if (handler) handlers.emplace(channel, std::move(handler));
    destroying = true;
    old = {};
    destroying = false;
  }
  std::shared_ptr<Response> call(const std::string &channel, const std::string &method,
                                 const csf::Value &arguments) {
    const auto message = codec().EncodeMethodCall(::flutter::MethodCall<::flutter::EncodableValue>(
        method, std::make_unique<::flutter::EncodableValue>(csf::to_encodable_value(arguments))));
    return raw(channel, *message);
  }
  std::shared_ptr<Response> raw(const std::string &channel, const std::vector<uint8_t> &message) {
    const auto found = handlers.find(channel);
    assert(found != handlers.end());
    auto result = std::make_shared<Response>();
    auto handler = found->second;
    handler(message.data(), message.size(), [this, result](const uint8_t *bytes, std::size_t size) {
      assert(std::this_thread::get_id() == owner && !destroying);
      ++result->wire_calls;
      assert(bytes != nullptr && size != 0);
      assert(codec().DecodeAndProcessResponseEnvelope(bytes, size, result.get()));
    });
    return result;
  }
  ~Messenger() override { assert(handlers.empty()); }
  std::thread::id owner = std::this_thread::get_id();
  bool destroying{};
  std::map<std::string, ::flutter::BinaryMessageHandler> handlers;
  mutable std::vector<::flutter::EncodableValue> events;
};

void pump() {
  MSG message{};
  for (std::size_t budget = 0; budget < 4096; ++budget) {
    if (!PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) return;
    assert(message.message != WM_QUIT);
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  assert(false && "CitizenSDK UI queue did not drain");
}

csf::Value request(const std::string &session, int64_t sequence) {
  return csf::test::list({csf::Value::integer(1), csf::Value::string(session),
                         csf::Value::integer(sequence)});
}
std::string session_of(const Response &response) {
  assert(response.success && response.wire_calls == 1 && response.results == 1);
  const auto value = csf::from_encodable_value(response.value);
  return csf::test::text(csf::test::items(value).at(1));
}
std::unique_ptr<::flutter::Plugin> attach(Messenger &messenger,
                                         const std::shared_ptr<csf::test::FakeTransport> &native) {
  return csf::register_plugin(&messenger, nullptr, [](uint32_t) { return csf::OpenEnvironment{}; },
      [native](const citizen_sdk::Config &) { return native; });
}
void exactly(const std::shared_ptr<Response> &response, bool success, const char *code = "") {
  assert(response->wire_calls == 1 && response->results == 1 && response->success == success);
  assert(response->code == code);
}
}  // namespace

int main() {
  texture_contract();
  const auto initial_dispatchers = csf::plugin_dispatcher_count();
  {
    Messenger messenger;
    int environments = 0;
    int transports = 0;
    auto plugin = csf::register_plugin(&messenger, nullptr,
        [&](uint32_t) { ++environments; return csf::OpenEnvironment{}; },
        [&](const citizen_sdk::Config &) {
          ++transports; return std::make_shared<csf::test::FakeTransport>();
        });
    csf::Value::Bytes signature(64);
    signature.back() = 0x80;
    const auto verified = messenger.call(csf::kMethodChannel, "verifySignature",
        csf::test::list({csf::Value::integer(1), csf::Value::string("0x2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972"),
                        csf::Value::bytes(signature), csf::Value::bytes({})}));
    exactly(verified, true);
    const auto result = csf::from_encodable_value(verified->value);
    assert(csf::test::items(result).size() == 2 &&
           !std::get<bool>(csf::test::items(result)[1].data));
    signature.pop_back();
    const auto rejected = messenger.call(csf::kMethodChannel, "verifySignature",
        csf::test::list({csf::Value::integer(1), csf::Value::string("0x2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972"),
                        csf::Value::bytes(signature), csf::Value::bytes({})}));
    exactly(rejected, false, "citizensdk.invalidArgument");
    const auto error = csf::from_encodable_value(rejected->value);
    assert(std::holds_alternative<std::monostate>(csf::test::items(error)[1].data));
    assert(std::holds_alternative<std::monostate>(csf::test::items(error)[2].data));
    // 未 open 或 listen；验证路径不得创建环境/Host，亦不得发布会话事件。
    assert(environments == 0 && transports == 0 && messenger.events.empty());
    assert(csf::plugin_pending_reply_count(*plugin) == 0);
    plugin.reset();
    pump();
  }
  assert(csf::plugin_dispatcher_count() == initial_dispatchers);
  const auto subscription = csf::test::list({csf::Value::integer(1)});
  const auto open_request = csf::test::list({csf::Value::integer(1), csf::Value::integer(63)});
  {
    Messenger messenger;
    auto native = std::make_shared<csf::test::FakeTransport>();
    auto plugin = attach(messenger, native);
    assert(messenger.handlers.size() == 2);
    const auto opened = messenger.call(csf::kMethodChannel, "open", open_request);
    const auto session = session_of(*opened);
    assert(csf::plugin_pending_reply_count(*plugin) == 0);
    exactly(messenger.call(csf::kEventChannel, "listen", subscription), true);
    assert(messenger.events.size() == 2);  // 已有 session 的同步快照也不能被丢弃。
    exactly(messenger.call(csf::kEventChannel, "listen", subscription), false, "citizensdk.busy");
    exactly(messenger.call(csf::kEventChannel, "cancel", subscription), true);
    const auto after_cancel = messenger.events.size();
    citizensdk_event_t event{};
    event.struct_size = sizeof(event);
    event.abi_version = CITIZENSDK_ABI_VERSION;
    event.event_type = CITIZENSDK_EVENT_LIFECYCLE_CHANGED;
    native->observer(event);
    exactly(messenger.call(csf::kEventChannel, "listen", subscription), true);
    pump();
    assert(messenger.events.size() == after_cancel + 2);
    exactly(messenger.call(csf::kMethodChannel, "unknown", subscription), false, "citizensdk.unsupported");
    exactly(messenger.call(csf::kMethodChannel, "open", csf::Value::null()), false,
            "citizensdk.invalidArgument");
    // 两个生产 channel 均在官方解码器分配/递归前检查原始标准 wire。
    for (const auto *channel : {csf::kMethodChannel, csf::kEventChannel}) {
      exactly(messenger.raw(channel, {}), false, "citizensdk.invalidArgument");
      auto bytes = codec().EncodeMethodCall(::flutter::MethodCall<::flutter::EncodableValue>(
          channel == csf::kMethodChannel ? "open" : "listen",
          std::make_unique<::flutter::EncodableValue>(csf::to_encodable_value(subscription))));
      bytes->push_back(0);
      exactly(messenger.raw(channel, *bytes), false, "citizensdk.invalidArgument");
      bytes->resize(bytes->size() - 2);
      exactly(messenger.raw(channel, *bytes), false, "citizensdk.invalidArgument");
    }

    // 真正后台 observer 经生产 HWND 队列回到 UI；早完成与完成后 pending 清理共用该路径。
    native->defer_profile = true;
    const auto profile = messenger.call(csf::kMethodChannel, "getWalletProfile", request(session, 1));
    assert(profile->wire_calls == 0 && csf::plugin_pending_reply_count(*plugin) == 1);
    std::thread worker([&] { native->complete_deferred(); });
    worker.join();
    assert(profile->wire_calls == 0);
    pump();
    exactly(profile, true);
    assert(csf::plugin_pending_reply_count(*plugin) == 0);
    native->busy_closes = 1;
    exactly(messenger.call(csf::kMethodChannel, "close", request(session, 2)), false, "citizensdk.busy");
    exactly(messenger.call(csf::kMethodChannel, "close", request(session, 3)), true);
    assert(native->closed == 1);
    plugin.reset();
    pump();
    assert(messenger.handlers.empty());
  }
  assert(csf::plugin_dispatcher_count() == initial_dispatchers);

  {
    Messenger messenger;
    auto native = std::make_shared<csf::test::FakeTransport>();
    native->defer_prepared = true;
    native->complete_on_cancel = false;
    auto plugin = attach(messenger, native);
    const auto session = session_of(*messenger.call(csf::kMethodChannel, "open", open_request));
    const auto pending = messenger.call(csf::kMethodChannel, "prepareWalletCreation",
        csf::test::list({csf::Value::integer(2), csf::Value::string(session),
                         csf::Value::integer(1), csf::Value::integer(12), csf::Value::string("")}));
    assert(native->accepted.size() == 1 && native->accepted[0] == csf::Method::prepare_wallet_creation && pending->wire_calls == 0);
    // 替换事件端同样撤销整个旧实例；取消是请求，原生真实终态仍由旧队列收口。
    messenger.SetMessageHandler(csf::kEventChannel,
        [](const uint8_t *, std::size_t, ::flutter::BinaryReply reply) {
          const auto response = codec().EncodeSuccessEnvelope();
          reply(response->data(), response->size());
        });
    assert(native->cancelled == 1 && pending->wire_calls == 0);
    pump();
    exactly(pending, false, "citizensdk.invalidState");
    assert(native->retired == 0 && messenger.handlers.count(csf::kMethodChannel) == 0);
    assert(messenger.handlers.count(csf::kEventChannel) == 1);
    std::thread worker([native] { native->complete_deferred(); });
    worker.join();
    pump();
    exactly(pending, false, "citizensdk.invalidState");
    assert(native->retired == 1);
    plugin.reset();
    assert(messenger.handlers.count(csf::kEventChannel) == 1);
    messenger.SetMessageHandler(csf::kEventChannel, nullptr);
    pump();
  }
  assert(csf::plugin_dispatcher_count() == initial_dispatchers);

  {
    Messenger messenger;
    auto native = std::make_shared<csf::test::FakeTransport>();
    native->defer_profile = true;
    auto plugin = attach(messenger, native);
    const auto session = session_of(*messenger.call(csf::kMethodChannel, "open", open_request));
    const auto pending = messenger.call(csf::kMethodChannel, "getWalletProfile", request(session, 1));
    int replacement_calls = 0;
    messenger.SetMessageHandler(csf::kMethodChannel,
        [&](const uint8_t *, std::size_t, ::flutter::BinaryReply reply) {
          ++replacement_calls;
          const auto response = codec().EncodeSuccessEnvelope();
          reply(response->data(), response->size());
        });
    assert(pending->wire_calls == 0);  // handler 销毁栈中没有回答。
    pump();
    exactly(pending, false, "citizensdk.invalidState");
    assert(csf::plugin_pending_reply_count(*plugin) == 0);
    assert(messenger.handlers.count(csf::kMethodChannel) == 1);
    assert(messenger.handlers.count(csf::kEventChannel) == 0);
    exactly(messenger.call(csf::kMethodChannel, "replacement", subscription), true);
    assert(replacement_calls == 1 && native->retired == 0);
    // 迟到原生完成只退役旧资源，不二次回应，不删除新注册者。
    native->complete_deferred();
    pump();
    exactly(pending, false, "citizensdk.invalidState");
    assert(native->retired == 1);
    plugin.reset();
    assert(messenger.handlers.count(csf::kMethodChannel) == 1);
    messenger.SetMessageHandler(csf::kMethodChannel, nullptr);
    pump();
  }
  assert(csf::plugin_dispatcher_count() == initial_dispatchers);

  {
    Messenger messenger;
    auto first_native = std::make_shared<csf::test::FakeTransport>();
    auto first = attach(messenger, first_native);
    (void)session_of(*messenger.call(csf::kMethodChannel, "open", open_request));
    auto second_native = std::make_shared<csf::test::FakeTransport>();
    auto second = attach(messenger, second_native);
    pump();
    assert(messenger.handlers.size() == 2 && first_native->retired == 1);
    (void)session_of(*messenger.call(csf::kMethodChannel, "open", open_request));
    first.reset();
    assert(messenger.handlers.size() == 2);
    second.reset();
    pump();
  }
  assert(csf::plugin_dispatcher_count() == initial_dispatchers);

  {
    Messenger messenger;
    auto plugin = csf::register_plugin(&messenger, nullptr,
        [](uint32_t) -> csf::OpenEnvironment {
          throw csf::ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "injected native environment failure");
        }, {});
    exactly(messenger.call(csf::kMethodChannel, "open", open_request), false, "citizensdk.unavailable");
    assert(csf::plugin_pending_reply_count(*plugin) == 0);
    plugin.reset();
    pump();
  }
  assert(csf::plugin_dispatcher_count() == initial_dispatchers);
  return 0;
}
