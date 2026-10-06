#include "citizen_sdk_flutter_sessions.hpp"

#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <future>
#include <exception>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>
#include <vector>
#include "citizen_sdk/citizen_sdk.hpp"
#include "citizensdk_qr_image.h"

namespace citizen_sdk::flutter {

bool allow_close_without_core(bool close_attempted,
                              citizensdk_lifecycle_t checkpoint_state,
                              citizensdk_error_code_t host_status,
                              citizensdk_handle_t core) {
  if (host_status == CITIZENSDK_OK) {
    if (core == 0) throw Error(CITIZENSDK_ERROR_INTEGRITY,
                               "CitizenSDK Host returned an empty Core handle");
    return false;
  }
  if (host_status == CITIZENSDK_ERROR_NOT_READY && core == 0 && close_attempted &&
      (checkpoint_state == CITIZENSDK_LIFECYCLE_CREATED ||
       checkpoint_state == CITIZENSDK_LIFECYCLE_START_FAILED ||
       checkpoint_state == CITIZENSDK_LIFECYCLE_STOPPED)) return true;
  throw Error(host_status, "CitizenSDK Host Core ownership is unavailable");
}

namespace {

citizensdk_bytes_view_t view(const std::vector<uint8_t> &bytes) noexcept {
  return {bytes.empty() ? nullptr : bytes.data(), static_cast<uint64_t>(bytes.size())};
}

citizensdk_bytes_view_t view(const std::string &text) noexcept {
  return {reinterpret_cast<const uint8_t *>(text.data()),
          static_cast<uint64_t>(text.size())};
}

template <typename Call>
std::vector<uint8_t> qr_core_output(Call call, uint64_t maximum = 65536) {
  uint64_t required = 0;
  auto code = call(nullptr, 0, &required);
  if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK QR output query failed");
  if (required == 0 || required > maximum)
    throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK QR output length is invalid");
  std::vector<uint8_t> output(static_cast<std::size_t>(required));
  code = call(output.data(), required, &required);
  if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK QR output copy failed");
  if (required != output.size())
    throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK QR output length changed");
  return output;
}

std::string qr_text(std::vector<uint8_t> bytes) {
  return std::string(reinterpret_cast<const char *>(bytes.data()), bytes.size());
}

std::string preparation_id(const uint8_t *bytes) {
  static constexpr char digits[] = "0123456789abcdef";
  std::string result(34, '0'); result[1] = 'x';
  for (std::size_t index = 0; index < 16; ++index) {
    result[2 + index * 2] = digits[bytes[index] >> 4];
    result[3 + index * 2] = digits[bytes[index] & 15];
  }
  return result;
}

using citizen_sdk::detail::image_error;
void check_qr_image(citizensdk_qr_image_status_t status, const char *message) {
  if (status != CITIZENSDK_QR_IMAGE_OK) throw Error(image_error(status), message);
}

// 只检查真实Core结果的ABI/类型/错误阶段，不从展示文本推断成功。
void require_result(citizensdk_result_handle_t result, citizensdk_result_kind_t kind) {
  citizensdk_result_info_t info{};
  info.struct_size = sizeof(info); info.abi_version = CITIZENSDK_ABI_VERSION;
  const auto code = citizensdk_result_get_info(result, &info);
  if (code != CITIZENSDK_OK) throw Error(code, "Core result inspection failed");
  if (info.struct_size != sizeof(info) || info.abi_version != CITIZENSDK_ABI_VERSION)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core result ABI is invalid");
  if (info.error_code != CITIZENSDK_OK) {
    citizensdk_failure_stage_t stage{};
    const auto stage_code = citizensdk_result_get_failure_stage(result, &stage);
    if (stage_code != CITIZENSDK_OK) throw Error(stage_code, "Core result stage query failed");
    throw Error(info.error_code, "Core operation failed", stage);
  }
  if (info.kind != kind) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Core result kind is invalid");
}

std::string random_session_id();

// This adapter contains no chain/wallet algorithm. Every accepted method goes
// directly to the same installed Host/Core used by the native C/C++ binding.
class HostTransport final : public NativeTransport, public std::enable_shared_from_this<HostTransport> {
 public:
  HostTransport(const Config &config, Scheduler schedule, TextureFactory textures)
      : host_(std::make_unique<Host>(config)), modules_(config.modules),
        schedule_(std::move(schedule)), textures_(std::move(textures)) {
    host_->open();
  }
  ~HostTransport() override = default;
  citizensdk_error_code_t accept_request_sequence(uint64_t sequence) override {
    return host_ ? citizensdk_accept_request_sequence(host_->native_handle(), sequence)
                 : CITIZENSDK_ERROR_INVALID_STATE;
  }
  void observe(Observer observer) override {
    require_open();
    host_->set_event_observer(std::move(observer));
  }

  void capture(const DecodedRequest &r, PrivateKeyResource::Completion completion) override {
    if (r.method == Method::qr_decode_image) {
      if (image_jobs_ >= 4) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "图片解码任务已达上限");
      ++image_jobs_;
      const auto self = shared_from_this();
      try {
        std::thread worker([self, bytes = r.payload, purpose = r.qr_purpose, completion = std::move(completion)]() mutable {
          std::optional<Value> result;
          std::exception_ptr failure;
          try {
            const auto packet = qr_core_output([&](uint8_t *buffer, uint64_t capacity, uint64_t *required) {
              return citizensdk_host_decode_qr_image(self->host_->host_handle(), view(bytes), purpose, buffer, capacity, required);
            }, 4U * 1024U * 1024U + 260);
            std::size_t offset = 0;
            const auto read_u32 = [&]() {
              if (packet.size() - offset < 4) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片结果长度被截断");
              uint32_t value = 0;
              for (unsigned shift = 0; shift < 32; shift += 8) value |= static_cast<uint32_t>(packet[offset++]) << shift;
              return value;
            };
            const auto count = read_u32();
            if (count > 64) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片二维码数量超限");
            Value::List documents;
            for (uint32_t index = 0; index < count; ++index) {
              const auto length = read_u32();
              if (length == 0 || length > 65536 || packet.size() - offset < length)
                throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片文档大小无效");
              documents.push_back(Value::string(std::string(reinterpret_cast<const char *>(packet.data() + offset), length)));
              offset += length;
            }
            if (offset != packet.size()) throw Error(CITIZENSDK_ERROR_INTEGRITY, "图片结果有多余字节");
            result = Value::list({Value::list(std::move(documents))});
          } catch (...) { failure = std::current_exception(); }
          // 有限worker拥有Host至两个同步投影返回；关闭仍由同一路由等待此终态。
          --self->image_jobs_;
          completion([result = std::move(result), failure]() mutable {
            if (failure) std::rethrow_exception(failure);
            return std::move(*result);
          });
        });
        worker.detach();
      } catch (...) { --image_jobs_; throw; }
      return;
    }
    if (r.method == Method::open_qr_capture) {
      if (!textures_) throw Error(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理注册器不可用");
      if (captures_.size() >= 4) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "采集资源已达上限");
      const auto id = random_session_id();
      const std::weak_ptr<HostTransport> weak = shared_from_this();
      auto resource = std::make_shared<CaptureResource>(host_->host_handle(), id, r.qr_purpose, schedule_, textures_,
          [weak](std::string type, Value value) {
            if (const auto owner = weak.lock()) owner->resource_event(std::move(type), std::move(value));
          },
          [weak, id](bool granted) {
            if (const auto owner = weak.lock()) {
              owner->captures_.erase(id);
              owner->resource_event(granted ? "qrCaptureClosed" : "",
                  granted ? Value::list({Value::string(id)}) : Value::list({}));
            }
          });
      if (!captures_.emplace(id, resource).second) throw Error(CITIZENSDK_ERROR_CONFLICT, "采集资源编号冲突");
      try { resource->open(std::move(completion)); }
      catch (...) { captures_.erase(id); throw; }
      return;
    }
    const auto found = captures_.find(r.resource_id);
    if (found == captures_.end()) throw Error(CITIZENSDK_ERROR_NOT_FOUND, "采集资源不属于本实例");
    const auto resource = found->second;
    resource->control(r.method, r.torch, std::move(completion));
  }
  void close_captures() override {
    std::vector<std::shared_ptr<CaptureResource>> resources;
    for (const auto &entry : captures_) resources.push_back(entry.second);
    std::exception_ptr failure;
    for (const auto &resource : resources) {
      try { resource->request_close(); } catch (...) { if (!failure) failure = std::current_exception(); }
    }
    if (failure) std::rethrow_exception(failure);
  }
  bool captures_closed() override { return captures_.empty() && image_jobs_.load() == 0; }
  void resource_event(std::string type, Value value) {
    ResourceObserver observer;
    { std::lock_guard<std::mutex> guard(private_keys_->lock); observer = private_keys_->observer; }
    if (observer) observer(std::move(type), std::move(value));
  }

  citizensdk_error_code_t accept(Method native_method, const DecodedRequest &r,
                                citizensdk_request_id_t *out, Completion completion) override {
    if (!host_ || !completion) return CITIZENSDK_ERROR_INVALID_STATE;
    // 复用Host唯一私有请求路由，结果不再依赖可先关闭的公共事件观察者。
    const auto self = shared_from_this();
    struct RequestCancellation final {
      std::atomic<citizensdk_request_id_t> id{0};
      std::atomic<bool> requested{false};
      std::atomic<bool> finished{false};
    };
    const auto cancellation = std::make_shared<RequestCancellation>();
    return host_->submit_request(
        [this, native_method, &r, cancellation](citizensdk_handle_t core, citizensdk_request_id_t *id) {
          const auto code = accept_core(native_method, r, id);
          if (code == CITIZENSDK_OK) {
            cancellation->id.store(*id);
            if (cancellation->requested.load()) (void)citizensdk_cancel_request(core, *id);
          }
          return code;
        },
        [self, native_method, cancellation, completion = std::move(completion)](
            citizensdk_request_id_t id, citizensdk_result_handle_t result) mutable {
          detail::EventResultScope received(result);
          cancellation->finished.store(true);
          try {
            auto owned = std::make_shared<detail::EventResultScope>(result);
            received.value = 0;
            completion(id, [self, native_method, owned] {
              return native_method == Method::review_qr_request
                  ? self->copy_review(owned) : self->copy_result(native_method, owned->value);
            });
          } catch (...) {
            // 真实Core终态已到达；无可交付副本时由原会话交付失败，不伪造成功或遗失终态。
            completion(id, {});
          }
        },
        [cancellation](citizensdk_handle_t core) {
          if (cancellation->finished.load()) return;
          cancellation->requested.store(true);
          const auto id = cancellation->id.load();
          if (id != 0) (void)citizensdk_cancel_request(core, id);
        }, out);
  }

