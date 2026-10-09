#include <cassert>
#include <algorithm>
#include <future>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include "citizen_sdk/citizen_sdk_error.hpp"
#include "citizen_sdk_flutter_sessions.hpp"
#include "citizen_sdk_flutter_test_support.hpp"

#ifdef NDEBUG
#error "CitizenSDK Flutter session contract assertions must remain enabled"
#endif

namespace csf = citizen_sdk::flutter;

namespace {

using citizen_sdk::flutter::test::items;
using citizen_sdk::flutter::test::text;
using citizen_sdk::flutter::test::FakeTransport;
using citizen_sdk::flutter::test::request;
using citizen_sdk::flutter::test::drain_tasks;

void close_guard_contract() {
  const auto rejects = [](bool attempted, citizensdk_lifecycle_t state,
                          citizensdk_error_code_t status, citizensdk_handle_t core,
                          citizensdk_error_code_t expected) {
    bool rejected = false;
    try { (void)csf::allow_close_without_core(attempted, state, status, core); }
    catch (const citizen_sdk::Error &error) { rejected = error.code() == expected; }
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
}  // namespace


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
    if (fail_close) throw citizen_sdk::Error(CITIZENSDK_ERROR_UNAVAILABLE, "合成纹理暂未注销");
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
        assert(host == 55 && purpose == 1 && value->struct_size == sizeof(*value) && value->abi_version == 1);
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
          if (fail_texture) throw citizen_sdk::Error(CITIZENSDK_ERROR_UNAVAILABLE, "合成注册失败");
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
    const citizensdk_qr_frame_v1_t value{sizeof(citizensdk_qr_frame_v1_t), 1, 2, 2, 0, 0, 1,
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
    try { (void)project(); } catch (const citizen_sdk::Error &error) { rejected = error.code() == code; }
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
    try { p.close(); } catch (const citizen_sdk::Error &) { rejected = true; }
    assert(rejected && !p.resource->is_closed());
    p.texture->fail_close = false; p.close(); p.native_finished(); p.pump();
    p.texture->drained(); p.pump();
    assert(p.finished == 1 && p.closings.size() == 1); // 注销失败可重试，不提前释放。
  }
  {
    CaptureBindingFixture p; p.open(); p.publish();
    for (int i = 0; i < 64; ++i) p.command(csf::Method::pause_qr_capture);
    bool full = false;
    try { p.command(csf::Method::resume_qr_capture); } catch (const citizen_sdk::Error &error) { full = error.code() == CITIZENSDK_ERROR_QUEUE_FULL; }
    assert(full); p.close(); p.native_finished(); p.pump(); p.texture->drained(); p.pump();
    assert(p.resource->is_closed() && p.controls.size() == 64 && p.closings.size() == 1);
    for (const auto &project : p.controls) fails(project, CITIZENSDK_ERROR_CANCELLED);
  }
}
}  // namespace

