#ifndef CITIZENSDK_LINUX_QR_CAMERA_HPP
#define CITIZENSDK_LINUX_QR_CAMERA_HPP
#include <cstdint>
#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "citizensdk_types.h"
#include "citizen_sdk/citizensdk_host.h"
namespace citizen_sdk::linux {
// 相机输出同帧RGBA8与识别用亮度；不创建预览窗口、不解释QR协议。
struct QrFrame final {
  uint32_t width{};
  uint32_t height{};
  uint32_t rotation_degrees{};
  std::vector<uint8_t> luminance;
  std::vector<uint8_t> rgba;
};
// 只做平台像素格式/行跨度投影；识别继续由同一ZXing实现，不在此解析二维码。
QrFrame copy_qr_frame(const uint8_t *data, std::size_t size, uint32_t width,
                      uint32_t height, int64_t stride, bool bgrx);
class QrCamera final {
 public:
  using Frame = std::function<void(QrFrame)>;
  using Failure = std::function<void(citizensdk_error_code_t, std::string)>;
  QrCamera(Frame frame, Failure failure);
  QrCamera(const QrCamera &) = delete;
  QrCamera &operator=(const QrCamera &) = delete;
  ~QrCamera();
  void start();
  // 只对当前实际设备查询/设置torch；不支持时返回事实，不伪造成功。
  citizensdk_error_code_t set_torch(bool enabled) noexcept;
  // 必须在 SDK 清理 worker 调用：停止真实采集、等待回调和线程排空后返回。
  void stop() noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// 采集资源仅协调平台设备与真实回调；不包含窗口、布局、App文案或第二二维码算法。
class QrCapture final : public std::enable_shared_from_this<QrCapture> {
 public:
  struct Device {
    std::function<void()> start;
    std::function<void()> stop; // 不抛异常，返回时设备线程与回调必须已排空。
    std::function<citizensdk_error_code_t(bool)> torch;
  };
  using Factory = std::function<Device(QrCamera::Frame, QrCamera::Failure)>;
  using Terminal = std::function<void(uint64_t)>;
  QrCapture(citizensdk_handle_t sdk, uint64_t resource_id, uint32_t purpose,
            citizensdk_qr_capture_callbacks_v1_t callbacks, std::shared_ptr<void> owner, Terminal terminal);
  QrCapture(citizensdk_handle_t sdk, uint64_t resource_id, uint32_t purpose,
            citizensdk_qr_capture_callbacks_v1_t callbacks, std::shared_ptr<void> owner, Terminal terminal, Factory factory);
  ~QrCapture();
  void start();
  citizensdk_error_code_t control(uint64_t operation_id, uint32_t action, uint8_t enabled);
  void request_close() noexcept;
  bool closed() const noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  void run() noexcept;
  void receive(uint64_t generation, QrFrame frame) noexcept;
  void fail(uint64_t generation, citizensdk_error_code_t code) noexcept;
};
// 有限平台解码：只用OS图像解码器和同一ZXing/Core，不创建临时目录或第二协议实现。
QrFrame decode_qr_image_pixels(citizensdk_bytes_view_t encoded);
std::vector<uint8_t> decode_qr_image_documents(citizensdk_handle_t sdk,
                                             citizensdk_bytes_view_t encoded, uint32_t purpose);
}  // namespace citizen_sdk::linux
#endif