  citizensdk_error_code_t accept_core(Method native_method, const DecodedRequest &r,
                                     citizensdk_request_id_t *out) {
    if (!host_ || close_attempted_) return CITIZENSDK_ERROR_INVALID_STATE;
    const auto sdk = host_->native_handle();
    if (native_method == Method::prepare_wallet_creation && !r.password)
      return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    if ((native_method == Method::import_wallet || native_method == Method::add_wallet_accounts ||
         native_method == Method::add_next_wallet_account) && (!r.mnemonic || !r.password))
      return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    switch (native_method) {
      case Method::start: return citizensdk_start(sdk, out);
      case Method::stop: return citizensdk_stop(sdk, out);
      case Method::get_finalized_head: return citizensdk_get_finalized_head(sdk, out);
      case Method::get_sync_status: return citizensdk_get_sync_status(sdk, out);
      case Method::get_best_head: return citizensdk_get_best_head(sdk, out);
      case Method::get_finalized_block_at:
        return citizensdk_get_finalized_block_at(sdk, r.block_number, out);
      case Method::resolve_finalized_block:
        return citizensdk_resolve_finalized_block(sdk, r.block.hash, r.block_number, out);
      case Method::get_block_header:
        return citizensdk_get_block_header_at(sdk, &r.block, out);
      case Method::get_block_body:
        return citizensdk_get_block_body_at(sdk, &r.block, out);
      case Method::get_runtime_context:
        return citizensdk_get_runtime_context_at(sdk, &r.block, out);
      case Method::get_storage:
        return citizensdk_get_storage_at(sdk, &r.block, view(r.payload), out);
      case Method::get_storage_batch: {
        std::vector<citizensdk_bytes_view_t> keys;
        keys.reserve(r.storage_keys.size());
        for (const auto &key : r.storage_keys) keys.push_back(view(key));
        return citizensdk_get_storage_batch_at(sdk, &r.block, keys.data(),
                                                static_cast<uint32_t>(keys.size()), out);
      }
      case Method::get_storage_keys_paged: {
        const citizensdk_bytes_view_t start = r.storage_start_key
            ? view(*r.storage_start_key) : citizensdk_bytes_view_t{nullptr, 0};
        return citizensdk_get_storage_keys_paged(
            sdk, &r.block, view(r.payload), r.storage_start_key ? 1 : 0,
            start, r.storage_keys_limit, out);
      }
      case Method::call_runtime_api:
        return citizensdk_call_runtime_api(
            sdk, &r.block, view(r.runtime_api_method), view(r.payload), out);
      case Method::get_system_events:
        return citizensdk_get_system_events_at(sdk, &r.block, out);
      case Method::export_state: return citizensdk_export_state(sdk, out);
      case Method::import_state:
        return citizensdk_import_state(sdk, &r.block, r.state_format_version,
                                       view(r.state_database), out);
      case Method::get_account_balance:
        return citizensdk_get_finalized_account_balance(sdk, &r.account_id, out);
      case Method::get_account_balances:
        return citizensdk_get_finalized_account_balances(sdk,
            r.account_ids.empty() ? nullptr : r.account_ids.data(),
            static_cast<uint32_t>(r.account_ids.size()), out);
      case Method::get_account_nonce: return citizensdk_get_account_nonce(sdk, &r.account_id, out);
      case Method::get_fee_snapshot: return citizensdk_get_best_fee_snapshot(sdk, out);
      case Method::prepare_wallet_creation:
        return citizensdk_prepare_wallet_creation(sdk, r.word_count, view(r.password->value), out);
      case Method::import_wallet:
        return citizensdk_import_wallet(sdk, view(r.mnemonic->value), view(r.password->value), out);
      case Method::add_wallet_accounts:
        return citizensdk_add_wallet_accounts(sdk, view(r.mnemonic->value), view(r.password->value),
            r.indices.data(), static_cast<uint32_t>(r.indices.size()), out);
      case Method::add_next_wallet_account:
        return citizensdk_add_next_wallet_account(sdk, view(r.mnemonic->value), view(r.password->value), out);
      case Method::commit_wallet_creation: {
        std::lock_guard<std::mutex> guard(prepared_lock_);
        const auto found = prepared_wallets_.find(r.resource_id);
        if (found == prepared_wallets_.end()) return CITIZENSDK_ERROR_NOT_FOUND;
        if (found->second.claimed) return CITIZENSDK_ERROR_INVALID_STATE;
        const auto code = citizensdk_commit_wallet_creation(sdk, found->second.handle, out);
        // 只有Core真实接纳才消耗提交资格，异步失败也不能重交；显式release仍可定位该资源。
        if (code == CITIZENSDK_OK) found->second.claimed = true;
        return code;
      }
      case Method::sign_and_delete_wallet: return citizensdk_sign_and_delete_wallet(sdk, out);
      case Method::review_qr_request:
        return citizensdk_review_qr_sign_request(sdk, view(r.qr_text), out);
      case Method::sign_qr_request: {
        std::lock_guard<std::mutex> guard(prepared_lock_);
        const auto found = reviews_.find(r.resource_id);
        if (found == reviews_.end()) return CITIZENSDK_ERROR_NOT_FOUND;
        if (found->second.claimed) return CITIZENSDK_ERROR_INVALID_STATE;
        const auto code = citizensdk_sign_qr_request(sdk, found->second.result->value, out);
        if (code == CITIZENSDK_OK) found->second.claimed = true;
        return code;
      }
      case Method::inspect_wallets:
      case Method::get_wallet_state: return citizensdk_get_wallet_state(sdk, out);
      case Method::repair_hot_wallet: case Method::rename_diagnostic_wallet: case Method::delete_diagnostic_wallet: {
        std::lock_guard<std::mutex> guard(prepared_lock_);
        const auto found = inspections_.find(r.resource_id);
        if (found == inspections_.end()) return CITIZENSDK_ERROR_NOT_FOUND;
        const auto result = found->second->value;
        if (native_method == Method::repair_hot_wallet)
          return citizensdk_repair_hot_wallet(sdk, result, r.wallet_index, out);
        if (native_method == Method::rename_diagnostic_wallet)
          return citizensdk_rename_diagnostic_wallet(sdk, result, r.wallet_index, view(r.name), out);
        return citizensdk_delete_diagnostic_wallet(sdk, result, r.wallet_index, out);
      }
      case Method::import_cold_account_code: {
        auto encoded = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
          return citizensdk_qr_parse(sdk, view(r.qr_text), target, capacity, required);
        });
        const auto account = detail::qr_import_account(qr_text(std::move(encoded)));
        return citizensdk_import_cold_account_id(sdk, &account, bytes_view(r.name), out);
      }
      case Method::import_cold_account_id:
        return citizensdk_import_cold_account_id(sdk, &r.account_id, bytes_view(r.name), out);
      case Method::import_cold_account_ss58:
        return citizensdk_import_cold_account_ss58(sdk, bytes_view(r.qr_text), bytes_view(r.name), out);
      case Method::reorder_wallet_accounts_without_default_change:
        return citizensdk_reorder_wallet_accounts_without_default_change(
            sdk, r.wallet_revision, r.account_ids.data(),
            static_cast<uint32_t>(r.account_ids.size()), out);
      case Method::set_active_wallet:
        return citizensdk_set_active_wallet(sdk, r.wallet_revision, r.wallet_index, out);
      case Method::rename_wallet:
        return citizensdk_rename_wallet(sdk, r.wallet_revision, r.wallet_index, bytes_view(r.name), out);
      case Method::rename_account:
        return citizensdk_rename_account(sdk, &r.account_id, bytes_view(r.name), out);
      case Method::delete_account:
        return citizensdk_delete_account(sdk, &r.account_id, out);
      case Method::set_active_wallet_account:
        return citizensdk_set_active_wallet_account(sdk, &r.account_id, out);
      case Method::delete_wallet: return citizensdk_delete_wallet(sdk, out);
      case Method::reconcile_wallet_cleanup: return citizensdk_reconcile_wallet_cleanup(sdk, out);
      case Method::sign_wallet_payload:
        return citizensdk_sign_wallet_payload(sdk, &r.account_id, view(r.payload), out);
      case Method::begin_signing:
        return citizensdk_begin_signing(
            sdk, &r.account_id, view(r.payload), r.signing_transform,
            view(r.signing_domain), r.external_signer_transport,
            r.signing_action, r.signing_ttl, out);
      case Method::consume_external_signature:
        return citizensdk_consume_external_signature(
            sdk, view(r.signing_session_id), view(r.signing_response), out);
      case Method::begin_default_account_change:
        return citizensdk_begin_default_account_change(
            sdk, r.wallet_revision, r.account_ids.data(),
            static_cast<uint32_t>(r.account_ids.size()), r.signing_ttl, out);
      case Method::consume_default_account_change:
        return citizensdk_consume_default_account_change(
            sdk, view(r.signing_session_id), view(r.signing_response), out);
      case Method::prepare_transaction:
        return citizensdk_prepare_transaction(sdk, &r.account_id, view(r.payload), out);
      case Method::execute_prepared_transaction: {
        citizensdk_prepared_transaction_handle_t prepared = 0;
        {
          std::lock_guard<std::mutex> guard(prepared_lock_);
          const auto found = prepared_transactions_.find(r.preparation_id);
          if (found == prepared_transactions_.end()) return CITIZENSDK_ERROR_NOT_FOUND;
          prepared = found->second;
          prepared_transactions_.erase(found);
        }
        const auto code = citizensdk_execute_prepared_transaction(sdk, prepared, out);
        if (code != CITIZENSDK_OK) {
          std::lock_guard<std::mutex> guard(prepared_lock_);
          prepared_transactions_.emplace(r.preparation_id, prepared);
        }
        return code;
      }
      case Method::consume_prepared_transaction_qr_response:
        return citizensdk_transaction_execution_consume_qr_response(
            sdk, &r.execution_id, view(r.signing_response), out);
      case Method::get_transaction_history:
        return citizensdk_get_transaction_history(
            sdk, r.before_execution_id ? &*r.before_execution_id : nullptr,
            r.history_limit, out);
      case Method::sync_transaction_history:
        return citizensdk_sync_transaction_history(sdk, out);
      // 同步控制和独立资源不经普通Core请求入口；本分支不接纳窗口驱动的钱包变更。
      case Method::release_wallet_inspection:
      case Method::cancel_signing:
      case Method::cancel_prepared_transaction:
      case Method::cancel_prepared_transaction_execution:
      case Method::verify_signature:
      case Method::open: case Method::close: case Method::get_capabilities: case Method::get_genesis_hash:
      case Method::qr_parse: case Method::qr_create_sign_request:
      case Method::qr_validate_sign_response: case Method::qr_consume_sign_response: case Method::qr_cancel_sign_request:
      case Method::qr_encode_account_id:
      case Method::qr_decode_luminance: case Method::qr_encode:
      case Method::respond_credential: case Method::cancel_credential:
      case Method::qr_encode_document: case Method::qr_prepare_account_authorization: case Method::encode_signing_payload:
        return CITIZENSDK_ERROR_UNSUPPORTED;
    }
    return CITIZENSDK_ERROR_UNSUPPORTED;
  }
  Value copy_review(const std::shared_ptr<detail::EventResultScope> &result) {
    require_result(result->value, CITIZENSDK_RESULT_QR_REVIEW);
    auto document = qr_text(qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
      return citizensdk_result_copy_qr(result->value, target, capacity, required);
    }));
    const auto id = random_session_id();
    auto value = Value::list({Value::string(id), Value::string(std::move(document))});
    validate_public_value(Method::review_qr_request, value);
    std::lock_guard<std::mutex> guard(prepared_lock_);
    if (!reviews_.emplace(id, Review{result, false}).second)
      throw Error(CITIZENSDK_ERROR_CONFLICT, "QR review identity collision");
    return value;
  }

  Value copy_result(Method method, citizensdk_result_handle_t result) override {
    if (method == Method::inspect_wallets) {
      auto projected = copy_public_result(Method::get_wallet_state, result);
      auto &fields = std::get<Value::List>(projected.data);
      const auto id = random_session_id();
      auto value = Value::list({Value::string(id), std::move(fields.at(0))});
      validate_public_value(method, value);
      std::lock_guard<std::mutex> guard(prepared_lock_);
      if (inspections_.size() >= 64) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "钱包检查资源数量超限");
      citizensdk_result_handle_t retained = 0;
      const auto code = citizensdk_wallet_state_retain(host_->native_handle(), result, &retained);
      if (code != CITIZENSDK_OK) throw Error(code, "钱包检查快照保留失败");
      detail::EventResultScope cleanup(retained);
      auto owned = std::make_shared<detail::EventResultScope>(retained);
      cleanup.value = 0;
      if (!inspections_.emplace(id, std::move(owned)).second)
        throw Error(CITIZENSDK_ERROR_CONFLICT, "钱包检查资源标识冲突");
      return value;
    }
    if (method == Method::sign_qr_request) {
      require_result(result, CITIZENSDK_RESULT_QR_SIGNED);
      auto document = qr_text(qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
        return citizensdk_result_copy_qr(result, target, capacity, required);
      }));
      // 只从Core公开投影取得规范响应文本，再调用SDK唯一码图实现；不重建签名消息。
      auto image = detail::qr_image(detail::qr_public_field(document, "canonical_text", 2331));
      auto value = Value::list({Value::string(std::move(document)), Value::integer(image.width),
          Value::integer(image.height), Value::bytes(std::move(image.luminance))});
      validate_public_value(method, value); return value;
    }
    if (method == Method::prepare_wallet_creation) {
      require_result(result, CITIZENSDK_RESULT_PREPARED_WALLET);
      citizensdk_prepared_wallet_info_t info{};
      info.struct_size = sizeof(info); info.abi_version = CITIZENSDK_ABI_VERSION;
      const auto code = citizensdk_result_get_prepared_wallet(result, &info);
      if (code != CITIZENSDK_OK) throw Error(code, "Prepared wallet handle copy failed");
      if (info.prepared_wallet == 0 || info.struct_size != sizeof(info) || info.abi_version != CITIZENSDK_ABI_VERSION)
        throw Error(CITIZENSDK_ERROR_INTEGRITY, "Prepared wallet descriptor is invalid");
      // 对外只分配不透明关联号；Core句柄始终留在本实例表中。
      try {
        const auto id = random_session_id();
        auto value = Value::list({Value::string(id)});
        std::lock_guard<std::mutex> guard(prepared_lock_);
        if (!prepared_wallets_.emplace(id, PreparedWallet{info.prepared_wallet, false}).second)
          throw Error(CITIZENSDK_ERROR_CONFLICT, "Prepared wallet identity collision");
        return value;
      } catch (...) {
        (void)citizensdk_prepared_wallet_release(host_->native_handle(), info.prepared_wallet);
        throw;
      }
    }
    Value value = copy_public_result(method, result);
    if (method == Method::prepare_transaction) {
      citizensdk_prepared_transaction_info_t info{};
      info.struct_size = sizeof(info);
      info.abi_version = CITIZENSDK_ABI_VERSION;
      const auto code = citizensdk_result_get_prepared_transaction(result, &info);
      if (code != CITIZENSDK_OK) throw Error(code, "Prepared transaction ownership copy failed");
      const auto id = preparation_id(info.preparation_id);
      std::lock_guard<std::mutex> guard(prepared_lock_);
      if (!prepared_transactions_.emplace(id, info.prepared_transaction).second) {
        (void)citizensdk_prepared_transaction_release(
            host_->native_handle(), info.prepared_transaction);
        throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                              "Core returned a duplicate preparation identity");
      }
    }
    return value;
  }
  citizensdk_lifecycle_t lifecycle_state() override {
    if (!host_) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Host is retired");
    citizensdk_handle_t core = 0;
    const auto status = citizensdk_host_sdk(host_->host_handle(), &core);
    if (allow_close_without_core(close_attempted_, checkpoint_state_, status, core)) {
      // 仅供 progress_close 再进 Host::close；不能提前发送 disposed 或重建 Core。
      return checkpoint_state_;
    }
    citizensdk_lifecycle_t state{};
    const auto code = citizensdk_get_lifecycle(core, &state);
    if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK lifecycle query failed");
    return state;
  }
  Value genesis_hash() override { return copy_genesis_hash(host_->native_handle()); }
  Value cancel_signing(const DecodedRequest &r) override {
    uint8_t cancelled = 0;
    const auto code = citizensdk_cancel_signing_session(
        host_->native_handle(), view(r.signing_session_id), &cancelled);
    if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK signing cancellation failed");
    if (cancelled > 1)
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                            "CitizenSDK signing cancellation result is invalid");
    return Value::list({Value::boolean(cancelled != 0)});
  }
  Value cancel_prepared_transaction(const DecodedRequest &r) override {
    std::lock_guard<std::mutex> guard(prepared_lock_);
    const auto found = prepared_transactions_.find(r.preparation_id);
    if (found == prepared_transactions_.end())
      throw ContractFailure(CITIZENSDK_ERROR_NOT_FOUND,
                            "Transaction preparation was not found");
    const auto code = citizensdk_prepared_transaction_release(
        host_->native_handle(), found->second);
    if (code != CITIZENSDK_OK)
      throw Error(code, "CitizenSDK prepared transaction cancellation failed");
    prepared_transactions_.erase(found);
    return Value::list({Value::null()});
  }
  Value cancel_transaction_execution(const DecodedRequest &r) override {
    const auto code = citizensdk_transaction_execution_cancel(
        host_->native_handle(), &r.execution_id);
    if (code != CITIZENSDK_OK)
      throw Error(code, "CitizenSDK transaction execution cancellation failed");
    return Value::list({Value::null()});
  }
  Value capability_snapshot() override {
    require_open();
    citizensdk_capability_snapshot_t snapshot{};
    snapshot.struct_size = sizeof(snapshot);
    snapshot.abi_version = CITIZENSDK_ABI_VERSION;
    const auto code = citizensdk_get_capabilities(host_->native_handle(), &snapshot);
    if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK capability query failed");
    return capabilities(snapshot);
  }
  Value qr(const DecodedRequest &r) override {
    require_open();
    if ((modules_ & CITIZENSDK_MODULE_QR) == 0)
      throw Error(CITIZENSDK_ERROR_UNSUPPORTED, "CitizenSDK QR module is not enabled");
    const auto sdk = host_->native_handle();
    switch (r.method) {
      case Method::qr_encode_document: {
        auto output = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
          return citizensdk_qr_encode_document(sdk, view(r.input_json), target, capacity, required);
        });
        return Value::list({Value::string(qr_text(std::move(output)))});
      }
      case Method::qr_prepare_account_authorization: {
        auto output = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
          return citizensdk_qr_prepare_account_authorization(sdk, r.qr_action, view(r.payload),
              view(r.account_id_text), target, capacity, required);
        });
        return Value::list({Value::string(qr_text(std::move(output)))});
      }
      case Method::qr_parse: {
        auto output = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
          return citizensdk_qr_parse(sdk, view(r.qr_text), target, capacity, required);
        });
        return Value::list({Value::string(qr_text(std::move(output)))});
      }
      case Method::qr_create_sign_request: {
        auto output = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
          return citizensdk_qr_create_sign_request(sdk, static_cast<uint16_t>(r.qr_action), &r.account_id,
              view(r.payload), r.qr_ttl, target, capacity, required);
        });
        return Value::list({Value::string(qr_text(std::move(output)))});
      }
      case Method::qr_validate_sign_response: {
        const auto code = citizensdk_qr_validate_sign_response(sdk, view(r.qr_request_id), view(r.qr_text));
        if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK QR response preflight failed");
        return Value::list({});
      }
      case Method::qr_consume_sign_response: {
        std::vector<uint8_t> signature(64);
        const auto code = citizensdk_qr_consume_sign_response(sdk, view(r.qr_text), signature.data());
        if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK QR response was rejected");
        return Value::list({Value::bytes(std::move(signature))});
      }
      case Method::qr_cancel_sign_request: {
        uint8_t cancelled = 0;
        const auto code = citizensdk_qr_cancel_sign_request(sdk, view(r.qr_request_id), &cancelled);
        if (code != CITIZENSDK_OK) throw Error(code, "CitizenSDK QR request cancellation failed");
        if (cancelled > 1)
          throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK QR cancellation result is invalid");
        return Value::list({Value::boolean(cancelled != 0)});
      }
      case Method::qr_encode_account_id: {
        auto output = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
          return citizensdk_qr_encode_account_id(sdk, &r.account_id, target, capacity, required);
        });
        return Value::list({Value::string(qr_text(std::move(output)))});
      }
      case Method::qr_decode_luminance: {
        size_t required = 0;
        auto status = citizensdk_qr_image_decode_luminance(r.payload.data(), r.payload.size(),
            r.qr_width, r.qr_height, r.qr_stride, nullptr, 0, &required);
        if (status != CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL || required == 0 || required > 2331)
          throw Error(image_error(status), "ZXing-C++ QR decode query failed");
        std::vector<uint8_t> output(required);
        status = citizensdk_qr_image_decode_luminance(r.payload.data(), r.payload.size(),
            r.qr_width, r.qr_height, r.qr_stride, output.data(), output.size(), &required);
        check_qr_image(status, "ZXing-C++ QR decode failed");
        if (required != output.size())
          throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "ZXing-C++ QR decode length changed");
        const auto text = qr_text(std::move(output));
        auto document = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *size) {
          return citizensdk_qr_parse(sdk, view(text), target, capacity, size);
        });
        return Value::list({Value::string(qr_text(std::move(document)))});
      }
      case Method::qr_encode: {
        uint32_t width = 0, height = 0;
        size_t required = 0;
        auto status = citizensdk_qr_image_encode_text(
            reinterpret_cast<const uint8_t *>(r.qr_text.data()), r.qr_text.size(), r.qr_scale,
            nullptr, 0, &width, &height, &required);
        if (status != CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL || required == 0 || required > 16777216)
          throw Error(image_error(status), "ZXing-C++ QR encode query failed");
        std::vector<uint8_t> output(required);
        status = citizensdk_qr_image_encode_text(
            reinterpret_cast<const uint8_t *>(r.qr_text.data()), r.qr_text.size(), r.qr_scale,
            output.data(), output.size(), &width, &height, &required);
        check_qr_image(status, "ZXing-C++ QR encode failed");
        if (required != output.size())
          throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY, "ZXing-C++ QR image length changed");
        return Value::list({Value::integer(width), Value::integer(height), Value::bytes(std::move(output))});
      }
      default: throw ContractFailure(CITIZENSDK_ERROR_UNSUPPORTED, "Unsupported QR method");
    }
  }
  Value control(const DecodedRequest &r) override {
    if (!host_) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Host is closed");
    if (r.method == Method::release_wallet_inspection) {
      std::shared_ptr<detail::EventResultScope> owned;
      {
        std::lock_guard<std::mutex> guard(prepared_lock_);
        const auto found = inspections_.find(r.resource_id);
        if (found == inspections_.end()) throw Error(CITIZENSDK_ERROR_NOT_FOUND, "检查资源不属于当前实例");
        owned = std::move(found->second); inspections_.erase(found);
      }
      // 原结果释放在锁外完成；已接纳操作已由Core复制原记录。
      owned.reset(); return Value::list({});
    }
    if (r.method == Method::release_qr_review) {
      std::shared_ptr<detail::EventResultScope> result;
      {
        std::lock_guard<std::mutex> guard(prepared_lock_);
        const auto found = reviews_.find(r.resource_id);
        if (found == reviews_.end()) throw Error(CITIZENSDK_ERROR_NOT_FOUND, "QR review is not owned by this session");
        result = std::move(found->second.result); reviews_.erase(found);
      }
      // 锁外归还Core结果；签名接纳调用已经复制确认内容，释放不撤回已接纳签名。
      result.reset(); return Value::list({});
    }
    if (r.method == Method::validate_wallet_password || r.method == Method::validate_wallet_mnemonic) {
      citizensdk_wallet_input_validation_v1_t result{};
      result.struct_size = sizeof(result); result.abi_version = CITIZENSDK_ABI_VERSION;
      const bool password = r.method == Method::validate_wallet_password;
      const auto &input = password ? r.password : r.mnemonic;
      if (!input) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Wallet input is absent");
      const auto code = citizensdk_validate_wallet_input(password ? 1U : 2U, view(input->value),
          password ? 0U : r.word_count, &result);
      if (code != CITIZENSDK_OK) throw Error(code, "Wallet input validation failed");
      if (result.struct_size != sizeof(result) || result.abi_version != CITIZENSDK_ABI_VERSION)
        throw Error(CITIZENSDK_ERROR_INTEGRITY, "Wallet validation ABI is invalid");
      auto value = Value::list({Value::integer(result.reason),
          result.position == UINT32_MAX ? Value::null() : Value::integer(result.position)});
      validate_public_value(r.method, value);
      return value;
    }
    if (r.method == Method::wallet_word_suggestions) {
      if (!r.mnemonic) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Word prefix is absent");
      uint64_t length = 0;
      auto code = citizensdk_wallet_word_suggestions(view(r.mnemonic->value), nullptr, 0, &length);
      if (code != CITIZENSDK_OK) throw Error(code, "Wallet word suggestions failed");
      if (length > 1024) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Wallet word suggestions exceed boundary");
      std::vector<uint8_t> bytes(static_cast<std::size_t>(length));
      uint64_t copied = length;
      code = citizensdk_wallet_word_suggestions(view(r.mnemonic->value),
          bytes.empty() ? nullptr : bytes.data(), length, &copied);
      if (code != CITIZENSDK_OK) throw Error(code, "Wallet word suggestions copy failed");
      if (copied != length) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Wallet word suggestions changed");
      Value::List words;
      std::size_t offset = 0;
      for (std::size_t i = 0; i <= bytes.size(); ++i) {
        if (i != bytes.size() && bytes[i] != '\n') continue;
        if (i > offset) words.push_back(Value::string(std::string(bytes.begin() + offset, bytes.begin() + i)));
        else if (!bytes.empty()) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Wallet word suggestion is empty");
        offset = i + 1;
      }
      auto value = Value::list({Value::list(std::move(words))});
      validate_public_value(r.method, value); return value;
    }
    std::lock_guard<std::mutex> guard(prepared_lock_);
    const auto found = prepared_wallets_.find(r.resource_id);
    if (found == prepared_wallets_.end()) throw Error(CITIZENSDK_ERROR_NOT_FOUND, "Prepared wallet is not owned by this session");
    const auto sdk = host_->native_handle();
    if (r.method == Method::release_prepared_wallet) {
      const auto code = citizensdk_prepared_wallet_release(sdk, found->second.handle);
      // claimed被Core消费后句柄不存在是已释放；BUSY仍保留本绑定所有权，允许真实终态后重试。
      if (code != CITIZENSDK_OK && !(found->second.claimed && code == CITIZENSDK_ERROR_INVALID_HANDLE))
        throw Error(code, "Prepared wallet release failed");
      prepared_wallets_.erase(found);
      return Value::list({});
    }
    if (r.method != Method::copy_recovery_phrase || found->second.claimed)
      throw Error(CITIZENSDK_ERROR_INVALID_STATE, "Prepared wallet is not available for display");
    uint64_t length = 0;
    auto code = citizensdk_prepared_wallet_copy_mnemonic(sdk, found->second.handle, nullptr, 0, &length);
    if (code != CITIZENSDK_OK) throw Error(code, "Recovery phrase length query failed");
    if (length == 0 || length > 1024)
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "Recovery phrase exceeds boundary");
    CredentialBytes phrase(std::vector<uint8_t>(static_cast<std::size_t>(length)));
    uint64_t copied = length;
    code = citizensdk_prepared_wallet_copy_mnemonic(sdk, found->second.handle, phrase.value.data(), length, &copied);
    if (code != CITIZENSDK_OK) throw Error(code, "Recovery phrase copy failed");
    if (copied != length) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Recovery phrase length changed");
    return Value::list({Value::sensitive_bytes(std::move(phrase.value))});
  }
  void cancel_credential(uint64_t id) override {
    const auto code = citizensdk_host_cancel_credential(host_->host_handle(), id);
    if (code != CITIZENSDK_OK && code != CITIZENSDK_ERROR_INVALID_STATE &&
        code != CITIZENSDK_ERROR_NOT_FOUND)
      throw Error(code, "CitizenSDK credential cancellation failed");
  }
  bool cancel(citizensdk_request_id_t request) override {
    require_open();
    const auto code = citizensdk_cancel_request(host_->native_handle(), request);
    if (code != CITIZENSDK_OK && code != CITIZENSDK_ERROR_NOT_FOUND &&
        code != CITIZENSDK_ERROR_INVALID_HANDLE)
      throw Error(code, "CitizenSDK request cancellation failed");
    return code == CITIZENSDK_OK;
  }
  void close() override {
    clear_reviews();
    if (!host_) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Host is retired");
    if (!close_attempted_) {
      const auto state = lifecycle_state();
      if (state != CITIZENSDK_LIFECYCLE_CREATED &&
          state != CITIZENSDK_LIFECYCLE_START_FAILED &&
          state != CITIZENSDK_LIFECYCLE_STOPPED)
        throw Error(CITIZENSDK_ERROR_BUSY, "CitizenSDK must stop before Host close");
      checkpoint_state_ = state;
      close_attempted_ = true;
    }
    // 调用已存在的公开 Host 所有权实现。失败后只允许再次 close 或 retire，
    // 不接受任何新链操作、能力查询或钱包流程，不另建 Windows teardown。
    host_->close();
  }
  void retire() noexcept override {
    try { close_captures(); } catch (...) { /* 原Host仍保有真实采集租约。 */ }
    try { close_private_keys(); } catch (...) { /* Host监督器保留精确关闭钩子继续收口。 */ }
    clear_reviews();
    // Host::~Host performs its callback barrier and, if needed, transfers the
    // full Host/Core/store/vault graph to the existing process supervisor.
    host_.reset();
  }
 private:
  void require_open() const {
    if (!host_ || close_attempted_)
      throw Error(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK Host is closing or retired");
  }
  struct PrivateKeys final {
    std::mutex lock;
    std::map<std::string, std::shared_ptr<PrivateKeyResource>> values;
    ResourceObserver observer;
  };
  std::shared_ptr<PrivateKeys> private_keys_{std::make_shared<PrivateKeys>()};
  std::unique_ptr<Host> host_;
  const uint32_t modules_;
  Scheduler schedule_;
  TextureFactory textures_;
  std::map<std::string, std::shared_ptr<CaptureResource>> captures_;
  std::atomic<uint32_t> image_jobs_{0};
  struct Review { std::shared_ptr<detail::EventResultScope> result; bool claimed; };
  std::map<std::string, Review> reviews_;
  std::map<std::string, std::shared_ptr<detail::EventResultScope>> inspections_;
  void clear_reviews() {
    std::map<std::string, Review> owned;
    std::map<std::string, std::shared_ptr<detail::EventResultScope>> inspections;
    {
      std::lock_guard<std::mutex> guard(prepared_lock_);
      owned.swap(reviews_);
      inspections.swap(inspections_);
    }
    // 生命周期结束时所有尚未显式release的审阅结果仍有唯一释放所有者。
  }
  struct PreparedWallet { citizensdk_prepared_wallet_handle_t handle; bool claimed; };
  std::map<std::string, PreparedWallet> prepared_wallets_;
  std::mutex prepared_lock_;
  std::map<std::string, citizensdk_prepared_transaction_handle_t> prepared_transactions_;
  citizensdk_lifecycle_t checkpoint_state_{};
  bool close_attempted_{};
};

