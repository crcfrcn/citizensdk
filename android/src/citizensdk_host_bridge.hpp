#ifndef CITIZENSDK_HOST_BRIDGE_HPP
#define CITIZENSDK_HOST_BRIDGE_HPP

// 管理 Android JNI 宿主与 Core 实例的生命周期、准备资源和异步回调登记。
#include <jni.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "citizensdk.h"

namespace citizen::sdk::jni {

// JNI仅借用同一Host资源；不登记第二套句柄或状态。
struct DatabaseContext {
  JavaVM *vm;
  jobject host;
  bool secure;
};
jboolean store_generation(JNIEnv *, jclass, jobject, jint, jint, jbyteArray,
                          jbyteArray);
jbyteArray store_generations(JNIEnv *, jclass, jobject);
class CitizenSdkHostBridge final {
public:
  CitizenSdkHostBridge(JavaVM *vm, JNIEnv *env, jobject host_services);
  ~CitizenSdkHostBridge();
  CitizenSdkHostBridge(const CitizenSdkHostBridge &) = delete;
  CitizenSdkHostBridge &operator=(const CitizenSdkHostBridge &) = delete;

  bool create(JNIEnv *env, const std::vector<uint8_t> &manifest,
              const std::vector<uint8_t> &chain_spec,
              const std::vector<uint8_t> &sync_state, uint32_t modules);
  bool bind(JNIEnv *env, jobject native_owner);
  bool destroy(JNIEnv *env);

  citizensdk_handle_t handle() const { return handle_; }
  jobject host_services() const { return host_services_; }
  JavaVM *vm() const { return vm_; }

  void remember_prepared(uint64_t token,
                         citizensdk_prepared_wallet_handle_t handle);
  bool prepared(uint64_t token, citizensdk_prepared_wallet_handle_t *out) const;
  bool forget_prepared(uint64_t token,
                       citizensdk_prepared_wallet_handle_t *out);

  void remember_vault_status(uint64_t operation_id, void *sdk_context,
                             citizensdk_host_status_completion_v1_t completion);
  bool reject_vault_status(uint64_t operation_id);
  void complete_vault_status(uint64_t operation_id, int32_t error_code);

  int32_t release_completion(uint64_t result, bool keep);
  void dispatch_event(const citizensdk_event_t &event);
  bool has_qr_review(uint64_t result) const;
  int32_t inspect_wallets(citizensdk_request_id_t *out);
  bool has_wallet_inspection(uint64_t result) const;
  int32_t release_wallet_inspection(uint64_t result);
  void release_qr_review(uint64_t result);

private:
  struct PendingVaultStatus {
    void *sdk_context;
    citizensdk_host_status_completion_v1_t completion;
  };

  JavaVM *vm_;
  jobject host_services_;
  jobject native_owner_ = nullptr;
  citizensdk_handle_t handle_ = 0;
  bool callback_bound_ = false;
  bool capability_subscribed_ = false;
  citizensdk_store_v1_t database_{};
  DatabaseContext public_context_{};
  DatabaseContext secure_context_{};
  citizensdk_store_v1_t secure_database_{};
  citizensdk_host_secret_vault_v1_t vault_{};

  mutable std::mutex prepared_mutex_;
  std::unordered_map<uint64_t, citizensdk_prepared_wallet_handle_t> prepared_;
  std::mutex vault_status_mutex_;
  std::unordered_map<uint64_t, PendingVaultStatus> vault_status_operations_;
  mutable std::mutex qr_mutex_;
  std::unordered_set<uint64_t> qr_reviews_;
  mutable std::mutex inspection_mutex_;
  std::unordered_set<uint64_t> inspection_requests_;
  std::unordered_set<uint64_t> wallet_inspections_;
};

} // namespace citizen::sdk::jni

#endif // CITIZENSDK_HOST_BRIDGE_HPP
