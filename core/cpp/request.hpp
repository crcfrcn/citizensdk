// 实际Host请求/凭据回调拥有者，不定义第二套业务结果。
#ifndef CITIZENSDK_REQUEST_HPP
#define CITIZENSDK_REQUEST_HPP
#include "environment.hpp"
#include "value.hpp"
#include <atomic>
#include <functional>
#include <future>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <thread>
namespace citizen_sdk::flutter {
inline void throw_if_error(citizensdk_error_code_t code, const char *message) {
  if (code != CITIZENSDK_OK)
    throw ContractFailure(code, message);
}
namespace detail {
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
  if (box->references.fetch_sub(1) == 1)
    delete box;
}
inline void install_credential_provider(citizensdk_host_handle_t host,
                                        const Config &config) {
  if (!config.credentialProvider)
    return;
  auto state = std::make_shared<CredentialProviderState>();
  state->host = host;
  state->provide = config.credentialProvider;
  auto *box = new CredentialProviderBox();
  box->state = state;
  citizensdk_credential_provider_v1_t provider{
      sizeof(citizensdk_credential_provider_v1_t),
      CITIZENSDK_ABI_VERSION,
      box,
      +[](void *raw, const citizensdk_credential_challenge_v1_t *request) {
        const auto state = static_cast<CredentialProviderBox *>(raw)->state;
        if (request == nullptr || request->struct_size != sizeof(*request) ||
            request->abi_version != CITIZENSDK_ABI_VERSION ||
            request->host_operation_id == 0 || request->reserved != 0 ||
            (request->key_purpose != 1 && request->key_purpose != 2))
          throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                                "Credential challenge is invalid");
        auto pending = std::make_shared<CredentialProviderState::Pending>();
        CredentialChallenge challenge;
        challenge.host_operation_id = request->host_operation_id;
        challenge.key_purpose = request->key_purpose == 1 ? "create" : "unlock";
        challenge.cancelled = pending->cancelled.get_future().share();
        {
          std::lock_guard<std::mutex> guard(state->lock);
          if (!state->pending.emplace(challenge.host_operation_id, pending)
                   .second)
            throw ContractFailure(CITIZENSDK_ERROR_CONFLICT,
                                  "Credential challenge is already active");
        }
        try {
          std::thread([state, pending, challenge] {
            struct CredentialBytes final {
              std::optional<std::vector<uint8_t>> value;
              ~CredentialBytes() {
                if (!value)
                  return;
                volatile uint8_t *data = value->data();
                for (std::size_t i = 0; i < value->size(); ++i)
                  data[i] = 0;
              }
            } bytes;
            bool invoke = false;
            {
              std::lock_guard<std::mutex> guard(state->lock);
              invoke = !pending->revoked;
            }
            if (invoke) {
              try {
                bytes.value = state->provide(challenge).get();
              } catch (...) {
                bytes.value.reset();
              } // 不传播可能带秘密的宿主异常文案。
            }
            bool deliver = false;
            {
              std::lock_guard<std::mutex> guard(state->lock);
              deliver = !pending->revoked;
            }
            if (deliver) {
              // 不持有适配器锁反调Host，避免关闭->idle和回包之间的锁顺序倒置。
              const uint8_t nonnull_empty = 0;
              const citizensdk_bytes_view_t view =
                  bytes.value
                      ? citizensdk_bytes_view_t{bytes.value->empty()
                                                    ? &nonnull_empty
                                                    : bytes.value->data(),
                                                static_cast<uint64_t>(
                                                    bytes.value->size())}
                      : citizensdk_bytes_view_t{nullptr, 0};
              (void)citizensdk_host_respond_credential(
                  state->host, challenge.host_operation_id, view);
            }
            // 先清零结果再报告排空；取消通知绝不伪造提供者Future完成。
            if (bytes.value) {
              volatile uint8_t *data = bytes.value->data();
              for (std::size_t i = 0; i < bytes.value->size(); ++i)
                data[i] = 0;
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
        if (found == state->pending.end() || found->second->revoked)
          return;
        found->second->revoked = true;
        found->second->cancelled.set_value();
      },
      +[](void *raw) {
        auto *box = static_cast<CredentialProviderBox *>(raw);
        if (box->references.fetch_add(1) ==
            std::numeric_limits<uint32_t>::max())
          std::terminate();
      },
      release_credential_provider,
      +[](void *raw) -> uint8_t {
        const auto state = static_cast<CredentialProviderBox *>(raw)->state;
        std::lock_guard<std::mutex> guard(state->lock);
        return state->pending.empty() ? 1 : 0;
      }};
  const auto code = citizensdk_host_set_credential_provider(host, &provider);
  release_credential_provider(
      box); // 成功时Host已经retain；失败时释放唯一所有权。
  throw_if_error(code, "CitizenSDK credential provider registration failed");
}

struct RequestBox final {
  std::atomic<uint32_t> references{1};
  std::function<citizensdk_error_code_t(citizensdk_handle_t,
                                        citizensdk_request_id_t *)>
      accept;
  std::function<void(citizensdk_request_id_t, citizensdk_result_handle_t)>
      complete;
  std::function<void(citizensdk_handle_t)> cancel;
};
inline void release_request_box(void *raw) noexcept {
  auto *box = static_cast<RequestBox *>(raw);
  const auto previous = box->references.fetch_sub(1);
  if (previous == 0)
    std::terminate();
  if (previous == 1)
    delete box;
}

inline citizensdk_error_code_t submit_request(
    citizensdk_host_handle_t host,
    std::function<citizensdk_error_code_t(citizensdk_handle_t,
                                          citizensdk_request_id_t *)>
        accept,
    std::function<void(citizensdk_request_id_t, citizensdk_result_handle_t)>
        complete,
    std::function<void(citizensdk_handle_t)> cancel,
    citizensdk_request_id_t *out) {
  if (!accept || !complete || out == nullptr)
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  *out = 0;
  auto *box = new RequestBox();
  box->accept = std::move(accept);
  box->complete = std::move(complete);
  box->cancel = std::move(cancel);
  const citizensdk_host_request_v1_t callbacks{
      sizeof(citizensdk_host_request_v1_t),
      CITIZENSDK_HOST_ABI_VERSION,
      box,
      +[](void *raw, citizensdk_handle_t core,
          citizensdk_request_id_t *request) -> citizensdk_error_code_t {
        auto *state = static_cast<RequestBox *>(raw);
        // Core已同步复制输入后立即释放接纳闭包，避免秘密输入随整个异步请求驻留。
        auto function = std::move(state->accept);
        try {
          return function(core, request);
        } catch (const ContractFailure &error) {
          return error.code;
        } catch (...) {
          return CITIZENSDK_ERROR_INTERNAL;
        }
      },
      +[](void *raw, citizensdk_request_id_t request,
          citizensdk_result_handle_t result) {
        static_cast<RequestBox *>(raw)->complete(request, result);
      },
      +[](void *raw, citizensdk_handle_t core) {
        auto *state = static_cast<RequestBox *>(raw);
        if (state->cancel)
          state->cancel(core);
      },
      +[](void *raw) {
        auto *state = static_cast<RequestBox *>(raw);
        if (state->references.fetch_add(1) ==
            std::numeric_limits<uint32_t>::max())
          std::terminate();
      },
      release_request_box};
  const auto code = citizensdk_host_submit_request(host, &callbacks, out);
  release_request_box(box);
  return code;
}
struct EventResultScope final {
  explicit EventResultScope(citizensdk_result_handle_t value) noexcept
      : value(value) {}
  EventResultScope(const EventResultScope &) = delete;
  EventResultScope &operator=(const EventResultScope &) = delete;
  ~EventResultScope() {
    if (value != 0)
      (void)citizensdk_result_release(value);
  }
  citizensdk_result_handle_t value{};
};
} // namespace detail
} // namespace citizen_sdk::flutter
#endif