std::string random_session_id() {
  std::array<uint8_t, 16> bytes{};
  // Windows 系统 CSPRNG；session 只是公开路由标识，不是钱包/登录凭据。
  if (::BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                          "CitizenSDK session entropy is unavailable");
  static constexpr char hex[] = "0123456789abcdef";
  std::string value; value.reserve(32);
  for (const auto byte : bytes) {
    value.push_back(hex[static_cast<std::size_t>(byte >> 4)]);
    value.push_back(hex[static_cast<std::size_t>(byte & 15)]);
  }
  return value;
}

Reply failure(citizensdk_error_code_t code, const std::string &message,
              const DecodedRequest &request, citizensdk_failure_stage_t stage = 0) {
  const bool open = request.method == Method::open || request.method == Method::verify_signature || request.method == Method::encode_signing_payload;
  return {false, error_details(code, message,
          open ? std::optional<std::string>{} : request.session,
          open ? std::optional<int64_t>{} : request.sequence,
          method_name(request.method), stage), code, message};
}

Reply success(const DecodedRequest &request, Value payload) {
  if (request.method == Method::get_account_balances)
    validate_account_balances(request, payload);
  if (request.method == Method::qr_validate_sign_response ||
      request.method == Method::get_genesis_hash ||
      request.method == Method::cancel_signing ||
      request.method == Method::cancel_prepared_transaction ||
      request.method == Method::cancel_prepared_transaction_execution ||
      (request.method >= Method::qr_parse && request.method <= Method::sign_qr_request))
    validate_public_value(request.method, payload);
  return {true, response(request.session, request.sequence, std::move(payload)),
          CITIZENSDK_OK, {}};
}

