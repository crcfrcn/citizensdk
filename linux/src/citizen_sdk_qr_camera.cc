#include "citizen_sdk_qr_camera.hpp"
#include "citizen_sdk/citizen_sdk.hpp"
#include "citizensdk_qr_image.h"
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <optional>
#include <atomic>
#include <cstring>
#include <cerrno>
#include <chrono>
#include <mutex>
#include <sys/ioctl.h>
#include <linux/videodev2.h>
#include <thread>
#include <utility>
#include "citizen_sdk_host_record.hpp"
#if CITIZENSDK_ENABLE_QR_CAPTURE
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <gst/app/gstappsink.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#endif
namespace citizen_sdk::linux {

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
struct QrCamera::Impl final {
  Frame frame;
  Failure failure;
  std::atomic<bool> stopping{false};
  std::thread worker;
  std::mutex control_lock;
#if CITIZENSDK_ENABLE_QR_CAPTURE
  GstElement *control_source{}; // 由采集线程持有；控制锁覆盖借用及退役。
#endif
  Impl(Frame value, Failure error) : frame(std::move(value)), failure(std::move(error)) {}
  void run() noexcept {
#if CITIZENSDK_ENABLE_QR_CAPTURE
    GstDeviceMonitor *monitor = nullptr;
    GstElement *pipeline = nullptr;
    GstBus *bus = nullptr;
    GList *devices = nullptr;
    try {
      GError *error = nullptr;
      if (!gst_init_check(nullptr, nullptr, &error)) {
        if (error != nullptr) g_error_free(error);
        throw HostError(CITIZENSDK_ERROR_UNAVAILABLE, "GStreamer 摄像头运行环境不可用");
      }
      monitor = gst_device_monitor_new();
      require(monitor != nullptr, CITIZENSDK_ERROR_UNAVAILABLE, "摄像头枚举不可用");
      GstCaps *filter = gst_caps_from_string("video/x-raw");
      const guint filter_id = gst_device_monitor_add_filter(monitor, "Video/Source", filter);
      gst_caps_unref(filter);
      require(filter_id != 0 && gst_device_monitor_start(monitor),
              CITIZENSDK_ERROR_UNAVAILABLE, "无法枚举摄像头，请检查设备与权限");
      devices = gst_device_monitor_get_devices(monitor);
      require(devices != nullptr, CITIZENSDK_ERROR_UNAVAILABLE, "未发现可用摄像头");
      pipeline = gst_pipeline_new(nullptr);
      require(pipeline != nullptr, CITIZENSDK_ERROR_UNAVAILABLE, "无法创建摄像头管线");
      GstElement *source = gst_device_create_element(GST_DEVICE(devices->data), nullptr);
      require(source != nullptr, CITIZENSDK_ERROR_UNAVAILABLE, "无法打开摄像头，请检查设备权限");
      gst_bin_add(GST_BIN(pipeline), source);
      { std::lock_guard<std::mutex> guard(control_lock); control_source = source; }
      auto add = [&](const char *factory) {
        GstElement *element = gst_element_factory_make(factory, nullptr);
        require(element != nullptr, CITIZENSDK_ERROR_UNAVAILABLE, "缺少正式 GStreamer 采集组件");
        gst_bin_add(GST_BIN(pipeline), element);
        return element;
      };
      GstElement *convert = add("videoconvert");
      GstElement *scale = add("videoscale");
      GstElement *caps_filter = add("capsfilter");
      GstElement *sink = add("appsink");
      GstCaps *caps = gst_caps_from_string("video/x-raw,format=RGBA,width=640,height=480");
      g_object_set(caps_filter, "caps", caps, nullptr);
      gst_caps_unref(caps);
      g_object_set(sink, "max-buffers", 1U, "drop", TRUE, "sync", FALSE, nullptr);
      require(gst_element_link_many(source, convert, scale, caps_filter, sink, nullptr),
              CITIZENSDK_ERROR_UNAVAILABLE, "摄像头像素格式无法转换");
      bus = gst_element_get_bus(pipeline);
      require(bus != nullptr &&
                  gst_element_set_state(pipeline, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE,
              CITIZENSDK_ERROR_UNAVAILABLE, "摄像头启动被拒绝");
      auto last_frame = std::chrono::steady_clock::now();
      while (!stopping.load()) {
        GstMessage *message = gst_bus_pop_filtered(bus,
            static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_EOS));
        if (message != nullptr) {
          gst_message_unref(message);
          throw HostError(CITIZENSDK_ERROR_UNAVAILABLE, "摄像头断开或采集失败");
        }
        GstSample *sample = gst_app_sink_try_pull_sample(GST_APP_SINK(sink), 50 * GST_MSECOND);
        if (sample == nullptr) {
          if (std::chrono::steady_clock::now() - last_frame > std::chrono::seconds(10))
            throw HostError(CITIZENSDK_ERROR_TIMEOUT, "摄像头未返回帧");
          continue;
        }
        last_frame = std::chrono::steady_clock::now();
        GstVideoInfo info{};
        GstVideoFrame video{};
        GstCaps *sample_caps = gst_sample_get_caps(sample);
        GstBuffer *buffer = gst_sample_get_buffer(sample);
        const bool valid = sample_caps != nullptr && buffer != nullptr &&
            gst_video_info_from_caps(&info, sample_caps) &&
            GST_VIDEO_INFO_FORMAT(&info) == GST_VIDEO_FORMAT_RGBA &&
            GST_VIDEO_INFO_WIDTH(&info) > 0 && GST_VIDEO_INFO_WIDTH(&info) <= 4096 &&
            GST_VIDEO_INFO_HEIGHT(&info) > 0 && GST_VIDEO_INFO_HEIGHT(&info) <= 4096 &&
            gst_video_frame_map(&video, &info, buffer, GST_MAP_READ);
        if (!valid) {
          gst_sample_unref(sample);
          throw HostError(CITIZENSDK_ERROR_INTEGRITY, "摄像头返回无效亮度帧");
        }
        QrFrame output;
        const gint stride = GST_VIDEO_FRAME_PLANE_STRIDE(&video, 0);
        const auto width = GST_VIDEO_INFO_WIDTH(&info);
        const auto height = GST_VIDEO_INFO_HEIGHT(&info);
        if (stride < width * 4) {
          gst_video_frame_unmap(&video); gst_sample_unref(sample);
          throw HostError(CITIZENSDK_ERROR_INTEGRITY, "摄像头行跨度无效");
        }
        try {
          const auto *pixels = static_cast<const uint8_t *>(GST_VIDEO_FRAME_PLANE_DATA(&video, 0));
          const auto base = reinterpret_cast<uintptr_t>(video.map[0].data);
          const auto address = reinterpret_cast<uintptr_t>(pixels);
          require(pixels != nullptr && address >= base && address - base <= video.map[0].size,
                  CITIZENSDK_ERROR_INTEGRITY, "摄像头像素映射无效");
          output = copy_qr_frame(pixels, video.map[0].size - static_cast<std::size_t>(address - base),
              static_cast<uint32_t>(width), static_cast<uint32_t>(height), stride, false);
        } catch (...) {
          gst_video_frame_unmap(&video); gst_sample_unref(sample); throw;
        }
        gst_video_frame_unmap(&video); gst_sample_unref(sample);
        if (!stopping.load()) frame(std::move(output));
      }
    } catch (const HostError &error) {
      if (!stopping.load()) { try { failure(error.code(), error.what()); } catch (...) {} }
    } catch (...) {
      if (!stopping.load()) { try { failure(CITIZENSDK_ERROR_INTERNAL, "摄像头采集失败"); } catch (...) {} }
    }
    { std::lock_guard<std::mutex> guard(control_lock); control_source = nullptr; }
    if (pipeline != nullptr) gst_element_set_state(pipeline, GST_STATE_NULL);
    if (bus != nullptr) gst_object_unref(bus);
    if (pipeline != nullptr) gst_object_unref(pipeline);
    if (devices != nullptr) g_list_free_full(devices, g_object_unref);
    if (monitor != nullptr) { gst_device_monitor_stop(monitor); gst_object_unref(monitor); }
#else
    try { failure(CITIZENSDK_ERROR_UNSUPPORTED, "此构建未启用GStreamer摄像采集"); } catch (...) {}
#endif
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
  impl_->worker = std::thread([this] { impl_->run(); });
}

citizensdk_error_code_t QrCamera::set_torch(bool enabled) noexcept {
#if CITIZENSDK_ENABLE_QR_CAPTURE
  try {
    std::lock_guard<std::mutex> guard(impl_->control_lock);
    if (impl_->stopping.load() || !impl_->control_source) return CITIZENSDK_ERROR_NOT_READY;
    auto *object = G_OBJECT(impl_->control_source);
    const auto *property = g_object_class_find_property(G_OBJECT_GET_CLASS(object), "device-fd");
    if (!property || !G_IS_PARAM_SPEC_INT(property)) return CITIZENSDK_ERROR_UNSUPPORTED;
    gint descriptor = -1;
    g_object_get(object, "device-fd", &descriptor, nullptr);
    if (descriptor < 0) return CITIZENSDK_ERROR_NOT_READY;
    const auto failure = [] {
      return errno == EACCES || errno == EPERM ? CITIZENSDK_ERROR_PERMISSION_DENIED
          : errno == EINVAL || errno == ENOTTY ? CITIZENSDK_ERROR_UNSUPPORTED
          : errno == EBUSY ? CITIZENSDK_ERROR_BUSY : CITIZENSDK_ERROR_UNAVAILABLE;
    };
    v4l2_queryctrl query{}; query.id = V4L2_CID_FLASH_LED_MODE;
    if (ioctl(descriptor, VIDIOC_QUERYCTRL, &query) < 0) return failure();
    if ((query.flags & V4L2_CTRL_FLAG_DISABLED) != 0) return CITIZENSDK_ERROR_UNSUPPORTED;
    v4l2_control control{}; control.id = V4L2_CID_FLASH_LED_MODE;
    control.value = enabled ? V4L2_FLASH_LED_MODE_TORCH : V4L2_FLASH_LED_MODE_NONE;
    if (ioctl(descriptor, VIDIOC_S_CTRL, &control) < 0) return failure();
    control.value = -1;
    if (ioctl(descriptor, VIDIOC_G_CTRL, &control) < 0) return failure();
    return control.value == (enabled ? V4L2_FLASH_LED_MODE_TORCH : V4L2_FLASH_LED_MODE_NONE)
        ? CITIZENSDK_OK : CITIZENSDK_ERROR_INTEGRITY;
  } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
#else
  (void)enabled; return CITIZENSDK_ERROR_UNSUPPORTED;
#endif
}

void QrCamera::stop() noexcept {
  impl_->stopping.store(true);
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
#if CITIZENSDK_ENABLE_QR_CAPTURE
  const bool png = encoded.len >= 8 && std::memcmp(encoded.data, "\x89PNG\r\n\x1a\n", 8) == 0;
  const bool jpeg = encoded.len >= 2 && encoded.data[0] == 0xff && encoded.data[1] == 0xd8;
  const bool bmp = encoded.len >= 2 && encoded.data[0] == 'B' && encoded.data[1] == 'M';
  require(png || jpeg || bmp, CITIZENSDK_ERROR_UNSUPPORTED, "此平台不支持该图片格式");
  if (png) {
    // 只排除动画容器，不实现PNG解码；像素/格式/尺寸仍交唯一系统解码器。
    std::size_t offset = 8;
    while (encoded.len - offset >= 12) {
      const uint64_t length = (static_cast<uint64_t>(encoded.data[offset]) << 24) |
          (static_cast<uint64_t>(encoded.data[offset + 1]) << 16) |
          (static_cast<uint64_t>(encoded.data[offset + 2]) << 8) | encoded.data[offset + 3];
      require(length <= encoded.len - offset - 12, CITIZENSDK_ERROR_DECODE, "图片块被截断");
      require(std::memcmp(encoded.data + offset + 4, "acTL", 4) != 0, CITIZENSDK_ERROR_UNSUPPORTED, "此平台不支持动画图片");
      offset += static_cast<std::size_t>(length) + 12;
    }
  }
  // 匿名内存描述符供系统尺寸探测使用，不落盘、不创建产品或缓存目录；先封存再解码。
  struct Descriptor { int value{-1}; ~Descriptor() { if (value >= 0) ::close(value); } } descriptor;
  descriptor.value = memfd_create("citizensdk-image", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  require(descriptor.value >= 0, errno == ENOSYS ? CITIZENSDK_ERROR_UNSUPPORTED : CITIZENSDK_ERROR_UNAVAILABLE,
      "图片内存描述符不可用");
  std::size_t offset = 0;
  while (offset < encoded.len) {
    const auto written = ::write(descriptor.value, encoded.data + offset, static_cast<std::size_t>(encoded.len) - offset);
    if (written < 0 && errno == EINTR) continue;
    require(written > 0, CITIZENSDK_ERROR_UNAVAILABLE, "图片内存写入失败");
    offset += static_cast<std::size_t>(written);
  }
  require(fcntl(descriptor.value, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL) == 0,
      CITIZENSDK_ERROR_UNAVAILABLE, "图片输入无法封存");
  const auto path = std::string("/proc/self/fd/") + std::to_string(descriptor.value);
  gint width = 0, height = 0;
  auto *format = gdk_pixbuf_get_file_info(path.c_str(), &width, &height);
  require(format && width > 0 && width <= 4096 && height > 0 && height <= 4096,
      CITIZENSDK_ERROR_DECODE, "图片尺寸无效或超过上限");
  gchar *format_name = gdk_pixbuf_format_get_name(format);
  const bool supported = format_name && (std::strcmp(format_name, "png") == 0 ||
      std::strcmp(format_name, "jpeg") == 0 || std::strcmp(format_name, "bmp") == 0);
  g_free(format_name);
  require(supported, CITIZENSDK_ERROR_UNSUPPORTED, "系统识别出不支持的图片格式");
  struct Pixbuf { GdkPixbuf *value{}; ~Pixbuf() { if (value) g_object_unref(value); } } pixels;
  GError *error = nullptr;
  pixels.value = gdk_pixbuf_new_from_file(path.c_str(), &error);
  const bool failed = error != nullptr;
  if (error) g_error_free(error); // 不回传可能带原始输入/路径的系统错误文本。
  require(pixels.value != nullptr && !failed, CITIZENSDK_ERROR_DECODE, "系统图片解码失败");
  require(gdk_pixbuf_get_width(pixels.value) == width && gdk_pixbuf_get_height(pixels.value) == height &&
      gdk_pixbuf_get_bits_per_sample(pixels.value) == 8 &&
      gdk_pixbuf_get_colorspace(pixels.value) == GDK_COLORSPACE_RGB,
      CITIZENSDK_ERROR_INTEGRITY, "图片解码事实与尺寸探测不一致");
  const gint channels = gdk_pixbuf_get_n_channels(pixels.value), stride = gdk_pixbuf_get_rowstride(pixels.value);
  const auto *data = gdk_pixbuf_read_pixels(pixels.value);
  const auto length = gdk_pixbuf_get_byte_length(pixels.value);
  require(data && (channels == 3 || channels == 4) && stride >= width * channels &&
      static_cast<uint64_t>(height - 1) * static_cast<uint64_t>(stride) +
          static_cast<uint64_t>(width * channels) <= length,
      CITIZENSDK_ERROR_INTEGRITY, "系统图片缓冲被截断");
  QrFrame frame; frame.width = static_cast<uint32_t>(width); frame.height = static_cast<uint32_t>(height);
  const auto count = static_cast<std::size_t>(width) * static_cast<std::size_t>(height);
  frame.rgba.resize(count * 4); frame.luminance.resize(count);
  for (gint y = 0; y < height; ++y) for (gint x = 0; x < width; ++x) {
    const auto *pixel = data + static_cast<std::size_t>(y) * static_cast<std::size_t>(stride) +
        static_cast<std::size_t>(x) * static_cast<std::size_t>(channels);
    const auto index = static_cast<std::size_t>(y) * static_cast<std::size_t>(width) + static_cast<std::size_t>(x);
    frame.rgba[index * 4] = pixel[0]; frame.rgba[index * 4 + 1] = pixel[1]; frame.rgba[index * 4 + 2] = pixel[2];
    frame.rgba[index * 4 + 3] = channels == 4 ? pixel[3] : 255;
    frame.luminance[index] = static_cast<uint8_t>((77U * pixel[0] + 150U * pixel[1] + 29U * pixel[2]) >> 8);
  }
  return frame;
#else
  (void)encoded;
  throw HostError(CITIZENSDK_ERROR_UNSUPPORTED, "此构建未启用系统图片解码");
#endif
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
}  // namespace citizen_sdk::linux
