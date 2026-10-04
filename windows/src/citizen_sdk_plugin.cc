#include "citizen_sdk/citizen_sdk_plugin.h"

#include <flutter/binary_messenger.h>
#include <flutter/plugin_registrar_windows.h>
#include <flutter/standard_method_codec.h>
#include <flutter/texture_registrar.h>

#include <algorithm>
#include <atomic>
#include <exception>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "citizen_sdk_flutter_codec.hpp"
#include "citizen_sdk_flutter_environment.hpp"
#include "citizen_sdk_flutter_sessions.hpp"

namespace citizen_sdk::flutter {
namespace {

const auto &codec() { return ::flutter::StandardMethodCodec::GetInstance(); }
using Bytes = std::vector<uint8_t>;
constexpr UINT kInvoke = WM_APP + 1;
constexpr UINT kRetire = WM_APP + 2;
std::atomic<std::size_t> live_dispatchers{0};

// 独立 UI 调度器只保存公开值/完成函数，不访问 Host 私有窗口或秘密。
// 窗口自持 State；最后一个 scheduler 在任何线程释放时只投递退休消息。
class UiQueue final {
  struct State final : std::enable_shared_from_this<State> {
    std::mutex lock;
    std::map<UINT_PTR, std::function<void()>> pending;
    UINT_PTR next{1};
    HWND window{};
    HINSTANCE module{};
    std::wstring class_name;
    std::size_t dispatching{};
    bool retiring{};
    bool registered{};
    bool counted{};

    static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wp,
                                         LPARAM lp) noexcept {
      auto *anchor = reinterpret_cast<std::shared_ptr<State> *>(
          GetWindowLongPtrW(hwnd, GWLP_USERDATA));
      if (message == WM_NCCREATE) {
        try {
          const auto *create = reinterpret_cast<const CREATESTRUCTW *>(lp);
          auto *value = static_cast<State *>(create->lpCreateParams);
          anchor = new std::shared_ptr<State>(value->shared_from_this());
          SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(anchor));
          value->counted = true;
          ++live_dispatchers;
        } catch (...) { return FALSE; }
      }
      const auto state = anchor == nullptr ? std::shared_ptr<State>{} : *anchor;
      if (state && message == kInvoke) {
        std::function<void()> action;
        {
          std::lock_guard<std::mutex> guard(state->lock);
          const auto found = state->pending.find(static_cast<UINT_PTR>(wp));
          if (found == state->pending.end()) return 0;
          action.swap(found->second);
          state->pending.erase(found);
          ++state->dispatching;
        }
        try { action(); } catch (...) { /* 不记录任务参数或异常内容。 */ }
        // 函数捕获对象也必须在 UI 上释放，再检查最后一个 scheduler 的退休请求。
        action = {};
        {
          std::lock_guard<std::mutex> guard(state->lock);
          --state->dispatching;
          if (state->retiring && state->pending.empty() && state->dispatching == 0) {
            (void)PostMessageW(hwnd, kRetire, 0, 0);
          }
        }
        return 0;
      }
      if (state && message == kRetire) {
        {
          std::lock_guard<std::mutex> guard(state->lock);
          if (!state->retiring || !state->pending.empty() || state->dispatching != 0) return 0;
        }
        MSG obsolete{};
        while (PeekMessageW(&obsolete, hwnd, kInvoke, kRetire, PM_REMOVE)) {}
        if (DestroyWindow(hwnd) && state->registered) {
          if (UnregisterClassW(state->class_name.c_str(), state->module)) state->registered = false;
        }
        return 0;
      }
      if (state && message == WM_CLOSE) return 0;
      if (state && message == WM_NCDESTROY) {
        {
          std::lock_guard<std::mutex> guard(state->lock);
          // 未经排空就强行销毁 dispatcher 不是一次合法关闭，不能丢弃已接纳完成。
          if (!state->pending.empty() || state->dispatching != 0) std::terminate();
          state->window = nullptr;
        }
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        delete anchor;
        if (state->counted) { state->counted = false; --live_dispatchers; }
      }
      return DefWindowProcW(hwnd, message, wp, lp);
    }
  };