std::mutex &process_mutation_lock() { static std::mutex value; return value; }
std::weak_ptr<void> &process_mutation_owner() {
  static std::weak_ptr<void> value;
  return value;
}
bool acquire_process_mutation(const std::shared_ptr<void> &owner) {
  // 全进程共享，不按 session 或 Flutter engine 分裂；并发变更直接 BUSY。
  std::lock_guard<std::mutex> guard(process_mutation_lock());
  if (!process_mutation_owner().expired()) return false;
  process_mutation_owner() = owner;
  return true;
}
void release_process_mutation(const std::shared_ptr<void> &owner) noexcept {
  std::lock_guard<std::mutex> guard(process_mutation_lock());
  const auto current = process_mutation_owner().lock();
  if (current == owner) process_mutation_owner().reset();
}

}  // namespace


PrivateKeyResource::PrivateKeyResource(citizensdk_handle_t core, std::string id,
    Completion opened, Closed closed)
    : PrivateKeyResource(core, std::move(id), std::move(opened), std::move(closed),
          {citizensdk_private_key_reveal, citizensdk_private_key_cancel, citizensdk_private_key_finish}) {}

PrivateKeyResource::PrivateKeyResource(citizensdk_handle_t core, std::string id,
    Completion opened, Closed closed, PrivateKeyControls controls)
    : core_(core), controls_(std::move(controls)), id_(std::move(id)),
      opened_(std::move(opened)), closed_(std::move(closed)) {
  if (!controls_.reveal || !controls_.cancel || !controls_.finish)
    throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Private key control table is incomplete");
}

citizensdk_private_key_receiver_v1_t PrivateKeyResource::receiver() noexcept {
  return {sizeof(citizensdk_private_key_receiver_v1_t), CITIZENSDK_ABI_VERSION, this,
          receive, settled, authorizing};
}

void PrivateKeyResource::bind(uint64_t secret) {
  bool revoked;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (secret == 0 || (secret_ != 0 && secret_ != secret)) std::terminate();
    secret_ = secret; revoked = revoked_;
  }
  if (revoked) { try { request_close(); } catch (...) { /* 保留所有权，Host关闭钩子继续请求。 */ } }
}

int32_t PrivateKeyResource::authorizing(void *raw, uint64_t secret, uint64_t operation) noexcept {
  auto *self = static_cast<PrivateKeyResource *>(raw);
  if (!self || secret == 0 || operation == 0) return CITIZENSDK_ERROR_INTEGRITY;
  try {
    std::lock_guard<std::mutex> guard(self->lock_);
    if (self->revoked_ || self->terminal_) return CITIZENSDK_ERROR_CANCELLED;
    if (!self->revealing_ || self->host_operation_ != 0 ||
        (self->secret_ != 0 && self->secret_ != secret)) return CITIZENSDK_ERROR_INTEGRITY;
    self->secret_ = secret; self->host_operation_ = operation;
    // 此OK仅接纳准确授权关联；后续实际Vault仍须使用真实凭据完成解密，绝非认证成功。
    return CITIZENSDK_OK;
  } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
}

int32_t PrivateKeyResource::receive(void *raw, uint64_t secret, citizensdk_bytes_view_t bytes) noexcept {
  auto *self = static_cast<PrivateKeyResource *>(raw);
  if (!self || secret == 0 || !bytes.data || bytes.len != 32) return CITIZENSDK_ERROR_INTEGRITY;
  try {
    std::lock_guard<std::mutex> guard(self->lock_);
    if (self->revoked_ || self->terminal_) return CITIZENSDK_ERROR_CANCELLED;
    if (self->secret_ != secret || !self->revealing_ || self->host_operation_ == 0 ||
        self->received_) return CITIZENSDK_ERROR_INTEGRITY;
    self->bytes_.emplace(bytes.data, 32);
    self->received_ = true;
    return CITIZENSDK_OK;
  } catch (...) { return CITIZENSDK_ERROR_INTERNAL; }
}

void PrivateKeyResource::settled(void *raw, uint64_t secret, int32_t code) noexcept {
  if (!raw) std::terminate();
  try { static_cast<PrivateKeyResource *>(raw)->stage(secret, code); }
  catch (...) { std::terminate(); } // 不能跨C边界抛出或丢弃仍由Core借用的context。
}

void PrivateKeyResource::deliver_failure(Completion completion, citizensdk_error_code_t code) {
  if (!completion) return;
  const auto self = shared_from_this();
  completion([self, code]() -> Value {
    // producer由平台线程领取；不在receiver借用回调内反调Core。
    try { self->request_close(); } catch (...) { /* 打开/查看交付原错误，关闭仍可重试。 */ }
    throw Error(code, "Private key resource did not become available");
  });
}

void PrivateKeyResource::stage(uint64_t secret, citizensdk_error_code_t code) {
  Completion completion;
  bool opening = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (secret == 0 || (secret_ != 0 && secret_ != secret)) code = CITIZENSDK_ERROR_INTEGRITY;
    else secret_ = secret;
    if (!prepared_) {
      prepared_ = true; opening = true; completion = std::move(opened_);
    } else if (revealing_) {
      completion = std::move(revealed_);
      if (code == CITIZENSDK_OK && !received_) code = CITIZENSDK_ERROR_INTEGRITY;
    }
    if (revoked_ && code == CITIZENSDK_OK) code = CITIZENSDK_ERROR_CANCELLED;
    if (code != CITIZENSDK_OK) { revoked_ = true; bytes_.reset(); }
  }
  if (!completion) return;
  if (code != CITIZENSDK_OK) { deliver_failure(std::move(completion), code); return; }
  const auto self = shared_from_this();
  completion([self, opening] { return opening ? self->grant() : self->take_secret(); });
}

Value PrivateKeyResource::grant() {
  auto value = Value::list({Value::string(id_)});
  std::lock_guard<std::mutex> guard(lock_);
  if (revoked_ || terminal_) throw Error(CITIZENSDK_ERROR_CANCELLED, "Private key resource was revoked");
  granted_ = true;
  return value;
}

Value PrivateKeyResource::take_secret() {
  std::lock_guard<std::mutex> guard(lock_);
  if (revoked_ || terminal_) throw Error(CITIZENSDK_ERROR_CANCELLED, "Private key delivery was revoked");
  if (delivered_ || !bytes_ || bytes_->value.size() != 32)
    throw Error(CITIZENSDK_ERROR_INTEGRITY, "Private key delivery is invalid");
  // 只在平台线程最终领取时交付，排队阶段不持有脱离撤销控制的明文结果。
  auto result = Value::list({Value::sensitive_bytes(std::move(bytes_->value))});
  bytes_.reset(); delivered_ = true;
  return result;
}

void PrivateKeyResource::reveal(Completion completion) {
  uint64_t secret;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (!prepared_ || revealing_ || revoked_ || terminal_)
      throw Error(CITIZENSDK_ERROR_INVALID_STATE, "Private key resource is not ready for reveal");
    revealing_ = true; revealed_ = std::move(completion); secret = secret_;
  }
  const auto code = controls_.reveal(core_, secret);
  if (code != CITIZENSDK_OK) {
    Completion rejected;
    { std::lock_guard<std::mutex> guard(lock_); rejected = std::move(revealed_); revoked_ = true; }
    deliver_failure(std::move(rejected), code);
  }
}

void PrivateKeyResource::request_close() {
  uint64_t secret;
  {
    std::lock_guard<std::mutex> guard(lock_);
    revoked_ = true; bytes_.reset();
    if (terminal_) return;
    secret = secret_;
  }
  if (secret == 0) return; // 接纳仍未返回；bind负责补发已登记的关闭。
  const auto cancel = controls_.cancel(core_, secret);
  if (cancel != CITIZENSDK_OK && cancel != CITIZENSDK_ERROR_NOT_FOUND)
    throw Error(cancel, "Private key cancellation failed");
  const auto finish = controls_.finish(core_, secret);
  if (finish != CITIZENSDK_OK && finish != CITIZENSDK_ERROR_NOT_FOUND)
    throw Error(finish, "Private key finish was not accepted");
  // NOT_FOUND也必须等待该请求真实terminal，不能在这里补造closed。
}

void PrivateKeyResource::close(Completion completion) {
  const auto delivered = std::make_shared<std::atomic<bool>>(false);
  Completion once = [completion = std::move(completion), delivered](std::function<Value()> value) {
    if (!delivered->exchange(true)) completion(std::move(value));
  };
  bool ended;
  {
    std::lock_guard<std::mutex> guard(lock_);
    ended = terminal_;
    if (!ended) closing_.push_back(once);
  }
  if (ended) { once([] { return Value::list({}); }); return; }
  try { request_close(); }
  catch (const Error &error) {
    const auto code = error.code(); const auto stage = error.stage();
    once([code, stage]() -> Value { throw Error(code, "Private key close must be retried", stage); });
  } catch (...) {
    once([]() -> Value { throw Error(CITIZENSDK_ERROR_INTERNAL, "Private key close failed"); });
  }
}

void PrivateKeyResource::terminal(citizensdk_error_code_t code) {
  Completion opened, revealed;
  std::vector<Completion> closing;
  Closed closed;
  bool granted;
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (terminal_) return;
    terminal_ = true; revoked_ = true; bytes_.reset();
    opened = std::move(opened_); revealed = std::move(revealed_);
    closing.swap(closing_); closed = std::move(closed_); granted = granted_;
  }
  const auto failure = code == CITIZENSDK_OK ? CITIZENSDK_ERROR_CANCELLED : code;
  deliver_failure(std::move(opened), failure);
  deliver_failure(std::move(revealed), failure);
  // 业务错误已由打开/查看交付；真实Core请求结束才使close成功，认证取消不是关闭失败。
  for (auto &completion : closing) completion([] { return Value::list({}); });
  if (closed) { try { closed(granted); } catch (...) { /* 真实终态已记录；下一次平台入口继续排空。 */ } }
}

bool PrivateKeyResource::is_closed() const {
  std::lock_guard<std::mutex> guard(lock_);
  return terminal_;
}


struct CaptureResource::State final {
  citizensdk_host_handle_t host;
  std::string id;
  uint32_t purpose;
  Scheduler schedule;
  TextureFactory textures;
  Observer observer;
  Closed closed;
  CaptureControls controls;
  uint64_t native{}, operation{};
  uint32_t width{}, height{}, rotation{};
  bool revoked{}, published{}, host_released{}, texture_closing{}, texture_drained{true}, finished{}, paused{true};
  citizensdk_error_code_t terminal{CITIZENSDK_OK};
  Completion opening;
  std::map<uint64_t, std::pair<Method, Completion>> pending;
  std::vector<Completion> closing;
  std::shared_ptr<CaptureTexture> texture;
  // 只有anchor、最新帧及交付代际跨线程；业务/Flutter状态始终只在平台线程读写。
  std::mutex lock;
  std::shared_ptr<CaptureResource> anchor;
  std::shared_ptr<const std::vector<uint8_t>> latest;
  bool frame_queued{}, document_queued{}, error_queued{};
  std::atomic<uint64_t> delivery_epoch{0};

