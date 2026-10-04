#ifndef CITIZENSDK_LINUX_SECURE_STORE_HPP
#define CITIZENSDK_LINUX_SECURE_STORE_HPP

#include <array>
#include <filesystem>
#include <optional>
#include "citizen_sdk_sqlite.hpp"

namespace citizen_sdk::linux {

struct SecretIdentity final {
  uint32_t wallet_index{};
  uint32_t kind{};
  std::array<uint8_t, 16> generation{};
  std::array<uint8_t, 16> owner{};
  std::array<uint8_t, 32> account_id{};
};

struct WalletKey final {
  uint32_t wallet_index{};
  std::array<uint8_t, 16> generation{};
};

struct VaultObject final {
  Bytes public_blob;
  Bytes private_blob;
  Bytes name;
  Bytes auth_salt;
};

class SecureStore final : public SQLiteStore {
 public:
  static constexpr int64_t kGenerationActive = 1;
  static constexpr int64_t kGenerationRetired = 2;

  explicit SecureStore(const std::filesystem::path &directory);
  HostRecord wallet_profile_load();
  HostRecord wallet_profile_compare_and_swap(uint64_t expected,
                                             const Bytes &candidate);
  // 跨代际只读存在性；错误不能当false，不返回密文或钥。
  bool has_account_secret(const std::array<uint8_t, 32> &account_id);
  bool has_any_wallet_key(uint32_t wallet_index);
  HostRecord encrypted_secret_load(const SecretIdentity &identity);
  HostRecord encrypted_secret_compare_and_swap(const SecretIdentity &identity,
                                               uint64_t expected,
                                               const Bytes &candidate);

  bool ensure_generation(const WalletKey &key,
                         const std::array<uint8_t, 16> &operation_id);
  bool generation_owned_by(const WalletKey &key,
                           const std::array<uint8_t, 16> &operation_id);
  bool is_generation_active(const WalletKey &key);
  void retire_generation(const WalletKey &key,
                         const std::array<uint8_t, 16> &operation_id);
  std::optional<VaultObject> load_vault_object(const WalletKey &key);
  void store_vault_object_if_owned(
      const WalletKey &key, const std::array<uint8_t, 16> &operation_id,
      const VaultObject &object);
  bool vault_object_is_active(const WalletKey &key,
                              const VaultObject &expected);
  void delete_vault_object(const WalletKey &key);

 private:
  HostRecord singleton_compare_and_swap(uint64_t expected,
                                        const Bytes &candidate);
};

}  // namespace citizen_sdk::linux

#endif