 public:
  UiQueue() : state_(std::make_shared<State>()) {
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCWSTR>(&State::window_proc), &state_->module)) {
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter module is unavailable");
    }
    state_->class_name = L"CitizenSDK.Flutter.Dispatcher." +
        std::to_wstring(reinterpret_cast<UINT_PTR>(state_.get()));
    WNDCLASSEXW type{};
    type.cbSize = static_cast<UINT>(sizeof(type));
    type.hInstance = state_->module;
    type.lpfnWndProc = State::window_proc;
    type.lpszClassName = state_->class_name.c_str();
    if (!RegisterClassExW(&type)) {
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter UI class is unavailable");
    }
    state_->registered = true;
    state_->window = CreateWindowExW(0, state_->class_name.c_str(), L"", 0,
        0, 0, 0, 0, HWND_MESSAGE, nullptr, state_->module, state_.get());
    if (state_->window == nullptr) {
      // 只有 WM_NCCREATE 成功挂入 anchor 才计数，WM_NCDESTROY 与它配对。
      if (UnregisterClassW(state_->class_name.c_str(), state_->module)) state_->registered = false;
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter UI queue is unavailable");
    }
  }
  ~UiQueue() {
    std::lock_guard<std::mutex> guard(state_->lock);
    state_->retiring = true;
    if (state_->window != nullptr) (void)PostMessageW(state_->window, kRetire, 0, 0);
  }
  UiQueue(const UiQueue &) = delete;
  UiQueue &operator=(const UiQueue &) = delete;

  void post(std::function<void()> action) {
    if (!action) throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK UI task is empty");
    std::unique_lock<std::mutex> guard(state_->lock);
    if (state_->retiring || state_->window == nullptr || state_->next == 0) {
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Flutter UI queue is retired");
    }
    const auto identity = state_->next;
    state_->next = identity == std::numeric_limits<UINT_PTR>::max() ? 0 : identity + 1;
    state_->pending.emplace(identity, std::move(action));
    if (!PostMessageW(state_->window, kInvoke, identity, 0)) {
      action.swap(state_->pending.at(identity));
      state_->pending.erase(identity);
      guard.unlock();
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter UI queue rejected a task");
    }
  }

 private:
  std::shared_ptr<State> state_;
};

std::unique_ptr<Bytes> encoded_error(citizensdk_error_code_t code, const char *message,
                                    std::optional<std::string> session = {},
                                    std::optional<int64_t> sequence = {},
                                    const std::string &method = "open",
                                    citizensdk_failure_stage_t stage = 0) {
  const auto details = to_encodable_value(
      error_details(code, message, std::move(session), sequence, method, stage));
  return codec().EncodeErrorEnvelope(std::string("citizensdk.") + error_name(code), message, &details);
}

// BinaryReply 是 Flutter 官方自持 messenger 的回应能力，不借用插件或 registrar。
// 引擎已消失时官方实现安全拒发；活引擎替换 channel 时仍须实际回应一次。

struct PreviewPixels final : std::enable_shared_from_this<PreviewPixels> {
  struct FrameLease {
    FlutterDesktopPixelBuffer buffer{};
    std::shared_ptr<const std::vector<uint8_t>> pixels;
    std::shared_ptr<PreviewPixels> owner;
  };
  std::mutex mutex;
  uint32_t width{}, height{};
  std::shared_ptr<const std::vector<uint8_t>> latest;
  std::size_t leases{};
  bool unregistered{}, finalized{};
  std::vector<std::function<void()>> drained;

