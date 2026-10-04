#include "citizen_sdk_qr_camera.hpp"
#include "citizen_sdk/citizen_sdk.hpp"
#include "citizensdk_qr_image.h"
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <optional>
#include <windows.h>
#include <mfapi.h>
#include <wincodec.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfcaptureengine.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl/client.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include <utility>
#include "citizen_sdk_host_record.hpp"
namespace citizen_sdk::windows {

QrFrame copy_qr_frame(const uint8_t *data, std::size_t size, uint32_t width,
                      uint32_t height, int64_t stride, bool bgrx) {
  const uint64_t pitch = stride < 0 ? static_cast<uint64_t>(-(stride + 1)) + 1
                                   : static_cast<uint64_t>(stride);
  require(data != nullptr && width > 0 && width <= 4096 && height > 0 && height <= 4096 &&
              pitch >= static_cast<uint64_t>(width) * 4 && pitch <= 64U * 1024U * 1024U &&
              size <= 64U * 1024U * 1024U &&
              static_cast<uint64_t>(height - 1) * pitch + static_cast<uint64_t>(width) * 4 <= size,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "摄像头像素边界无效");
  QrFrame result; result.width = width; result.height = height;
  const auto count = static_cast<std::size_t>(width) * height;
  result.rgba.resize(count * 4); result.luminance.resize(count);
  for (uint32_t y = 0; y < height; ++y) {
    const auto source_row = stride < 0 ? height - 1 - y : y;
    const auto *row = data + static_cast<std::size_t>(source_row) * static_cast<std::size_t>(pitch);
    for (uint32_t x = 0; x < width; ++x) {
      const auto offset = static_cast<std::size_t>(y) * width + x;
      const auto *pixel = row + static_cast<std::size_t>(x) * 4;
      auto *rgba = result.rgba.data() + offset * 4;
      rgba[0] = pixel[bgrx ? 2 : 0]; rgba[1] = pixel[1]; rgba[2] = pixel[bgrx ? 0 : 2];
      rgba[3] = bgrx ? 255 : pixel[3];
      result.luminance[offset] = static_cast<uint8_t>(
          (77U * rgba[0] + 150U * rgba[1] + 29U * rgba[2]) >> 8);
    }
  }
  return result;
}
using Microsoft::WRL::ComPtr;
namespace {
struct Samples final {
  std::mutex lock;
  std::condition_variable changed;
  ComPtr<IMFSample> sample;
  HRESULT error{S_OK};
  bool ended{};
  bool sample_ready{};
  unsigned callbacks{};
};
class ReaderCallback final : public IMFSourceReaderCallback {
 public:
  explicit ReaderCallback(std::shared_ptr<Samples> state) : state_(std::move(state)) {}
  STDMETHODIMP QueryInterface(REFIID id, void **out) override {
    if (out == nullptr) return E_POINTER;
    *out = nullptr;
    if (id == __uuidof(IUnknown) || id == __uuidof(IMFSourceReaderCallback))
      *out = static_cast<IMFSourceReaderCallback *>(this);
    else return E_NOINTERFACE;
    AddRef(); return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++references_; }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG remaining = --references_; if (remaining == 0) delete this; return remaining;
  }
  STDMETHODIMP OnReadSample(HRESULT status, DWORD, DWORD flags, LONGLONG, IMFSample *sample) override {
    std::lock_guard<std::mutex> guard(state_->lock);
    ++state_->callbacks;
    if (FAILED(status)) state_->error = status;
    if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) state_->ended = true;
    if ((flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) != 0)
      state_->error = MF_E_INVALIDMEDIATYPE;
    state_->sample_ready = true;
    state_->sample = sample;
    --state_->callbacks; state_->changed.notify_all(); return S_OK;
  }
  STDMETHODIMP OnFlush(DWORD) override { state_->changed.notify_all(); return S_OK; }
  STDMETHODIMP OnEvent(DWORD, IMFMediaEvent *event) override {
    HRESULT status = S_OK;
    if (event != nullptr && SUCCEEDED(event->GetStatus(&status)) && FAILED(status)) {
      std::lock_guard<std::mutex> guard(state_->lock);
      state_->error = status; state_->changed.notify_all();
    }
    return S_OK;
  }
 private:
  std::atomic<ULONG> references_{1};
  std::shared_ptr<Samples> state_;
};
void check(HRESULT status, const char *message) {
  require(SUCCEEDED(status), status == E_ACCESSDENIED ? CITIZENSDK_ERROR_PERMISSION_DENIED
                                                   : CITIZENSDK_ERROR_UNAVAILABLE, message);
}
}
struct QrCamera::Impl final {
  Frame frame;
  Failure failure;
  std::atomic<bool> stopping{false};
  std::shared_ptr<Samples> samples{std::make_shared<Samples>()};
  std::thread worker;
  std::mutex control_lock;
  ComPtr<IMFMediaSource> control_source;
  Impl(Frame value, Failure error) : frame(std::move(value)), failure(std::move(error)) {}
  void run() noexcept {
    bool com_started = false;
    bool media_started = false;
    ComPtr<IMFMediaSource> source;
    ComPtr<IMFSourceReader> reader;
    ComPtr<ReaderCallback> callback;
    IMFActivate **devices = nullptr;
    UINT32 count = 0;
    try {
      check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM 摄像头线程初始化失败");
      com_started = true;
      check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "Media Foundation 不可用");
      media_started = true;
      ComPtr<IMFAttributes> attributes;
      check(MFCreateAttributes(&attributes, 3), "摄像头枚举不可用");
      check(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID), "摄像头类型设置失败");
      check(MFEnumDeviceSources(attributes.Get(), &devices, &count), "无法枚举摄像头");
      require(count != 0 && devices != nullptr, CITIZENSDK_ERROR_UNAVAILABLE, "未发现可用摄像头");
      check(devices[0]->ActivateObject(IID_PPV_ARGS(&source)), "摄像头不可用，请检查 Windows 相机权限");
      { std::lock_guard<std::mutex> guard(control_lock); control_source = source; }
      callback.Attach(new ReaderCallback(samples));
      attributes.Reset();
      check(MFCreateAttributes(&attributes, 3), "摄像头读取器初始化失败");
      check(attributes->SetUnknown(MF_SOURCE_READER_ASYNC_CALLBACK, callback.Get()), "异步采集配置失败");
      check(attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE), "像素转换配置失败");
      check(MFCreateSourceReaderFromMediaSource(source.Get(), attributes.Get(), &reader), "摄像头启动被拒绝");
      ComPtr<IMFMediaType> requested;
      check(MFCreateMediaType(&requested), "像素类型创建失败");
      check(requested->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "视频格式无效");
      check(requested->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32), "RGB32 格式不可用");
      check(reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, requested.Get()),
            "摄像头不支持安全有界像素转换");
      ComPtr<IMFMediaType> actual;
      check(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &actual), "无法读取实际像素格式");
      UINT32 width = 0, height = 0;
      check(MFGetAttributeSize(actual.Get(), MF_MT_FRAME_SIZE, &width, &height), "摄像头尺寸无效");
      require(width > 0 && height > 0 && width <= 4096 && height <= 4096,
              CITIZENSDK_ERROR_INVALID_ARGUMENT, "摄像头尺寸超过上限");
      UINT32 encoded_stride = 0;
      LONG stride = 0;
      if (SUCCEEDED(actual->GetUINT32(MF_MT_DEFAULT_STRIDE, &encoded_stride))) {
        static_assert(sizeof(stride) == sizeof(encoded_stride));
        std::memcpy(&stride, &encoded_stride, sizeof(stride));
      } else check(MFGetStrideForBitmapInfoHeader(MFVideoFormat_RGB32.Data1, width, &stride),
                   "摄像头行跨度不可用");
      const auto pitch = static_cast<std::size_t>(stride < 0 ? -static_cast<int64_t>(stride) : stride);
      require(pitch >= static_cast<std::size_t>(width) * 4 && pitch <= 16 * 1024 * 1024 &&
                  pitch * height <= 64 * 1024 * 1024,
              CITIZENSDK_ERROR_INVALID_ARGUMENT, "摄像头帧跨度超过上限");
      while (!stopping.load()) {
        {
          std::lock_guard<std::mutex> guard(samples->lock); samples->sample.Reset(); samples->sample_ready = false;
          if (FAILED(samples->error) || samples->ended)
            throw HostError(CITIZENSDK_ERROR_UNAVAILABLE, "摄像头断开或读取失败");
        }
        check(reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr, nullptr, nullptr, nullptr),
              "摄像头采集请求失败");
        ComPtr<IMFSample> sample;
        {
          std::unique_lock<std::mutex> guard(samples->lock);
          if (!samples->changed.wait_for(guard, std::chrono::seconds(10), [&] {
            return stopping.load() || samples->sample_ready || FAILED(samples->error) || samples->ended;
          })) throw HostError(CITIZENSDK_ERROR_TIMEOUT, "摄像头未返回帧");
          if (stopping.load()) break;
          if (FAILED(samples->error) || samples->ended)
            throw HostError(CITIZENSDK_ERROR_UNAVAILABLE, "摄像头断开或采集失败");
          sample = std::move(samples->sample);
        }
        if (!sample) continue;
        ComPtr<IMFMediaBuffer> buffer;
        check(sample->ConvertToContiguousBuffer(&buffer), "摄像头帧缓冲读取失败");
        BYTE *data = nullptr; DWORD length = 0;
        check(buffer->Lock(&data, nullptr, &length), "摄像头帧无法映射");
        QrFrame output;
        try {
          require(data != nullptr && length >= pitch * height, CITIZENSDK_ERROR_INTEGRITY,
                  "摄像头像素缓冲被截断");
          output = copy_qr_frame(data, length, width, height, stride, true);
        } catch (...) { buffer->Unlock(); throw; }
        check(buffer->Unlock(), "摄像头帧解除映射失败");
        if (!stopping.load()) frame(std::move(output));
      }
    } catch (const HostError &error) {
      if (!stopping.load()) { try { failure(error.code(), error.what()); } catch (...) {} }
    } catch (...) {
      if (!stopping.load()) { try { failure(CITIZENSDK_ERROR_INTERNAL, "摄像头采集失败"); } catch (...) {} }
    }
    // 停止底层设备在前，释放回调引用在后；上层 stop() 只在此线程退出后完成。
    { std::lock_guard<std::mutex> guard(control_lock); control_source.Reset(); }
    if (reader) reader->Flush(MF_SOURCE_READER_ALL_STREAMS);
    if (source) source->Shutdown();
    reader.Reset(); source.Reset(); callback.Reset();
    { std::lock_guard<std::mutex> guard(samples->lock); samples->sample.Reset(); }
    if (devices != nullptr) {
      for (UINT32 index = 0; index < count; ++index) devices[index]->Release();
      CoTaskMemFree(devices);
    }
    if (media_started) MFShutdown();
    if (com_started) CoUninitialize();
  }
};
QrCamera::QrCamera(Frame frame, Failure failure)
    : impl_(std::make_unique<Impl>(std::move(frame), std::move(failure))) {
  require(impl_->frame && impl_->failure, CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集回调不能为空");
}
QrCamera::~QrCamera() { stop(); }
void QrCamera::start() {
  require(!impl_->worker.joinable(), CITIZENSDK_ERROR_INVALID_STATE, "相机已经启动");
  impl_->stopping.store(false);
  impl_->samples = std::make_shared<Samples>(); // 新一次采集不接收上一代迟到的MF回调。
  impl_->worker = std::thread([this] { impl_->run(); });
}

citizensdk_error_code_t QrCamera::set_torch(bool enabled) noexcept {
#if defined(__IMFExtendedCameraController_INTERFACE_DEFINED__) && defined(__IMFExtendedCameraControl_INTERFACE_DEFINED__)
  const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(initialized)) return CITIZENSDK_ERROR_UNAVAILABLE;
  struct ComScope { ~ComScope() { CoUninitialize(); } } com_scope;
  try {
    std::lock_guard<std::mutex> guard(impl_->control_lock);
    if (impl_->stopping.load() || !impl_->control_source) return CITIZENSDK_ERROR_NOT_READY;
    ComPtr<IMFGetService> service;
    ComPtr<IMFExtendedCameraController> controller;
    auto status = impl_->control_source.As(&service);
    if (FAILED(status)) return CITIZENSDK_ERROR_UNSUPPORTED;
    status = service->GetService(GUID_NULL, IID_PPV_ARGS(&controller));
    if (FAILED(status)) return status == E_ACCESSDENIED
        ? CITIZENSDK_ERROR_PERMISSION_DENIED : CITIZENSDK_ERROR_UNSUPPORTED;
    ComPtr<IMFExtendedCameraControl> control;
    status = controller->GetExtendedCameraControl(MF_CAPTURE_ENGINE_MEDIASOURCE,
        KSPROPERTY_CAMERACONTROL_EXTENDED_TORCHMODE, &control);
    if (FAILED(status)) return CITIZENSDK_ERROR_UNSUPPORTED;
    const auto flags = enabled ? KSCAMERA_EXTENDEDPROP_VIDEOTORCH_ON : KSCAMERA_EXTENDEDPROP_VIDEOTORCH_OFF;
    if (enabled && (control->GetCapabilities() & flags) == 0) return CITIZENSDK_ERROR_UNSUPPORTED;
    status = control->SetFlags(flags);
    if (SUCCEEDED(status)) status = control->CommitSettings();
    if (FAILED(status)) return status == E_ACCESSDENIED
        ? CITIZENSDK_ERROR_PERMISSION_DENIED : CITIZENSDK_ERROR_UNAVAILABLE;
    ComPtr<IMFExtendedCameraControl> current;
    status = controller->GetExtendedCameraControl(MF_CAPTURE_ENGINE_MEDIASOURCE,
        KSPROPERTY_CAMERACONTROL_EXTENDED_TORCHMODE, &current);
    if (FAILED(status)) return CITIZENSDK_ERROR_UNAVAILABLE;
    return current->GetFlags() == flags ? CITIZENSDK_OK : CITIZENSDK_ERROR_INTEGRITY;
  } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
#else
  (void)enabled; return CITIZENSDK_ERROR_UNSUPPORTED;
#endif
}

