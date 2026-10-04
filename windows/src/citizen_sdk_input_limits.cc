#include "citizen_sdk_input_limits.hpp"

#include <unordered_set>
#include <regex>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::windows::input_limits {

void validate_wallet_indices(const uint32_t *indices, uint32_t count) {
  require(indices != nullptr && count > 0 && count <= kMaximumAdditionalAccounts,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "wallet indices must contain 1...1989 entries");
  std::unordered_set<uint32_t> unique;
  unique.reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    require(indices[i] >= 1 && indices[i] <= kMaximumAdditionalAccounts &&
                unique.insert(indices[i]).second,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "wallet indices must be unique values in 1...1989");
  }
}

void validate_word_count(citizensdk_wallet_word_count_t count) {
  require(count == CITIZENSDK_WALLET_WORDS_12 ||
              count == CITIZENSDK_WALLET_WORDS_18 ||
              count == CITIZENSDK_WALLET_WORDS_24,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "wallet word count must be 12, 18, or 24");
}

std::string validate_application_id(citizensdk_bytes_view_t value) {
  const Bytes bytes = copy_view(value, 253, "application_id is too long");
  const std::string identifier(bytes.begin(), bytes.end());
  static const std::regex pattern(
      R"(^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$)",
      std::regex::ECMAScript);
  require(identifier.size() >= 3 && std::regex_match(identifier, pattern),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "application_id must be a lowercase reverse-DNS identifier");
  return identifier;
}

}  // namespace citizen_sdk::windows::input_limits
