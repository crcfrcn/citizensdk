// 非UI凭据与真实Win32隐藏消息派发合同；合成凭据不冒充真实TPM验收。
#include <windows.h>
#include <array>
#include <atomic>
#include <cassert>
#include <chrono>
#include <functional>
#include <future>
#include <thread>
#include "citizen_sdk_user_auth.hpp"
#include "citizen_sdk_window.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif
namespace csw = citizen_sdk::windows;
namespace {
void pump_until(const std::function<bool()> &complete) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!complete()) {
    assert(std::chrono::steady_clock::now() < deadline);
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      assert(message.message != WM_QUIT);
      TranslateMessage(&message); DispatchMessageW(&message);
    }
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 5, QS_ALLINPUT);
  }
}
HWND parent_window() {
  HWND parent = CreateWindowExW(0, L"STATIC", L"CitizenSDK contract owner",
      WS_OVERLAPPEDWINDOW, 0, 0, 700, 700, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  assert(parent != nullptr);
  return parent;
}
}  // namespace

int main() {
  const auto ui = std::this_thread::get_id();
  {
    csw::WindowRef inert(nullptr, ui, false);
    csw::UserAuth auth;
    assert(!auth.available());
    assert(auth.unlock_vault_password(71).code == CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED);
    std::thread worker([&] { assert(inert.retire() == CITIZENSDK_OK); });
    worker.join();
  }
  HWND parent = parent_window();
  csw::WindowRef reference(parent, ui);
  assert(reference.on_ui_thread());
  {
    auto lease = reference.acquire();
    assert(lease.valid() && lease.get() == parent);
    assert(reference.set(nullptr) == CITIZENSDK_ERROR_BUSY);
    csw::WindowLease moved(std::move(lease));
    assert(!lease.valid() && moved.valid());
  }
  std::thread wrong_thread([&] {
    assert(reference.set(parent) == CITIZENSDK_ERROR_BUSY);
    assert(!reference.acquire().valid());
  });
  wrong_thread.join();
  // SDK认证不再依赖父窗口；窗口仍只验证下面的线程派发/销毁归属。
  csw::UserAuth auth;
  struct Provider final {
    csw::UserAuth *auth;
    uint64_t operation{};
    uint32_t purpose{};
    unsigned references{}, cancellations{};
    bool busy{false};
    std::promise<void> requested;
  } provider{&auth};
  citizensdk_credential_provider_v1_t callbacks{
      sizeof(citizensdk_credential_provider_v1_t), 1, &provider,
      +[](void *context, const citizensdk_credential_challenge_v1_t *request) {
        auto &provider = *static_cast<Provider *>(context);
        provider.operation = request->host_operation_id;
        provider.purpose = request->key_purpose;
        provider.requested.set_value();
      },
      +[](void *context, uint64_t id) {
        auto &provider = *static_cast<Provider *>(context);
        assert(id == provider.operation);
        ++provider.cancellations;
      },
      +[](void *context) { ++static_cast<Provider *>(context)->references; },
      +[](void *context) { --static_cast<Provider *>(context)->references; },
      +[](void *context) -> uint8_t { return static_cast<Provider *>(context)->busy ? 0 : 1; }};
  assert(auth.configure(&callbacks) == CITIZENSDK_OK && provider.references == 1);
  const auto receive = [&](bool create, uint64_t id) {
    provider.requested = std::promise<void>();
    auto requested = provider.requested.get_future();
    auto result = std::async(std::launch::async, [&auth, create, id] {
      return create ? auth.create_vault_password(id) : auth.unlock_vault_password(id);
    });
    assert(requested.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    assert(provider.operation == id && provider.purpose == (create ? 1U : 2U));
    return result;
  };
  auto unlock = receive(false, 71);
  assert(!auth.idle());
  assert(auth.cancel(72) == CITIZENSDK_ERROR_INVALID_STATE);
  assert(auth.cancel(71) == CITIZENSDK_OK);
  std::array<uint8_t, 12> synthetic{};
  synthetic.fill('a');
  assert(auth.respond(71, {synthetic.data(), synthetic.size()}) == CITIZENSDK_ERROR_INVALID_STATE);
  auto cancelled = unlock.get();
  assert(cancelled.code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED && cancelled.password.empty());
  assert(provider.cancellations == 1);

  auto create = receive(true, 72);
  assert(auth.respond(72, {synthetic.data(), synthetic.size()}) == CITIZENSDK_OK);
  auto created = create.get();
  assert(created.code == CITIZENSDK_OK && created.password.size() == synthetic.size());
  synthetic.fill(0);
  assert(created.password.data()[0] == 'a');
  created.password.clear();
  provider.busy = true;
  assert(!auth.idle()); // 原生等待已返回，提供者资源未排空时仍不能释放context。
  assert(auth.configure(nullptr) == CITIZENSDK_ERROR_BUSY);
  provider.busy = false;
  assert(auth.configure(nullptr) == CITIZENSDK_OK && provider.references == 0);
  assert(DestroyWindow(parent));
  parent = nullptr;
  assert(!reference.acquire().valid());
  // 只有显式 set(nullptr) 才允许重新开启 rootless，而不是把销毁的 owner 偷换为空。
  assert(reference.set(nullptr) == CITIZENSDK_OK);
  {
    auto rootless = reference.acquire();
    assert(rootless.valid() && rootless.get() == nullptr);
    std::atomic<bool> invoked{false};
    std::thread worker([&] { assert(rootless.invoke([&] { invoked.store(true); })); });
    worker.join();
    assert(!invoked.load());
    pump_until([&] { return invoked.load(); });
  }
  citizensdk_error_code_t first_retire{};
  std::thread retire([&] { first_retire = reference.retire(); });
  retire.join();
  assert(first_retire == CITIZENSDK_ERROR_BUSY);
  assert(!reference.available());
  assert(reference.retire() == CITIZENSDK_OK);
  assert(reference.retire() == CITIZENSDK_OK);
  assert(!reference.invoke([] {}));
  return 0;
}
