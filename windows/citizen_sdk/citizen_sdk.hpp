#ifndef CITIZENSDK_CPP_HPP
#define CITIZENSDK_CPP_HPP

#include <exception>
#include <algorithm>
#include <iterator>
#include <future>
#include <type_traits>
#include "citizensdk_qr_image.h"
#include <limits>
#include <memory>
#include <atomic>
#include <map>
#include <mutex>
#include <thread>
#include <string>
#include <utility>
#include "citizen_sdk/citizen_sdk_config.hpp"
#include "citizen_sdk/citizen_sdk_error.hpp"
#include "citizen_sdk/citizen_sdk_events.hpp"
#include "citizen_sdk/citizen_sdk_models.hpp"

namespace citizen_sdk {

template <class T> class Operation final {
 public:
  Operation(std::string id, std::shared_future<T> result, std::function<bool()> cancel)
      : id_(std::move(id)), result_(std::move(result)), cancel_(std::move(cancel)) {}
  const std::string &operationId() const noexcept { return id_; }
  const std::shared_future<T> &result() const noexcept { return result_; }
  bool cancel() const { return cancel_(); }
 private:
  std::string id_;
  std::shared_future<T> result_;
  std::function<bool()> cancel_;
};
class Host;
class SecretBytes;
class WalletInspection;
class PreparedWallet;
class RecoveryPhrase;
class PrivateKey;
class QrReview;
class QrCapture;

namespace detail {

// 非UI Future适配只拥有异步结果和可撤销关联；真正认证仍由Host原金库执行。
struct CredentialProviderState final {
  struct Pending final {
    std::promise<void> cancelled;
    bool revoked{false};
  };
  citizensdk_host_handle_t host{};
  decltype(Config::credentialProvider) provide;
  std::mutex lock;
  std::map<uint64_t, std::shared_ptr<Pending>> pending;
};
struct CredentialProviderBox final {
  std::atomic<uint32_t> references{1};
  std::shared_ptr<CredentialProviderState> state;
};
inline void release_credential_provider(void *raw) noexcept {
  auto *box = static_cast<CredentialProviderBox *>(raw);
  if (box->references.fetch_sub(1) == 1) delete box;
}
inline void install_credential_provider(citizensdk_host_handle_t host,
                                         const Config &config) {
  if (!config.credentialProvider) return;
  auto state = std::make_shared<CredentialProviderState>();
  state->host = host;
  state->provide = config.credentialProvider;
  auto *box = new CredentialProviderBox();
  box->state = state;
  citizensdk_credential_provider_v1_t provider{
      sizeof(citizensdk_credential_provider_v1_t), 1, box,
      +[](void *raw, const citizensdk_credential_challenge_v1_t *request) {
        const auto state = static_cast<CredentialProviderBox *>(raw)->state;
        if (request == nullptr || request->struct_size != sizeof(*request) ||
            request->abi_version != 1 || request->host_operation_id == 0 ||
            request->reserved != 0 || (request->key_purpose != 1 && request->key_purpose != 2))
          throw Error(CITIZENSDK_ERROR_INTEGRITY, "Credential challenge is invalid");
        auto pending = std::make_shared<CredentialProviderState::Pending>();
        CredentialChallenge challenge;
        challenge.host_operation_id = request->host_operation_id;
        challenge.key_purpose = request->key_purpose == 1 ? "create" : "unlock";
        challenge.cancelled = pending->cancelled.get_future().share();
        {
          std::lock_guard<std::mutex> guard(state->lock);
          if (!state->pending.emplace(challenge.host_operation_id, pending).second)
            throw Error(CITIZENSDK_ERROR_CONFLICT, "Credential challenge is already active");
        }
        try {
          std::thread([state, pending, challenge] {
            struct CredentialBytes final {
              std::optional<std::vector<uint8_t>> value;
              ~CredentialBytes() {
                if (!value) return;
                volatile uint8_t *data = value->data();
                for (std::size_t i = 0; i < value->size(); ++i) data[i] = 0;
              }
            } bytes;
            bool invoke = false;
            {
              std::lock_guard<std::mutex> guard(state->lock);
              invoke = !pending->revoked;
            }
            if (invoke) {
              try { bytes.value = state->provide(challenge).get(); }
              catch (...) { bytes.value.reset(); } // 不传播可能带秘密的宿主异常文案。
            }
            bool deliver = false;
            {
              std::lock_guard<std::mutex> guard(state->lock);
              deliver = !pending->revoked;
            }
            if (deliver) {
              // 不持有适配器锁反调Host，避免关闭->idle和回包之间的锁顺序倒置。
              const uint8_t nonnull_empty = 0;
              const citizensdk_bytes_view_t view = bytes.value
                  ? citizensdk_bytes_view_t{
                      bytes.value->empty() ? &nonnull_empty : bytes.value->data(),
                      static_cast<uint64_t>(bytes.value->size())}
                  : citizensdk_bytes_view_t{nullptr, 0};
              (void)citizensdk_host_respond_credential(
                  state->host, challenge.host_operation_id, view);
            }
            // 先清零结果再报告排空；取消通知绝不伪造提供者Future完成。
            if (bytes.value) {
              volatile uint8_t *data = bytes.value->data();
              for (std::size_t i = 0; i < bytes.value->size(); ++i) data[i] = 0;
              bytes.value.reset();
            }
            std::lock_guard<std::mutex> guard(state->lock);
            state->pending.erase(challenge.host_operation_id);
          }).detach();
        } catch (...) {
          std::lock_guard<std::mutex> guard(state->lock);
          state->pending.erase(challenge.host_operation_id);
          throw;
        }
      },
      +[](void *raw, uint64_t id) {
        const auto state = static_cast<CredentialProviderBox *>(raw)->state;
        std::lock_guard<std::mutex> guard(state->lock);
        const auto found = state->pending.find(id);
        if (found == state->pending.end() || found->second->revoked) return;
        found->second->revoked = true;
        found->second->cancelled.set_value();
      },
      +[](void *raw) {
        auto *box = static_cast<CredentialProviderBox *>(raw);
        if (box->references.fetch_add(1) == std::numeric_limits<uint32_t>::max())
          std::terminate();
      },
      release_credential_provider,
      +[](void *raw) -> uint8_t {
        const auto state = static_cast<CredentialProviderBox *>(raw)->state;
        std::lock_guard<std::mutex> guard(state->lock);
        return state->pending.empty() ? 1 : 0;
      }};
  const auto code = citizensdk_host_set_credential_provider(host, &provider);
  release_credential_provider(box); // 成功时Host已经retain；失败时释放唯一所有权。
  throw_if_error(code, "CitizenSDK credential provider registration failed");
}


struct RequestBox final {
  std::atomic<uint32_t> references{1};
  std::function<citizensdk_error_code_t(citizensdk_handle_t, citizensdk_request_id_t *)> accept;
  std::function<void(citizensdk_request_id_t, citizensdk_result_handle_t)> complete;
  std::function<void(citizensdk_handle_t)> cancel;
};
inline void release_request_box(void *raw) noexcept {
  auto *box = static_cast<RequestBox *>(raw);
  const auto previous = box->references.fetch_sub(1);
  if (previous == 0) std::terminate();
  if (previous == 1) delete box;
}

inline citizensdk_error_code_t submit_request(
    citizensdk_host_handle_t host,
      std::function<citizensdk_error_code_t(citizensdk_handle_t, citizensdk_request_id_t *)> accept,
      std::function<void(citizensdk_request_id_t, citizensdk_result_handle_t)> complete,
      std::function<void(citizensdk_handle_t)> cancel,
      citizensdk_request_id_t *out) {
    if (!accept || !complete || out == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    *out = 0;
    auto *box = new detail::RequestBox();
    box->accept = std::move(accept);
    box->complete = std::move(complete);
    box->cancel = std::move(cancel);
    const citizensdk_host_request_v1_t callbacks{
      sizeof(citizensdk_host_request_v1_t), CITIZENSDK_HOST_ABI_VERSION, box,
      +[](void *raw, citizensdk_handle_t core, citizensdk_request_id_t *request) -> citizensdk_error_code_t {
        auto *state = static_cast<detail::RequestBox *>(raw);
        // Core已同步复制输入后立即释放接纳闭包，避免秘密输入随整个异步请求驻留。
        auto function = std::move(state->accept);
        try { return function(core, request); }
        catch (const Error &error) { return error.code(); }
        catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
      },
      +[](void *raw, citizensdk_request_id_t request, citizensdk_result_handle_t result) {
        static_cast<detail::RequestBox *>(raw)->complete(request, result);
      },
      +[](void *raw, citizensdk_handle_t core) {
        auto *state = static_cast<detail::RequestBox *>(raw);
        if (state->cancel) state->cancel(core);
      },
      +[](void *raw) {
        auto *state = static_cast<detail::RequestBox *>(raw);
        if (state->references.fetch_add(1) == std::numeric_limits<uint32_t>::max()) std::terminate();
      },
      detail::release_request_box};
    const auto code = citizensdk_host_submit_request(host, &callbacks, out);
    detail::release_request_box(box);
    return code;
  }


struct EventContext final {
  std::mutex lock;
  EventObserver observer;
};

struct EventResultScope final {
  explicit EventResultScope(citizensdk_result_handle_t value) noexcept
      : value(value) {}
  EventResultScope(const EventResultScope &) = delete;
  EventResultScope &operator=(const EventResultScope &) = delete;
  ~EventResultScope() {
    if (value != 0) (void)citizensdk_result_release(value);
  }
  citizensdk_result_handle_t value{};
};


// 仅管理C++绑定的公开资源/Promise，不拥有第二个Core、请求调度器或业务状态机。
struct OwnedResource {
  virtual ~OwnedResource() = default;
  virtual void release() = 0;
  virtual unsigned resource_kind() const noexcept = 0;
  virtual bool is_released() const noexcept = 0;
};
struct AsyncOwner final {
  AsyncOwner(citizensdk_host_handle_t host, citizensdk_handle_t core) : host(host), core(core) {}
  const citizensdk_host_handle_t host;
  const citizensdk_handle_t core;
  std::mutex gate;
  bool accepting{true};
  uint64_t next_operation{1};
  std::atomic<uint64_t> pending{0};
  std::vector<std::weak_ptr<OwnedResource>> resources;

  void remember(const std::shared_ptr<OwnedResource> &resource) {
    std::lock_guard<std::mutex> guard(gate);
    if (!accepting) throw Error(CITIZENSDK_ERROR_CANCELLED, "SDK正在关闭");
    resources.erase(std::remove_if(resources.begin(), resources.end(), [](const auto &value) { const auto live = value.lock(); return !live || live->is_released(); }), resources.end());
    std::size_t inspections = 0;
    for (const auto &value : resources) if (const auto live = value.lock(); live && live->resource_kind() == 1) ++inspections;
    if (resource->resource_kind() == 1 && inspections >= 64) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "钱包检查资源数量超限");
    resources.push_back(resource);
  }
  void release_resources() {
    std::size_t index = 0; std::exception_ptr failed;
    for (;;) {
      std::shared_ptr<OwnedResource> resource;
      {
        std::lock_guard<std::mutex> guard(gate);
        accepting = false;
        if (index == resources.size()) break;
        resource = resources[index++].lock();
      }
      if (resource && !resource->is_released()) try { resource->release(); } catch (...) { if (!failed) failed = std::current_exception(); }
    }
    if (failed) std::rethrow_exception(failed);
  }
};
template <class T> struct PendingOperation final {
  std::promise<T> promise;
  std::atomic<citizensdk_request_id_t> native{0};
  std::atomic<bool> finished{false};
};
// 使用既有Host私有终态路由；公开关联号独立于Core request_id且不会回绕。
template <class T, class Accept, class Decode>
inline Operation<T> operation(const std::shared_ptr<AsyncOwner> &owner, Accept accept, Decode decode) {
  if (!owner) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK尚未打开");
  auto pending = std::make_shared<PendingOperation<T>>();
  auto future = pending->promise.get_future().share();
  std::unique_lock<std::mutex> admission(owner->gate);
  if (!owner->accepting || owner->next_operation == 0)
    throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK已关闭或操作编号耗尽");
  const auto id = std::to_string(owner->next_operation);
  owner->next_operation = owner->next_operation == UINT64_MAX ? 0 : owner->next_operation + 1;
  // Future/取消闭包的分配在接纳前完成，Core接纳后只移动已拥有的对象。
  Operation<T> output(id, std::move(future), [owner, pending] {
    if (pending->finished.load()) return false;
    const auto code = citizensdk_cancel_request(owner->core, pending->native.load());
    if (code == CITIZENSDK_ERROR_NOT_FOUND || code == CITIZENSDK_ERROR_INVALID_HANDLE) return false;
    if (code != CITIZENSDK_OK) throw Error(code, "Core取消未接纳");
    return true;
  });
  owner->pending.fetch_add(1);
  citizensdk_request_id_t request = 0;
  try {
    const auto code = submit_request(owner->host, std::move(accept),
      [owner, pending, decode = std::move(decode)](citizensdk_request_id_t, citizensdk_result_handle_t result) mutable noexcept {
        EventResultScope owned(result);
        if (pending->finished.exchange(true)) return;
        try {
          if constexpr (std::is_void_v<T>) { decode(owned); pending->promise.set_value(); }
          else { pending->promise.set_value(decode(owned)); }
        } catch (...) {
          try { pending->promise.set_exception(std::current_exception()); } catch (...) {}
        }
        owner->pending.fetch_sub(1);
      },
      [pending](citizensdk_handle_t core) {
        const auto id = pending->native.load();
        if (id != 0 && !pending->finished.load()) (void)citizensdk_cancel_request(core, id);
      }, &request);
    if (request == 0) throw Error(code == CITIZENSDK_OK ? CITIZENSDK_ERROR_INTEGRITY : code, last_host_error("Core请求未接纳"));
    pending->native.store(request);
  } catch (...) {
    if (!pending->finished.exchange(true)) owner->pending.fetch_sub(1);
    throw;
  }
  return output;
}

// 同一Core结果的唯一C++数据投影；Flutter只编码这些公开事实，不重复读取/解释钱包。
template <class T> inline T output_info() {
  T value{}; value.struct_size = sizeof(value); value.abi_version = CITIZENSDK_ABI_VERSION; return value;
}
inline void require_core(citizensdk_error_code_t code, const char *message) {
  if (code != CITIZENSDK_OK) throw Error(code, message);
}
inline AccountId public_account(const citizensdk_account_id_t &value) {
  AccountId result; std::copy(std::begin(value.bytes), std::end(value.bytes), result.bytes.begin()); return result;
}
inline citizensdk_account_id_t core_account(const AccountId &value) {
  citizensdk_account_id_t result{}; std::copy(value.bytes.begin(), value.bytes.end(), std::begin(result.bytes)); return result;
}
template <class Copy> inline std::string public_text(Copy copy, std::size_t maximum) {
  uint64_t required = 0;
  require_core(copy(nullptr, 0, &required), "Core文本长度读取失败");
  if (required > maximum) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core文本长度超出合同");
  std::vector<uint8_t> bytes(static_cast<std::size_t>(required));
  uint64_t confirmed = required;
  require_core(copy(bytes.empty() ? nullptr : bytes.data(), required, &confirmed), "Core文本复制失败");
  if (confirmed != required) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core文本长度发生变化");
  return std::string(bytes.begin(), bytes.end());
}
inline citizensdk_result_info_t result_info(citizensdk_result_handle_t result, citizensdk_result_kind_t kind) {
  auto info = output_info<citizensdk_result_info_t>();
  require_core(citizensdk_result_get_info(result, &info), "Core结果读取失败");
  if (info.error_code != CITIZENSDK_OK) {
    citizensdk_failure_stage_t stage = 0;
    require_core(citizensdk_result_get_failure_stage(result, &stage), "Core失败阶段读取失败");
    const auto message = public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_result_copy_error_message(result, p, n, size);
    }, 65536);
    throw Error(info.error_code, message, stage);
  }
  if (info.kind != kind) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core结果类型不符");
  return info;
}
inline WalletProfile profile_header(citizensdk_result_handle_t result, const citizensdk_wallet_profile_info_t &info) {
  if (info.present != 1 || info.wallet_index != 0 || info.account_count > 1990 ||
      (info.origin != CITIZENSDK_WALLET_ORIGIN_CREATED && info.origin != CITIZENSDK_WALLET_ORIGIN_IMPORTED))
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core热钱包事实不符");
  WalletProfile profile;
  profile.wallet_index = info.wallet_index; profile.origin = info.origin;
  profile.master_account_id = public_account(info.master_account_id);
  profile.active_account_id = public_account(info.active_account_id);
  profile.created_at_millis = info.created_at_millis;
  profile.wallet_name = public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
    return citizensdk_wallet_profile_copy_name(result, p, n, size);
  }, 120);
  return profile;
}
template <class Info, class Copy> inline std::pair<std::string, std::string> account_text(Info &info, Copy copy) {
  uint64_t address_size = 0, name_size = 0;
  require_core(copy(&info, nullptr, 0, &address_size, nullptr, 0, &name_size), "Core账户长度读取失败");
  if (address_size > 128 || name_size > 120) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core账户文本超出合同");
  std::vector<uint8_t> address(static_cast<std::size_t>(address_size)), name(static_cast<std::size_t>(name_size));
  uint64_t a = address_size, n = name_size;
  require_core(copy(&info, address.empty() ? nullptr : address.data(), address_size, &a,
                   name.empty() ? nullptr : name.data(), name_size, &n), "Core账户文本复制失败");
  if (a != address_size || n != name_size) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core账户文本长度变化");
  return {std::string(address.begin(), address.end()), std::string(name.begin(), name.end())};
}
inline std::optional<WalletProfile> read_wallet_profile(citizensdk_result_handle_t result) {
  (void)result_info(result, CITIZENSDK_RESULT_WALLET_PROFILE);
  auto info = output_info<citizensdk_wallet_profile_info_t>();
  require_core(citizensdk_result_get_wallet_profile(result, &info), "Core热钱包读取失败");
  if (info.present == 0) return {};
  auto profile = profile_header(result, info);
  profile.accounts.reserve(info.account_count);
  for (uint32_t index = 0; index < info.account_count; ++index) {
    auto account = output_info<citizensdk_wallet_account_info_t>();
    const auto text = account_text(account, [&](auto *out, uint8_t *a, uint64_t ac, uint64_t *ar, uint8_t *n, uint64_t nc, uint64_t *nr) {
      return citizensdk_result_get_wallet_account(result, index, out, a, ac, ar, n, nc, nr);
    });
    if (account.is_active > 1 || account.index > 1989) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core热账户标志无效");
    profile.accounts.push_back({account.index, public_account(account.account_id), text.first, text.second,
                                account.created_at_millis, account.is_active != 0});
  }
  return profile;
}
inline WalletState read_wallet_state(citizensdk_result_handle_t result) {
  (void)result_info(result, CITIZENSDK_RESULT_WALLET_STATE);
  auto info = output_info<citizensdk_wallet_state_info_t>();
  auto profile_info = output_info<citizensdk_wallet_profile_info_t>();
  require_core(citizensdk_result_get_wallet_state(result, &info), "Core钱包快照读取失败");
  require_core(citizensdk_result_get_wallet_profile(result, &profile_info), "Core热钱包读取失败");
  if (info.account_count > 3980 || info.has_default_account > 1 ||
      (info.account_count == 0) != (info.has_default_account == 0) || profile_info.present > 1)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core钱包快照数量或标志无效");
  WalletState state; state.revision = info.revision;
  if (profile_info.present) state.hot_profile = profile_header(result, profile_info);
  state.accounts.reserve(info.account_count);
  for (uint32_t index = 0; index < info.account_count; ++index) {
    auto account = output_info<citizensdk_wallet_state_account_info_t>();
    const auto text = account_text(account, [&](auto *out, uint8_t *a, uint64_t ac, uint64_t *ar, uint8_t *n, uint64_t nc, uint64_t *nr) {
      return citizensdk_result_get_wallet_state_account(result, index, out, a, ac, ar, n, nc, nr);
    });
    const bool hot = account.sign_mode == CITIZENSDK_WALLET_SIGN_HOT;
    if (account.has_account_index > 1 || account.is_default != (index == 0 ? 1U : 0U) ||
        !(hot ? account.wallet_index == 0 && account.has_account_index == 1 && account.account_index <= 1989
              : account.sign_mode == CITIZENSDK_WALLET_SIGN_COLD && account.wallet_index > 0 && account.has_account_index == 0))
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core钱包账户事实无效");
    const auto id = public_account(account.account_id);
    if (index == 0 && id.bytes != public_account(info.default_account_id).bytes)
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core默认账户不符");
    state.accounts.push_back({account.sign_mode, account.wallet_index,
      hot ? std::optional<uint32_t>{account.account_index} : std::nullopt,
      id, text.first, text.second, account.created_at_millis, account.is_default != 0});
    if (hot) {
      if (!state.hot_profile) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core热账户缺少profile");
      state.hot_profile->accounts.push_back({account.account_index, id, text.first, text.second, account.created_at_millis,
        id.bytes == state.hot_profile->active_account_id.bytes});
    }
  }
  if (state.hot_profile && state.hot_profile->accounts.size() != profile_info.account_count)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core热账户数量不符");
  uint32_t count = 0;
  require_core(citizensdk_wallet_state_get_diagnostic_count(result, &count), "Core诊断数量读取失败");
  if (count > 1991) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core诊断数量无效");
  state.diagnostics.reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    auto value = output_info<citizensdk_wallet_diagnostic_info_v1_t>();
    require_core(citizensdk_wallet_state_get_diagnostic_at(result, index, &value), "Core诊断读取失败");
    if (value.has_ss58_address > 1 || value.sign_mode > 2 || value.diagnostic_reason < 1 || value.diagnostic_reason > 3 ||
        value.cleanup_account_count > 1990 || value.delete_wallet_wide_key > 1 ||
        (value.cleanup_account_count == 0 && value.delete_wallet_wide_key != 0) ||
        (value.has_ss58_address == 0 && value.ss58_address_len != 0))
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core诊断事实无效");
    WalletDiagnostic diagnostic;
    diagnostic.wallet_index = value.wallet_index; diagnostic.diagnostic_reason = value.diagnostic_reason;
    diagnostic.account_id = public_account(value.account_id);
    if (value.sign_mode) diagnostic.sign_mode = value.sign_mode;
    diagnostic.wallet_name = public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_wallet_state_copy_diagnostic_text(result, index, 1, p, n, size);
    }, 120);
    if (value.has_ss58_address) diagnostic.ss58_address = public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_wallet_state_copy_diagnostic_text(result, index, 2, p, n, size);
    }, 128);
    if (value.cleanup_account_count) {
      WalletCleanupTargets targets; targets.delete_wallet_wide_key = value.delete_wallet_wide_key != 0;
      targets.account_ids.reserve(value.cleanup_account_count);
      for (uint32_t at = 0; at < value.cleanup_account_count; ++at) {
        citizensdk_account_id_t id{};
        require_core(citizensdk_wallet_state_get_diagnostic_cleanup_account(result, index, at, &id), "Core清理目标复制失败");
        auto account = public_account(id);
        if (!targets.account_ids.empty() && !(targets.account_ids.back().bytes < account.bytes))
          throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core清理目标顺序无效");
        targets.account_ids.push_back(account);
      }
      diagnostic.cleanup_targets = std::move(targets);
    }
    state.diagnostics.push_back(std::move(diagnostic));
  }
  uint8_t cleanup = 0, has_active = 0; uint32_t active = 0;
  require_core(citizensdk_wallet_state_get_initialization(result, &state.initialization_state, &cleanup), "Core初始化事实读取失败");
  require_core(citizensdk_wallet_state_get_active_wallet(result, &has_active, &active), "Core付款选择读取失败");
  if (state.initialization_state > 2 || cleanup > 1 || has_active > 1 || (!has_active && active != 0) ||
      ((state.initialization_state == 1) != (!state.accounts.empty() || !state.diagnostics.empty())) ||
      (state.initialization_state == 0 && cleanup != 0))
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core钱包状态标志不符");
  state.cleanup_pending = cleanup != 0;
  if (has_active) state.active_wallet_index = active;
  return state;
}


