#include "citizen_sdk/citizen_sdk_plugin.h"

#include <algorithm>
#include <functional>
#include <exception>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#include "citizen_sdk_flutter_codec.hpp"
#include "citizen_sdk_flutter_environment.hpp"
#include "citizen_sdk_flutter_sessions.hpp"

namespace {

using namespace citizen_sdk::flutter;

// 必须排队到已确认的 GTK 主上下文；禁止在 handler 销毁栈或原生回调线程内联进入 Flutter。
// Always enqueue a new source: g_main_context_invoke_full may execute inline
// when called by the context owner, which would re-enter Flutter's handler
// destroy callback before Flutter has cleared its old user_data pointer.
void post(GMainContext *context, std::function<void()> work) {
  auto owned = std::make_unique<std::function<void()>>(std::move(work));
  GSource *source = g_idle_source_new();
  if (source == nullptr) {
    throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                          "CitizenSDK Flutter UI task allocation failed");
  }
  g_source_set_callback(
      source,
      [](gpointer data) -> gboolean {
        try {
          (*static_cast<std::function<void()> *>(data))();
        } catch (...) {
          // Never log request arguments or native error payloads.
          g_warning("CitizenSDK Flutter UI task failed");
        }
        return G_SOURCE_REMOVE;
      },
      owned.release(),
      [](gpointer data) { delete static_cast<std::function<void()> *>(data); });
  const guint source_id = g_source_attach(source, context);
  g_source_unref(source);
  if (source_id == 0) {
    throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                          "CitizenSDK Flutter UI context rejected a task");
  }
}


// PixelBuffer返回的指针在注销前必须稳定；仅渲染回调改写这块固定大小的RGBA缓冲。
struct PreviewPixels final {
  std::mutex mutex;
  uint32_t width{}, height{};
  std::shared_ptr<const std::vector<uint8_t>> latest;
  std::vector<uint8_t> stable;
  bool finalized{};
  std::vector<std::function<void()>> drained;
};
typedef struct _CitizenSdkPreviewTexture {
  FlPixelBufferTexture parent_instance;
  std::shared_ptr<PreviewPixels> *pixels;
} CitizenSdkPreviewTexture;
typedef struct _CitizenSdkPreviewTextureClass {
  FlPixelBufferTextureClass parent_class;
} CitizenSdkPreviewTextureClass;
G_DEFINE_TYPE(CitizenSdkPreviewTexture, citizen_sdk_preview_texture, fl_pixel_buffer_texture_get_type())

gboolean preview_copy(FlPixelBufferTexture *texture, const uint8_t **buffer,
                      uint32_t *width, uint32_t *height, GError **) noexcept {
  auto *self = reinterpret_cast<CitizenSdkPreviewTexture *>(texture);
  if (!self->pixels || !buffer || !width || !height) return FALSE;
  const auto state = *self->pixels;
  {
    std::lock_guard<std::mutex> guard(state->mutex);
    if (state->finalized) return FALSE;
    if (state->latest) std::copy(state->latest->begin(), state->latest->end(), state->stable.begin());
  }
  *buffer = state->stable.data(); *width = state->width; *height = state->height;
  return TRUE;
}
void preview_finalize(GObject *object) {
  auto *self = reinterpret_cast<CitizenSdkPreviewTexture *>(object);
  const auto state = self->pixels ? *self->pixels : std::shared_ptr<PreviewPixels>{};
  delete self->pixels; self->pixels = nullptr;
  G_OBJECT_CLASS(citizen_sdk_preview_texture_parent_class)->finalize(object);
  if (!state) return;
  std::vector<std::function<void()>> callbacks;
  {
    std::lock_guard<std::mutex> guard(state->mutex);
    state->finalized = true; state->latest.reset(); state->stable.clear();
    callbacks.swap(state->drained);
  }
  // GObject实际终结之后才通知资源层；注销接纳本身不能冒充最后渲染引用已归还。
  for (auto &callback : callbacks) if (callback) callback();
}
void citizen_sdk_preview_texture_class_init(CitizenSdkPreviewTextureClass *type) {
  G_OBJECT_CLASS(type)->finalize = preview_finalize;
  FL_PIXEL_BUFFER_TEXTURE_CLASS(type)->copy_pixels = preview_copy;
}
void citizen_sdk_preview_texture_init(CitizenSdkPreviewTexture *self) { self->pixels = nullptr; }

