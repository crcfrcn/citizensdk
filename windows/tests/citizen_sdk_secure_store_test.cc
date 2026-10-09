// 来源：Linux secure store 合同测试；仅将权限/文件和 TPM 公开对象改为 Windows 适配。
// 验证 profile/密文隔离、CAS 和 generation 永久退休，不冒充 TPM 硬件测试。
#include <cassert>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <atomic>
#include <limits>
#include <sqlite3.h>

#include "citizen_sdk_secure_store.hpp"
#include "citizen_sdk_record_key.hpp"
#include "citizen_sdk_test_support.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

namespace {

void make_private(const std::filesystem::path &path) {
  citizen_sdk::windows::Directory created(path);
}

void touch(const std::filesystem::path &path) {
  citizen_sdk::windows::Directory directory(path.parent_path());
  auto file = directory.open(path.filename().native(), GENERIC_READ | GENERIC_WRITE, 3);
  assert(file);
}

void verify_private(const std::filesystem::path &directory, const char *name) {
  citizen_sdk::windows::Directory root(directory);
  root.verify();
  auto file = root.open(citizen_sdk::windows::Directory::utf16(name));
  root.verify_file(file.get());
}

void widen_test_file(const std::filesystem::path &path) {
  citizen_sdk::windows::UniqueHandle file(CreateFileW(path.c_str(), WRITE_DAC,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr));
  assert(file);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  assert(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"D:P(A;;FA;;;WD)", SDDL_REVISION_1, &descriptor, nullptr));
  PACL dacl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  assert(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) && present && dacl);
  assert(SetSecurityInfo(file.get(), SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS);
  LocalFree(descriptor);
}


citizen_sdk::windows::VaultObject fixture_object(const citizen_sdk::windows::WalletKey &key) {
  // 这是 store 长度/身份测试的公开元数据，不冒充 CNG RSA 或 TPM 可用性测试。
  using namespace citizen_sdk::windows;
  return {"citizensdk." + record_key::hex(key.generation.data(), key.generation.size()),
          Bytes(283, 9), Bytes(34, 11), Bytes(key.generation.begin(), key.generation.end())};
}

void expect_permission_denied(const std::filesystem::path &directory) {
  bool rejected = false;
  try {
    citizen_sdk::windows::SecureStore store(directory);
  } catch (const citizen_sdk::windows::HostError &error) {
    rejected = error.code() == CITIZENSDK_ERROR_PERMISSION_DENIED;
  }
  assert(rejected);
}

void execute_sql(const std::filesystem::path &database, const char *sql) {
  touch(database);
  sqlite3 *handle = nullptr;
  assert(sqlite3_open_v2(database.u8string().c_str(), &handle,
                         SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
                             SQLITE_OPEN_FULLMUTEX |
                             SQLITE_OPEN_PRIVATECACHE,
                         nullptr) == SQLITE_OK);
  assert(handle != nullptr);
  char *message = nullptr;
  assert(sqlite3_exec(handle, "PRAGMA journal_mode=DELETE", nullptr, nullptr, nullptr) == SQLITE_OK);
  const int code = sqlite3_exec(handle, sql, nullptr, nullptr, &message);
  if (message != nullptr) sqlite3_free(message);
  assert(code == SQLITE_OK);
  assert(sqlite3_close_v2(handle) == SQLITE_OK);
}

std::string read_text_pragma(const std::filesystem::path &database,
                             const char *sql) {
  sqlite3 *handle = nullptr;
  assert(sqlite3_open_v2(database.u8string().c_str(), &handle,
                         SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX |
                             SQLITE_OPEN_PRIVATECACHE,
                         nullptr) == SQLITE_OK);
  assert(handle != nullptr);
  sqlite3_stmt *statement = nullptr;
  assert(sqlite3_prepare_v2(handle, sql, -1, &statement, nullptr) ==
         SQLITE_OK);
  assert(statement != nullptr && sqlite3_step(statement) == SQLITE_ROW);
  const auto *value = sqlite3_column_text(statement, 0);
  assert(value != nullptr);
  const std::string result(reinterpret_cast<const char *>(value));
  assert(sqlite3_step(statement) == SQLITE_DONE);
  assert(sqlite3_finalize(statement) == SQLITE_OK);
  assert(sqlite3_close_v2(handle) == SQLITE_OK);
  return result;
}