  State(citizensdk_host_handle_t value, std::string identity, uint32_t use, Scheduler queue,
        TextureFactory factory, Observer events, Closed done, CaptureControls calls)
      : host(value), id(std::move(identity)), purpose(use), schedule(std::move(queue)),
        textures(std::move(factory)), observer(std::move(events)), closed(std::move(done)), controls(std::move(calls)) {}
  static void complete(Completion callback, citizensdk_error_code_t code) {
    if (callback) callback([code] {
      if (code != CITIZENSDK_OK) throw Error(code, "采集资源操作失败");
      return Value::list({});
    });
  }
};

CaptureResource::CaptureResource(citizensdk_host_handle_t host, std::string id, uint32_t purpose,
    Scheduler schedule, TextureFactory textures, Observer observer, Closed closed)
    : CaptureResource(host, std::move(id), purpose, std::move(schedule), std::move(textures),
        std::move(observer), std::move(closed), {citizensdk_host_open_qr_capture, citizensdk_host_control_qr_capture}) {}
CaptureResource::CaptureResource(citizensdk_host_handle_t host, std::string id, uint32_t purpose,
    Scheduler schedule, TextureFactory textures, Observer observer, Closed closed, CaptureControls controls)
    : state_(std::make_unique<State>(host, std::move(id), purpose, std::move(schedule), std::move(textures),
        std::move(observer), std::move(closed), std::move(controls))) {
  if (!host || state_->id.empty() || purpose < 1 || purpose > 8 || !state_->schedule ||
      !state_->textures || !state_->closed || !state_->controls.open || !state_->controls.control)
    throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集资源配置不完整");
}
CaptureResource::~CaptureResource() = default;

void CaptureResource::enqueue(std::function<void()> action) noexcept {
  try { state_->schedule(std::move(action)); }
  catch (...) {
    // 排队失败不等于设备/纹理已释放；保有资源，禁止虚报完成或继续裸指针析构。
    std::lock_guard<std::mutex> guard(state_->lock);
    if (!state_->anchor) state_->anchor = shared_from_this();
  }
}
void CaptureResource::retain(void *raw) noexcept {
  auto &self = *static_cast<CaptureResource *>(raw);
  std::lock_guard<std::mutex> guard(self.state_->lock);
  self.state_->anchor = self.shared_from_this();
}
void CaptureResource::release(void *raw) noexcept {
  auto &self = *static_cast<CaptureResource *>(raw);
  std::shared_ptr<CaptureResource> owner;
  { std::lock_guard<std::mutex> guard(self.state_->lock); owner = std::move(self.state_->anchor); }
  if (!owner) return;
  // Host已经归还自身租约；这里只排队，不从release反调Host。
  self.enqueue([owner] { owner->state_->host_released = true; owner->finish_close(); });
}
void CaptureResource::open(Completion completion) {
  auto &s = *state_;
  if (s.opening || s.native || s.finished || s.revoked) throw Error(CITIZENSDK_ERROR_INVALID_STATE, "采集资源不可重复打开");
  s.opening = std::move(completion);
  const citizensdk_qr_capture_callbacks_v1_t callbacks{sizeof(citizensdk_qr_capture_callbacks_v1_t),
      CITIZENSDK_HOST_ABI_VERSION, this, opened, frame, document, error, controlled, closed, retain, release};
  uint64_t id = 0;
  const auto code = s.controls.open(s.host, s.purpose, &callbacks, &id);
  if (code != CITIZENSDK_OK) {
    s.terminal = code; s.host_released = true; s.revoked = true; finish_close(); return;
  }
  if (id == 0) throw Error(CITIZENSDK_ERROR_INTEGRITY, "Host采集接纳返回空编号");
  s.native = id;
}
void CaptureResource::opened(void *raw, uint64_t native, citizensdk_error_code_t code,
    uint32_t width, uint32_t height, uint32_t rotation) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  self->enqueue([self, native, code, width, height, rotation] {
    auto &s = *self->state_;
    if (native != s.native) { s.terminal = CITIZENSDK_ERROR_INTEGRITY; self->request_close(); return; }
    if (code != CITIZENSDK_OK) { s.terminal = code; return; } // 失败也等Host最终release。
    if (s.revoked) return;
    try {
      if (width == 0 || width > 4096 || height == 0 || height > 4096 || rotation > 270 || rotation % 90)
        throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集预览规格无效");
      s.width = width; s.height = height; s.rotation = rotation;
      s.texture = s.textures(width, height);
      if (s.texture) s.texture_drained = false;
      if (!s.texture || s.texture->id() < 0) throw Error(CITIZENSDK_ERROR_UNAVAILABLE, "Flutter纹理不可用");
      auto completion = std::move(s.opening);
      if (completion) completion([self] {
        auto &current = *self->state_;
        if (current.revoked || current.finished || !current.texture)
          throw Error(CITIZENSDK_ERROR_CANCELLED, "采集打开交付已撤销");
        current.published = true;
        return Value::list({Value::string(current.id), Value::integer(current.texture->id()),
            Value::integer(current.width), Value::integer(current.height), Value::integer(current.rotation)});
      });
    } catch (const Error &failure) { s.terminal = failure.code(); self->request_close(); }
    catch (const ContractFailure &failure) { s.terminal = failure.code; self->request_close(); }
    catch (...) { s.terminal = CITIZENSDK_ERROR_INTERNAL; self->request_close(); }
  });
}
void CaptureResource::frame(void *raw, uint64_t, const citizensdk_qr_frame_v1_t *value) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  try {
    if (!value || value->struct_size != sizeof(*value) || value->abi_version != CITIZENSDK_HOST_ABI_VERSION ||
        value->width == 0 || value->width > 4096 || value->height == 0 || value->height > 4096 ||
        !value->rgba.data || value->rgba.len != static_cast<uint64_t>(value->width) * value->height * 4)
      throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集像素规格无效");
    auto pixels = std::make_shared<const std::vector<uint8_t>>(value->rgba.data, value->rgba.data + value->rgba.len);
    {
      std::lock_guard<std::mutex> guard(self->state_->lock);
      self->state_->latest = std::move(pixels);
      if (self->state_->frame_queued) return;
      self->state_->frame_queued = true;
    }
    self->enqueue([self] {
      std::shared_ptr<const std::vector<uint8_t>> latest;
      {
        std::lock_guard<std::mutex> guard(self->state_->lock);
        latest = std::move(self->state_->latest); self->state_->frame_queued = false;
      }
      auto &s = *self->state_;
      if (s.revoked || !s.texture || !latest) return;
      try { s.texture->update(std::move(latest)); }
      catch (...) { s.terminal = CITIZENSDK_ERROR_UNAVAILABLE; self->request_close(); }
    });
  } catch (...) {
    self->enqueue([self] { self->state_->terminal = CITIZENSDK_ERROR_INTEGRITY; self->request_close(); });
  }
}
void CaptureResource::document(void *raw, uint64_t native, uint64_t, citizensdk_bytes_view_t bytes) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  try {
    if (!bytes.data || bytes.len == 0 || bytes.len > 65536) throw Error(CITIZENSDK_ERROR_INTEGRITY, "采集文档大小无效");
    { std::lock_guard<std::mutex> guard(self->state_->lock);
      if (self->state_->document_queued) return;
      self->state_->document_queued = true; }
    const auto epoch = self->state_->delivery_epoch.load();
    std::string json(reinterpret_cast<const char *>(bytes.data), static_cast<std::size_t>(bytes.len));
    self->enqueue([self, native, epoch, json = std::move(json)] {
      { std::lock_guard<std::mutex> guard(self->state_->lock); self->state_->document_queued = false; }
      auto &s = *self->state_;
      if (native != s.native || s.revoked || s.paused || !s.published || epoch != s.delivery_epoch.load()) return;
      if (s.observer) s.observer("qrCaptureResult", Value::list({
          Value::string(s.id), Value::integer(s.purpose), Value::string(json)}));
    });
  } catch (...) {
    { std::lock_guard<std::mutex> guard(self->state_->lock); self->state_->document_queued = false; }
    error(raw, native, CITIZENSDK_ERROR_INTEGRITY);
  }
}
void CaptureResource::report_error(citizensdk_error_code_t code) {
  if (code == CITIZENSDK_OK || !state_->published || state_->revoked || !state_->observer) return;
  state_->observer("qrCaptureError", Value::list({Value::string(state_->id), Value::integer(code),
      Value::string(error_name(code)), Value::integer(flutter_default_failure_stage(code))}));
}
void CaptureResource::error(void *raw, uint64_t native, citizensdk_error_code_t code) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  { std::lock_guard<std::mutex> guard(self->state_->lock);
    if (self->state_->error_queued) return;
    self->state_->error_queued = true; }
  const auto epoch = self->state_->delivery_epoch.load();
  self->enqueue([self, native, epoch, code] {
    { std::lock_guard<std::mutex> guard(self->state_->lock); self->state_->error_queued = false; }
    if (native == self->state_->native && epoch == self->state_->delivery_epoch.load()) self->report_error(code);
  });
}
void CaptureResource::controlled(void *raw, uint64_t native, uint64_t operation, citizensdk_error_code_t code) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  self->enqueue([self, native, operation, code] {
    auto &s = *self->state_;
    if (native != s.native) return;
    const auto found = s.pending.find(operation);
    if (found == s.pending.end()) return;
    const auto method = found->second.first;
    auto completion = std::move(found->second.second); s.pending.erase(found);
    if (method == Method::resume_qr_capture && code == CITIZENSDK_OK && !s.revoked &&
        operation == s.delivery_epoch.load()) s.paused = false;
    State::complete(std::move(completion), code);
  });
}
void CaptureResource::closed(void *raw, uint64_t native, citizensdk_error_code_t code) noexcept {
  auto self = static_cast<CaptureResource *>(raw)->shared_from_this();
  self->enqueue([self, native, code] {
    auto &s = *self->state_;
    if (native != s.native) s.terminal = CITIZENSDK_ERROR_INTEGRITY;
    else if (code != CITIZENSDK_OK) s.terminal = code;
    self->report_error(s.terminal);
    s.revoked = true; s.paused = true;
    self->begin_texture_close(); self->finish_close();
  });
}
void CaptureResource::begin_texture_close() {
  auto &s = *state_;
  if (!s.texture || s.texture_closing || s.texture_drained) return;
  s.texture_closing = true;
  const auto self = shared_from_this();
  try {
    s.texture->close([self] {
      self->enqueue([self] {
        self->state_->texture_drained = true;
        self->state_->texture.reset();
        self->finish_close();
      });
    });
  } catch (...) { s.texture_closing = false; throw; } // 注销失败仍保有纹理，可再次关闭。
}
void CaptureResource::request_close() {
  auto &s = *state_;
  if (s.finished) return;
  s.revoked = true; s.paused = true;
  if (s.native && !s.host_released) {
    if (s.operation == UINT64_MAX) throw Error(CITIZENSDK_ERROR_UNAVAILABLE, "采集控制编号耗尽");
    const auto operation = ++s.operation; s.delivery_epoch.store(operation);
    const auto code = s.controls.control(s.host, s.native, operation, 4, 0);
    // 已从Host表移除的资源仍要等已排队release，不能直接认定关闭。
    if (code != CITIZENSDK_OK && code != CITIZENSDK_ERROR_NOT_FOUND)
      throw Error(code, "采集关闭接纳失败");
  }
  begin_texture_close(); finish_close();
}
void CaptureResource::control(Method method, bool enabled, Completion completion) {
  auto &s = *state_;
  if (method == Method::close_qr_capture) {
    if (s.finished) { State::complete(std::move(completion), s.terminal); return; }
    if (s.closing.size() >= 64) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "采集关闭等待已达上限");
    s.closing.push_back(std::move(completion));
    try { request_close(); }
    catch (...) { if (!s.closing.empty()) s.closing.pop_back(); throw; }
    return;
  }
  if (s.revoked || s.finished || !s.native || !s.published)
    throw Error(CITIZENSDK_ERROR_INVALID_STATE, "采集资源未就绪或已关闭");
  const uint32_t action = method == Method::pause_qr_capture ? 1 : method == Method::resume_qr_capture ? 2 :
      method == Method::set_qr_capture_torch ? 3 : 0;
  if (!action) throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "采集控制无效");
  if (s.pending.size() >= 64 || s.operation == UINT64_MAX) throw Error(CITIZENSDK_ERROR_QUEUE_FULL, "采集控制已达上限");
  const auto operation = ++s.operation;
  s.pending.emplace(operation, std::make_pair(method, std::move(completion)));
  const auto code = s.controls.control(s.host, s.native, operation, action, action == 3 && enabled ? 1 : 0);
  if (code != CITIZENSDK_OK) {
    auto callback = std::move(s.pending.at(operation).second); s.pending.erase(operation);
    State::complete(std::move(callback), code); return;
  }
  if (action == 1 || action == 2) {
    s.delivery_epoch.store(operation); s.paused = true;
  }
}
void CaptureResource::finish_close() {
  auto &s = *state_;
  if (s.finished || !s.host_released || !s.texture_drained) return;
  s.finished = true; s.revoked = true;
  State::complete(std::move(s.opening), s.terminal == CITIZENSDK_OK ? CITIZENSDK_ERROR_CANCELLED : s.terminal);
  auto controls = std::move(s.pending);
  for (auto &entry : controls) State::complete(std::move(entry.second.second), CITIZENSDK_ERROR_CANCELLED);
  auto closing = std::move(s.closing);
  for (auto &completion : closing) State::complete(std::move(completion), s.terminal);
  auto done = std::move(s.closed);
  if (done) done(s.published);
}
bool CaptureResource::is_closed() const noexcept { return state_->finished; }

struct Sessions::State final : std::enable_shared_from_this<State> {
  struct Route final {
    DecodedRequest request;
    // Public method/arguments never change. native_method alone advances an
    // approved compound operation to its private profile-read stage.
    Method native_method{Method::open};
    ReplyCallback reply;
    citizensdk_request_id_t native_id{};
    std::optional<Reply> ready;
    std::function<Value()> projection;
    bool completion_identity_invalid{};
    bool accepting{};
    bool terminal_seen{};
    bool completed{};
    bool close_stop{};
    bool mutation{};
    bool fetch_profile_after_mutation{};
    std::shared_ptr<void> mutation_owner;
  };
  struct CredentialReply;
  struct Session final {
    std::string id;
    std::shared_ptr<NativeTransport> transport;

