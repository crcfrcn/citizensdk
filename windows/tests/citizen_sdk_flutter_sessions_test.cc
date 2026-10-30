#include <cassert>
#include <functional>
#include <memory>
#include <vector>
#include "value.hpp"
#include "flutter.hpp"
namespace csf=citizen_sdk::flutter;
static const csf::Value::List &items(const csf::Value&v){return std::get<csf::Value::List>(v.data);}
static const std::string &text(const csf::Value&v){return std::get<std::string>(v.data);}
void close_guard_contract() {
  const auto rejects = [](bool attempted, citizensdk_lifecycle_t state,
                          citizensdk_error_code_t status, citizensdk_handle_t core,
                          citizensdk_error_code_t expected) {
    bool rejected = false;
    try { (void)csf::allow_close_without_core(attempted, state, status, core); }
    catch (const citizen_sdk::flutter::ContractFailure &error) { rejected = error.code == expected; }
    assert(rejected);
  };
  assert(!csf::allow_close_without_core(false, 0, CITIZENSDK_OK, 1));
  rejects(false, CITIZENSDK_LIFECYCLE_STOPPED, CITIZENSDK_ERROR_NOT_READY, 0,
          CITIZENSDK_ERROR_NOT_READY);
  rejects(true, CITIZENSDK_LIFECYCLE_RUNNING, CITIZENSDK_ERROR_NOT_READY, 0,
          CITIZENSDK_ERROR_NOT_READY);
  rejects(true, CITIZENSDK_LIFECYCLE_STOPPED, CITIZENSDK_ERROR_INVALID_HANDLE, 0,
          CITIZENSDK_ERROR_INVALID_HANDLE);
  rejects(true, CITIZENSDK_LIFECYCLE_STOPPED, CITIZENSDK_OK, 0, CITIZENSDK_ERROR_INTEGRITY);
  for (const auto state : {CITIZENSDK_LIFECYCLE_CREATED,
                           CITIZENSDK_LIFECYCLE_START_FAILED, CITIZENSDK_LIFECYCLE_STOPPED}) {
    assert(csf::allow_close_without_core(true, state, CITIZENSDK_ERROR_NOT_READY, 0));
  }
}

