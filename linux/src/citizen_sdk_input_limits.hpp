#ifndef CITIZENSDK_LINUX_INPUT_LIMITS_HPP
#define CITIZENSDK_LINUX_INPUT_LIMITS_HPP

#include <cstddef>
#include <cstdint>
#include <string>
#include "citizensdk_types.h"

namespace citizen_sdk::linux::input_limits {

inline constexpr uint64_t kMaximumChainDatabaseBytes = UINT64_C(512) * 1024;
inline constexpr uint64_t kMaximumRuntimeCacheBytes = UINT64_C(8) * 1024 * 1024;
inline constexpr uint64_t kMaximumWalletProfileBytes = UINT64_C(1) * 1024 * 1024;
inline constexpr uint64_t kMaximumTransactionHistoryBytes = UINT64_C(32) * 1024 * 1024;
inline constexpr uint64_t kTransactionHistoryQueryBytes = 58;
inline constexpr uint64_t kMaximumEncryptedSecretBytes = UINT64_C(64) * 1024;
inline constexpr uint64_t kMaximumAssetBytes = UINT64_C(128) * 1024 * 1024;
inline constexpr uint64_t kMaximumPathBytes = 4096;
inline constexpr std::size_t kMaximumUnlockPasswordBytes = 1024;
inline constexpr uint32_t kMaximumAdditionalAccounts = 1989;

void validate_wallet_indices(const uint32_t *indices, uint32_t count);
void validate_word_count(citizensdk_wallet_word_count_t count);
std::string validate_application_id(citizensdk_bytes_view_t value);

}  // namespace citizen_sdk::linux::input_limits

#endif
