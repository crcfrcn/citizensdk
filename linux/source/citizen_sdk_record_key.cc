#include "citizen_sdk_record_key.hpp"

#include <iomanip>
#include <sstream>

namespace citizen_sdk::linux::record_key {

std::string hex(const uint8_t *bytes, std::size_t size) {
  std::ostringstream stream;
  stream << std::hex << std::setfill('0');
  for (std::size_t index = 0; index < size; ++index) {
    stream << std::setw(2) << static_cast<unsigned>(bytes[index]);
  }
  return stream.str();
}

std::string block_hash(const std::array<uint8_t, 32> &hash) {
  return "block:" + hex(hash.data(), hash.size());
}

std::string secret(uint32_t wallet_index, uint32_t kind,
                   const std::array<uint8_t, 16> &generation_value,
                   const std::array<uint8_t, 16> &owner,
                   const std::array<uint8_t, 32> &account_id) {
  return "v1:" + std::to_string(wallet_index) + ":" +
         std::to_string(kind) + ":" +
         hex(generation_value.data(), generation_value.size()) + ":" +
         hex(owner.data(), owner.size()) + ":" +
         hex(account_id.data(), account_id.size());
}

std::string generation(uint32_t wallet_index,
                       const std::array<uint8_t, 16> &generation_value) {
  return "v1:" + std::to_string(wallet_index) + ":" +
         hex(generation_value.data(), generation_value.size());
}

}  // namespace citizen_sdk::linux::record_key
