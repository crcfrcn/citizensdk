// 验证平台敏感缓冲区不可复制、移动后单一所有权并可显式清零。
#include <array>
#include <cassert>
#include <type_traits>
#include <utility>

#include "citizen_sdk_sensitive_buffer.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

int main() {
  using citizen_sdk::windows::SensitiveBuffer;
  using citizen_sdk::windows::secure_zero;

  static_assert(!std::is_copy_constructible_v<SensitiveBuffer>);
  static_assert(!std::is_copy_assignable_v<SensitiveBuffer>);
  static_assert(std::is_nothrow_move_constructible_v<SensitiveBuffer>);
  static_assert(std::is_nothrow_move_assignable_v<SensitiveBuffer>);

  std::array<uint8_t, 32> bytes{};
  bytes.fill(0xa5);
  SensitiveBuffer first(bytes.data(), bytes.size());
  assert(first.size() == bytes.size());
  assert(first.data()[0] == 0xa5);

  SensitiveBuffer second(std::move(first));
  assert(first.empty());
  assert(second.size() == bytes.size());
  second.clear();
  assert(second.empty());

  secure_zero(bytes.data(), bytes.size());
  for (const auto byte : bytes) assert(byte == 0);
  return 0;
}