class LinuxCaptureTexture final : public CaptureTexture {
 public:
  LinuxCaptureTexture(FlTextureRegistrar *registrar, uint32_t width, uint32_t height)
      : registrar_(FL_TEXTURE_REGISTRAR(g_object_ref(registrar)), [](FlTextureRegistrar *value) { g_object_unref(value); }), pixels_(std::make_shared<PreviewPixels>()) {
    if (width == 0 || width > 4096 || height == 0 || height > 4096)
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "纹理尺寸无效");
    pixels_->width = width; pixels_->height = height;
    pixels_->stable.resize(static_cast<std::size_t>(width) * height * 4);
  }
  ~LinuxCaptureTexture() override {
    // 成功注册的纹理必须由close注销；失败不能靠析构伪造渲染排空。
    if (texture_) std::terminate();
  }
  void register_texture() {
    auto *created = reinterpret_cast<CitizenSdkPreviewTexture *>(g_object_new(citizen_sdk_preview_texture_get_type(), nullptr));
    try { created->pixels = new std::shared_ptr<PreviewPixels>(pixels_); }
    catch (...) { g_object_unref(created); throw; }
    if (!fl_texture_registrar_register_texture(registrar_.get(), FL_TEXTURE(created))) {
      g_object_unref(created);
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注册失败");
    }
    texture_ = created;
    identity_ = fl_texture_get_id(FL_TEXTURE(created));
    if (identity_ < 0) {
      close({});
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "Flutter纹理编号无效");
    }
  }
  int64_t id() const noexcept override { return identity_; }
  void update(std::shared_ptr<const std::vector<uint8_t>> rgba) override {
    if (!texture_) return;
    if (!rgba || rgba->size() != pixels_->stable.size())
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "纹理像素尺寸不符");
    { std::lock_guard<std::mutex> guard(pixels_->mutex); pixels_->latest = std::move(rgba); }
    if (!fl_texture_registrar_mark_texture_frame_available(registrar_.get(), FL_TEXTURE(texture_)))
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
    if (!texture_) return; // 注销后GObject可能仍被真实渲染调用保有。
    if (!fl_texture_registrar_unregister_texture(registrar_.get(), FL_TEXTURE(texture_)))
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注销失败");
    auto *owned = texture_; texture_ = nullptr;
    g_object_unref(owned);
  }
 private:
  std::shared_ptr<FlTextureRegistrar> registrar_;
  CitizenSdkPreviewTexture *texture_{};
  std::shared_ptr<PreviewPixels> pixels_;
  int64_t identity_{-1};
};

class LinuxTextures final {
 public:
  explicit LinuxTextures(FlTextureRegistrar *value)
      : registrar_(value ? FL_TEXTURE_REGISTRAR(g_object_ref(value)) : nullptr) {}
  ~LinuxTextures() { g_clear_object(&registrar_); }
  std::shared_ptr<CaptureTexture> create(uint32_t width, uint32_t height) {
    if (detached_ || !registrar_) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注册器已撤销");
    values_.erase(std::remove_if(values_.begin(), values_.end(), [](const auto &value) { return value.expired(); }), values_.end());
    auto texture = std::make_shared<LinuxCaptureTexture>(registrar_, width, height);
    values_.push_back(texture); // 注册前完成容器分配，避免已注册对象在异常路径被直接析构。
    texture->register_texture();
    return texture;
  }
  void detach() noexcept {
    detached_ = true;
    for (const auto &weak : values_) if (const auto texture = weak.lock()) {
      try { texture->close({}); } catch (...) { /* 资源仍拥有纹理；不提前确认释放。 */ }
    }
  }
 private:
  FlTextureRegistrar *registrar_{};
  bool detached_{};
  std::vector<std::weak_ptr<LinuxCaptureTexture>> values_;
};

