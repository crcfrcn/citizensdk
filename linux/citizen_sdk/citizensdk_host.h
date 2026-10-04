#ifndef CITIZENSDK_HOST_H
#define CITIZENSDK_HOST_H

#include <stdint.h>
#include "citizensdk.h"

#if defined(__GNUC__)
#define CITIZENSDK_HOST_API __attribute__((visibility("default")))
#else
#define CITIZENSDK_HOST_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define CITIZENSDK_HOST_ABI_VERSION UINT32_C(1)

typedef uint64_t citizensdk_host_handle_t;

/* 无UI请求接纳桥：accept只投影已有Core函数；complete接管真实result并释放一次。
 * cancel只请求资源关闭，不完成请求。context由retain/release保有至终态与并发取消回调结束。
 * 所有回调不得抛异常；retain/release不得阻塞或反调Host。旧Host配置布局不变。 */
typedef struct citizensdk_host_request_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  citizensdk_error_code_t (*accept)(void *context, citizensdk_handle_t core,
                                    citizensdk_request_id_t *out_request_id);
  void (*complete)(void *context, citizensdk_request_id_t request_id,
                   citizensdk_result_handle_t result);
  void (*cancel)(void *context, citizensdk_handle_t core);
  void (*retain)(void *context);
  void (*release)(void *context);
} citizensdk_host_request_v1_t;
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_submit_request(
    citizensdk_host_handle_t host, const citizensdk_host_request_v1_t *request,
    citizensdk_request_id_t *out_request_id);


/* 非UI凭据绑定。request/cancel可在Host工作线程回调；宿主只派发UI，
 * 不阻塞回调。context保留至Host销毁；配置只允许在create_sdk之前登记。
 * 回包借用12..1024个UTF-8字节；NULL/0表示用户取消，不表示认证成功。 */
typedef struct citizensdk_credential_challenge_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t host_operation_id;
  uint32_t key_purpose; /* 1=create，2=unlock；不复用二维码purpose。 */
  uint32_t reserved;
} citizensdk_credential_challenge_v1_t;
typedef struct citizensdk_credential_provider_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  void (*request)(void *context, const citizensdk_credential_challenge_v1_t *challenge);
  void (*cancel)(void *context, uint64_t host_operation_id);
  /* 生命周期回调不得等待UI或反调Host。retain/release成对保有context，
   * idle只读报告提供者异步结果是否排空，取消通知不等于idle。 */
  void (*retain)(void *context);
  void (*release)(void *context);
  uint8_t (*idle)(void *context);
} citizensdk_credential_provider_v1_t;
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_set_credential_provider(
    citizensdk_host_handle_t host, const citizensdk_credential_provider_v1_t *provider);
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_respond_credential(
    citizensdk_host_handle_t host, uint64_t host_operation_id,
    citizensdk_bytes_view_t credential);
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_cancel_credential(
    citizensdk_host_handle_t host, uint64_t host_operation_id);


/* 无UI采集薄绑定：只有真实首帧才产生opened成功；新资源初始暂停。
 * 像素/文档只在回调期间借用；回调不得阻塞或抛异常，retain/release不得反调Host。
 * 最后release发生在设备/回调排空和Host服务租约归还之后，不代表取消请求即完成。 */
typedef struct citizensdk_qr_frame_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t width;
  uint32_t height;
  uint32_t rotation_degrees;
  uint32_t reserved;
  uint64_t generation;
  citizensdk_bytes_view_t rgba;
  citizensdk_bytes_view_t luminance;
} citizensdk_qr_frame_v1_t;
typedef struct citizensdk_qr_capture_callbacks_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  void (*opened)(void *, uint64_t, citizensdk_error_code_t, uint32_t, uint32_t, uint32_t);
  void (*frame)(void *, uint64_t, const citizensdk_qr_frame_v1_t *); /* 可空 */
  void (*document)(void *, uint64_t, uint64_t, citizensdk_bytes_view_t);
  void (*error)(void *, uint64_t, citizensdk_error_code_t);
  void (*control)(void *, uint64_t, uint64_t, citizensdk_error_code_t);
  void (*closed)(void *, uint64_t, citizensdk_error_code_t);
  void (*retain)(void *);
  void (*release)(void *);
} citizensdk_qr_capture_callbacks_v1_t;
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_open_qr_capture(
    citizensdk_host_handle_t host, uint32_t purpose,
    const citizensdk_qr_capture_callbacks_v1_t *callbacks, uint64_t *out_resource_id);
