#ifndef SMOLDOT_H
#define SMOLDOT_H

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * Opaque handle to a smoldot client
 */
typedef uint64_t SmoldotClientHandle;

/**
 * Opaque handle to a chain
 */
typedef uint64_t SmoldotChainHandle;

/**
 * Callback function type for async operations
 *
 * # Arguments
 * * `callback_id` - ID to match callback with request
 * * `result` - Result value (handle, string pointer, or 0 for error)
 * * `error` - Error message pointer (null if success)
 */
typedef void (*SmoldotDartCallback)(int64_t callback_id, int64_t result, const char *error);

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

/**
 * Initialize a new smoldot client
 *
 * # Safety
 * - `config_json` must be a valid null-terminated UTF-8 string
 * - Returns 0 on failure
 */
SmoldotClientHandle smoldot_client_init(const char *config_json, char **error_out);

/**
 * Add a chain to the client
 *
 * # Safety
 * - `client_handle` must be a valid handle returned from `smoldot_client_init`
 * - `chain_spec_json` must be a valid null-terminated UTF-8 string
 * - `callback` must be a valid function pointer
 */
int smoldot_add_chain(SmoldotClientHandle client_handle,
                      const char *chain_spec_json,
                      const SmoldotChainHandle *potential_relay_chains,
                      int relay_chains_count,
                      const char *database_content,
                      int64_t callback_id,
                      SmoldotDartCallback callback,
                      char **error_out);

/**
 * Send a JSON-RPC request to a chain
 *
 * # Safety
 * - `chain_handle` must be a valid handle
 * - `request_json` must be a valid null-terminated UTF-8 string
 */
int smoldot_send_json_rpc(SmoldotChainHandle chain_handle,
                          const char *request_json,
                          char **error_out);

/**
 * Get next JSON-RPC response from a chain (blocking)
 *
 * # Safety
 * - `chain_handle` must be a valid handle
 * - `callback` must be a valid function pointer
 * - Caller must free the returned string with `smoldot_free_string`
 */
int smoldot_next_json_rpc_response(SmoldotChainHandle chain_handle,
                                   int64_t callback_id,
                                   SmoldotDartCallback callback,
                                   char **error_out);

/**
 * Remove a chain from the client
 *
 * # Safety
 * - `chain_handle` must be a valid handle
 */
int smoldot_remove_chain(SmoldotChainHandle chain_handle, char **error_out);

/**
 * Destroy a client and all its chains
 *
 * # Safety
 * - `client_handle` must be a valid handle
 * - All chain handles for this client become invalid
 */
int smoldot_client_destroy(SmoldotClientHandle client_handle, char **error_out);

/**
 * Free a string allocated by Rust
 *
 * # Safety
 * - `ptr` must have been allocated by Rust via CString
 */
void smoldot_free_string(char *ptr);

/**
 * Get the version of the smoldot FFI library
 *
 * # Safety
 * - Returned string must be freed with `smoldot_free_string`
 */
char *smoldot_version(void);

/**
 * 异步读取轻节点状态快照；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_status_snapshot_async(SmoldotChainHandle chain_handle,
                                      int64_t callback_id,
                                      SmoldotDartCallback callback,
                                      char **error_out);

/**
 * 异步读取runtime 版本；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_runtime_version_async(SmoldotChainHandle chain_handle,
                                      int64_t callback_id,
                                      SmoldotDartCallback callback,
                                      char **error_out);

/**
 * 异步读取runtime metadata；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_metadata_async(SmoldotChainHandle chain_handle,
                               int64_t callback_id,
                               SmoldotDartCallback callback,
                               char **error_out);

/**
 * 异步读取账户下一个可用 nonce；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `account_id_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_account_next_index_async(SmoldotChainHandle chain_handle,
                                         const char *account_id_hex,
                                         int64_t callback_id,
                                         SmoldotDartCallback callback,
                                         char **error_out);

/**
 * 异步读取指定高度的区块哈希；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `block_number` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_block_hash_async(SmoldotChainHandle chain_handle,
                                 const char *block_number,
                                 int64_t callback_id,
                                 SmoldotDartCallback callback,
                                 char **error_out);

/**
 * 异步读取指定区块的 extrinsic 列表；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `block_hash_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_block_extrinsics_async(SmoldotChainHandle chain_handle,
                                       const char *block_hash_hex,
                                       int64_t callback_id,
                                       SmoldotDartCallback callback,
                                       char **error_out);

/**
 * 异步读取提交 extrinsic 到交易池；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `extrinsic_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_submit_extrinsic_async(SmoldotChainHandle chain_handle,
                                   const char *extrinsic_hex,
                                   int64_t callback_id,
                                   SmoldotDartCallback callback,
                                   char **error_out);

/**
 * 异步读取最新块的 System::Account；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `account_id_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_system_account_async(SmoldotChainHandle chain_handle,
                                     const char *account_id_hex,
                                     int64_t callback_id,
                                     SmoldotDartCallback callback,
                                     char **error_out);

/**
 * 异步读取finalized 的 System::Account；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `account_id_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_finalized_system_account_async(SmoldotChainHandle chain_handle,
                                               const char *account_id_hex,
                                               int64_t callback_id,
                                               SmoldotDartCallback callback,
                                               char **error_out);

/**
 * 异步读取最新块的单个 storage 值；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `storage_key_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_storage_value_async(SmoldotChainHandle chain_handle,
                                    const char *storage_key_hex,
                                    int64_t callback_id,
                                    SmoldotDartCallback callback,
                                    char **error_out);

/**
 * 异步读取finalized 的单个 storage 值；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `storage_key_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_finalized_storage_value_async(SmoldotChainHandle chain_handle,
                                              const char *storage_key_hex,
                                              int64_t callback_id,
                                              SmoldotDartCallback callback,
                                              char **error_out);

/**
 * 异步读取最新块的批量 storage 值；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `storage_keys_json` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_storage_values_async(SmoldotChainHandle chain_handle,
                                     const char *storage_keys_json,
                                     int64_t callback_id,
                                     SmoldotDartCallback callback,
                                     char **error_out);

/**
 * 异步读取finalized 的批量 storage 值；结果经 `callback` 回传，本函数立即返回。
 *
 * # Safety
 * - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
 *   句柄失效会在运行期被检出并返回 -1，不构成 UB。
 * - `storage_keys_json` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
 * - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
 *   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
 * - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
 *   不是调用本函数的那个线程。
 * - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
 *   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
 */
int smoldot_get_finalized_storage_values_async(SmoldotChainHandle chain_handle,
                                               const char *storage_keys_json,
                                               int64_t callback_id,
                                               SmoldotDartCallback callback,
                                               char **error_out);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* SMOLDOT_H */
