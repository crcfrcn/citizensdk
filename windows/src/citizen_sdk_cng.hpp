#ifndef CITIZENSDK_WINDOWS_CNG_HPP
#define CITIZENSDK_WINDOWS_CNG_HPP

#include <cstdint>
#include <optional>
#include <string>
#include "citizen_sdk_secure_store.hpp"
#include "citizen_sdk_sensitive_buffer.hpp"

namespace citizen_sdk::windows {

enum class CngAvailability { kAvailable, kUnsupported, kUnavailable };

struct CngErrorMapping final {
  citizensdk_error_code_t code;
  bool dictionary_attack_lockout;
};
CngErrorMapping map_cng_error(uint32_t status,
                              citizensdk_error_code_t failure) noexcept;

// 生产与测试共用的属性校验；这些值不包含 TPM 授权或钱包秘密。
struct CngKeyProperties final {
  uint32_t length{};
  uint32_t key_type{};
  uint32_t key_usage{};
  uint32_t export_policy{};
  uint32_t pcp_key_usage{};
  bool password_required{};
  bool export_allowed{};
};
void validate_cng_key_properties(const CngKeyProperties &properties);
void validate_cng_public_blob(const Bytes &public_blob);
std::string cng_key_name(const WalletKey &key);

// 仅 Windows 私有 Host 适配。CNG 管理 TPM RSA KEK，不接触 sr25519 私钥。
// 生产创建/删除调用者必须持同一 GenerationLock，并在锁内核验 SQLite owner/墓碑。
class Cng final {
 public:
  CngAvailability availability() const noexcept;
  VaultObject create_key(const WalletKey &key,
                         const SensitiveBuffer &password) const;
  bool validate_key(const VaultObject &object) const;
  Bytes encrypt_dek(const VaultObject &object,
                    const uint8_t plaintext_dek[32]) const;
  void decrypt_dek(const VaultObject &object, const Bytes &wrapped_dek,
                   const SensitiveBuffer &password,
                   uint8_t plaintext_dek_out[32]) const;
  void delete_key(const WalletKey &key,
                   const std::optional<VaultObject> &expected) const;
};

}  // namespace citizen_sdk::windows
#endif