    int64_t next_event{1};
    std::mutex lock;
    std::map<int64_t, std::shared_ptr<Route>> routes;
    std::map<uint64_t, std::shared_ptr<CredentialReply>> credentials;
    std::shared_ptr<Route> admitting;
    bool closing{};
    bool retired{};
    std::optional<DecodedRequest> close_request;
    ReplyCallback close_reply;
  };

  State(EnvironmentFactory source, Scheduler queue, TransportFactory make)
      : environment(std::move(source)), schedule(std::move(queue)),
        factory(std::move(make)), owner(std::this_thread::get_id()) {}
  EnvironmentFactory environment;
  Scheduler schedule;
  TransportFactory factory;
  std::thread::id owner;
  std::map<std::string, std::shared_ptr<Session>> sessions;
  EventSink sink;
  // 公开目录变更沿既有进程门串行；Core真实终态到达后释放，不再依赖SDK窗口。
  std::shared_ptr<Route> active_mutation;
  // The callback thread snapshots epoch under this lock; all Flutter objects
  // remain UI-owned and are never accessed from that thread.
  std::mutex epoch_lock;
  uint64_t epoch{};
  bool detached{};
  std::shared_ptr<State> detached_owner;
  void retain_detached_state() {
    // detach 只撤销 Flutter 回调，不等于原生操作完成。自保活无需新增线程或
    // 分配全局队列；待已接受请求排空后解除，再交既有 Host supervisor。
    if (!detached_owner) detached_owner = shared_from_this();
  }
  void release_detached_state_if_empty() {
    if (sessions.empty()) detached_owner.reset();
  }

