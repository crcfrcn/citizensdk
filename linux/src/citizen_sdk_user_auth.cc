#include "citizen_sdk_user_auth.hpp"

#include <utility>
#include <chrono>
#include <thread>
#include <cstring>
#include <gio/gio.h>
#include "citizen_sdk_input_limits.hpp"

namespace citizen_sdk::linux {
namespace {
// 凭据是实际UTF-8字节，不是授权布尔值；拒绝截断、过长、代理项及非最短编码。
// 此处只校验设备金库凭据边界，不复制Rust的BIP39派生密码规则。
bool valid_credential(citizensdk_bytes_view_t value) noexcept {
  if (value.data == nullptr || value.len < 12 ||
      value.len > input_limits::kMaximumUnlockPasswordBytes) return false;
  for (uint64_t i = 0; i < value.len;) {
    const uint8_t first = value.data[i++];
    if (first == 0) return false;
    if (first < 0x80) continue;
    uint32_t code = 0, minimum = 0;
    unsigned count = 0;
    if (first >= 0xc2 && first <= 0xdf) { code = first & 31; count = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { code = first & 15; count = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { code = first & 7; count = 3; minimum = 0x10000; }
    else return false;
    if (value.len - i < count) return false;
    while (count-- != 0) {
      const uint8_t next = value.data[i++];
      if ((next & 0xc0) != 0x80) return false;
      code = (code << 6) | (next & 63);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
}  // namespace

citizensdk_error_code_t UserAuth::configure(const citizensdk_credential_provider_v1_t *provider) {
  if (provider != nullptr && (provider->struct_size != sizeof(*provider) ||
      provider->abi_version != 1 || provider->request == nullptr || provider->cancel == nullptr ||
      provider->retain == nullptr || provider->release == nullptr || provider->idle == nullptr))
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  std::shared_ptr<Provider> previous;
  {
    std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
    std::lock_guard<std::mutex> guard(lock_);
    if ((!pending_.empty() || !biometric_.empty()) || (provider_ && provider_->value.idle(provider_->value.context) != 1))
      return CITIZENSDK_ERROR_BUSY;
    auto next = provider == nullptr ? std::shared_ptr<Provider>() : std::make_shared<Provider>(*provider);
    previous = std::move(provider_);
    provider_ = std::move(next);
  }
  // context的释放不在凭据锁下，且所有快照共同持有它至最后一个回调退出。
  previous.reset();
  return CITIZENSDK_OK;
}

bool UserAuth::available() const noexcept {
  try { std::lock_guard<std::mutex> guard(lock_); return provider_ != nullptr; }
  catch (...) { return false; }
}
bool UserAuth::idle() const noexcept {
  try {
    std::shared_ptr<Provider> provider;
    {
      std::lock_guard<std::mutex> guard(lock_);
      if ((!pending_.empty() || !biometric_.empty())) return false;
      provider = provider_;
    }
    // 不能持有callback_lock_：request可能同步回Host回包，
    // 而关闭线程正持Host锁查询idle；反向取锁会相互等待。
    return !provider || provider->value.idle(provider->value.context) == 1;
  } catch (...) { return false; }
}

// fprintd只验证当前登录用户的已登记指纹；不登记、不读取模板，也不使用密码代替。
citizensdk_error_code_t UserAuth::authorize_add_accounts(uint64_t host_operation_id) {
  if (host_operation_id == 0) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  auto cancelled = std::make_shared<std::atomic_bool>(false);
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (!biometric_.emplace(host_operation_id, cancelled).second) return CITIZENSDK_ERROR_CONFLICT;
  }
  struct Registration {
    UserAuth *owner; uint64_t id;
    ~Registration() { std::lock_guard<std::mutex> guard(owner->lock_); owner->biometric_.erase(id); }
  } registration{this, host_operation_id};
  GError *error = nullptr;
  gchar *address = g_dbus_address_get_for_bus_sync(G_BUS_TYPE_SYSTEM, nullptr, &error);
  if (error) g_error_free(error);
  if (!address) return CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
  error = nullptr;
  // 独占连接确保异常退出后Claim随连接释放，不影响其他SDK请求或宿主总线。
  auto *connection = g_dbus_connection_new_for_address_sync(address,
      static_cast<GDBusConnectionFlags>(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
                                       G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
      nullptr, nullptr, &error);
  g_free(address);
  if (error) g_error_free(error);
  if (!connection) return CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
  struct Connection {
    GDBusConnection *value;
    ~Connection() { g_dbus_connection_close_sync(value, nullptr, nullptr); g_object_unref(value); }
  } connection_owner{connection};
  auto call = [&](const char *path, const char *interface, const char *method, GVariant *arguments) {
    return g_dbus_connection_call_sync(connection, "net.reactivated.Fprint", path, interface,
        method, arguments, nullptr, G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, nullptr);
  };
  GVariant *device = call("/net/reactivated/Fprint/Manager", "net.reactivated.Fprint.Manager", "GetDefaultDevice", nullptr);
  if (!device) return CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
  const gchar *raw_path = nullptr;
  g_variant_get(device, "(&o)", &raw_path);
  const std::string path(raw_path);
  g_variant_unref(device);
  constexpr const char *interface = "net.reactivated.Fprint.Device";
  GVariant *claimed = call(path.c_str(), interface, "Claim", g_variant_new("(s)", ""));
  if (!claimed) return CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
  g_variant_unref(claimed);
  auto *context = g_main_context_new();
  g_main_context_push_thread_default(context);
  struct Result { bool done{false}; bool matched{false}; } result;
  const guint subscription = g_dbus_connection_signal_subscribe(connection,
      "net.reactivated.Fprint", interface, "VerifyStatus", path.c_str(), nullptr,
      G_DBUS_SIGNAL_FLAGS_NONE,
      [](GDBusConnection *, const gchar *, const gchar *, const gchar *, const gchar *, GVariant *parameters, gpointer data) {
        auto &state = *static_cast<Result *>(data);
        if (state.done || !g_variant_is_of_type(parameters, G_VARIANT_TYPE("(sb)"))) return;
        const gchar *status = nullptr; gboolean done = FALSE;
        g_variant_get(parameters, "(&sb)", &status, &done);
        if (done) { state.matched = std::strcmp(status, "verify-match") == 0; state.done = true; }
      }, &result, nullptr);
  GVariant *started = cancelled->load() ? nullptr :
      call(path.c_str(), interface, "VerifyStart", g_variant_new("(s)", "any"));
  const bool accepted = started != nullptr;
  if (started) g_variant_unref(started);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
  while (accepted && !result.done && !cancelled->load() && !g_dbus_connection_is_closed(connection) &&
         std::chrono::steady_clock::now() < deadline) {
    while (g_main_context_iteration(context, FALSE)) {}
    if (!result.done) std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  g_dbus_connection_signal_unsubscribe(connection, subscription);
  // 停止及Release都要执行；认证成功从来不作为下一次请求的缓存。
  if (accepted) { if (auto *stopped = call(path.c_str(), interface, "VerifyStop", nullptr)) g_variant_unref(stopped); }
  if (auto *released = call(path.c_str(), interface, "Release", nullptr)) g_variant_unref(released);
  while (g_main_context_iteration(context, FALSE)) {}
  g_main_context_pop_thread_default(context);
  g_main_context_unref(context);
  if (cancelled->load() || (accepted && !result.done)) return CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED;
  return accepted && result.done && result.matched ? CITIZENSDK_OK : CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
}

AuthenticationResult UserAuth::create_vault_password(uint64_t host_operation_id) {
  return request(1, host_operation_id);
}
AuthenticationResult UserAuth::unlock_vault_password(uint64_t host_operation_id) {
  return request(2, host_operation_id);
}

AuthenticationResult UserAuth::request(uint32_t key_purpose, uint64_t host_operation_id) {
  if (host_operation_id == 0) return {CITIZENSDK_ERROR_INVALID_ARGUMENT, {}};
  auto pending = std::make_shared<Pending>();
  {
    std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
    std::shared_ptr<Provider> provider;
    {
      std::lock_guard<std::mutex> guard(lock_);
      if (!provider_) return {CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, {}};
      if (!pending_.emplace(host_operation_id, pending).second)
        return {CITIZENSDK_ERROR_CONFLICT, {}};
      provider = provider_;
    }
    const citizensdk_credential_challenge_v1_t challenge{
        sizeof(citizensdk_credential_challenge_v1_t), 1, host_operation_id, key_purpose, 0};
    try { provider->value.request(provider->value.context, &challenge); }
    catch (...) {
      // 异常不能留下等待者或已经同步交付的凭据。
      cancel(host_operation_id);
    }
  }
  std::unique_lock<std::mutex> guard(lock_);
  pending->ready.wait(guard, [&] { return pending->done; });
  AuthenticationResult result = std::move(pending->result);
  pending_.erase(host_operation_id);
  return result;
}

citizensdk_error_code_t UserAuth::respond(
    uint64_t host_operation_id, citizensdk_bytes_view_t credential) {
  std::lock_guard<std::mutex> guard(lock_);
  const auto found = pending_.find(host_operation_id);
  if (found == pending_.end() || found->second->done) return CITIZENSDK_ERROR_INVALID_STATE;
  auto &pending = *found->second;
  const bool cancelled = credential.data == nullptr && credential.len == 0;
  if (!cancelled && !valid_credential(credential)) {
    pending.result.code = CITIZENSDK_ERROR_INVALID_ARGUMENT;
  } else if (cancelled) {
    pending.result.code = CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED;
  } else {
    try {
      pending.result.password = SensitiveBuffer(credential.data, static_cast<std::size_t>(credential.len));
      pending.result.code = CITIZENSDK_OK;
    } catch (...) { pending.result.code = CITIZENSDK_ERROR_INTERNAL; }
  }
  pending.done = true;
  pending.ready.notify_all();
  return pending.result.code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED
      ? CITIZENSDK_OK : pending.result.code;
}

citizensdk_error_code_t UserAuth::cancel(uint64_t host_operation_id) {
  std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
  std::shared_ptr<Provider> provider;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (const auto biometric = biometric_.find(host_operation_id); biometric != biometric_.end()) {
      biometric->second->store(true);
      return CITIZENSDK_OK;
    }
    const auto found = pending_.find(host_operation_id);
    if (found == pending_.end()) return CITIZENSDK_ERROR_INVALID_STATE;
    // 撤销优先于尚未被工作线程领取的成功回包；迟到/重复回包不能恢复它。
    found->second->result.password.clear();
    found->second->result.code = CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED;
    found->second->done = true;
    found->second->ready.notify_all();
    provider = provider_;
  }
  try { if (provider) provider->value.cancel(provider->value.context, host_operation_id); }
  catch (...) {}  // 宿主UI取消异常不得重新开放凭据交付。
  return CITIZENSDK_OK;
}

void UserAuth::cancel_all() {
  std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
  std::vector<uint64_t> ids;
  {
    std::lock_guard<std::mutex> guard(lock_);
    ids.reserve(pending_.size());
    for (const auto &entry : pending_) ids.push_back(entry.first);
    for (const auto &entry : biometric_) entry.second->store(true);
  }
  for (const auto id : ids) (void)cancel(id);
}

}  // namespace citizen_sdk::linux
