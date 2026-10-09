#ifndef CITIZENSDK_CPP_MODELS_HPP
#define CITIZENSDK_CPP_MODELS_HPP

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include "citizensdk_types.h"

namespace citizen_sdk {

// 纯图像数据，不包含预览控件或SDK窗口。
struct QrImage {
  uint32_t width{}, height{};
  std::vector<uint8_t> luminance;
};

struct CapabilityStatus {
  citizensdk_capability_name_t name{};
  citizensdk_capability_reason_t reason{};
  bool supported{};
  bool available{};
  bool enabled{};
  bool ready{};
};

struct Capabilities {
  uint64_t revision{};
  std::vector<CapabilityStatus> statuses;
};

struct BlockRef {
  std::array<uint8_t, 32> hash{};
  uint64_t number{};
  citizensdk_finality_t finality{CITIZENSDK_FINALITY_FINALIZED};
};

struct AccountId { std::array<uint8_t, 32> bytes{}; };




struct QrPreview { uint32_t width{}, height{}, rotation_degrees{}; };
struct QrFrame {
  QrPreview preview;
  uint64_t generation{};
  std::vector<uint8_t> rgba;
};

struct QrDocument {
  uint32_t kind{}, scan_purpose_mask{};
  std::string canonical_text, core_json;
};
struct QrSigned { QrDocument document; QrImage qr_image; };
struct QrAuthorization {
  uint32_t reason{};
  std::array<uint8_t, 32> genesis_hash{};
  std::string cid_number;
  std::optional<AccountId> current_account_id;
  uint64_t expected_binding_revision{}, expires_at{};
  std::vector<uint8_t> materialized_payload;
};
struct WalletSignature { AccountId account_id; std::array<uint8_t, 64> bytes{}; };
struct SigningIntent {
  AccountId account_id;
  std::vector<uint8_t> payload;
  citizensdk_signing_transform_t transform{CITIZENSDK_SIGNING_TRANSFORM_RAW};
  std::vector<uint8_t> domain;
  citizensdk_external_signer_transport_t transport{CITIZENSDK_EXTERNAL_SIGNER_NONE};
  uint16_t action{};
  uint64_t ttl_seconds{120};
};
struct SigningOutcome {
  citizensdk_signing_outcome_status_t status{};
  AccountId account_id;
  std::array<uint8_t, 32> payload_hash{};
  std::optional<std::array<uint8_t, 64>> signature;
  uint64_t expires_at{};
  std::string session_id, transport_request;
};
struct DefaultAccountChange {
  citizensdk_signing_outcome_status_t status{};
  AccountId current_default_account_id;
  std::array<uint8_t, 32> payload_hash{};
  uint64_t expires_at{}, committed_revision{};
  std::string session_id, transport_request;
};

struct WalletInputValidation { uint32_t reason{}; std::optional<uint32_t> position; };

struct WalletAccount {
  uint32_t index{};
  AccountId account_id;
  std::string ss58_address, name;
  uint64_t created_at_millis{};
  bool is_active{};
};
struct WalletProfile {
  uint32_t wallet_index{};
  std::string wallet_name;
  AccountId master_account_id, active_account_id;
  citizensdk_wallet_origin_t origin{};
  uint64_t created_at_millis{};
  std::vector<WalletAccount> accounts;
};
struct WalletCleanupTargets {
  std::vector<AccountId> account_ids;
  bool delete_wallet_wide_key{};
};
struct WalletDiagnostic {
  uint32_t wallet_index{}, diagnostic_reason{};
  std::string wallet_name;
  AccountId account_id;
  std::optional<std::string> ss58_address;
  std::optional<citizensdk_wallet_sign_mode_t> sign_mode;
  std::optional<WalletCleanupTargets> cleanup_targets;
};

struct WalletStateAccount {
  citizensdk_wallet_sign_mode_t sign_mode{};
  uint32_t wallet_index{};
  std::optional<uint32_t> account_index;
  AccountId account_id;
  std::string ss58_address;
  std::string name;
  uint64_t created_at_millis{};
  bool is_default{};
};

struct WalletState {
  uint64_t revision{};
  std::optional<WalletProfile> hot_profile;
  std::vector<WalletStateAccount> accounts;
  uint32_t initialization_state{};
  bool cleanup_pending{};
  std::optional<uint32_t> active_wallet_index;
  std::vector<WalletDiagnostic> diagnostics;
  const WalletStateAccount *default_account() const noexcept {
    return accounts.empty() ? nullptr : &accounts.front();
  }
};

}  // namespace citizen_sdk

#endif