struct PendingReply final {
  PendingReply(FlMethodCall *value, const DecodedRequest &request)
      : session(request.session.empty()
                    ? std::nullopt
                    : std::optional<std::string>(request.session)),
sequence(request.method == Method::open || request.method == Method::verify_signature || request.method == Method::encode_signing_payload
                     ? std::nullopt
                     : std::optional<int64_t>(request.sequence)),
        method(method_name(request.method)) {
    call = FL_METHOD_CALL(g_object_ref(value));
  }
  ~PendingReply() { g_clear_object(&call); }

  void finish(const Reply &reply) noexcept {
    if (done) return;
    done = true;
    try {
      auto value = to_fl_value(reply.value);
      g_autoptr(GError) error = nullptr;
      if (reply.success) {
        (void)fl_method_call_respond_success(call, value.get(), &error);
      } else {
        const auto code = static_cast<citizensdk_error_code_t>(reply.error_code);
        const std::string name = std::string("citizensdk.") + error_name(code);
        (void)fl_method_call_respond_error(
            call, name.c_str(), reply.message.c_str(), value.get(), &error);
      }
    } catch (...) {
      g_autoptr(GError) error = nullptr;
      (void)fl_method_call_respond_error(
          call, "citizensdk.internal", "CitizenSDK response encoding failed",
          nullptr, &error);
    }
    g_clear_object(&call);
  }

  void fail(citizensdk_error_code_t code, const char *message,
            citizensdk_failure_stage_t stage = 0) noexcept {
    if (done) return;
    try {
      finish({false, error_details(code, message, session, sequence, method, stage), code, message});
    } catch (...) {
      // Even if constructing structured error details fails, a retained live
      // FlMethodCall must be answered before its last reference is dropped.
      done = true;
      g_autoptr(GError) error = nullptr;
      (void)fl_method_call_respond_error(
          call, "citizensdk.internal", "CitizenSDK response encoding failed",
          nullptr, &error);
      g_clear_object(&call);
    }
  }

  FlMethodCall *call = nullptr;
  std::optional<std::string> session;
  std::optional<int64_t> sequence;
  std::string method;
  bool done = false;
};

struct RegistrationState final {
  // Cleared by the corresponding channel's official destroy notification.
  // A replaced registration belongs to its new owner and must not be removed.
  bool owned = false;
};

struct PluginState final {
  // Registration below proves ownership of this exact GTK platform context;
  // an unrelated thread-default context must never receive Flutter objects.
  GMainContext *context = g_main_context_ref(g_main_context_default());
  std::thread::id ui_thread = std::this_thread::get_id();
  std::shared_ptr<FlutterEnvironment> environment;
  std::shared_ptr<Sessions> sessions;
  TextureRegistration textures;
  FlBinaryMessenger *messenger = nullptr;
  FlMethodChannel *method_channel = nullptr;
  FlEventChannel *event_channel = nullptr;
  RegistrationState method_registration;
  RegistrationState event_registration;
  std::vector<std::shared_ptr<PendingReply>> pending;
  bool detached = false;
  bool cleanup_queued = false;

  ~PluginState() {
    g_clear_object(&method_channel);
    g_clear_object(&event_channel);
    g_clear_object(&messenger);
    g_main_context_unref(context);
  }

