#ifndef CITIZENSDK_WINDOWS_HOST_BRIDGE_HPP
#define CITIZENSDK_WINDOWS_HOST_BRIDGE_HPP

#include <condition_variable>
#include <filesystem>
#include <functional>
#include <memory>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include "citizen_sdk_assets.hpp"
#include "citizen_sdk_window.hpp"
#include "citizen_sdk_lifecycle.hpp"
#include "citizen_sdk_operation.hpp"
#include "citizen_sdk_public_store.hpp"
#include "citizen_sdk_secret_vault.hpp"
#include "citizen_sdk/citizensdk_host.h"

namespace citizen_sdk::windows {

class QrCapture;

class HostBridge final : public std::enable_shared_from_this<HostBridge> {
 public:
  HostBridge(std::filesystem::path storage_root,
             std::filesystem::path asset_root, std::string application_id,
             void *hwnd, uint32_t modules);
  HostBridge(const HostBridge &) = delete;
  HostBridge &operator=(const HostBridge &) = delete;
  ~HostBridge();

  citizensdk_error_code_t create_sdk(citizensdk_handle_t *out_sdk);
  uint32_t modules() const noexcept { return modules_; }
  citizensdk_handle_t sdk() const noexcept;
  citizensdk_handle_t public_sdk() const noexcept;
  citizensdk_error_code_t set_event_callback(citizensdk_event_callback_t callback,
                                             void *context);
  citizensdk_error_code_t set_parent_window(void *hwnd) noexcept;
  WindowLease acquire_parent_window() const noexcept;
  citizensdk_host_vault_availability_t vault_availability() noexcept;
  citizensdk_error_code_t close();
  citizensdk_error_code_t set_credential_provider(const citizensdk_credential_provider_v1_t *provider);
  citizensdk_error_code_t respond_credential(uint64_t host_operation_id, citizensdk_bytes_view_t credential);
  citizensdk_error_code_t cancel_credential(uint64_t host_operation_id);

  citizensdk_error_code_t open_qr_capture(uint32_t purpose, const citizensdk_qr_capture_callbacks_v1_t &, uint64_t *out_resource);
  citizensdk_error_code_t control_qr_capture(uint64_t resource, uint64_t operation, uint32_t action, uint8_t enabled);
  Bytes decode_qr_image(citizensdk_bytes_view_t encoded, uint32_t purpose);

  RequestRouter &private_requests() noexcept { return private_requests_; }
  citizensdk_error_code_t submit_private(
      const std::function<citizensdk_error_code_t(citizensdk_request_id_t *)> &accept,
      RequestRouter::Handler handler, citizensdk_request_id_t *out_request,
      RequestRouter::Cancellation cancel = {});

  HostRecord chain_load();
  HostRecord chain_cas(uint64_t expected, const Bytes &candidate);
  HostRecord runtime_load(const std::array<uint8_t, 32> &hash);
  void runtime_store(const std::array<uint8_t, 32> &hash,
                     const Bytes &candidate);
  void runtime_delete(const std::array<uint8_t, 32> &hash);
  HostRecord history_query(const Bytes &query);
  HostRecord history_mutate(uint64_t expected, const Bytes &mutation);
  HostRecord profile_load();
  HostRecord profile_cas(uint64_t expected, const Bytes &candidate);
  bool has_account_secret(const std::array<uint8_t, 32> &account_id);
  bool has_any_wallet_key(uint32_t wallet_index);
  HostRecord secret_load(const SecretIdentity &identity);
  HostRecord secret_cas(const SecretIdentity &identity, uint64_t expected,
                        const Bytes &candidate);
  void vault_authorize_add_accounts(uint64_t host_operation_id, const WalletKey &key,
      const std::array<uint8_t, 16> &operation_id);
  void vault_ensure(uint64_t host_operation_id, const WalletKey &key,
                    const std::array<uint8_t, 16> &operation_id);
  bool vault_has(const WalletKey &key);
  Bytes vault_wrap(uint64_t host_operation_id, const WalletKey &key,
                   const std::array<uint8_t, 16> &operation_id,
                   const uint8_t plaintext_dek[32]);
  void vault_unwrap(uint64_t host_operation_id, const WalletKey &key,
                    const Bytes &wrapped_dek, uint8_t plaintext_dek_out[32]);
  void vault_retire(const WalletKey &key,
                    const std::array<uint8_t, 16> &operation_id);

 private:
  struct CaptureOwner;
  void close_qr_captures();
  std::map<uint64_t, std::shared_ptr<QrCapture>> captures_;
  uint64_t next_capture_{1};
  bool capture_ids_exhausted_{};
  static void receive_core_event(void *context,
                                 const citizensdk_event_t *event) noexcept;
  void dispatch_core_event(const citizensdk_event_t &event) noexcept;
  void dispatch_routed_event(const citizensdk_event_t &event) noexcept;
  citizensdk_host_services_v1_t services() noexcept;
  void configure_vtables() noexcept;
  class ServiceLease final {
   public:
    explicit ServiceLease(HostBridge &host) : host_(host) {
      std::lock_guard<std::recursive_mutex> guard(host_.call_lock_);
      require(!host_.services_retired_, CITIZENSDK_ERROR_INVALID_STATE,
              "CitizenSDK Host services are retired");
      host_.lifecycle_.begin_service();
    }
    ServiceLease(const ServiceLease &) = delete;
    ServiceLease &operator=(const ServiceLease &) = delete;
    ~ServiceLease() { host_.lifecycle_.finish_service(); }
   private:
    HostBridge &host_;
  };
  template <typename Function>
  auto service_call(Function function) -> decltype(function()) {
    // 短租约保护Host资源生命周期；凭据等待不持有Host锁，
    // 允许宿主异步回包、查询状态和发起真实取消/关闭。
    ServiceLease lease(*this);
    return function();
  }

  std::thread::id ui_thread_;
  WindowRef parent_window_;
  std::filesystem::path asset_root_;
  const uint32_t modules_;
  std::unique_ptr<PublicStore> public_store_;
  std::unique_ptr<SecureStore> secure_store_;
  std::unique_ptr<SecretVault> vault_;
  citizensdk_host_public_store_v1_t public_vtable_{};
  citizensdk_host_secure_store_v1_t secure_vtable_{};
  citizensdk_host_secret_vault_v1_t vault_vtable_{};

  mutable std::recursive_mutex call_lock_;
  mutable std::mutex callback_lock_;
  std::condition_variable callback_idle_;
  citizensdk_event_callback_t public_callback_{};
  void *public_callback_context_{};
  std::thread::id callback_thread_{};
  uint32_t callbacks_active_{};
  RequestRouter private_requests_;
  std::mutex private_submit_lock_;
  CompletionAdmission completion_admission_;
  Lifecycle lifecycle_;
  citizensdk_handle_t sdk_{};
  bool capability_subscribed_{false};
  bool callback_installed_{false};
  bool callback_update_in_progress_{false};
  bool create_in_progress_{false};
  bool close_in_progress_{false};
  bool teardown_started_{false};
  bool services_retired_{false};
};

}  // namespace citizen_sdk::windows

#endif
