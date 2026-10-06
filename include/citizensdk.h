#ifndef CITIZENSDK_H
#define CITIZENSDK_H

#include "citizensdk_types.h"

#if defined(_WIN32) && defined(CITIZENSDK_SHARED)
#if defined(CITIZENSDK_BUILDING)
#define CITIZENSDK_API __declspec(dllexport)
#else
#define CITIZENSDK_API __declspec(dllimport)
#endif
#else
#define CITIZENSDK_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

CITIZENSDK_API uint32_t citizensdk_abi_version(void);
CITIZENSDK_API uint32_t citizensdk_create_options_size(void);

/* Pure preflight. Rejects empty/unknown masks, missing chain dependencies and
 * modules excluded from this build, before hosts create any device resources. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_validate_modules(uint32_t modules);

/* 各平台共用每实例唯一通道序号：先验外壳并调用一次，再解方法参数。
 * 参数错误不回退已接纳序号；非法、重复、跳号、关闭及耗尽仍拒绝。
 * 不分配Core request_id，不创建请求/结果，不触发业务、设备或网络操作。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_accept_request_sequence(
    citizensdk_handle_t handle, uint64_t request_sequence);

/* One composition path for full and selected modules. Existing ABI v1 structures
 * are unchanged. Chain assets are required only when CHAIN is selected and must
 * be empty otherwise. host_services may be NULL for public chain-only use.
 * WALLET or SIGNING requires secure_store + secret_vault; HISTORY requires its
 * typed public-store callbacks. Each public callback group is all-or-none.
 * Vtables are copied; contexts live through successful destroy. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_create_with_modules(
    const citizensdk_create_options_t *options,
    const citizensdk_host_services_v1_t *host_services, uint32_t modules,
    citizensdk_handle_t *out_handle);

/* Stateless sr25519 verification: no instance, wallet, vault or chain. The
 * account is 32 bytes, signature exactly 64 bytes and message at most 16 MiB.
 * On OK out_valid is 0 or 1; malformed encodings return INVALID_ARGUMENT.
 * No output is written on error. Excluded signing builds return UNSUPPORTED. */
/* 纯载荷编码：kind 1=消息摘要、2=二进制前缀、3=管理员激活、4=管理员解密、
 * 5=SCALE字符串、6=u64小端。fields_json最多4096字节，大载荷单独传入。
 * 无实例、无设备认证；buffer=NULL/capacity=0仅查询长度，不输出秘密。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_encode_signing_payload(
    uint32_t payload_kind, citizensdk_bytes_view_t fields_json,
    citizensdk_bytes_view_t payload_bytes, uint8_t *buffer, uint64_t capacity,
    uint64_t *out_required);

CITIZENSDK_API citizensdk_error_code_t citizensdk_verify_signature(
    const citizensdk_account_id_t *account_id,
    citizensdk_bytes_view_t signature, citizensdk_bytes_view_t message,
    uint8_t *out_valid);

/* QR-only instances initialize no wallet, vault, chain or light node. All QR
 * text is strict UTF-8 QR_V1; query variable output with NULL/0. The image
 * codec is the separate citizensdk_qr_image API and always uses ZXing-C++.
 * Parsing returns the Core's expanded JSON, including canonical_text and kind.
 * The SDK owns expiry time. No platform decodes QR_V1 wire fields itself.
 * QR_V1码型及用途允许集由Core唯一解释；冷导入只允许账户码，
 * 用户与转账码型按各自用途保留；码型只允许1至5，用途只允许1至5、7、8。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_qr_parse(
    citizensdk_handle_t handle, citizensdk_bytes_view_t text,
    uint8_t *output, uint64_t output_capacity, uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t citizensdk_qr_create_sign_request(
    citizensdk_handle_t handle, uint16_t action,
    const citizensdk_account_id_t *signer_account_id,
    citizensdk_bytes_view_t review_payload, uint64_t ttl_seconds,
    uint8_t *output, uint64_t output_capacity, uint64_t *out_required);
/* Review requires QR+CHAIN and a ready, explicitly started verified chain.
 * It yields QR_REVIEW through the ordinary request/result lifecycle. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_review_qr_sign_request(
    citizensdk_handle_t handle, citizensdk_bytes_view_t sign_request,
    citizensdk_request_id_t *out_request_id);
/* 宿主App展示Core审阅事实并取得明确确认后调用；SDK不提供审阅界面。
 * The same
 * instance's immutable review result is single-use; QR+SIGNING+CHAIN required.
 * Keep review_result alive until this call returns. Cancellation drains real
 * device authentication before completion and never emits a late signature. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_sign_qr_request(
    citizensdk_handle_t handle, citizensdk_result_handle_t review_result,
    citizensdk_request_id_t *out_request_id);
/* QR_REVIEW/QR_SIGNED expanded JSON, bounded and secret-free. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_copy_qr(
    citizensdk_result_handle_t result,
    uint8_t *output, uint64_t output_capacity, uint64_t *out_required);
/* Pure verification needs QR only. Writes exactly 64 bytes only after the
 * response binds to this instance's request and atomically consumes it. */