  void require_owner() const {
    if (std::this_thread::get_id() != owner)
      throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE,
                            "CitizenSDK Flutter entry point requires the UI thread");
  }

  uint64_t snapshot_epoch() {
    std::lock_guard<std::mutex> guard(epoch_lock);
    return epoch;
  }
  void advance_epoch(bool detach_now = false) {
    std::lock_guard<std::mutex> guard(epoch_lock);
    if (epoch == std::numeric_limits<uint64_t>::max()) {
      detached = true;
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                            "CitizenSDK subscription generation is exhausted");
    }
    ++epoch;
    if (detach_now) detached = true;
  }
  bool is_detached() {
    std::lock_guard<std::mutex> guard(epoch_lock);
    return detached;
  }

  bool current(const std::shared_ptr<Session> &session) const {
    const auto found = sessions.find(session->id);
    return found != sessions.end() && found->second == session && !session->retired;
  }
  void emit(const std::shared_ptr<Session> &session, const std::string &type,
            Value payload, uint64_t expected) {
    if (is_detached() || expected != snapshot_epoch() || !sink || !current(session)) return;
    if (session->next_event == std::numeric_limits<int64_t>::max()) {
      // Fail closed instead of wrapping/reusing an event sequence.
      cancel_events();
      throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                            "CitizenSDK event sequence is exhausted");
    }
    const auto sequence = session->next_event++;
    auto callback = sink;
    callback(event(session->id, sequence, type, std::move(payload)));
  }
  void snapshots(const std::shared_ptr<Session> &session, uint64_t expected,
                 citizensdk_event_type_t kind = 0) {
    if (!current(session) || is_detached() || expected != snapshot_epoch()) return;
    if (kind == CITIZENSDK_EVENT_HISTORY_CHANGED)
      emit(session, "historyChanged", Value::list({}), expected);
    if (kind == CITIZENSDK_EVENT_WALLET_CHANGED)
      emit(session, "walletChanged", Value::list({}), expected);
    // Core callbacks carry only a notification, not an owned snapshot. Query
    // on the UI thread after the callback returns, never re-enter Core while
    // its dispatch thread may hold lifecycle/provider locks.
    if (kind == 0 || kind == CITIZENSDK_EVENT_LIFECYCLE_CHANGED)
      emit(session, "lifecycleChanged",
           Value::list({lifecycle(session->transport->lifecycle_state())}), expected);
    if (kind == 0 || kind == CITIZENSDK_EVENT_CAPABILITIES_CHANGED)
      emit(session, "capabilitiesChanged",
           Value::list({session->transport->capability_snapshot()}), expected);
  }

  void post_drain(const std::shared_ptr<Session> &session) noexcept {
    try {
      std::weak_ptr<State> weak = shared_from_this();
      std::weak_ptr<Session> target = session;
      schedule([weak, target] {
        if (const auto state = weak.lock()) if (const auto value = target.lock()) {
          try { state->drain(value); } catch (...) {}
        }
      });
    } catch (...) {
      // Route::ready remains authoritative until the next UI dispatch/drain.
      // No borrowed result or callback pointer is stored in this recovery path.
    }
  }

  void receive(const std::shared_ptr<Session> &session,
               const citizensdk_event_t &event_value) noexcept {
    const auto expected = snapshot_epoch();
    if (event_value.struct_size < sizeof(event_value) ||
        event_value.abi_version != CITIZENSDK_ABI_VERSION) return;
    if (event_value.event_type == CITIZENSDK_EVENT_FINALIZED_BLOCK_CHANGED) {
      if (event_value.request_id != 0 || event_value.result == 0 ||
          event_value.capability_revision != 0 || event_value.reserved != 0) return;
      try {
        Value payload = session->transport->copy_result(
            Method::get_finalized_head, event_value.result);
        std::weak_ptr<State> weak = shared_from_this();
        std::weak_ptr<Session> target = session;
        schedule([weak, target, expected, payload = std::move(payload)]() mutable {
          if (const auto state = weak.lock()) if (const auto value = target.lock()) {
            try { state->emit(value, "finalizedBlockChanged", std::move(payload), expected); }
            catch (...) {}
          }
        });
      } catch (...) {}
      return;
    }
    if (event_value.event_type == CITIZENSDK_EVENT_LIFECYCLE_CHANGED ||
        event_value.event_type == CITIZENSDK_EVENT_CAPABILITIES_CHANGED ||
        event_value.event_type == CITIZENSDK_EVENT_HISTORY_CHANGED ||
        event_value.event_type == CITIZENSDK_EVENT_WALLET_CHANGED) {
      if ((event_value.event_type == CITIZENSDK_EVENT_HISTORY_CHANGED ||
           event_value.event_type == CITIZENSDK_EVENT_WALLET_CHANGED) &&
          (event_value.request_id != 0 || event_value.result != 0 ||
           event_value.capability_revision != 0 || event_value.reserved != 0)) return;
      try {
        std::weak_ptr<State> weak = shared_from_this();
        std::weak_ptr<Session> target = session;
        const auto kind = event_value.event_type;
        schedule([weak, target, expected, kind] {
          if (const auto state = weak.lock()) if (const auto value = target.lock()) {
            try { state->snapshots(value, expected, kind); } catch (...) {}
          }
        });
      } catch (...) {}
      return;
    }
    // 请求终态归Host私有路由；公共观察者只承接上面的真实状态/链事件。
  }

  void receive_result(const std::shared_ptr<Session> &session, const std::shared_ptr<Route> &route,
                      citizensdk_request_id_t id, std::function<Value()> projection) noexcept {
    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (route->terminal_seen) return;
      if (id == 0 || (route->native_id != 0 && route->native_id != id)) {
        route->completion_identity_invalid = true;
      } else {
        route->native_id = id;
        route->projection = std::move(projection);
      }
      route->terminal_seen = true;
      route->completed = true;
    }
    post_drain(session);
  }


  using CredentialValue = std::optional<std::vector<uint8_t>>;
  struct CredentialReply final { std::promise<CredentialValue> result; };

  static void wipe_credential(CredentialValue &value) noexcept {
    if (!value) return;
    volatile uint8_t *data = value->data();
    for (std::size_t i = 0; i < value->size(); ++i) data[i] = 0;
    value.reset();
  }
  static bool settle_credential(const std::shared_ptr<Session> &session,
                                uint64_t id, CredentialValue value) {
    std::shared_ptr<CredentialReply> reply;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      const auto found = session->credentials.find(id);
      if (found == session->credentials.end()) { wipe_credential(value); return false; }
      reply = found->second;
      session->credentials.erase(found);
    }
    try { reply->result.set_value(std::move(value)); }
    catch (...) { wipe_credential(value); throw; }
    return true;
  }

  std::future<CredentialValue> credential(const std::shared_ptr<Session> &session,
                                         const CredentialChallenge &challenge) {
    auto reply = std::make_shared<CredentialReply>();
    auto result = reply->result.get_future();
    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (session->credentials.size() >= 64 ||
          !session->credentials.emplace(challenge.host_operation_id, reply).second)
        throw ContractFailure(CITIZENSDK_ERROR_CONFLICT, "Credential challenge admission failed");
    }
    std::weak_ptr<State> weak = shared_from_this();
    std::weak_ptr<Session> target = session;
    const auto expected = snapshot_epoch();
    try {
      schedule([weak, target, expected, challenge] {
        const auto state = weak.lock(); const auto session = target.lock();
        if (!session) return;
        if (!state || !state->current(session) || state->is_detached() ||
            session->closing || !state->sink || expected != state->snapshot_epoch()) {
          settle_credential(session, challenge.host_operation_id, std::nullopt);
          return;
        }
        try {
          state->emit(session, "credentialRequest", Value::list({
              Value::string(std::to_string(challenge.host_operation_id)),
              Value::string(challenge.key_purpose), Value::null()}), expected);
        } catch (...) { settle_credential(session, challenge.host_operation_id, std::nullopt); }
      });
      // deferred复用C++凭据适配器的既有等待线程，不为Flutter另开一个等待线程。
      return std::async(std::launch::deferred,
          [weak, target, challenge, result = std::move(result)]() mutable -> CredentialValue {
        for (;;) {
          if (challenge.cancelled.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready) {
            if (const auto session = target.lock())
              settle_credential(session, challenge.host_operation_id, std::nullopt);
            if (result.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready) {
              try { auto late = result.get(); wipe_credential(late); } catch (...) {}
            }
            if (const auto state = weak.lock()) {
              try {
                state->schedule([weak, target, id = challenge.host_operation_id] {
                  if (const auto state = weak.lock()) if (const auto session = target.lock())
                    state->emit(session, "credentialCancelled",
                        Value::list({Value::string(std::to_string(id))}), state->snapshot_epoch());
                });
              } catch (...) {}
            }
            return std::nullopt;
          }
          if (result.wait_for(std::chrono::milliseconds(20)) == std::future_status::ready)
            return result.get();
        }
      });
    } catch (...) {
      settle_credential(session, challenge.host_operation_id, std::nullopt);
      throw;
    }
  }

  void cancel_credentials(const std::shared_ptr<Session> &session) {
    std::vector<uint64_t> ids;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      for (const auto &entry : session->credentials) ids.push_back(entry.first);
    }
    for (const auto id : ids) {
      session->transport->cancel_credential(id);
      (void)settle_credential(session, id, std::nullopt);
    }
  }

  void open(DecodedRequest request, ReplyCallback reply) {
    std::shared_ptr<Session> session;
    std::optional<Reply> outcome;
    try {
      const auto module_code = citizensdk_validate_modules(request.modules);
      if (module_code != CITIZENSDK_OK)
        throw ContractFailure(module_code, "CitizenSDK module selection is invalid");
      auto source = environment(request.modules); // keeps upgraded parent alive through Host creation
      session = std::make_shared<Session>();
      session->id = random_session_id();
      source.config.modules = request.modules;
      if (request.has_credential_provider) {
        std::weak_ptr<State> weak = shared_from_this();
        std::weak_ptr<Session> target = session;
        source.config.credentialProvider = [weak, target](const CredentialChallenge &challenge) {
          const auto state = weak.lock(); const auto session = target.lock();
          if (!state || !session) {
            std::promise<CredentialValue> cancelled;
            cancelled.set_value(std::nullopt);
            return cancelled.get_future();
          }
          return state->credential(session, challenge);
        };
      }
      session->transport = factory(source.config);
      if (!session->transport) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE,
                                                     "CitizenSDK native Host is unavailable");
      std::weak_ptr<State> weak = shared_from_this();
      std::weak_ptr<Session> target = session;
      session->transport->observe([weak, target](const citizensdk_event_t &value) {
        if (const auto state = weak.lock()) if (const auto session = target.lock()) state->receive(session, value);
      });
      session->transport->observe_resources([weak, target](std::string type, Value payload) {
        if (const auto state = weak.lock()) {
          const auto expected = state->snapshot_epoch();
          state->schedule([weak, target, expected, type = std::move(type), payload = std::move(payload)]() mutable {
            if (const auto state = weak.lock()) if (const auto session = target.lock()) {
              if (!state->current(session)) return;
              if (!type.empty()) state->emit(session, type, std::move(payload), expected);
              state->drain(session);
            }
          });
        }
      });
      const auto initial_state = session->transport->lifecycle_state();
      // open 的固定合同是 created / eventSequence 1；其它合法生命周期也
      // 不能冒充新 session，否则 Dart 会拒绝响应并失去该原生实例的身份。
      if (initial_state != CITIZENSDK_LIFECYCLE_CREATED)
        throw ContractFailure(CITIZENSDK_ERROR_INTEGRITY,
                              "CitizenSDK open requires a newly created native instance");
      if (!sessions.emplace(session->id, session).second)
        throw ContractFailure(CITIZENSDK_ERROR_CONFLICT, "CitizenSDK session identity collision");
      request.session = session->id;
      const auto state = lifecycle(initial_state);
      outcome = success(request, Value::list({state, Value::integer(1)}));
    } catch (const ContractFailure &error) {
      if (session && session->transport) { sessions.erase(session->id); session->transport->retire(); }
      outcome = failure(error.code, error.what(), request, error.stage);
    } catch (const Error &error) {
      if (session && session->transport) { sessions.erase(session->id); session->transport->retire(); }
      outcome = failure(error.code(), error.what(), request, error.stage());
    } catch (...) {
      if (session && session->transport) { sessions.erase(session->id); session->transport->retire(); }
      outcome = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK open failed", request);
    }
    // User/messenger code is outside native resource rollback. Once a session
    // was inserted, a throwing test callback must not make us reply twice.
    reply(std::move(*outcome));
    // Match the other official bindings: publish the open response before the
    // first session events, so Dart learns the random session ID first. A
    // reentrant close removes the session and makes snapshots a no-op.
    if (session && current(session)) {
      try { snapshots(session, snapshot_epoch()); } catch (...) {}
    }
  }

  void submit(const std::shared_ptr<Session> &session, const std::shared_ptr<Route> &route) {
    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (session->admitting) throw ContractFailure(CITIZENSDK_ERROR_BUSY,
                                                   "CitizenSDK request admission is busy");
      route->accepting = true;
      session->admitting = route;
    }
    citizensdk_request_id_t native_id = 0;
    citizensdk_error_code_t code = CITIZENSDK_ERROR_INTERNAL;
    try {
      std::weak_ptr<State> weak = shared_from_this();
      std::weak_ptr<Session> target = session;
      code = session->transport->accept(route->native_method, route->request, &native_id,
          [weak, target, route](citizensdk_request_id_t id, std::function<Value()> projection) {
            if (const auto state = weak.lock()) if (const auto current = target.lock())
              state->receive_result(current, route, id, std::move(projection));
          });
    }
    catch (...) {
      // Production C ABI is noexcept; finite test transports may throw before
      // acceptance. An observed ID means completion owns the route already.
      code = CITIZENSDK_ERROR_INTERNAL;
    }
    // Core在接纳调用内已经复制输入；路由只保留公开上下文等待真实终态。
    route->request.mnemonic.reset();
    route->request.password.reset();
    {
      std::lock_guard<std::mutex> guard(session->lock);
      route->accepting = false;
      session->admitting.reset();
      if (code == CITIZENSDK_OK && native_id != 0 &&
          (route->native_id == 0 || route->native_id == native_id)) {
        route->native_id = native_id;
      } else {
        // A contract-violating adapter must not overwrite the early route.
        // Keep any accepted ID for cancellation/retirement, but fail publicly.
        route->completed = true;
        route->ready = failure(code == CITIZENSDK_OK ? CITIZENSDK_ERROR_INTEGRITY : code,
                              "CitizenSDK native request was not accepted", route->request);
      }
    }
    drain(session);
  }

  void resource_operation(const std::shared_ptr<Session> &session, const std::shared_ptr<Route> &route) {
    { std::lock_guard<std::mutex> guard(session->lock); route->accepting = true; }
    const std::weak_ptr<State> weak = shared_from_this();
    const std::weak_ptr<Session> target = session;
    try {
      auto completion = [weak, target, route](std::function<Value()> project) {
            const auto state = weak.lock(); const auto session = target.lock();
            if (!state || !session) return;
            {
              std::lock_guard<std::mutex> guard(session->lock);
              if (route->terminal_seen) return;
              // 这里只结束该资源控制调用；长期Core/相机/纹理所有权分别保有至真实排空。
              route->projection = std::move(project);
              route->terminal_seen = true; route->completed = true;
            }
            state->post_drain(session);
          };
      const auto method = route->request.method;
      if (method == Method::open_private_key || method == Method::reveal_private_key || method == Method::close_private_key)
        session->transport->private_key(route->request, std::move(completion));
      else session->transport->capture(route->request, std::move(completion));
    } catch (...) {
      { std::lock_guard<std::mutex> guard(session->lock); route->accepting = false; }
      throw;
    }
    { std::lock_guard<std::mutex> guard(session->lock); route->accepting = false; }
    drain(session);
  }

  static bool is_mutation(Method method) noexcept {
    switch (method) {
      // 这里只串行真实Core目录变更；私钥显示资源由独立代际租约保有。
       case Method::sign_qr_request:
         case Method::import_wallet:
      case Method::prepare_wallet_creation: case Method::commit_wallet_creation:
      case Method::add_next_wallet_account: case Method::sign_and_delete_wallet:
      case Method::add_wallet_accounts: case Method::set_active_wallet_account:
      case Method::import_cold_account_id: case Method::import_cold_account_ss58:
      case Method::reorder_wallet_accounts_without_default_change:
      case Method::begin_default_account_change:
      case Method::consume_default_account_change:
      case Method::repair_hot_wallet: case Method::rename_diagnostic_wallet: case Method::delete_diagnostic_wallet:
      case Method::set_active_wallet: case Method::rename_wallet:
      case Method::import_cold_account_code:
      case Method::rename_account: case Method::delete_account:
      case Method::delete_wallet: case Method::reconcile_wallet_cleanup:
        return true;
      default: return false;
    }
  }

  static bool needs_profile_read(Method method) noexcept {
    return method == Method::reconcile_wallet_cleanup;
  }

  void settle_launch_failure(const std::shared_ptr<Session> &session,
                             const std::shared_ptr<Route> &route,
                             citizensdk_error_code_t code,
                             const std::string &message,
                             citizensdk_failure_stage_t stage = 0) {
    {
      std::lock_guard<std::mutex> guard(session->lock);
      route->completed = true;
      route->ready = failure(code, message, route->request, stage);
    }
    drain(session);
  }

  void launch_mutation(const std::shared_ptr<Session> &session,
                       const std::shared_ptr<Route> &route) {
    try {
      submit(session, route);
    } catch (const ContractFailure &error) {
      settle_launch_failure(session, route, error.code, error.what(), error.stage);
    } catch (const Error &error) {
      settle_launch_failure(session, route, error.code(), error.what(), error.stage());
    } catch (...) {
      settle_launch_failure(session, route, CITIZENSDK_ERROR_INTERNAL,
                            "CitizenSDK wallet mutation dispatch failed");
    }
  }

  void begin_mutation(const std::shared_ptr<Session> &session,
                      const std::shared_ptr<Route> &route) {
    route->mutation = true;
    route->mutation_owner = std::make_shared<uint8_t>(0);
    if (!acquire_process_mutation(route->mutation_owner)) {
      settle_launch_failure(session, route, CITIZENSDK_ERROR_BUSY,
                            "CitizenSDK wallet mutation is already active");
      return;
    }
    active_mutation = route;
    launch_mutation(session, route);
  }

  void finish_mutation(const std::shared_ptr<Route> &route) {
    if (active_mutation == route) active_mutation.reset();
    release_process_mutation(route->mutation_owner);
    route->mutation_owner.reset();
  }

  void retire_detached_session_if_idle(const std::shared_ptr<Session> &session) {
    if (!is_detached() || !current(session)) return;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (!session->routes.empty() || session->admitting) return;
    }
    if (!session->transport->private_keys_closed() || !session->transport->captures_closed()) return;
    session->transport->retire();
    session->retired = true;
    sessions.erase(session->id);
    release_detached_state_if_empty();
  }





  void drain(const std::shared_ptr<Session> &session) {
    require_owner();
    if (!current(session)) return;
    for (;;) {
      std::shared_ptr<Route> route;
      {
        std::lock_guard<std::mutex> guard(session->lock);
        for (auto found = session->routes.begin(); found != session->routes.end(); ++found) {
          if (!found->second->completed || found->second->accepting) continue;
          route = found->second;
          session->routes.erase(found);
          break;
        }
      }
      if (!route) break;
      if (route->completion_identity_invalid)
        route->ready = failure(CITIZENSDK_ERROR_INTEGRITY, "Core completion identity disagrees", route->request);
      // 先在平台线程领取真实结果，再释放借用期；不能把裸result排入UI队列。
      if (route->projection && !is_detached()) {
        auto project = std::move(route->projection);
        try {
          auto value = project();
          if (route->request.method == Method::open_private_key || route->request.method == Method::reveal_private_key ||
              route->request.method == Method::close_private_key) validate_public_value(route->request.method, value);
          if (route->request.method == Method::reconcile_wallet_cleanup &&
              route->native_method == Method::get_wallet_state) {
            validate_public_value(Method::get_wallet_state, value);
            const auto &state = std::get<Value::List>(std::get<Value::List>(value.data)[0].data);
            value = Value::list({state[1]});
          }
          route->ready = success(route->request, std::move(value));
        } catch (const ContractFailure &error) {
          route->ready = failure(error.code, error.what(), route->request, error.stage);
        } catch (const Error &error) {
          route->ready = failure(error.code(), error.what(), route->request, error.stage());
        } catch (...) {
          route->ready = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK result projection failed", route->request);
        }
        // 真实result在progress_close之前归还；审阅资源另持有的所有权不在此处释放。
        project = {};
      } else {
        // 引擎已退出则不再领取或投影数据，只归还实际结果所有权。
        route->projection = {};
      }
      auto result = route->ready ? std::move(*route->ready)
          : failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK result copying failed", route->request);
      if (result.success && (route->native_method == Method::start ||
                             route->native_method == Method::stop)) {
        try { result = success(route->request, Value::list({lifecycle(session->transport->lifecycle_state())})); }
        catch (const ContractFailure &error) { result = failure(error.code, error.what(), route->request, error.stage); }
        catch (const Error &error) { result = failure(error.code(), error.what(), route->request, error.stage()); }
        catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK lifecycle query failed", route->request); }
      }
      if (!is_detached() && result.success && route->fetch_profile_after_mutation &&
          route->native_method != Method::get_wallet_state) {
        // 只有reconcile需把空控制终态映射为收敛后的可空profile。
        // 删除直接交付原空终态；rename/deleteAccount直接使用同次提交的目录，不多读一代事实。
        route->native_method = Method::get_wallet_state;
        route->native_id = 0;
        route->terminal_seen = false;
        route->completed = false;
        route->ready.reset();
        {
          std::lock_guard<std::mutex> guard(session->lock);
          session->routes.emplace(route->request.sequence, route);
        }
        try { submit(session, route); }
        catch (const ContractFailure &error) {
          settle_launch_failure(session, route, error.code, error.what(), error.stage);
        } catch (const Error &error) {
          settle_launch_failure(session, route, error.code(), error.what(), error.stage());
        } catch (...) {
          settle_launch_failure(session, route, CITIZENSDK_ERROR_INTERNAL,
                                "CitizenSDK wallet profile query failed");
        }
        continue;
      }
      const bool mutation_finished = route->mutation;
      // Release the process gate before exposing terminal completion. A
      // reentrant Flutter reply may immediately begin the next mutation, but
      // never during the canonical Core/Win32/profile chain above.
      if (mutation_finished) finish_mutation(route);
      if (route->close_stop) {
        if (!result.success) close_failed(session, result.error_code, result.message);
      } else if (!is_detached() && route->reply) {
        auto reply = std::move(route->reply);
        // Removal above is the linearization point; a reply may reenter close.
        reply(std::move(result));
      }
    }
    if (is_detached()) {
      retire_detached_session_if_idle(session);
      return;
    }
    if (session->closing) progress_close(session);
  }

  void close_failed(const std::shared_ptr<Session> &session,
                    citizensdk_error_code_t code, const std::string &message) {
    if (!session->close_request) return;
    auto request = std::move(*session->close_request);
    auto reply = std::move(session->close_reply);
    session->close_request.reset();
    session->closing = false;
    if (!is_detached() && reply) reply(failure(code, message, request));
  }

  void progress_close(const std::shared_ptr<Session> &session) {
    if (!current(session) || !session->closing || !session->close_request) return;
    try { cancel_credentials(session); session->transport->close_private_keys(); session->transport->close_captures(); }
    catch (const Error &error) { close_failed(session, error.code(), error.what()); return; }
    catch (const ContractFailure &error) { close_failed(session, error.code, error.what()); return; }
    catch (...) { close_failed(session, CITIZENSDK_ERROR_INTERNAL, "Credential cancellation failed"); return; }

    {
      std::lock_guard<std::mutex> guard(session->lock);
      if (!session->routes.empty()) return;
    }
    if (!session->transport->private_keys_closed() || !session->transport->captures_closed()) return;
    try {
      const auto state = session->transport->lifecycle_state();
      if (state == CITIZENSDK_LIFECYCLE_RUNNING || state == CITIZENSDK_LIFECYCLE_STARTING ||
          state == CITIZENSDK_LIFECYCLE_IMPORTING_STATE) {
        auto route = std::make_shared<Route>();
        route->request = *session->close_request;
        route->native_method = Method::stop;
        route->close_stop = true;
        {
          std::lock_guard<std::mutex> guard(session->lock);
          session->routes.emplace(route->request.sequence, route);
        }
        submit(session, route);
        return;
      }
      // Host::close rejects still-live result/callback frames as BUSY. This is
      // retryable and retains all ownership; never report disposed beforehand.
      session->transport->close();
      session->retired = true;
      sessions.erase(session->id);
      auto request = std::move(*session->close_request);
      auto reply = std::move(session->close_reply);
      session->close_request.reset();
      if (!is_detached() && reply) reply(success(request, Value::list({Value::string("disposed")})));
    } catch (const ContractFailure &error) { close_failed(session, error.code, error.what()); }
    catch (const Error &error) { close_failed(session, error.code(), error.what()); }
    catch (...) { close_failed(session, CITIZENSDK_ERROR_INTERNAL, "CitizenSDK close failed"); }
  }

  void cancel_requests(const std::shared_ptr<Session> &session) {
    std::vector<citizensdk_request_id_t> ids;
    {
      std::lock_guard<std::mutex> guard(session->lock);
      for (const auto &entry : session->routes)
        if (!entry.second->terminal_seen && entry.second->native_id != 0)
          ids.push_back(entry.second->native_id);
    }
    // 快照后锁外请求取消，真实completion仍保有对应路由和所有权。
    for (const auto id : ids) (void)session->transport->cancel(id);
  }

  void begin_close(const std::shared_ptr<Session> &session,
                   const DecodedRequest &request, ReplyCallback reply) {
    try { cancel_credentials(session); }
    catch (const Error &error) { reply(failure(error.code(), error.what(), request, error.stage())); return; }
    catch (const ContractFailure &error) { reply(failure(error.code, error.what(), request, error.stage)); return; }
    catch (...) { reply(failure(CITIZENSDK_ERROR_INTERNAL, "Credential cancellation failed", request)); return; }

    session->closing = true;
    session->close_request = request;
    session->close_reply = std::move(reply);
    std::exception_ptr first;
    try { cancel_requests(session); } catch (...) { if (!first) first = std::current_exception(); }
    if (first) {
      try { std::rethrow_exception(first); }
      catch (const Error &error) { close_failed(session, error.code(), error.what()); }
      catch (...) { close_failed(session, CITIZENSDK_ERROR_INTERNAL, "CitizenSDK cancellation failed"); }
      return;
    }
    drain(session);
  }

  void accept_request_sequence(const RequestEnvelope &request) {
    require_owner();
    if (is_detached()) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter engine is detached",
                                            request.session, request.sequence);
    const auto found = sessions.find(request.session);
    if (found == sessions.end()) throw ContractFailure(CITIZENSDK_ERROR_NOT_FOUND, "CitizenSDK session was not found",
                                                       request.session, request.sequence);
    const auto session = found->second;
    if (session->closing) throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK session is closing",
                                                request.session, request.sequence);
    const auto code = session->transport->accept_request_sequence(static_cast<uint64_t>(request.sequence));
    if (code != CITIZENSDK_OK) throw ContractFailure(code, "CitizenSDK request sequence admission failed",
                                                    request.session, request.sequence);
  }

  void dispatch(DecodedRequest request, ReplyCallback reply) {
    require_owner();
    if (!reply) throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK reply is required");
    if (is_detached()) { reply(failure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter engine is detached", request)); return; }
    // 不创建或查找 session，不调用环境/Host 工厂，不打开钱包、金库或链。
    if (request.method == Method::encode_signing_payload) {
      std::optional<Reply> result;
      try {
        auto output = qr_core_output([&](uint8_t *target, uint64_t capacity, uint64_t *required) {
          return citizensdk_encode_signing_payload(request.payload_kind, view(request.input_json),
              view(request.payload), target, capacity, required);
        }, 16 * 1024 * 1024);
        result = Reply{true, Value::list({Value::integer(kProtocolVersion), Value::bytes(std::move(output))}), CITIZENSDK_OK, {}};
      } catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "Payload encoding failed", request); }
      reply(std::move(*result));
      return;
    }
    if (request.method == Method::verify_signature) {
      uint8_t valid = 0;
      const auto code = citizensdk_verify_signature(
          &request.account_id, view(request.signature), view(request.payload), &valid);
      if (code != CITIZENSDK_OK) {
        reply(failure(code, "CitizenSDK signature verification failed", request));
      } else {
        reply({true, Value::list({Value::integer(kProtocolVersion),
                                 Value::boolean(valid != 0)}), CITIZENSDK_OK, {}});
      }
      return;
    }
    // A previous failed main-loop allocation may have left a copied completion
    // ready. Retry ownership settlement before admitting another request.
    std::vector<std::shared_ptr<Session>> existing;
    for (const auto &pair : sessions) existing.push_back(pair.second);
    for (const auto &session : existing) drain(session);
    if (request.method == Method::open) { open(std::move(request), std::move(reply)); return; }
    const auto found = sessions.find(request.session);
    if (found == sessions.end()) { reply(failure(CITIZENSDK_ERROR_NOT_FOUND, "CitizenSDK session was not found", request)); return; }
    const auto session = found->second;
    if (session->closing) {
      reply(failure(CITIZENSDK_ERROR_INVALID_STATE, "CitizenSDK session is closing", request)); return;
    }
    if (request.method == Method::respond_credential || request.method == Method::cancel_credential) {
      std::optional<Reply> result;
      try {
        {
          std::lock_guard<std::mutex> guard(session->lock);
          if (session->credentials.find(request.host_operation_id) == session->credentials.end())
            throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE, "Credential challenge is not active");
        }
        if (request.method == Method::cancel_credential)
          session->transport->cancel_credential(request.host_operation_id);
        CredentialValue credential_value;
        if (request.method == Method::respond_credential && request.credential)
          credential_value = std::move(request.credential->value);
        if (!settle_credential(session, request.host_operation_id, std::move(credential_value)) &&
            request.method != Method::cancel_credential)
          throw ContractFailure(CITIZENSDK_ERROR_INVALID_STATE, "Credential challenge was revoked");
        result = success(request, Value::list({}));
      } catch (const ContractFailure &error) {
        result = failure(error.code, error.what(), request, error.stage);
      } catch (const Error &error) {
        result = failure(error.code(), error.what(), request, error.stage());
      } catch (...) {
        result = failure(CITIZENSDK_ERROR_INTERNAL, "Credential response failed", request);
      }
      reply(std::move(*result));
      return;
    }
    if (request.method == Method::cancel_operation) {
      std::optional<Reply> result;
      try {
        uint64_t sequence = 0;
        const auto &id = request.resource_id;
        const auto parsed = std::from_chars(id.data(), id.data() + id.size(), sequence);
        if (id.empty() || id.front() == '0' || parsed.ec != std::errc{} ||
            parsed.ptr != id.data() + id.size() || sequence == 0)
          throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "Operation identity is invalid");
        citizensdk_request_id_t native = 0;
        {
          std::lock_guard<std::mutex> guard(session->lock);
          if (sequence <= static_cast<uint64_t>(INT64_MAX)) {
            const auto found = session->routes.find(static_cast<int64_t>(sequence));
            if (found != session->routes.end() && !found->second->terminal_seen)
              native = found->second->native_id;
          }
        }
        const bool accepted = native != 0 && session->transport->cancel(native);
        result = success(request, Value::list({Value::boolean(accepted)}));
      } catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "Operation cancellation failed", request); }
      reply(std::move(*result)); return;
    }
    if (request.method == Method::validate_wallet_password || request.method == Method::validate_wallet_mnemonic ||
        request.method == Method::wallet_word_suggestions || request.method == Method::copy_recovery_phrase ||
        request.method == Method::release_prepared_wallet || request.method == Method::release_qr_review ||
        request.method == Method::release_wallet_inspection) {
      std::optional<Reply> result;
      try {
        auto value = session->transport->control(request);
        validate_public_value(request.method, value);
        result = success(request, std::move(value));
      } catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "Wallet input or resource control failed", request); }
      request.mnemonic.reset(); request.password.reset();
      reply(std::move(*result)); return;
    }
    if (request.method == Method::close) { begin_close(session, request, std::move(reply)); return; }
    if ((request.method >= Method::qr_parse && request.method <= Method::qr_encode) ||
        request.method == Method::qr_validate_sign_response || request.method == Method::qr_encode_document || request.method == Method::qr_prepare_account_authorization) {
      std::optional<Reply> result;
      try { result = success(request, session->transport->qr(request)); }
      catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK QR operation failed", request); }
      reply(std::move(*result));
      return;
    }
    if (request.method == Method::get_genesis_hash) {
      std::optional<Reply> result;
      try { result = success(request, Value::list({session->transport->genesis_hash()})); }
      catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK genesis query failed", request); }
      reply(std::move(*result));
      return;
    }
    if (request.method == Method::cancel_signing) {
      std::optional<Reply> result;
      try { result = success(request, session->transport->cancel_signing(request)); }
      catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK signing cancellation failed", request); }
      reply(std::move(*result));
      return;
    }
    if (request.method == Method::cancel_prepared_transaction) {
      std::optional<Reply> result;
      try { result = success(request, session->transport->cancel_prepared_transaction(request)); }
      catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL,
                                     "CitizenSDK transaction cancellation failed", request); }
      reply(std::move(*result));
      return;
    }
    if (request.method == Method::cancel_prepared_transaction_execution) {
      std::optional<Reply> result;
      try { result = success(request, session->transport->cancel_transaction_execution(request)); }
      catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL,
                                     "CitizenSDK transaction execution cancellation failed",
                                     request); }
      reply(std::move(*result));
      return;
    }
    if (request.method == Method::get_capabilities) {
      std::optional<Reply> result;
      try { result = success(request, Value::list({session->transport->capability_snapshot()})); }
      catch (const ContractFailure &error) { result = failure(error.code, error.what(), request, error.stage); }
      catch (const Error &error) { result = failure(error.code(), error.what(), request, error.stage()); }
      catch (...) { result = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK capability query failed", request); }
      // messenger 的回调不属于 native 查询错误域；回调抛错不能被捕获后第二次回复。
      reply(std::move(*result));
      return;
    }
    auto route = std::make_shared<Route>();
    route->request = std::move(request);
    route->native_method = route->request.method;
    route->reply = std::move(reply);
    route->fetch_profile_after_mutation = needs_profile_read(route->request.method);
    {
      std::lock_guard<std::mutex> guard(session->lock);
      session->routes.emplace(route->request.sequence, route);
    }
    try {
      if (route->request.method == Method::open_private_key || route->request.method == Method::reveal_private_key ||
          route->request.method == Method::close_private_key || route->request.method == Method::open_qr_capture ||
          route->request.method == Method::close_qr_capture || route->request.method == Method::pause_qr_capture ||
          route->request.method == Method::resume_qr_capture || route->request.method == Method::set_qr_capture_torch ||
          route->request.method == Method::qr_decode_image) resource_operation(session, route);
      else if (is_mutation(route->request.method)) begin_mutation(session, route);
      else submit(session, route);
    } catch (const ContractFailure &error) {
      {
        std::lock_guard<std::mutex> guard(session->lock);
        route->completed = true; route->ready = failure(error.code, error.what(), route->request, error.stage);
      }
      drain(session);
    } catch (const Error &error) {
      {
        std::lock_guard<std::mutex> guard(session->lock);
        route->completed = true; route->ready = failure(error.code(), error.what(), route->request, error.stage());
      }
      drain(session);
    } catch (...) {
      {
        std::lock_guard<std::mutex> guard(session->lock);
        route->completed = true;
        route->ready = failure(CITIZENSDK_ERROR_INTERNAL, "CitizenSDK request dispatch failed", route->request);
      }
      drain(session);
    }
  }

  void listen(EventSink value) {
    require_owner();
    if (is_detached()) throw ContractFailure(CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK Flutter engine is detached");
    if (!value) throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK event sink is required");
    if (sink) throw ContractFailure(CITIZENSDK_ERROR_BUSY, "CitizenSDK event subscription is already active");
    advance_epoch(); sink = std::move(value);
    std::vector<std::shared_ptr<Session>> current_sessions;
    for (const auto &pair : sessions) current_sessions.push_back(pair.second);
    const auto expected = snapshot_epoch();
    for (const auto &session : current_sessions) {
      try { snapshots(session, expected); } catch (...) {}
    }
  }
  void cancel_events() {
    require_owner();
    if (is_detached()) { sink = {}; return; }
    advance_epoch(); sink = {};
    // 失去唯一凭据回包通道后撤销本实例实际挑战，不能无限保留一个不可见等待。
    for (const auto &entry : sessions) cancel_credentials(entry.second);
  }

  void detach() noexcept {
    // This method is called synchronously by plugin dispose on its owner
    // thread, before messenger handles are retired. Host callbacks never wait
    // for this UI thread, so Host's callback barrier cannot deadlock it.
    try { advance_epoch(true); } catch (...) {}
    sink = {};
    if (!sessions.empty()) retain_detached_state();
    for (auto found = sessions.begin(); found != sessions.end();) {
      const auto session = (found++)->second;
      session->closing = true;
      session->close_reply = {};
      try { cancel_credentials(session); } catch (...) {}
      try { session->transport->close_private_keys(); } catch (...) {}
      try { session->transport->close_captures(); } catch (...) {}
      try { cancel_requests(session); } catch (...) {}
      {
        std::lock_guard<std::mutex> guard(session->lock);
        for (auto &route_pair : session->routes) route_pair.second->reply = {};
      }
      try { drain(session); } catch (...) {}
    }
    release_detached_state_if_empty();
  }
};