  void finish() {
    std::vector<std::function<void()>> callbacks;
    {
      std::lock_guard<std::mutex> guard(mutex);
      if (finalized || !unregistered || leases != 0) return;
      finalized = true; latest.reset(); callbacks.swap(drained);
    }
    for (auto &callback : callbacks) if (callback) callback();
  }
  const FlutterDesktopPixelBuffer *copy() noexcept {
    try {
      std::lock_guard<std::mutex> guard(mutex);
      // 固定最多三个借用，不让慢渲染器无限保留旧相机帧。
      if (unregistered || !latest || leases >= 3) return nullptr;
      auto lease = std::make_unique<FrameLease>();
      lease->pixels = latest; lease->owner = shared_from_this();
      lease->buffer.buffer = lease->pixels->data(); lease->buffer.width = width; lease->buffer.height = height;
      lease->buffer.release_context = lease.get();
      lease->buffer.release_callback = [](void *raw) {
        std::unique_ptr<FrameLease> released(static_cast<FrameLease *>(raw));
        const auto state = released->owner;
        { std::lock_guard<std::mutex> guard(state->mutex); --state->leases; }
        released.reset(); // 像素借用已归还，再允许资源收到排空通知。
        state->finish();
      };
      ++leases;
      return &lease.release()->buffer;
    } catch (...) { return nullptr; } // 分配失败不返回无效像素指针。
  }
};

class WindowsCaptureTexture final : public CaptureTexture, public std::enable_shared_from_this<WindowsCaptureTexture> {
 public:
  WindowsCaptureTexture(::flutter::TextureRegistrar *registrar, uint32_t width, uint32_t height)
      : registrar_(registrar), pixels_(std::make_shared<PreviewPixels>()) {
    if (!registrar || width == 0 || width > 4096 || height == 0 || height > 4096)
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "纹理尺寸或注册器无效");
    pixels_->width = width; pixels_->height = height;
  }
  void register_texture() {
    const auto state = pixels_;
    texture_ = std::make_unique<::flutter::TextureVariant>(
        ::flutter::PixelBufferTexture([state](std::size_t, std::size_t) { return state->copy(); }));
    identity_ = registrar_->RegisterTexture(texture_.get());
    if (identity_ < 0) {
      texture_.reset();
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注册失败");
    }
  }
  int64_t id() const noexcept override { return identity_; }
  void update(std::shared_ptr<const std::vector<uint8_t>> rgba) override {
    if (closing_ || !registrar_) return;
    if (!rgba || rgba->size() != static_cast<std::size_t>(pixels_->width) * pixels_->height * 4)
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "纹理像素尺寸不符");
    { std::lock_guard<std::mutex> guard(pixels_->mutex); pixels_->latest = std::move(rgba); }
    if (!registrar_->MarkTextureFrameAvailable(identity_))
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter拒绝纹理帧");
  }
  void close(std::function<void()> drained) override {
    bool complete = false;
    {
      std::lock_guard<std::mutex> guard(pixels_->mutex);
      complete = pixels_->finalized;
      if (!complete && drained) pixels_->drained.push_back(std::move(drained));
    }
    if (complete) { if (drained) drained(); return; }
    if (closing_) return;
    if (!registrar_) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注册器已撤销");
    closing_ = true;
    const auto self = shared_from_this();
    try {
      registrar_->UnregisterTexture(identity_, [self] {
        { std::lock_guard<std::mutex> guard(self->pixels_->mutex); self->pixels_->unregistered = true; }
        // 官方异步注销已完成；即使仍有PixelBuffer借用，也由各自lease保有像素。
        self->texture_.reset();
        self->pixels_->finish();
      });
    } catch (...) { closing_ = false; throw; }
  }
  void detach_registrar() noexcept { registrar_ = nullptr; }
 private:
  ::flutter::TextureRegistrar *registrar_{};
  std::shared_ptr<PreviewPixels> pixels_;
  std::unique_ptr<::flutter::TextureVariant> texture_;
  int64_t identity_{-1};
  bool closing_{};
};

class WindowsTextures final {
 public:
  explicit WindowsTextures(::flutter::TextureRegistrar *value) : registrar_(value) {}
  std::shared_ptr<CaptureTexture> create(uint32_t width, uint32_t height) {
    if (!registrar_) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注册器已撤销");
    values_.erase(std::remove_if(values_.begin(), values_.end(), [](const auto &value) { return value.expired(); }), values_.end());
    auto texture = std::make_shared<WindowsCaptureTexture>(registrar_, width, height);
    values_.push_back(texture);
    texture->register_texture();
    return texture;
  }
  void detach() noexcept {
    for (const auto &weak : values_) if (const auto texture = weak.lock()) {
      try { texture->close({}); } catch (...) { /* 未排空不能通知资源关闭。 */ }
      texture->detach_registrar(); // registrar销毁后任何迟到任务均不得再解引用。
    }
    registrar_ = nullptr;
  }
 private:
  ::flutter::TextureRegistrar *registrar_{};
  std::vector<std::weak_ptr<WindowsCaptureTexture>> values_;
};