struct SecretInput final {
  explicit SecretInput(const std::vector<uint8_t> &source) : bytes(source) {}
  ~SecretInput() {
    volatile uint8_t *data = bytes.data();
    for (std::size_t i = 0; i < bytes.size(); ++i) data[i] = 0;
  }
  citizensdk_bytes_view_t view() const noexcept { return {bytes.empty() ? nullptr : bytes.data(), static_cast<uint64_t>(bytes.size())}; }
  std::vector<uint8_t> bytes;
};
inline std::shared_ptr<SecretInput> secret_input(const std::vector<uint8_t> &source) {
  if (source.size() > 1024) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "钱包输入超过1024字节");
  return std::make_shared<SecretInput>(source);
}
inline WalletProfile required_profile(EventResultScope &owned) {
  auto profile = read_wallet_profile(owned.value);
  if (!profile) throw Error(CITIZENSDK_ERROR_INTEGRITY, "钱包操作缺少已提交profile");
  return std::move(*profile);
}
inline void empty_result(EventResultScope &owned) { (void)result_info(owned.value, CITIZENSDK_RESULT_EMPTY); }

inline void event_trampoline(void *context,
                             const citizensdk_event_t *event) noexcept {
  if (event == nullptr) return;
  EventResultScope result_owner(event->result);
  if (context == nullptr) return;
  EventObserver observer;
  try {
    auto *state = static_cast<EventContext *>(context);
    {
      std::lock_guard<std::mutex> guard(state->lock);
      observer = state->observer;
    }
    if (observer) observer(*event);
  } catch (...) {}
}

