#include "citizen_sdk_secure_store.hpp"

#include <algorithm>
#include <limits>
#include "citizen_sdk_record_key.hpp"
#include "citizensdk.h"

namespace citizen_sdk::linux {
namespace {

std::string secret_key(const SecretIdentity &identity) {
  return record_key::secret(identity.wallet_index, identity.kind,
                            identity.generation, identity.owner,
                            identity.account_id);
}

std::string generation_key(const WalletKey &key) {
  return record_key::generation(key.wallet_index, key.generation);
}

Bytes array_bytes(const std::array<uint8_t, 16> &value) {
  return Bytes(value.begin(), value.end());
}

bool same_object(const VaultObject &left, const VaultObject &right) noexcept {
  return left.public_blob == right.public_blob &&
         left.private_blob == right.private_blob && left.name == right.name &&
         left.auth_salt == right.auth_salt;
}

}  // namespace

SecureStore::SecureStore(const std::filesystem::path &directory)
    : SQLiteStore(directory, "secure-state-v1.sqlite3",
                  {"CREATE TABLE IF NOT EXISTS wallet_profile ("
                   "wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), "
                   "revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), "
                   "record BLOB NOT NULL "
                   "CHECK(typeof(record) = 'blob' AND length(record) <= 1048576)))",
                   "CREATE TABLE IF NOT EXISTS encrypted_secret ("
                   "record_key TEXT PRIMARY KEY, revision INTEGER NOT NULL "
                   "CHECK(typeof(revision) = 'integer' AND revision > 0), "
                   "record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 65536)))",
                   "CREATE TABLE IF NOT EXISTS vault_generation ("
                   "record_key TEXT PRIMARY KEY, wallet_index INTEGER NOT NULL "
                   "CHECK(typeof(wallet_index) = 'integer' AND wallet_index >= 0), "
                   "generation BLOB NOT NULL CHECK(typeof(generation) = 'blob' AND length(generation) = 16), "
                   "state INTEGER NOT NULL CHECK(typeof(state) = 'integer' AND state IN (1,2)), "
                   "operation_id BLOB NOT NULL CHECK(typeof(operation_id) = 'blob' AND length(operation_id) = 16)))",
                   "CREATE TABLE IF NOT EXISTS vault_object ("
                   "record_key TEXT PRIMARY KEY, public_blob BLOB NOT NULL "
                   "CHECK(typeof(public_blob) = 'blob' AND length(public_blob) BETWEEN 1 AND 8192), "
                   "private_blob BLOB NOT NULL CHECK(typeof(private_blob) = 'blob' AND length(private_blob) BETWEEN 1 AND 8192), "
                   "object_name BLOB NOT NULL CHECK(typeof(object_name) = 'blob' AND length(object_name) = 34), "
                   "auth_salt BLOB NOT NULL CHECK(typeof(auth_salt) = 'blob' AND length(auth_salt) = 16)))"},
                  true) {}

HostRecord SecureStore::wallet_profile_load() {
  return read([&](sqlite3 *database) {
    Statement statement(database,
                        "SELECT revision, record FROM wallet_profile "
                        "WHERE wallet_index = 0");
    if (statement.step_row_or_done()) {
      const int64_t revision = statement.integer(
          0, 1, std::numeric_limits<int64_t>::max());
      return HostRecord::value(
          CITIZENSDK_HOST_RECORD_WALLET_PROFILE,
          static_cast<uint64_t>(revision),
          statement.bytes(1, 1048576));
    }
    return HostRecord::absent(CITIZENSDK_HOST_RECORD_WALLET_PROFILE);
  });
}


bool SecureStore::has_account_secret(const std::array<uint8_t, 32> &account_id) {
  return read([&](sqlite3 *database) {
    // 扫描本SDK命名空间的完整记录，不以某个代际未命中代替不存在；每次只持有一条密文。
    Statement query(database, "SELECT revision, record FROM encrypted_secret LIMIT 65537");
    citizensdk_account_id_t account{};
    std::copy(account_id.begin(), account_id.end(), account.bytes);
    std::size_t count = 0;
    while (query.step_row_or_done()) {
      require(++count <= 65536, CITIZENSDK_ERROR_UNAVAILABLE, "秘密存在性查询超过条数上限");
      const auto revision = query.integer(0, 1, std::numeric_limits<int64_t>::max());
      const auto record = query.bytes(1, 65536);
      uint8_t present = 0;
      const auto code = citizensdk_encrypted_secret_record_has_secret(&account, static_cast<uint64_t>(revision),
          {record.data(), record.size()}, &present);
      require(code == CITIZENSDK_OK, code, "秘密存在性记录检查失败");
      if (present == 1) return true;
    }
    return false;
  });
}

bool SecureStore::has_any_wallet_key(uint32_t wallet_index) {
  return read([&](sqlite3 *database) {
    // Linux物理TPM钥由sealed对象本体承载；退休标志不能掩盖尚未删除的对象。
    Statement query(database,
        "SELECT o.record_key, g.wallet_index, g.generation FROM vault_object o "
        "LEFT JOIN vault_generation g ON g.record_key = o.record_key LIMIT 65537");
    std::size_t count = 0;
    while (query.step_row_or_done()) {
      require(++count <= 65536, CITIZENSDK_ERROR_UNAVAILABLE, "金库对象查询超过条数上限");
      WalletKey key{};
      key.wallet_index = static_cast<uint32_t>(query.integer(1, 0, UINT32_MAX));
      const auto generation = query.bytes(2, 16);
      require(generation.size() == 16, CITIZENSDK_ERROR_INTEGRITY, "孤立金库对象不能证明归属");
      std::copy(generation.begin(), generation.end(), key.generation.begin());
      require(query.text(0, 64) == generation_key(key), CITIZENSDK_ERROR_INTEGRITY, "金库对象主键与事实不符");
      if (key.wallet_index == wallet_index) return true;
    }
    return false;
  });
}

HostRecord SecureStore::wallet_profile_compare_and_swap(
    uint64_t expected, const Bytes &candidate) {
  return singleton_compare_and_swap(expected, candidate);
}

HostRecord SecureStore::singleton_compare_and_swap(uint64_t expected,
                                                    const Bytes &candidate) {
  require(candidate.size() <= 1048576, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK wallet profile is too large");
  if (expected >= static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    return HostRecord::failure(CITIZENSDK_HOST_RECORD_WALLET_PROFILE,
                               CITIZENSDK_ERROR_CONFLICT);
  }
  return transaction([&](sqlite3 *database) {
    Statement query(database,
                    "SELECT revision FROM wallet_profile WHERE wallet_index = 0");
    uint64_t actual = 0;
    if (query.step_row_or_done()) {
      const int64_t revision = query.integer(
          0, 1, std::numeric_limits<int64_t>::max());
      actual = static_cast<uint64_t>(revision);
    }
    if (actual != expected) {
      return HostRecord::failure(CITIZENSDK_HOST_RECORD_WALLET_PROFILE,
                                 CITIZENSDK_ERROR_CONFLICT);
    }
    const uint64_t next = expected + 1;
    Statement write(database,
                    "INSERT OR REPLACE INTO wallet_profile"
                    "(wallet_index, revision, record) VALUES(0, ?, ?)");
    write.bind(1, static_cast<int64_t>(next));
    write.bind(2, candidate);
    write.step_done();
    return HostRecord::value(CITIZENSDK_HOST_RECORD_WALLET_PROFILE, next,
                             candidate);
  });
}

HostRecord SecureStore::encrypted_secret_load(const SecretIdentity &identity) {
  const std::string key = secret_key(identity);
  return read([&](sqlite3 *database) {
    Statement statement(database,
                        "SELECT revision, record FROM encrypted_secret "
                        "WHERE record_key = ?");
    statement.bind(1, key);
    if (statement.step_row_or_done()) {
      const int64_t revision = statement.integer(
          0, 1, std::numeric_limits<int64_t>::max());
      return HostRecord::value(
          CITIZENSDK_HOST_RECORD_ENCRYPTED_SECRET_BLOB,
          static_cast<uint64_t>(revision),
          statement.bytes(1, 65536));
    }
    return HostRecord::absent(CITIZENSDK_HOST_RECORD_ENCRYPTED_SECRET_BLOB);
  });
}

HostRecord SecureStore::encrypted_secret_compare_and_swap(
    const SecretIdentity &identity, uint64_t expected,
    const Bytes &candidate) {
  require(candidate.size() <= 65536, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK encrypted secret is too large");
  if (expected >= static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    return HostRecord::failure(CITIZENSDK_HOST_RECORD_ENCRYPTED_SECRET_BLOB,
                               CITIZENSDK_ERROR_CONFLICT);
  }
  const std::string key = secret_key(identity);
  return transaction([&](sqlite3 *database) {
    Statement query(database,
                    "SELECT revision FROM encrypted_secret WHERE record_key = ?");
    query.bind(1, key);
    uint64_t actual = 0;
    if (query.step_row_or_done()) {
      const int64_t revision = query.integer(
          0, 1, std::numeric_limits<int64_t>::max());
      actual = static_cast<uint64_t>(revision);
    }
    if (actual != expected) {
      return HostRecord::failure(CITIZENSDK_HOST_RECORD_ENCRYPTED_SECRET_BLOB,
                                 CITIZENSDK_ERROR_CONFLICT);
    }
    const uint64_t next = expected + 1;
    Statement write(database,
                    "INSERT OR REPLACE INTO encrypted_secret"
                    "(record_key, revision, record) VALUES(?, ?, ?)");
    write.bind(1, key);
    write.bind(2, static_cast<int64_t>(next));
    write.bind(3, candidate);
    write.step_done();
    return HostRecord::value(CITIZENSDK_HOST_RECORD_ENCRYPTED_SECRET_BLOB,
                             next, candidate);
  });
}

bool SecureStore::ensure_generation(
    const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  const std::string identity = generation_key(key);
  const Bytes operation(operation_id.begin(), operation_id.end());
  return transaction([&](sqlite3 *database) {
    Statement query(database,
                    "SELECT state, operation_id, wallet_index, generation "
                    "FROM vault_generation "
                    "WHERE record_key = ?");
    query.bind(1, identity);
    if (query.step_row_or_done()) {
      const int64_t state = query.integer(
          0, kGenerationActive, kGenerationRetired);
      const Bytes stored_operation = query.bytes(1, 16);
      const int64_t wallet_index = query.integer(
          2, 0, std::numeric_limits<uint32_t>::max());
      const Bytes generation = query.bytes(3, 16);
      require(stored_operation.size() == 16 && generation.size() == 16 &&
                  static_cast<uint64_t>(wallet_index) == key.wallet_index &&
                  std::equal(generation.begin(), generation.end(),
                             key.generation.begin()),
              CITIZENSDK_ERROR_INTEGRITY,
              "CitizenSDK vault generation identity is corrupt");
      return state == kGenerationActive && stored_operation == operation;
    }
    Statement write(database,
                    "INSERT INTO vault_generation"
                    "(record_key, wallet_index, generation, state, operation_id) "
                    "VALUES(?, ?, ?, ?, ?)");
    write.bind(1, identity);
    write.bind(2, static_cast<int64_t>(key.wallet_index));
    write.bind(3, array_bytes(key.generation));
    write.bind(4, kGenerationActive);
    write.bind(5, operation);
    write.step_done();
    return true;
  });
}

bool SecureStore::is_generation_active(const WalletKey &key) {
  const std::string identity = generation_key(key);
  return read([&](sqlite3 *database) {
    Statement query(database,
                    "SELECT state, wallet_index, generation "
                    "FROM vault_generation WHERE record_key = ?");
    query.bind(1, identity);
    if (!query.step_row_or_done()) return false;
    const int64_t state = query.integer(
        0, kGenerationActive, kGenerationRetired);
    const int64_t wallet_index = query.integer(
        1, 0, std::numeric_limits<uint32_t>::max());
    const Bytes generation = query.bytes(2, 16);
    require(generation.size() == 16 &&
                static_cast<uint64_t>(wallet_index) == key.wallet_index &&
                std::equal(generation.begin(), generation.end(),
                           key.generation.begin()),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK vault generation identity is corrupt");
    return state == kGenerationActive;
  });
}

bool SecureStore::generation_owned_by(
    const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  const std::string identity = generation_key(key);
  const Bytes expected_operation(operation_id.begin(), operation_id.end());
  return read([&](sqlite3 *database) {
    Statement query(database,
                    "SELECT state, operation_id, wallet_index, generation "
                    "FROM vault_generation WHERE record_key = ?");
    query.bind(1, identity);
    if (!query.step_row_or_done()) return false;
    const int64_t state = query.integer(
        0, kGenerationActive, kGenerationRetired);
    const Bytes stored_operation = query.bytes(1, 16);
    const int64_t wallet_index = query.integer(
        2, 0, std::numeric_limits<uint32_t>::max());
    const Bytes generation = query.bytes(3, 16);
    require(stored_operation.size() == 16 && generation.size() == 16 &&
                static_cast<uint64_t>(wallet_index) == key.wallet_index &&
                std::equal(generation.begin(), generation.end(),
                           key.generation.begin()),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK vault generation identity is corrupt");
    return state == kGenerationActive &&
           stored_operation == expected_operation;
  });
}

void SecureStore::retire_generation(
    const WalletKey &key, const std::array<uint8_t, 16> &operation_id) {
  const std::string identity = generation_key(key);
  (void)transaction([&](sqlite3 *database) {
    Statement write(database,
                    "INSERT OR REPLACE INTO vault_generation"
                    "(record_key, wallet_index, generation, state, operation_id) "
                    "VALUES(?, ?, ?, ?, ?)");
    write.bind(1, identity);
    write.bind(2, static_cast<int64_t>(key.wallet_index));
    write.bind(3, array_bytes(key.generation));
    write.bind(4, kGenerationRetired);
    write.bind(5, Bytes(operation_id.begin(), operation_id.end()));
    write.step_done();
    return true;
  });
}

std::optional<VaultObject> SecureStore::load_vault_object(const WalletKey &key) {
  const std::string identity = generation_key(key);
  return read([&](sqlite3 *database) -> std::optional<VaultObject> {
    Statement query(database,
                    "SELECT public_blob, private_blob, object_name, auth_salt "
                    "FROM vault_object WHERE record_key = ?");
    query.bind(1, identity);
    if (!query.step_row_or_done()) return std::nullopt;
    VaultObject object{query.bytes(0, 8192), query.bytes(1, 8192),
                       query.bytes(2, 34), query.bytes(3, 16)};
    require(object.auth_salt.size() == 16 && !object.public_blob.empty() &&
                !object.private_blob.empty() && object.name.size() == 34,
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK TPM object state is corrupt");
    return object;
  });
}

void SecureStore::store_vault_object_if_owned(
    const WalletKey &key, const std::array<uint8_t, 16> &operation_id,
    const VaultObject &object) {
  require(!object.public_blob.empty() && object.public_blob.size() <= 8192 &&
              !object.private_blob.empty() && object.private_blob.size() <= 8192 &&
              object.name.size() == 34 &&
              object.auth_salt.size() == 16,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK TPM object state violates its schema bounds");
  const std::string identity = generation_key(key);
  const Bytes expected_operation(operation_id.begin(), operation_id.end());
  (void)transaction([&](sqlite3 *database) {
    Statement generation_query(
        database,
        "SELECT state, operation_id, wallet_index, generation "
        "FROM vault_generation WHERE record_key = ?");
    generation_query.bind(1, identity);
    require(generation_query.step_row_or_done(),
            CITIZENSDK_ERROR_KEY_INVALIDATED,
            "CitizenSDK vault generation disappeared during provisioning");
    const int64_t state = generation_query.integer(
        0, kGenerationActive, kGenerationRetired);
    const Bytes stored_operation = generation_query.bytes(1, 16);
    const int64_t wallet_index = generation_query.integer(
        2, 0, std::numeric_limits<uint32_t>::max());
    const Bytes generation = generation_query.bytes(3, 16);
    require(stored_operation.size() == 16 && generation.size() == 16 &&
                static_cast<uint64_t>(wallet_index) == key.wallet_index &&
                std::equal(generation.begin(), generation.end(),
                           key.generation.begin()),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK vault generation identity is corrupt");
    require(state == kGenerationActive &&
                stored_operation == expected_operation,
            CITIZENSDK_ERROR_KEY_INVALIDATED,
            "CitizenSDK vault generation was retired during provisioning");
    require(!generation_query.step_row_or_done(),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK vault generation identity is ambiguous");
    Statement write(database,
                    "INSERT INTO vault_object"
                    "(record_key, public_blob, private_blob, object_name, auth_salt) "
                    "VALUES(?, ?, ?, ?, ?)");
    write.bind(1, identity);
    write.bind(2, object.public_blob);
    write.bind(3, object.private_blob);
    write.bind(4, object.name);
    write.bind(5, object.auth_salt);
    write.step_done();
    return true;
  });
}

bool SecureStore::vault_object_is_active(const WalletKey &key,
                                         const VaultObject &expected) {
  const std::string identity = generation_key(key);
  return read([&](sqlite3 *database) {
    Statement query(
        database,
        "SELECT g.state, g.wallet_index, g.generation, o.public_blob, "
        "o.private_blob, o.object_name, o.auth_salt "
        "FROM vault_generation AS g JOIN vault_object AS o "
        "ON o.record_key = g.record_key WHERE g.record_key = ?");
    query.bind(1, identity);
    if (!query.step_row_or_done()) return false;
    const int64_t state = query.integer(
        0, kGenerationActive, kGenerationRetired);
    const int64_t wallet_index = query.integer(
        1, 0, std::numeric_limits<uint32_t>::max());
    const Bytes generation = query.bytes(2, 16);
    require(generation.size() == 16 &&
                static_cast<uint64_t>(wallet_index) == key.wallet_index &&
                std::equal(generation.begin(), generation.end(),
                           key.generation.begin()),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK vault generation identity is corrupt");
    VaultObject stored{query.bytes(3, 8192), query.bytes(4, 8192),
                       query.bytes(5, 34), query.bytes(6, 16)};
    require(!stored.public_blob.empty() && !stored.private_blob.empty() &&
                stored.name.size() == 34 && stored.auth_salt.size() == 16,
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK TPM object state is corrupt");
    return state == kGenerationActive && same_object(stored, expected);
  });
}

void SecureStore::delete_vault_object(const WalletKey &key) {
  const std::string identity = generation_key(key);
  (void)transaction([&](sqlite3 *database) {
    Statement erase(database, "DELETE FROM vault_object WHERE record_key = ?");
    erase.bind(1, identity);
    erase.step_done();
    return true;
  });
}

}  // namespace citizen_sdk::linux
