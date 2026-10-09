#include "citizensdk_qr_image.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <string>
#include <vector>

// Release 同样执行检查，不能使用被 NDEBUG 删除的 assert 表达式。
#define CHECK(condition) do { if (!(condition)) { \
  std::fprintf(stderr, "QR image contract failed at line %d\n", __LINE__); \
  std::exit(EXIT_FAILURE); } } while (false)

static void check_status(citizensdk_qr_image_status_t actual,
                         citizensdk_qr_image_status_t expected) {
  if (actual != expected) {
    std::fprintf(stderr, "QR image status %d, expected %d\n", actual, expected);
    std::exit(EXIT_FAILURE);
  }
}

static void expect_text(const std::vector<uint8_t>& image, uint32_t width,
                        uint32_t height, uint32_t stride, const std::string& text) {
  size_t size = 0;
  const auto status = citizensdk_qr_image_decode_luminance(image.data(), image.size(), width,
      height, stride, nullptr, 0, &size);
  if (status != CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL)
    std::fprintf(stderr, "QR fixture width=%u height=%u stride=%u bytes=%zu\n",
        width, height, stride, text.size());
  check_status(status, CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
  std::vector<uint8_t> decoded(size);
  CHECK(citizensdk_qr_image_decode_luminance(image.data(), image.size(), width,
      height, stride, decoded.data(), decoded.size(), &size) == CITIZENSDK_QR_IMAGE_OK);
  CHECK(std::string(decoded.begin(), decoded.end()) == text);
}

int main() {
  const std::string text =
      R"({"p":"QR_V1","k":5,"b":{"n":"0x0000000000000000000000000000000000000000000000000000000000000000"}})";
  uint32_t width = 0;
  uint32_t height = 0;
  size_t pixels = 0;
  CHECK(citizensdk_qr_image_encode_text(
             reinterpret_cast<const uint8_t *>(text.data()), text.size(), 4,
             nullptr, 0, &width, &height, &pixels) ==
         CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
  CHECK(width > 0 && height > 0 && pixels == width * height);
  std::vector<uint8_t> image(pixels);
  CHECK(citizensdk_qr_image_encode_text(
             reinterpret_cast<const uint8_t *>(text.data()), text.size(), 4,
             image.data(), image.size(), &width, &height, &pixels) ==
         CITIZENSDK_QR_IMAGE_OK);

  size_t decoded_size = 0;
  check_status(citizensdk_qr_image_decode_luminance(
             image.data(), image.size(), width, height, width, nullptr, 0,
             &decoded_size), CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
  std::vector<uint8_t> decoded(decoded_size);
  CHECK(citizensdk_qr_image_decode_luminance(
             image.data(), image.size(), width, height, width, decoded.data(),
             decoded.size(), &decoded_size) == CITIZENSDK_QR_IMAGE_OK);
  CHECK(std::string(decoded.begin(), decoded.end()) == text);
  const char* version = citizensdk_qr_image_zxing_version();
  CHECK(version != nullptr && std::string(version) == "3.1.1");

  auto rotated = image;
  CHECK(width == height);
  for (int orientation = 0; orientation < 3; ++orientation) {
    auto source = rotated;
    for (uint32_t y = 0; y < height; ++y)
      for (uint32_t x = 0; x < width; ++x)
        rotated[static_cast<size_t>(x) * width + height - y - 1] =
            source[static_cast<size_t>(y) * width + x];
    expect_text(rotated, width, height, width, text);
  }
  auto inverted = image;
  for (auto& value : inverted) value = static_cast<uint8_t>(255U - value);
  expect_text(inverted, width, height, width, text);

  // 相机行填充以及最后一行不含 padding 的视图必须正确读取。
  const uint32_t stride = width + 17;
  std::vector<uint8_t> padded(static_cast<size_t>(height - 1) * stride + width, 0x39);
  for (uint32_t y = 0; y < height; ++y)
    std::copy_n(image.data() + static_cast<size_t>(y) * width, width,
        padded.data() + static_cast<size_t>(y) * stride);
  expect_text(padded, width, height, stride, text);
  padded.pop_back();
  CHECK(citizensdk_qr_image_decode_luminance(padded.data(), padded.size(), width,
      height, stride, nullptr, 0, &decoded_size) == CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT);
  CHECK(decoded_size == 0);

  auto blurred = image;
  for (uint32_t y = 1; y + 1 < height; ++y) {
    for (uint32_t x = 1; x + 1 < width; ++x) {
      unsigned total = 0;
      for (uint32_t dy = y - 1; dy <= y + 1; ++dy)
        for (uint32_t dx = x - 1; dx <= x + 1; ++dx)
          total += image[static_cast<size_t>(dy) * width + dx];
      blurred[static_cast<size_t>(y) * width + x] = static_cast<uint8_t>(total / 9U);
    }
  }
  expect_text(blurred, width, height, width, text);
  std::vector<uint8_t> blank(64 * 64, 255);
  CHECK(citizensdk_qr_image_decode_luminance(blank.data(), blank.size(), 64, 64,
      64, nullptr, 0, &decoded_size) == CITIZENSDK_QR_IMAGE_NO_CODE);
  const uint32_t two_width = width * 2 + 32;
  std::vector<uint8_t> two(static_cast<size_t>(two_width) * height, 255);
  for (uint32_t y = 0; y < height; ++y) {
    auto* row = two.data() + static_cast<size_t>(y) * two_width;
    const auto* source = image.data() + static_cast<size_t>(y) * width;
    std::copy_n(source, width, row);
    std::copy_n(source, width, row + width + 32);
  }
  CHECK(citizensdk_qr_image_decode_luminance(two.data(), two.size(), two_width,
      height, two_width, nullptr, 0, &decoded_size) == CITIZENSDK_QR_IMAGE_MULTIPLE_CODES);
  // 同一个识别实现可以投影多码；精确单码入口仍拒绝歧义，不静默改变旧C调用语义。
  CHECK(citizensdk_qr_image_decode_luminance_all(two.data(), two.size(), two_width,
      height, two_width, nullptr, 0, &decoded_size) == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
  CHECK(decoded_size == 4 + 2 * (4 + text.size()));
  std::vector<uint8_t> packed(decoded_size);
  CHECK(citizensdk_qr_image_decode_luminance_all(two.data(), two.size(), two_width,
      height, two_width, packed.data(), packed.size(), &decoded_size) == CITIZENSDK_QR_IMAGE_OK);
  size_t offset = 0;
  auto read_u32 = [&]() {
    CHECK(offset + 4 <= packed.size());
    uint32_t value = 0;
    for (unsigned index = 0; index < 4; ++index) value |= static_cast<uint32_t>(packed[offset++]) << (index * 8);
    return value;
  };
  CHECK(read_u32() == 2);
  for (unsigned index = 0; index < 2; ++index) {
    const auto size = read_u32();
    CHECK(size == text.size() && offset + size <= packed.size());
    CHECK(std::string(packed.begin() + offset, packed.begin() + offset + size) == text);
    offset += size;
  }
  CHECK(offset == packed.size());
  std::vector<uint8_t> insufficient(3, 0xa5);
  CHECK(citizensdk_qr_image_decode_luminance_all(two.data(), two.size(), two_width,
      height, two_width, insufficient.data(), insufficient.size(), &decoded_size) == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
  CHECK(std::all_of(insufficient.begin(), insufficient.end(), [](uint8_t value) { return value == 0xa5; }));
  CHECK(citizensdk_qr_image_decode_luminance_all(blank.data(), blank.size(), 64, 64,
      64, nullptr, 0, &decoded_size) == CITIZENSDK_QR_IMAGE_NO_CODE);
  CHECK(decoded_size == 0);
  CHECK(citizensdk_qr_image_decode_luminance(image.data(), image.size(), 4097,
      1, 4097, nullptr, 0, &decoded_size) == CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT);
  CHECK(citizensdk_qr_image_decode_luminance(image.data(), image.size(), width,
      height, width, nullptr, 1, &decoded_size) == CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT);
  std::vector<uint8_t> short_output(text.size() - 1, 0x5a);
  CHECK(citizensdk_qr_image_decode_luminance(image.data(), image.size(), width,
      height, width, short_output.data(), short_output.size(), &decoded_size) ==
      CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
  CHECK(decoded_size == text.size() && std::all_of(short_output.begin(), short_output.end(),
      [](uint8_t value) { return value == 0x5a; }));
  const uint8_t invalid_utf8[] = {0xc0, 0xaf};
  CHECK(citizensdk_qr_image_encode_text(invalid_utf8, 2, 4, nullptr, 0,
      &width, &height, &pixels) == CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT);
  CHECK(width == 0 && height == 0 && pixels == 0);
  for (uint32_t scale : {0U, 17U})
    CHECK(citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t*>(text.data()),
        text.size(), scale, nullptr, 0, &width, &height, &pixels) ==
        CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT);
  const std::string oversized(2332, 'x');
  CHECK(citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t*>(oversized.data()),
      oversized.size(), 4, nullptr, 0, &width, &height, &pixels) ==
      CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT);
  // 中文与反斜杠不允许被 ECI 前缀、转义或字符集猜测改变。
  for (const std::string value : {std::string(u8"公民二维码\\路径"), std::string("ascii"),
                                 std::string("embedded\0nul", 12)}) {
    CHECK(citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t*>(value.data()),
        value.size(), 4, nullptr, 0, &width, &height, &pixels) ==
        CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
    std::vector<uint8_t> encoded(pixels);
    CHECK(citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t*>(value.data()),
        value.size(), 4, encoded.data(), encoded.size(), &width, &height, &pixels) ==
        CITIZENSDK_QR_IMAGE_OK);
    expect_text(encoded, width, height, width, value);
  }
  std::puts("CitizenSDK QR image contracts passed");
  return 0;
}
