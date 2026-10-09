#ifndef CITIZENSDK_LINUX_TPM2_HPP
#define CITIZENSDK_LINUX_TPM2_HPP

#include <array>
#include <cstdint>
#include "citizen_sdk_secure_store.hpp"
#include "citizen_sdk_sensitive_buffer.hpp"

namespace citizen_sdk::linux {

enum class TpmAvailability { kAvailable, kUnsupported, kUnavailable };

// Internal, side-effect-free classification shared by production check() and
// contract tests. TSS software-layer codes retain the caller's fallback; they
// must never be decoded as a TPM authentication or key-lifecycle response.
struct TpmErrorMapping final {
  citizensdk_error_code_t code;
  bool dictionary_attack_lockout;
};
TpmErrorMapping map_tpm2_error(uint32_t response,
                              citizensdk_error_code_t mapped) noexcept;

class Tpm2 final {
 public:
  TpmAvailability availability() const noexcept;
  VaultObject create_key(const SensitiveBuffer &password) const;
  bool validate_key(const VaultObject &object) const;
  Bytes encrypt_dek(const VaultObject &object,
                    const uint8_t plaintext_dek[32]) const;
  void decrypt_dek(const VaultObject &object, const Bytes &wrapped_dek,
                   const SensitiveBuffer &password,
                   uint8_t plaintext_dek_out[32]) const;

 private:
  static SensitiveBuffer derive_auth(const SensitiveBuffer &password,
                                     const Bytes &salt);
};

}  // namespace citizen_sdk::linux

#endif