void QrCamera::stop() noexcept {
  impl_->stopping.store(true); impl_->samples->changed.notify_all();
  if (impl_->worker.joinable()) {
    if (impl_->worker.get_id() == std::this_thread::get_id()) std::terminate();
    impl_->worker.join();
  }
}

namespace {
citizensdk_error_code_t capture_image_error(citizensdk_qr_image_status_t code) {
  switch (code) {
    case CITIZENSDK_QR_IMAGE_NO_CODE: return CITIZENSDK_ERROR_NOT_FOUND;
    case CITIZENSDK_QR_IMAGE_LIBRARY_ERROR: return CITIZENSDK_ERROR_INTERNAL;
    default: return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
}
std::vector<uint8_t> capture_document(citizensdk_handle_t sdk, const uint8_t *bytes, std::size_t size, uint32_t purpose) {
  uint64_t required = 0;
  auto code = citizensdk_qr_parse(sdk, {bytes, size}, nullptr, 0, &required);
  require(code == CITIZENSDK_OK, code, "二维码解析失败");
  require(required > 0 && required <= 65536, CITIZENSDK_ERROR_INTEGRITY, "二维码文档大小无效");
  std::vector<uint8_t> result(static_cast<std::size_t>(required));
  const auto capacity = required;
  code = citizensdk_qr_parse(sdk, {bytes, size}, result.data(), capacity, &required);
  require(code == CITIZENSDK_OK, code, "二维码解析失败");
  require(required == capacity, CITIZENSDK_ERROR_INTEGRITY, "二维码文档复制期间变化");
  uint64_t mask = 0;
  try { mask = citizen_sdk::detail::qr_public_unsigned(std::string(result.begin(), result.end()), "scan_purpose_mask", 255); }
  catch (const citizen_sdk::Error &error) { throw HostError(error.code(), "Core二维码文档字段无效"); }
  require((mask & (UINT64_C(1) << (purpose - 1))) != 0, CITIZENSDK_ERROR_INVALID_ARGUMENT, "二维码用途不符");
  return result;
}
void validate_capture_frame(const QrFrame &frame) {
  const auto pixels = static_cast<uint64_t>(frame.width) * frame.height;
  require(frame.width > 0 && frame.width <= 4096 && frame.height > 0 && frame.height <= 4096 &&
      frame.luminance.size() == pixels && frame.rgba.size() == pixels * 4 &&
      (frame.rotation_degrees == 0 || frame.rotation_degrees == 90 ||
       frame.rotation_degrees == 180 || frame.rotation_degrees == 270),
      CITIZENSDK_ERROR_INTEGRITY, "采集帧尺寸或像素数量无效");
}
}

struct QrCapture::Impl {
  struct Command { uint64_t id; uint32_t action; bool enabled; };
  citizensdk_handle_t sdk;
  uint64_t id;
  uint32_t purpose;
  citizensdk_qr_capture_callbacks_v1_t callbacks;
  std::shared_ptr<void> owner;
  Terminal terminal;
  Factory factory;
  mutable std::mutex mutex;
  std::condition_variable changed;
  std::deque<Command> commands;
  std::optional<QrFrame> first_frame;
  Device device;
  uint64_t generation{}, last_operation{};
  uint32_t width{}, height{}, rotation{};
  citizensdk_error_code_t device_error{CITIZENSDK_OK};
  bool started{}, opened{}, closing{}, ended{}, starting{}, paused{true}, torch_on{}, retained{};
  std::optional<Command> active_command;

