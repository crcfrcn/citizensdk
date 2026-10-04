// 验证 Linux record key 精确绑定 generation、owner、account 与 block hash。
#include <array>
#include <cassert>
#include <string>

#include "citizen_sdk_record_key.hpp"

#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif

int main() {
  using namespace citizen_sdk::linux;

  std::array<uint8_t, 16> first_generation{};
  std::array<uint8_t, 16> second_generation{};
  std::array<uint8_t, 16> first_owner{};
  std::array<uint8_t, 16> second_owner{};
  std::array<uint8_t, 32> account{};
  first_generation[0] = 1;
  second_generation[0] = 2;
  first_owner[0] = 3;
  second_owner[0] = 4;
  account[0] = 5;

  const auto first = record_key::secret(0, 1, first_generation, first_owner,
                                        account);
  assert(first.rfind("v1:0:1:", 0) == 0);
  assert(first.find("citizenapp") == std::string::npos);
  assert(first != record_key::secret(0, 1, second_generation, first_owner,
                                     account));
  assert(first != record_key::secret(0, 1, first_generation, second_owner,
                                     account));

  const auto generation = record_key::generation(0, first_generation);
  assert(generation.rfind("v1:0:", 0) == 0);
  assert(generation.size() == 5 + 32);
  assert(generation.find("citizenapp") == std::string::npos);
  assert(generation != record_key::generation(0, second_generation));

  std::array<uint8_t, 32> block{};
  block[0] = 0xab;
  const auto block_key = record_key::block_hash(block);
  assert(block_key.rfind("block:ab", 0) == 0);
  assert(block_key.size() == 6 + 64);
  return 0;
}