// 只读取 Core 输出 JSON 的字符串字段，不解释 QR_V1 或重新创建待签数据。
inline std::string qr_json_string(const std::string &json, std::size_t &at) {
  if (at >= json.size() || json[at++] != '"')
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core QR JSON string is missing");
  std::string output;
  const auto unit = [&]() -> uint32_t {
    if (json.size() - at < 4) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON escape is truncated");
    uint32_t code = 0;
    for (unsigned index = 0; index < 4; ++index) {
      const char digit = json[at++];
      const int value = digit >= '0' && digit <= '9' ? digit - '0'
          : digit >= 'a' && digit <= 'f' ? digit - 'a' + 10
          : digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 : -1;
      if (value < 0) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON escape is invalid");
      code = code * 16 + static_cast<uint32_t>(value);
    }
    return code;
  };
  while (at < json.size()) {
    const auto ch = json[at++];
    if (ch == '"') return output;
    if (static_cast<unsigned char>(ch) < 0x20)
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON contains a control byte");
    if (ch != '\\') { output.push_back(ch); continue; }
    if (at == json.size()) break;
    switch (json[at++]) {
      case '"': output.push_back('"'); break;
      case '\\': output.push_back('\\'); break;
      case '/': output.push_back('/'); break;
      case 'b': output.push_back('\b'); break;
      case 'f': output.push_back('\f'); break;
      case 'n': output.push_back('\n'); break;
      case 'r': output.push_back('\r'); break;
      case 't': output.push_back('\t'); break;
      case 'u': {
        uint32_t code = unit();
        if (code >= 0xd800 && code <= 0xdbff) {
          if (json.size() - at < 2 || json[at++] != '\\' || json[at++] != 'u')
            throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON surrogate is truncated");
          const uint32_t low = unit();
          if (low < 0xdc00 || low > 0xdfff)
            throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON surrogate is invalid");
          code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
        } else if (code >= 0xdc00 && code <= 0xdfff)
          throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON surrogate is invalid");
        if (code < 0x80) output.push_back(static_cast<char>(code));
        else {
          if (code >= 0x10000) output.push_back(static_cast<char>(0xf0 | (code >> 18)));
          if (code >= 0x800) output.push_back(static_cast<char>(
              (code >= 0x10000 ? 0x80 : 0xe0) | ((code >> 12) & 0x3f)));
          output.push_back(static_cast<char>((code >= 0x800 ? 0x80 : 0xc0) | ((code >> 6) & 0x3f)));
          output.push_back(static_cast<char>(0x80 | (code & 0x3f)));
        }
        break;
      }
      default: throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON escape is invalid");
    }
  }
  throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core JSON string is truncated");
}
inline std::optional<std::string> qr_public_optional_field(const std::string &json, const char *field, std::size_t maximum) {
  unsigned depth = 0;
  std::optional<std::string> canonical;
  bool found = false;
  for (std::size_t at = 0; at < json.size();) {
    const char ch = json[at];
    if (ch == '{' || ch == '[') { ++depth; ++at; continue; }
    if (ch == '}' || ch == ']') { if (depth == 0) break; --depth; ++at; continue; }
    if (ch != '"') { ++at; continue; }
    const auto name = qr_json_string(json, at);
    while (at < json.size() && (json[at] == ' ' || json[at] == '\n' || json[at] == '\r' || json[at] == '\t')) ++at;
    if (depth != 1 || at == json.size() || json[at] != ':' || name != field) continue;
    ++at;
    while (at < json.size() && (json[at] == ' ' || json[at] == '\n' || json[at] == '\r' || json[at] == '\t')) ++at;
    if (found) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core QR canonical field is duplicated");
    if (json.compare(at, 4, "null") == 0 &&
        (at + 4 == json.size() || json[at + 4] == ',' || json[at + 4] == '}' ||
         json[at + 4] == ' ' || json[at + 4] == '\n' || json[at + 4] == '\r' || json[at + 4] == '\t')) {
      canonical.reset(); at += 4;
    } else { canonical = qr_json_string(json, at); }
    found = true;
  }
  if (!found || (canonical && canonical->size() > maximum))
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core QR canonical field is invalid");
  return canonical;
}
inline std::string qr_public_field(const std::string &json, const char *field, std::size_t maximum) {
  auto value = qr_public_optional_field(json, field, maximum);
  if (!value || value->empty()) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core公开字符串缺失");
  return std::move(*value);
}
// 只投影Core生成的顶层整数事实；不解析QR_V1文本，也不复制码型到用途的业务表。
inline uint64_t qr_public_unsigned(const std::string &json, const char *field, uint64_t maximum) {
  uint64_t value = 0;
  bool found = false;
  unsigned depth = 0;
  for (std::size_t at = 0; at < json.size();) {
    const char ch = json[at];
    if (ch == '{' || ch == '[') { ++depth; ++at; continue; }
    if (ch == '}' || ch == ']') { if (depth == 0) break; --depth; ++at; continue; }
    if (ch != '"') { ++at; continue; }
    const auto key = qr_json_string(json, at);
    const auto whitespace = [](char c) { return c == ' ' || c == '\n' || c == '\r' || c == '\t'; };
    while (at < json.size() && whitespace(json[at])) ++at;
    if (depth != 1 || key != field || at == json.size() || json[at] != ':') continue;
    if (found) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core QR integer field is duplicated");
    ++at;
    while (at < json.size() && whitespace(json[at])) ++at;
    const auto start = at;
    value = 0;
    while (at < json.size() && json[at] >= '0' && json[at] <= '9') {
      const auto digit = static_cast<uint64_t>(json[at++] - '0');
      if (digit > maximum || value > (maximum - digit) / 10)
        throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core QR integer field exceeds boundary");
      value = value * 10 + digit;
    }
    if (at == start || (at - start > 1 && json[start] == '0') ||
        (at < json.size() && !whitespace(json[at]) && json[at] != ',' && json[at] != '}'))
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core QR integer field is invalid");
    found = true;
  }
  if (!found) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core QR integer field is missing");
  return value;
}


inline citizensdk_bytes_view_t bytes(const std::vector<uint8_t> &value) {
  return {value.empty() ? nullptr : value.data(), static_cast<uint64_t>(value.size())};
}
template <class Copy> inline std::vector<uint8_t> public_bytes(Copy copy, std::size_t maximum) {
  uint64_t required = 0;
  require_core(copy(nullptr, 0, &required), "Core字节长度读取失败");
  if (required > maximum) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core字节长度超出合同");
  std::vector<uint8_t> output(static_cast<std::size_t>(required)); uint64_t confirmed = required;
  require_core(copy(output.empty() ? nullptr : output.data(), required, &confirmed), "Core字节复制失败");
  if (confirmed != required) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core字节长度变化");
  return output;
}
inline std::vector<uint8_t> hex_bytes(const std::string &value, std::size_t maximum) {
  if (value.size() < 2 || value.rfind("0x", 0) != 0 || value.size() % 2 != 0 || (value.size() - 2) / 2 > maximum)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core公开字节编码无效");
  auto nibble = [](char digit) -> uint8_t {
    if (digit >= '0' && digit <= '9') return static_cast<uint8_t>(digit - '0');
    if (digit >= 'a' && digit <= 'f') return static_cast<uint8_t>(digit - 'a' + 10);
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core公开字节不是规范小写hex");
  };
  std::vector<uint8_t> bytes((value.size() - 2) / 2);
  for (std::size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<uint8_t>((nibble(value[2 + 2 * i]) << 4) | nibble(value[3 + 2 * i]));
  return bytes;
}
inline uint64_t decimal_u64(const std::string &text) {
  if (text.empty() || text.size() > 20 || (text.size() > 1 && text[0] == '0'))
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core整数文本无效");
  uint64_t value = 0;
  for (const auto digit : text) {
    if (digit < '0' || digit > '9' || value > (UINT64_MAX - static_cast<uint64_t>(digit - '0')) / 10)
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core整数文本越界");
    value = value * 10 + static_cast<uint64_t>(digit - '0');
  }
  return value;
}
inline QrDocument qr_document(std::string json) {
  if (json.size() > 65536) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core二维码文档超限");
  const auto kind = qr_public_unsigned(json, "kind", 6);
  if (kind == 0) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core二维码类型无效");
  return {static_cast<uint32_t>(kind), static_cast<uint32_t>(qr_public_unsigned(json, "scan_purpose_mask", 255)),
          qr_public_field(json, "canonical_text", 2331), std::move(json)};
}
inline void qr_purpose(const QrDocument &document, uint32_t purpose) {
  if (purpose < 1 || purpose > 8 || (document.scan_purpose_mask & (1U << (purpose - 1))) == 0)
    throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "二维码不符合请求用途");
}
inline SigningOutcome read_signing(citizensdk_result_handle_t result) {
  (void)result_info(result, CITIZENSDK_RESULT_SIGNING_OUTCOME);
  auto info = output_info<citizensdk_signing_outcome_info_t>();
  uint64_t signature_size = 0, session_size = 0, request_size = 0;
  auto copy = [&](uint8_t *signature, uint64_t signature_capacity, uint8_t *session, uint64_t session_capacity,
                  uint8_t *request, uint64_t request_capacity) {
    return citizensdk_result_get_signing_outcome(result, &info, signature, signature_capacity, &signature_size,
      session, session_capacity, &session_size, request, request_capacity, &request_size);
  };
  require_core(copy(nullptr, 0, nullptr, 0, nullptr, 0), "签名结果长度读取失败");
  if (signature_size > 64 || session_size > 128 || request_size > 2331)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "签名结果长度无效");
  const auto signature_expected = signature_size, session_expected = session_size, request_expected = request_size;
  std::vector<uint8_t> signature(signature_size), session(session_size), request(request_size);
  require_core(copy(signature.data(), signature.size(), session.data(), session.size(), request.data(), request.size()), "签名结果复制失败");
  if (signature_size != signature_expected || session_size != session_expected || request_size != request_expected)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "签名结果长度变化");
  const bool completed = info.status == CITIZENSDK_SIGNING_COMPLETED;
  if (!(completed ? info.transport == CITIZENSDK_EXTERNAL_SIGNER_NONE && signature_size == 64 && session_size == 0 && request_size == 0
        : info.status == CITIZENSDK_SIGNING_EXTERNAL_PENDING && info.transport == CITIZENSDK_EXTERNAL_SIGNER_QR_V1 &&
          signature_size == 0 && session_size >= 16 && request_size > 0 && info.expires_at > 0))
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "签名结果事实不符");
  SigningOutcome value; value.status = info.status; value.account_id = public_account(info.account_id);
  std::copy(std::begin(info.payload_hash), std::end(info.payload_hash), value.payload_hash.begin());
  value.expires_at = info.expires_at;
  if (completed) { std::array<uint8_t, 64> bytes{}; std::copy(signature.begin(), signature.end(), bytes.begin()); value.signature = bytes; }
  value.session_id.assign(session.begin(), session.end()); value.transport_request.assign(request.begin(), request.end());
  return value;
}
inline DefaultAccountChange read_default_change(citizensdk_result_handle_t result) {
  (void)result_info(result, CITIZENSDK_RESULT_DEFAULT_ACCOUNT_CHANGE);
  auto info = output_info<citizensdk_default_account_change_info_t>();
  uint64_t session_size = 0, request_size = 0;
  auto copy = [&](uint8_t *session, uint64_t capacity, uint8_t *request, uint64_t request_capacity) {
    return citizensdk_result_get_default_account_change(result, &info, session, capacity, &session_size,
      request, request_capacity, &request_size);
  };
  require_core(copy(nullptr, 0, nullptr, 0), "默认账户结果长度读取失败");
  if (session_size > 128 || request_size > 2331) throw Error(CITIZENSDK_ERROR_INTEGRITY, "默认账户结果超限");
  const auto session_expected = session_size, request_expected = request_size;
  std::vector<uint8_t> session(session_size), request(request_size);
  require_core(copy(session.data(), session.size(), request.data(), request.size()), "默认账户结果复制失败");
  if (session_size != session_expected || request_size != request_expected)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "默认账户结果长度变化");
  const bool completed = info.status == CITIZENSDK_SIGNING_COMPLETED;
  if (!(completed ? info.transport == CITIZENSDK_EXTERNAL_SIGNER_NONE && session_size == 0 && request_size == 0
        : info.status == CITIZENSDK_SIGNING_EXTERNAL_PENDING && info.transport == CITIZENSDK_EXTERNAL_SIGNER_QR_V1 &&
          session_size >= 16 && request_size > 0 && info.expires_at > 0))
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "默认账户结果事实不符");
  DefaultAccountChange value; value.status = info.status; value.current_default_account_id = public_account(info.current_default_account_id);
  std::copy(std::begin(info.payload_hash), std::end(info.payload_hash), value.payload_hash.begin());
  value.expires_at = info.expires_at; value.committed_revision = info.committed_revision;
  value.session_id.assign(session.begin(), session.end()); value.transport_request.assign(request.begin(), request.end());
  return value;
}