/* action: pause=1/resume=2/torch=3/close=4；operation_id非零严格递增。
 * enabled只用于torch且为0/1，其他action必须为0；接纳后由回调交付真实终态。 */
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_control_qr_capture(
    citizensdk_host_handle_t host, uint64_t resource_id, uint64_t operation_id,
    uint32_t action, uint8_t enabled);
/* 有界同步图像能力；调用方不得在UI线程进行重解码。
 * 输出为u32数量及逐项u32长度/Core文档UTF8，均小端；最多64项/每项64KiB。
 * NULL/0查询长度；失败不部分写输出；未知图像格式明确unsupported。 */
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_decode_qr_image(
    citizensdk_host_handle_t host, citizensdk_bytes_view_t encoded_image, uint32_t purpose,
    uint8_t *buffer, uint64_t capacity, uint64_t *out_required);

typedef struct citizensdk_host_config_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_bytes_view_t storage_root_utf8;
  citizensdk_bytes_view_t asset_root_utf8;
  citizensdk_bytes_view_t application_id_utf8;
  void *gtk_parent_window;
  uint8_t enable_wallet;
  uint8_t reserved[7];
} citizensdk_host_config_v1_t;

CITIZENSDK_HOST_API uint32_t citizensdk_host_abi_version(void);
CITIZENSDK_HOST_API uint32_t citizensdk_host_config_size(void);
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_create(
    const citizensdk_host_config_v1_t *config,
    citizensdk_host_handle_t *out_host);

/* 显式模块创建不改变 ABI1 结构布局。enable_wallet 必须准确投影 wallet/signing
 * 是否需要设备安全资源；模块依赖由 Rust 唯一校验。 */
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_create_with_modules(
    const citizensdk_host_config_v1_t *config, uint32_t modules,
    citizensdk_host_handle_t *out_host);

/* The Host owns the returned Core instance. Applications may invoke the root
 * C ABI with this borrowed handle but must not replace its event callback or
 * call citizensdk_destroy directly. Destruction is committed through Host. */
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_create_sdk(
    citizensdk_host_handle_t host, citizensdk_handle_t *out_sdk);
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_sdk(
    citizensdk_host_handle_t host, citizensdk_handle_t *out_sdk);
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_set_event_callback(
    citizensdk_host_handle_t host, citizensdk_event_callback_t callback,
    void *context);
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_set_parent_window(
    citizensdk_host_handle_t host, void *gtk_parent_window);
CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_vault_availability(
    citizensdk_host_handle_t host,
    citizensdk_host_vault_availability_t *out_availability);

/* Fails with BUSY while requests, results, callbacks, or resources remain.
 * Success destroys Core first, closes stores, zeroizes vault state, and makes
 * the host handle permanently invalid. */
CITIZENSDK_HOST_API citizensdk_error_code_t
citizensdk_host_destroy(citizensdk_host_handle_t host);

/* Transfers an otherwise unreachable Host to the process supervisor. The
 * supervisor requests a checkpointed stop when needed and retries monotonic
 * teardown with bounded backoff. The caller must never use the handle again. */
CITIZENSDK_HOST_API citizensdk_error_code_t
citizensdk_host_abandon(citizensdk_host_handle_t host);

CITIZENSDK_HOST_API citizensdk_error_code_t citizensdk_host_last_error_copy(
    uint8_t *buffer, uint64_t capacity, uint64_t *out_required);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CITIZENSDK_HOST_H */
