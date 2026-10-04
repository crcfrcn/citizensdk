#include "citizensdk_qr_image.h"

#include <ZXingC.h>

#include <algorithm>
#include <cstring>
#include <limits>
#include <memory>
#include <vector>

namespace {

constexpr size_t kMaxQrTextBytes = 2331;
constexpr uint32_t kMaxDimension = 4096;
constexpr size_t kMaxPixels = 16U * 1024U * 1024U;

template <typename T, void (*Delete)(T *)>
using ZxingPointer = std::unique_ptr<T, decltype(Delete)>;

bool is_valid_utf8(const uint8_t *data, size_t size) {
  size_t index = 0;
  while (index < size) {
    const uint8_t first = data[index++];
    if (first <= 0x7f) {
      continue;
    }
    uint32_t code_point = 0;
    size_t remaining = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      code_point = first & 0x1fU;
      remaining = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      code_point = first & 0x0fU;
      remaining = 2;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code_point = first & 0x07U;
      remaining = 3;
    } else {
      return false;
    }
    if (remaining > size - index) {
      return false;
    }
    for (size_t offset = 0; offset < remaining; ++offset) {
      const uint8_t continuation = data[index++];
      if ((continuation & 0xc0U) != 0x80U) {
        return false;
      }
      code_point = (code_point << 6U) | (continuation & 0x3fU);
    }
    if ((remaining == 1 && code_point < 0x80U) ||
        (remaining == 2 && code_point < 0x800U) ||
        (remaining == 3 && code_point < 0x10000U) ||
        code_point > 0x10ffffU ||
        (code_point >= 0xd800U && code_point <= 0xdfffU)) {
      return false;
    }
  }
  return true;
}

bool checked_image_size(uint32_t width, uint32_t height, uint32_t row_stride,
                        size_t data_size) {
  if (width == 0 || height == 0 || width > kMaxDimension ||
      height > kMaxDimension || row_stride < width ||
      row_stride > kMaxDimension * 4U) {
    return false;
  }
  const size_t rows = static_cast<size_t>(height - 1U);
  const size_t required = rows * static_cast<size_t>(row_stride) + width;
  return required <= data_size &&
         static_cast<size_t>(width) * static_cast<size_t>(height) <= kMaxPixels;
}

citizensdk_qr_image_status_t copy_output(const uint8_t *source, size_t size,
                                         uint8_t *output,
                                         size_t output_capacity,
                                         size_t *output_size) {
  if (output_size == nullptr || (output == nullptr && output_capacity != 0)) {
    return CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT;
  }
  *output_size = size;
  if (output == nullptr || output_capacity < size) {
    return CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL;
  }
  if (size != 0) {
    std::memcpy(output, source, size);
  }
  return CITIZENSDK_QR_IMAGE_OK;
}

}  // namespace

