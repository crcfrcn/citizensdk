#include "citizensdk.h"
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <type_traits>
#include <utility>
#include <vector>

#ifdef NDEBUG
#error "CitizenSDK assertions must remain enabled"
#endif

int main() {
  // C++直接消费同一C接口，覆盖真实句柄、用途拒绝和失败输出不写入。
  static_assert(std::is_standard_layout_v<citizensdk_create_options_t>);
  static_assert(std::is_standard_layout_v<citizensdk_stores_v1_t>);
  static_assert(sizeof(citizensdk_account_id_t) == 32);
  static_assert(offsetof(citizensdk_create_options_t, abi_version) == 4);
  assert(citizensdk_abi_version() == CITIZENSDK_ABI_VERSION);
  citizensdk_create_options_t options{};
  options.struct_size = sizeof(options); options.abi_version = CITIZENSDK_ABI_VERSION;
  citizensdk_stores_v1_t stores{};
  stores.struct_size = sizeof(stores); stores.abi_version = CITIZENSDK_ABI_VERSION;
  citizensdk_handle_t sdk = 0;
  assert(citizensdk_create(&options, CITIZENSDK_MODULE_QR, &stores, &sdk) == CITIZENSDK_OK && sdk != 0);
  citizensdk_lifecycle_t lifecycle = 0;
  assert(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK && lifecycle == CITIZENSDK_LIFECYCLE_CREATED);
  citizensdk_account_id_t account{};
  for (auto &byte : account.bytes) byte = 0x11;
  uint64_t needed = 0;
  assert(citizensdk_qr_encode_account_id(sdk, &account, nullptr, 0, &needed) == CITIZENSDK_OK);
  assert(needed > 0 && needed <= 2331);
  std::vector<uint8_t> text(static_cast<std::size_t>(needed));
  assert(citizensdk_qr_encode_account_id(sdk, &account, text.data(), text.size(), &needed) == CITIZENSDK_OK);
  const citizensdk_bytes_view_t input{text.data(), text.size()};
  uint64_t json_size = 0;
  assert(citizensdk_qr_parse(sdk, input, 1, nullptr, 0, &json_size) == CITIZENSDK_OK && json_size > 0);
  std::array<uint8_t, 8> unchanged{}; unchanged.fill(0xa5);
  for (const auto [purpose, expected] : {std::pair{5U,CITIZENSDK_ERROR_INVALID_ARGUMENT},std::pair{6U,CITIZENSDK_ERROR_DECODE},std::pair{UINT32_MAX,CITIZENSDK_ERROR_DECODE}}) {
    uint64_t output_size = 777;
    assert(citizensdk_qr_parse(sdk, input, purpose, unchanged.data(), unchanged.size(), &output_size) == expected);
    assert(output_size == 777);
    for (const auto byte : unchanged) assert(byte == 0xa5);
  }
  assert(citizensdk_destroy(sdk) == CITIZENSDK_OK);
  assert(citizensdk_destroy(sdk) == CITIZENSDK_ERROR_INVALID_HANDLE);
  assert(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_ERROR_INVALID_HANDLE);
  std::puts("CitizenSDK C++ ABI passed");
}