/* 只验签同实例真实会话，不消费、不提交；后续消费仍复核全部条件。 */
CITIZENSDK_API int32_t citizensdk_qr_validate_sign_response(
    citizensdk_handle_t handle, citizensdk_bytes_view_t session_id,
    citizensdk_bytes_view_t sign_response);
CITIZENSDK_API citizensdk_error_code_t citizensdk_qr_consume_sign_response(
    citizensdk_handle_t handle, citizensdk_bytes_view_t sign_response,
    uint8_t *out_signature);
CITIZENSDK_API citizensdk_error_code_t citizensdk_qr_cancel_sign_request(
    citizensdk_handle_t handle, citizensdk_bytes_view_t request_id,
    uint8_t *out_cancelled);
CITIZENSDK_API citizensdk_error_code_t citizensdk_qr_encode_document(
    citizensdk_handle_t handle, citizensdk_bytes_view_t input_json,
    uint8_t *buffer, uint64_t capacity, uint64_t *out_required);
/* 原授权模板准备结果含reason及公开事实；不代表链上资格或签名授权成功。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_qr_prepare_account_authorization(
    citizensdk_handle_t handle, uint32_t action, citizensdk_bytes_view_t payload,
    citizensdk_bytes_view_t account_id_utf8, uint8_t *buffer, uint64_t capacity,
    uint64_t *out_required);

CITIZENSDK_API citizensdk_error_code_t citizensdk_qr_encode_account_id(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    uint8_t *output, uint64_t output_capacity, uint64_t *out_required);
/* All input views are copied before return. Empty system_name/system_version
 * select CitizenSDK/1.0.0 defaults. The three verified chain assets are
 * mandatory and are revalidated before a smoldot provider is constructed. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_create(const citizensdk_create_options_t *options,
                  citizensdk_handle_t *out_handle);

/* 默认耐久组合：提供安全组时选择完整模块，否则选择链／交易／历史。
 * 显式按需集成使用 create_with_modules；两者进入同一内部装配。
 * CitizenSDK copies all supplied vtables; secure_store and secret_vault are
 * all-or-none. Host-owned contexts live through successful destroy. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_create_with_host(
    const citizensdk_create_options_t *options,
    const citizensdk_host_services_v1_t *host_services,
    citizensdk_handle_t *out_handle);

/* Destroy rejects outstanding requests/results and calls from the instance's
 * own callback with BUSY before teardown, leaving the handle usable. If a live
 * handle returns another error after teardown begins, it is teardown-only:
 * issue no new requests/callback changes/subscriptions and retry destroy.
 * Success guarantees no later callback. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_destroy(citizensdk_handle_t handle);

/* Callback execution uses one dedicated dispatch thread. Replacement waits
 * for an old callback to return; queued old-generation events never use the
 * new context. Clear only after capability unsubscription and after releasing
 * every result. Request acceptance and callback control are linearized; a
 * conflicting transition returns BUSY. Registration is the commit point and
 * its immediate state notifications are best-effort/queryable synchronously.
 * HISTORY_CHANGED (5) is a payloadless history invalidation from SDK-owned
 * transaction execution monitoring; read the history API for the latest snapshot.
 * It carries only sequence; request_id/result/capability_revision/reserved are
 * zero. Stop drains the monitor, pending host writes and owned subscriptions
 * before removing the provider. The event pointer is valid only during the callback. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_set_event_callback(
    citizensdk_handle_t handle, citizensdk_event_callback_t callback,
    void *context);

CITIZENSDK_API citizensdk_error_code_t citizensdk_get_capabilities(
    citizensdk_handle_t handle,
    citizensdk_capability_snapshot_t *out_snapshot);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_get_lifecycle(citizensdk_handle_t handle,
                         citizensdk_lifecycle_t *out_lifecycle);
/* Subscribe and unsubscribe publish/join through the bounded event path.
 * Calling either from inside that instance's callback returns BUSY before
 * changing monitor state; perform the control call after callback return.
 * Monitor installation/removal is linearized with callback control, request
 * acceptance and destroy. Initial capability publication is best-effort. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_subscribe_capability_changes(citizensdk_handle_t handle);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_unsubscribe_capability_changes(citizensdk_handle_t handle);

/* Accepted asynchronous requests return exactly one REQUEST_COMPLETED event.
 * The callback may race with and run before the accepting function returns;
 * route by event.request_id and do not rely on out_request_id being observed
 * first. Acceptance pre-reserves its event capacity and unique nonzero result
 * handle; monotonic-space exhaustion fails before a request ID is returned.
 * Every completion event.result must be inspected and released once. Raw
 * extrinsic watch and prepared-transaction execution are cancellable after
 * acceptance; cancel on other state-mutating or atomic requests returns
 * UNSUPPORTED, so it never falsely promises rollback. Execution cancellation
 * is cooperative: REQUEST_COMPLETED waits for any already-entered
 * host store/CAS or vault operation to return. Cancellation is not withdrawal
 * and never clears a durable Pending/InBlock or proven execution record. */