static citizensdk_qr_image_status_t
decode_luminance(
    const uint8_t *data, size_t data_size, uint32_t width, uint32_t height,
    uint32_t row_stride, uint8_t *output, size_t output_capacity,
    size_t *output_size, bool multiple) {
  // 每帧失败清空长度，防止调用方误用上一帧的识别结果。
  if (output_size != nullptr) *output_size = 0;
  if (data == nullptr || output_size == nullptr ||
      (output == nullptr && output_capacity != 0) ||
      !checked_image_size(width, height, row_stride, data_size) ||
      width > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      height > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      row_stride > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      data_size > static_cast<size_t>(std::numeric_limits<int>::max())) {
    return CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT;
  }
  try {
    // 上方已按最后一个实际像素验证完整范围。相机最后一行可以没有 padding；
    // 上游带 size 构造器额外要求 height*stride，不能用它拒绝此合法零拷贝视图。
    ZxingPointer<ZXing_ImageView, ZXing_ImageView_delete> image(
        ZXing_ImageView_new(
            data, static_cast<int>(width),
            static_cast<int>(height), ZXing_ImageFormat_Lum,
            static_cast<int>(row_stride), 1),
        ZXing_ImageView_delete);
    ZxingPointer<ZXing_ReaderOptions, ZXing_ReaderOptions_delete> options(
        ZXing_ReaderOptions_new(), ZXing_ReaderOptions_delete);
    if (!image || !options) {
      return CITIZENSDK_QR_IMAGE_LIBRARY_ERROR;
    }
    const ZXing_BarcodeFormat format =
        ZXing_BarcodeFormat_QRCodeModel2;
    ZXing_ReaderOptions_setFormats(options.get(), &format, 1);
    ZXing_ReaderOptions_setTryHarder(options.get(), true);
    ZXing_ReaderOptions_setTryRotate(options.get(), true);
    ZXing_ReaderOptions_setTryInvert(options.get(), true);
    ZXing_ReaderOptions_setReturnErrors(options.get(), false);
    ZXing_ReaderOptions_setTextMode(options.get(), ZXing_TextMode_Plain);
    ZXing_ReaderOptions_setMaxNumberOfSymbols(options.get(), multiple ? 64 : 2);

    ZxingPointer<ZXing_Barcodes, ZXing_Barcodes_delete> barcodes(
        ZXing_ReadBarcodes(image.get(), options.get()), ZXing_Barcodes_delete);
    if (!barcodes) {
      return CITIZENSDK_QR_IMAGE_LIBRARY_ERROR;
    }
    const int count = ZXing_Barcodes_size(barcodes.get());
    if (count == 0) {
      return CITIZENSDK_QR_IMAGE_NO_CODE;
    }
    if (!multiple && count != 1) {
      return CITIZENSDK_QR_IMAGE_MULTIPLE_CODES;
    }
    if (count < 0 || count > 64) return CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED;
    std::vector<uint8_t> packed;
    auto append_u32 = [&](uint32_t value) {
      for (unsigned shift = 0; shift != 32; shift += 8)
        packed.push_back(static_cast<uint8_t>(value >> shift));
    };
    if (multiple) append_u32(static_cast<uint32_t>(count));
    for (int index = 0; index < count; ++index) {
      const ZXing_Barcode *barcode = ZXing_Barcodes_at(barcodes.get(), index);
      // Reader过滤Model2，成功结果返回QRCode符号族；不把bytesECI当作原文。
      if (barcode == nullptr || !ZXing_Barcode_isValid(barcode) ||
          ZXing_Barcode_format(barcode) != ZXing_BarcodeFormat_QRCode)
        return CITIZENSDK_QR_IMAGE_NO_CODE;
      int text_size = 0;
      std::unique_ptr<uint8_t, decltype(&ZXing_free)> text(
          ZXing_Barcode_bytes(barcode, &text_size), ZXing_free);
      if (!text || text_size <= 0 || static_cast<size_t>(text_size) > kMaxQrTextBytes)
        return CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED;
      if (!is_valid_utf8(text.get(), static_cast<size_t>(text_size)))
        return CITIZENSDK_QR_IMAGE_INVALID_UTF8;
      if (!multiple) return copy_output(text.get(), static_cast<size_t>(text_size),
                                        output, output_capacity, output_size);
      append_u32(static_cast<uint32_t>(text_size));
      packed.insert(packed.end(), text.get(), text.get() + text_size);
    }
    return copy_output(packed.data(), packed.size(), output, output_capacity, output_size);
  } catch (...) {
    return CITIZENSDK_QR_IMAGE_LIBRARY_ERROR;
  }
}

extern "C" citizensdk_qr_image_status_t citizensdk_qr_image_decode_luminance(
    const uint8_t *data, size_t data_size, uint32_t width, uint32_t height,
    uint32_t row_stride, uint8_t *output, size_t output_capacity, size_t *output_size) {
  return decode_luminance(data, data_size, width, height, row_stride,
                          output, output_capacity, output_size, false);
}