namespace {
struct CaptureTextureFixture final : csf::CaptureTexture {
  int updates{}, closes{};
  bool fail_close{};
  std::shared_ptr<const std::vector<uint8_t>> pixels;
  std::function<void()> drained;
  int64_t id() const noexcept override { return 23; }
  void update(std::shared_ptr<const std::vector<uint8_t>> value) override { ++updates; pixels = std::move(value); }
  void close(std::function<void()> done) override {
    ++closes;
    if (fail_close) throw citizen_sdk::flutter::ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "合成纹理暂未注销");
    drained = std::move(done);
  }
};
struct CaptureBindingFixture final {
  std::vector<std::function<void()>> tasks;
  std::vector<std::function<csf::Value()>> openings, controls, closings;
  std::vector<std::string> events;
  std::vector<uint32_t> actions;
  citizensdk_qr_capture_callbacks_v1_t callbacks{};
  std::shared_ptr<CaptureTextureFixture> texture = std::make_shared<CaptureTextureFixture>();
  std::shared_ptr<csf::CaptureResource> resource;
  citizensdk_error_code_t admission{CITIZENSDK_OK};
  citizensdk_error_code_t opening_code{CITIZENSDK_OK};
  int factories{}, finished{}, released{};
  bool granted{}, fail_texture{};
  void pump() {
    while (!tasks.empty()) {
      auto work = std::move(tasks); tasks.clear();
      for (auto &action : work) action();
    }
  }
  void open() {
    csf::CaptureControls api{
      [&](citizensdk_host_handle_t host, uint32_t purpose, const citizensdk_qr_capture_callbacks_v1_t *value, uint64_t *id) {
        assert(host == 55 && purpose == 1 && value->struct_size == sizeof(*value) && value->abi_version == CITIZENSDK_HOST_ABI_VERSION);
        if (admission != CITIZENSDK_OK) return admission;
        callbacks = *value; callbacks.retain(callbacks.context);
        // 特意在接纳函数返回编号前回调；生产对象必须在UI派发后关联正确ID。
        callbacks.opened(callbacks.context, 9, opening_code,
            opening_code == CITIZENSDK_OK ? 2 : 0, opening_code == CITIZENSDK_OK ? 2 : 0, 0);
        *id = 9; return CITIZENSDK_OK;
      },
      [&](citizensdk_host_handle_t host, uint64_t id, uint64_t operation, uint32_t action, uint8_t enabled) {
        assert(host == 55 && id == 9 && operation != 0 && enabled <= 1);
        actions.push_back(action);
        return CITIZENSDK_OK;
      }};
    resource = std::make_shared<csf::CaptureResource>(55, "capture_1", 1,
        [&](std::function<void()> work) { tasks.push_back(std::move(work)); },
        [&](uint32_t width, uint32_t height) -> std::shared_ptr<csf::CaptureTexture> {
          assert(width == 2 && height == 2); ++factories;
          if (fail_texture) throw citizen_sdk::flutter::ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "合成注册失败");
          return texture;
        },
        [&](std::string type, csf::Value) { events.push_back(std::move(type)); },
        [&](bool value) { ++finished; granted = value; }, api);
    resource->open([&](auto project) { openings.push_back(std::move(project)); });
  }
  void publish() {
    pump(); assert(openings.size() == 1);
    const auto value = openings.front()();
    assert(text(items(value)[0]) == "capture_1" && std::get<int64_t>(items(value)[1].data) == 23);
  }
  void command(csf::Method method) {
    resource->control(method, false, [&](auto project) { controls.push_back(std::move(project)); });
  }
  void close() {
    resource->control(csf::Method::close_qr_capture, false, [&](auto project) { closings.push_back(std::move(project)); });
  }
  void native_finished(citizensdk_error_code_t code = CITIZENSDK_OK) {
    callbacks.closed(callbacks.context, 9, code);
    callbacks.release(callbacks.context); ++released;
  }
  void frame() {
    const std::vector<uint8_t> rgba(16, 7), luma(4, 7);
    const citizensdk_qr_frame_v1_t value{sizeof(citizensdk_qr_frame_v1_t), CITIZENSDK_ABI_VERSION, 2, 2, 0, 0, 1,
        {rgba.data(), rgba.size()}, {luma.data(), luma.size()}};
    callbacks.frame(callbacks.context, 9, &value);
  }
  void document() {
    const std::string json = "{\"scan_purpose_mask\":1}";
    callbacks.document(callbacks.context, 9, 1, {reinterpret_cast<const uint8_t *>(json.data()), json.size()});
  }
};
void capture_binding_contract() {
  const auto fails = [](std::function<csf::Value()> project, citizensdk_error_code_t code) {
    bool rejected = false;
    try { (void)project(); } catch (const citizen_sdk::flutter::ContractFailure &error) { rejected = error.code == code; }
    assert(rejected);
  };
  {
    CaptureBindingFixture p; p.open(); p.publish();
    for (int i = 0; i < 100; ++i) p.frame();
    assert(p.tasks.size() == 1); p.pump();
    assert(p.texture->updates == 1 && p.texture->pixels->size() == 16);
    p.command(csf::Method::resume_qr_capture);
    p.callbacks.control(p.callbacks.context, 9, 1, CITIZENSDK_OK); p.pump();
    assert(p.controls.size() == 1); (void)p.controls.back()();
    for (int i = 0; i < 100; ++i) p.document();
    assert(p.tasks.size() == 1);
    p.command(csf::Method::pause_qr_capture);
    p.callbacks.control(p.callbacks.context, 9, 2, CITIZENSDK_OK); p.pump();
    assert(p.events.empty()); // 暂停前排队的识别结果不得在下一轮重现。
    p.command(csf::Method::resume_qr_capture);
    p.callbacks.control(p.callbacks.context, 9, 3, CITIZENSDK_OK); p.pump();
    p.document(); p.pump(); assert(p.events == std::vector<std::string>{"qrCaptureResult"});
    p.close(); assert(p.texture->closes == 1 && p.closings.empty());
    p.native_finished(); p.pump();
    assert(!p.resource->is_closed() && p.finished == 0 && p.closings.empty());
    p.texture->drained(); p.pump();
    assert(p.resource->is_closed() && p.finished == 1 && p.granted && p.released == 1);
    assert(p.closings.size() == 1); (void)p.closings.front()();
  }
  {
    CaptureBindingFixture p; p.open(); p.publish(); p.close();
    p.texture->drained(); p.pump();
    assert(!p.resource->is_closed() && p.closings.empty()); // 纹理先结束也不能代替相机终态。
    p.native_finished(); p.pump();
    assert(p.resource->is_closed() && p.finished == 1 && p.closings.size() == 1);
  }
  {
    CaptureBindingFixture p; p.open(); p.close(); p.native_finished(); p.pump();
    assert(p.factories == 0 && !p.granted && p.finished == 1 && p.openings.size() == 1);
    fails(p.openings.front(), CITIZENSDK_ERROR_CANCELLED); // 迟到打开不再注册纹理。
  }
  {
    CaptureBindingFixture p; p.open(); p.pump(); // 已注册，但打开回应尚未被平台领取。
    p.close(); p.native_finished(); p.pump(); p.texture->drained(); p.pump();
    fails(p.openings.front(), CITIZENSDK_ERROR_CANCELLED);
    assert(!p.granted && p.finished == 1);
  }
  {
    CaptureBindingFixture p; p.admission = CITIZENSDK_ERROR_QUEUE_FULL; p.open(); p.pump();
    assert(p.finished == 1 && p.factories == 0 && p.released == 0);
    fails(p.openings.front(), CITIZENSDK_ERROR_QUEUE_FULL);
  }
  {
    CaptureBindingFixture p; p.opening_code = CITIZENSDK_ERROR_PERMISSION_DENIED;
    p.open(); p.native_finished(CITIZENSDK_ERROR_PERMISSION_DENIED); p.pump();
    assert(p.finished == 1 && p.factories == 0);
    fails(p.openings.front(), CITIZENSDK_ERROR_PERMISSION_DENIED);
  }
  {
    CaptureBindingFixture p; p.fail_texture = true; p.open(); p.pump();
    assert(p.actions == std::vector<uint32_t>{4} && p.finished == 0);
    p.native_finished(); p.pump();
    assert(p.finished == 1); fails(p.openings.front(), CITIZENSDK_ERROR_UNAVAILABLE);
  }
  {
    CaptureBindingFixture p; p.open(); p.publish(); p.texture->fail_close = true;
    bool rejected = false;
    try { p.close(); } catch (const citizen_sdk::flutter::ContractFailure &) { rejected = true; }
    assert(rejected && !p.resource->is_closed());
    p.texture->fail_close = false; p.close(); p.native_finished(); p.pump();
    p.texture->drained(); p.pump();
    assert(p.finished == 1 && p.closings.size() == 1); // 注销失败可重试，不提前释放。
  }
  {
    CaptureBindingFixture p; p.open(); p.publish();
    for (int i = 0; i < 64; ++i) p.command(csf::Method::pause_qr_capture);
    bool full = false;
    try { p.command(csf::Method::resume_qr_capture); } catch (const citizen_sdk::flutter::ContractFailure &error) { full = error.code == CITIZENSDK_ERROR_QUEUE_FULL; }
    assert(full); p.close(); p.native_finished(); p.pump(); p.texture->drained(); p.pump();
    assert(p.resource->is_closed() && p.controls.size() == 64 && p.closings.size() == 1);
    for (const auto &project : p.controls) fails(project, CITIZENSDK_ERROR_CANCELLED);
  }
}
}  // namespace

