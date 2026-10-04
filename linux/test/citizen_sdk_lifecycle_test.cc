// 验证实际服务租约与关闭接纳使用同一个单调状态机；旧SDK窗口token已删除。
#include <cassert>
#include <condition_variable>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>

#include "citizen_sdk_lifecycle.hpp"
#include "citizen_sdk/citizen_sdk.hpp"

#ifndef CITIZENSDK_LINUX_TEST_SOURCE_DIR
#error "CITIZENSDK_LINUX_TEST_SOURCE_DIR must point at the Linux source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif

int main() {
  // 只测试 Core 公共 JSON 的结构投影，业务校验与真实签名仍只由 Rust 测试覆盖。
  assert(citizen_sdk::detail::qr_public_field(
      R"({"kind":5,"canonical_text":"QR_\u00561"})", "canonical_text", 2331) == "QR_V1");
  bool rejected_duplicate = false;
  try { (void)citizen_sdk::detail::qr_public_field(
      R"({"canonical_text":"a","canonical_text":"b"})", "canonical_text", 2331); }
  catch (const citizen_sdk::Error &) { rejected_duplicate = true; }
  assert(rejected_duplicate);


  using citizen_sdk::linux::HostError;
  using citizen_sdk::linux::Lifecycle;

  Lifecycle lifecycle;
  assert(lifecycle.begin_close());
  bool concurrent_close_busy = false;
  try { (void)lifecycle.begin_close(); }
  catch (const HostError &error) { concurrent_close_busy = error.code() == CITIZENSDK_ERROR_BUSY; }
  assert(concurrent_close_busy);
  lifecycle.cancel_close(false);
  lifecycle.begin_service(); lifecycle.finish_service();
  assert(lifecycle.begin_close());
  lifecycle.cancel_close(true);
  bool teardown_rejected_service = false;
  try { lifecycle.begin_service(); }
  catch (const HostError &error) { teardown_rejected_service = error.code() == CITIZENSDK_ERROR_INVALID_STATE; }
  assert(teardown_rejected_service);
  assert(lifecycle.begin_close()); lifecycle.commit_closed();
  assert(!lifecycle.begin_close());

  // 模拟 worker 正在等 宿主凭据：service 只持租约、不持状态机锁。
  // UI 仍可查询状态并立即取得 BUSY；worker 返回后正常关闭且关闭期间
  // 禁止新 provider admission。CTEST timeout 会捕捉持锁等待回归。
  Lifecycle services;
  std::mutex service_lock;
  std::condition_variable service_ready;
  bool entered = false;
  bool release_service = false;
  std::thread provider([&] {
    services.begin_service();
    {
      std::unique_lock<std::mutex> guard(service_lock);
      entered = true;
      service_ready.notify_all();
      service_ready.wait(guard, [&] { return release_service; });
    }
    services.finish_service();
  });
  {
    std::unique_lock<std::mutex> guard(service_lock);
    service_ready.wait(guard, [&] { return entered; });
  }
  bool active_service_busy = false;
  try {
    (void)services.begin_close();
  } catch (const HostError &error) {
    active_service_busy = error.code() == CITIZENSDK_ERROR_BUSY;
  }
  assert(active_service_busy);
  {
    std::lock_guard<std::mutex> guard(service_lock);
    release_service = true;
  }
  service_ready.notify_all();
  provider.join();
  assert(services.begin_close());
  bool closing_rejected_service = false;
  try {
    services.begin_service();
  } catch (const HostError &error) {
    closing_rejected_service = error.code() == CITIZENSDK_ERROR_INVALID_STATE;
  }
  assert(closing_rejected_service);
  services.cancel_close(false);
  services.begin_service();
  services.finish_service();
  assert(services.begin_close());
  services.commit_closed();
  bool closed_rejected_service = false;
  try {
    services.begin_service();
  } catch (const HostError &error) {
    closed_rejected_service = error.code() == CITIZENSDK_ERROR_INVALID_STATE;
  }
  assert(closed_rejected_service);

  // 多个实际服务必须分别排空，归还其中一个不能提前释放Host。
  Lifecycle multiple;
  multiple.begin_service(); multiple.begin_service();
  multiple.finish_service();
  bool remaining_busy = false;
  try { (void)multiple.begin_close(); }
  catch (const HostError &error) { remaining_busy = error.code() == CITIZENSDK_ERROR_BUSY; }
  assert(remaining_busy);
  multiple.finish_service();
  assert(multiple.begin_close()); multiple.commit_closed();
  assert(!multiple.begin_close());

  const auto read = [](const char *relative) {
    const std::string path = std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
                             relative;
    std::ifstream stream(path, std::ios::binary);
    assert(stream.good());
    return std::string((std::istreambuf_iterator<char>(stream)),
                       std::istreambuf_iterator<char>());
  };
  const std::string host_api = read("/src/citizen_sdk_host_api.cc");
  const std::string host_bridge =
      read("/src/citizen_sdk_host_bridge.cc");
  const std::string cpp_api =
      read("/citizen_sdk/citizen_sdk.hpp");
  const auto wallet_index_guard =
      host_bridge.find("value.wallet_index == 0");
  const auto secret_index_guard = host_bridge.find(
      "value.wallet_index == 0", wallet_index_guard + 1);
  assert(wallet_index_guard != std::string::npos &&
         secret_index_guard != std::string::npos);
  assert(host_api.find("citizensdk_host_abandon") != std::string::npos);
  assert(host_api.find("citizensdk_stop(sdk") != std::string::npos);
  assert(host_api.find("std::min(delay * 2") != std::string::npos);

  // 显式 destroy 遇到另一个 API lease 立即 BUSY，绝不在 callback/GTK
  // 线程等待；abandon 则让 supervisor 保留完整对象图，待 lease 退出。
  assert(host_api.find("class HostLease final") != std::string::npos);
  assert(host_api.find("(!include_retiring && found->second->retiring)") !=
         std::string::npos);
  assert(host_api.find("++found->second->active_calls") !=
         std::string::npos);
  assert(host_api.find("--entry_->active_calls") != std::string::npos);
  assert(host_api.find(
             "if (!abandon && entry->active_calls != 1) return CITIZENSDK_ERROR_BUSY") !=
         std::string::npos);
  assert(host_api.find("registry_idle") == std::string::npos);
  const auto supervisor = host_api.find("void supervise_abandoned_host(");
  const auto supervisor_admission = host_api.find(
      "entry->abandoned && entry->active_calls == 0", supervisor);
  const auto supervisor_close = host_api.find("host->close()", supervisor_admission);
  assert(supervisor != std::string::npos &&
         supervisor_admission != std::string::npos &&
         supervisor_close != std::string::npos &&
         supervisor < supervisor_admission &&
         supervisor_admission < supervisor_close);
  const auto abandonment = host_api.find("citizensdk_error_code_t citizensdk_host_abandon(");
  const auto detached = host_api.find("supervisor.detach()", abandonment);
  const auto committed = host_api.find("host.entry()->abandoned = true", detached);
  assert(abandonment != std::string::npos && detached != std::string::npos &&
         committed != std::string::npos && detached < committed);
  std::size_t leased_entry_points = 0;
  std::size_t lease_cursor = 0;
  while ((lease_cursor = host_api.find("auto host = acquire_host(",
                                       lease_cursor)) != std::string::npos) {
    ++leased_entry_points;
    ++lease_cursor;
  }
  // 采集和普通请求都沿同一Host服务租约，不再有SDK窗口入口。
  assert(leased_entry_points == 14);
  const auto capture_entry = host_api.find("citizensdk_host_open_qr_capture(");
  const auto capture_lease = host_api.find("auto host = acquire_host(", capture_entry);
  const auto capture_call = host_api.find("open_qr_capture(", capture_lease);
  assert(capture_entry != std::string::npos && capture_lease != std::string::npos &&
         capture_call != std::string::npos && capture_entry < capture_lease && capture_lease < capture_call);
  const auto retirement = host_api.find("begin_retirement(host_handle, host, false)");
  const auto host_close = host_api.find("code = host->close()", retirement);
  const auto registry_erase = host_api.find("registry().erase(found)", host_close);
  assert(retirement != std::string::npos && host_close != std::string::npos &&
         registry_erase != std::string::npos && retirement < host_close &&
         host_close < registry_erase);
  // close 已成功时，只读 abandon probe 可以暂持 shared_ptr lease；不能
  // 因其计数不是 1 就遗留一个再也无法取得的 retiring registry entry。
  assert(host_api.substr(host_close, registry_erase - host_close).find(
             "active_calls != 1") == std::string::npos);

  // HostBridge 不跨 root ABI 调用持有 call_lock_；Core 销毁成功后才按
  // Vault -> secure store -> public store 的顺序退休宿主资源。
  const auto foreign_boundary = host_bridge.find(
      "Never hold call_lock_ across that foreign boundary");
  const auto lifecycle_query =
      host_bridge.find("citizensdk_get_lifecycle(sdk", foreign_boundary);
  const auto unsubscribe = host_bridge.find(
      "citizensdk_unsubscribe_capability_changes(sdk)", lifecycle_query);
  const auto clear_core_callback = host_bridge.find(
      "citizensdk_set_event_callback(sdk, nullptr, nullptr)", unsubscribe);
  const auto destroy_core =
      host_bridge.find("citizensdk_destroy(sdk)", clear_core_callback);
  const auto retire_services =
      host_bridge.find("services_retired_ = true", destroy_core);
  const auto retire_vault = host_bridge.find("vault_.reset()", retire_services);
  const auto retire_secure =
      host_bridge.find("secure_store_->close()", retire_vault);
  const auto retire_public =
      host_bridge.find("if (public_store_) public_store_->close()", retire_secure);
  assert(foreign_boundary != std::string::npos &&
         lifecycle_query != std::string::npos &&
         unsubscribe != std::string::npos &&
         clear_core_callback != std::string::npos &&
         destroy_core != std::string::npos &&
         retire_services != std::string::npos &&
         retire_vault != std::string::npos &&
         retire_secure != std::string::npos &&
         retire_public != std::string::npos &&
         foreign_boundary < lifecycle_query && lifecycle_query < unsubscribe &&
         unsubscribe < clear_core_callback &&
         clear_core_callback < destroy_core && destroy_core < retire_services &&
         retire_services < retire_vault && retire_vault < retire_secure &&
         retire_secure < retire_public);
  assert(host_bridge.find(
             "callback_thread_ == std::this_thread::get_id()") !=
         std::string::npos);

  const auto close_noexcept = cpp_api.find("void close_noexcept() noexcept");
  const auto clear = cpp_api.find(
      "citizensdk_host_set_event_callback(host_, nullptr, nullptr)",
      close_noexcept);
  const auto first_abandon = cpp_api.find(
      "const auto abandon = citizensdk_host_abandon(host_)", clear);
  const auto reset = cpp_api.find("event_context_.reset()", first_abandon);
  const auto destroy =
      cpp_api.find("citizensdk_host_destroy(host_)", reset);
  const auto second_abandon = cpp_api.find(
      "const auto abandon = citizensdk_host_abandon(host_)", destroy);
  assert(close_noexcept != std::string::npos && clear != std::string::npos &&
         first_abandon != std::string::npos && reset != std::string::npos &&
         destroy != std::string::npos && second_abandon != std::string::npos);
  assert(close_noexcept < clear && clear < first_abandon &&
         first_abandon < reset && reset < destroy &&
         destroy < second_abandon);
  assert(cpp_api.find("std::terminate()", first_abandon) < reset);
  assert(cpp_api.find("std::terminate()", second_abandon) !=
         std::string::npos);
  assert(cpp_api.find("event_context_.release()") == std::string::npos);
  assert(cpp_api.find("abandon_delay") == std::string::npos);

  const auto trampoline = cpp_api.find("inline void event_trampoline");
  const auto result_scope = cpp_api.find(
      "EventResultScope result_owner(event->result)", trampoline);
  const auto observer = cpp_api.find("if (observer) observer(*event)",
                                     result_scope);
  assert(trampoline != std::string::npos && result_scope != std::string::npos &&
         observer != std::string::npos && result_scope < observer);
  assert(cpp_api.find("(void)citizensdk_result_release(value)") !=
         std::string::npos);
  return 0;
}