// 多码入口与单码入口共用同一读取/UTF-8验证实现；只改变结果容器，不另造识别器。
extern "C" citizensdk_qr_image_status_t citizensdk_qr_image_decode_luminance_all(
    const uint8_t *data, size_t data_size, uint32_t width, uint32_t height,
    uint32_t row_stride, uint8_t *output, size_t output_capacity, size_t *output_size) {
  return decode_luminance(data, data_size, width, height, row_stride,
                          output, output_capacity, output_size, true);
}

extern "C" citizensdk_qr_image_status_t citizensdk_qr_image_encode_text(
    const uint8_t *text, size_t text_size, uint32_t scale, uint8_t *output,
    size_t output_capacity, uint32_t *output_width, uint32_t *output_height,
    size_t *output_size) {
  if (output_width != nullptr) *output_width = 0;
  if (output_height != nullptr) *output_height = 0;
  if (output_size != nullptr) *output_size = 0;
  if (text == nullptr || text_size == 0 || text_size > kMaxQrTextBytes ||
      (output == nullptr && output_capacity != 0) ||
      text_size > static_cast<size_t>(std::numeric_limits<int>::max()) ||
      scale == 0 || scale > 16 || output_width == nullptr ||
      output_height == nullptr || output_size == nullptr ||
      !is_valid_utf8(text, text_size)) {
    return CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT;
  }
  try {
    ZxingPointer<ZXing_CreatorOptions, ZXing_CreatorOptions_delete> creator(
        ZXing_CreatorOptions_new(ZXing_BarcodeFormat_QRCodeModel2),
        ZXing_CreatorOptions_delete);
    ZxingPointer<ZXing_WriterOptions, ZXing_WriterOptions_delete> writer(
        ZXing_WriterOptions_new(), ZXing_WriterOptions_delete);
    if (!creator || !writer) {
      return CITIZENSDK_QR_IMAGE_LIBRARY_ERROR;
    }
    ZXing_CreatorOptions_setOptions(creator.get(), "ecLevel=M, eci=UTF-8");
    ZXing_WriterOptions_setScale(writer.get(), static_cast<int>(scale));
    ZXing_WriterOptions_setAddHRT(writer.get(), false);
    ZXing_WriterOptions_setAddQuietZones(writer.get(), true);
    ZxingPointer<ZXing_Barcode, ZXing_Barcode_delete> barcode(
        ZXing_CreateBarcodeFromText(reinterpret_cast<const char *>(text),
                                    static_cast<int>(text_size), creator.get()),
        ZXing_Barcode_delete);
    if (!barcode || !ZXing_Barcode_isValid(barcode.get())) {
      return CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED;
    }
    ZxingPointer<ZXing_Image, ZXing_Image_delete> image(
        ZXing_WriteBarcodeToImage(barcode.get(), writer.get()),
        ZXing_Image_delete);
    if (!image || ZXing_Image_format(image.get()) != ZXing_ImageFormat_Lum) {
      return CITIZENSDK_QR_IMAGE_LIBRARY_ERROR;
    }
    const int width = ZXing_Image_width(image.get());
    const int height = ZXing_Image_height(image.get());
    if (width <= 0 || height <= 0) {
      return CITIZENSDK_QR_IMAGE_LIBRARY_ERROR;
    }
    const size_t pixels = static_cast<size_t>(width) *
                          static_cast<size_t>(height);
    if (pixels > kMaxPixels) {
      return CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED;
    }
    *output_width = static_cast<uint32_t>(width);
    *output_height = static_cast<uint32_t>(height);
    return copy_output(ZXing_Image_data(image.get()), pixels, output,
                       output_capacity, output_size);
  } catch (...) {
    return CITIZENSDK_QR_IMAGE_LIBRARY_ERROR;
  }
}

extern "C" const char *citizensdk_qr_image_zxing_version(void) {
  try {
    return ZXing_Version();
  } catch (...) {
    return nullptr;
  }
}