struct PendingReply final {
  explicit PendingReply(::flutter::BinaryReply value) : reply(std::move(value)) {}
  ::flutter::BinaryReply reply;
  std::optional<std::string> session;
  std::optional<int64_t> sequence;
  std::string method{"open"};
  bool done{};

  void send(const Bytes *bytes) noexcept {
    if (done) return;
    done = true;
    ::flutter::BinaryReply callback;
    callback.swap(reply);
    try { if (callback) callback(bytes == nullptr ? nullptr : bytes->data(),
                                 bytes == nullptr ? 0 : bytes->size()); }
    catch (...) { /* 回调已消费，不能因宿主异常二次发送。 */ }
  }
  void fail(citizensdk_error_code_t code, const char *message,
            citizensdk_failure_stage_t stage = 0) noexcept {
    if (done) return;
    try { const auto bytes = encoded_error(code, message, session, sequence, method, stage); send(bytes.get()); }
    catch (...) { send(nullptr); }
  }
  void finish(const Reply &value) noexcept {
    if (done) return;
    try {
      const auto result = to_encodable_value(value.value);
      const auto bytes = value.success ? codec().EncodeSuccessEnvelope(&result)
          : codec().EncodeErrorEnvelope(std::string("citizensdk.") + error_name(value.error_code),
                                        value.message, &result);
      send(bytes.get());
    } catch (...) { fail(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK response encoding failed"); }
  }
};

struct PluginState;
struct Registration final {
  std::atomic<bool> owned{false};
};
struct HandlerToken final {
  std::shared_ptr<PluginState> state;
  std::shared_ptr<Registration> registration;
  ~HandlerToken();
};

struct PluginState final : std::enable_shared_from_this<PluginState> {
  std::thread::id ui_thread = std::this_thread::get_id();
  std::shared_ptr<UiQueue> queue = std::make_shared<UiQueue>();
  std::shared_ptr<FlutterEnvironment> environment;
  std::shared_ptr<Sessions> sessions;
  TextureRegistration textures;
  ::flutter::BinaryMessenger *messenger{};
  std::shared_ptr<Registration> method_registration = std::make_shared<Registration>();
  std::shared_ptr<Registration> event_registration = std::make_shared<Registration>();
  std::vector<std::shared_ptr<PendingReply>> pending;
  std::atomic<bool> cleanup_queued{false};
  bool detached{};
  bool listening{};

  void require_ui() const {
    if (std::this_thread::get_id() != ui_thread)
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Flutter requires its UI thread");
  }
  void invalidate() noexcept {
    if (detached) return;
    detached = true;
    listening = false;
    if (textures.detach) textures.detach();
    if (environment) environment->detach();
    const auto current = sessions;
    if (current) current->detach();
  }
  void remove_pending(const std::shared_ptr<PendingReply> &value) {
    pending.erase(std::remove(pending.begin(), pending.end(), value), pending.end());
  }
  void cleanup() noexcept {
    invalidate();
    // 只撤销仍属本实例的注册；外部同名替换已经使旧 token 失效。
    if (messenger != nullptr) {
      if (method_registration->owned.exchange(false)) messenger->SetMessageHandler(kMethodChannel, nullptr);
      if (event_registration->owned.exchange(false)) messenger->SetMessageHandler(kEventChannel, nullptr);
      messenger = nullptr;
    }
    auto replies = std::move(pending);
    pending.clear();
    for (const auto &reply : replies) reply->fail(CITIZENSDK_ERROR_INVALID_STATE,
                                                "CitizenSDK Flutter plugin is detached");
    sessions.reset();
    environment.reset();
    // 已接纳的原生完成仍通过 Sessions 自持 scheduler 退役；这里只释放插件自己的引用。
    queue.reset();
  }
  void handler_destroyed() noexcept {
    if (cleanup_queued.exchange(true)) return;
    if (std::this_thread::get_id() == ui_thread) invalidate();
    try {
      const auto self = shared_from_this();
      queue->post([self] { self->cleanup(); });
    } catch (...) {
      // 不在 handler 销毁栈中答复或重入 messenger；registrar 所有者仍保留待回应状态。
    }
  }
  void shutdown() noexcept {
    // 官方 registrar 在 messenger 销毁前 ClearPlugins；仅在这里同步清理其余注册。
    if (std::this_thread::get_id() != ui_thread) std::terminate();
    cleanup_queued = true;
    cleanup();
  }

  void method(const uint8_t *message, std::size_t size, ::flutter::BinaryReply reply) noexcept {
    std::shared_ptr<PendingReply> response;
    try {
      require_ui();
      response = std::make_shared<PendingReply>(std::move(reply));
      if (detached || !sessions) throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE,
                                                      "CitizenSDK Flutter plugin is detached");
      const auto call = decode_method_call(message, size);
      if (!call) throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK method message is invalid");
      const auto envelope = decode_request_envelope(call->method_name(), call->arguments());
      response->method = call->method_name();
      if (envelope) {
        response->session = envelope->session;
        response->sequence = envelope->sequence;
        sessions->accept_request_sequence(*envelope);
      }
      const auto request = decode_request(call->method_name(), call->arguments());
      response->method = method_name(request.method);
      if (!request.session.empty()) response->session = request.session;
      if (request.method != Method::open && request.method != Method::verify_signature && request.method != Method::encode_signing_payload)
        response->sequence = request.sequence;
      pending.push_back(response);
      const std::weak_ptr<PluginState> weak = shared_from_this();
      const auto current = sessions;
      current->dispatch(request, [weak, response](Reply value) {
        const auto owner = weak.lock();
        if (!owner || owner->detached) return;
        owner->require_ui();
        owner->remove_pending(response);  // 先撤销注册，允许回应回调重入/关闭插件。
        response->finish(value);
      });
    } catch (const ContractFailure &error) {
      if (response) {
        if (!response->session) response->session = error.session;
        if (!response->sequence) response->sequence = error.sequence;
        remove_pending(response);
        response->fail(error.code, error.what(), error.stage);
      } else { PendingReply failure(std::move(reply)); failure.fail(error.code, error.what(), error.stage); }
    } catch (...) {
      if (response) { remove_pending(response); response->fail(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request failed"); }
      else { PendingReply failure(std::move(reply)); failure.fail(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request failed"); }
    }
  }

  void subscription(const uint8_t *message, std::size_t size, ::flutter::BinaryReply reply) noexcept {
    PendingReply response(std::move(reply));
    try {
      require_ui();
      if (detached || !sessions) throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE,
                                                      "CitizenSDK Flutter plugin is detached");
      const auto call = decode_method_call(message, size);
      if (!call) throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK event message is invalid");
      (void)decode_subscription(call->arguments());
      if (call->method_name() == "listen") {
        if (listening) throw ContractFailure(CITIZENSDK_ERROR_BUSY, "CitizenSDK event stream is already active");
        const std::weak_ptr<PluginState> weak = shared_from_this();
        listening = true;
        const auto current = sessions;
        try { current->listen([weak](Value event_value) {
          const auto owner = weak.lock();
          if (!owner || owner->detached || !owner->listening || owner->messenger == nullptr) return;
          owner->require_ui();
          const auto value = to_encodable_value(event_value);
          const auto bytes = codec().EncodeSuccessEnvelope(&value);
          owner->messenger->Send(kEventChannel, bytes->data(), bytes->size());
        }); } catch (...) { listening = false; throw; }
      } else if (call->method_name() == "cancel") {
        const auto current = sessions;
        current->cancel_events();
        listening = false;
      } else {
        throw ContractFailure(CITIZENSDK_ERROR_UNSUPPORTED, "CitizenSDK event method is unsupported");
      }
      const auto bytes = codec().EncodeSuccessEnvelope();
      response.send(bytes.get());
    } catch (const ContractFailure &error) { response.fail(error.code, error.what()); }
    catch (...) { response.fail(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK event request failed"); }
  }
};

HandlerToken::~HandlerToken() {
  registration->owned = false;
  state->handler_destroyed();
}

class CitizenSdkPlugin final : public ::flutter::Plugin {
 public:
  explicit CitizenSdkPlugin(std::shared_ptr<PluginState> state) : state_(std::move(state)) {}
  ~CitizenSdkPlugin() override { state_->shutdown(); }
  const std::shared_ptr<PluginState> &state() const { return state_; }
 private:
  std::shared_ptr<PluginState> state_;
};

}  // namespace

TextureRegistration create_texture_registration(::flutter::TextureRegistrar *registrar) {
  const auto owner = std::make_shared<WindowsTextures>(registrar);
  return {[owner](uint32_t width, uint32_t height) { return owner->create(width, height); },
          [owner] { owner->detach(); }};
}

// 私有依赖注入仅替换原生环境/有限 transport；生产与测试走同一注册和消息实现。
// 不声明在安装头、不导出 C++ 符号，不构成宿主可获取秘密或原生 handle 的 API。
std::unique_ptr<::flutter::Plugin> register_plugin(::flutter::BinaryMessenger *messenger,
    HWND view, EnvironmentFactory environment_factory, TransportFactory transport_factory,
    ::flutter::TextureRegistrar *registrar = nullptr) {
  if (messenger == nullptr) throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT,
                                                 "CitizenSDK Flutter messenger is unavailable");
  const auto state = std::make_shared<PluginState>();
  auto plugin = std::make_unique<CitizenSdkPlugin>(state);
  state->messenger = messenger;
  state->environment = std::make_shared<FlutterEnvironment>(view);
  const auto environment = state->environment;
  if (!environment_factory) environment_factory = [environment](uint32_t modules) { return environment->open(modules); };
  const auto queue = state->queue;
  state->textures = create_texture_registration(registrar);
  state->sessions = Sessions::create(std::move(environment_factory),
      [queue](std::function<void()> action) { queue->post(std::move(action)); }, std::move(transport_factory), state->textures.open);
  const auto method = std::make_shared<HandlerToken>();
  method->state = state;
  method->registration = state->method_registration;
  state->method_registration->owned = true;
  messenger->SetMessageHandler(kMethodChannel,
      [method](const uint8_t *message, std::size_t size, ::flutter::BinaryReply reply) {
        const auto owner = method->state;
        owner->method(message, size, std::move(reply));
      });
  const auto event = std::make_shared<HandlerToken>();
  event->state = state;
  event->registration = state->event_registration;
  state->event_registration->owned = true;
  messenger->SetMessageHandler(kEventChannel,
      [event](const uint8_t *message, std::size_t size, ::flutter::BinaryReply reply) {
        const auto owner = event->state;
        owner->subscription(message, size, std::move(reply));
      });
  return plugin;
}

std::size_t plugin_pending_reply_count(const ::flutter::Plugin &plugin) {
  const auto &state = static_cast<const CitizenSdkPlugin &>(plugin).state();
  state->require_ui();
  return state->pending.size();
}
std::size_t plugin_dispatcher_count() noexcept { return live_dispatchers.load(); }

}  // namespace citizen_sdk::flutter

void CitizenSdkPluginRegisterWithRegistrar(FlutterDesktopPluginRegistrarRef registrar) {
  if (registrar == nullptr) return;
  try {
    auto *owner = ::flutter::PluginRegistrarManager::GetInstance()
        ->GetRegistrar<::flutter::PluginRegistrarWindows>(registrar);
    auto *view = owner->GetView();
    owner->AddPlugin(citizen_sdk::flutter::register_plugin(owner->messenger(),
        view == nullptr ? nullptr : view->GetNativeWindow(), {}, {}, owner->texture_registrar()));
  } catch (...) {
    // C 注册入口绝不抛异常、记录环境/消息内容或构造半可用的降级插件。
  }
}
