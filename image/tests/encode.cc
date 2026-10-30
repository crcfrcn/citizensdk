#include "citizensdk_qr_image.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <string>
#include <vector>
#include <utility>

// Release 同样执行检查，不能使用被 NDEBUG 删除的 assert 表达式。
#define CHECK(condition) do { if (!(condition)) { \
  std::fprintf(stderr, "QR image contract failed at line %d\n", __LINE__); \
  std::exit(EXIT_FAILURE); } } while (false)


void expect_text(const std::vector<uint8_t>&, uint32_t, uint32_t, uint32_t, const std::string&);
void decode_contract(const std::vector<uint8_t>&, uint32_t, uint32_t, const std::string&);

// 编码成功、边界及逐字节回读与原解码套件共用真实图像库。
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

  decode_contract(image, width, height, text);
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
  for (const std::string &value : {std::string(u8"公民二维码\\路径"), std::string("ascii"),
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
  if (std::getenv("CITIZENSDK_PERFORMANCE") != nullptr) {
    // 同一真实ZXing调用；分尺寸采样，旋转/多码边界仍由原解码套件验收。
    for (uint32_t scale : {2U, 4U, 8U}) {
      std::vector<int64_t> encodes, decodes;
      for (unsigned round = 0; round < 20; ++round) {
        CHECK(citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t*>(text.data()), text.size(), scale, nullptr, 0, &width, &height, &pixels) == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL);
        std::vector<uint8_t> encoded(pixels);
        auto begin = std::chrono::steady_clock::now();
        CHECK(citizensdk_qr_image_encode_text(reinterpret_cast<const uint8_t*>(text.data()), text.size(), scale, encoded.data(), encoded.size(), &width, &height, &pixels) == CITIZENSDK_QR_IMAGE_OK);
        encodes.push_back(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - begin).count());
        begin = std::chrono::steady_clock::now();
        expect_text(encoded, width, height, width, text);
        decodes.push_back(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - begin).count());
      }
      for (auto entry : {std::make_pair("encode", encodes), std::make_pair("decode", decodes)}) {
        std::sort(entry.second.begin(), entry.second.end());
        std::printf("sdk-baseline zxing operation=%s scale=%u rounds=20 p50_ns=%lld p95_ns=%lld max_ns=%lld pixels=%zu\n", entry.first, scale,
          static_cast<long long>(entry.second[9]), static_cast<long long>(entry.second[18]), static_cast<long long>(entry.second[19]), pixels);
      }
    }
  }
  std::puts("CitizenSDK QR image contracts passed");
  return 0;
}
