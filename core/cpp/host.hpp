// 两平台共同编译这份真实实现；条件块只保留系统调用差异。
#ifndef CITIZENSDK_HOST_HPP
#define CITIZENSDK_HOST_HPP

#include "citizen_sdk_assets.hpp"
#include <condition_variable>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#if defined(_WIN32) // 系统差异
#include "citizen_sdk_window.hpp"
#endif
#include "citizen_sdk_secret_vault.hpp"
#include "citizen_sdk_sqlite.hpp"
#include "citizensdk_host.h"
#include "operation.hpp"
#include "sqlite.hpp"

#if defined(_WIN32) // 系统差异
namespace citizen_sdk::windows {
#else  // 系统差异
namespace citizen_sdk::linux {
#endif // 系统差异

class QrCapture;
#if !defined(_WIN32)

// 宿主GTK对象的短期强引用仅在捕获的宿主线程创建/归还；不绘制SDK界面。
class GtkParentLease final {
public:
  GtkParentLease() = default;
  GtkParentLease(void *window, std::thread::id ui_thread) noexcept;
  GtkParentLease(const GtkParentLease &) = delete;
  GtkParentLease &operator=(const GtkParentLease &) = delete;
  GtkParentLease(GtkParentLease &&other) noexcept;
  GtkParentLease &operator=(GtkParentLease &&other) noexcept;
  ~GtkParentLease();

  void *get() const noexcept { return window_; }
  explicit operator bool() const noexcept { return window_ != nullptr; }

private:
  void clear() noexcept;
  void *window_{};
  std::thread::id ui_thread_{};
};

// 宿主对象只以GWeakRef保存，宿主销毁窗口时自动失效；短期提升不改变宿主所有权。
class GtkParentRef final {
public:
  GtkParentRef(void *window, std::thread::id ui_thread);
  GtkParentRef(const GtkParentRef &) = delete;
  GtkParentRef &operator=(const GtkParentRef &) = delete;
  ~GtkParentRef();

  citizensdk_error_code_t set(void *window) noexcept;
  GtkParentLease acquire() const noexcept;
  bool on_ui_thread() const noexcept;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::thread::id ui_thread_;
};
#endif

class Host final : public std::enable_shared_from_this<Host> {
public:
  Host(std::filesystem::path storage_root, std::filesystem::path asset_root,
       std::string application_id,
#if defined(_WIN32) // 系统差异
       void *hwnd, uint32_t modules);
#else  // 系统差异
       void *parent, uint32_t modules);
#endif // 系统差异
  Host(const Host &) = delete;
  Host &operator=(const Host &) = delete;
  ~Host();

  citizensdk_error_code_t create_sdk(citizensdk_handle_t *out_sdk);
  uint32_t modules() const noexcept { return modules_; }
  citizensdk_handle_t sdk() const noexcept;
  citizensdk_handle_t public_sdk() const noexcept;
  citizensdk_error_code_t
  set_event_callback(citizensdk_event_callback_t callback, void *context);
#if defined(_WIN32) // 系统差异
  citizensdk_error_code_t set_parent_window(void *hwnd) noexcept;
  WindowLease acquire_parent_window() const noexcept;
#else  // 系统差异
  citizensdk_error_code_t set_parent_window(void *parent) noexcept;
  GtkParentLease acquire_parent_window() const noexcept;
#endif // 系统差异
  citizensdk_host_vault_availability_t vault_availability() noexcept;
  citizensdk_error_code_t close();
  citizensdk_error_code_t
  set_credential_provider(const citizensdk_credential_provider_v1_t *provider);
  citizensdk_error_code_t
  respond_credential(uint64_t host_operation_id,
                     citizensdk_bytes_view_t credential);
  citizensdk_error_code_t cancel_credential(uint64_t host_operation_id);

  citizensdk_error_code_t
  open_qr_capture(uint32_t purpose,
                  const citizensdk_qr_capture_callbacks_v1_t &,
                  uint64_t *out_resource);
  citizensdk_error_code_t control_qr_capture(uint64_t resource,
                                             uint64_t operation,
                                             uint32_t action, uint8_t enabled);
  Bytes decode_qr_image(citizensdk_bytes_view_t encoded, uint32_t purpose);

  RequestRouter &private_requests() noexcept { return private_requests_; }
  citizensdk_error_code_t submit_private(
      const std::function<citizensdk_error_code_t(citizensdk_request_id_t *)>
          &accept,
      RequestRouter::Handler handler, citizensdk_request_id_t *out_request,
      RequestRouter::Cancellation cancel = {});

  bool has_any_wallet_key(uint32_t wallet_index);
  void
  vault_authorize_add_accounts(uint64_t host_operation_id, const WalletKey &key,
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

  void configure_vtables() noexcept;
  class ServiceLease final {
  public:
    explicit ServiceLease(Host &host) : host_(host) {
      std::lock_guard<std::recursive_mutex> guard(host_.call_lock_);
      require(!host_.services_retired_, CITIZENSDK_ERROR_INVALID_STATE,
              "CitizenSDK Host services are retired");
      host_.begin_service();
    }
    ServiceLease(const ServiceLease &) = delete;
    ServiceLease &operator=(const ServiceLease &) = delete;
    ~ServiceLease() { host_.finish_service(); }

  private:
    Host &host_;
  };
  template <typename Function>
  auto service_call(Function function) -> decltype(function()) {
    // 短租约保护Host资源生命周期；凭据等待不持有Host锁，
    // 允许宿主异步回包、查询状态和发起真实取消/关闭。
    ServiceLease lease(*this);
    return function();
  }

  std::thread::id ui_thread_;
#if defined(_WIN32) // 系统差异
  WindowRef parent_window_;
#else  // 系统差异
  GtkParentRef parent_window_;
#endif // 系统差异
  std::filesystem::path asset_root_;
  const uint32_t modules_;
  std::unique_ptr<citizen_sdk::Database<SQLiteStore, HostError>> database_;
  std::unique_ptr<citizen_sdk::Database<SQLiteStore, HostError>>
      secure_database_;
  std::unique_ptr<VaultStore> metadata_;
  std::unique_ptr<SecretVault> vault_;

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
  // 真实Host直接拥有服务租约与单调关闭状态。
  void begin_service();
  void finish_service() noexcept;
  bool begin_service_close();
  void cancel_service_close(bool teardown_started) noexcept;
  void commit_service_closed() noexcept;
  enum class ServiceState { kOpen, kClosing, kClosed };
  std::mutex service_lock_;
  ServiceState service_state_{ServiceState::kOpen};
  uint64_t service_count_{};
  bool service_close_active_{false};
  citizensdk_handle_t sdk_{};
  bool capability_subscribed_{false};
  bool callback_installed_{false};
  bool callback_update_in_progress_{false};
  bool create_in_progress_{false};
  bool close_in_progress_{false};
  bool teardown_started_{false};
  bool services_retired_{false};
};

#if defined(_WIN32) // 系统差异
} // namespace citizen_sdk::windows
#else  // 系统差异
} // namespace citizen_sdk::linux
#endif // 系统差异

#endif