inline citizensdk_account_id_t qr_import_account(const std::string &document) {
  // 冷导入允许位由Core决定；用户码/转账码不能靠同名account_id字段绕过。
  if ((qr_public_unsigned(document, "scan_purpose_mask", 255) & 1U) == 0)
    throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "QR document is not allowed for cold account import");
  const auto text = qr_public_field(document, "account_id", 66);
  if (text.size() != 66 || text.rfind("0x", 0) != 0)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core account identity is invalid");
  citizensdk_account_id_t account{};
  const auto nibble = [](char ch) -> uint8_t {
    if (ch >= '0' && ch <= '9') return static_cast<uint8_t>(ch - '0');
    if (ch >= 'a' && ch <= 'f') return static_cast<uint8_t>(ch - 'a' + 10);
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core account identity is not canonical");
  };
  for (std::size_t i = 0; i < 32; ++i)
    account.bytes[i] = static_cast<uint8_t>((nibble(text[2 + 2 * i]) << 4) | nibble(text[3 + 2 * i]));
  return account;
}

inline citizensdk_error_code_t image_error(citizensdk_qr_image_status_t status) noexcept {
  switch (status) {
    case CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT:
    case CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED: return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    case CITIZENSDK_QR_IMAGE_NO_CODE: return CITIZENSDK_ERROR_NOT_FOUND;
    case CITIZENSDK_QR_IMAGE_MULTIPLE_CODES: return CITIZENSDK_ERROR_CONFLICT;
    case CITIZENSDK_QR_IMAGE_INVALID_UTF8: return CITIZENSDK_ERROR_DECODE;
    default: return CITIZENSDK_ERROR_INTERNAL;
  }
}

inline QrImage qr_image(const std::string &text, uint32_t scale = 4) {
  QrImage image;
  size_t required = 0;
  auto code = citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t *>(text.data()),
      text.size(), scale, nullptr, 0, &image.width, &image.height, &required);
  if (code != CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL || required == 0 || required > 16777216)
    throw Error(code == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL ? CITIZENSDK_ERROR_INTEGRITY : image_error(code), "QR response image query failed");
  image.luminance.resize(required);
  code = citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t *>(text.data()),
      text.size(), scale, image.luminance.data(), image.luminance.size(), &image.width, &image.height, &required);
  if (code != CITIZENSDK_QR_IMAGE_OK || required != image.luminance.size())
    throw Error(code == CITIZENSDK_QR_IMAGE_OK ? CITIZENSDK_ERROR_INTEGRITY : image_error(code), "QR response image encoding failed");
  return image;
}
}  // namespace detail


/** SDK自有短时秘密缓冲；只在useBytes回调内借用，回调不得等待资源关闭。
 * 不保证宿主另造的String/内存副本可擦除，SDK自己的固定缓冲在release时清零。 */
class SecretBytes : public detail::OwnedResource {
 public:
  SecretBytes(const SecretBytes &) = delete;
  SecretBytes &operator=(const SecretBytes &) = delete;
  ~SecretBytes() override { release(); }
  template <class F> auto useBytes(F &&body) const -> decltype(body(static_cast<const uint8_t *>(nullptr), std::size_t{})) {
    std::lock_guard<std::recursive_mutex> guard(gate_);
    if (released_.load() || !populated_) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "秘密显示副本已释放");
    return body(bytes_.data(), length_);
  }
  void release() override {
    std::lock_guard<std::recursive_mutex> guard(gate_);
    volatile uint8_t *data = bytes_.data();
    for (std::size_t i = 0; i < bytes_.size(); ++i) data[i] = 0;
    released_.store(true);
  }
  bool is_released() const noexcept override { return released_.load(); }
  unsigned resource_kind() const noexcept override { return 3; }
 protected:
  SecretBytes() = default;
  template <class F> void fill(std::size_t size, F copy) {
    std::lock_guard<std::recursive_mutex> guard(gate_);
    if (released_.load() || populated_ || size > bytes_.size())
      throw Error(CITIZENSDK_ERROR_INVALID_STATE, "秘密副本边界无效");
    try {
      detail::require_core(copy(bytes_.data(), static_cast<uint64_t>(size)), "秘密副本复制失败");
      length_ = size; populated_ = true;
    } catch (...) { release(); throw; }
  }
 private:
  friend class Host;
  friend class PreparedWallet;
  friend class PrivateKey;
  mutable std::recursive_mutex gate_;
  std::array<uint8_t, 1024> bytes_{};
  std::size_t length_{};
  bool populated_{false};
  std::atomic<bool> released_{false};
};

class RecoveryPhrase final : public SecretBytes {
 private:
  friend class PreparedWallet;
  RecoveryPhrase() = default;
};

class WalletInspection final : public detail::OwnedResource, public std::enable_shared_from_this<WalletInspection> {
 public:
  WalletInspection(const WalletInspection &) = delete;
  WalletInspection &operator=(const WalletInspection &) = delete;
  ~WalletInspection() override { try { release(); } catch (...) {} }
  const WalletState &state() const noexcept { return state_; }
  bool is_released() const noexcept override { return released_.load(); }
  unsigned resource_kind() const noexcept override { return 1; }
  void release() override {
    std::lock_guard<std::mutex> guard(gate_);
    if (result_ == 0) return;
    detail::require_core(citizensdk_result_release(result_), "钱包检查资源释放失败");
    result_ = 0; released_.store(true);
  }
  Operation<WalletState> repairHot(uint32_t wallet_index) {
    return change([wallet_index](auto core, auto result, auto *out) {
      return citizensdk_repair_hot_wallet(core, result, wallet_index, out);
    });
  }
  Operation<WalletState> rename(uint32_t wallet_index, std::string name) {
    return change([wallet_index, name = std::move(name)](auto core, auto result, auto *out) {
      return citizensdk_rename_diagnostic_wallet(core, result, wallet_index, bytes_view(name), out);
    });
  }
  Operation<WalletState> erase(uint32_t wallet_index) {
    return change([wallet_index](auto core, auto result, auto *out) {
      return citizensdk_delete_diagnostic_wallet(core, result, wallet_index, out);
    });
  }
 private:
  friend class Host;
  WalletInspection(const std::shared_ptr<detail::AsyncOwner> &owner, WalletState state)
      : owner_(owner), state_(std::move(state)) {}
  template <class Call> Operation<WalletState> change(Call call) {
    auto owner = owner_.lock(); auto self = shared_from_this();
    return detail::operation<WalletState>(owner,
      [self, call = std::move(call)](auto core, auto *out) {
        std::lock_guard<std::mutex> guard(self->gate_);
        if (self->result_ == 0) return CITIZENSDK_ERROR_INVALID_STATE;
        return call(core, self->result_, out);
      }, [](detail::EventResultScope &owned) { return detail::read_wallet_state(owned.value); });
  }
  std::weak_ptr<detail::AsyncOwner> owner_;
  const WalletState state_;
  std::mutex gate_;
  citizensdk_result_handle_t result_{};
  std::atomic<bool> released_{false};
};

class PreparedWallet final : public detail::OwnedResource, public std::enable_shared_from_this<PreparedWallet> {
 public:
  PreparedWallet(const PreparedWallet &) = delete;
  PreparedWallet &operator=(const PreparedWallet &) = delete;
  ~PreparedWallet() override { try { release(); } catch (...) {} }
  bool is_released() const noexcept override { return released_.load(); }
  unsigned resource_kind() const noexcept override { return 2; }

  std::shared_ptr<RecoveryPhrase> recoveryPhrase() {
    const auto owner = owner_.lock();
    if (!owner) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK已关闭");
    std::shared_ptr<RecoveryPhrase> phrase;
    {
      std::lock_guard<std::mutex> admission(owner->gate);
      if (!owner->accepting) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK正在关闭");
      std::lock_guard<std::mutex> guard(gate_);
      if (released_.load() || claimed_ || prepared_ == 0)
        throw Error(CITIZENSDK_ERROR_INVALID_STATE, "创建准备资源不可读");
      uint64_t required = 0;
      detail::require_core(citizensdk_prepared_wallet_copy_mnemonic(core_, prepared_, nullptr, 0, &required), "备份副本长度读取失败");
      if (required == 0 || required > 1024) throw Error(CITIZENSDK_ERROR_INTEGRITY, "备份副本长度无效");
      phrase = std::shared_ptr<RecoveryPhrase>(new RecoveryPhrase());
      phrase->fill(static_cast<std::size_t>(required), [&](uint8_t *buffer, uint64_t size) {
        uint64_t confirmed = size;
        const auto code = citizensdk_prepared_wallet_copy_mnemonic(core_, prepared_, buffer, size, &confirmed);
        return code == CITIZENSDK_OK && confirmed != size ? CITIZENSDK_ERROR_INTEGRITY : code;
      });
    }
    // 关闭可在复制后先行；登记被拒绝时局部资源析构立即清零，不交付迟到副本。
    owner->remember(phrase);
    return phrase;
  }
  Operation<WalletProfile> commit() {
    const auto owner = owner_.lock(); const auto self = shared_from_this();
    return detail::operation<WalletProfile>(owner,
      [self](auto core, auto *out) {
        std::lock_guard<std::mutex> guard(self->gate_);
        if (self->released_.load() || self->claimed_ || self->prepared_ == 0) return CITIZENSDK_ERROR_INVALID_STATE;
        const auto code = citizensdk_commit_wallet_creation(core, self->prepared_, out);
        if (code == CITIZENSDK_OK) self->claimed_ = true;
        return code;
      }, [](detail::EventResultScope &owned) {
        auto value = detail::read_wallet_profile(owned.value);
        if (!value) throw Error(CITIZENSDK_ERROR_INTEGRITY, "创建提交没有返回profile");
        return std::move(*value);
      });
  }
  void release() override {
    std::lock_guard<std::mutex> guard(gate_);
    if (released_.load()) return;
    // 已接纳的commit由原Core请求独立拥有，不能以release伪造其终态或再次提交。
    if (!claimed_ && prepared_ != 0)
      detail::require_core(citizensdk_prepared_wallet_release(core_, prepared_), "创建准备资源释放失败");
    prepared_ = 0; released_.store(true);
  }
 private:
  friend class Host;
  PreparedWallet(const std::shared_ptr<detail::AsyncOwner> &owner) : owner_(owner), core_(owner->core) {}
  std::weak_ptr<detail::AsyncOwner> owner_;
  const citizensdk_handle_t core_;
  std::mutex gate_;
  citizensdk_prepared_wallet_handle_t prepared_{};
  bool claimed_{false};
  std::atomic<bool> released_{false};
};


class QrReview final : public detail::OwnedResource, public std::enable_shared_from_this<QrReview> {
 public:
  QrReview(const QrReview &) = delete;
  QrReview &operator=(const QrReview &) = delete;
  ~QrReview() override { try { release(); } catch (...) {} }
  const QrDocument &document() const noexcept { return document_; }
  const std::string &palletName() const noexcept { return pallet_; }
  const std::string &callName() const noexcept { return call_; }
  const std::string &callArguments() const noexcept { return arguments_; }
  bool is_released() const noexcept override { return released_.load(); }
  unsigned resource_kind() const noexcept override { return 4; }
  void release() override {
    std::lock_guard<std::mutex> guard(gate_);
    if (result_ == 0) return;
    detail::require_core(citizensdk_result_release(result_), "审阅资源释放失败");
    result_ = 0; released_.store(true);
  }
 private:
  friend class Host;
  QrReview(const std::shared_ptr<detail::AsyncOwner> &owner, QrDocument document)
      : owner_(owner), document_(std::move(document)),
        pallet_(detail::qr_public_field(document_.core_json, "pallet_name", 256)),
        call_(detail::qr_public_field(document_.core_json, "call_name", 256)),
        arguments_(detail::qr_public_field(document_.core_json, "call_arguments", 65536)) {
    if (document_.kind != 1) throw Error(CITIZENSDK_ERROR_INTEGRITY, "审阅结果不是签名请求");
  }
  std::weak_ptr<detail::AsyncOwner> owner_;
  const QrDocument document_;
  const std::string pallet_, call_, arguments_;
  std::mutex gate_;
  citizensdk_result_handle_t result_{};
  bool claimed_{false};
  std::atomic<bool> released_{false};
};