  void invalidate() noexcept {
    if (detached) return;
    detached = true;
    // handler 销毁既可能是引擎关闭，也可能只是活引擎替换同名 channel。
    // 先撤销业务回调，但保留全部未回复 FlMethodCall 到销毁栈外的 UI cleanup；
    // 直接丢句柄会违反 Flutter 回应契约，并使活引擎内的 Dart Future 悬空。
    // This does not claim accepted native operations have finished/cancelled;
    // Sessions still owns their checkpointed shutdown and native resources.
    if (textures.detach) textures.detach();
    if (environment) environment->detach();
    if (sessions) sessions->detach();
  }

  void settle_detached() noexcept {
    auto replies = std::move(pending);
    for (const auto &reply : replies) {
      reply->fail(CITIZENSDK_ERROR_INVALID_STATE,
                  "CitizenSDK Flutter plugin is detached");
    }
  }
};

}  // namespace

typedef struct _CitizenSdkPlugin {
  GObject parent_instance;
  PluginState *state;
} CitizenSdkPlugin;

typedef struct _CitizenSdkPluginClass {
  GObjectClass parent_class;
} CitizenSdkPluginClass;

G_DEFINE_TYPE(CitizenSdkPlugin, citizen_sdk_plugin, G_TYPE_OBJECT)

