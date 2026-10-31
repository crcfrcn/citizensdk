// 两平台共同编译这份真实实现；条件块只保留系统调用差异。
#ifndef CITIZENSDK_FLUTTER_HPP
#define CITIZENSDK_FLUTTER_HPP

#include "citizen_sdk_flutter_environment.hpp"
#include "environment.hpp"
#include "value.hpp"
#include <functional>
#include <memory>
#include <mutex>
#include <string>

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

// Windows销毁Core后的关闭重入仍核对真实Host状态，测试使用同一生产判断。
#if defined(_WIN32)
bool allow_close_without_core(bool close_attempted,
                              citizensdk_lifecycle_t checkpoint_state,
                              citizensdk_error_code_t host_status,
                              citizensdk_handle_t core);
#endif

// 生产绑定固定使用公开Core控制函数；内部有限执行器用于验证同一资源状态，不替代认证。
struct PrivateKeyControls {
  using Call =
      std::function<citizensdk_error_code_t(citizensdk_handle_t, uint64_t)>;
  Call reveal, cancel, finish;
};
// Core
// receiver的无UI所有者。阶段回调只复制/派发，不反调Core；控制方法由平台线程执行。
class PrivateKeyResource final
    : public std::enable_shared_from_this<PrivateKeyResource> {
public:
  using Completion = std::function<void(std::function<Value()>)>;
  using Closed = std::function<void(bool granted)>;
  PrivateKeyResource(citizensdk_handle_t core, std::string id,
                     Completion opened, Closed closed);
  PrivateKeyResource(citizensdk_handle_t core, std::string id,
                     Completion opened, Closed closed,
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
  bool prepared_{}, revealing_{}, received_{}, delivered_{}, revoked_{},
      terminal_{}, granted_{};
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
using TextureFactory = std::function<std::shared_ptr<CaptureTexture>(
    uint32_t width, uint32_t height)>;
struct TextureRegistration {
  TextureFactory open;
  std::function<void()> detach;
};

// 只替换同版Host三个调用中的采集接纳/控制，有限测试不能伪装真实设备权限。
struct CaptureControls {
  using Open = std::function<citizensdk_error_code_t(
      citizensdk_host_handle_t, uint32_t,
      const citizensdk_qr_capture_callbacks_v1_t *, uint64_t *)>;
  using Control = std::function<citizensdk_error_code_t(
      citizensdk_host_handle_t, uint64_t, uint64_t, uint32_t, uint8_t)>;
  Open open;
  Control control;
};
class CaptureResource final
    : public std::enable_shared_from_this<CaptureResource> {
public:
  using Completion = PrivateKeyResource::Completion;
  using Observer = std::function<void(std::string, Value)>;
  using Closed = std::function<void(bool granted)>;
  CaptureResource(citizensdk_host_handle_t host, std::string id,
                  uint32_t purpose, Scheduler schedule, TextureFactory textures,
                  Observer observer, Closed closed);
  CaptureResource(citizensdk_host_handle_t host, std::string id,
                  uint32_t purpose, Scheduler schedule, TextureFactory textures,
                  Observer observer, Closed closed, CaptureControls controls);
  ~CaptureResource();
  void open(Completion completion);
  void control(Method method, bool enabled, Completion completion);
  void request_close();
  bool is_closed() const noexcept;

private:
  struct State;
  std::unique_ptr<State> state_;
  static void opened(void *, uint64_t, citizensdk_error_code_t, uint32_t,
                     uint32_t, uint32_t) noexcept;
  static void frame(void *, uint64_t,
                    const citizensdk_qr_frame_v1_t *) noexcept;
  static void document(void *, uint64_t, uint64_t,
                       citizensdk_bytes_view_t) noexcept;
  static void error(void *, uint64_t, citizensdk_error_code_t) noexcept;
  static void controlled(void *, uint64_t, uint64_t,
                         citizensdk_error_code_t) noexcept;
  static void closed(void *, uint64_t, citizensdk_error_code_t) noexcept;
  static void retain(void *) noexcept;
  static void release(void *) noexcept;
  void enqueue(std::function<void()> action) noexcept;
  void finish_close();
  void begin_texture_close();
  void report_error(citizensdk_error_code_t code);
};

class Sessions final : public std::enable_shared_from_this<Sessions> {
public:
  static std::shared_ptr<Sessions> create(EnvironmentFactory environment,
                                          Scheduler scheduler,
                                          TextureFactory textures = {});
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

} // namespace citizen_sdk::flutter
#endif