/** 无窗口私钥租约。reveal只完成数据交付，closed只在原Core请求真实终态后完成。 */
class PrivateKey final : public detail::OwnedResource, public std::enable_shared_from_this<PrivateKey> {
 public:
  PrivateKey(const PrivateKey &) = delete;
  PrivateKey &operator=(const PrivateKey &) = delete;
  ~PrivateKey() override { try { (void)close(); } catch (...) {} }
  bool is_released() const noexcept override { return released_.load(); }
  unsigned resource_kind() const noexcept override { return 5; }
  const std::shared_future<void> &closed() const noexcept { return ended_result_; }
  std::shared_future<std::shared_ptr<SecretBytes>> reveal() {
    const auto owner = owner_.lock();
    if (!owner) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK已关闭");
    citizensdk_error_code_t code = CITIZENSDK_OK;
    {
      std::lock_guard<std::mutex> admission(owner->gate);
      if (!owner->accepting) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK正在关闭");
      std::lock_guard<std::recursive_mutex> guard(gate_);
      if (closing_ || stage_ != 1 || id_ == 0) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "私钥资源不可重复查看");
      stage_ = 2;
      code = citizensdk_private_key_reveal(core_, id_);
    }
    if (code != CITIZENSDK_OK) {
      try { revealed_.set_exception(failure(code, "私钥查看未接纳")); } catch (...) {}
      (void)close();
    }
    return revealed_result_;
  }
  std::shared_future<void> close() {
    uint64_t id = 0;
    std::shared_ptr<SecretBytes> secret;
    std::optional<std::promise<std::shared_ptr<PrivateKey>>> opened;
    {
      std::lock_guard<std::recursive_mutex> guard(gate_);
      if (released_.load()) return ended_result_;
      closing_ = true; id = id_; wipe_pending();
      secret = secret_; opened.swap(opened_);
    }
    // 不持有资源锁等待借用者归还显示副本，避免显示回调与关闭锁顺序倒置。
    if (secret) secret->release();
    citizensdk_error_code_t cancel = CITIZENSDK_OK, finish = CITIZENSDK_OK;
    if (id != 0) {
      cancel = citizensdk_private_key_cancel(core_, id);
      finish = citizensdk_private_key_finish(core_, id);
    }
    const auto error = failure(CITIZENSDK_ERROR_CANCELLED, "私钥资源已撤销");
    if (opened) try { opened->set_exception(error); } catch (...) {}
    try { revealed_.set_exception(error); } catch (...) {}
    auto accepted = [](citizensdk_error_code_t code) {
      return code == CITIZENSDK_OK || code == CITIZENSDK_ERROR_NOT_FOUND ||
             code == CITIZENSDK_ERROR_INVALID_HANDLE || code == CITIZENSDK_ERROR_INVALID_STATE;
    };
    if (!accepted(cancel)) throw Error(cancel, "私钥撤销失败");
    if (!accepted(finish)) throw Error(finish, "私钥结束失败");
    return ended_result_;
  }
  void release() override {
    (void)close();
    if (!released_.load()) throw Error(CITIZENSDK_ERROR_BUSY, "私钥请求仍在排空");
  }
 private:
  friend class Host;
  PrivateKey(const std::shared_ptr<detail::AsyncOwner> &owner, AccountId account)
      : owner_(owner), core_(owner->core), account_(account) {}
  static std::exception_ptr failure(citizensdk_error_code_t code, const char *text) noexcept {
    try { return std::make_exception_ptr(Error(code, text)); } catch (...) { return std::current_exception(); }
  }
  void wipe_pending() noexcept {
    volatile uint8_t *data = pending_secret_.data();
    for (std::size_t i = 0; i < pending_secret_.size(); ++i) data[i] = 0;
    populated_ = false;
  }
  citizensdk_private_key_receiver_v1_t receiver() noexcept {
    return {sizeof(citizensdk_private_key_receiver_v1_t), CITIZENSDK_ABI_VERSION, this,
      +[](void *raw, uint64_t id, citizensdk_bytes_view_t bytes) noexcept -> citizensdk_error_code_t {
        try {
        auto &self = *static_cast<PrivateKey *>(raw);
        std::lock_guard<std::recursive_mutex> guard(self.gate_);
        if (self.closing_ || self.populated_ || id == 0 || id != self.id_) return CITIZENSDK_ERROR_CANCELLED;
        if (self.stage_ != 2 || self.authentication_ == 0 || bytes.data == nullptr || bytes.len != 32) return CITIZENSDK_ERROR_INTEGRITY;
        std::copy(bytes.data, bytes.data + 32, self.pending_secret_.begin());
        self.populated_ = true;
        return CITIZENSDK_OK;
        } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
      },
      +[](void *raw, uint64_t id, citizensdk_error_code_t code) { static_cast<PrivateKey *>(raw)->settled(id, code); },
      +[](void *raw, uint64_t id, uint64_t operation) noexcept -> citizensdk_error_code_t {
        try {
        auto &self = *static_cast<PrivateKey *>(raw);
        std::lock_guard<std::recursive_mutex> guard(self.gate_);
        if (self.closing_) return CITIZENSDK_ERROR_CANCELLED;
        if (id == 0 || id != self.id_ || operation == 0 || self.authentication_ != 0) return CITIZENSDK_ERROR_INTEGRITY;
        self.authentication_ = operation;
        // 这里只绑定实际Host操作；真实解密/设备授权仍由原Host金库独立执行。
        return CITIZENSDK_OK;
        } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
      }};
  }
  void settled(uint64_t id, citizensdk_error_code_t code) noexcept {
    std::optional<std::promise<std::shared_ptr<PrivateKey>>> opened;
    std::exception_ptr error;
    try {
      {
        std::lock_guard<std::recursive_mutex> guard(gate_);
        if (closing_ || id == 0 || (id_ != 0 && id_ != id)) return;
        id_ = id; // 准备通知可早到，但不能随后绑定另一个资源。
        if (code != CITIZENSDK_OK) {
          error = failure(code, "私钥授权失败");
          opened.swap(opened_);
        } else if (stage_ == 0) {
          stage_ = 1; opened.swap(opened_);
        } else if (stage_ == 2) {
          if (!populated_) throw Error(CITIZENSDK_ERROR_INTEGRITY, "私钥结果缺少实际交付");
          auto secret = std::shared_ptr<SecretBytes>(new SecretBytes());
          secret->fill(32, [&](uint8_t *target, uint64_t) {
            std::copy(pending_secret_.begin(), pending_secret_.end(), target); return CITIZENSDK_OK;
          });
          wipe_pending(); secret_ = secret; stage_ = 3;
          revealed_.set_value(std::move(secret));
        }
      }
      // 移走promise避免Promise<shared_ptr<Self>>在资源内形成自身引用环。
      if (opened) { if (error) opened->set_exception(error); else opened->set_value(shared_from_this()); }
    } catch (...) { error = std::current_exception(); }
    if (error) {
      try { revealed_.set_exception(error); } catch (...) {}
      if (opened) try { opened->set_exception(error); } catch (...) {}
      // 接收回调不反调Core；只派发既有租约的关闭，不建立另一认证流程。
      try { auto self = shared_from_this(); std::thread([self] { try { (void)self->close(); } catch (...) {} }).detach(); }
      catch (...) { /* 实例仍登记该资源，显式SDK关闭继续归还真实租约。 */ }
    }
  }
  void terminal(std::exception_ptr error = {}) noexcept {
    std::shared_ptr<SecretBytes> secret;
    std::optional<std::promise<std::shared_ptr<PrivateKey>>> opened;
    {
      std::lock_guard<std::recursive_mutex> guard(gate_);
      if (terminal_) return;
      terminal_ = true; closing_ = true; id_ = 0; wipe_pending(); secret = secret_; opened.swap(opened_);
    }
    if (secret) secret->release();
    if (!error) error = failure(CITIZENSDK_ERROR_CANCELLED, "私钥资源已关闭");
    if (opened) try { opened->set_exception(error); } catch (...) {}
    try { revealed_.set_exception(error); } catch (...) {}
    released_.store(true);
    try { ended_.set_value(); } catch (...) {}
  }
  std::weak_ptr<detail::AsyncOwner> owner_;
  const citizensdk_handle_t core_;
  const AccountId account_;
  std::recursive_mutex gate_;
  uint64_t id_{}, authentication_{};
  unsigned stage_{};
  bool closing_{false}, terminal_{false}, populated_{false};
  std::atomic<bool> released_{false};
  std::array<uint8_t, 32> pending_secret_{};
  std::shared_ptr<SecretBytes> secret_;
  std::optional<std::promise<std::shared_ptr<PrivateKey>>> opened_{std::in_place};
  std::promise<std::shared_ptr<SecretBytes>> revealed_;
  std::shared_future<std::shared_ptr<SecretBytes>> revealed_result_{revealed_.get_future().share()};
  std::promise<void> ended_;
  std::shared_future<void> ended_result_{ended_.get_future().share()};
};


/** 非UI采集；监听器在SDK线程执行，只可快速转发到宿主UI，不得阻塞、等待关闭或销毁Host。 */
class QrCapture final : public detail::OwnedResource, public std::enable_shared_from_this<QrCapture> {
 public:
  struct Listener {
    std::function<void(const QrDocument &)> result;
    std::function<void(citizensdk_error_code_t)> error;
    std::function<void(std::shared_ptr<const QrFrame>)> frame;
  };
  QrCapture(const QrCapture &) = delete;
  QrCapture &operator=(const QrCapture &) = delete;
  ~QrCapture() override { try { (void)close(); } catch (...) {} }
  unsigned resource_kind() const noexcept override { return 6; }
  bool is_released() const noexcept override { return released_.load(); }
  QrPreview preview() const { std::lock_guard<std::recursive_mutex> guard(gate_); return preview_; }
  const std::shared_future<void> &closed() const noexcept { return ended_result_; }
  std::shared_future<void> pause() { return control(1, false); }
  std::shared_future<void> resume() { return control(2, false); }
  std::shared_future<void> setTorch(bool enabled) { return control(3, enabled); }

