#include "citizen_sdk_host_bridge.hpp"
#include "citizen_sdk_qr_camera.hpp"

#include <algorithm>
#include <cstring>
#include <exception>
#include <iterator>
#include <limits>
#include <thread>
#include <utility>
#include "citizen_sdk_input_limits.hpp"

#if CITIZENSDK_ENABLE_QR_CAPTURE
#include <gtk/gtk.h>
#endif

namespace citizen_sdk::linux {

struct GtkParentRef::Impl final {
  std::mutex lock;
#if CITIZENSDK_ENABLE_QR_CAPTURE
  GWeakRef weak{};
  bool initialized{false};
#endif
};

GtkParentLease::GtkParentLease(void *window,
                               std::thread::id ui_thread) noexcept
    : window_(window), ui_thread_(ui_thread) {}

GtkParentLease::GtkParentLease(GtkParentLease &&other) noexcept
    : window_(other.window_), ui_thread_(other.ui_thread_) {
  other.window_ = nullptr;
}

GtkParentLease &GtkParentLease::operator=(GtkParentLease &&other) noexcept {
  if (this != &other) {
    clear();
    window_ = other.window_;
    ui_thread_ = other.ui_thread_;
    other.window_ = nullptr;
  }
  return *this;
}

GtkParentLease::~GtkParentLease() { clear(); }

void GtkParentLease::clear() noexcept {
#if CITIZENSDK_ENABLE_QR_CAPTURE
  if (window_ != nullptr) {
    if (std::this_thread::get_id() != ui_thread_) std::terminate();
    g_object_unref(window_);
    window_ = nullptr;
  }
#else
  window_ = nullptr;
#endif
}

GtkParentRef::GtkParentRef(void *window, std::thread::id ui_thread)
    : impl_(std::make_unique<Impl>()), ui_thread_(ui_thread) {
#if CITIZENSDK_ENABLE_QR_CAPTURE
  g_weak_ref_init(&impl_->weak, nullptr);
  impl_->initialized = true;
#endif
  const citizensdk_error_code_t code = set(window);
  if (code != CITIZENSDK_OK) {
    throw HostError(code, "CitizenSDK GTK parent window is invalid");
  }
}

GtkParentRef::~GtkParentRef() {
#if CITIZENSDK_ENABLE_QR_CAPTURE
  if (impl_ && impl_->initialized) {
    std::lock_guard<std::mutex> guard(impl_->lock);
    g_weak_ref_clear(&impl_->weak);
    impl_->initialized = false;
  }
#endif
}

citizensdk_error_code_t GtkParentRef::set(void *window) noexcept {
  if (!on_ui_thread()) return CITIZENSDK_ERROR_BUSY;
#if !CITIZENSDK_ENABLE_QR_CAPTURE
  return window == nullptr ? CITIZENSDK_OK : CITIZENSDK_ERROR_UNSUPPORTED;
#else
  if (window != nullptr &&
      (!GTK_IS_WINDOW(window) ||
       gtk_widget_in_destruction(GTK_WIDGET(window)))) {
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  try {
    std::lock_guard<std::mutex> guard(impl_->lock);
    g_weak_ref_set(&impl_->weak,
                   window == nullptr ? nullptr : G_OBJECT(window));
    return CITIZENSDK_OK;
  } catch (...) {
    return CITIZENSDK_ERROR_INTERNAL;
  }
#endif
}

GtkParentLease GtkParentRef::acquire() const noexcept {
  if (!on_ui_thread()) return {};
#if !CITIZENSDK_ENABLE_QR_CAPTURE
  return {};
#else
  try {
    std::lock_guard<std::mutex> guard(impl_->lock);
    GObject *object = static_cast<GObject *>(g_weak_ref_get(&impl_->weak));
    if (object == nullptr) return {};
    if (!GTK_IS_WINDOW(object) ||
        gtk_widget_in_destruction(GTK_WIDGET(object))) {
      g_object_unref(object);
      return {};
    }
    return GtkParentLease(object, ui_thread_);
  } catch (...) {
    return {};
  }
#endif
}

bool GtkParentRef::on_ui_thread() const noexcept {
  return std::this_thread::get_id() == ui_thread_;
}

namespace {

std::array<uint8_t, 16> id16(citizensdk_host_id128_t value) {
  std::array<uint8_t, 16> result{};
  std::copy(std::begin(value.bytes), std::end(value.bytes), result.begin());
  return result;
}

std::array<uint8_t, 32> hash32(citizensdk_host_hash32_t value) {
  std::array<uint8_t, 32> result{};
  std::copy(std::begin(value.bytes), std::end(value.bytes), result.begin());
  return result;
}

WalletKey wallet_key(citizensdk_host_wallet_key_ref_v1_t value) {
  require(value.struct_size >= sizeof(value) && value.abi_version == 1 &&
              value.wallet_index == 0 && value.reserved == 0,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "wallet key reference ABI is invalid");
  return {value.wallet_index, id16(value.generation)};
}

SecretIdentity secret_identity(citizensdk_host_secret_ref_v1_t value) {
  require(value.struct_size >= sizeof(value) && value.abi_version == 1 &&
              value.wallet_index == 0 &&
              value.kind == CITIZENSDK_HOST_SECRET_ACCOUNT_MINI_SECRET,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "secret reference ABI is invalid");
  SecretIdentity result{};
  result.wallet_index = value.wallet_index;
  result.kind = value.kind;
  result.generation = id16(value.generation);
  result.owner = id16(value.owner);
  std::copy(std::begin(value.account_id.bytes), std::end(value.account_id.bytes),
            result.account_id.begin());
  return result;
}

void complete_record(uint64_t operation_id, void *sdk_context,
                     citizensdk_host_record_completion_v1_t completion,
                     const HostRecord &record) {
  citizensdk_host_record_result_v1_t result{};
  result.struct_size = sizeof(result);
  result.abi_version = 1;
  result.host_operation_id = operation_id;
  result.error_code = record.error_code;
  result.domain = record.domain;
  result.present = record.error_code == CITIZENSDK_OK && record.present ? 1 : 0;
  result.revision = result.present != 0 ? record.revision : 0;
  if (result.present != 0) {
    result.record = {record.record.data(),
                     static_cast<uint64_t>(record.record.size())};
  }
  completion(sdk_context, &result);
}

void complete_status(uint64_t operation_id, void *sdk_context,
                     citizensdk_host_status_completion_v1_t completion,
                     citizensdk_error_code_t code) {
  citizensdk_host_status_result_v1_t result{};
  result.struct_size = sizeof(result);
  result.abi_version = 1;
  result.host_operation_id = operation_id;
  result.error_code = code;
  completion(sdk_context, &result);
}

HostBridge &host(void *context) {
  require(context != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK Host context is missing");
  return *static_cast<HostBridge *>(context);
}

citizensdk_error_code_t chain_load(void *context, uint64_t operation_id,
    void *sdk_context, citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
                        host(context).chain_load()); return CITIZENSDK_OK; }
  catch (...) { return map_exception(); }
}

citizensdk_error_code_t chain_cas(void *context, uint64_t operation_id,
    uint64_t expected, uint8_t present, citizensdk_bytes_view_t candidate,
    void *sdk_context, citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr || present != 1) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
      host(context).chain_cas(expected, copy_view(candidate,
          input_limits::kMaximumChainDatabaseBytes, "chain database is too large")));
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t runtime_load(void *context, uint64_t operation_id,
    citizensdk_host_hash32_t hash, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
                        host(context).runtime_load(hash32(hash)));
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t runtime_store(void *context, uint64_t operation_id,
    citizensdk_host_hash32_t hash, citizensdk_bytes_view_t candidate,
    void *sdk_context, citizensdk_host_status_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { host(context).runtime_store(hash32(hash), copy_view(candidate,
          input_limits::kMaximumRuntimeCacheBytes, "runtime cache is too large"));
    complete_status(operation_id, sdk_context, completion, CITIZENSDK_OK);
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t runtime_delete(void *context, uint64_t operation_id,
    citizensdk_host_hash32_t hash, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { host(context).runtime_delete(hash32(hash));
    complete_status(operation_id, sdk_context, completion, CITIZENSDK_OK);
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t history_query(void *context, uint64_t operation_id,
    citizensdk_bytes_view_t query, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
      host(context).history_query(copy_view(query,
          input_limits::kTransactionHistoryQueryBytes,
          "transaction history query has invalid size"))); return CITIZENSDK_OK; }
  catch (...) { return map_exception(); }
}

citizensdk_error_code_t history_mutate(void *context, uint64_t operation_id,
    uint64_t expected, citizensdk_bytes_view_t mutation, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
      host(context).history_mutate(expected, copy_view(mutation,
          input_limits::kMaximumTransactionHistoryBytes, "transaction history is too large")));
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t profile_load(void *context, uint64_t operation_id,
    void *sdk_context, citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
                        host(context).profile_load()); return CITIZENSDK_OK; }
  catch (...) { return map_exception(); }
}

citizensdk_error_code_t profile_cas(void *context, uint64_t operation_id,
    uint64_t expected, citizensdk_bytes_view_t candidate, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
      host(context).profile_cas(expected, copy_view(candidate,
          input_limits::kMaximumWalletProfileBytes, "wallet profile is too large")));
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t secret_load(void *context, uint64_t operation_id,
    citizensdk_host_secret_ref_v1_t secret, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
                        host(context).secret_load(secret_identity(secret)));
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t secret_cas(void *context, uint64_t operation_id,
    citizensdk_host_secret_ref_v1_t secret, uint64_t expected,
    citizensdk_bytes_view_t candidate, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { complete_record(operation_id, sdk_context, completion,
      host(context).secret_cas(secret_identity(secret), expected,
        copy_view(candidate, input_limits::kMaximumEncryptedSecretBytes,
                  "encrypted secret blob is too large")));
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t vault_availability(void *context, uint64_t operation_id,
    void *sdk_context,
    citizensdk_host_vault_availability_completion_v1_t completion) {
  if (context == nullptr || completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  citizensdk_host_vault_availability_result_v1_t result{};
  result.struct_size = sizeof(result); result.abi_version = 1;
  result.host_operation_id = operation_id; result.error_code = CITIZENSDK_OK;
  result.availability = static_cast<HostBridge *>(context)->vault_availability();
  completion(sdk_context, &result);
  return CITIZENSDK_OK;
}

// 该入口只完成本次追加认证，持久事务和目标账户集合由Core唯一管理。
citizensdk_error_code_t vault_authorize_add_accounts(void *context, uint64_t operation_id,
    citizensdk_host_wallet_key_ref_v1_t key, citizensdk_host_id128_t provisioning_id,
    void *sdk_context, citizensdk_host_status_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { host(context).vault_authorize_add_accounts(operation_id, wallet_key(key), id16(provisioning_id));
    complete_status(operation_id, sdk_context, completion, CITIZENSDK_OK);
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t vault_ensure(void *context, uint64_t operation_id,
    citizensdk_host_wallet_key_ref_v1_t key,
    citizensdk_host_id128_t provisioning_id, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { host(context).vault_ensure(operation_id, wallet_key(key), id16(provisioning_id));
    complete_status(operation_id, sdk_context, completion, CITIZENSDK_OK);
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

citizensdk_error_code_t vault_has(void *context, uint64_t operation_id,
    citizensdk_host_wallet_key_ref_v1_t key, void *sdk_context,
    citizensdk_host_bool_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { citizensdk_host_bool_result_v1_t result{};
    result.struct_size = sizeof(result); result.abi_version = 1;
    result.host_operation_id = operation_id; result.error_code = CITIZENSDK_OK;
    result.value = host(context).vault_has(wallet_key(key)) ? 1 : 0;
    completion(sdk_context, &result); return CITIZENSDK_OK;
  } catch (...) { return map_exception(); }
}


citizensdk_error_code_t account_secret_presence(void *context, uint64_t operation_id,
    citizensdk_account_id_t account_id, void *sdk_context, citizensdk_host_bool_completion_v1_t completion) {
  if (!completion) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try {
    std::array<uint8_t, 32> account{};
    std::copy(account_id.bytes, account_id.bytes + 32, account.begin());
    citizensdk_host_bool_result_v1_t result{};
    result.struct_size = sizeof(result); result.abi_version = 1; result.host_operation_id = operation_id;
    result.error_code = CITIZENSDK_OK; result.value = host(context).has_account_secret(account) ? 1 : 0;
    completion(sdk_context, &result); return CITIZENSDK_OK;
  } catch (...) { return map_exception(); }
}
citizensdk_error_code_t wallet_key_presence(void *context, uint64_t operation_id,
    uint32_t wallet_index, void *sdk_context, citizensdk_host_bool_completion_v1_t completion) {
  if (!completion) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try {
    citizensdk_host_bool_result_v1_t result{};
    result.struct_size = sizeof(result); result.abi_version = 1; result.host_operation_id = operation_id;
    result.error_code = CITIZENSDK_OK; result.value = host(context).has_any_wallet_key(wallet_index) ? 1 : 0;
    completion(sdk_context, &result); return CITIZENSDK_OK;
  } catch (...) { return map_exception(); }
}

citizensdk_error_code_t vault_wrap(void *context, uint64_t operation_id,
    citizensdk_host_wallet_key_ref_v1_t key,
    citizensdk_host_id128_t provisioning_id, citizensdk_bytes_view_t plaintext,
    void *sdk_context, citizensdk_host_bytes_completion_v1_t completion) {
  if (completion == nullptr || plaintext.data == nullptr ||
      plaintext.len != CITIZENSDK_HOST_DEK_BYTES) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { const Bytes wrapped = host(context).vault_wrap(operation_id, wallet_key(key),
      id16(provisioning_id), plaintext.data);
    citizensdk_host_bytes_result_v1_t result{};
    result.struct_size = sizeof(result); result.abi_version = 1;
    result.host_operation_id = operation_id; result.error_code = CITIZENSDK_OK;
    result.kind = CITIZENSDK_HOST_BYTES_WRAPPED_DEK;
    result.bytes = {wrapped.data(), static_cast<uint64_t>(wrapped.size())};
    completion(sdk_context, &result); return CITIZENSDK_OK;
  } catch (...) { return map_exception(); }
}

citizensdk_error_code_t vault_unwrap(void *context, uint64_t operation_id,
    citizensdk_host_wallet_key_ref_v1_t key, citizensdk_bytes_view_t wrapped,
    citizensdk_mutable_bytes_view_t output, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion) {
  if (completion == nullptr || output.data == nullptr ||
      output.len != CITIZENSDK_HOST_DEK_BYTES) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { host(context).vault_unwrap(operation_id, wallet_key(key),
      copy_view(wrapped, 4096, "wrapped wallet DEK is malformed"), output.data);
    complete_status(operation_id, sdk_context, completion, CITIZENSDK_OK);
    return CITIZENSDK_OK;
  } catch (...) {
    secure_zero(output.data, static_cast<std::size_t>(output.len));
    return map_exception();
  }
}

citizensdk_error_code_t vault_retire(void *context, uint64_t operation_id,
    citizensdk_host_wallet_key_ref_v1_t key,
    citizensdk_host_id128_t cleanup_id, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion) {
  if (completion == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  try { host(context).vault_retire(wallet_key(key), id16(cleanup_id));
    complete_status(operation_id, sdk_context, completion, CITIZENSDK_OK);
    return CITIZENSDK_OK; } catch (...) { return map_exception(); }
}

}  // namespace

HostBridge::HostBridge(std::filesystem::path storage_root,
                       std::filesystem::path asset_root,
                       std::string application_id, void *gtk_parent_window,
                       uint32_t modules)
    : ui_thread_(std::this_thread::get_id()),
      parent_window_(gtk_parent_window, ui_thread_),
      asset_root_(std::move(asset_root)),
      modules_(modules) {
  // 未选链/历史时不创建公开数据库，钱包独立运行完全不触碰链资产和存储。
  if ((modules & (CITIZENSDK_MODULE_CHAIN | CITIZENSDK_MODULE_HISTORY)) != 0) {
    public_store_ = std::make_unique<PublicStore>(
        storage_root / application_id / "citizensdk" / "v1" / "public");
  }
  const auto secure_root = storage_root / application_id / "citizensdk" / "v1" / "secure";
  if ((modules & (CITIZENSDK_MODULE_WALLET | CITIZENSDK_MODULE_SIGNING)) != 0) {
    secure_store_ = std::make_unique<SecureStore>(secure_root);
    vault_ = std::make_unique<SecretVault>(*secure_store_);
  }
  configure_vtables();
}

HostBridge::~HostBridge() = default;

// 采集与图像解码沿用同一服务租约；租约拥有Host，排空前Core/存储不能被释放。
struct HostBridge::CaptureOwner final {
  std::shared_ptr<HostBridge> host;
  ServiceLease service;
  explicit CaptureOwner(std::shared_ptr<HostBridge> value) : host(std::move(value)), service(*host) {}
};

citizensdk_error_code_t HostBridge::open_qr_capture(uint32_t purpose,
    const citizensdk_qr_capture_callbacks_v1_t &callbacks, uint64_t *out_resource) {
  require(out_resource != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集输出不能为空");
  std::shared_ptr<QrCapture> capture;
  uint64_t id = 0;
  {
    std::lock_guard<std::recursive_mutex> guard(call_lock_);
    require(!teardown_started_ && !close_in_progress_ && !create_in_progress_ && !services_retired_ && sdk_ != 0,
        CITIZENSDK_ERROR_INVALID_STATE, "Host尚未就绪或正在关闭");
    require((modules_ & CITIZENSDK_MODULE_QR) != 0, CITIZENSDK_ERROR_UNSUPPORTED, "未启用二维码模块");
    require(captures_.size() < 4, CITIZENSDK_ERROR_QUEUE_FULL, "采集资源已达上限");
    require(!capture_ids_exhausted_, CITIZENSDK_ERROR_UNAVAILABLE, "采集资源编号已耗尽");
    auto owner = std::make_shared<CaptureOwner>(shared_from_this());
    id = next_capture_;
    if (next_capture_ == UINT64_MAX) capture_ids_exhausted_ = true; else ++next_capture_;
    std::weak_ptr<HostBridge> weak = shared_from_this();
    capture = std::make_shared<QrCapture>(sdk_, id, purpose, callbacks, owner, [weak](uint64_t resource) {
      const auto host = weak.lock();
      if (!host) std::terminate(); // CaptureOwner在terminal返回前必须仍拥有Host。
      std::lock_guard<std::recursive_mutex> guard(host->call_lock_);
      host->captures_.erase(resource);
    });
    captures_.emplace(id, capture);
  }
  try { capture->start(); }
  catch (...) {
    std::lock_guard<std::recursive_mutex> guard(call_lock_); captures_.erase(id); throw;
  }
  *out_resource = id;
  return CITIZENSDK_OK;
}
citizensdk_error_code_t HostBridge::control_qr_capture(uint64_t resource, uint64_t operation,
                                                      uint32_t action, uint8_t enabled) {
  std::shared_ptr<QrCapture> capture;
  {
    std::lock_guard<std::recursive_mutex> guard(call_lock_);
    const auto found = captures_.find(resource);
    if (found == captures_.end()) return CITIZENSDK_ERROR_NOT_FOUND;
    capture = found->second;
  }
  // 不持Host锁进入资源门，避免回调重入控制时形成反向锁序。
  return capture->control(operation, action, enabled);
}
void HostBridge::close_qr_captures() {
  std::vector<std::shared_ptr<QrCapture>> captures;
  {
    std::lock_guard<std::recursive_mutex> guard(call_lock_);
    for (const auto &entry : captures_) captures.push_back(entry.second);
  }
  for (const auto &capture : captures) capture->request_close();
}
Bytes HostBridge::decode_qr_image(citizensdk_bytes_view_t encoded, uint32_t purpose) {
  citizensdk_handle_t sdk = 0;
  std::shared_ptr<CaptureOwner> owner;
  {
    std::lock_guard<std::recursive_mutex> guard(call_lock_);
    require(!teardown_started_ && !close_in_progress_ && !services_retired_ && sdk_ != 0,
        CITIZENSDK_ERROR_INVALID_STATE, "Host尚未就绪或正在关闭");
    require((modules_ & CITIZENSDK_MODULE_QR) != 0, CITIZENSDK_ERROR_UNSUPPORTED, "未启用二维码模块");
    owner = std::make_shared<CaptureOwner>(shared_from_this()); sdk = sdk_;
  }
  return decode_qr_image_documents(sdk, encoded, purpose);
}



void HostBridge::configure_vtables() noexcept {
  public_vtable_ = {sizeof(public_vtable_), 1, this, ::citizen_sdk::linux::chain_load,
    ::citizen_sdk::linux::chain_cas, ::citizen_sdk::linux::runtime_load,
    ::citizen_sdk::linux::runtime_store, ::citizen_sdk::linux::runtime_delete,
    ::citizen_sdk::linux::history_query, ::citizen_sdk::linux::history_mutate};
  // 每组回调必须完整或完全缺席；不可用模块不发布可触达的资源。
  if ((modules_ & CITIZENSDK_MODULE_CHAIN) == 0) {
    public_vtable_.chain_database_load = nullptr;
    public_vtable_.chain_database_compare_and_swap = nullptr;
    public_vtable_.runtime_cache_load = nullptr;
    public_vtable_.runtime_cache_store = nullptr;
    public_vtable_.runtime_cache_delete = nullptr;
  }
  if ((modules_ & CITIZENSDK_MODULE_HISTORY) == 0) {
    public_vtable_.transaction_history_query = nullptr;
    public_vtable_.transaction_history_mutate = nullptr;
  }
  secure_vtable_ = {sizeof(secure_vtable_), 1, this,
    ::citizen_sdk::linux::profile_load, ::citizen_sdk::linux::profile_cas,
    ::citizen_sdk::linux::secret_load, ::citizen_sdk::linux::secret_cas};
  vault_vtable_ = {sizeof(vault_vtable_), 1, this,
    ::citizen_sdk::linux::vault_availability, ::citizen_sdk::linux::vault_ensure,
    ::citizen_sdk::linux::vault_has, ::citizen_sdk::linux::vault_wrap,
    ::citizen_sdk::linux::vault_unwrap, ::citizen_sdk::linux::vault_retire,
    ::citizen_sdk::linux::vault_authorize_add_accounts};
}

citizensdk_host_services_v1_t HostBridge::services() noexcept {
  citizensdk_host_services_v1_t result{};
  result.struct_size = sizeof(result); result.abi_version = 1;
  result.public_store = public_store_ ? &public_vtable_ : nullptr;
  result.secure_store = secure_store_ ? &secure_vtable_ : nullptr;
  result.secret_vault = vault_ ? &vault_vtable_ : nullptr;
  return result;
}

citizensdk_error_code_t HostBridge::create_sdk(citizensdk_handle_t *out_sdk) {
  if (out_sdk == nullptr) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  *out_sdk = 0;
  {
    std::lock_guard<std::recursive_mutex> guard(call_lock_);
    if (sdk_ != 0 || teardown_started_ || create_in_progress_ ||
        close_in_progress_ || services_retired_) {
      return CITIZENSDK_ERROR_INVALID_STATE;
    }
    create_in_progress_ = true;
  }
  try {
    const Assets assets = (modules_ & CITIZENSDK_MODULE_CHAIN) != 0
        ? Assets::load(asset_root_) : Assets{};
    const std::string name = "CitizenSDK";
    const std::string version = CITIZENSDK_HOST_VERSION;
    citizensdk_create_options_t options{};
    options.struct_size = sizeof(options); options.abi_version = 1;
    options.asset_manifest = {assets.manifest.data(), static_cast<uint64_t>(assets.manifest.size())};
    options.chain_spec = {assets.chain_spec.data(), static_cast<uint64_t>(assets.chain_spec.size())};
    options.light_sync_state = {assets.light_sync_state.data(), static_cast<uint64_t>(assets.light_sync_state.size())};
    options.system_name = {reinterpret_cast<const uint8_t *>(name.data()), name.size()};
    options.system_version = {reinterpret_cast<const uint8_t *>(version.data()), version.size()};
    citizensdk_host_services_v1_t host_services = services();
    citizensdk_handle_t created = 0;
    citizensdk_error_code_t code =
        citizensdk_create_with_modules(&options, &host_services, modules_, &created);
    if (code != CITIZENSDK_OK) {
      // A nonzero error handle is a destroy-only Core instance. Preserve it so
      // close()/abandon can reclaim all Rust and provider ownership safely.
      if (created != 0) {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        sdk_ = created;
        teardown_started_ = true;
      }
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      create_in_progress_ = false;
      return code;
    }
    if (created == 0) {
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      create_in_progress_ = false;
      return CITIZENSDK_ERROR_INTEGRITY;
    }
    {
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      sdk_ = created;
    }
    if (secure_store_) {
      const citizensdk_host_secret_presence_v1_t presence{
          sizeof(citizensdk_host_secret_presence_v1_t), CITIZENSDK_ABI_VERSION, this,
          account_secret_presence, wallet_key_presence};
      code = citizensdk_set_secret_presence_provider(created, &presence);
    }
    if (code == CITIZENSDK_OK) code = citizensdk_set_event_callback(created, receive_core_event, this);
    if (code == CITIZENSDK_OK) {
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      callback_installed_ = true;
    }
    if (code == CITIZENSDK_OK) {
      code = citizensdk_subscribe_capability_changes(created);
      if (code == CITIZENSDK_OK) {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        capability_subscribed_ = true;
      }
    }
    if (code != CITIZENSDK_OK) {
      bool callback_installed = false;
      {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        teardown_started_ = true;
        callback_installed = callback_installed_;
      }
      if (callback_installed &&
          citizensdk_set_event_callback(created, nullptr, nullptr) ==
              CITIZENSDK_OK) {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        callback_installed_ = false;
        callback_installed = false;
      }
      if (!callback_installed && citizensdk_destroy(created) == CITIZENSDK_OK) {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        sdk_ = 0;
      }
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      create_in_progress_ = false;
      return code;
    }
    {
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      create_in_progress_ = false;
      *out_sdk = sdk_;
    }
    return CITIZENSDK_OK;
  } catch (...) {
    std::lock_guard<std::recursive_mutex> guard(call_lock_);
    create_in_progress_ = false;
    return map_exception();
  }
}

citizensdk_handle_t HostBridge::sdk() const noexcept {
  std::lock_guard<std::recursive_mutex> guard(call_lock_);
  return sdk_;
}

citizensdk_handle_t HostBridge::public_sdk() const noexcept {
  std::lock_guard<std::recursive_mutex> guard(call_lock_);
  return sdk_ != 0 && !teardown_started_ && !create_in_progress_ &&
                 !close_in_progress_ && !services_retired_ &&
                 callback_installed_ && capability_subscribed_
             ? sdk_
             : 0;
}

citizensdk_error_code_t HostBridge::set_event_callback(
    citizensdk_event_callback_t callback, void *context) {
  if (callback == nullptr) {
    std::lock_guard<std::mutex> guard(callback_lock_);
    if (callback_thread_ == std::this_thread::get_id()) {
      // A foreign setter may be waiting for this exact callback to return.
      // Self-retirement must not wait for that setter or reject the only safe
      // C++ destructor barrier. The setter owns its replacement context; an
      // abandoned Host's supervisor retires that replacement after its lease.
      public_callback_ = nullptr;
      public_callback_context_ = nullptr;
      return CITIZENSDK_OK;
    }
  }
  {
    std::lock_guard<std::recursive_mutex> call(call_lock_);
    if ((teardown_started_ || close_in_progress_ || services_retired_) &&
        callback != nullptr) {
      return CITIZENSDK_ERROR_INVALID_STATE;
    }
    if (callback_update_in_progress_) return CITIZENSDK_ERROR_BUSY;
    callback_update_in_progress_ = true;
  }
  citizensdk_error_code_t result = CITIZENSDK_OK;
  try {
    std::unique_lock<std::mutex> guard(callback_lock_);
    if (callback_thread_ == std::this_thread::get_id()) {
      if (callback != nullptr) {
        result = CITIZENSDK_ERROR_BUSY;
      } else {
        public_callback_ = nullptr;
        public_callback_context_ = nullptr;
      }
    } else {
      callback_idle_.wait(guard, [&] { return callbacks_active_ == 0; });
      public_callback_ = callback;
      public_callback_context_ = callback ? context : nullptr;
    }
  } catch (...) {
    result = map_exception();
  }
  {
    std::lock_guard<std::recursive_mutex> call(call_lock_);
    callback_update_in_progress_ = false;
  }
  return result;
}

void HostBridge::receive_core_event(void *context,
                                    const citizensdk_event_t *event) noexcept {
  if (context != nullptr && event != nullptr) {
    static_cast<HostBridge *>(context)->dispatch_core_event(*event);
  }
}

void HostBridge::dispatch_core_event(const citizensdk_event_t &event) noexcept {
  if (event.event_type == CITIZENSDK_EVENT_REQUEST_COMPLETED) {
    // Core guarantees one dedicated dispatch thread per instance. Holding an
    // early completion here preserves that thread identity while the caller
    // publishes the request route; it neither buffers nor caps events.
    completion_admission_.await_route(event.request_id);
  }
  dispatch_routed_event(event);
}

void HostBridge::dispatch_routed_event(const citizensdk_event_t &event) noexcept {
  RequestRouter::Handler private_handler;
  try {
    private_handler = private_requests_.take(event);
  } catch (...) {
    if (event.result != 0) (void)citizensdk_result_release(event.result);
    return;
  }
  if (private_handler) {
    // Ownership transfers to the registered private handler before the call.
    // All production handlers are noexcept and release exactly once. If a
    // future handler violates that contract, re-releasing here could double
    // release a handle already consumed immediately before the exception.
    try { private_handler(event.result); } catch (...) {}
    return;
  }
  citizensdk_event_callback_t callback = nullptr; void *context = nullptr;
  {
    std::lock_guard<std::mutex> guard(callback_lock_);
    callback = public_callback_; context = public_callback_context_;
    if (callback != nullptr) { ++callbacks_active_; callback_thread_ = std::this_thread::get_id(); }
  }
  if (callback != nullptr) {
    try {
      // Raw C callback ownership transfers here. It must not throw and must
      // release a nonzero result exactly once; Host cannot safely infer
      // whether a callback that violates that contract already released it.
      callback(context, &event);
    } catch (...) {}
  } else if (event.result != 0) {
    (void)citizensdk_result_release(event.result);
  }
  {
    std::lock_guard<std::mutex> guard(callback_lock_);
    if (callback != nullptr) { --callbacks_active_; callback_thread_ = {}; callback_idle_.notify_all(); }
  }
}

citizensdk_error_code_t HostBridge::set_parent_window(void *window) noexcept {
  std::lock_guard<std::recursive_mutex> call(call_lock_);
  if (teardown_started_ || create_in_progress_ || close_in_progress_ ||
      services_retired_) {
    return CITIZENSDK_ERROR_INVALID_STATE;
  }
  return parent_window_.set(window);
}
GtkParentLease HostBridge::acquire_parent_window() const noexcept {
  return parent_window_.acquire();
}
citizensdk_host_vault_availability_t HostBridge::vault_availability() noexcept {
  try {
    return service_call([&] {
      return vault_ ? vault_->availability() : CITIZENSDK_HOST_VAULT_UNSUPPORTED;
    });
  } catch (...) {
    return CITIZENSDK_HOST_VAULT_UNAVAILABLE;
  }
}

citizensdk_error_code_t HostBridge::set_credential_provider(
    const citizensdk_credential_provider_v1_t *provider) {
  std::lock_guard<std::recursive_mutex> guard(call_lock_);
  // 创建Core后不替换凭据归属；避免请求过程中改宿主、悬空context或改变认证事实。
  if (sdk_ != 0 || create_in_progress_ || close_in_progress_ || services_retired_)
    return CITIZENSDK_ERROR_INVALID_STATE;
  return vault_ ? vault_->set_credential_provider(provider) : CITIZENSDK_ERROR_UNSUPPORTED;
}
citizensdk_error_code_t HostBridge::respond_credential(
    uint64_t host_operation_id, citizensdk_bytes_view_t credential) {
  return service_call([&] {
    return vault_ ? vault_->respond_credential(host_operation_id, credential)
                  : CITIZENSDK_ERROR_UNSUPPORTED;
  });
}
citizensdk_error_code_t HostBridge::cancel_credential(uint64_t host_operation_id) {
  return service_call([&] {
    return vault_ ? vault_->cancel_credential(host_operation_id)
                  : CITIZENSDK_ERROR_UNSUPPORTED;
  });
}

citizensdk_error_code_t HostBridge::close() {
  bool teardown_started = false;
  const auto cancel_close = [&](citizensdk_error_code_t code) noexcept {
    std::lock_guard<std::recursive_mutex> guard(call_lock_);
    close_in_progress_ = false;
    lifecycle_.cancel_close(teardown_started_);
    return code;
  };
  try {
    // 无UI资源自行结束Core租约；仅发取消请求，不清空真实终态路由。
    close_qr_captures();
    private_requests_.cancel_all();
    // 回调不持有Host锁；租约防止其他关闭线程在取消期间释放金库。
    // 已进入单向拆卸的重试不重新接纳服务，也不妨碍原关闭状态机继续收敛。
    std::unique_ptr<ServiceLease> credential_lease;
    {
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      if (close_in_progress_ || create_in_progress_) return CITIZENSDK_ERROR_BUSY;
      if (!teardown_started_ && !services_retired_)
        credential_lease = std::make_unique<ServiceLease>(*this);
    }
    if (credential_lease && vault_) vault_->cancel_credentials();
    credential_lease.reset();
    citizensdk_handle_t sdk = 0;
    bool subscribed = false;
    bool callback_installed = false;
    {
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      if (close_in_progress_ || create_in_progress_) {
        return CITIZENSDK_ERROR_BUSY;
      }
      if (!lifecycle_.begin_close()) return CITIZENSDK_OK;
      close_in_progress_ = true;
      teardown_started = teardown_started_;
      if (!completion_admission_.idle()) {
        return cancel_close(CITIZENSDK_ERROR_BUSY);
      }
      if (callback_update_in_progress_ || !private_requests_.empty() ||
          (vault_ && !vault_->idle())) {
        return cancel_close(CITIZENSDK_ERROR_BUSY);
      }
      sdk = sdk_;
      subscribed = capability_subscribed_;
      callback_installed = callback_installed_;
    }

    {
      std::lock_guard<std::mutex> callback_guard(callback_lock_);
      if (callback_thread_ == std::this_thread::get_id()) {
        return cancel_close(CITIZENSDK_ERROR_BUSY);
      }
    }
    // Root calls can synchronously or concurrently re-enter Host callbacks.
    // Never hold call_lock_ across that foreign boundary.
    if (sdk != 0 && !teardown_started) {
      citizensdk_lifecycle_t core_lifecycle = 0;
      const auto lifecycle_code = citizensdk_get_lifecycle(sdk, &core_lifecycle);
      if (lifecycle_code != CITIZENSDK_OK) {
        return cancel_close(lifecycle_code);
      }
      if (core_lifecycle == CITIZENSDK_LIFECYCLE_RUNNING ||
          core_lifecycle == CITIZENSDK_LIFECYCLE_STARTING ||
          core_lifecycle == CITIZENSDK_LIFECYCLE_IMPORTING_STATE) {
        return cancel_close(CITIZENSDK_ERROR_BUSY);
      }
    }

    // Do not clear the application's observer until the cheap lifecycle gate
    // proves teardown can progress. A BUSY close therefore leaves an otherwise
    // open Host fully observable and retryable.
    const auto public_callback_code = set_event_callback(nullptr, nullptr);
    if (public_callback_code != CITIZENSDK_OK) {
      return cancel_close(public_callback_code);
    }

    if (sdk != 0 && subscribed) {
      {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        teardown_started_ = true;
        teardown_started = true;
      }
      const auto code = citizensdk_unsubscribe_capability_changes(sdk);
      if (code != CITIZENSDK_OK) return cancel_close(code);
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      capability_subscribed_ = false;
    }
    if (sdk != 0 && callback_installed) {
      {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        teardown_started_ = true;
        teardown_started = true;
      }
      const auto code = citizensdk_set_event_callback(sdk, nullptr, nullptr);
      if (code != CITIZENSDK_OK) return cancel_close(code);
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      callback_installed_ = false;
    }
    if (sdk != 0) {
      {
        std::lock_guard<std::recursive_mutex> guard(call_lock_);
        teardown_started_ = true;
        teardown_started = true;
      }
      const auto code = citizensdk_destroy(sdk);
      if (code != CITIZENSDK_OK) return cancel_close(code);
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      sdk_ = 0;
    }

    {
      // A successful Core destroy guarantees its host-service borrows and
      // callbacks have ended. begin_close() has already rejected active service
      // leases and closed new service admission. The call lock now commits
      // resource retirement without ever waiting for a GTK provider callback.
      std::lock_guard<std::recursive_mutex> guard(call_lock_);
      services_retired_ = true;
      vault_.reset();
      if (secure_store_) secure_store_->close();
      secure_store_.reset();
      if (public_store_) public_store_->close();
      close_in_progress_ = false;
      lifecycle_.commit_closed();
    }
    return CITIZENSDK_OK;
  } catch (...) {
    return cancel_close(map_exception());
  }
}

citizensdk_error_code_t HostBridge::submit_private(
    const std::function<citizensdk_error_code_t(citizensdk_request_id_t *)> &accept,
    RequestRouter::Handler handler, citizensdk_request_id_t *out_request,
    RequestRouter::Cancellation cancel) {
  if (!accept || !handler || out_request == nullptr) {
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  *out_request = 0;
  std::lock_guard<std::mutex> submission(private_submit_lock_);
  {
    std::lock_guard<std::recursive_mutex> call(call_lock_);
    if (sdk_ == 0 || teardown_started_ || create_in_progress_ ||
        close_in_progress_ || services_retired_) {
      return CITIZENSDK_ERROR_INVALID_STATE;
    }
  }
  try {
    private_requests_.prime(std::move(handler), std::move(cancel));
    try {
      completion_admission_.begin();
    } catch (...) {
      private_requests_.cancel_primed();
      throw;
    }
  } catch (...) {
    return map_exception();
  }
  citizensdk_request_id_t request = 0;
  citizensdk_error_code_t code = CITIZENSDK_ERROR_INTERNAL;
  try {
    code = accept(&request);
  } catch (...) {
    code = map_exception();
  }
  if (request == 0) {
    private_requests_.cancel_primed();
    completion_admission_.publish_route();
    *out_request = request;
    return code == CITIZENSDK_OK ? CITIZENSDK_ERROR_INTEGRITY : code;
  }
  // The handler was fully allocated before accept(). Binding the integer ID is
  // non-allocating, so every accepted result—including a successful prepared
  // wallet hidden inside an error-returning acceptance—has a cleanup owner.
  private_requests_.bind(request);
  // 发布屏障前写出真实编号，早到终态回调可安全观察已绑定请求。
  *out_request = request;
  completion_admission_.publish_route();
  return code;
}

HostRecord HostBridge::chain_load() {
  return service_call([&] { return public_store_->chain_database_load(); });
}
HostRecord HostBridge::chain_cas(uint64_t expected, const Bytes &candidate) {
  return service_call([&] {
    return public_store_->chain_database_compare_and_swap(expected, candidate);
  });
}
HostRecord HostBridge::runtime_load(const std::array<uint8_t, 32> &hash) {
  return service_call([&] { return public_store_->runtime_cache_load(hash); });
}
void HostBridge::runtime_store(const std::array<uint8_t, 32> &hash,
                               const Bytes &candidate) {
  service_call([&] { public_store_->runtime_cache_store(hash, candidate); });
}
void HostBridge::runtime_delete(const std::array<uint8_t, 32> &hash) {
  service_call([&] { public_store_->runtime_cache_delete(hash); });
}
HostRecord HostBridge::history_query(const Bytes &query) {
  return service_call([&] { return public_store_->transaction_history_query(query); });
}
HostRecord HostBridge::history_mutate(uint64_t expected, const Bytes &mutation) {
  return service_call([&] {
    return public_store_->transaction_history_mutate(expected, mutation);
  });
}
HostRecord HostBridge::profile_load() {
  return service_call([&] {
    require(secure_store_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    return secure_store_->wallet_profile_load();
  });
}
HostRecord HostBridge::profile_cas(uint64_t expected, const Bytes &candidate) {
  return service_call([&] {
    require(secure_store_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    return secure_store_->wallet_profile_compare_and_swap(expected, candidate);
  });
}
bool HostBridge::has_account_secret(const std::array<uint8_t, 32> &account_id) {
  return service_call([&] {
    require(secure_store_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED, "未启用安全仓储");
    return secure_store_->has_account_secret(account_id);
  });
}
bool HostBridge::has_any_wallet_key(uint32_t wallet_index) {
  return service_call([&] {
    require(vault_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED, "未启用金库");
    return vault_->has_any_wallet_key(wallet_index);
  });
}
HostRecord HostBridge::secret_load(const SecretIdentity &identity) {
  return service_call([&] {
    require(secure_store_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    return secure_store_->encrypted_secret_load(identity);
  });
}
HostRecord HostBridge::secret_cas(const SecretIdentity &identity,
                                  uint64_t expected,
                                  const Bytes &candidate) {
  return service_call([&] {
    require(secure_store_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    return secure_store_->encrypted_secret_compare_and_swap(identity, expected,
                                                             candidate);
  });
}
void HostBridge::vault_authorize_add_accounts(uint64_t host_operation_id, const WalletKey &key,
    const std::array<uint8_t, 16> &operation_id) {
  service_call([&] {
    require(vault_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED, "wallet host is disabled");
    vault_->authorize_add_accounts(host_operation_id, key, operation_id);
  });
}
void HostBridge::vault_ensure(
    uint64_t host_operation_id, const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  service_call([&] {
    require(vault_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    vault_->ensure_wallet_kek(host_operation_id, key, operation_id);
  });
}
bool HostBridge::vault_has(const WalletKey &key) {
  return service_call([&] {
    require(vault_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    return vault_->has_wallet_kek(key);
  });
}
Bytes HostBridge::vault_wrap(
    uint64_t host_operation_id, const WalletKey &key, const std::array<uint8_t, 16> &operation_id,
    const uint8_t plaintext_dek[32]) {
  return service_call([&] {
    require(vault_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    return vault_->wrap_dek(host_operation_id, key, operation_id, plaintext_dek);
  });
}
void HostBridge::vault_unwrap(uint64_t host_operation_id, const WalletKey &key,
                              const Bytes &wrapped_dek,
                              uint8_t plaintext_dek_out[32]) {
  service_call([&] {
    require(vault_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    vault_->unwrap_dek(host_operation_id, key, wrapped_dek,
                       plaintext_dek_out);
  });
}
void HostBridge::vault_retire(
    const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  service_call([&] {
    require(vault_ != nullptr, CITIZENSDK_ERROR_UNSUPPORTED,
            "wallet host is disabled");
    vault_->retire_wallet_kek(key, operation_id);
  });
}

}  // namespace citizen_sdk::linux
