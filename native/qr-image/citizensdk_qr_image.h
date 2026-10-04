#ifndef CITIZENSDK_QR_IMAGE_H
#define CITIZENSDK_QR_IMAGE_H

#include <stddef.h>
#include <stdint.h>

#if defined(__GNUC__) || defined(__clang__)
#define CITIZENSDK_QR_IMAGE_API __attribute__((visibility("default")))
#else
#define CITIZENSDK_QR_IMAGE_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

/** CitizenSDK ZXing-C++ 窄包装的稳定状态码。 */
typedef enum citizensdk_qr_image_status {
  CITIZENSDK_QR_IMAGE_OK = 0,
  CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT = 1,
  CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED = 2,
  CITIZENSDK_QR_IMAGE_NO_CODE = 3,
  CITIZENSDK_QR_IMAGE_MULTIPLE_CODES = 4,
  CITIZENSDK_QR_IMAGE_INVALID_UTF8 = 5,
  CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL = 6,
  CITIZENSDK_QR_IMAGE_LIBRARY_ERROR = 7
} citizensdk_qr_image_status_t;

/**
 * 从单平面 8 位亮度图像识别唯一 QR Code Model 2。
 *
 * `row_stride` 可以大于 `width`，但不得越过 `data_size`。输出不附加 NUL 终止字节；
 * 原文中的嵌入 NUL 由准确长度保留。失败时清零输出长度，不改写输出缓冲。
 * `output == NULL && output_capacity == 0` 可先查询 `output_size`。
 */
CITIZENSDK_QR_IMAGE_API citizensdk_qr_image_status_t
citizensdk_qr_image_decode_luminance(
    const uint8_t *data, size_t data_size, uint32_t width, uint32_t height,
    uint32_t row_stride, uint8_t *output, size_t output_capacity,
    size_t *output_size);

/** SDK内部多码结果：小端u32数量，随后逐个小端u32字节长度和UTF-8原文。
 * 最多64个码，每码最多2331字节；不暴露图像库对象或添加QR_V1字段。
 * 参数/输出所有权与单码入口相同，未识别返回NO_CODE，失败不部分写输出。 */
CITIZENSDK_QR_IMAGE_API citizensdk_qr_image_status_t
citizensdk_qr_image_decode_luminance_all(
    const uint8_t *data, size_t data_size, uint32_t width, uint32_t height,
    uint32_t row_stride, uint8_t *output, size_t output_capacity,
    size_t *output_size);

/**
 * 把 UTF-8 文本编码为纠错等级 M、含 quiet zone 的 QR Code Model 2 亮度图。
 *
 * `scale` 固定允许 1..16。成功时像素为 8 位灰度；查询调用仍返回最终宽、高和字节数。
 */
CITIZENSDK_QR_IMAGE_API citizensdk_qr_image_status_t
citizensdk_qr_image_encode_text(
    const uint8_t *text, size_t text_size, uint32_t scale, uint8_t *output,
    size_t output_capacity, uint32_t *output_width, uint32_t *output_height,
    size_t *output_size);

/** 返回实际链接的 ZXing-C++ 版本，只用于版本核验。 */
CITIZENSDK_QR_IMAGE_API const char *citizensdk_qr_image_zxing_version(void);

#ifdef __cplusplus
}
#endif

#undef CITIZENSDK_QR_IMAGE_API

#endif