  std::shared_future<void> close() {
    std::lock_guard<std::recursive_mutex> guard(gate_);
    if (released_.load() || close_sent_) return ended_result_;
    closing_ = true;
    if (id_ != 0) {
      if (next_control_ == 0) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "采集控制编号已耗尽");
      const auto code = citizensdk_host_control_qr_capture(host_, id_, next_control_, 4, 0);
      if (code != CITIZENSDK_OK && code != CITIZENSDK_ERROR_NOT_FOUND && code != CITIZENSDK_ERROR_INVALID_HANDLE)
        throw Error(code, "采集关闭未接纳");
      close_sent_ = true;
      next_control_ = next_control_ == UINT64_MAX ? 0 : next_control_ + 1;
    }
    return ended_result_;
  }
  void release() override {
    (void)close();
    if (!released_.load()) throw Error(CITIZENSDK_ERROR_BUSY, "采集上下文尚未真实归还");
  }
 private:
  friend class Host;
  struct Box {
    std::atomic<uint32_t> references{1};
    std::shared_ptr<QrCapture> value;
  };
  QrCapture(const std::shared_ptr<detail::AsyncOwner> &owner, uint32_t purpose, Listener listener)
      : host_(owner->host), purpose_(purpose), listener_(std::move(listener)) {}
  static std::exception_ptr failure(citizensdk_error_code_t code, const char *message) noexcept {
    try { return std::make_exception_ptr(Error(code, message)); } catch (...) { return std::current_exception(); }
  }
  static void release_box(void *raw) noexcept {
    auto *box = static_cast<Box *>(raw);
    if (box->references.fetch_sub(1) == 1) {
      auto value = std::move(box->value); delete box;
      value->context_released();
    }
  }
  bool bind(uint64_t id) noexcept {
    if (id == 0 || (id_ != 0 && id_ != id)) return false;
    id_ = id; return true;
  }
  std::shared_future<void> control(uint32_t action, bool enabled) {
    auto promise = std::make_shared<std::promise<void>>();
    auto future = promise->get_future().share();
    std::lock_guard<std::recursive_mutex> guard(gate_);
    if (closing_ || released_.load() || id_ == 0 || !opened_done_)
      throw Error(CITIZENSDK_ERROR_INVALID_STATE, "采集资源不可控制");
    // 留最后一个编号给关闭；普通命令满时关闭不受阻挡。
    if (next_control_ == 0 || next_control_ == UINT64_MAX || controls_.size() >= 64)
      throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "采集控制队列或编号已满");
    const auto id = next_control_;
    controls_.emplace(id, promise); // 接纳前完成分配，早到回调也能精确关联。
    const auto code = citizensdk_host_control_qr_capture(host_, id_, id, action, enabled ? 1 : 0);
    if (code != CITIZENSDK_OK) {
      controls_.erase(id); throw Error(code, "采集控制未接纳");
    }
    ++next_control_;
    if (action == 1) paused_ = true;
    if (action == 2) { paused_ = false; awaiting_generation_ = true; }
    return future;
  }
  citizensdk_qr_capture_callbacks_v1_t callbacks(Box *box) noexcept {
    return {sizeof(citizensdk_qr_capture_callbacks_v1_t), CITIZENSDK_HOST_ABI_VERSION, box,
      +[](void *raw, uint64_t id, citizensdk_error_code_t code, uint32_t w, uint32_t h, uint32_t rotation) noexcept {
        auto self = static_cast<Box *>(raw)->value;
        std::optional<std::promise<std::shared_ptr<QrCapture>>> opened;
        try {
          {
            std::lock_guard<std::recursive_mutex> guard(self->gate_);
            if (!self->bind(id)) code = CITIZENSDK_ERROR_INTEGRITY;
            if (self->closing_) code = CITIZENSDK_ERROR_CANCELLED;
            if (code == CITIZENSDK_OK && (w == 0 || h == 0 || w > 4096 || h > 4096 ||
                (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270))) code = CITIZENSDK_ERROR_INTEGRITY;
            self->opened_done_ = code == CITIZENSDK_OK;
            if (self->opened_done_) self->preview_ = {w, h, rotation};
            opened.swap(self->opened_);
          }
          if (opened) {
            if (code == CITIZENSDK_OK) opened->set_value(self);
            else opened->set_exception(failure(code, "采集打开失败"));
          }
        } catch (...) { if (opened) try { opened->set_exception(std::current_exception()); } catch (...) {} }
      },
      +[](void *raw, uint64_t id, const citizensdk_qr_frame_v1_t *frame) noexcept {
        auto self = static_cast<Box *>(raw)->value;
        try {
          std::lock_guard<std::recursive_mutex> guard(self->gate_);
          if (self->closing_ || !self->opened_done_ || id != self->id_) return;
          if (self->paused_ && !self->initial_preview_) return;
          if (frame && (frame->generation < self->generation_ || (self->awaiting_generation_ && frame->generation <= self->generation_))) return;
          if (frame == nullptr || frame->struct_size != sizeof(*frame) || frame->abi_version != CITIZENSDK_HOST_ABI_VERSION ||
              frame->reserved != 0 || frame->generation == 0 || frame->width != self->preview_.width ||
              frame->height != self->preview_.height || frame->rotation_degrees != self->preview_.rotation_degrees ||
              frame->rgba.data == nullptr || frame->rgba.len != uint64_t{frame->width} * frame->height * 4) throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集帧事实无效");
          self->generation_ = frame->generation; self->awaiting_generation_ = false; self->initial_preview_ = false;
          if (!self->listener_.frame) return;
          auto copy = std::make_shared<QrFrame>();
          copy->preview = self->preview_; copy->generation = frame->generation;
          copy->rgba.assign(frame->rgba.data, frame->rgba.data + static_cast<std::size_t>(frame->rgba.len));
          self->listener_.frame(std::move(copy));
        } catch (...) { self->report(CITIZENSDK_ERROR_INTEGRITY); }
      },
      +[](void *raw, uint64_t id, uint64_t generation, citizensdk_bytes_view_t bytes) noexcept {
        auto self = static_cast<Box *>(raw)->value;
        try {
          std::lock_guard<std::recursive_mutex> guard(self->gate_);
          if (self->closing_ || self->paused_ || self->awaiting_generation_ || !self->opened_done_ || id != self->id_ || generation == 0 || generation != self->generation_) return;
          if (!bytes.data || bytes.len == 0 || bytes.len > 65536) throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集文档边界无效");
          auto document = detail::qr_document(std::string(reinterpret_cast<const char *>(bytes.data), static_cast<std::size_t>(bytes.len)));
          detail::qr_purpose(document, self->purpose_);
          if (self->listener_.result) self->listener_.result(document);
        } catch (const Error &error) { self->report(error.code()); }
        catch (...) { self->report(CITIZENSDK_ERROR_INTERNAL); }
      },
      +[](void *raw, uint64_t, citizensdk_error_code_t code) noexcept { static_cast<Box *>(raw)->value->report(code); },
      +[](void *raw, uint64_t id, uint64_t operation, citizensdk_error_code_t code) noexcept {
        auto self = static_cast<Box *>(raw)->value;
        try {
          std::lock_guard<std::recursive_mutex> guard(self->gate_);
          if (id != self->id_) return;
          const auto found = self->controls_.find(operation);
          if (found == self->controls_.end()) return;
          auto promise = found->second; self->controls_.erase(found);
          if (code == CITIZENSDK_OK) promise->set_value();
          else promise->set_exception(failure(code, "采集控制失败"));
        } catch (...) {}
      },
      +[](void *raw, uint64_t id, citizensdk_error_code_t) noexcept {
        auto self = static_cast<Box *>(raw)->value;
        std::lock_guard<std::recursive_mutex> guard(self->gate_);
        if (self->bind(id)) self->closing_ = true;
        // closed回调不是context.release；这里只停止交付，不能提前完成closed Future。
      },
      +[](void *raw) noexcept {
        if (static_cast<Box *>(raw)->references.fetch_add(1) == UINT32_MAX) std::terminate();
      },
      release_box};
  }
  void report(citizensdk_error_code_t code) noexcept {
    try {
      std::lock_guard<std::recursive_mutex> guard(gate_);
      if (!released_.load() && listener_.error) listener_.error(code);
    } catch (...) {}
  }
  void context_released() noexcept {
    std::lock_guard<std::recursive_mutex> guard(gate_);
    if (released_.exchange(true)) return;
    closing_ = true; id_ = 0;
    const auto error = failure(CITIZENSDK_ERROR_CANCELLED, "采集资源已关闭");
    if (opened_) { try { opened_->set_exception(error); } catch (...) {} opened_.reset(); }
    for (const auto &entry : controls_) try { entry.second->set_exception(error); } catch (...) {}
    controls_.clear(); listener_ = {};
    try { ended_.set_value(); } catch (...) {}
  }
  const citizensdk_host_handle_t host_;
  const uint32_t purpose_;
  mutable std::recursive_mutex gate_;
  Listener listener_;
  uint64_t id_{}, generation_{}, next_control_{1};
  bool closing_{false}, close_sent_{false}, opened_done_{false};
  bool paused_{true}, awaiting_generation_{false}, initial_preview_{true};
  QrPreview preview_;
  std::atomic<bool> released_{false};
  std::map<uint64_t, std::shared_ptr<std::promise<void>>> controls_;
  std::optional<std::promise<std::shared_ptr<QrCapture>>> opened_{std::in_place};
  std::promise<void> ended_;
  std::shared_future<void> ended_result_{ended_.get_future().share()};
};

/* Header-only ownership wrapper. Construction owns only Host resources; open()
 * is explicit so a Core setup error never loses the still-retryable Host
 * handle. Applications must stop and await Core before close(). */
class Host final {
 public:
  explicit Host(const Config &config) {
    const std::string storage = config.storage_root.u8string();
    const std::string assets = config.asset_root.u8string();
    citizensdk_host_config_v1_t native{};
    native.struct_size = sizeof(native);
    native.abi_version = CITIZENSDK_HOST_ABI_VERSION;
    native.storage_root_utf8 = bytes_view(storage);
    native.asset_root_utf8 = bytes_view(assets);
    native.application_id_utf8 = bytes_view(config.application_id);
    native.hwnd = config.hwnd;
    native.enable_wallet = (config.modules & (CITIZENSDK_MODULE_WALLET | CITIZENSDK_MODULE_SIGNING)) != 0 ? 1 : 0;
    throw_if_error(citizensdk_host_create_with_modules(&native, config.modules, &host_),
                   "CitizenSDK Host creation failed");
    try { detail::install_credential_provider(host_, config); }
    catch (...) { close_noexcept(); throw; }
  }

  Host(const Host &) = delete;
  Host &operator=(const Host &) = delete;
  Host(Host &&other) noexcept
      : host_(other.host_), sdk_(other.sdk_),
        event_context_(std::move(other.event_context_)), operations_(std::move(other.operations_)) {
    other.host_ = 0;
    other.sdk_ = 0;
  }
  Host &operator=(Host &&other) noexcept {
    if (this != &other) {
      close_noexcept();
      host_ = other.host_;
      sdk_ = other.sdk_;
      event_context_ = std::move(other.event_context_);
      operations_ = std::move(other.operations_);
      other.host_ = 0;
      other.sdk_ = 0;
    }
    return *this;
  }
  ~Host() { close_noexcept(); }

  void open() {
    if (sdk_ == 0) throw_if_error(citizensdk_host_create_sdk(host_, &sdk_), "CitizenSDK Core creation failed");
    if (!operations_) operations_ = std::make_shared<detail::AsyncOwner>(host_, sdk_);
    std::lock_guard<std::mutex> guard(operations_->gate);
    if (!operations_->accepting) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK仅允许重试关闭");
  }