/* For instances with persistent host chain storage, start restores the database
 * before provider start. Stop first persists an exact revisioned snapshot;
 * persistence failure leaves unsubscribe/services/provider untouched. The
 * session-only store uses explicit import/export. Persistent host start,
 * stop and import use exclusive request admission: prior requests must finish,
 * and later requests, controls and destroy return BUSY through completion. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_start(citizensdk_handle_t handle,
                 citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_stop(citizensdk_handle_t handle,
                citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_cancel_request(citizensdk_handle_t handle,
                          citizensdk_request_id_t request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_refresh_capabilities(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);

CITIZENSDK_API citizensdk_error_code_t citizensdk_get_best_head(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_finalized_head(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
/* One typed smoldot snapshot; is_usable is authoritative. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_sync_status(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_finalized_block_at(
    citizensdk_handle_t handle, uint64_t number,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_resolve_finalized_block(
    citizensdk_handle_t handle, const uint8_t *hash_32, uint64_t number,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_block_header_at(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_block_body_at(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    citizensdk_request_id_t *out_request_id);
/* Protocol-level raw System.Events; finalized blocks only. Event interpretation
 * and product semantics remain the integrating application's responsibility. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_system_events_at(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_storage_at(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    citizensdk_bytes_view_t key, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_storage_batch_at(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    const citizensdk_bytes_view_t *keys, uint32_t key_count,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_storage_keys_paged(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *finalized_block,
    citizensdk_bytes_view_t prefix, uint8_t has_start_key,
    citizensdk_bytes_view_t start_key, uint32_t limit,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_call_runtime_api(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    citizensdk_bytes_view_t method, citizensdk_bytes_view_t arguments,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_runtime_context_at(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    citizensdk_request_id_t *out_request_id);

/* Typed public account state. Nonce is exact-best Runtime state, not a
 * transaction-pool lease. The retained fee snapshot can be reused with
 * citizensdk_result_estimate_fee for the SDK's exact rounding semantics. */
