#ifndef CITIZENSDK_LINUX_RECORD_KEY_HPP
#define CITIZENSDK_LINUX_RECORD_KEY_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::linux::record_key {

std::string hex(const uint8_t *bytes, std::size_t size);
std::string block_hash(const std::array<uint8_t, 32> &hash);
std::string secret(uint32_t wallet_index, uint32_t kind,
                   const std::array<uint8_t, 16> &generation,
                   const std::array<uint8_t, 16> &owner,
                   const std::array<uint8_t, 32> &account_id);
std::string generation(uint32_t wallet_index,
                       const std::array<uint8_t, 16> &generation);

}  // namespace citizen_sdk::linux::record_key

#endif