  Operation<WalletState> getState() {
    return detail::operation<WalletState>(operations_,
      [](auto core, auto *out) { return citizensdk_get_wallet_state(core, out); },
      [](detail::EventResultScope &owned) { return detail::read_wallet_state(owned.value); });
  }
  Operation<std::shared_ptr<WalletInspection>> inspect() {
    const auto owner = operations_;
    return detail::operation<std::shared_ptr<WalletInspection>>(owner,
      [](auto core, auto *out) { return citizensdk_get_wallet_state(core, out); },
      [owner](detail::EventResultScope &owned) {
        auto state = detail::read_wallet_state(owned.value);
        auto inspection = std::shared_ptr<WalletInspection>(new WalletInspection(owner, std::move(state)));
        inspection->result_ = owned.value; owned.value = 0;
        owner->remember(inspection);
        return inspection;
      });
  }
  static WalletInputValidation validatePassword(const std::vector<uint8_t> &password) {
    return validateInput(1, password, 0);
  }
  static WalletInputValidation validateMnemonic(const std::vector<uint8_t> &mnemonic, uint32_t word_count) {
    return validateInput(2, mnemonic, word_count);
  }
  static std::vector<std::string> wordSuggestions(const std::string &prefix) {
    const auto text = detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_wallet_word_suggestions(bytes_view(prefix), p, n, size);
    }, 1024);
    std::vector<std::string> words;
    for (std::size_t begin = 0; begin < text.size();) {
      const auto end = text.find('\n', begin);
      words.push_back(text.substr(begin, end == std::string::npos ? std::string::npos : end - begin));
      if (end == std::string::npos) break;
      begin = end + 1;
    }
    if (words.size() > 6) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core词表候选数量无效");
    return words;
  }
  Operation<std::shared_ptr<PreparedWallet>> prepareCreation(uint32_t word_count,
                                                            const std::vector<uint8_t> &password = {}) {
    auto input = detail::secret_input(password); const auto owner = operations_;
    return detail::operation<std::shared_ptr<PreparedWallet>>(owner,
      [word_count, input](auto core, auto *out) { return citizensdk_prepare_wallet_creation(core, word_count, input->view(), out); },
      [owner](detail::EventResultScope &owned) {
        (void)detail::result_info(owned.value, CITIZENSDK_RESULT_PREPARED_WALLET);
        auto info = detail::output_info<citizensdk_prepared_wallet_info_t>();
        detail::require_core(citizensdk_result_get_prepared_wallet(owned.value, &info), "Core创建准备结果读取失败");
        if (info.prepared_wallet == 0) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core创建准备编号无效");
        // 结果句柄和准备句柄拥有权不同；分配公开对象失败仍须归还后者。
        struct PreparedGuard {
          citizensdk_handle_t core; citizensdk_prepared_wallet_handle_t value;
          ~PreparedGuard() { if (value) (void)citizensdk_prepared_wallet_release(core, value); }
        } guard{owner->core, info.prepared_wallet};
        auto prepared = std::shared_ptr<PreparedWallet>(new PreparedWallet(owner));
        prepared->prepared_ = guard.value; guard.value = 0;
        owner->remember(prepared);
        return prepared;
      });
  }
  Operation<WalletProfile> importWallet(const std::vector<uint8_t> &mnemonic,
                                         const std::vector<uint8_t> &password = {}) {
    const auto phrase = detail::secret_input(mnemonic), pass = detail::secret_input(password);
    return detail::operation<WalletProfile>(operations_,
      [phrase, pass](auto core, auto *out) { return citizensdk_import_wallet(core, phrase->view(), pass->view(), out); },
      detail::required_profile);
  }
  Operation<WalletProfile> addAccounts(const std::vector<uint8_t> &mnemonic,
                                       const std::vector<uint8_t> &password, std::vector<uint32_t> indices) {
    if (indices.empty() || indices.size() > 1989) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "追加账户数量无效");
    const auto phrase = detail::secret_input(mnemonic), pass = detail::secret_input(password);
    return detail::operation<WalletProfile>(operations_,
      [phrase, pass, indices = std::move(indices)](auto core, auto *out) {
        return citizensdk_add_wallet_accounts(core, phrase->view(), pass->view(), indices.data(), static_cast<uint32_t>(indices.size()), out);
      }, detail::required_profile);
  }
  Operation<WalletProfile> addNextAccount(const std::vector<uint8_t> &mnemonic,
                                          const std::vector<uint8_t> &password = {}) {
    const auto phrase = detail::secret_input(mnemonic), pass = detail::secret_input(password);
    return detail::operation<WalletProfile>(operations_,
      [phrase, pass](auto core, auto *out) { return citizensdk_add_next_wallet_account(core, phrase->view(), pass->view(), out); },
      detail::required_profile);
  }
  Operation<WalletState> importColdAccount(AccountId account, std::string name = {}) {
    return stateOperation([account = detail::core_account(account), name = std::move(name)](auto core, auto *out) {
      return citizensdk_import_cold_account_id(core, &account, bytes_view(name), out);
    });
  }
  Operation<WalletState> importColdAccount(std::string ss58_address, std::string name = {}) {
    return stateOperation([ss58_address = std::move(ss58_address), name = std::move(name)](auto core, auto *out) {
      return citizensdk_import_cold_account_ss58(core, bytes_view(ss58_address), bytes_view(name), out);
    });
  }
  Operation<WalletState> importColdAccountCode(std::string code, std::string name = {}) {
    return stateOperation([code = std::move(code), name = std::move(name)](auto core, auto *out) {
      const auto document = detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
        return citizensdk_qr_parse(core, bytes_view(code), p, n, size);
      }, 65536);
      const auto account = detail::qr_import_account(document);
      return citizensdk_import_cold_account_id(core, &account, bytes_view(name), out);
    });
  }
  Operation<WalletState> setActiveWallet(uint64_t revision, uint32_t wallet_index) {
    return stateOperation([revision, wallet_index](auto core, auto *out) { return citizensdk_set_active_wallet(core, revision, wallet_index, out); });
  }
  Operation<WalletState> renameWallet(uint64_t revision, uint32_t wallet_index, std::string name) {
    return stateOperation([revision, wallet_index, name = std::move(name)](auto core, auto *out) {
      return citizensdk_rename_wallet(core, revision, wallet_index, bytes_view(name), out);
    });
  }
  Operation<WalletProfile> setActiveAccount(AccountId account) {
    return detail::operation<WalletProfile>(operations_,
      [account = detail::core_account(account)](auto core, auto *out) { return citizensdk_set_active_wallet_account(core, &account, out); },
      detail::required_profile);
  }
  Operation<WalletState> renameAccount(AccountId account, std::string name) {
    return stateOperation([account = detail::core_account(account), name = std::move(name)](auto core, auto *out) {
      return citizensdk_rename_account(core, &account, bytes_view(name), out);
    });
  }
  Operation<WalletState> deleteAccount(AccountId account) {
    return stateOperation([account = detail::core_account(account)](auto core, auto *out) { return citizensdk_delete_account(core, &account, out); });
  }
  Operation<void> erase() {
    return detail::operation<void>(operations_, [](auto core, auto *out) { return citizensdk_delete_wallet(core, out); }, detail::empty_result);
  }
  Operation<void> signAndDelete() {
    return detail::operation<void>(operations_, [](auto core, auto *out) { return citizensdk_sign_and_delete_wallet(core, out); }, detail::empty_result);
  }
  // 与Core Empty终态一致；需要清理后目录时显式调用getState，不伪造profile。
  Operation<void> reconcileCleanup() {
    return detail::operation<void>(operations_, [](auto core, auto *out) { return citizensdk_reconcile_wallet_cleanup(core, out); }, detail::empty_result);
  }
  Operation<WalletState> reorderAccountsWithoutDefaultChange(uint64_t revision, std::vector<AccountId> accounts) {
    if (accounts.size() > 3980) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "账户目录数量无效");
    std::vector<citizensdk_account_id_t> ids; ids.reserve(accounts.size());
    for (const auto &account : accounts) ids.push_back(detail::core_account(account));
    return stateOperation([revision, ids = std::move(ids)](auto core, auto *out) {
      return citizensdk_reorder_wallet_accounts_without_default_change(core, revision, ids.empty() ? nullptr : ids.data(), static_cast<uint32_t>(ids.size()), out);
    });
  }



  std::shared_future<std::shared_ptr<QrCapture>> openCapture(uint32_t purpose, QrCapture::Listener listener = {}) {
    if (purpose < 1 || purpose > 8) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集用途无效");
    const auto owner = requireOwner();
    auto capture = std::shared_ptr<QrCapture>(new QrCapture(owner, purpose, std::move(listener)));
    auto opened = capture->opened_->get_future().share();
    owner->remember(capture);
    std::lock_guard<std::mutex> admission(owner->gate);
    if (!owner->accepting) { capture->context_released(); return opened; }
    auto *box = new QrCapture::Box();
    box->value = capture;
    const auto callbacks = capture->callbacks(box);
    uint64_t id = 0;
    const auto code = citizensdk_host_open_qr_capture(owner->host, purpose, &callbacks, &id);
    {
      std::lock_guard<std::recursive_mutex> guard(capture->gate_);
      if (code == CITIZENSDK_OK && !capture->bind(id)) {
        if (capture->opened_) { capture->opened_->set_exception(QrCapture::failure(CITIZENSDK_ERROR_INTEGRITY, "采集编号不符")); capture->opened_.reset(); }
      } else if (code != CITIZENSDK_OK && capture->opened_) {
        capture->opened_->set_exception(QrCapture::failure(code, "采集打开未接纳")); capture->opened_.reset();
      }
    }
    QrCapture::release_box(box); // 最后由Host归还的引用才允许closed完成。
    return opened;
  }

  std::shared_future<std::shared_ptr<PrivateKey>> openPrivateKey(AccountId account) {
    const auto owner = requireOwner();
    auto key = std::shared_ptr<PrivateKey>(new PrivateKey(owner, account));
    auto opened = key->opened_->get_future().share();
    owner->remember(key);
    try {
      (void)detail::operation<void>(owner, [key](auto core, auto *out) {
        const auto account = detail::core_account(key->account_);
        const auto receiver = key->receiver();
        uint64_t id = 0;
        const auto code = citizensdk_private_key_open(core, &account, &receiver, &id, out);
        if (code == CITIZENSDK_OK) {
          std::lock_guard<std::recursive_mutex> guard(key->gate_);
          if (id == 0 || (key->id_ != 0 && key->id_ != id)) return CITIZENSDK_ERROR_INTEGRITY;
          key->id_ = id;
        }
        return code;
      }, [key](detail::EventResultScope &owned) {
        std::exception_ptr error;
        try { detail::empty_result(owned); } catch (...) { error = std::current_exception(); }
        key->terminal(error);
      });
    } catch (...) { key->terminal(std::current_exception()); }
    return opened;
  }

  Operation<WalletSignature> sign(AccountId account, std::vector<uint8_t> payload) {
    if (payload.size() > 16U * 1024U * 1024U) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "签名载荷超限");
    return detail::operation<WalletSignature>(operations_,
      [account = detail::core_account(account), payload = std::move(payload)](auto core, auto *out) {
        return citizensdk_sign_wallet_payload(core, &account, detail::bytes(payload), out);
      }, [account](detail::EventResultScope &owned) {
        (void)detail::result_info(owned.value, CITIZENSDK_RESULT_SIGNATURE);
        WalletSignature value; value.account_id = account;
        detail::require_core(citizensdk_result_get_signature(owned.value, value.bytes.data()), "签名字节复制失败");
        return value;
      });
  }
  static bool verify(AccountId account, const std::array<uint8_t, 64> &signature, const std::vector<uint8_t> &message) {
    const auto id = detail::core_account(account); uint8_t valid = 0;
    detail::require_core(citizensdk_verify_signature(&id, {signature.data(), signature.size()}, detail::bytes(message), &valid), "公开验签失败");
    if (valid > 1) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core验签结果无效");
    return valid != 0;
  }
  Operation<SigningOutcome> begin(SigningIntent intent) {
    if (intent.payload.size() > 16U * 1024U * 1024U) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "签名载荷超限");
    return detail::operation<SigningOutcome>(operations_, [intent = std::move(intent)](auto core, auto *out) {
      const auto account = detail::core_account(intent.account_id);
      return citizensdk_begin_signing(core, &account, detail::bytes(intent.payload), intent.transform,
          detail::bytes(intent.domain), intent.transport, intent.action, intent.ttl_seconds, out);
    }, [](detail::EventResultScope &owned) { return detail::read_signing(owned.value); });
  }
  Operation<SigningOutcome> consumeExternalSignature(std::string session_id, std::string response) {
    return detail::operation<SigningOutcome>(operations_,
      [session_id = std::move(session_id), response = std::move(response)](auto core, auto *out) {
        return citizensdk_consume_external_signature(core, bytes_view(session_id), bytes_view(response), out);
      }, [](detail::EventResultScope &owned) { return detail::read_signing(owned.value); });
  }
  bool cancel(const std::string &session_id) {
    const auto owner = requireOwner(); std::lock_guard<std::mutex> guard(owner->gate);
    requireAccepting(*owner); uint8_t value = 0;
    detail::require_core(citizensdk_cancel_signing_session(owner->core, bytes_view(session_id), &value), "冷签会话取消失败");
    if (value > 1) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core取消结果无效");
    return value != 0;
  }
  Operation<DefaultAccountChange> beginDefaultAccountChange(uint64_t revision, std::vector<AccountId> accounts, uint64_t ttl_seconds = 90) {
    if (accounts.empty() || accounts.size() > 3980) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "账户目录数量无效");
    std::vector<citizensdk_account_id_t> ids; ids.reserve(accounts.size());
    for (const auto &account : accounts) ids.push_back(detail::core_account(account));
    return detail::operation<DefaultAccountChange>(operations_,
      [revision, ids = std::move(ids), ttl_seconds](auto core, auto *out) {
        return citizensdk_begin_default_account_change(core, revision, ids.data(), static_cast<uint32_t>(ids.size()), ttl_seconds, out);
      }, [](detail::EventResultScope &owned) { return detail::read_default_change(owned.value); });
  }
  Operation<DefaultAccountChange> consumeDefaultAccountChange(std::string session_id, std::string response) {
    return detail::operation<DefaultAccountChange>(operations_,
      [session_id = std::move(session_id), response = std::move(response)](auto core, auto *out) {
        return citizensdk_consume_default_account_change(core, bytes_view(session_id), bytes_view(response), out);
      }, [](detail::EventResultScope &owned) { return detail::read_default_change(owned.value); });
  }
  Operation<std::shared_ptr<SecretBytes>> deriveApplicationKey(AccountId account, std::array<uint8_t, 32> salt, std::vector<uint8_t> info) {
    if (info.empty() || info.size() > 256) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "派生域长度无效");
    const auto owner = operations_;
    return detail::operation<std::shared_ptr<SecretBytes>>(owner,
      [account = detail::core_account(account), salt, info = std::move(info)](auto core, auto *out) {
        return citizensdk_derive_application_key(core, &account, {salt.data(), salt.size()}, detail::bytes(info), out);
      }, [owner](detail::EventResultScope &owned) {
        (void)detail::result_info(owned.value, CITIZENSDK_RESULT_APPLICATION_KEY);
        auto bytes = std::shared_ptr<SecretBytes>(new SecretBytes());
        bytes->fill(32, [&](uint8_t *buffer, uint64_t) { return citizensdk_result_get_application_key(owned.value, buffer); });
        owner->remember(bytes);
        return bytes;
      });
  }
  static std::vector<uint8_t> encodePayload(uint32_t kind, const std::string &fields_json, const std::vector<uint8_t> &payload = {}) {
    return detail::public_bytes([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_encode_signing_payload(kind, bytes_view(fields_json), detail::bytes(payload), p, n, size);
    }, 16U * 1024U * 1024U + 4);
  }
  QrDocument parse(const std::string &text) {
    const auto owner = requireOwner(); std::lock_guard<std::mutex> guard(owner->gate); requireAccepting(*owner);
    return detail::qr_document(detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_qr_parse(owner->core, bytes_view(text), p, n, size);
    }, 65536));
  }
  QrDocument parseForPurpose(const std::string &text, uint32_t purpose) {
    auto document = parse(text); detail::qr_purpose(document, purpose); return document;
  }
  QrDocument encodeDocument(const std::string &input_json) {
    const auto owner = requireOwner(); std::lock_guard<std::mutex> guard(owner->gate); requireAccepting(*owner);
    return detail::qr_document(detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_qr_encode_document(owner->core, bytes_view(input_json), p, n, size);
    }, 65536));
  }
  QrAuthorization prepareAccountAuthorization(uint32_t action, const std::vector<uint8_t> &payload, const std::string &account_id) {
    const auto owner = requireOwner(); std::lock_guard<std::mutex> guard(owner->gate); requireAccepting(*owner);
    const auto json = detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_qr_prepare_account_authorization(owner->core, action, detail::bytes(payload), bytes_view(account_id), p, n, size);
    }, 65536);
    QrAuthorization value; value.reason = static_cast<uint32_t>(detail::qr_public_unsigned(json, "reason", 3));
    if (value.reason != 0) return value;
    const auto genesis = detail::hex_bytes(detail::qr_public_field(json, "genesis_hash", 66), 32);
    if (genesis.size() != 32) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core创世哈希长度无效");
    std::copy(genesis.begin(), genesis.end(), value.genesis_hash.begin());
    value.cid_number = detail::qr_public_field(json, "cid_number", 256);
    if (const auto id = detail::qr_public_optional_field(json, "current_account_id", 66)) {
      const auto bytes = detail::hex_bytes(*id, 32);
      if (bytes.size() != 32) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core账户标识长度无效");
      AccountId account; std::copy(bytes.begin(), bytes.end(), account.bytes.begin()); value.current_account_id = account;
    }
    value.expected_binding_revision = detail::decimal_u64(detail::qr_public_field(json, "expected_binding_revision", 20));
    value.expires_at = detail::decimal_u64(detail::qr_public_field(json, "expires_at", 20));
    value.materialized_payload = detail::hex_bytes(detail::qr_public_field(json, "materialized_payload", 3842), 1920);
    if (value.materialized_payload.empty()) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core授权载荷为空");
    return value;
  }
  Operation<std::shared_ptr<QrReview>> reviewQrRequest(std::string request) {
    const auto owner = operations_;
    return detail::operation<std::shared_ptr<QrReview>>(owner,
      [request = std::move(request)](auto core, auto *out) { return citizensdk_review_qr_sign_request(core, bytes_view(request), out); },
      [owner](detail::EventResultScope &owned) {
        (void)detail::result_info(owned.value, CITIZENSDK_RESULT_QR_REVIEW);
        const auto json = detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) { return citizensdk_result_copy_qr(owned.value, p, n, size); }, 65536);
        auto review = std::shared_ptr<QrReview>(new QrReview(owner, detail::qr_document(json)));
        review->result_ = owned.value; owned.value = 0;
        owner->remember(review);
        return review;
      });
  }
  Operation<QrSigned> signQrRequest(const std::shared_ptr<QrReview> &review) {
    const auto owner = requireOwner();
    if (!review || review->owner_.lock() != owner) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "审阅不属于当前SDK");
    return detail::operation<QrSigned>(owner, [review](auto core, auto *out) {
      std::lock_guard<std::mutex> guard(review->gate_);
      if (review->result_ == 0 || review->claimed_) return CITIZENSDK_ERROR_INVALID_STATE;
      const auto code = citizensdk_sign_qr_request(core, review->result_, out);
      if (code == CITIZENSDK_OK) review->claimed_ = true;
      return code;
    }, [](detail::EventResultScope &owned) {
      (void)detail::result_info(owned.value, CITIZENSDK_RESULT_QR_SIGNED);
      const auto json = detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) { return citizensdk_result_copy_qr(owned.value, p, n, size); }, 65536);
      auto document = detail::qr_document(json);
      if (document.kind != 2) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core签名响应类型无效");
      auto image = detail::qr_image(document.canonical_text);
      return QrSigned{std::move(document), std::move(image)};
    });
  }


  static QrImage encode(const std::string &text, uint32_t scale = 4) {
    return detail::qr_image(text, scale);
  }
  std::string encodeAccountId(AccountId account) {
    const auto owner = requireOwner(); std::lock_guard<std::mutex> guard(owner->gate); requireAccepting(*owner);
    const auto id = detail::core_account(account);
    return detail::public_text([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_qr_encode_account_id(owner->core, &id, p, n, size);
    }, 2331);
  }
  QrDocument decodeLuminance(const std::vector<uint8_t> &data, uint32_t width, uint32_t height,
                            uint32_t row_stride, uint32_t purpose) {
    std::size_t required = 0;
    auto code = citizensdk_qr_image_decode_luminance(data.data(), data.size(), width, height, row_stride, nullptr, 0, &required);
    if (code != CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL) throw Error(detail::image_error(code), "二维码识别失败");
    if (required == 0 || required > 2331) throw Error(CITIZENSDK_ERROR_INTEGRITY, "二维码识别长度无效");
    std::vector<uint8_t> text(required);
    code = citizensdk_qr_image_decode_luminance(data.data(), data.size(), width, height, row_stride, text.data(), text.size(), &required);
    if (code != CITIZENSDK_QR_IMAGE_OK) throw Error(detail::image_error(code), "二维码识别失败");
    if (required != text.size()) throw Error(CITIZENSDK_ERROR_INTEGRITY, "二维码识别长度变化");
    return parseForPurpose(std::string(text.begin(), text.end()), purpose);
  }
  // 同一有界Host图像解码器；调用者须在其后台任务调用，不在UI回调中重解码。
  std::vector<QrDocument> decodeImage(const std::vector<uint8_t> &encoded, uint32_t purpose) {
    const auto owner = requireOwner(); std::lock_guard<std::mutex> guard(owner->gate); requireAccepting(*owner);
    const auto data = detail::public_bytes([&](uint8_t *p, uint64_t n, uint64_t *size) {
      return citizensdk_host_decode_qr_image(owner->host, detail::bytes(encoded), purpose, p, n, size);
    }, 4 + 64 * (4 + 65536));
    std::size_t at = 0;
    auto read = [&]() -> uint32_t {
      if (data.size() - at < 4) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图像结果被截断");
      uint32_t value = 0;
      for (unsigned i = 0; i < 4; ++i) value |= uint32_t{data[at++]} << (8 * i);
      return value;
    };
    const auto count = read();
    if (count > 64) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图像结果数量超限");
    std::vector<QrDocument> documents; documents.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
      const auto size = read();
      if (size == 0 || size > 65536 || size > data.size() - at) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图像文档长度无效");
      auto document = detail::qr_document(std::string(reinterpret_cast<const char *>(data.data() + at), size));
      detail::qr_purpose(document, purpose); documents.push_back(std::move(document)); at += size;
    }
    if (at != data.size()) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图像结果有多余字节");
    return documents;
  }

  // 只验签当前Core实例会话；不替换其固定transform，不消费或发起交易。
  void validateSignResponse(const std::string &session_id, const std::string &response) {
    const auto owner = requireOwner(); std::lock_guard<std::mutex> guard(owner->gate); requireAccepting(*owner);
    throw_if_error(citizensdk_qr_validate_sign_response(owner->core, bytes_view(session_id), bytes_view(response)),
                   "CitizenSDK QR response preflight failed");
  }


  // 一条Host终态路由保有上下文；公共观察者/Flutter界面关闭不会释放在途资源的回调。
  citizensdk_error_code_t submit_request(
      std::function<citizensdk_error_code_t(citizensdk_handle_t, citizensdk_request_id_t *)> accept,
      std::function<void(citizensdk_request_id_t, citizensdk_result_handle_t)> complete,
      std::function<void(citizensdk_handle_t)> cancel,
      citizensdk_request_id_t *out) {
    return detail::submit_request(host_, std::move(accept), std::move(complete), std::move(cancel), out);
  }

  citizensdk_handle_t native_handle() const noexcept { return sdk_; }
  citizensdk_host_handle_t host_handle() const noexcept { return host_; }

  void set_parent_window(void *window) {
    throw_if_error(citizensdk_host_set_parent_window(host_, window),
                   "CitizenSDK parent window update failed");
  }

  void set_event_observer(EventObserver observer) {
    if (!observer) {
      throw_if_error(citizensdk_host_set_event_callback(host_, nullptr, nullptr),
                     "CitizenSDK event observer clear failed");
      event_context_.reset();
      return;
    }
    auto state = std::make_unique<detail::EventContext>();
    state->observer = std::move(observer);
    throw_if_error(citizensdk_host_set_event_callback(
                       host_, detail::event_trampoline, state.get()),
                   "CitizenSDK event observer registration failed");
    event_context_ = std::move(state);
  }

  Capabilities capabilities() const {
    citizensdk_capability_snapshot_t snapshot{};
    snapshot.struct_size = sizeof(snapshot);
    snapshot.abi_version = CITIZENSDK_ABI_VERSION;
    const auto code = citizensdk_get_capabilities(sdk_, &snapshot);
    if (code != CITIZENSDK_OK) {
      throw Error(code, "CitizenSDK capability query failed");
    }
    if (snapshot.count != CITIZENSDK_CAPABILITY_COUNT) {
      throw Error(CITIZENSDK_ERROR_INTEGRITY,
                  "CitizenSDK capability snapshot has an incompatible size");
    }
    Capabilities result;
    result.revision = snapshot.revision;
    result.statuses.reserve(snapshot.count);
    for (uint32_t index = 0; index < snapshot.count; ++index) {
      const auto &value = snapshot.statuses[index];
      result.statuses.push_back({value.name, value.reason,
                                 value.supported != 0, value.available != 0,
                                 value.enabled != 0, value.ready != 0});
    }
    return result;
  }

  citizensdk_host_vault_availability_t vault_availability() const {
    citizensdk_host_vault_availability_t value{};
    throw_if_error(citizensdk_host_vault_availability(host_, &value),
                   "CitizenSDK vault availability query failed");
    return value;
  }

  void close() {
    if (host_ == 0) return;
    // Windows 窗口退休可以晚于 Core 销毁。上次 BUSY 后不能再查询已经
    // 释放的缓存 Core handle；以仍然存活的 Host 为唯一所有权真源。
    refresh_core_handle();
    if (sdk_ != 0) {
      citizensdk_lifecycle_t lifecycle = 0;
      const auto code = citizensdk_get_lifecycle(sdk_, &lifecycle);
      if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK lifecycle query failed");
      if (lifecycle == CITIZENSDK_LIFECYCLE_RUNNING ||
          lifecycle == CITIZENSDK_LIFECYCLE_STARTING ||
          lifecycle == CITIZENSDK_LIFECYCLE_IMPORTING_STATE) {
        throw Error(CITIZENSDK_ERROR_BUSY,
                    "stop CitizenSDK and await its checkpoint before close");
      }
    }
    if (operations_) {
      operations_->release_resources();
      if (operations_->pending.load() != 0) throw Error(CITIZENSDK_ERROR_BUSY, "C++请求尚未真实结束");
    }
    // Preserve the observer when close is rejected as BUSY. Once the lifecycle
    // gate passes, clearing it is the synchronization barrier that makes the
    // EventContext safe to destroy.
    if (event_context_) {
      throw_if_error(citizensdk_host_set_event_callback(host_, nullptr, nullptr),
                     "CitizenSDK event observer clear failed");
      event_context_.reset();
    }
    const auto closed = citizensdk_host_destroy(host_);
    if (closed != CITIZENSDK_OK) {
      refresh_core_handle();
      throw_if_error(closed, "CitizenSDK Host close failed");
    }
    host_ = 0;
    sdk_ = 0;
    operations_.reset();
  }

 private:
  // Host才是Core存活的真源；半关闭/消息分派退休期间不得再查询已失效缓存句柄。
  void refresh_core_handle() {
    citizensdk_handle_t current = 0;
    const auto code = citizensdk_host_sdk(host_, &current);
    if (code == CITIZENSDK_ERROR_NOT_READY) { sdk_ = 0; return; }
    throw_if_error(code, "CitizenSDK Host Core句柄查询失败");
    if (current == 0) throw Error(CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK Host返回空Core句柄");
    sdk_ = current;
  }

  std::shared_ptr<detail::AsyncOwner> requireOwner() const {
    if (!operations_) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK尚未打开");
    return operations_;
  }
  static void requireAccepting(const detail::AsyncOwner &owner) {
    if (!owner.accepting) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "SDK正在关闭");
  }
  template <class Call> Operation<WalletState> stateOperation(Call call) {
    return detail::operation<WalletState>(operations_, std::move(call),
      [](detail::EventResultScope &owned) { return detail::read_wallet_state(owned.value); });
  }
  static WalletInputValidation validateInput(uint32_t kind, const std::vector<uint8_t> &input, uint32_t count) {
    auto value = detail::output_info<citizensdk_wallet_input_validation_v1_t>();
    const citizensdk_bytes_view_t view{input.empty() ? nullptr : input.data(), static_cast<uint64_t>(input.size())};
    detail::require_core(citizensdk_validate_wallet_input(kind, view, count, &value), "Core输入校验失败");
    if (value.reason > 8 || (value.reason == 3) != (value.position != UINT32_MAX) || (value.position != UINT32_MAX && value.position >= 24))
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core输入原因无效");
    return {value.reason, value.position == UINT32_MAX ? std::nullopt : std::optional<uint32_t>{value.position}};
  }

  void close_noexcept() noexcept {
    if (host_ == 0) return;
    if (operations_) try { operations_->release_resources(); } catch (...) { /* 原Host监督器继续等待真实请求排空。 */ }
    // Clearing the Host callback is a synchronization barrier: success waits
    // for every callback frame, including a std::function copy, to retire. A
    // destructor running inside its own callback is also supported by Host.
    // A failed barrier transfers the Host to its supervisor; if ownership
    // cannot be transferred, terminate rather than leak or free a still-
    // borrowed raw context. Long-lived retries belong only to the supervisor.
    bool transferred = false;
    if (event_context_) {
      const auto clear =
          citizensdk_host_set_event_callback(host_, nullptr, nullptr);
      if (clear != CITIZENSDK_OK &&
          clear != CITIZENSDK_ERROR_INVALID_HANDLE) {
        const auto abandon = citizensdk_host_abandon(host_);
        if (abandon != CITIZENSDK_OK &&
            abandon != CITIZENSDK_ERROR_INVALID_HANDLE) {
          std::terminate();
        }
        transferred = true;
      }
      event_context_.reset();
    }
    const auto code = transferred ? CITIZENSDK_OK
                                  : citizensdk_host_destroy(host_);
    if (!transferred && code != CITIZENSDK_OK &&
        code != CITIZENSDK_ERROR_INVALID_HANDLE) {
      // abandon transfers the complete Host/Core/store/vault graph to its
      // process supervisor; it never borrows this C++ object or event context.
      const auto abandon = citizensdk_host_abandon(host_);
      if (abandon != CITIZENSDK_OK &&
          abandon != CITIZENSDK_ERROR_INVALID_HANDLE) {
        std::terminate();
      }
    }
    host_ = 0;
    sdk_ = 0;
    operations_.reset();
  }

  citizensdk_host_handle_t host_{};
  citizensdk_handle_t sdk_{};
  std::unique_ptr<detail::EventContext> event_context_;
  std::shared_ptr<detail::AsyncOwner> operations_;
};

}  // namespace citizen_sdk

#endif