/* 固定链身份：同步写入 32 字节；要求 chain 已编译且已选择，不要求启动/联网。
 * out_genesis_hash 不可为 NULL；调用期间不得并发销毁实例。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_genesis_hash(
    citizensdk_handle_t handle, uint8_t *out_genesis_hash);
/* 接受 0..1990 项，保留输入顺序和重复项，全部余额绑定同一 finalized 块。
 * account_count 为 0 时 account_ids 可为 NULL；仍校验模块/生命周期，零存储读取。
 * 非空数组在受理前复制；错误不产生部分余额。有限请求不支持取消，销毁前必须排空。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_finalized_account_balances(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_ids,
    uint32_t account_count, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_get_finalized_account_balance(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_account_nonce(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_best_fee_snapshot(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);

/* 无UI同步校验：input_kind为PASSWORD或MNEMONIC；密码的word_count须为0，
 * 助记词须为12/18/24。校验无效也返回OK与原因/位置；ABI参数错误返回错误码。
 * 输入最多1024字节，不保存或回显；position不适用时为UINT32_MAX。
 * out_validation须预置完整struct_size/abi_version。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_validate_wallet_input(
    uint32_t input_kind, citizensdk_bytes_view_t input,
    citizensdk_wallet_word_count_t word_count,
    citizensdk_wallet_input_validation_v1_t *out_validation);

/* 前缀仅接受小写 ASCII，空前缀返回空。最多六个官方词表候选，以 LF 分隔，
 * 无尾随 LF/NUL。NULL/0 查询字节数；容量不足仅写 out_required，不部分写。
 * 候选是公开词表内容，不是输入、助记词或规范化密码的回传。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_word_suggestions(
    citizensdk_bytes_view_t prefix, uint8_t *buffer, uint64_t capacity,
    uint64_t *out_required);

/* Wallet secret inputs are borrowed only for the accepting call and copied
 * immediately into Rust zeroizing buffers. They are raw UTF-8 bytes without a
 * NUL terminator. No mini-secret/private key or standalone signed extrinsic is
 * returned. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_wallet_profile(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
/* Unified secret-free hot/cold catalog. Accounts use one global order and its
 * first item is the default account. This version deliberately exposes no
 * unauthorised default-account mutation. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_wallet_state(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
/* 保留同实例成功WalletState为独立拥有的结果引用，仍用result_release释放。
 * SDK销毁前须释放；不重读数据库、不接受宿主构造的原记录。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_state_retain(
    citizensdk_handle_t handle, citizensdk_result_handle_t result,
    citizensdk_result_handle_t *out_retained_result);
/* 同次异常事实；out_info预置完整size/version。文本field仅1=钱包名、2=地址。
 * NULL/0查询长度；短缓冲、错误类型、越界均不修改任何输出。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_state_get_diagnostic_count(
    citizensdk_result_handle_t result, uint32_t *out_count);
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_state_get_diagnostic_at(
    citizensdk_result_handle_t result, uint32_t index,
    citizensdk_wallet_diagnostic_info_v1_t *out_info);
/* 只从同一快照的可信精确目标复制公开账户，错误或越界不改输出。
 * 不返回SecretRef或代际；该投影不是删除授权，实际操作仍复核原记录。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_state_get_diagnostic_cleanup_account(
    citizensdk_result_handle_t result, uint32_t index, uint32_t account_index,
    citizensdk_account_id_t *out_account_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_state_copy_diagnostic_text(
    citizensdk_result_handle_t result, uint32_t index, uint32_t field,
    uint8_t *buffer, uint64_t capacity, uint64_t *out_required);
/* 接纳时复制该真实快照中的异常记录，执行时复核修订及原字段。
 * 释放inspection不取消已接纳请求；热验证仍需真实签名/验签及设备认证。
 * 删除沿同一精确cleanup，不授权删除无法证明归属的秘密。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_repair_hot_wallet(
    citizensdk_handle_t handle, citizensdk_result_handle_t inspection,
    uint32_t wallet_index, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_rename_diagnostic_wallet(
    citizensdk_handle_t handle, citizensdk_result_handle_t inspection,
    uint32_t wallet_index, citizensdk_bytes_view_t name,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_delete_diagnostic_wallet(
    citizensdk_handle_t handle, citizensdk_result_handle_t inspection,
    uint32_t wallet_index, citizensdk_request_id_t *out_request_id);
/* 钱包级名称与付款选择共享目录CAS，不更改账户名、默认顺序或热当前账户。
 * expected_revision不匹配返回Conflict；两操作均不触发签名或金库查询。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_set_active_wallet(
    citizensdk_handle_t handle, uint64_t expected_revision, uint32_t wallet_index,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_rename_wallet(
    citizensdk_handle_t handle, uint64_t expected_revision, uint32_t wallet_index,
    citizensdk_bytes_view_t name, citizensdk_request_id_t *out_request_id);
/* 只读取同一结果，不二次查库；无选择为present=0/index=0；无热钱包名为零长。
 * 全部输出先校验，失败不部分写入；copy_name支持buffer=NULL/capacity=0长度查询。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_state_get_active_wallet(
    citizensdk_result_handle_t result, uint8_t *out_present, uint32_t *out_wallet_index);
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_profile_copy_name(
    citizensdk_result_handle_t result, uint8_t *buffer, uint64_t capacity, uint64_t *out_required);
/* 在该实例首次Host操作前一次登记；拒绝替换或关闭期间登记。
 * provider及两回调非空，结构大小必须准确；代码/context保有至真实SDK销毁。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_set_secret_presence_provider(
    citizensdk_handle_t handle, const citizensdk_host_secret_presence_v1_t *provider);
/* 无实例纯投影：完整校验有界CSHR/身份/状态及存储revision。
 * 只有匹配账户的sealed记录返回1；有效其它记录为0，失败不改输出。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_encrypted_secret_record_has_secret(
    const citizensdk_account_id_t *account_id, uint64_t expected_revision,
    citizensdk_bytes_view_t record, uint8_t *out_present);

/* open只接纳资源；reveal在真实授权后最多交付一次。
 * cancel撤销迟到交付；finish在宿主清屏/清理副本后请求关闭。
 * 普通request只有在finish及准备/认证/回调均排空后结束，不能提前释放context。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_private_key_open(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    const citizensdk_private_key_receiver_v1_t *receiver,
    uint64_t *out_secret_id, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_private_key_reveal(
    citizensdk_handle_t handle, uint64_t secret_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_private_key_cancel(
    citizensdk_handle_t handle, uint64_t secret_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_private_key_finish(
    citizensdk_handle_t handle, uint64_t secret_id);
/* 同一result中的初始化事实：EMPTY=0、READY=1、RECOVERING=2。
 * cleanup_pending为0/1；错误不写输出，不扩长原wallet_state_info结构。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_wallet_state_get_initialization(
    citizensdk_result_handle_t result, uint32_t *out_initialization_state,
    uint8_t *out_cleanup_pending);
CITIZENSDK_API citizensdk_error_code_t citizensdk_import_cold_account_id(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_bytes_view_t name, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_import_cold_account_ss58(
    citizensdk_handle_t handle, citizensdk_bytes_view_t ss58_address,
    citizensdk_bytes_view_t name, citizensdk_request_id_t *out_request_id);
/* Optimistic concurrency and the unchanged-first-item rule close the ordinary
 * reorder path against stale writes and default-account changes. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_reorder_wallet_accounts_without_default_change(
    citizensdk_handle_t handle, uint64_t expected_revision,
    const citizensdk_account_id_t *account_ids, uint32_t account_count,
    citizensdk_request_id_t *out_request_id);
/* Product-independent signing. payload/domain are opaque bytes; action is
 * carried only by QR_V1 and is never interpreted or allowlisted by Core. The
 * persisted wallet catalog selects hot Vault signing or a cold external
 * session. TTL is 1..300 seconds. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_begin_signing(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_bytes_view_t payload, citizensdk_signing_transform_t transform,
    citizensdk_bytes_view_t domain,
    citizensdk_external_signer_transport_t external_signer_transport,
    uint16_t opaque_action, uint64_t ttl_seconds,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_consume_external_signature(
    citizensdk_handle_t handle, citizensdk_bytes_view_t session_id,
    citizensdk_bytes_view_t response,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_cancel_signing_session(
    citizensdk_handle_t handle, citizensdk_bytes_view_t session_id,
    uint8_t *out_cancelled);
/* Default-account changes are SDK wallet mutations. The old default signs the
 * full permutation; callers cannot inject the signer, action, payload or a raw
 * default setter. Cold mode uses the existing independent CitizenWallet's
 * QR_V1 action 12 adapter. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_begin_default_account_change(
    citizensdk_handle_t handle, uint64_t expected_revision,
    const citizensdk_account_id_t *account_ids, uint32_t account_count,
    uint64_t ttl_seconds, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_consume_default_account_change(
    citizensdk_handle_t handle, citizensdk_bytes_view_t session_id,
    citizensdk_bytes_view_t response,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_rename_account(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_bytes_view_t name, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_delete_account(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_prepare_wallet_creation(
    citizensdk_handle_t handle, citizensdk_wallet_word_count_t word_count,
    citizensdk_bytes_view_t password,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_prepared_wallet_copy_mnemonic(
    citizensdk_handle_t handle,
    citizensdk_prepared_wallet_handle_t prepared_wallet, uint8_t *buffer,
    uint64_t capacity, uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t citizensdk_prepared_wallet_release(
    citizensdk_handle_t handle,
    citizensdk_prepared_wallet_handle_t prepared_wallet);
CITIZENSDK_API citizensdk_error_code_t citizensdk_commit_wallet_creation(
    citizensdk_handle_t handle,
    citizensdk_prepared_wallet_handle_t prepared_wallet,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_import_wallet(
    citizensdk_handle_t handle, citizensdk_bytes_view_t mnemonic,
    citizensdk_bytes_view_t password,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_add_wallet_accounts(
    citizensdk_handle_t handle, citizensdk_bytes_view_t mnemonic,
    citizensdk_bytes_view_t password, const uint32_t *indices,
    uint32_t index_count, citizensdk_request_id_t *out_request_id);
/* 显式下一编号与指定追加均返回本次提交的WALLET_PROFILE，不能用空indices表示。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_add_next_wallet_account(
    citizensdk_handle_t handle, citizensdk_bytes_view_t mnemonic,
    citizensdk_bytes_view_t password, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_set_active_wallet_account(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_rename_wallet_account(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_bytes_view_t name,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_delete_wallet_account(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_delete_wallet(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
/* 签名删除在同一钱包代际内完成认证/签名/验签；不改变原delete擦除入口。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_sign_and_delete_wallet(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_reconcile_wallet_cleanup(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_sign_wallet_payload(
    citizensdk_handle_t handle, const citizensdk_account_id_t *account_id,
    citizensdk_bytes_view_t message,
    citizensdk_request_id_t *out_request_id);

/* Product-independent transaction preparation. call_data is one complete canonical opaque SCALE
 * RuntimeCall of 1..1MiB. Core reads the exact best runtime and source nonce; callers cannot
 * provide nonce, era, tip, signer bytes, an options object, or an application action. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_prepare_transaction(
    citizensdk_handle_t handle,
    const citizensdk_account_id_t *source_account_id,
    citizensdk_bytes_view_t call_data,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_prepared_transaction_release(
    citizensdk_handle_t handle,
    citizensdk_prepared_transaction_handle_t prepared_transaction);
CITIZENSDK_API citizensdk_error_code_t citizensdk_execute_prepared_transaction(
    citizensdk_handle_t handle,
    citizensdk_prepared_transaction_handle_t prepared_transaction,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_transaction_execution_consume_qr_response(
    citizensdk_handle_t handle,
    const citizensdk_transaction_execution_id_t *execution_id,
    citizensdk_bytes_view_t response,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_transaction_execution_cancel(
    citizensdk_handle_t handle,
    const citizensdk_transaction_execution_id_t *execution_id);

/* Reads only SDK-submitted generic transaction facts. Applications keep
 * destination, amount, remark, direction and pallet/event projections. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_get_transaction_history(
    citizensdk_handle_t handle,
    const citizensdk_transaction_execution_id_t *before_execution_id,
    uint32_t limit, citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_sync_transaction_history(
    citizensdk_handle_t handle, citizensdk_request_id_t *out_request_id);

CITIZENSDK_API citizensdk_error_code_t citizensdk_submit_extrinsic(
    citizensdk_handle_t handle, citizensdk_bytes_view_t signed_extrinsic,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_watch_extrinsic(
    citizensdk_handle_t handle, citizensdk_bytes_view_t signed_extrinsic,
    citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_verify_transaction_at(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *block,
    citizensdk_bytes_view_t signed_extrinsic, const uint8_t *submitted_hash_32,
    citizensdk_request_id_t *out_request_id);

/* Host-backed export persists the same stable snapshot before completion;
 * legacy session export remains non-durable. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_export_state(citizensdk_handle_t handle,
                        citizensdk_request_id_t *out_request_id);
CITIZENSDK_API citizensdk_error_code_t citizensdk_import_state(
    citizensdk_handle_t handle, const citizensdk_block_ref_t *finalized,
    uint32_t format_version, citizensdk_bytes_view_t database,
    citizensdk_request_id_t *out_request_id);

CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_info(
    citizensdk_result_handle_t result, citizensdk_result_info_t *out_info);
/* Available only for a ready failed result; success and released handles are rejected. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_failure_stage(
    citizensdk_result_handle_t result, citizensdk_failure_stage_t *out_stage);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_copy_error_message(citizensdk_result_handle_t result,
                                     uint8_t *buffer, uint64_t capacity,
                                     uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_block_ref(
    citizensdk_result_handle_t result, citizensdk_block_ref_t *out_block);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_sync_status(
    citizensdk_result_handle_t result,
    citizensdk_chain_sync_status_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_block_header(
    citizensdk_result_handle_t result, citizensdk_block_header_info_t *out_info,
    uint8_t *digest_buffer, uint64_t digest_capacity,
    uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_block_body_info(
    citizensdk_result_handle_t result, citizensdk_block_body_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_copy_block_body_extrinsic(
    citizensdk_result_handle_t result, uint32_t index, uint8_t *buffer,
    uint64_t capacity, uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_copy_storage(
    citizensdk_result_handle_t result, uint8_t *out_present, uint8_t *buffer,
    uint64_t capacity, uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_storage_batch_count(citizensdk_result_handle_t result,
                                          uint32_t *out_count);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_copy_storage_batch_item(citizensdk_result_handle_t result,
                                          uint32_t index,
                                          uint8_t *out_present,
                                          uint8_t *buffer, uint64_t capacity,
                                          uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_runtime_context(
    citizensdk_result_handle_t result,
    citizensdk_runtime_context_info_t *out_info, uint8_t *metadata_buffer,
    uint64_t metadata_capacity, uint64_t *out_required);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_hash(citizensdk_result_handle_t result,
                           uint8_t *out_hash_32);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_execution(
    citizensdk_result_handle_t result, citizensdk_execution_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_watch_event(
    citizensdk_result_handle_t result, citizensdk_watch_event_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_exported_state(
    citizensdk_result_handle_t result,
    citizensdk_exported_state_info_t *out_info, uint8_t *database_buffer,
    uint64_t database_capacity, uint64_t *out_required);

CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_account_balance(
    citizensdk_result_handle_t result,
    citizensdk_account_balance_info_t *out_info);
/* 仅接受 ACCOUNT_BALANCES 结果；越界、错误结果或 ABI 前缀无效时不修改输出。 */
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_account_balance_count(
    citizensdk_result_handle_t result, uint32_t *out_count);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_account_balance_at(
    citizensdk_result_handle_t result, uint32_t index,
    citizensdk_account_balance_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_account_nonce(
    citizensdk_result_handle_t result,
    citizensdk_account_nonce_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_fee_snapshot(
    citizensdk_result_handle_t result,
    citizensdk_fee_snapshot_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_estimate_fee(
    citizensdk_result_handle_t result, citizensdk_u128_t amount_fen,
    citizensdk_u128_t *out_estimated_fee_fen,
    citizensdk_u128_t *out_minimum_self_pay_fen);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_wallet_profile(
    citizensdk_result_handle_t result,
    citizensdk_wallet_profile_info_t *out_info);
/* The profile getter also accepts WALLET_STATE and projects its optional hot
 * profile; state-account getters preserve the global hot/cold order. */
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_wallet_state(
    citizensdk_result_handle_t result,
    citizensdk_wallet_state_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_wallet_state_account(
    citizensdk_result_handle_t result, uint32_t index,
    citizensdk_wallet_state_account_info_t *out_info, uint8_t *ss58_buffer,
    uint64_t ss58_capacity, uint64_t *out_ss58_required,
    uint8_t *name_buffer, uint64_t name_capacity,
    uint64_t *out_name_required);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_signing_outcome(
    citizensdk_result_handle_t result,
    citizensdk_signing_outcome_info_t *out_info, uint8_t *signature_buffer,
    uint64_t signature_capacity, uint64_t *out_signature_required,
    uint8_t *session_id_buffer, uint64_t session_id_capacity,
    uint64_t *out_session_id_required, uint8_t *transport_request_buffer,
    uint64_t transport_request_capacity,
    uint64_t *out_transport_request_required);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_default_account_change(
    citizensdk_result_handle_t result,
    citizensdk_default_account_change_info_t *out_info,
    uint8_t *session_id_buffer, uint64_t session_id_capacity,
    uint64_t *out_session_id_required, uint8_t *transport_request_buffer,
    uint64_t transport_request_capacity,
    uint64_t *out_transport_request_required);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_wallet_account_count(citizensdk_result_handle_t result,
                                           uint32_t *out_count);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_wallet_account(
    citizensdk_result_handle_t result, uint32_t index,
    citizensdk_wallet_account_info_t *out_info, uint8_t *ss58_buffer,
    uint64_t ss58_capacity, uint64_t *out_ss58_required,
    uint8_t *name_buffer, uint64_t name_capacity,
    uint64_t *out_name_required);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_signature(
    citizensdk_result_handle_t result, uint8_t *out_signature_64);
CITIZENSDK_API citizensdk_error_code_t citizensdk_result_get_prepared_wallet(
    citizensdk_result_handle_t result,
    citizensdk_prepared_wallet_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_prepared_transaction(
    citizensdk_result_handle_t result,
    citizensdk_prepared_transaction_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_transaction_execution(
    citizensdk_result_handle_t result,
    citizensdk_transaction_execution_info_t *out_info,
    uint8_t *session_id_buffer, uint64_t session_id_capacity,
    uint64_t *out_session_id_required, uint8_t *transport_request_buffer,
    uint64_t transport_request_capacity,
    uint64_t *out_transport_request_required, uint8_t *reason_buffer,
    uint64_t reason_capacity, uint64_t *out_reason_required);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_transaction_history_page(
    citizensdk_result_handle_t result,
    citizensdk_transaction_history_page_info_t *out_info);
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_get_transaction_history_record(
    citizensdk_result_handle_t result, uint32_t index,
    citizensdk_transaction_history_record_info_t *out_info,
    uint8_t *reason_buffer, uint64_t reason_capacity,
    uint64_t *out_reason_required);

/* Double release is a stable INVALID_HANDLE error, not undefined behavior. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_result_release(citizensdk_result_handle_t result);

/* Synchronous-call diagnostic. Query with buffer=NULL/capacity=0 returns OK
 * after writing out_required. Copied UTF-8 bytes are not NUL-terminated. */
CITIZENSDK_API citizensdk_error_code_t
citizensdk_last_error_copy(uint8_t *buffer, uint64_t capacity,
                           uint64_t *out_required);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CITIZENSDK_H */