int main(){
 capture_binding_contract();
 close_guard_contract();
  {
    // 运行生产receiver状态，只把三个Core控制调用换成有限执行器；不伪造设备认证证明。
    std::vector<std::function<csf::Value()>> opened, revealed, closed;
    int reveal_calls = 0, cancel_calls = 0, finish_calls = 0, terminal_calls = 0;
    csf::PrivateKeyControls controls{
      [&](citizensdk_handle_t core, uint64_t secret) { assert(core == 77 && secret == 9); ++reveal_calls; return CITIZENSDK_OK; },
      [&](citizensdk_handle_t, uint64_t secret) { assert(secret == 9); ++cancel_calls; return CITIZENSDK_OK; },
      [&](citizensdk_handle_t, uint64_t secret) { assert(secret == 9); ++finish_calls; return CITIZENSDK_OK; },
    };
    auto resource = std::make_shared<csf::PrivateKeyResource>(77, "private_1",
        [&](auto value) { opened.push_back(std::move(value)); },
        [&](bool granted) { assert(granted); ++terminal_calls; }, controls);
    const auto receiver = resource->receiver();
    assert(receiver.struct_size == sizeof(receiver) && receiver.abi_version == CITIZENSDK_ABI_VERSION);
    std::vector<uint8_t> synthetic(32, 7);
    assert(receiver.receive(receiver.context, 9, {synthetic.data(), 32}) == CITIZENSDK_ERROR_INTEGRITY);
    assert(receiver.authorizing(receiver.context, 9, 100) == CITIZENSDK_ERROR_INTEGRITY);
    // 准备通知允许早于open返回的bind，之后必须绑定同一实际编号。
    receiver.settled(receiver.context, 9, CITIZENSDK_OK);
    resource->bind(9);
    assert(opened.size() == 1 && !resource->is_closed());
    assert(text(items(opened[0]())[0]) == "private_1");
    resource->reveal([&](auto value) { revealed.push_back(std::move(value)); });
    assert(reveal_calls == 1);
    assert(receiver.authorizing(receiver.context, 10, 100) == CITIZENSDK_ERROR_INTEGRITY);
    assert(receiver.authorizing(receiver.context, 9, 100) == CITIZENSDK_OK);
    assert(receiver.authorizing(receiver.context, 9, 101) == CITIZENSDK_ERROR_INTEGRITY);
    assert(receiver.receive(receiver.context, 9, {synthetic.data(), 31}) == CITIZENSDK_ERROR_INTEGRITY);
    assert(receiver.receive(receiver.context, 9, {synthetic.data(), 32}) == CITIZENSDK_OK);
    assert(receiver.receive(receiver.context, 9, {synthetic.data(), 32}) == CITIZENSDK_ERROR_INTEGRITY);
    std::fill(synthetic.begin(), synthetic.end(), 0);
    receiver.settled(receiver.context, 9, CITIZENSDK_OK);
    assert(revealed.size() == 1 && !resource->is_closed());
    auto value = revealed[0]();
    assert(items(value)[0].sensitive && std::get<csf::Value::Bytes>(items(value)[0].data) == csf::Value::Bytes(32, 7));
    bool repeated = false;
    try { resource->reveal([](auto) {}); } catch (const citizen_sdk::flutter::ContractFailure &error) {
      repeated = error.code == CITIZENSDK_ERROR_INVALID_STATE;
    }
    assert(repeated && reveal_calls == 1);
    resource->close([&](auto value) { closed.push_back(std::move(value)); });
    assert(cancel_calls == 1 && finish_calls == 1 && closed.empty() && !resource->is_closed());
    assert(receiver.receive(receiver.context, 9, {synthetic.data(), 32}) == CITIZENSDK_ERROR_CANCELLED);
    resource->terminal(CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED);
    assert(resource->is_closed() && terminal_calls == 1 && closed.size() == 1 && items(closed[0]()).empty());
    resource->terminal(CITIZENSDK_OK);
    assert(terminal_calls == 1);
    resource->close([&](auto value) { assert(items(value()).empty()); });
    assert(finish_calls == 1);
  }
  {
    // 已排队但尚未交付的秘密在close之后必须拒绝；不是靠mounted或延时隐藏竞态。
    std::function<csf::Value()> opened, revealed;
    bool ended = false;
    csf::PrivateKeyControls controls{
      [](auto, auto) { return CITIZENSDK_OK; },
      [](auto, auto) { return CITIZENSDK_OK; },
      [](auto, auto) { return CITIZENSDK_OK; },
    };
    auto resource = std::make_shared<csf::PrivateKeyResource>(77, "private_2",
        [&](auto value) { opened = std::move(value); }, [&](bool) { ended = true; }, controls);
    auto receiver = resource->receiver();
    receiver.settled(receiver.context, 9, CITIZENSDK_OK); resource->bind(9); (void)opened();
    resource->reveal([&](auto value) { revealed = std::move(value); });
    assert(receiver.authorizing(receiver.context, 9, 100) == CITIZENSDK_OK);
    std::vector<uint8_t> synthetic(32, 3);
    assert(receiver.receive(receiver.context, 9, {synthetic.data(), 32}) == CITIZENSDK_OK);
    receiver.settled(receiver.context, 9, CITIZENSDK_OK);
    resource->request_close();
    bool revoked = false;
    try { (void)revealed(); } catch (const citizen_sdk::flutter::ContractFailure &error) {
      revoked = error.code == CITIZENSDK_ERROR_CANCELLED;
    }
    assert(revoked && !ended && !resource->is_closed());
    resource->terminal(CITIZENSDK_ERROR_CANCELLED);
    assert(ended);
  }
  {
    // finish拒绝时保留真实所有权；重试后终态只成功交付仍等待的close，不反复返回认证错误。
    std::function<csf::Value()> opened;
    std::vector<std::function<csf::Value()>> first_close, second_close;
    bool reject_finish = true;
    csf::PrivateKeyControls controls{
      [](auto, auto) { return CITIZENSDK_OK; },
      [](auto, auto) { return CITIZENSDK_OK; },
      [&](auto, auto) { return reject_finish ? CITIZENSDK_ERROR_BUSY : CITIZENSDK_OK; },
    };
    auto resource = std::make_shared<csf::PrivateKeyResource>(77, "private_3",
        [&](auto value) { opened = std::move(value); }, [](bool) {}, controls);
    const auto receiver = resource->receiver();
    receiver.settled(receiver.context, 9, CITIZENSDK_OK); resource->bind(9); (void)opened();
    resource->close([&](auto value) { first_close.push_back(std::move(value)); });
    assert(first_close.size() == 1 && !resource->is_closed());
    bool rejected = false;
    try { (void)first_close[0](); } catch (const citizen_sdk::flutter::ContractFailure &error) { rejected = error.code == CITIZENSDK_ERROR_BUSY; }
    assert(rejected);
    reject_finish = false;
    resource->close([&](auto value) { second_close.push_back(std::move(value)); });
    assert(second_close.empty());
    resource->terminal(CITIZENSDK_ERROR_CANCELLED);
    assert(first_close.size() == 1 && second_close.size() == 1 && items(second_close[0]()).empty());
  }
  {
    // 打开失败/退出早于领取时不得向宿主发放可用资源。
    std::function<csf::Value()> opened;
    bool closed = false;
    csf::PrivateKeyControls controls{
      [](auto, auto) { return CITIZENSDK_OK; },
      [](auto, auto) { return CITIZENSDK_OK; },
      [](auto, auto) { return CITIZENSDK_OK; },
    };
    auto resource = std::make_shared<csf::PrivateKeyResource>(77, "private_4",
        [&](auto value) { opened = std::move(value); }, [&](bool granted) { assert(!granted); closed = true; }, controls);
    const auto receiver = resource->receiver();
    receiver.settled(receiver.context, 9, CITIZENSDK_OK);
    resource->request_close(); resource->bind(9);
    bool rejected = false;
    try { (void)opened(); } catch (const citizen_sdk::flutter::ContractFailure &error) { rejected = error.code == CITIZENSDK_ERROR_CANCELLED; }
    assert(rejected && !closed);
    resource->terminal(CITIZENSDK_ERROR_CANCELLED);
    assert(closed);
  }

 return 0;
}