namespace {

struct HandlerToken final {
  HandlerToken(CitizenSdkPlugin *value, RegistrationState *state)
      : plugin(static_cast<CitizenSdkPlugin *>(g_object_ref(value))),
        registration(state) {}
  ~HandlerToken() { g_object_unref(plugin); }
  CitizenSdkPlugin *plugin;
  RegistrationState *registration;
};

struct WeakPlugin final {
  explicit WeakPlugin(CitizenSdkPlugin *plugin) { g_weak_ref_init(&value, plugin); }
  ~WeakPlugin() { g_weak_ref_clear(&value); }
  GWeakRef value{};
};

std::shared_ptr<CitizenSdkPlugin> lock_plugin(const std::shared_ptr<WeakPlugin> &weak) {
  auto *plugin = static_cast<CitizenSdkPlugin *>(g_weak_ref_get(&weak->value));
  return {plugin, [](CitizenSdkPlugin *value) {
            if (value != nullptr) g_object_unref(value);
          }};
}

void begin_detach(CitizenSdkPlugin *plugin) noexcept {
  PluginState *state = plugin->state;
  if (state == nullptr) return;
  if (state->cleanup_queued) return;
  state->cleanup_queued = true;
  // 先撤销新请求和订阅，再异步解除 channel；原生已接纳操作仍由 Sessions 收口。
  // Flutter normally destroys handlers on the GTK platform thread. If an
  // embedding messenger violates that expectation, defer *all* session and
  // GTK work; only GObject ref-counting/GWeakRef may cross this boundary.
  const bool already_ui = std::this_thread::get_id() == state->ui_thread;
  if (already_ui) state->invalidate();
  // Keep finalization out of Flutter's current handler-destroy stack. If even
  // allocating the idle task fails, deliberately retain this one object until
  // process teardown instead of risking a re-entrant double destroy.
  auto *retained = static_cast<CitizenSdkPlugin *>(g_object_ref(plugin));
  try {
    post(state->context, [retained] {
      PluginState *current = retained->state;
      if (!current->detached) current->invalidate();
      // Outside channel_closed_cb: the old method channel still owns its
      // messenger and codec, so it can settle pending calls even if another
      // handler now owns the channel name. Official send_response also safely
      // handles an engine that has already gone away. Never guess that state.
      current->settle_detached();
      // 清用户 handler 并不注销 messenger 的注册，也不会解除 channel 与
      // messenger 的相互引用。只注销 token 仍确认属于本实例的注册；同名
      // channel 已被替换时，旧 token 已失效，不能删掉新 owner 的 handler。
      if (current->messenger != nullptr && current->method_registration.owned) {
        fl_binary_messenger_set_message_handler_on_channel(
            current->messenger, kMethodChannel, nullptr, nullptr, nullptr);
      }
      if (current->messenger != nullptr && current->event_registration.owned) {
        fl_binary_messenger_set_message_handler_on_channel(
            current->messenger, kEventChannel, nullptr, nullptr, nullptr);
      }
      g_clear_object(&current->method_channel);
      g_clear_object(&current->event_channel);
      g_clear_object(&current->messenger);
      current->sessions.reset();
      current->environment.reset();
      g_object_unref(retained);
    });
  } catch (...) {
    // Admission is already revoked; never synchronously re-enter the Flutter
    // destroy callback on an allocation failure. Retaining the adapter also
    // retains pending response handles instead of dropping them unanswered.
    g_warning("CitizenSDK Flutter detach scheduling failed; retaining detached adapter");
  }
}

void handler_destroyed(gpointer user_data) noexcept {
  auto *token = static_cast<HandlerToken *>(user_data);
  token->registration->owned = false;
  begin_detach(token->plugin);
  delete token;
}

FlMethodErrorResponse *failure_response(citizensdk_error_code_t code,
                                       const std::string &message,
                                       std::optional<std::string> session = {},
                                       std::optional<int64_t> sequence = {},
                                       std::string method = "open",
                                       citizensdk_failure_stage_t stage = 0) {
  const std::string name = std::string("citizensdk.") + error_name(code);
  auto details = to_fl_value(error_details(code, message, session, sequence, method, stage));
  return fl_method_error_response_new(name.c_str(), message.c_str(), details.get());
}

void respond_failure(FlMethodCall *call, citizensdk_error_code_t code,
                     const std::string &message,
                     std::optional<std::string> session = {},
                     std::optional<int64_t> sequence = {},
                     std::string method = "open",
                     citizensdk_failure_stage_t stage = 0) noexcept {
  try {
    g_autoptr(FlMethodErrorResponse) response =
        failure_response(code, message, std::move(session), sequence, std::move(method), stage);
    g_autoptr(GError) error = nullptr;
    (void)fl_method_call_respond(call, FL_METHOD_RESPONSE(response), &error);
  } catch (...) {
    g_autoptr(GError) error = nullptr;
    (void)fl_method_call_respond_error(
        call, "citizensdk.internal", "CitizenSDK request failed", nullptr, &error);
  }
}

void method_call(FlMethodChannel *, FlMethodCall *call, gpointer user_data) noexcept {
  auto *plugin = static_cast<HandlerToken *>(user_data)->plugin;
  PluginState *state = plugin->state;
  std::shared_ptr<PendingReply> pending;
  std::optional<RequestEnvelope> envelope;
  try {
    if (state->detached || state->sessions == nullptr) {
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE,
                            "CitizenSDK Flutter plugin is detached");
    }
    envelope = decode_request_envelope(fl_method_call_get_name(call), fl_method_call_get_args(call));
    if (envelope) state->sessions->accept_request_sequence(*envelope);
    const DecodedRequest request = decode_request(
        fl_method_call_get_name(call), fl_method_call_get_args(call));
    pending = std::make_shared<PendingReply>(call, request);
    state->pending.push_back(pending);
    auto weak = std::make_shared<WeakPlugin>(plugin);
    state->sessions->dispatch(request, [weak, pending](Reply reply) {
      auto owner = lock_plugin(weak);
      if (!owner || owner->state->detached) return;
      pending->finish(reply);
      auto &replies = owner->state->pending;
      replies.erase(std::remove(replies.begin(), replies.end(), pending), replies.end());
    });
  } catch (const ContractFailure &error) {
    if (pending) {
      try {
        pending->finish({false,
            error_details(error.code, error.what(), error.session, error.sequence,
                          pending->method, error.stage),
            error.code, error.what()});
      } catch (...) {
        pending->fail(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request failed",
                      CITIZENSDK_FAILURE_STAGE_TEARDOWN);
      }
    } else {
      const std::string method = fl_method_call_get_name(call);
      respond_failure(call, error.code, error.what(),
                      error.session ? error.session : (envelope ? std::optional<std::string>(envelope->session) : std::nullopt),
                      error.sequence ? error.sequence : (envelope ? std::optional<int64_t>(envelope->sequence) : std::nullopt),
                      method, error.stage);
    }
  } catch (...) {
    if (pending) {
      try {
        pending->finish({false,
            error_details(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request failed",
                          {}, {}, pending->method, CITIZENSDK_FAILURE_STAGE_TEARDOWN),
            CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request failed"});
      } catch (...) {
        pending->fail(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request failed");
      }
    } else {
      respond_failure(call, CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request failed",
                      {}, {}, fl_method_call_get_name(call), CITIZENSDK_FAILURE_STAGE_TEARDOWN);
    }
  }
  if (pending && pending->done) {
    auto &replies = state->pending;
    replies.erase(std::remove(replies.begin(), replies.end(), pending), replies.end());
  }
}

FlMethodErrorResponse *listen(FlEventChannel *, FlValue *arguments,
                              gpointer user_data) noexcept {
  auto *plugin = static_cast<HandlerToken *>(user_data)->plugin;
  try {
    if (plugin->state->detached) {
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE,
                            "CitizenSDK Flutter plugin is detached");
    }
    (void)decode_subscription(arguments);
    auto weak = std::make_shared<WeakPlugin>(plugin);
    plugin->state->sessions->listen([weak](Value event_value) {
      auto owner = lock_plugin(weak);
      if (!owner || owner->state->detached || owner->state->event_channel == nullptr) return;
      auto value = to_fl_value(event_value);
      g_autoptr(GError) error = nullptr;
      if (!fl_event_channel_send(owner->state->event_channel, value.get(), nullptr, &error)) {
        // Revoke the subscription; never replay a failed event as if it were
        // a newly accepted operation or log its payload.
        owner->state->sessions->cancel_events();
      }
    });
    return nullptr;
  } catch (const ContractFailure &error) {
    try { return failure_response(error.code, error.what(), error.session, error.sequence); }
    catch (...) {}
  } catch (...) {}
  return fl_method_error_response_new("citizensdk.internal",
                                      "CitizenSDK event subscription failed", nullptr);
}

FlMethodErrorResponse *cancel(FlEventChannel *, FlValue *arguments,
                              gpointer user_data) noexcept {
  auto *plugin = static_cast<HandlerToken *>(user_data)->plugin;
  try {
    (void)decode_subscription(arguments);
    if (!plugin->state->detached) plugin->state->sessions->cancel_events();
    return nullptr;
  } catch (const ContractFailure &error) {
    try { return failure_response(error.code, error.what(), error.session, error.sequence); }
    catch (...) {}
  } catch (...) {}
  return fl_method_error_response_new("citizensdk.internal",
                                      "CitizenSDK event cancellation failed", nullptr);
}

}  // namespace

static void citizen_sdk_plugin_dispose(GObject *object) {
  auto *plugin = reinterpret_cast<CitizenSdkPlugin *>(object);
  if (plugin->state != nullptr) plugin->state->invalidate();
  G_OBJECT_CLASS(citizen_sdk_plugin_parent_class)->dispose(object);
}

static void citizen_sdk_plugin_finalize(GObject *object) {
  auto *plugin = reinterpret_cast<CitizenSdkPlugin *>(object);
  delete plugin->state;
  plugin->state = nullptr;
  G_OBJECT_CLASS(citizen_sdk_plugin_parent_class)->finalize(object);
}

static void citizen_sdk_plugin_class_init(CitizenSdkPluginClass *klass) {
  G_OBJECT_CLASS(klass)->dispose = citizen_sdk_plugin_dispose;
  G_OBJECT_CLASS(klass)->finalize = citizen_sdk_plugin_finalize;
}

static void citizen_sdk_plugin_init(CitizenSdkPlugin *plugin) { plugin->state = nullptr; }

namespace citizen_sdk::flutter {

TextureRegistration create_texture_registration(FlTextureRegistrar *registrar) {
  const auto owner = std::make_shared<LinuxTextures>(registrar);
  return {[owner](uint32_t width, uint32_t height) { return owner->create(width, height); },
          [owner] { owner->detach(); }};
}

// Internal dependency seam for deterministic native transport fixtures. This
// symbol is hidden by the plugin's visibility policy and is not declared in
// installed/public headers. Production and tests use this same registration,
// pending-reply and detach implementation; the exported entry uses OS/Host.
void register_plugin(FlPluginRegistrar *registrar,
                     EnvironmentFactory environment_factory,
                     TransportFactory transport_factory) {
  g_return_if_fail(FL_IS_PLUGIN_REGISTRAR(registrar));
  // Generated GTK runners register synchronously from the UI context. There
  // is no worker-thread registration path and no asynchronous half-attachment.
  g_return_if_fail(g_main_context_is_owner(g_main_context_default()));
  auto *plugin = static_cast<CitizenSdkPlugin *>(
      g_object_new(citizen_sdk_plugin_get_type(), nullptr));
  try {
    plugin->state = new PluginState();
    PluginState *state = plugin->state;
    FlBinaryMessenger *messenger = fl_plugin_registrar_get_messenger(registrar);
    if (messenger == nullptr || !FL_IS_BINARY_MESSENGER(messenger)) {
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                            "CitizenSDK Flutter messenger is unavailable");
    }
    state->messenger = FL_BINARY_MESSENGER(g_object_ref(messenger));
    FlView *view = fl_plugin_registrar_get_view(registrar);
    state->environment = std::make_shared<FlutterEnvironment>(
        view == nullptr ? nullptr : GTK_WIDGET(view));
    const auto environment = state->environment;
    const auto context = std::shared_ptr<GMainContext>(
        g_main_context_ref(state->context), g_main_context_unref);
    if (!environment_factory) {
      environment_factory = [environment](uint32_t modules) { return environment->open(modules); };
    }
    state->textures = create_texture_registration(fl_plugin_registrar_get_texture_registrar(registrar));
    state->sessions = Sessions::create(
        std::move(environment_factory),
        [context](std::function<void()> work) { post(context.get(), std::move(work)); },
        std::move(transport_factory), state->textures.open);
    g_autoptr(FlStandardMethodCodec) codec = new_method_codec();
    auto method_token = std::make_unique<HandlerToken>(
        plugin, &state->method_registration);
    state->method_channel = fl_method_channel_new(messenger, kMethodChannel, FL_METHOD_CODEC(codec));
    if (state->method_channel == nullptr) {
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                            "CitizenSDK Flutter method channel is unavailable");
    }
    state->method_registration.owned = true;
    fl_method_channel_set_method_call_handler(
        state->method_channel, method_call, method_token.release(), handler_destroyed);
    auto event_token = std::make_unique<HandlerToken>(
        plugin, &state->event_registration);
    state->event_channel = fl_event_channel_new(messenger, kEventChannel, FL_METHOD_CODEC(codec));
    if (state->event_channel == nullptr) {
      throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                            "CitizenSDK Flutter event channel is unavailable");
    }
    state->event_registration.owned = true;
    fl_event_channel_set_stream_handlers(
        state->event_channel, listen, cancel, event_token.release(), handler_destroyed);
  } catch (...) {
    begin_detach(plugin);
    g_warning("CitizenSDK Flutter registration failed");
  }
  g_object_unref(plugin);
}

}  // namespace citizen_sdk::flutter

void citizen_sdk_plugin_register_with_registrar(FlPluginRegistrar *registrar) {
  citizen_sdk::flutter::register_plugin(registrar, {}, {});
}