void expect_corrupt_profile(const std::filesystem::path &directory) {
  bool rejected = false;
  try {
    citizen_sdk::windows::SecureStore store(directory);
    (void)store.wallet_profile_load();
  } catch (const citizen_sdk::windows::HostError &error) {
    rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY;
  }
  assert(rejected);
}

void expect_integrity_on_open(const std::filesystem::path &directory) {
  bool rejected = false;
  try {
    citizen_sdk::windows::SecureStore store(directory);
  } catch (const citizen_sdk::windows::HostError &error) {
    rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY;
  }
  assert(rejected);
}

}  // namespace


namespace {
void secret_presence_contract() {
  using namespace citizen_sdk::windows;
  test::TempDirectory temporary("secret-presence");
  SecureStore store(temporary.path() / "state");
  const auto decode = [](const std::string &hex) {
    Bytes result;
    for (std::size_t i = 0; i < hex.size(); i += 2)
      result.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
    return result;
  };
  // 独立CSHR合成金标，Rust host_codec测试同时逐字节核对；没有真实秘密。
  const auto sealed = decode("43534852010038000500000000000000b8000000000000009481a10e6546da63b1c160907fb48acbfa35c6ffdee717bfd4a0094b3d9e57b901000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d");
  const auto tombstone = decode("43534852010038000500000000000000600000000000000017b5fd919396d702e90558844acef60fb5a38a41f42bdfa34a449075559ce09101000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010200000000000000030e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e");
  const auto second = decode("43534852010038000500000000000000b800000000000000bbf644dec5dde868148f6f1ffe1151f121f1de7e78e2b7ecd7c9e35e0cdd48a501000700000058585858585858585858585858585858090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d");
  SecretIdentity identity{}; identity.wallet_index = 7; identity.kind = 1;
  identity.generation.fill(8); identity.owner.fill(9); identity.account_id.fill(10);
  assert(!store.has_account_secret(identity.account_id));
  assert(store.encrypted_secret_compare_and_swap(identity, 0, sealed).error_code == CITIZENSDK_OK);
  assert(store.has_account_secret(identity.account_id));
  auto foreign = identity.account_id; foreign[0] = 11;
  assert(!store.has_account_secret(foreign));
  assert(store.encrypted_secret_compare_and_swap(identity, 1, tombstone).error_code == CITIZENSDK_OK);
  assert(!store.has_account_secret(identity.account_id));
  identity.generation.fill(88);
  assert(store.encrypted_secret_compare_and_swap(identity, 0, second).error_code == CITIZENSDK_OK);
  assert(store.has_account_secret(identity.account_id));
  SecureStore isolated(temporary.path() / "isolated");
  assert(!isolated.has_account_secret(identity.account_id));
  assert(isolated.encrypted_secret_compare_and_swap(identity, 0, Bytes{1}).error_code == CITIZENSDK_OK);
  bool rejected = false;
  try { (void)isolated.has_account_secret(foreign); } catch (const HostError &) { rejected = true; }
  assert(rejected && isolated.encrypted_secret_load(identity).record == Bytes{1}); // 坏记录不能被错账户过滤成false。
  store.close();
  rejected = false;
  try { (void)store.has_account_secret(identity.account_id); } catch (const HostError &) { rejected = true; }
  assert(rejected);
}
}  // namespace

