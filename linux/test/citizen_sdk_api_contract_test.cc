// 冻结 Linux Host 自有薄 ABI；根产品 ABI 仍是唯一 Core 合同。
#include <cassert>
#include <algorithm>
#include <vector>
#include "citizen_sdk_qr_camera.hpp"
#include <functional>
#include <memory>
#include "citizen_sdk_host_record.hpp"
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <regex>
#include <set>
#include <string>
#include <type_traits>

#include "citizen_sdk/citizensdk_host.h"
#include "citizen_sdk/citizen_sdk.hpp"
#include "citizen_sdk_test_support.hpp"

#ifndef CITIZENSDK_LINUX_TEST_SOURCE_DIR
#error "CITIZENSDK_LINUX_TEST_SOURCE_DIR must point at the Linux source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif


namespace {
struct CaptureProbe {
  std::mutex mutex;
  std::condition_variable changed;
  std::weak_ptr<void> owner;
  int retained{}, released{}, opened{}, closed{}, frames{}, stops{}, terminals{};
  uint32_t width{}, height{};
  citizensdk_error_code_t open_code{}, close_code{};
  std::vector<std::pair<uint64_t, citizensdk_error_code_t>> controls;
  std::vector<bool> torches;
  std::vector<citizen_sdk::linux::QrCamera::Frame> frame_callbacks;
  bool emit_first{true}, malformed{}, deny{}, block_stop{}, unblock_stop{}, block_torch{}, unblock_torch{};
  int torch_entries{};
  void wait(const std::function<bool()> &predicate) {
    std::unique_lock<std::mutex> guard(mutex);
    assert(changed.wait_for(guard, std::chrono::seconds(5), predicate));
  }
  citizensdk_qr_capture_callbacks_v1_t callbacks() {
    return {sizeof(citizensdk_qr_capture_callbacks_v1_t), CITIZENSDK_HOST_ABI_VERSION, this,
      +[](void *raw, uint64_t id, citizensdk_error_code_t code, uint32_t w, uint32_t h, uint32_t rotation) {
        auto &p = *static_cast<CaptureProbe *>(raw); std::lock_guard<std::mutex> guard(p.mutex);
        assert(id == 1 && rotation == 0); ++p.opened; p.open_code = code; p.width = w; p.height = h; p.changed.notify_all();
      },
      +[](void *raw, uint64_t id, const citizensdk_qr_frame_v1_t *frame) {
        auto &p = *static_cast<CaptureProbe *>(raw); std::lock_guard<std::mutex> guard(p.mutex);
        assert(id == 1 && frame && frame->width == 2 && frame->height == 2 && frame->rgba.len == 16);
        ++p.frames; p.changed.notify_all();
      },
      +[](void *, uint64_t, uint64_t, citizensdk_bytes_view_t) { assert(false); }, // 空白合成帧不应有二维码。
      +[](void *, uint64_t, citizensdk_error_code_t) {},
      +[](void *raw, uint64_t id, uint64_t operation, citizensdk_error_code_t code) {
        auto &p = *static_cast<CaptureProbe *>(raw); std::lock_guard<std::mutex> guard(p.mutex);
        assert(id == 1); p.controls.emplace_back(operation, code); p.changed.notify_all();
      },
      +[](void *raw, uint64_t id, citizensdk_error_code_t code) {
        auto &p = *static_cast<CaptureProbe *>(raw); std::lock_guard<std::mutex> guard(p.mutex);
        assert(id == 1); ++p.closed; p.close_code = code; p.changed.notify_all();
      },
      +[](void *raw) {
        auto &p = *static_cast<CaptureProbe *>(raw); std::lock_guard<std::mutex> guard(p.mutex); ++p.retained;
      },
      +[](void *raw) {
        auto &p = *static_cast<CaptureProbe *>(raw); std::lock_guard<std::mutex> guard(p.mutex);
        assert(p.owner.expired()); ++p.released; p.changed.notify_all();
      }};
  }
  static citizen_sdk::linux::QrFrame blank(bool bad = false) {
    citizen_sdk::linux::QrFrame frame; frame.width = bad ? 0U : 2U; frame.height = 2;
    frame.rgba.assign(16, 255); frame.luminance.assign(4, 255); return frame;
  }
  citizen_sdk::linux::QrCapture::Factory factory() {
    return [this](auto frame, auto failed) {
      { std::lock_guard<std::mutex> guard(mutex); frame_callbacks.push_back(frame); changed.notify_all(); }
      return citizen_sdk::linux::QrCapture::Device{
        [this, frame, failed] {
          if (deny) failed(CITIZENSDK_ERROR_PERMISSION_DENIED, "不得外传的合成后端文本");
          else if (emit_first) frame(blank(malformed));
        },
        [this] {
          std::unique_lock<std::mutex> guard(mutex); ++stops; changed.notify_all();
          if (block_stop) changed.wait(guard, [&] { return unblock_stop; });
        },
        [this](bool enabled) {
          std::unique_lock<std::mutex> guard(mutex); torches.push_back(enabled);
          if (enabled && block_torch) { ++torch_entries; changed.notify_all(); changed.wait(guard, [&] { return unblock_torch; }); }
          return CITIZENSDK_OK;
        }};
    };
  }
  std::shared_ptr<citizen_sdk::linux::QrCapture> create() {
    auto lease = std::make_shared<uint8_t>(0); owner = lease;
    return std::make_shared<citizen_sdk::linux::QrCapture>(77, 1, 1, callbacks(), lease,
      [this](uint64_t id) { std::lock_guard<std::mutex> guard(mutex); assert(id == 1); ++terminals; },
      factory());
  }
};

void capture_resource_contract() {
  static_assert(sizeof(citizensdk_qr_frame_v1_t) == 64);
  static_assert(sizeof(citizensdk_qr_capture_callbacks_v1_t) == 80);
  static_assert(offsetof(citizensdk_qr_frame_v1_t, rgba) == 32);
  static_assert(offsetof(citizensdk_qr_frame_v1_t, luminance) == 48);
  {
    CaptureProbe p;
    auto capture = p.create(); capture->start();
    p.wait([&] { return p.opened == 1 && p.frames == 1; });
    assert(p.open_code == CITIZENSDK_OK && p.width == 2 && p.height == 2 && p.stops == 1);
    assert(capture->control(1, 2, 0) == CITIZENSDK_OK);
    p.wait([&] { return p.controls.size() == 1; });
    citizen_sdk::linux::QrCamera::Frame old_frame;
    { std::lock_guard<std::mutex> guard(p.mutex); old_frame = p.frame_callbacks.back(); }
    old_frame(CaptureProbe::blank());
    assert(capture->control(2, 1, 0) == CITIZENSDK_OK);
    p.wait([&] { return p.controls.size() == 2; });
    const int paused_frames = p.frames;
    old_frame(CaptureProbe::blank()); assert(p.frames == paused_frames);
    assert(capture->control(3, 2, 0) == CITIZENSDK_OK);
    p.wait([&] { return p.controls.size() == 3; });
    old_frame(CaptureProbe::blank()); assert(p.frames == paused_frames); // 旧代不得在新代恢复后重现。
    assert(capture->control(3, 2, 0) == CITIZENSDK_ERROR_CONFLICT);
    assert(capture->control(4, 1, 1) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(capture->control(4, 3, 1) == CITIZENSDK_OK);
    p.wait([&] { return p.controls.size() == 4; });
    assert(capture->control(5, 4, 0) == CITIZENSDK_OK);
    p.wait([&] { return p.released == 1; });
    assert(capture->closed() && p.closed == 1 && p.terminals == 1 && p.retained == 1);
    assert(p.close_code == CITIZENSDK_OK && p.torches == std::vector<bool>({true, false}));
    assert(capture->control(6, 2, 0) == CITIZENSDK_ERROR_NOT_FOUND);
    old_frame(CaptureProbe::blank()); assert(p.frames == paused_frames);
  }
  {
    CaptureProbe p; p.emit_first = false; p.block_stop = true;
    auto capture = p.create(); capture->start();
    p.wait([&] { return !p.frame_callbacks.empty(); });
    assert(capture->control(1, 2, 0) == CITIZENSDK_ERROR_NOT_READY);
    assert(capture->control(1, 4, 0) == CITIZENSDK_OK);
    p.wait([&] { return p.stops == 1; });
    assert(p.closed == 0 && p.released == 0 && !capture->closed());
    { std::lock_guard<std::mutex> guard(p.mutex); p.unblock_stop = true; p.changed.notify_all(); }
    p.wait([&] { return p.released == 1; });
    assert(p.opened == 1 && p.open_code == CITIZENSDK_ERROR_CANCELLED && p.frames == 0);
  }
  {
    CaptureProbe p; p.block_torch = true;
    auto capture = p.create(); capture->start();
    p.wait([&] { return p.opened == 1 && p.frames == 1; });
    assert(capture->control(1, 2, 0) == CITIZENSDK_OK);
    p.wait([&] { return p.controls.size() == 1; });
    assert(capture->control(2, 3, 1) == CITIZENSDK_OK);
    p.wait([&] { return p.torch_entries == 1; });
    for (uint64_t id = 3; id <= 65; ++id) assert(capture->control(id, 3, 0) == CITIZENSDK_OK);
    assert(capture->control(66, 3, 0) == CITIZENSDK_ERROR_QUEUE_FULL);
    assert(capture->control(67, 4, 0) == CITIZENSDK_OK); // 关闭不能被满控制队列阻挡。
    { std::lock_guard<std::mutex> guard(p.mutex); p.unblock_torch = true; p.changed.notify_all(); }
    p.wait([&] { return p.released == 1; });
    assert(p.controls.size() == 65 && p.closed == 1);
    for (std::size_t i = 2; i < p.controls.size(); ++i) assert(p.controls[i].second == CITIZENSDK_ERROR_CANCELLED);
  }
  {
    CaptureProbe p;
    auto capture = p.create(); capture->start();
    p.wait([&] { return p.opened == 1 && p.frames == 1; });
    assert(capture->control(1, 2, 0) == CITIZENSDK_OK);
    p.wait([&] { return p.controls.size() == 1; });
    citizen_sdk::linux::QrCamera::Frame current;
    { std::lock_guard<std::mutex> guard(p.mutex); current = p.frame_callbacks.back(); }
    auto changed = CaptureProbe::blank(); changed.rotation_degrees = 90;
    current(std::move(changed)); // 公开Capture尺寸/方向固定，重启不能静默改变纹理合同。
    p.wait([&] { return p.released == 1; });
    assert(p.close_code == CITIZENSDK_ERROR_INTEGRITY && p.closed == 1);
  }
  for (const bool malformed : {false, true}) {
    CaptureProbe p; p.malformed = malformed; p.deny = !malformed;
    auto capture = p.create(); capture->start();
    p.wait([&] { return p.released == 1; });
    const auto expected = malformed ? CITIZENSDK_ERROR_INTEGRITY : CITIZENSDK_ERROR_PERMISSION_DENIED;
    assert(p.open_code == expected && p.close_code == expected && p.frames == 0);
    assert(p.closed == 1 && p.terminals == 1);
  }
}

void capture_image_contract() {
  // 2x2公开合成BMP：顶行蓝/白、底行红/绿，不从磁盘取得图片或真实资料。
  std::vector<uint8_t> bmp(70, 0);
  const auto put32 = [&](std::size_t at, uint32_t value) {
    for (unsigned shift = 0; shift < 32; shift += 8) bmp[at++] = static_cast<uint8_t>(value >> shift);
  };
  bmp[0] = 'B'; bmp[1] = 'M'; put32(2, 70); put32(10, 54); put32(14, 40);
  put32(18, 2); put32(22, 2); bmp[26] = 1; bmp[28] = 24; put32(34, 16);
  bmp[56] = 255; bmp[58] = 255;
  bmp[62] = 255; bmp[65] = 255; bmp[66] = 255; bmp[67] = 255;
#if defined(_WIN32) || CITIZENSDK_ENABLE_QR_CAPTURE
  const auto pixels = citizen_sdk::linux::decode_qr_image_pixels({bmp.data(), bmp.size()});
  assert(pixels.width == 2 && pixels.height == 2 && pixels.rgba.size() == 16 && pixels.luminance.size() == 4);
  assert(pixels.rgba[0] == 0 && pixels.rgba[1] == 0 && pixels.rgba[2] == 255 && pixels.rgba[3] == 255);
  assert(pixels.luminance[0] == 28 && pixels.luminance[1] == 255);
  assert(citizen_sdk::linux::decode_qr_image_documents(77, {bmp.data(), bmp.size()}, 1) == std::vector<uint8_t>(4, 0));
  put32(18, 4097);
  bool oversized = false;
  try { (void)citizen_sdk::linux::decode_qr_image_pixels({bmp.data(), bmp.size()}); }
  catch (const citizen_sdk::linux::HostError &) { oversized = true; }
  assert(oversized);
#else
  bool unavailable = false;
  try { (void)citizen_sdk::linux::decode_qr_image_pixels({bmp.data(), bmp.size()}); }
  catch (const citizen_sdk::linux::HostError &error) { unavailable = error.code() == CITIZENSDK_ERROR_UNSUPPORTED; }
  assert(unavailable);
#endif
  for (const citizensdk_bytes_view_t invalid : {citizensdk_bytes_view_t{nullptr, 1}, citizensdk_bytes_view_t{bmp.data(), 0},
      citizensdk_bytes_view_t{bmp.data(), 16U * 1024U * 1024U + 1}}) {
    bool rejected = false;
    try { (void)citizen_sdk::linux::decode_qr_image_pixels(invalid); }
    catch (const citizen_sdk::linux::HostError &error) { rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT; }
    assert(rejected);
  }
}
}  // namespace

int main() {

  {
    // 真实公开Core纯函数，不创建钱包或访问设备；Cpp只复制参数和结果。
    assert(citizen_sdk::Host::validatePassword({}).reason == 0);
    assert(citizen_sdk::Host::validatePassword(std::vector<uint8_t>{'a','b','c','d','e'}).reason == 7);
    assert(citizen_sdk::Host::wordSuggestions("aban") == std::vector<std::string>{"abandon"});
    const auto prefix = citizen_sdk::Host::encodePayload(2, "{\"op_tag\":24}");
    assert(prefix == std::vector<uint8_t>({'G','M','B',24}));
    bool failed = false;
    try { (void)citizen_sdk::Host::encodePayload(2, "{\"op_tag\":24,\"op_tag\":25}"); }
    catch (const citizen_sdk::Error &error) { failed = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT; }
    assert(failed);
  }
  {
    // 只检验生产Cpp拥有者的资源门，不将有限对象当硬件或密码学证据。
    struct Resource final : citizen_sdk::detail::OwnedResource {
      bool released{}, fail{};
      unsigned calls{};
      unsigned resource_kind() const noexcept override { return 1; }
      bool is_released() const noexcept override { return released; }
      void release() override { ++calls; if (fail) throw citizen_sdk::Error(CITIZENSDK_ERROR_BUSY, "synthetic"); released = true; }
    };
    auto owner = std::make_shared<citizen_sdk::detail::AsyncOwner>(0, 0);
    std::vector<std::shared_ptr<Resource>> values;
    for (unsigned i = 0; i < 64; ++i) { auto value = std::make_shared<Resource>(); owner->remember(value); values.push_back(value); }
    bool full = false;
    try { owner->remember(std::make_shared<Resource>()); } catch (const citizen_sdk::Error &error) { full = error.code() == CITIZENSDK_ERROR_QUEUE_FULL; }
    assert(full);
    values.front()->release();
    auto next = std::make_shared<Resource>(); owner->remember(next);
    values[1]->fail = true;
    bool busy = false;
    try { owner->release_resources(); } catch (const citizen_sdk::Error &error) { busy = error.code() == CITIZENSDK_ERROR_BUSY; }
    assert(busy && next->released && values.back()->released && !owner->accepting);
    values[1]->fail = false; owner->release_resources(); assert(values[1]->released);
    unsigned invoked = 0;
    try {
      (void)citizen_sdk::detail::operation<void>(owner,
        [&](citizensdk_handle_t, citizensdk_request_id_t *) { ++invoked; return CITIZENSDK_OK; },
        [](citizen_sdk::detail::EventResultScope &) {});
      assert(false);
    } catch (const citizen_sdk::Error &error) { assert(error.code() == CITIZENSDK_ERROR_INVALID_STATE); }
    assert(invoked == 0 && owner->pending.load() == 0);
    auto invalid = std::make_shared<citizen_sdk::detail::AsyncOwner>(0, 0);
    invalid->next_operation = UINT64_MAX;
    try {
      (void)citizen_sdk::detail::operation<void>(invalid,
        [&](citizensdk_handle_t, citizensdk_request_id_t *) { ++invoked; return CITIZENSDK_OK; },
        [](citizen_sdk::detail::EventResultScope &) {});
      assert(false);
    } catch (const citizen_sdk::Error &error) { assert(error.code() == CITIZENSDK_ERROR_INVALID_HANDLE); }
    assert(invalid->pending.load() == 0 && invalid->next_operation == 0 && invoked == 0);
  }
  {
    // Core JSON仅为公开投影；nullable与重复/越界分别测试，不解析QR_V1。
    assert(!citizen_sdk::detail::qr_public_optional_field("{\"value\":null}", "value", 8));
    assert(citizen_sdk::detail::qr_public_optional_field("{\"value\":\"\"}", "value", 8) == std::optional<std::string>{""});
    assert(citizen_sdk::detail::decimal_u64("18446744073709551615") == UINT64_MAX);
    for (const auto &text : {"", "01", "18446744073709551616"}) {
      bool bad = false;
      try { (void)citizen_sdk::detail::decimal_u64(text); } catch (const citizen_sdk::Error &) { bad = true; }
      assert(bad);
    }
    bool bad = false;
    try { (void)citizen_sdk::detail::qr_public_optional_field("{\"value\":null,\"value\":\"x\"}", "value", 8); }
    catch (const citizen_sdk::Error &) { bad = true; }
    assert(bad);
  }

  capture_resource_contract();
  capture_image_contract();

  {
    // 调用生产像素转换，不启动真实摄像头；色序、负行跨度、边界及副本独立性分别验证。
    namespace camera = citizen_sdk::linux;
    const uint8_t rgba[] = {255, 0, 0, 17, 0, 255, 0, 255};
    const auto frame = camera::copy_qr_frame(rgba, sizeof(rgba), 2, 1, 8, false);
    assert(frame.width == 2 && frame.height == 1 && frame.rgba == std::vector<uint8_t>(rgba, rgba + 8));
    assert(frame.luminance == std::vector<uint8_t>({76, 149}));
    std::vector<uint8_t> bgrx{255, 0, 0, 0, 0, 0, 255, 0};
    const auto flipped = camera::copy_qr_frame(bgrx.data(), bgrx.size(), 1, 2, -4, true);
    std::fill(bgrx.begin(), bgrx.end(), 0);
    assert(flipped.rgba == std::vector<uint8_t>({255, 0, 0, 255, 0, 0, 255, 255}));
    assert(flipped.luminance == std::vector<uint8_t>({76, 28}));
    for (unsigned invalid = 0; invalid < 6; ++invalid) {
      bool rejected = false;
      try {
        (void)camera::copy_qr_frame(invalid == 0 ? nullptr : rgba,
            invalid == 1 ? 3 : sizeof(rgba), invalid == 2 ? 0U : invalid == 3 ? 4097U : 1U,
            1, invalid == 4 ? 3 : invalid == 5 ? INT64_MIN : 4, false);
      } catch (const camera::HostError &error) {
        rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
      }
      assert(rejected);
    }
    bool missing_callbacks = false;
    try { camera::QrCamera invalid_camera({}, {}); }
    catch (const camera::HostError &error) { missing_callbacks = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT; }
    assert(missing_callbacks);
    camera::QrCamera stopped([](camera::QrFrame) {}, [](auto, auto) {});
    const auto unavailable = stopped.set_torch(true);
    assert(unavailable == CITIZENSDK_ERROR_NOT_READY || unavailable == CITIZENSDK_ERROR_UNSUPPORTED);
    stopped.stop(); stopped.stop();
  }

  static_assert(CITIZENSDK_ABI_VERSION == 1);
  static_assert(CITIZENSDK_CAPABILITY_COUNT == 10);
  static_assert(CITIZENSDK_HOST_ABI_VERSION == 1);
  static_assert(std::is_standard_layout_v<citizensdk_host_request_v1_t>);
  static_assert(sizeof(citizensdk_host_request_v1_t) == 56);
  static_assert(offsetof(citizensdk_host_request_v1_t, context) == 8);
  static_assert(offsetof(citizensdk_host_request_v1_t, accept) == 16);
  static_assert(offsetof(citizensdk_host_request_v1_t, complete) == 24);
  static_assert(offsetof(citizensdk_host_request_v1_t, cancel) == 32);
  static_assert(offsetof(citizensdk_host_request_v1_t, retain) == 40);
  static_assert(offsetof(citizensdk_host_request_v1_t, release) == 48);
  static_assert(sizeof(citizensdk_handle_t) == sizeof(uint64_t));
  static_assert(sizeof(citizensdk_host_handle_t) == sizeof(uint64_t));
  static_assert(std::is_standard_layout_v<citizensdk_host_config_v1_t>);
  static_assert(sizeof(citizensdk_host_config_v1_t) == 72);
  static_assert(offsetof(citizensdk_host_config_v1_t, struct_size) == 0);
  static_assert(offsetof(citizensdk_host_config_v1_t, abi_version) == 4);
  static_assert(offsetof(citizensdk_host_config_v1_t, storage_root_utf8) == 8);
  static_assert(offsetof(citizensdk_host_config_v1_t, asset_root_utf8) == 24);
  static_assert(offsetof(citizensdk_host_config_v1_t, application_id_utf8) ==
                40);
  static_assert(offsetof(citizensdk_host_config_v1_t, gtk_parent_window) == 56);
  static_assert(offsetof(citizensdk_host_config_v1_t, enable_wallet) == 64);
  static_assert(offsetof(citizensdk_host_config_v1_t, reserved) == 65);
  static_assert(
      sizeof(static_cast<citizensdk_host_config_v1_t *>(nullptr)->reserved) ==
      7);

  assert(citizensdk_abi_version() == CITIZENSDK_ABI_VERSION);
  assert(citizensdk_host_abi_version() == CITIZENSDK_HOST_ABI_VERSION);
  assert(citizensdk_host_config_size() == sizeof(citizensdk_host_config_v1_t));
  assert(CITIZENSDK_ERROR_CANCELLED == 22);

  const std::string header_path =
      std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
      "/citizen_sdk/citizensdk_host.h";
  std::ifstream stream(header_path, std::ios::binary);
  assert(stream.good());
  const std::string header((std::istreambuf_iterator<char>(stream)),
                           std::istreambuf_iterator<char>());
  assert(header.find("citizensdk_linux_host_") == std::string::npos);
  const std::regex function_pattern(R"(\b(citizensdk_host_[a-z0-9_]+)\s*\()",
                                    std::regex::ECMAScript);
  std::set<std::string> functions;
  for (auto iterator = std::sregex_iterator(header.begin(), header.end(),
                                             function_pattern);
       iterator != std::sregex_iterator(); ++iterator) {
    functions.insert((*iterator)[1].str());
  }
  const std::set<std::string> expected{
      "citizensdk_host_open_qr_capture",
      "citizensdk_host_control_qr_capture",
      "citizensdk_host_decode_qr_image",
      "citizensdk_host_submit_request",
      "citizensdk_host_set_credential_provider",
      "citizensdk_host_respond_credential",
      "citizensdk_host_cancel_credential",
      "citizensdk_host_abi_version",
      "citizensdk_host_abandon",
      "citizensdk_host_config_size",
      "citizensdk_host_create",
      "citizensdk_host_create_with_modules",
      "citizensdk_host_create_sdk",
      "citizensdk_host_destroy",
      "citizensdk_host_last_error_copy",
      "citizensdk_host_sdk",
      "citizensdk_host_set_event_callback",
      "citizensdk_host_set_parent_window",
      "citizensdk_host_vault_availability",
  };
  assert(functions == expected);

  // 安装投影必须继续只暴露 CitizenSDK::Host，并由该目标通过安装期
  // CitizenSDK::Core 传递唯一 Core；不能把构建树 imported target 名或
  // 测试专用资产宏泄漏到已安装消费者合同。
  const auto read_source = [](const char *relative) {
    const std::string path = std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
                             relative;
    std::ifstream input(path, std::ios::binary);
    assert(input.good());
    return std::string((std::istreambuf_iterator<char>(input)),
                       std::istreambuf_iterator<char>());
  };
  const std::string cmake = read_source("/CMakeLists.txt");
  // GNU 扩展模式的 linux 宏不得改写 citizen_sdk::linux 命名空间。
  assert(cmake.find("set(CMAKE_CXX_EXTENSIONS OFF)") != std::string::npos);
  const std::string gtk_parent = read_source("/src/citizen_sdk_host_bridge.cc");
  assert(gtk_parent.find(
             "static_cast<GObject *>(g_weak_ref_get(&impl_->weak))") !=
         std::string::npos);
  assert(cmake.find("$<BUILD_INTERFACE:citizensdk_core>") !=
         std::string::npos);
  assert(cmake.find("$<INSTALL_INTERFACE:CitizenSDK::Core>") !=
         std::string::npos);
  assert(cmake.find("EXPORT_NAME Host") != std::string::npos);
  assert(cmake.find("CITIZENSDK_PACKAGED_ASSET_DIR") == std::string::npos);
  const std::string package_config =
      read_source("/cmake/CitizenSDKConfig.cmake.in");
  assert(package_config.find("set(CITIZENSDK_ASSET_DIR") !=
         std::string::npos);
  assert(package_config.find("add_library(CitizenSDK::Core SHARED IMPORTED)") !=
         std::string::npos);
  assert(package_config.find("CitizenSDKDependencies.cmake") !=
         std::string::npos);
  assert(package_config.find("CitizenSDKTargets.cmake") !=
         std::string::npos);
  const std::string test_cmake = read_source("/test/CMakeLists.txt");
  assert(test_cmake.find("set(CITIZENSDK_TEST_WORK_DIR \"\" CACHE PATH") !=
         std::string::npos);
  assert(test_cmake.find(
             "ENVIRONMENT \"CITIZENSDK_TEST_WORK_DIR=${CITIZENSDK_TEST_WORK_DIR}\"") !=
         std::string::npos);
  const std::string test_support =
      read_source("/test/citizen_sdk_test_support.hpp");
  assert(test_support.find("std::getenv(\"CITIZENSDK_TEST_WORK_DIR\")") !=
         std::string::npos);
  assert(test_support.find("::getrandom") != std::string::npos);
  assert(test_support.find("::mkdirat(parent_fd_") != std::string::npos);
  assert(test_support.find("::mkdtemp") == std::string::npos);
  assert(test_support.find("std::filesystem::temp_directory_path") ==
         std::string::npos);
  assert(test_support.find("remove_all") == std::string::npos);

  citizensdk_host_handle_t host = 99;
  assert(citizensdk_host_create(nullptr, nullptr) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(citizensdk_host_create(nullptr, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  citizensdk_host_config_v1_t invalid{};
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);

  citizen_sdk::linux::test::TempDirectory temporary("api-contract");
  const std::string storage = (temporary.path() / "state").string();
  const std::string assets = (temporary.path() / "assets").string();
  const std::string application_id = "org.citizen.fixture";
  const auto view = [](const std::string &value) {
    return citizensdk_bytes_view_t{
        reinterpret_cast<const uint8_t *>(value.data()),
        static_cast<uint64_t>(value.size())};
  };
  invalid.struct_size = sizeof(invalid);
  invalid.abi_version = CITIZENSDK_HOST_ABI_VERSION;
  invalid.storage_root_utf8 = view(storage);
  invalid.asset_root_utf8 = view(assets);
  invalid.application_id_utf8 = view(application_id);
  invalid.abi_version = CITIZENSDK_HOST_ABI_VERSION + 1;
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  invalid.abi_version = CITIZENSDK_HOST_ABI_VERSION;
  invalid.reserved[0] = 1;
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  invalid.reserved[0] = 0;
  invalid.enable_wallet = 2;
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  invalid.enable_wallet = 0;
  invalid.application_id_utf8 = {nullptr, 0};
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  const std::string invalid_application_id = "Citizen.App";
  invalid.application_id_utf8 = view(invalid_application_id);
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  const std::string relative_storage = "relative-state";
  invalid.application_id_utf8 = view(application_id);
  invalid.storage_root_utf8 = view(relative_storage);
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  const std::string relative_assets = "relative-assets";
  invalid.storage_root_utf8 = view(storage);
  invalid.asset_root_utf8 = view(relative_assets);
  assert(citizensdk_host_create(&invalid, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  uint64_t error_bytes = 0;
  assert(citizensdk_host_last_error_copy(nullptr, 0, &error_bytes) ==
         CITIZENSDK_OK);
  assert(error_bytes > 0);
  std::string copied_error(static_cast<std::size_t>(error_bytes), '\0');
  assert(citizensdk_host_last_error_copy(
             reinterpret_cast<uint8_t *>(copied_error.data()),
             error_bytes - 1, &error_bytes) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(citizensdk_host_last_error_copy(
             reinterpret_cast<uint8_t *>(copied_error.data()), error_bytes,
             &error_bytes) == CITIZENSDK_OK);
  assert(!copied_error.empty());
  assert(citizensdk_host_sdk(0, nullptr) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(citizensdk_host_destroy(0) == CITIZENSDK_ERROR_INVALID_HANDLE);
  assert(citizensdk_host_abandon(0) == CITIZENSDK_ERROR_INVALID_HANDLE);
  assert(citizensdk_host_last_error_copy(nullptr, 0, nullptr) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);

  // Host 构造只组合平台资源；Core 创建保持显式。这个有效的 chain-only
  // 实例无需真实链资产即可冻结未打开、能力查询和正常销毁的 C 生命周期。
  invalid.asset_root_utf8 = view(assets);
  assert(citizensdk_host_create_with_modules(&invalid, 0, &host) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  assert(citizensdk_host_create_with_modules(&invalid, CITIZENSDK_MODULE_HISTORY, &host) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(host == 0);
  // 未知/缺依赖模块在平台资源创建前被 Rust 拒绝。
  assert(!std::filesystem::exists(
      temporary.path() / "state" / application_id / "citizensdk"));
  assert(citizensdk_host_create(&invalid, &host) == CITIZENSDK_OK);
  assert(host != 0);
  assert(std::filesystem::is_directory(
      temporary.path() / "state" / application_id / "citizensdk" / "v1" /
      "public"));
  assert(!std::filesystem::exists(
      temporary.path() / "state" / application_id / "citizensdk" / "v1" /
      "secure"));
  assert(!std::filesystem::exists(
      temporary.path() / "state" / application_id / "citizenapp"));
  citizensdk_handle_t sdk = 99;
  assert(citizensdk_host_sdk(host, nullptr) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(citizensdk_host_sdk(host, &sdk) == CITIZENSDK_ERROR_NOT_READY);
  assert(sdk == 0);
  citizensdk_host_vault_availability_t availability{};
  assert(citizensdk_host_vault_availability(host, nullptr) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(citizensdk_host_vault_availability(host, &availability) ==
         CITIZENSDK_OK);
  assert(availability == CITIZENSDK_HOST_VAULT_UNSUPPORTED);
  assert(citizensdk_host_set_event_callback(host, nullptr, nullptr) ==
         CITIZENSDK_OK);
  assert(citizensdk_host_set_parent_window(host, nullptr) == CITIZENSDK_OK);
  assert(citizensdk_host_create_sdk(host, nullptr) ==
         CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(citizensdk_host_create_sdk(host, &sdk) ==
         CITIZENSDK_ERROR_INTEGRITY);
  assert(sdk == 0);
  uint64_t resource = 99;
  assert(citizensdk_host_open_qr_capture(host, 1, nullptr, &resource) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(resource == 0);
  CaptureProbe probe;
  auto capture_callbacks = probe.callbacks();
  assert(citizensdk_host_open_qr_capture(host, 1, &capture_callbacks, &resource) == CITIZENSDK_ERROR_INVALID_STATE);
  assert(resource == 0 && probe.retained == 0);
  assert(citizensdk_host_control_qr_capture(host, 1, 1, 4, 0) == CITIZENSDK_ERROR_NOT_FOUND);
  uint64_t required_image = 77;
  assert(citizensdk_host_decode_qr_image(host, {nullptr, 0}, 1, nullptr, 0, &required_image) == CITIZENSDK_ERROR_INVALID_STATE);
  assert(required_image == 77); // 未就绪失败不输出半个图像结果。
  assert(citizensdk_host_destroy(host) == CITIZENSDK_OK);
  assert(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_INVALID_HANDLE);

  // 钱包与签名均能脱离链独立创建，空资产根不被读取，也不创建公开链数据库。
  for (const auto modules : {CITIZENSDK_MODULE_WALLET, CITIZENSDK_MODULE_SIGNING}) {
    const std::string isolated_id = modules == CITIZENSDK_MODULE_WALLET
        ? "org.citizen.walletfixture" : "org.citizen.signingfixture";
    invalid.application_id_utf8 = view(isolated_id);
    invalid.asset_root_utf8 = {nullptr, 0};
    invalid.enable_wallet = 1;
    assert(citizensdk_host_create_with_modules(&invalid, modules, &host) == CITIZENSDK_OK);
    assert(!std::filesystem::exists(
        temporary.path() / "state" / isolated_id / "citizensdk" / "v1" / "public"));
    assert(citizensdk_host_create_sdk(host, &sdk) == CITIZENSDK_OK && sdk != 0);
    citizensdk_capability_snapshot_t snapshot{};
    snapshot.struct_size = sizeof(snapshot); snapshot.abi_version = CITIZENSDK_ABI_VERSION;
    assert(citizensdk_get_capabilities(sdk, &snapshot) == CITIZENSDK_OK);
    // 金库可用性仍由设备事实报告，不能为通过测试打开软件金库。
    assert(!std::filesystem::exists(
        temporary.path() / "state" / isolated_id / "citizensdk" / "v1" / "public"));
    if (modules == CITIZENSDK_MODULE_SIGNING) {
    }
    assert(citizensdk_host_destroy(host) == CITIZENSDK_OK);
  }


  // 实际QR-only Core请求经过Host薄接纳桥；不读取真实钱包、链资产或设备金库。
  {
    struct Probe {
      std::atomic<unsigned> retains{0}, releases{0}, completions{0}, cancellations{0};
      std::atomic<citizensdk_request_id_t> delivered{0};
      std::mutex mutex;
      std::condition_variable changed;
    } probe;
    // 视图不能借用临时字符串；命名空间在本组全部调用期间保持存活。
    const std::string request_namespace = "org.citizen.requestfixture";
    invalid.application_id_utf8 = view(request_namespace);
    invalid.asset_root_utf8 = {nullptr, 0};
    invalid.enable_wallet = 0;
    assert(citizensdk_host_create_with_modules(&invalid, CITIZENSDK_MODULE_QR, &host) == CITIZENSDK_OK);
    assert(citizensdk_host_create_sdk(host, &sdk) == CITIZENSDK_OK);
    citizensdk_host_request_v1_t callbacks{
      sizeof(callbacks), CITIZENSDK_HOST_ABI_VERSION, &probe,
      +[](void *, citizensdk_handle_t core, citizensdk_request_id_t *out) {
        return citizensdk_refresh_capabilities(core, out);
      },
      +[](void *raw, citizensdk_request_id_t request, citizensdk_result_handle_t result) {
        auto &state = *static_cast<Probe *>(raw);
        citizensdk_result_info_t info{};
        info.struct_size = sizeof(info); info.abi_version = CITIZENSDK_ABI_VERSION;
        assert(citizensdk_result_get_info(result, &info) == CITIZENSDK_OK);
        assert(info.error_code == CITIZENSDK_OK);
        assert(citizensdk_result_release(result) == CITIZENSDK_OK);
        state.delivered.store(request);
        ++state.completions;
      },
      +[](void *raw, citizensdk_handle_t) { ++static_cast<Probe *>(raw)->cancellations; },
      +[](void *raw) { ++static_cast<Probe *>(raw)->retains; },
      +[](void *raw) {
        auto &state = *static_cast<Probe *>(raw);
        { std::lock_guard<std::mutex> guard(state.mutex); ++state.releases; }
        state.changed.notify_all();
      }};
    citizensdk_request_id_t request = 99;
    auto malformed = callbacks; malformed.struct_size = 0;
    assert(citizensdk_host_submit_request(host, &malformed, &request) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(request == 0 && probe.retains == 0);
    assert(citizensdk_host_submit_request(0, &callbacks, &request) == CITIZENSDK_ERROR_INVALID_HANDLE);
    assert(request == 0 && probe.retains == 0);
    assert(citizensdk_host_submit_request(host, &callbacks, &request) == CITIZENSDK_OK && request != 0);
    {
      std::unique_lock<std::mutex> guard(probe.mutex);
      assert(probe.changed.wait_for(guard, std::chrono::seconds(5), [&] { return probe.releases == 1; }));
    }
    assert(probe.retains == 1 && probe.completions == 1 && probe.delivered == request);
    callbacks.accept = +[](void *, citizensdk_handle_t, citizensdk_request_id_t *out) {
      *out = 0; return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    };
    assert(citizensdk_host_submit_request(host, &callbacks, &request) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(request == 0 && probe.retains == 2 && probe.releases == 2 && probe.completions == 1);
    // 回调release完成不等于Core派发栈已退出；关闭只重试真实BUSY。
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    auto closed = citizensdk_host_destroy(host);
    while (closed == CITIZENSDK_ERROR_BUSY && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      closed = citizensdk_host_destroy(host);
    }
    assert(closed == CITIZENSDK_OK);
  }

  {
    // 仅验证Core JSON事实投影；实际QR_V1码型/用途判定仍由Core完成。
    const std::string identity = "0x" + std::string(64, 'a');
    const auto document = std::string("{\"scan_purpose_mask\":1,\"account_id\":\"") + identity + "\"}";
    const auto account = citizen_sdk::detail::qr_import_account(document);
    for (auto byte : account.bytes) assert(byte == 0xaa);
    assert(citizen_sdk::detail::qr_public_unsigned("{\"nested\":{\"scan_purpose_mask\":0},\"scan_purpose_mask\":255}",
                                                 "scan_purpose_mask", 255) == 255);
    for (const char *bad : {"{}", "{\"scan_purpose_mask\":-1}", "{\"scan_purpose_mask\":01}",
                           "{\"scan_purpose_mask\":256}", "{\"scan_purpose_mask\":\"1\"}",
                           "{\"scan_purpose_mask\":1.0}", "{\"scan_purpose_mask\":1,\"scan_purpose_mask\":2}"}) {
      bool rejected = false;
      try { (void)citizen_sdk::detail::qr_public_unsigned(bad, "scan_purpose_mask", 255); }
      catch (const citizen_sdk::Error &error) { rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY; }
      assert(rejected);
    }
    for (const auto &bad : {std::string("{\"scan_purpose_mask\":64,\"account_id\":\"") + identity + "\"}",
                           std::string("{\"scan_purpose_mask\":128,\"account_id\":\"") + identity + "\"}"}) {
      bool rejected = false;
      try { (void)citizen_sdk::detail::qr_import_account(bad); }
      catch (const citizen_sdk::Error &error) { rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT; }
      assert(rejected); // 有account_id也不能把用户码/转账码的事实绕进冷导入。
    }
    bool rejected = false;
    try { (void)citizen_sdk::detail::qr_import_account("{\"scan_purpose_mask\":1,\"account_id\":\"0xAB\"}"); }
    catch (const citizen_sdk::Error &error) { rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY; }
    assert(rejected);
  }

  return 0;
}
