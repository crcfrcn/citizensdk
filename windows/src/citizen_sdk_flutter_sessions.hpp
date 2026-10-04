#ifndef CITIZENSDK_WINDOWS_FLUTTER_SESSIONS_HPP
#define CITIZENSDK_WINDOWS_FLUTTER_SESSIONS_HPP

#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include "citizen_sdk/citizen_sdk_config.hpp"
#include "citizen_sdk_flutter_codec.hpp"
#include "citizen_sdk_flutter_environment.hpp"

namespace citizen_sdk::flutter {

// 仅把工作派发到拥有绑定对象的线程，不创建SDK界面。
using Scheduler = std::function<void(std::function<void()>)>;

struct Reply final {
  bool success{};
  Value value;
  citizensdk_error_code_t error_code{CITIZENSDK_OK};
  std::string message;
};
using ReplyCallback = std::function<void(Reply)>;
using EventSink = std::function<void(Value)>;
using EnvironmentFactory = std::function<OpenEnvironment(uint32_t modules)>;

// Internal native seam, not an exported SDK API. Production delegates only to
// the installed Host and its borrowed Core. Tests inject finite callbacks into
// the same routing/state machine without running a chain, Win32 or TPM.

// 生产绑定固定使用公开Core控制函数；内部有限执行器用于验证同一资源状态，不替代认证。
struct PrivateKeyControls {
  using Call = std::function<citizensdk_error_code_t(citizensdk_handle_t, uint64_t)>;
  Call reveal, cancel, finish;
};
// Core receiver的无UI所有者。阶段回调只复制/派发，不反调Core；控制方法由平台线程执行。
class PrivateKeyResource final : public std::enable_shared_from_this<PrivateKeyResource> {
 public:
  using Completion = std::function<void(std::function<Value()>)>;
  using Closed = std::function<void(bool granted)>;
  PrivateKeyResource(citizensdk_handle_t core, std::string id, Completion opened, Closed closed);
  PrivateKeyResource(citizensdk_handle_t core, std::string id, Completion opened, Closed closed,
                     PrivateKeyControls controls);
  citizensdk_private_key_receiver_v1_t receiver() noexcept;
  void bind(uint64_t secret);
  void reveal(Completion completion);
  void close(Completion completion);
  void request_close();
  void terminal(citizensdk_error_code_t code);
  bool is_closed() const;
 private:
  static int32_t receive(void *, uint64_t, citizensdk_bytes_view_t) noexcept;
  static int32_t authorizing(void *, uint64_t, uint64_t) noexcept;
  static void settled(void *, uint64_t, int32_t) noexcept;
  void stage(uint64_t secret, citizensdk_error_code_t code);
  Value grant();
  Value take_secret();
  void deliver_failure(Completion completion, citizensdk_error_code_t code);
  const citizensdk_handle_t core_;
  const PrivateKeyControls controls_;
  const std::string id_;
  mutable std::mutex lock_;
  uint64_t secret_{};
  uint64_t host_operation_{};
  bool prepared_{}, revealing_{}, received_{}, delivered_{}, revoked_{}, terminal_{}, granted_{};
  std::optional<CredentialBytes> bytes_;
  Completion opened_, revealed_;
  std::vector<Completion> closing_;
  Closed closed_;
};


// Flutter只承载像素纹理；注册/更新/关闭均由平台线程调用，关闭回调必须是真实渲染借用排空。
class CaptureTexture {
 public:
  virtual ~CaptureTexture() = default;
  virtual int64_t id() const noexcept = 0;
  virtual void update(std::shared_ptr<const std::vector<uint8_t>> rgba) = 0;
  virtual void close(std::function<void()> drained) = 0;
};
using TextureFactory = std::function<std::shared_ptr<CaptureTexture>(uint32_t width, uint32_t height)>;
struct TextureRegistration {
  TextureFactory open;
  std::function<void()> detach;
};

// 只替换同版Host三个调用中的采集接纳/控制，有限测试不能伪装真实设备权限。
struct CaptureControls {
  using Open = std::function<citizensdk_error_code_t(citizensdk_host_handle_t, uint32_t,
      const citizensdk_qr_capture_callbacks_v1_t *, uint64_t *)>;
  using Control = std::function<citizensdk_error_code_t(citizensdk_host_handle_t, uint64_t, uint64_t, uint32_t, uint8_t)>;
  Open open;
  Control control;
};
class CaptureResource final : public std::enable_shared_from_this<CaptureResource> {
 public:
  using Completion = PrivateKeyResource::Completion;
  using Observer = std::function<void(std::string, Value)>;
  using Closed = std::function<void(bool granted)>;
  CaptureResource(citizensdk_host_handle_t host, std::string id, uint32_t purpose,
                  Scheduler schedule, TextureFactory textures, Observer observer, Closed closed);
  CaptureResource(citizensdk_host_handle_t host, std::string id, uint32_t purpose,
                  Scheduler schedule, TextureFactory textures, Observer observer, Closed closed, CaptureControls controls);
  ~CaptureResource();
  void open(Completion completion);
  void control(Method method, bool enabled, Completion completion);
  void request_close();
  bool is_closed() const noexcept;
 private:
  struct State;
  std::unique_ptr<State> state_;
  static void opened(void *, uint64_t, citizensdk_error_code_t, uint32_t, uint32_t, uint32_t) noexcept;
  static void frame(void *, uint64_t, const citizensdk_qr_frame_v1_t *) noexcept;
  static void document(void *, uint64_t, uint64_t, citizensdk_bytes_view_t) noexcept;
  static void error(void *, uint64_t, citizensdk_error_code_t) noexcept;
  static void controlled(void *, uint64_t, uint64_t, citizensdk_error_code_t) noexcept;
  static void closed(void *, uint64_t, citizensdk_error_code_t) noexcept;
  static void retain(void *) noexcept;
  static void release(void *) noexcept;
  void enqueue(std::function<void()> action) noexcept;
  void finish_close();
  void begin_texture_close();
  void report_error(citizensdk_error_code_t code);
};

class NativeTransport {
 public:
  using Observer = std::function<void(const citizensdk_event_t &)>;
  // 完成回调只通知真实Core终态；producer持有实际结果，平台线程领取后立即释放。
  using Completion = std::function<void(citizensdk_request_id_t, std::function<Value()>)>;
  using ResourceObserver = std::function<void(std::string, Value)>;
  virtual ~NativeTransport() = default;
  virtual void observe_resources(ResourceObserver observer) = 0;
  virtual void private_key(const DecodedRequest &, PrivateKeyResource::Completion) = 0;
  virtual void close_private_keys() = 0;
  virtual bool private_keys_closed() = 0;
  virtual void capture(const DecodedRequest &, PrivateKeyResource::Completion) = 0;
  virtual void close_captures() = 0;
  virtual bool captures_closed() = 0;
  virtual void observe(Observer observer) = 0;
  // 委托本实例Core，不在平台保存接收序号。
  virtual citizensdk_error_code_t accept_request_sequence(uint64_t sequence) = 0;
  virtual citizensdk_error_code_t accept(Method native_method,
                                        const DecodedRequest &public_request,
                                        citizensdk_request_id_t *out_id, Completion completion) = 0;
  // 通知结果仅在观察回调期间借用；请求结果由完成投影持有真实所有权。
  // copy_result只借用，不释放或外泄句柄，错误路径同样由唯一所有者归还。
  virtual Value copy_result(Method method, citizensdk_result_handle_t result) = 0;
  virtual citizensdk_lifecycle_t lifecycle_state() = 0;
  virtual Value capability_snapshot() = 0;
  virtual Value genesis_hash() = 0;
  virtual Value cancel_signing(const DecodedRequest &) {
    throw ContractFailure(CITIZENSDK_ERROR_UNSUPPORTED, "Signing cancellation is unavailable");
  }
  virtual Value cancel_prepared_transaction(const DecodedRequest &) {
    throw ContractFailure(CITIZENSDK_ERROR_UNSUPPORTED,
                          "Prepared transaction cancellation is unavailable");
  }
  virtual Value cancel_transaction_execution(const DecodedRequest &) {
    throw ContractFailure(CITIZENSDK_ERROR_UNSUPPORTED,
                          "Transaction execution cancellation is unavailable");
  }
  virtual Value qr(const DecodedRequest &) {
    throw ContractFailure(CITIZENSDK_ERROR_UNSUPPORTED, "QR transport is unavailable");
  }
  // 同步输入校验及已登记资源的控制；不创建窗口，也不保存宿主输入。
  virtual Value control(const DecodedRequest &) = 0;
  virtual void cancel_credential(uint64_t) {
    throw ContractFailure(CITIZENSDK_ERROR_UNSUPPORTED, "Credential transport is unavailable");
  }
  virtual bool cancel(citizensdk_request_id_t request) = 0;
  virtual void close() = 0;
  // No-throw ownership transfer to the existing Host supervisor. Caller must
  // cease use afterwards. A live transport is never silently dropped.
  virtual void retire() noexcept = 0;
};
using TransportFactory = std::function<std::shared_ptr<NativeTransport>(const Config &)>;

// Windows Host 可在 Core 已销毁后因 UI 退休 BUSY 保留句柄。此私有合同只允许
// 已实际发起 close 且先确认非运行态的 transport 重试，不把首次 NOT_READY 当已停止。
bool allow_close_without_core(bool close_attempted,
                              citizensdk_lifecycle_t checkpoint_state,
                              citizensdk_error_code_t host_status,
                              citizensdk_handle_t core);

class Sessions final : public std::enable_shared_from_this<Sessions> {
 public:
  static std::shared_ptr<Sessions> create(EnvironmentFactory environment,
                                           Scheduler scheduler,
                                           TransportFactory transport = {}, TextureFactory textures = {});
  ~Sessions();
  Sessions(const Sessions &) = delete;
  Sessions &operator=(const Sessions &) = delete;

  // All entry points belong to the registrar's UI thread. Scheduler must queue
  // onto that thread and must never execute inline on a native callback thread.
  void accept_request_sequence(const RequestEnvelope &request);
  void dispatch(DecodedRequest request, ReplyCallback reply);
  void listen(EventSink sink);
  void cancel_events();
  void detach() noexcept;
  std::size_t session_count() const;

 private:
  struct State;
  explicit Sessions(std::shared_ptr<State> state);
  std::shared_ptr<State> state_;
};

}  // namespace citizen_sdk::flutter
#endif