Sessions::Sessions(std::shared_ptr<State> state) : state_(std::move(state)) {}
std::shared_ptr<Sessions> Sessions::create(EnvironmentFactory environment,
                                          Scheduler scheduler, TransportFactory factory, TextureFactory textures) {
  if (!environment || !scheduler)
    throw ContractFailure(CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK environment and scheduler are required");
  if (!factory) factory = [scheduler, textures = std::move(textures)](const Config &config) {
    return std::make_shared<HostTransport>(config, scheduler, textures);
  };
  return std::shared_ptr<Sessions>(new Sessions(
      std::make_shared<State>(std::move(environment), std::move(scheduler), std::move(factory))));
}
Sessions::~Sessions() { state_->detach(); }
void Sessions::accept_request_sequence(const RequestEnvelope &request) { state_->accept_request_sequence(request); }
void Sessions::dispatch(DecodedRequest request, ReplyCallback reply) { state_->dispatch(std::move(request), std::move(reply)); }
void Sessions::listen(EventSink sink) { state_->listen(std::move(sink)); }
void Sessions::cancel_events() { state_->cancel_events(); }
void Sessions::detach() noexcept { state_->detach(); }
std::size_t Sessions::session_count() const { state_->require_owner(); return state_->sessions.size(); }

}  // namespace citizen_sdk::flutter