  Impl(citizensdk_handle_t core, uint64_t identity, uint32_t use,
       citizensdk_qr_capture_callbacks_v1_t cb, std::shared_ptr<void> lease, Terminal done, Factory make)
      : sdk(core), id(identity), purpose(use), callbacks(cb), owner(std::move(lease)),
        terminal(std::move(done)), factory(std::move(make)) {
    require(sdk != 0 && id != 0 && purpose >= 1 && purpose <= 8 && owner && terminal && factory,
        CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集资源参数无效");
    require(cb.struct_size == sizeof(cb) && cb.abi_version == CITIZENSDK_HOST_ABI_VERSION &&
        cb.opened && cb.document && cb.error && cb.control && cb.closed && cb.retain && cb.release,
        CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集回调不完整");
    callbacks.retain(callbacks.context); retained = true;
  }
  ~Impl() { if (retained) callbacks.release(callbacks.context); }
  template<class Function> void notify(Function function) noexcept {
    try { function(); }
    catch (...) { std::lock_guard<std::mutex> guard(mutex); closing = true; paused = true; changed.notify_all(); }
  }
  void stopped_device() noexcept {
    if (!device.stop) return;
    if (torch_on && device.torch) {
      const auto code = device.torch(false);
      if (code != CITIZENSDK_OK) notify([&] { callbacks.error(callbacks.context, id, code); });
    }
    torch_on = false;
    // 后端stop的合同是noexcept且真正join；不能用Future完成标记代替设备排空。
    try { device.stop(); } catch (...) { std::terminate(); }
    device = {};
  }
};

QrCapture::QrCapture(citizensdk_handle_t sdk, uint64_t id, uint32_t purpose,
                     citizensdk_qr_capture_callbacks_v1_t callbacks, std::shared_ptr<void> owner, Terminal terminal)
    : QrCapture(sdk, id, purpose, callbacks, std::move(owner), std::move(terminal),
        [](QrCamera::Frame frame, QrCamera::Failure failure) {
          auto camera = std::make_shared<QrCamera>(std::move(frame), std::move(failure));
          return Device{[camera] { camera->start(); }, [camera] { camera->stop(); },
                        [camera](bool enabled) { return camera->set_torch(enabled); }};
        }) {}
QrCapture::QrCapture(citizensdk_handle_t sdk, uint64_t id, uint32_t purpose,
                     citizensdk_qr_capture_callbacks_v1_t callbacks, std::shared_ptr<void> owner, Terminal terminal, Factory factory)
    : impl_(std::make_unique<Impl>(sdk, id, purpose, callbacks, std::move(owner), std::move(terminal), std::move(factory))) {}
QrCapture::~QrCapture() = default;

void QrCapture::start() {
  std::lock_guard<std::mutex> guard(impl_->mutex);
  require(!impl_->started, CITIZENSDK_ERROR_INVALID_STATE, "采集资源已经启动");
  auto self = shared_from_this();
  // 这是随采集结束的有限设备工作线程，不是第二个后台监督器。
  std::thread worker([self] { self->run(); });
  impl_->started = true;
  worker.detach();
}
citizensdk_error_code_t QrCapture::control(uint64_t operation_id, uint32_t action, uint8_t enabled) {
  std::lock_guard<std::mutex> guard(impl_->mutex);
  if (operation_id == 0 || action < 1 || action > 4 || enabled > 1 || (action != 3 && enabled != 0))
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  if (impl_->ended) return CITIZENSDK_ERROR_NOT_FOUND;
  if (operation_id <= impl_->last_operation) return CITIZENSDK_ERROR_CONFLICT;
  if (action != 4 && impl_->closing) return CITIZENSDK_ERROR_CANCELLED;
  if (action != 4 && !impl_->opened) return CITIZENSDK_ERROR_NOT_READY;
  if (action != 4 && impl_->commands.size() + (impl_->active_command ? 1U : 0U) >= 64) return CITIZENSDK_ERROR_QUEUE_FULL;
  if (action == 4) { impl_->closing = true; impl_->paused = true; }
  else {
    impl_->commands.push_back({operation_id, action, enabled != 0});
    if (action == 1) impl_->paused = true; // 接纳暂停后不再开始新的公开交付。
  }
  impl_->last_operation = operation_id;
  impl_->changed.notify_all();
  return CITIZENSDK_OK;
}
void QrCapture::request_close() noexcept {
  std::lock_guard<std::mutex> guard(impl_->mutex);
  impl_->closing = true; impl_->paused = true; impl_->changed.notify_all();
}
bool QrCapture::closed() const noexcept {
  std::lock_guard<std::mutex> guard(impl_->mutex); return impl_->ended;
}
void QrCapture::fail(uint64_t generation, citizensdk_error_code_t code) noexcept {
  std::lock_guard<std::mutex> guard(impl_->mutex);
  if (impl_->ended || generation != impl_->generation) return;
  impl_->device_error = code == CITIZENSDK_OK ? CITIZENSDK_ERROR_INTEGRITY : code;
  impl_->closing = true; impl_->paused = true; impl_->changed.notify_all();
}
void QrCapture::receive(uint64_t generation, QrFrame frame) noexcept {
  try { validate_capture_frame(frame); }
  catch (...) { fail(generation, CITIZENSDK_ERROR_INTEGRITY); return; }
  try {
    {
      std::lock_guard<std::mutex> guard(impl_->mutex);
      if (impl_->closing || impl_->ended || generation != impl_->generation) return;
      if (impl_->width != 0) {
        if (frame.width != impl_->width || frame.height != impl_->height || frame.rotation_degrees != impl_->rotation) {
          impl_->device_error = CITIZENSDK_ERROR_INTEGRITY;
          impl_->closing = true; impl_->paused = true; impl_->changed.notify_all(); return;
        }
      }
      if (impl_->starting) {
        if (!impl_->first_frame) impl_->first_frame = std::move(frame);
        impl_->changed.notify_all(); return;
      }
      if (impl_->paused) return;
    }
    const citizensdk_qr_frame_v1_t value{sizeof(citizensdk_qr_frame_v1_t), CITIZENSDK_HOST_ABI_VERSION,
        frame.width, frame.height, frame.rotation_degrees, 0, generation,
        {frame.rgba.data(), frame.rgba.size()}, {frame.luminance.data(), frame.luminance.size()}};
    if (impl_->callbacks.frame) impl_->notify([&] { impl_->callbacks.frame(impl_->callbacks.context, impl_->id, &value); });
    {
      std::lock_guard<std::mutex> guard(impl_->mutex);
      if (impl_->closing || impl_->paused || generation != impl_->generation) return;
    }
    size_t required = 0;
    auto status = citizensdk_qr_image_decode_luminance(frame.luminance.data(), frame.luminance.size(),
        frame.width, frame.height, frame.width, nullptr, 0, &required);
    if (status == CITIZENSDK_QR_IMAGE_NO_CODE) return;
    require(status == CITIZENSDK_QR_IMAGE_OK || status == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL,
        capture_image_error(status), "二维码图像识别失败");
    require(required > 0 && required <= 2331, CITIZENSDK_ERROR_INTEGRITY, "二维码图像结果大小无效");
    std::vector<uint8_t> text(required);
    status = citizensdk_qr_image_decode_luminance(frame.luminance.data(), frame.luminance.size(),
        frame.width, frame.height, frame.width, text.data(), text.size(), &required);
    require(status == CITIZENSDK_QR_IMAGE_OK, capture_image_error(status), "二维码图像复制失败");
    require(required == text.size(), CITIZENSDK_ERROR_INTEGRITY, "二维码图像复制大小变化");
    const auto document = capture_document(impl_->sdk, text.data(), text.size(), impl_->purpose);
    {
      std::lock_guard<std::mutex> guard(impl_->mutex);
      if (impl_->closing || impl_->paused || generation != impl_->generation) return;
    }
    impl_->notify([&] { impl_->callbacks.document(impl_->callbacks.context, impl_->id, generation, {document.data(), document.size()}); });
  } catch (const HostError &error) {
    bool deliver = false;
    { std::lock_guard<std::mutex> guard(impl_->mutex); deliver = !impl_->closing && !impl_->paused && generation == impl_->generation; }
    if (deliver) impl_->notify([&] { impl_->callbacks.error(impl_->callbacks.context, impl_->id, error.code()); });
  } catch (const citizen_sdk::Error &error) {
    bool deliver = false;
    { std::lock_guard<std::mutex> guard(impl_->mutex); deliver = !impl_->closing && !impl_->paused && generation == impl_->generation; }
    if (deliver) impl_->notify([&] { impl_->callbacks.error(impl_->callbacks.context, impl_->id, error.code()); });
  } catch (...) { fail(generation, CITIZENSDK_ERROR_INTERNAL); }
}

void QrCapture::run() noexcept {
  auto &state = *impl_;
  const auto start_device = [&](bool opening) -> std::optional<QrFrame> {
    uint64_t generation = 0;
    {
      std::lock_guard<std::mutex> guard(state.mutex);
      if (state.closing) return {};
      if (!opening && std::any_of(state.commands.begin(), state.commands.end(),
          [](const Impl::Command &command) { return command.action == 1; })) return {};
      require(state.generation != UINT64_MAX, CITIZENSDK_ERROR_UNAVAILABLE, "采集代际耗尽");
      generation = ++state.generation; state.starting = true;
      state.paused = false; state.first_frame.reset();
    }
    std::weak_ptr<QrCapture> weak = shared_from_this();
    state.device = state.factory(
        [weak, generation](QrFrame frame) { if (auto self = weak.lock()) self->receive(generation, std::move(frame)); },
        [weak, generation](citizensdk_error_code_t code, std::string) { if (auto self = weak.lock()) self->fail(generation, code); });
    require(state.device.start && state.device.stop && state.device.torch, CITIZENSDK_ERROR_INTEGRITY, "采集后端不完整");
    state.device.start();
    std::unique_lock<std::mutex> guard(state.mutex);
    state.changed.wait(guard, [&] { return state.first_frame.has_value() || state.closing || (!opening && state.paused); });
    auto frame = std::move(state.first_frame); state.first_frame.reset();
    if (opening) state.paused = true;
    state.starting = false;
    return frame;
  };
  try {
    auto first = start_device(true);
    { std::lock_guard<std::mutex> guard(state.mutex); state.paused = true; }
    state.stopped_device(); // 初始资源暂停；opened只承接已取得的真实尺寸。
    bool publish = false;
    { std::lock_guard<std::mutex> guard(state.mutex); publish = first.has_value() && !state.closing; state.opened = publish;
      if (publish) { state.width = first->width; state.height = first->height; state.rotation = first->rotation_degrees; } }
    if (publish) {
      state.notify([&] { state.callbacks.opened(state.callbacks.context, state.id, CITIZENSDK_OK,
          first->width, first->height, first->rotation_degrees); });
      bool preview = false;
      { std::lock_guard<std::mutex> guard(state.mutex); preview = !state.closing; }
      if (preview && state.callbacks.frame) {
        const citizensdk_qr_frame_v1_t frame{sizeof(citizensdk_qr_frame_v1_t), CITIZENSDK_HOST_ABI_VERSION,
          first->width, first->height, first->rotation_degrees, 0, state.generation,
          {first->rgba.data(), first->rgba.size()}, {first->luminance.data(), first->luminance.size()}};
        state.notify([&] { state.callbacks.frame(state.callbacks.context, state.id, &frame); });
      }
    }
    for (;;) {
      Impl::Command command{};
      {
        std::unique_lock<std::mutex> guard(state.mutex);
        state.changed.wait(guard, [&] { return state.closing || !state.commands.empty(); });
        if (state.closing) break;
        command = state.commands.front(); state.commands.pop_front(); state.active_command = command;
      }
      citizensdk_error_code_t code = CITIZENSDK_OK;
      if (command.action == 1) {
        { std::lock_guard<std::mutex> guard(state.mutex); state.paused = true; }
        state.stopped_device();
      } else if (command.action == 2) {
        bool active = false;
        { std::lock_guard<std::mutex> guard(state.mutex); active = !state.paused && static_cast<bool>(state.device.stop); }
        if (!active) {
          auto frame = start_device(false);
          bool running = false;
          { std::lock_guard<std::mutex> guard(state.mutex); running = frame.has_value() && !state.closing && !state.paused; }
          if (!running) {
            state.stopped_device();
            std::lock_guard<std::mutex> guard(state.mutex);
            code = state.device_error == CITIZENSDK_OK ? CITIZENSDK_ERROR_CANCELLED : state.device_error;
          }
          // 首帧由后续正常帧持续发布；不在worker内并行调用receive形成第二帧处理线程。
        }
      } else if (command.action == 3) {
        code = state.device.torch ? state.device.torch(command.enabled) : CITIZENSDK_ERROR_NOT_READY;
        if (code == CITIZENSDK_OK) state.torch_on = command.enabled;
      }
      state.notify([&] { state.callbacks.control(state.callbacks.context, state.id, command.id, code); });
      { std::lock_guard<std::mutex> guard(state.mutex); state.active_command.reset(); }
    }
  } catch (const HostError &error) {
    std::lock_guard<std::mutex> guard(state.mutex); state.device_error = error.code(); state.closing = true; state.paused = true;
  } catch (...) {
    std::lock_guard<std::mutex> guard(state.mutex); state.device_error = CITIZENSDK_ERROR_INTERNAL; state.closing = true; state.paused = true;
  }
  state.stopped_device();
  std::deque<Impl::Command> cancelled;
  std::optional<Impl::Command> interrupted;
  citizensdk_error_code_t terminal_code = CITIZENSDK_OK;
  bool opened = false;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    cancelled.swap(state.commands); interrupted = std::move(state.active_command); state.active_command.reset();
    terminal_code = state.device_error; opened = state.opened;
    state.ended = true; state.first_frame.reset();
  }
  if (!opened) state.notify([&] { state.callbacks.opened(state.callbacks.context, state.id,
      terminal_code == CITIZENSDK_OK ? CITIZENSDK_ERROR_CANCELLED : terminal_code, 0, 0, 0); });
  if (interrupted) state.notify([&] { state.callbacks.control(state.callbacks.context, state.id, interrupted->id,
      terminal_code == CITIZENSDK_OK ? CITIZENSDK_ERROR_CANCELLED : terminal_code); });
  for (const auto &command : cancelled)
    state.notify([&] { state.callbacks.control(state.callbacks.context, state.id, command.id, CITIZENSDK_ERROR_CANCELLED); });
  if (terminal_code != CITIZENSDK_OK) state.notify([&] { state.callbacks.error(state.callbacks.context, state.id, terminal_code); });
  state.notify([&] { state.callbacks.closed(state.callbacks.context, state.id, terminal_code); });
  // 先移出Host表并归还服务租约，再执行最后context.release；此后不再访问Core/Host。
  try { state.terminal(state.id); } catch (...) { std::terminate(); }
  state.terminal = {}; state.owner.reset();
  if (state.retained) { state.retained = false; state.callbacks.release(state.callbacks.context); }
}

QrFrame decode_qr_image_pixels(citizensdk_bytes_view_t encoded) {
  require(encoded.data && encoded.len > 0 && encoded.len <= 16U * 1024U * 1024U,
      CITIZENSDK_ERROR_INVALID_ARGUMENT, "图片输入长度无效");
  const auto apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  require(SUCCEEDED(apartment) || apartment == RPC_E_CHANGED_MODE, CITIZENSDK_ERROR_UNAVAILABLE, "图像COM环境不可用");
  struct Apartment { bool owned; ~Apartment() { if (owned) CoUninitialize(); } } lease{SUCCEEDED(apartment)};
  const auto check_image = [](HRESULT code) {
    require(SUCCEEDED(code), code == WINCODEC_ERR_COMPONENTNOTFOUND || code == WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT
        ? CITIZENSDK_ERROR_UNSUPPORTED : CITIZENSDK_ERROR_DECODE, "系统图片解码失败");
  };
  // 输入副本比所有WIC对象更早声明，保证其最后销毁，禁止流引用先悬空。
  std::vector<uint8_t> input(encoded.data, encoded.data + static_cast<std::size_t>(encoded.len));
  Microsoft::WRL::ComPtr<IWICImagingFactory> factory;
  check_image(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
  Microsoft::WRL::ComPtr<IWICStream> stream;
  check_image(factory->CreateStream(&stream));
  check_image(stream->InitializeFromMemory(input.data(), static_cast<DWORD>(input.size())));
  Microsoft::WRL::ComPtr<IWICBitmapDecoder> decoder;
  check_image(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder));
  Microsoft::WRL::ComPtr<IWICBitmapFrameDecode> source;
  check_image(decoder->GetFrame(0, &source));
  UINT width = 0, height = 0;
  check_image(source->GetSize(&width, &height));
  require(width > 0 && width <= 4096 && height > 0 && height <= 4096,
      CITIZENSDK_ERROR_INVALID_ARGUMENT, "图片尺寸超过上限");
  Microsoft::WRL::ComPtr<IWICFormatConverter> converter;
  check_image(factory->CreateFormatConverter(&converter));
  check_image(converter->Initialize(source.Get(), GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone,
                                   nullptr, 0.0, WICBitmapPaletteTypeCustom));
  const auto length = static_cast<std::size_t>(width) * height * 4;
  std::vector<uint8_t> rgba(length);
  check_image(converter->CopyPixels(nullptr, width * 4, static_cast<UINT>(length), rgba.data()));
  return copy_qr_frame(rgba.data(), rgba.size(), width, height, static_cast<int64_t>(width) * 4, false);
}

std::vector<uint8_t> decode_qr_image_documents(citizensdk_handle_t sdk,
                                              citizensdk_bytes_view_t encoded, uint32_t purpose) {
  require(sdk != 0 && purpose >= 1 && purpose <= 8, CITIZENSDK_ERROR_INVALID_ARGUMENT, "图像用途无效");
  auto frame = decode_qr_image_pixels(encoded);
  validate_capture_frame(frame);
  size_t required = 0;
  auto code = citizensdk_qr_image_decode_luminance_all(frame.luminance.data(), frame.luminance.size(),
      frame.width, frame.height, frame.width, nullptr, 0, &required);
  if (code == CITIZENSDK_QR_IMAGE_NO_CODE) return std::vector<uint8_t>(4, 0);
  require(code == CITIZENSDK_QR_IMAGE_OK || code == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL,
      capture_image_error(code), "图片二维码识别失败");
  require(required >= 4 && required <= 4 + 64 * (4 + 2331), CITIZENSDK_ERROR_INTEGRITY, "多码结果超过上限");
  std::vector<uint8_t> packet(required);
  code = citizensdk_qr_image_decode_luminance_all(frame.luminance.data(), frame.luminance.size(),
      frame.width, frame.height, frame.width, packet.data(), packet.size(), &required);
  require(code == CITIZENSDK_QR_IMAGE_OK, capture_image_error(code), "多码复制失败");
  require(required == packet.size(), CITIZENSDK_ERROR_INTEGRITY, "多码复制大小变化");
  std::size_t offset = 0;
  const auto read_u32 = [&]() {
    require(packet.size() - offset >= 4, CITIZENSDK_ERROR_INTEGRITY, "多码长度被截断");
    const uint32_t value = static_cast<uint32_t>(packet[offset]) |
        (static_cast<uint32_t>(packet[offset + 1]) << 8) | (static_cast<uint32_t>(packet[offset + 2]) << 16) |
        (static_cast<uint32_t>(packet[offset + 3]) << 24);
    offset += 4; return value;
  };
  const auto count = read_u32();
  require(count <= 64, CITIZENSDK_ERROR_INTEGRITY, "多码数量超过上限");
  std::vector<uint8_t> output;
  const auto append_u32 = [&](uint32_t value) {
    for (unsigned shift = 0; shift < 32; shift += 8) output.push_back(static_cast<uint8_t>(value >> shift));
  };
  append_u32(count);
  for (uint32_t index = 0; index < count; ++index) {
    const auto length = read_u32();
    require(length > 0 && length <= 2331 && packet.size() - offset >= length,
        CITIZENSDK_ERROR_INTEGRITY, "多码文本大小无效");
    const auto document = capture_document(sdk, packet.data() + offset, length, purpose);
    offset += length;
    append_u32(static_cast<uint32_t>(document.size()));
    output.insert(output.end(), document.begin(), document.end());
  }
  require(offset == packet.size() && output.size() <= 4U * 1024U * 1024U + 260,
      CITIZENSDK_ERROR_INTEGRITY, "多码结果闭集无效");
  return output;
}
}  // namespace citizen_sdk::windows