int main() {
  secret_presence_contract();
  using namespace citizen_sdk::windows;

  citizen_sdk::windows::test::TempDirectory temporary("secure-store");
  const auto directory = temporary.path() / "state";
  {
    SecureStore store(directory);
    assert(!store.wallet_profile_load().present);
    const auto profile =
        store.wallet_profile_compare_and_swap(0, Bytes{1, 2, 3});
    assert(profile.present && profile.revision == 1);
    assert(store.wallet_profile_compare_and_swap(0, Bytes{4}).error_code ==
           CITIZENSDK_ERROR_CONFLICT);

    SecretIdentity first{};
    first.kind = CITIZENSDK_HOST_SECRET_ACCOUNT_MINI_SECRET;
    first.generation[0] = 1;
    first.owner[0] = 2;
    first.account_id[0] = 3;
    SecretIdentity second = first;
    second.owner[0] = 4;
    const auto secret =
        store.encrypted_secret_compare_and_swap(first, 0, Bytes{5, 6});
    assert(secret.present && secret.revision == 1);
    assert((store.encrypted_secret_load(first).record == Bytes{5, 6}));
    assert(!store.encrypted_secret_load(second).present);

    WalletKey key{};
    key.generation = first.generation;
    std::array<uint8_t, 16> provision{};
    provision[0] = 7;
    std::array<uint8_t, 16> stranger{};
    stranger[0] = 8;
    assert(store.ensure_generation(key, provision));
    assert(store.ensure_generation(key, provision));
    assert(!store.ensure_generation(key, stranger));
    assert(store.is_generation_active(key));
    assert(store.generation_owned_by(key, provision));
    assert(!store.generation_owned_by(key, stranger));

    auto invalid_object = fixture_object(key);
    invalid_object.public_blob.resize(280);
    bool invalid_object_rejected = false;
    try {
      store.store_vault_object_if_owned(
          key, provision,
          invalid_object);
    } catch (const HostError &error) {
      invalid_object_rejected =
          error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
    }
    assert(invalid_object_rejected);
    VaultObject object = fixture_object(key);
    for (unsigned invalid = 0; invalid < 6; ++invalid) {
      auto malformed = object;
      if (invalid == 0) malformed.key_name[0] = 'x';
      if (invalid == 1) malformed.key_name.back() = 'X';
      if (invalid == 2) malformed.public_blob.resize(289);
      if (invalid == 3) malformed.name.clear();
      if (invalid == 4) malformed.name.resize(1025);
      if (invalid == 5) malformed.auth_salt[0] ^= 1;
      bool rejected = false;
      try { store.store_vault_object_if_owned(key, provision, malformed); }
      catch (const HostError &error) { rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT; }
      assert(rejected && !store.load_vault_object(key));
    }
    bool stranger_write_rejected = false;
    try {
      store.store_vault_object_if_owned(key, stranger, object);
    } catch (const HostError &error) {
      stranger_write_rejected =
          error.code() == CITIZENSDK_ERROR_KEY_INVALIDATED;
    }
    assert(stranger_write_rejected);
    store.store_vault_object_if_owned(key, provision, object);
    const auto loaded = store.load_vault_object(key);
    assert(loaded.has_value());
    assert(loaded->public_blob == object.public_blob);
    assert(loaded->key_name == object.key_name);
    assert(loaded->name == object.name);
    assert(loaded->auth_salt == object.auth_salt);
    assert(store.vault_object_is_active(key, object));
    bool overwrite_rejected = false;
    try { store.store_vault_object_if_owned(key, provision, object); }
    catch (const HostError &error) { overwrite_rejected = error.code() == CITIZENSDK_ERROR_STORAGE; }
    assert(overwrite_rejected && store.vault_object_is_active(key, object));
    VaultObject different = object;
    different.auth_salt[0] ^= 0xff;
    assert(!store.vault_object_is_active(key, different));

    store.retire_generation(key, stranger);
    assert(!store.is_generation_active(key));
    assert(!store.generation_owned_by(key, provision));
    assert(!store.ensure_generation(key, provision));
    assert(!store.vault_object_is_active(key, object));
    bool late_write_rejected = false;
    try {
      store.store_vault_object_if_owned(key, provision, object);
    } catch (const HostError &error) {
      late_write_rejected =
          error.code() == CITIZENSDK_ERROR_KEY_INVALIDATED;
    }
    assert(late_write_rejected);
    store.delete_vault_object(key);
    assert(!store.load_vault_object(key).has_value());

    verify_private(directory, "secure-state-v1.sqlite3");
    verify_private(directory, "secure-state-v1.sqlite3-wal");
    verify_private(directory, "secure-state-v1.sqlite3-shm");
  }

  // 对象删除后墓碑仍须跨连接/重开永久保留，不能因重试复活同 generation。
  {
    SecureStore reopened(directory);
    WalletKey retired{};
    retired.generation[0] = 1;
    std::array<uint8_t, 16> operation{};
    operation[0] = 7;
    assert(!reopened.ensure_generation(retired, operation));
    assert(!reopened.is_generation_active(retired));
    assert(!reopened.load_vault_object(retired));
    assert((reopened.wallet_profile_load().record == Bytes{1, 2, 3}));
    assert(reopened.wallet_profile_compare_and_swap(std::numeric_limits<uint64_t>::max(), Bytes{0}).error_code ==
           CITIZENSDK_ERROR_CONFLICT);
  }

  const auto database_directory = temporary.path() / "secure-db-directory";
  make_private(database_directory);
  make_private(database_directory /
                                    "secure-state-v1.sqlite3");
  expect_permission_denied(database_directory);

  const auto database_hardlink = temporary.path() / "secure-db-hardlink";
  make_private(database_hardlink);
  const auto hardlink_source = temporary.path() / "secure-hardlink-source";
  touch(hardlink_source);
  std::filesystem::create_hard_link(
      hardlink_source, database_hardlink / "secure-state-v1.sqlite3");
  expect_permission_denied(database_hardlink);

  for (const char *companion : {"-journal", "-wal", "-shm"}) {
    const auto companion_directory_state =
        temporary.path() /
        (std::string("secure-companion-directory") + companion + "-state");
    make_private(companion_directory_state);
    make_private(
        companion_directory_state /
            (std::string("secure-state-v1.sqlite3") + companion));
    expect_permission_denied(companion_directory_state);

    const auto companion_hardlink_state =
        temporary.path() /
        (std::string("secure-companion-hardlink") + companion + "-state");
    make_private(companion_hardlink_state);
    const auto companion_hardlink_source =
        temporary.path() /
        (std::string("secure-companion-hardlink") + companion + "-source");
    touch(companion_hardlink_source);
    std::filesystem::create_hard_link(
        companion_hardlink_source,
        companion_hardlink_state /
            (std::string("secure-state-v1.sqlite3") + companion));
    expect_permission_denied(companion_hardlink_state);
  }

  const auto unsafe_state = temporary.path() / "secure-unsafe-state";
  make_private(unsafe_state);
  const auto unsafe_database = unsafe_state / "secure-state-v1.sqlite3";
  touch(unsafe_database);
  widen_test_file(unsafe_database);
  expect_permission_denied(unsafe_state);

  const auto bound_state = temporary.path() / "secure-bound-state";
  const auto bound_identity =
      temporary.path() / "secure-bound-state-original";
  SecretIdentity bound_secret{};
  bound_secret.generation[0] = 1;
  bound_secret.owner[0] = 2;
  bound_secret.account_id[0] = 3;
  {
    SecureStore store(bound_state);
    (void)store.wallet_profile_compare_and_swap(0, Bytes{21});
    std::error_code rename_error;
    std::filesystem::rename(bound_state, bound_identity, rename_error);
    assert(rename_error);
    const auto persisted =
        store.encrypted_secret_compare_and_swap(bound_secret, 0, Bytes{22});
    assert(persisted.error_code == CITIZENSDK_OK && persisted.revision == 1);
  }
  std::filesystem::rename(bound_state, bound_identity);
  {
    SecureStore store(bound_identity);
    assert((store.wallet_profile_load().record == Bytes{21}));
    assert((store.encrypted_secret_load(bound_secret).record == Bytes{22}));
  }

  const auto wrong_schema = temporary.path() / "wrong-secure-schema";
  make_private(wrong_schema);
  execute_sql(wrong_schema / "secure-state-v1.sqlite3",
              "CREATE TABLE wallet_profile(wallet_index INTEGER PRIMARY KEY);");
  expect_integrity_on_open(wrong_schema);
  assert(read_text_pragma(wrong_schema / "secure-state-v1.sqlite3",
                          "PRAGMA journal_mode") == "delete");

  const auto extra_schema = temporary.path() / "extra-secure-schema";
  {
    SecureStore store(extra_schema);
  }
  execute_sql(extra_schema / "secure-state-v1.sqlite3",
              "CREATE TABLE unexpected_secret(value BLOB);");
  expect_integrity_on_open(extra_schema);

  const auto disguised_table = temporary.path() / "sqlitex-secure-table";
  { SecureStore store(disguised_table); }
  execute_sql(disguised_table / "secure-state-v1.sqlite3",
              "CREATE TABLE sqlitex_extra(value BLOB);");
  expect_integrity_on_open(disguised_table);
  const auto disguised_trigger = temporary.path() / "sqlitex-secure-trigger";
  { SecureStore store(disguised_trigger); }
  execute_sql(disguised_trigger / "secure-state-v1.sqlite3",
              "CREATE TRIGGER sqlitex_extra AFTER INSERT ON wallet_profile BEGIN SELECT 1; END;");
  expect_integrity_on_open(disguised_trigger);

  const auto corrupt_revision = temporary.path() / "secure-corrupt-revision";
  {
    SecureStore store(corrupt_revision);
    (void)store.wallet_profile_compare_and_swap(0, Bytes{1});
  }
  execute_sql(corrupt_revision / "secure-state-v1.sqlite3",
              "PRAGMA ignore_check_constraints=ON;"
              "UPDATE wallet_profile SET revision=0;");
  expect_corrupt_profile(corrupt_revision);

  const auto corrupt_blob = temporary.path() / "secure-corrupt-blob";
  {
    SecureStore store(corrupt_blob);
    (void)store.wallet_profile_compare_and_swap(0, Bytes{1});
  }
  execute_sql(corrupt_blob / "secure-state-v1.sqlite3",
              "PRAGMA ignore_check_constraints=ON;"
              "UPDATE wallet_profile SET record='not-a-blob';");
  expect_corrupt_profile(corrupt_blob);

  // 两个独立 store 连接同时 provision/retire 时，SQLite 事务顺序无论
  // 哪一方先线性化，最终 generation 都必须退休且对象不可再使用。
  const auto concurrent_state = temporary.path() / "secure-generation-race";
  SecureStore provisioning_store(concurrent_state);
  SecureStore retirement_store(concurrent_state);
  WalletKey concurrent_key{};
  concurrent_key.generation[0] = 33;
  std::array<uint8_t, 16> concurrent_operation{};
  concurrent_operation[0] = 44;
  assert(provisioning_store.ensure_generation(concurrent_key,
                                              concurrent_operation));
  const VaultObject concurrent_object = fixture_object(concurrent_key);
  std::mutex race_lock;
  std::condition_variable race_ready;
  std::size_t ready = 0;
  bool proceed = false;
  int provisioning_result = CITIZENSDK_OK;
  int retirement_result = CITIZENSDK_OK;
  const auto await_start = [&] {
    std::unique_lock<std::mutex> guard(race_lock);
    ++ready;
    race_ready.notify_all();
    race_ready.wait(guard, [&] { return proceed; });
  };
  std::thread provision([&] {
    await_start();
    try {
      provisioning_store.store_vault_object_if_owned(
          concurrent_key, concurrent_operation, concurrent_object);
    } catch (const HostError &error) {
      provisioning_result = error.code();
    } catch (...) {
      provisioning_result = -1;
    }
  });
  std::thread retire([&] {
    await_start();
    try {
      retirement_store.retire_generation(concurrent_key,
                                         concurrent_operation);
    } catch (const HostError &error) {
      retirement_result = error.code();
    } catch (...) {
      retirement_result = -1;
    }
  });
  {
    std::unique_lock<std::mutex> guard(race_lock);
    race_ready.wait(guard, [&] { return ready == 2; });
    proceed = true;
  }
  race_ready.notify_all();
  provision.join();
  retire.join();
  assert(retirement_result == CITIZENSDK_OK);
  assert(provisioning_result == CITIZENSDK_OK ||
         provisioning_result == CITIZENSDK_ERROR_KEY_INVALIDATED);
  assert(!provisioning_store.is_generation_active(concurrent_key));
  assert(!provisioning_store.vault_object_is_active(concurrent_key,
                                                     concurrent_object));
  bool concurrent_late_write_rejected = false;
  try {
    provisioning_store.store_vault_object_if_owned(
        concurrent_key, concurrent_operation, concurrent_object);
  } catch (const HostError &error) {
    concurrent_late_write_rejected =
        error.code() == CITIZENSDK_ERROR_KEY_INVALIDATED;
  }
  assert(concurrent_late_write_rejected);
  return 0;
}