int main() {
  {
    // 参数错误发生在已接纳外壳之后；使用真实Core序号状态验证后续查询，而非平台计数夹具。
    std::vector<std::function<void()>> queue;
    const auto native = std::make_shared<FakeTransport>();
    const auto sessions = csf::Sessions::create([](uint32_t) { return csf::OpenEnvironment{}; },
        [&](std::function<void()> work) { queue.push_back(std::move(work)); },
        [native](const citizen_sdk::Config &) { return native; });
    csf::Reply opened;
    sessions->dispatch(request(csf::Method::open, {}, 0), [&](csf::Reply value) { opened = std::move(value); });
    assert(opened.success);
    const auto id = text(items(opened.value)[1]);
    auto invalid = csf::to_encodable_value(csf::Value::list({csf::Value::integer(2), csf::Value::string(id), csf::Value::integer(1)}));
    const auto envelope = csf::decode_request_envelope("getStorageKeysPaged", &invalid);
    assert(envelope);
    sessions->accept_request_sequence(*envelope);
    bool rejected = false;
    try { (void)csf::decode_request("getStorageKeysPaged", &invalid); }
    catch (const csf::ContractFailure &) { rejected = true; }
    assert(rejected);
    sessions->accept_request_sequence({id, 2});
    csf::Reply snapshot;
    sessions->dispatch(request(csf::Method::get_capabilities, id, 2), [&](csf::Reply value) { snapshot = std::move(value); });
    assert(snapshot.success);
    rejected = false;
    try { sessions->accept_request_sequence({id, 2}); }
    catch (const csf::ContractFailure &error) { rejected = error.code == CITIZENSDK_ERROR_CONFLICT; }
    assert(rejected);
    sessions->accept_request_sequence({id, 3});
    csf::Reply closed;
    sessions->dispatch(request(csf::Method::close, id, 3), [&](csf::Reply value) { closed = std::move(value); });
    drain_tasks(queue);
    assert(closed.success);
  }

  capture_binding_contract();

  for (const bool detach : {false, true}) {
    // 同一Sessions真实路由等待采集与图库终态；有限transport不运行相机/链/金库。
    std::vector<std::function<void()>> queue;
    auto native = std::make_shared<FakeTransport>();
    std::function<void(std::function<csf::Value()>)> decode_completed;
    int close_requests = 0;
    native->capture_handler = [&](const csf::DecodedRequest &r, csf::PrivateKeyResource::Completion completion) {
      if (r.method == csf::Method::open_qr_capture) {
        native->capture_closed = false;
        completion([] { return csf::Value::list({csf::Value::string("capture_test"), csf::Value::integer(23),
            csf::Value::integer(2), csf::Value::integer(2), csf::Value::integer(0)}); });
      } else {
        assert(r.method == csf::Method::qr_decode_image);
        decode_completed = std::move(completion);
      }
    };
    native->close_capture_handler = [&] { ++close_requests; };
    auto sessions = csf::Sessions::create([](uint32_t) { return csf::OpenEnvironment{}; },
        [&](std::function<void()> work) { queue.push_back(std::move(work)); },
        [native](const citizen_sdk::Config &) { return native; });
    csf::Reply opened;
    sessions->dispatch(request(csf::Method::open, {}, 0), [&](csf::Reply value) { opened = std::move(value); });
    const auto id = text(items(opened.value)[1]);
    bool capture_reply = false, decode_reply = false, close_reply = false;
    auto capture = request(csf::Method::open_qr_capture, id, 1); capture.qr_purpose = 1;
    sessions->dispatch(capture, [&](csf::Reply value) { assert(value.success); capture_reply = true; });
    drain_tasks(queue); assert(capture_reply && native->accepted.empty());
    auto decode = request(csf::Method::qr_decode_image, id, 2); decode.payload = {1}; decode.qr_purpose = 1;
    sessions->dispatch(decode, [&](csf::Reply value) { assert(value.success); decode_reply = true; });
    if (detach) sessions->detach();
    else sessions->dispatch(request(csf::Method::close, id, 3), [&](csf::Reply value) { assert(value.success); close_reply = true; });
    assert(close_requests > 0 && sessions->session_count() == 1 && native->closed == 0 && native->retired == 0);
    decode_completed([] { return csf::Value::list({csf::Value::list({})}); });
    drain_tasks(queue);
    assert(sessions->session_count() == 1 && !close_reply && decode_reply == !detach);
    native->capture_closed = true;
    native->resource_observer("", csf::Value::list({})); drain_tasks(queue);
    assert(sessions->session_count() == 0);
    assert(close_reply == !detach && native->closed == (detach ? 0 : 1) && native->retired == (detach ? 1 : 0));
  }


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
    assert(receiver.struct_size == sizeof(receiver) && receiver.abi_version == 1);
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
    try { resource->reveal([](auto) {}); } catch (const citizen_sdk::Error &error) {
      repeated = error.code() == CITIZENSDK_ERROR_INVALID_STATE;
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
    try { (void)revealed(); } catch (const citizen_sdk::Error &error) {
      revoked = error.code() == CITIZENSDK_ERROR_CANCELLED;
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
    try { (void)first_close[0](); } catch (const citizen_sdk::Error &error) { rejected = error.code() == CITIZENSDK_ERROR_BUSY; }
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
    try { (void)opened(); } catch (const citizen_sdk::Error &error) { rejected = error.code() == CITIZENSDK_ERROR_CANCELLED; }
    assert(rejected && !closed);
    resource->terminal(CITIZENSDK_ERROR_CANCELLED);
    assert(closed);
  }
  (void)csf::event("s", 1, "privateKeyClosed", csf::Value::list({csf::Value::string("private_1")}));

  {
    // 合成Core投影只验证生产会话路由；不把它作为真实审阅、签名或码图的验收。
    std::vector<std::function<void()>> queue;
    auto native = std::make_shared<FakeTransport>();
    native->projection_handler = [](csf::Method method) {
      if (method == csf::Method::review_qr_request)
        return csf::Value::list({csf::Value::string("review-owned"), csf::Value::string("{}")});
      assert(method == csf::Method::sign_qr_request);
      return csf::Value::list({csf::Value::string("{}"), csf::Value::integer(1),
          csf::Value::integer(1), csf::Value::bytes({255})});
    };
    auto sessions = csf::Sessions::create(
        [](uint32_t) { return csf::OpenEnvironment{}; },
        [&](std::function<void()> work) { queue.push_back(std::move(work)); },
        [native](const citizen_sdk::Config &) { return native; });
    csf::Reply opened;
    sessions->dispatch(request(csf::Method::open, {}, 0), [&](csf::Reply value) { opened = std::move(value); });
    const auto id = text(items(opened.value)[1]);
    auto review = request(csf::Method::review_qr_request, id, 1);
    review.qr_text = "synthetic";
    sessions->dispatch(review, [&](csf::Reply value) {
      assert(value.success && text(items(items(value.value)[3])[0]) == "review-owned");
    });
    auto signing = request(csf::Method::sign_qr_request, id, 2);
    signing.resource_id = "review-owned";
    sessions->dispatch(signing, [&](csf::Reply value) {
      assert(value.success && items(items(value.value)[3]).size() == 4);
    });
    assert((native->accepted == std::vector<csf::Method>{
        csf::Method::review_qr_request, csf::Method::sign_qr_request}));
    native->projection_handler = [](csf::Method) -> csf::Value {
      throw citizen_sdk::Error(CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED, "synthetic cancellation");
    };
    signing.sequence = 3;
    sessions->dispatch(signing, [&](csf::Reply value) {
      assert(!value.success && value.error_code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED);
    });
    auto release = request(csf::Method::release_qr_review, id, 4);
    release.resource_id = "review-owned";
    native->control_handler = [](const csf::DecodedRequest &r) {
      assert(r.method == csf::Method::release_qr_review && r.resource_id == "review-owned");
      return csf::Value::list({});
    };
    sessions->dispatch(release, [&](csf::Reply value) { assert(value.success); });
    assert(native->released_results == 3);
    sessions->dispatch(request(csf::Method::close, id, 5), [&](csf::Reply value) { assert(value.success); });
    drain_tasks(queue);
  }

  {
    // 取消接纳不能结束原Future；直到真实终态到达，关闭和结果所有权都必须保留。
    std::vector<std::function<void()>> queue;
    auto native = std::make_shared<FakeTransport>();
    native->defer_history = true;
    native->complete_on_cancel = false;
    auto sessions = csf::Sessions::create(
        [](uint32_t) { return csf::OpenEnvironment{}; },
        [&](std::function<void()> work) { queue.push_back(std::move(work)); },
        [native](const citizen_sdk::Config &) { return native; });
    csf::Reply opened;
    sessions->dispatch(request(csf::Method::open, {}, 0), [&](csf::Reply value) { opened = std::move(value); });
    const auto id = text(items(opened.value)[1]);
    bool finished = false;
    sessions->dispatch(request(csf::Method::get_transaction_history, id, 1),
        [&](csf::Reply value) { finished = value.success; });
    auto cancel = request(csf::Method::cancel_operation, id, 2);
    cancel.resource_id = "1";
    sessions->dispatch(cancel, [&](csf::Reply value) {
      assert(value.success && std::get<bool>(items(items(value.value)[3])[0].data));
    });
    assert(native->cancelled == 1 && !finished && native->released_results == 0);
    cancel.sequence = 3; cancel.resource_id = "99";
    sessions->dispatch(cancel, [&](csf::Reply value) {
      assert(value.success && !std::get<bool>(items(items(value.value)[3])[0].data));
    });
    native->complete_deferred();
    assert(!finished && native->released_results == 0);
    drain_tasks(queue);
    assert(finished && native->released_results == 1 && native->copied_results == 1);
    cancel.sequence = 4; cancel.resource_id = "1";
    sessions->dispatch(cancel, [&](csf::Reply value) {
      assert(value.success && !std::get<bool>(items(items(value.value)[3])[0].data));
    });
    sessions->dispatch(request(csf::Method::close, id, 5), [&](csf::Reply value) { assert(value.success); });
    drain_tasks(queue);
  }

  {
    // 只替换本次明确需要的同步Core输入结果；会话校验/序号/错误映射仍运行生产路径。
    std::vector<std::function<void()>> pending;
    auto native = std::make_shared<FakeTransport>();
    auto sessions = csf::Sessions::create(
        [](uint32_t) { return csf::OpenEnvironment{}; },
        [&](std::function<void()> work) { pending.push_back(std::move(work)); },
        [native](const citizen_sdk::Config &) { return native; });
    csf::Reply opened;
    sessions->dispatch(request(csf::Method::open, {}, 0), [&](csf::Reply value) { opened = std::move(value); });
    assert(opened.success);
    const auto id = text(items(opened.value)[1]);
    auto password = request(csf::Method::validate_wallet_password, id, 1);
    password.password.emplace(std::string("synthetic"));
    native->control_handler = [](const csf::DecodedRequest &input) {
      assert(input.method == csf::Method::validate_wallet_password && input.password &&
             input.password->value.size() == 9);
      return csf::Value::list({csf::Value::integer(7), csf::Value::null()});
    };
    csf::Reply validation;
    sessions->dispatch(password, [&](csf::Reply value) { validation = std::move(value); });
    assert(validation.success && std::get<int64_t>(items(items(validation.value)[3])[0].data) == 7);
    assert(native->accepted.empty());
    password.sequence = 2;
    native->control_handler = [](const csf::DecodedRequest &) -> csf::Value {
      throw citizen_sdk::Error(CITIZENSDK_ERROR_UNAVAILABLE, "synthetic provider failure");
    };
    sessions->dispatch(password, [&](csf::Reply value) {
      assert(!value.success && value.error_code == CITIZENSDK_ERROR_UNAVAILABLE);
    });
    auto resource = request(csf::Method::copy_recovery_phrase, id, 3);
    resource.resource_id = "not-owned";
    native->control_handler = [](const csf::DecodedRequest &input) -> csf::Value {
      assert(input.resource_id == "not-owned");
      throw citizen_sdk::Error(CITIZENSDK_ERROR_NOT_FOUND, "synthetic missing resource");
    };
    sessions->dispatch(resource, [&](csf::Reply value) {
      assert(!value.success && value.error_code == CITIZENSDK_ERROR_NOT_FOUND);
    });
    resource.sequence = 4;
    native->control_handler = [](const csf::DecodedRequest &) {
      return csf::Value::list({csf::Value::sensitive_bytes(std::vector<uint8_t>(1025))});
    };
    sessions->dispatch(resource, [&](csf::Reply value) {
      assert(!value.success && value.error_code == CITIZENSDK_ERROR_INTEGRITY);
    });
    auto released = request(csf::Method::release_prepared_wallet, id, 5);
    released.resource_id = "synthetic";
    native->control_handler = [](const csf::DecodedRequest &input) {
      assert(input.method == csf::Method::release_prepared_wallet);
      return csf::Value::list({});
    };
    sessions->dispatch(released, [&](csf::Reply value) {
      assert(value.success && items(items(value.value)[3]).empty());
    });
    sessions->dispatch(request(csf::Method::close, id, 6), [&](csf::Reply value) { assert(value.success); });
    drain_tasks(pending);
  }

  {
    // 只替代OS/Core执行器；凭据关联、事件、回包、关闭均运行生产Sessions状态机。
    std::vector<std::function<void()>> credential_queue;
    std::vector<decltype(citizen_sdk::Config::credentialProvider)> providers;
    std::vector<std::shared_ptr<FakeTransport>> natives;
    std::vector<csf::Value> events;
    auto credential_sessions = csf::Sessions::create(
        [](uint32_t) { return csf::OpenEnvironment{}; },
        [&](std::function<void()> work) { credential_queue.push_back(std::move(work)); },
        [&](const citizen_sdk::Config &config) {
          providers.push_back(config.credentialProvider);
          auto native = std::make_shared<FakeTransport>();
          natives.push_back(native);
          return native;
        });
    credential_sessions->listen([&](csf::Value value) { events.push_back(std::move(value)); });
    auto open = request(csf::Method::open, {}, 0);
    open.has_credential_provider = true;
    csf::Reply first_open, second_open;
    credential_sessions->dispatch(open, [&](csf::Reply value) { first_open = std::move(value); });
    credential_sessions->dispatch(open, [&](csf::Reply value) { second_open = std::move(value); });
    assert(first_open.success && second_open.success && providers.size() == 2);
    assert(providers[0] && providers[1]);
    const auto first = text(items(first_open.value)[1]);
    const auto second = text(items(second_open.value)[1]);
    std::promise<void> cancel_first;
    citizen_sdk::CredentialChallenge challenge{71, "unlock", std::nullopt,
                                               cancel_first.get_future().share()};
    auto future = providers[0](challenge);
    drain_tasks(credential_queue);
    bool seen = false;
    for (const auto &event : events) {
      const auto &fields = items(event);
      if (text(fields[3]) == "credentialRequest") {
        assert(text(fields[1]) == first);
        const auto &payload = items(fields[4]);
        assert(payload.size() == 3 && text(payload[0]) == "71" && text(payload[1]) == "unlock");
        seen = true;
      }
    }
    assert(seen);
    auto response = request(csf::Method::respond_credential, second, 1);
    response.host_operation_id = 71;
    response.credential.emplace(std::vector<uint8_t>(12, 'a'));
    csf::Reply wrong_host;
    credential_sessions->dispatch(response, [&](csf::Reply value) { wrong_host = std::move(value); });
    assert(!wrong_host.success && wrong_host.error_code == CITIZENSDK_ERROR_INVALID_STATE);
    response.session = first;
    csf::Reply delivered;
    credential_sessions->dispatch(response, [&](csf::Reply value) { delivered = std::move(value); });
    assert(delivered.success && items(items(delivered.value)[3]).empty());
    auto bytes = future.get();
    assert(bytes && *bytes == std::vector<uint8_t>(12, 'a'));
    std::fill(bytes->begin(), bytes->end(), 0);
    response.sequence = 2;
    csf::Reply duplicate;
    credential_sessions->dispatch(response, [&](csf::Reply value) { duplicate = std::move(value); });
    assert(!duplicate.success && duplicate.error_code == CITIZENSDK_ERROR_INVALID_STATE);

    std::promise<void> cancel_second;
    challenge.host_operation_id = 72;
    challenge.cancelled = cancel_second.get_future().share();
    auto pending = providers[0](challenge);
    drain_tasks(credential_queue);
    natives[0]->credential_cancel = [&](uint64_t id) {
      assert(id == 72); cancel_second.set_value();
    };
    auto cancel = request(csf::Method::cancel_credential, first, 3);
    cancel.host_operation_id = 72;
    csf::Reply cancelled;
    credential_sessions->dispatch(cancel, [&](csf::Reply value) { cancelled = std::move(value); });
    assert(cancelled.success && !pending.get());
    drain_tasks(credential_queue);
    assert(natives[0]->credential_cancellations == std::vector<uint64_t>{72});
    response.host_operation_id = 72; response.sequence = 4;
    credential_sessions->dispatch(response, [&](csf::Reply value) {
      assert(!value.success && value.error_code == CITIZENSDK_ERROR_INVALID_STATE);
    });

    // 关闭失败保留同一session；取消已撤销的挑战不能被下一次关闭复活。
    std::promise<void> cancel_close;
    challenge.host_operation_id = 73;
    challenge.cancelled = cancel_close.get_future().share();
    auto during_close = providers[0](challenge);
    drain_tasks(credential_queue);
    natives[0]->credential_cancel = [&](uint64_t id) {
      assert(id == 73); cancel_close.set_value();
    };
    natives[0]->fail_close = true;
    credential_sessions->dispatch(request(csf::Method::close, first, 5), [&](csf::Reply value) {
      assert(!value.success && value.error_code == CITIZENSDK_ERROR_STORAGE);
    });
    assert(!during_close.get());
    drain_tasks(credential_queue);
    assert(credential_sessions->session_count() == 2);
    natives[0]->fail_close = false;
    credential_sessions->dispatch(request(csf::Method::close, first, 6), [&](csf::Reply value) {
      assert(value.success);
    });

    // 没有事件通道就没有可交付的输入交互，实际提供者结果必须取消。
    credential_sessions->cancel_events();
    std::promise<void> never_cancelled;
    challenge.host_operation_id = 74;
    challenge.cancelled = never_cancelled.get_future().share();
    auto without_sink = providers[1](challenge);
    drain_tasks(credential_queue);
    assert(!without_sink.get());
    credential_sessions->dispatch(request(csf::Method::close, second, 2), [&](csf::Reply value) {
      assert(value.success);
    });
    assert(credential_sessions->session_count() == 0);
  }



  {
    // 审阅签名已是普通Core请求；detach请求取消，但真实完成之前必须保有transport。
    std::vector<std::function<void()>> queue;
    auto native = std::make_shared<FakeTransport>();
    native->defer_signing = true;
    native->complete_on_cancel = false;
    auto sessions = csf::Sessions::create(
        [](uint32_t) { return csf::OpenEnvironment{}; },
        [&](std::function<void()> work) { queue.push_back(std::move(work)); },
        [native](const citizen_sdk::Config &) { return native; });
    csf::Reply opened;
    sessions->dispatch(request(csf::Method::open, {}, 0), [&](csf::Reply value) { opened = std::move(value); });
    const auto id = text(items(opened.value)[1]);
    bool replied = false;
    auto signing = request(csf::Method::sign_qr_request, id, 1);
    signing.resource_id = "review-test";
    sessions->dispatch(signing, [&](csf::Reply) { replied = true; });
    sessions->detach();
    assert(native->cancelled == 1 && native->retired == 0 && !replied);
    native->complete_deferred();
    drain_tasks(queue);
    assert(native->retired == 1 && !replied && sessions->session_count() == 0);
    assert(native->copied_results == 0 && native->released_results == 1);
  }
  {
    // 未 open、未 listen：验签直接访问纯 Core，环境及原生资源工厂必须均为零次。
    int environments = 0;
    int transports = 0;
    auto isolated = csf::Sessions::create(
        [&](uint32_t) { ++environments; return csf::OpenEnvironment{}; },
        [](std::function<void()> work) { work(); },
        [&](const citizen_sdk::Config &) {
          ++transports; return std::make_shared<FakeTransport>();
        });
    auto verification = request(csf::Method::verify_signature, "", 0);
    constexpr uint8_t public_key[] = {
        0x2a,0xfb,0xa9,0x27,0x8e,0x30,0xcc,0xf6,0xa6,0xce,0xb3,0xa8,0xb6,0xe3,0x36,0xb7,
        0x00,0x68,0xf0,0x45,0xc6,0x66,0xf2,0xe7,0xf4,0xf9,0xcc,0x5f,0x47,0xdb,0x89,0x72};
    for (std::size_t i = 0; i < sizeof(public_key); ++i)
      verification.account_id.bytes[i] = public_key[i];
    verification.signature.resize(64);
    verification.signature.back() = 0x80;  // 编码有效但不匹配该账户的签名。
    csf::Reply verified;
    isolated->dispatch(verification, [&](csf::Reply value) { verified = std::move(value); });
    assert(verified.success && items(verified.value).size() == 2);
    assert(std::get<int64_t>(items(verified.value)[0].data) == csf::kProtocolVersion);
    assert(!std::get<bool>(items(verified.value)[1].data));
    verification.signature.resize(63);
    isolated->dispatch(verification, [&](csf::Reply value) { verified = std::move(value); });
    assert(!verified.success && verified.error_code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(std::holds_alternative<std::monostate>(items(verified.value)[1].data));
    assert(std::holds_alternative<std::monostate>(items(verified.value)[2].data));
    assert(environments == 0 && transports == 0 && isolated->session_count() == 0);
  }
  close_guard_contract();
  std::vector<std::function<void()>> queue;
  auto native = std::make_shared<FakeTransport>();
  uint32_t received_modules = 0;
  auto sessions = csf::Sessions::create(
      [&](uint32_t modules) { received_modules = modules; return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [&](const citizen_sdk::Config &config) { assert(config.modules == received_modules); return native; });

  csf::Reply opened;
  csf::DecodedRequest open;
  open.method = csf::Method::open;
  open.modules = CITIZENSDK_MODULE_SIGNING;
  sessions->dispatch(open, [&](csf::Reply value) { opened = std::move(value); });
  assert(opened.success && sessions->session_count() == 1);
  assert(received_modules == CITIZENSDK_MODULE_SIGNING);
  const auto &wire = items(opened.value);
  assert(wire.size() == 4 && text(wire[1]).size() == 32);
  assert(text(items(wire[3])[0]) == "created");
  assert(std::get<int64_t>(items(wire[3])[1].data) == 1);
  const std::string session = text(wire[1]);

  // A valid but non-CREATED lifecycle is not a valid open response. Reject it
  // natively and retire once, before Dart can lose an unknown session ID.
  auto invalid_initial_native = std::make_shared<FakeTransport>();
  invalid_initial_native->lifecycle = CITIZENSDK_LIFECYCLE_RUNNING;
  auto invalid_initial = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [invalid_initial_native](const citizen_sdk::Config &) { return invalid_initial_native; });
  csf::Reply invalid_initial_reply;
  int invalid_initial_replies = 0;
  invalid_initial->dispatch(open, [&](csf::Reply value) {
    invalid_initial_reply = std::move(value); ++invalid_initial_replies;
  });
  assert(!invalid_initial_reply.success &&
         invalid_initial_reply.error_code == CITIZENSDK_ERROR_INTEGRITY);
  assert(invalid_initial_replies == 1 && invalid_initial->session_count() == 0);
  assert(invalid_initial_native->retired == 1);
  invalid_initial->detach();
  assert(invalid_initial_native->retired == 1);

  int event_count = 0;
  sessions->listen([&](csf::Value event) {
    assert(items(event).size() == 5);
    ++event_count;
  });
  assert(event_count == 2); // initial lifecycle + capabilities snapshots

  // Exercise every non-open/close method against the production routing
  // state machine. Synchronous capabilities and the three Win32 flows are the
  // only methods which intentionally do not directly enter Core here.
  const std::vector<csf::Method> methods = {
      csf::Method::start, csf::Method::stop, csf::Method::get_capabilities,
      csf::Method::get_finalized_head, csf::Method::get_genesis_hash,
      csf::Method::get_account_balance, csf::Method::get_account_balances,
      csf::Method::get_account_nonce, csf::Method::get_fee_snapshot,
      csf::Method::get_wallet_state, csf::Method::prepare_wallet_creation,
      csf::Method::import_wallet, csf::Method::add_wallet_accounts,
      csf::Method::set_active_wallet_account, csf::Method::rename_wallet,
      csf::Method::delete_account, csf::Method::delete_wallet,
      csf::Method::reconcile_wallet_cleanup, csf::Method::sign_wallet_payload,
      csf::Method::get_transaction_history, csf::Method::sync_transaction_history,
  };
  int64_t sequence = 1;
  int replies = 0;
  for (const auto method : methods) {
    auto call = request(method, session, sequence++);
    sessions->dispatch(std::move(call), [&](csf::Reply value) {
      assert(value.success); ++replies;
    });
  }
  assert(replies == static_cast<int>(methods.size()));
  assert(native->genesis_queries == 1);
  assert(native->copied_results == native->released_results);

  // Event cancellation changes epoch without closing sessions. A queued old
  // generation notification therefore cannot reach the replacement sink.
  citizensdk_event_t lifecycle{};
  lifecycle.struct_size = sizeof(lifecycle); lifecycle.abi_version = CITIZENSDK_ABI_VERSION;
  lifecycle.event_type = CITIZENSDK_EVENT_LIFECYCLE_CHANGED;
  native->observer(lifecycle);
  sessions->cancel_events();
  sessions->listen([&](csf::Value) { ++event_count; });
  const auto after_relisten = event_count;
  drain_tasks(queue);
  assert(event_count == after_relisten);

  // Close cancels an accepted history request, waits for its terminal result, then
  // checkpoints a running Core and destroys Host. It does not claim rollback
  // of durable history.
  native->defer_history = true;
  native->lifecycle = CITIZENSDK_LIFECYCLE_RUNNING;
  auto history = request(csf::Method::get_transaction_history, session, sequence++);
  csf::Reply history_reply;
  sessions->dispatch(history, [&](csf::Reply value) { history_reply = std::move(value); });
  bool close_replied = false;
  sessions->dispatch(request(csf::Method::close, session, sequence++),
                     [&](csf::Reply value) { close_replied = value.success; });
  assert(history_reply.success && native->cancelled == 1);
  assert(close_replied && native->closed == 1 && sessions->session_count() == 0);
  assert(native->accepted.back() == csf::Method::stop);

  sessions->detach();
  sessions->detach(); // idempotent; a closed Host is not retired again
  assert(native->retired == 0);

  // A close failure is reported but leaves the exact same native session
  // usable for a monotonic retry; it must not be silently retired or erased.
  auto failing_native = std::make_shared<FakeTransport>();
  failing_native->fail_close = true;
  auto retryable = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [failing_native](const citizen_sdk::Config &) { return failing_native; });
  csf::Reply retry_open;
  retryable->dispatch(open, [&](csf::Reply value) { retry_open = std::move(value); });
  const std::string retry_id = text(items(retry_open.value)[1]);
  failing_native->fail_accept = true;
  csf::Reply rejected_request;
  retryable->dispatch(request(csf::Method::get_finalized_head, retry_id, 1),
                      [&](csf::Reply value) { rejected_request = std::move(value); });
  assert(!rejected_request.success &&
         rejected_request.error_code == CITIZENSDK_ERROR_NETWORK);
  assert(retryable->session_count() == 1);
  failing_native->fail_accept = false;
  csf::Reply failed_close;
  retryable->dispatch(request(csf::Method::close, retry_id, 2),
                      [&](csf::Reply value) { failed_close = std::move(value); });
  assert(!failed_close.success && failed_close.error_code == CITIZENSDK_ERROR_STORAGE);
  assert(retryable->session_count() == 1 && failing_native->retired == 0);
  failing_native->fail_close = false;
  bool retried = false;
  retryable->dispatch(request(csf::Method::close, retry_id, 3),
                      [&](csf::Reply value) { retried = value.success; });
  assert(retried && retryable->session_count() == 0 && failing_native->closed == 1);

  // checkpoint 请求被拒时不能擦除 session，也不能虚构 Host 已关闭。
  auto checkpoint_native = std::make_shared<FakeTransport>();
  auto checkpoint = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [checkpoint_native](const citizen_sdk::Config &) { return checkpoint_native; });
  csf::Reply checkpoint_open;
  checkpoint->dispatch(open, [&](csf::Reply value) { checkpoint_open = std::move(value); });
  const auto checkpoint_id = text(items(checkpoint_open.value)[1]);
  checkpoint_native->lifecycle = CITIZENSDK_LIFECYCLE_RUNNING;
  checkpoint_native->fail_accept = true;
  csf::Reply checkpoint_close;
  checkpoint->dispatch(request(csf::Method::close, checkpoint_id, 1),
                       [&](csf::Reply value) { checkpoint_close = std::move(value); });
  assert(!checkpoint_close.success && checkpoint_close.error_code == CITIZENSDK_ERROR_NETWORK &&
         checkpoint->session_count() == 1 && checkpoint_native->closed == 0);
  checkpoint_native->fail_accept = false;
  checkpoint->dispatch(request(csf::Method::close, checkpoint_id, 2),
                       [&](csf::Reply value) { checkpoint_close = std::move(value); });
  assert(checkpoint_close.success && checkpoint->session_count() == 0);

  auto cancel_native = std::make_shared<FakeTransport>();
  cancel_native->defer_history = true;
  cancel_native->fail_cancel = true;
  auto cancelling = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [cancel_native](const citizen_sdk::Config &) { return cancel_native; });
  csf::Reply cancel_open;
  cancelling->dispatch(open, [&](csf::Reply value) { cancel_open = std::move(value); });
  const auto cancel_id = text(items(cancel_open.value)[1]);
  bool cancelled_history_replied = false;
  cancelling->dispatch(request(csf::Method::get_transaction_history, cancel_id, 1),
                        [&](csf::Reply value) { cancelled_history_replied = value.success; });
  csf::Reply cancel_close;
  cancelling->dispatch(request(csf::Method::close, cancel_id, 2),
                        [&](csf::Reply value) { cancel_close = std::move(value); });
  assert(!cancel_close.success && cancel_close.error_code == CITIZENSDK_ERROR_BUSY &&
         !cancelled_history_replied && cancelling->session_count() == 1);
  cancel_native->fail_cancel = false;
  cancelling->dispatch(request(csf::Method::close, cancel_id, 3),
                        [&](csf::Reply value) { cancel_close = std::move(value); });
  assert(cancel_close.success && cancelled_history_replied && cancelling->session_count() == 0);

  // Engine detach revokes a pending response and transfers the still-live
  // Host graph exactly once; it never invents a successful native completion.
  auto orphan_native = std::make_shared<FakeTransport>();
  orphan_native->defer_history = true;
  auto orphan = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [orphan_native](const citizen_sdk::Config &) { return orphan_native; });
  csf::Reply orphan_open;
  orphan->dispatch(open, [&](csf::Reply value) { orphan_open = std::move(value); });
  const std::string orphan_id = text(items(orphan_open.value)[1]);
  bool orphan_replied = false;
  orphan->dispatch(request(csf::Method::get_transaction_history, orphan_id, 1),
                   [&](csf::Reply) { orphan_replied = true; });
  orphan->detach();
  orphan->detach();
  assert(!orphan_replied && orphan_native->cancelled == 1 &&
         orphan_native->retired == 0 && orphan->session_count() == 1);
  drain_tasks(queue);
  assert(!orphan_replied && orphan_native->retired == 1 &&
         orphan->session_count() == 0);

  // The mutation gate is process-wide, not a per-session or per-plugin lock.
  // Keep reconciliation in its EMPTY -> wallet-state read window and
  // prove another Flutter engine receives BUSY rather than interleaving.
  auto gate_native_a = std::make_shared<FakeTransport>();
  auto gate_native_b = std::make_shared<FakeTransport>();
  gate_native_a->defer_profile = true;
  gate_native_a->complete_on_cancel = false;
  auto gate_a = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [gate_native_a](const citizen_sdk::Config &) { return gate_native_a; });
  auto gate_b = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [gate_native_b](const citizen_sdk::Config &) { return gate_native_b; });
  csf::Reply gate_open_a, gate_open_b;
  gate_a->dispatch(open, [&](csf::Reply value) { gate_open_a = std::move(value); });
  gate_b->dispatch(open, [&](csf::Reply value) { gate_open_b = std::move(value); });
  const auto gate_id_a = text(items(gate_open_a.value)[1]);
  const auto gate_id_b = text(items(gate_open_b.value)[1]);
  bool delete_finished = false;
  gate_a->dispatch(request(csf::Method::reconcile_wallet_cleanup, gate_id_a, 1),
                   [&](csf::Reply value) { delete_finished = value.success; });
  assert(!delete_finished && gate_native_a->deferred_id != 0);
  assert(gate_native_a->accepted.back() == csf::Method::get_wallet_state);
  assert(gate_native_a->public_methods.back() == csf::Method::reconcile_wallet_cleanup);
  csf::Reply competing;
  gate_b->dispatch(request(csf::Method::rename_account, gate_id_b, 1),
                   [&](csf::Reply value) { competing = std::move(value); });
  assert(!competing.success && competing.error_code == CITIZENSDK_ERROR_BUSY);
  assert(gate_native_b->accepted.empty());
  gate_a->detach();
  assert(gate_native_a->retired == 0 && gate_a->session_count() == 1);
  csf::Reply still_competing;
  gate_b->dispatch(request(csf::Method::rename_account, gate_id_b, 2),
                   [&](csf::Reply value) { still_competing = std::move(value); });
  assert(!still_competing.success && still_competing.error_code == CITIZENSDK_ERROR_BUSY);
  gate_native_a->complete_deferred();
  // The callback queued only owning data; drain it on the captured UI thread.
  drain_tasks(queue);
  assert(!delete_finished && gate_native_a->retired == 1 && gate_a->session_count() == 0);
  csf::Reply gate_released;
  gate_b->dispatch(request(csf::Method::rename_account, gate_id_b, 3),
                   [&](csf::Reply value) { gate_released = std::move(value); });
  assert(gate_released.success && gate_native_b->accepted.size() == 1);
  gate_b->detach();

  // Windows 特有两阶段退休：有限替身只注入 Host 状态，重试许可执行上方生产守门。
  // Core 已消失但 UI 两次 BUSY 时保留 session；不得提前返回 disposed 或恢复新操作。
  auto partial_native = std::make_shared<FakeTransport>();
  partial_native->busy_closes = 2;
  auto partial = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [partial_native](const citizen_sdk::Config &) { return partial_native; });
  csf::Reply partial_open;
  partial->dispatch(open, [&](csf::Reply value) { partial_open = std::move(value); });
  const auto partial_id = text(items(partial_open.value)[1]);
  csf::Reply partial_close;
  partial->dispatch(request(csf::Method::close, partial_id, 1),
                    [&](csf::Reply value) { partial_close = std::move(value); });
  assert(!partial_close.success && partial_close.error_code == CITIZENSDK_ERROR_BUSY &&
         !partial_native->core_present && partial->session_count() == 1);
  int64_t partial_sequence = 2;
  for (const auto method : {csf::Method::get_capabilities, csf::Method::start,
                             csf::Method::prepare_wallet_creation}) {
    csf::Reply denied;
    partial->dispatch(request(method, partial_id, partial_sequence++),
                      [&](csf::Reply value) { denied = std::move(value); });
    assert(!denied.success && denied.error_code == CITIZENSDK_ERROR_INVALID_STATE);
  }
  partial->dispatch(request(csf::Method::close, partial_id, partial_sequence++),
                    [&](csf::Reply value) { partial_close = std::move(value); });
  assert(!partial_close.success && partial_close.error_code == CITIZENSDK_ERROR_BUSY &&
         partial->session_count() == 1 && partial_native->closed == 0);
  partial->dispatch(request(csf::Method::close, partial_id, partial_sequence++),
                    [&](csf::Reply value) { partial_close = std::move(value); });
  assert(partial_close.success && partial->session_count() == 0 && partial_native->closed == 1 &&
         text(items(items(partial_close.value)[3])[0]) == "disposed");

  auto absent_native = std::make_shared<FakeTransport>();
  absent_native->core_present = false;
  auto absent = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [absent_native](const citizen_sdk::Config &) { return absent_native; });
  csf::Reply absent_open;
  absent->dispatch(open, [&](csf::Reply value) { absent_open = std::move(value); });
  assert(!absent_open.success && absent_open.error_code == CITIZENSDK_ERROR_NOT_READY &&
         absent->session_count() == 0 && absent_native->retired == 1);

  // 重复 completion 仍由 transport 各自释放，但同一请求只复制一次、回复一次。
  auto duplicate_native = std::make_shared<FakeTransport>();
  duplicate_native->duplicate_completion = true;
  auto duplicate = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; },
      [&](std::function<void()> work) { queue.push_back(std::move(work)); },
      [duplicate_native](const citizen_sdk::Config &) { return duplicate_native; });
  csf::Reply duplicate_open;
  duplicate->dispatch(open, [&](csf::Reply value) { duplicate_open = std::move(value); });
  const auto duplicate_id = text(items(duplicate_open.value)[1]);
  int duplicate_replies = 0;
  duplicate->dispatch(request(csf::Method::get_finalized_head, duplicate_id, 1),
                      [&](csf::Reply value) { assert(value.success); ++duplicate_replies; });
  assert(duplicate_replies == 1 && duplicate_native->copied_results == 1 &&
         duplicate_native->released_results == 2);
  duplicate_native->fail_copy = true;
  csf::Reply copy_failure;
  duplicate->dispatch(request(csf::Method::rename_wallet, duplicate_id, 2),
                      [&](csf::Reply value) { copy_failure = std::move(value); });
  assert(!copy_failure.success && copy_failure.error_code == CITIZENSDK_ERROR_INTEGRITY);
  duplicate_native->fail_copy = false;
  duplicate->dispatch(request(csf::Method::rename_wallet, duplicate_id, 3),
                      [&](csf::Reply value) { assert(value.success); ++duplicate_replies; });
  assert(duplicate_replies == 2); // 失败复制已释放进程级变更门，不留下 BUSY。
  int throwing_replies = 0;
  bool reply_threw = false;
  try {
    duplicate->dispatch(request(csf::Method::get_capabilities, duplicate_id, 4),
                        [&](csf::Reply) { ++throwing_replies; throw std::runtime_error("synthetic reply"); });
  } catch (const std::runtime_error &) { reply_threw = true; }
  assert(reply_threw && throwing_replies == 1);
  csf::Reply repeated_sequence;
  duplicate->dispatch(request(csf::Method::get_capabilities, duplicate_id, 4),
                      [&](csf::Reply value) { repeated_sequence = std::move(value); });
  assert(!repeated_sequence.success && repeated_sequence.error_code == CITIZENSDK_ERROR_CONFLICT);
  duplicate->dispatch(request(csf::Method::get_capabilities, duplicate_id, 5),
                      [](csf::Reply value) { assert(value.success); });
  duplicate->detach();

  // 原生线程仅复制公开值并排队；关闭回复、事件和 session map 始终在创建线程处理。
  citizen_sdk::flutter::test::FiniteScheduler main_queue;
  auto worker_native = std::make_shared<FakeTransport>();
  worker_native->defer_profile = true;
  auto worker_sessions = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; }, main_queue.scheduler(),
      [worker_native](const citizen_sdk::Config &) { return worker_native; });
  csf::Reply worker_open;
  worker_sessions->dispatch(open, [&](csf::Reply value) { worker_open = std::move(value); });
  const auto worker_id = text(items(worker_open.value)[1]);
  const auto main_thread = std::this_thread::get_id();
  int worker_replies = 0;
  worker_sessions->dispatch(request(csf::Method::get_wallet_state, worker_id, 1),
      [&](csf::Reply value) {
        assert(std::this_thread::get_id() == main_thread && value.success);
        ++worker_replies;
      });
  main_queue.fail_next();
  std::thread completion_thread([&] { worker_native->complete_deferred(); });
  completion_thread.join();
  assert(worker_replies == 0 && worker_native->released_results == 1);
  // 模拟一次 UI 入队分配失败；下次 dispatch 从 route 中保留的 owning copy 恢复。
  worker_sessions->dispatch(request(csf::Method::get_capabilities, worker_id, 2),
                            [](csf::Reply value) { assert(value.success); });
  assert(worker_replies == 1);
  main_queue.drain();
  worker_sessions->detach();

  // detach只能取消真实准备请求，终态之前不能放开进程变更门或释放transport。
  auto pending_wallet_native = std::make_shared<FakeTransport>();
  pending_wallet_native->defer_prepared = true;
  pending_wallet_native->complete_on_cancel = false;
  auto pending_wallet = csf::Sessions::create(
      [](uint32_t) { return csf::OpenEnvironment{}; }, main_queue.scheduler(),
      [pending_wallet_native](const citizen_sdk::Config &) { return pending_wallet_native; });
  csf::Reply pending_open;
  pending_wallet->dispatch(open, [&](csf::Reply value) { pending_open = std::move(value); });
  const auto pending_id = text(items(pending_open.value)[1]);
  bool wallet_replied = false;
  pending_wallet->dispatch(request(csf::Method::prepare_wallet_creation, pending_id, 1),
                           [&](csf::Reply) { wallet_replied = true; });
  pending_wallet->detach();
  assert(!wallet_replied && pending_wallet_native->cancelled == 1 &&
         pending_wallet_native->retired == 0 && pending_wallet->session_count() == 1);
  pending_wallet_native->complete_deferred();
  main_queue.drain();
  assert(!wallet_replied && pending_wallet_native->retired == 1 && pending_wallet->session_count() == 0);
  return 0;
}
