// 来源：Linux public store 用例；Windows DACL/HANDLE/锁差异显式适配。验证 public store 忠实实现根 ABI 的 revision CAS 与 domain 隔离。
#include <cassert>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <atomic>
#include <limits>
#include <thread>
#include <sqlite3.h>

#include "citizen_sdk_public_store.hpp"
#include "citizen_sdk_test_support.hpp"

#ifndef CITIZENSDK_WINDOWS_TEST_SOURCE_DIR
#error "CITIZENSDK_WINDOWS_TEST_SOURCE_DIR must point at the Windows source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

namespace {

using TestBytes = citizen_sdk::windows::Bytes;

void append_u32(TestBytes &bytes, uint32_t value) {
  for (int shift = 0; shift < 32; shift += 8) bytes.push_back(static_cast<uint8_t>(value >> shift));
}
void append_u64(TestBytes &bytes, uint64_t value) {
  for (int shift = 0; shift < 64; shift += 8) bytes.push_back(static_cast<uint8_t>(value >> shift));
}
TestBytes history_index_query() {
  TestBytes bytes{'T', 'H', 'Q', '1', 1};
  append_u64(bytes, std::numeric_limits<uint64_t>::max());
  append_u32(bytes, 0); bytes.insert(bytes.end(), 16, 0); bytes.push_back(0);
  append_u64(bytes, 0); bytes.insert(bytes.end(), 16, 0);
  return bytes;
}
TestBytes history_record_query(uint64_t revision, uint8_t identity) {
  TestBytes bytes{'T', 'H', 'Q', '1', 2};
  append_u64(bytes, revision); append_u32(bytes, 1);
  bytes.push_back(identity); bytes.insert(bytes.end(), 15, 0); bytes.push_back(0);
  append_u64(bytes, 0); bytes.insert(bytes.end(), 16, 0);
  return bytes;
}
TestBytes history_mutation(uint64_t expected, uint8_t identity,
                           const TestBytes &record) {
  const uint64_t weight = std::max<uint64_t>(1, record.size());
  TestBytes bytes{'T', 'H', 'M', '1'};
  append_u64(bytes, expected + 1); append_u32(bytes, 1); append_u64(bytes, weight);
  append_u32(bytes, 1); append_u64(bytes, weight);
  append_u32(bytes, 0); append_u32(bytes, 1);
  bytes.push_back(identity); bytes.insert(bytes.end(), 15, 0);
  append_u64(bytes, 1); append_u64(bytes, 1); append_u64(bytes, weight);
  bytes.push_back(0); bytes.push_back(0); append_u32(bytes, static_cast<uint32_t>(record.size()));
  bytes.insert(bytes.end(), record.begin(), record.end());
  return bytes;
}
TestBytes history_record_payload(const TestBytes &batch) {
  assert(batch.size() >= 87 && std::equal(batch.begin(), batch.begin() + 4, "THB1"));
  uint32_t count = 0;
  for (int shift = 0; shift < 32; shift += 8) count |= uint32_t(batch[83 + shift / 8]) << shift;
  assert(batch.size() == 87U + count);
  return TestBytes(batch.begin() + 87, batch.end());
}

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

class SavedTestDacl final {
 public:
  explicit SavedTestDacl(const std::filesystem::path &path)
      : handle_(CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr)) {
    assert(handle_);
    assert(GetSecurityInfo(handle_.get(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &dacl_, nullptr, &descriptor_) == ERROR_SUCCESS);
    assert(descriptor_ && dacl_);
  }
  SavedTestDacl(const SavedTestDacl &) = delete;
  SavedTestDacl &operator=(const SavedTestDacl &) = delete;
  ~SavedTestDacl() { LocalFree(descriptor_); }
  void restore() {
    // 仅恢复本测试刚改动的中央临时对象；生产代码绝不修补用户 ACL。
    assert(SetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl_, nullptr) == ERROR_SUCCESS);
  }
 private:
  citizen_sdk::windows::UniqueHandle handle_;
  PSECURITY_DESCRIPTOR descriptor_{};
  PACL dacl_{};
};

void expect_permission_denied(const std::filesystem::path &directory) {
  bool rejected = false;
  try {
    citizen_sdk::windows::PublicStore store(directory);
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

void execute_live_sql(const std::filesystem::path &database, const char *sql) {
  sqlite3 *handle = nullptr;
  assert(sqlite3_open_v2(database.u8string().c_str(), &handle,
                         SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX |
                             SQLITE_OPEN_PRIVATECACHE,
                         nullptr) == SQLITE_OK);
  assert(handle != nullptr);
  char *message = nullptr;
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

void expect_corrupt_singleton(const std::filesystem::path &directory) {
  bool rejected = false;
  try {
    citizen_sdk::windows::PublicStore store(directory);
    (void)store.chain_database_load();
  } catch (const citizen_sdk::windows::HostError &error) {
    rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY;
  }
  assert(rejected);
}

void expect_integrity_on_open(const std::filesystem::path &directory) {
  bool rejected = false;
  try {
    citizen_sdk::windows::PublicStore store(directory);
  } catch (const citizen_sdk::windows::HostError &error) {
    rejected = error.code() == CITIZENSDK_ERROR_INTEGRITY;
  }
  assert(rejected);
}

class InspectableSQLiteStore final : public citizen_sdk::windows::SQLiteStore {
 public:
  InspectableSQLiteStore(const std::filesystem::path &directory, bool secure)
      : SQLiteStore(
            directory,
            secure ? "secure-contract.sqlite3" : "public-contract.sqlite3",
            {"CREATE TABLE IF NOT EXISTS contract_record ("
             "identity INTEGER PRIMARY KEY CHECK(identity = 1), "
             "value BLOB NOT NULL CHECK(typeof(value) = 'blob'))"},
            secure) {}

  int64_t integer_pragma(const char *sql) {
    return read([&](sqlite3 *database) {
      Statement statement(database, sql);
      assert(statement.step_row_or_done());
      const int64_t value = statement.integer(0, 0, 1000000);
      assert(!statement.step_row_or_done());
      return value;
    });
  }

  std::string text_pragma(const char *sql) {
    return read([&](sqlite3 *database) {
      Statement statement(database, sql);
      assert(statement.step_row_or_done());
      const std::string value = statement.text(0, 64);
      assert(!statement.step_row_or_done());
      return value;
    });
  }

  void rollback_fixture() {
    bool rejected = false;
    try {
      (void)transaction([&](sqlite3 *database) -> bool {
        execute(database, "INSERT INTO contract_record(identity,value) VALUES(1,X'01')");
        throw citizen_sdk::windows::HostError(CITIZENSDK_ERROR_CANCELLED, "test precommit failure");
      });
    } catch (const citizen_sdk::windows::HostError &error) {
      rejected = error.code() == CITIZENSDK_ERROR_CANCELLED;
    }
    assert(rejected);
    assert(integer_pragma("SELECT count(*) FROM contract_record") == 0);
  }

  sqlite3_file *borrowed_file_for_test() {
    return read([](sqlite3 *database) {
      sqlite3_file *file = nullptr;
      assert(sqlite3_file_control(database, "main", SQLITE_FCNTL_FILE_POINTER, &file) == SQLITE_OK);
      assert(file && file->pMethods);
      return file;
    });
  }
};

void verify_pragmas(const std::filesystem::path &directory, bool secure) {
  InspectableSQLiteStore store(directory, secure);
  assert(store.text_pragma("PRAGMA journal_mode") == "wal");
  assert(store.integer_pragma("PRAGMA synchronous") == 2);
  assert(store.integer_pragma("PRAGMA foreign_keys") == 1);
  assert(store.integer_pragma("PRAGMA busy_timeout") == 5000);
  assert(store.integer_pragma("PRAGMA temp_store") == 2);
  assert(store.integer_pragma("PRAGMA trusted_schema") == 0);
  assert(store.integer_pragma("PRAGMA wal_autocheckpoint") == 1000);
  assert(store.integer_pragma("PRAGMA user_version") == 1);
  assert(store.integer_pragma("PRAGMA secure_delete") == (secure ? 1 : 0));
  store.rollback_fixture();
}

void verify_vfs_release_and_growth(const std::filesystem::path &directory) {
  // 使用真实 SQLite 连接的生产 VFS，不另写锁实现，也不暴露句柄到 SDK API。
  InspectableSQLiteStore first(directory, false), second(directory, false);
  auto *left = first.borrowed_file_for_test();
  auto *right = second.borrowed_file_for_test();
  void volatile *mapped = nullptr, *shared = nullptr;
  assert(left->pMethods->xShmMap(left, 0, 32768, 1, &mapped) == SQLITE_OK && mapped);
  assert(right->pMethods->xShmMap(right, 0, 32768, 1, &shared) == SQLITE_OK && shared);
  constexpr int lock = SQLITE_SHM_LOCK | SQLITE_SHM_EXCLUSIVE;
  constexpr int unlock = SQLITE_SHM_UNLOCK | SQLITE_SHM_EXCLUSIVE;
  assert(left->pMethods->xShmLock(left, 0, 1, lock) == SQLITE_OK);
  assert(right->pMethods->xShmLock(right, 0, 1, lock) == SQLITE_BUSY);
  const auto shm_path = directory / "public-contract.sqlite3-shm";
  {
    SavedTestDacl original(shm_path);
    widen_test_file(shm_path);
    assert(right->pMethods->xShmLock(right, 1, 1, lock) != SQLITE_OK);
    // 已持锁在 ACL 变化后必须真实释放；SQLite 可能忽略 EndWrite 的返回值。
    assert(left->pMethods->xShmLock(left, 0, 1, unlock) == SQLITE_OK);
    original.restore();
    assert(right->pMethods->xShmLock(right, 0, 1, lock) == SQLITE_OK);
    assert(right->pMethods->xShmLock(right, 0, 1, unlock) == SQLITE_OK);
  }

  int left_before = -1, right_before = -1;
  assert(left->pMethods->xFileControl(left, SQLITE_FCNTL_LOCKSTATE, &left_before) == SQLITE_OK);
  assert(right->pMethods->xFileControl(right, SQLITE_FCNTL_LOCKSTATE, &right_before) == SQLITE_OK);
  assert(left_before >= SQLITE_LOCK_NONE && left_before <= SQLITE_LOCK_SHARED);
  assert(right_before >= SQLITE_LOCK_NONE && right_before <= SQLITE_LOCK_SHARED);
  assert(left->pMethods->xLock(left, SQLITE_LOCK_SHARED) == SQLITE_OK);
  assert(right->pMethods->xLock(right, SQLITE_LOCK_SHARED) == SQLITE_OK);
  assert(left->pMethods->xLock(left, SQLITE_LOCK_RESERVED) == SQLITE_OK);
  assert(right->pMethods->xLock(right, SQLITE_LOCK_RESERVED) == SQLITE_BUSY);
  const auto database_path = directory / "public-contract.sqlite3";
  {
    SavedTestDacl original(database_path);
    widen_test_file(database_path);
    assert(left->pMethods->xUnlock(left, left_before) == SQLITE_OK);
    original.restore();
    assert(right->pMethods->xLock(right, SQLITE_LOCK_RESERVED) == SQLITE_OK);
    assert(right->pMethods->xUnlock(right, right_before) == SQLITE_OK);
  }

  // 第 64 页只需约 2 MiB SHM，直接覆盖旧的任意 64 页行为上限。
  mapped = nullptr; shared = nullptr;
  assert(left->pMethods->xShmMap(left, 64, 32768, 1, &mapped) == SQLITE_OK && mapped);
  assert(right->pMethods->xShmMap(right, 64, 32768, 0, &shared) == SQLITE_OK && shared == mapped);
  assert(left->pMethods->xShmMap(left, -1, 32768, 1, &mapped) == SQLITE_IOERR_SHMMAP && !mapped);
  assert(left->pMethods->xShmMap(left, 65, 0, 1, &mapped) == SQLITE_IOERR_SHMMAP && !mapped);
  assert(first.integer_pragma("SELECT count(*) FROM contract_record") == 0);
  assert(second.integer_pragma("SELECT count(*) FROM contract_record") == 0);
}

void increment(citizen_sdk::windows::PublicStore &store, unsigned count) {
  using namespace citizen_sdk::windows;
  for (unsigned index = 0; index < count; ++index) {
    for (;;) {
      const auto before = store.chain_database_load();
      const auto after = store.chain_database_compare_and_swap(before.revision, Bytes{42});
      if (after.error_code == CITIZENSDK_OK) break;
      assert(after.error_code == CITIZENSDK_ERROR_CONFLICT);
    }
  }
}

citizen_sdk::windows::UniqueHandle child(const std::wstring &arguments, bool inherit) {
  using citizen_sdk::windows::UniqueHandle;
  std::array<wchar_t, 32768> executable{};
  const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
  assert(length > 0 && length < executable.size());
  std::wstring command = L"\"" + std::wstring(executable.data(), length) + L"\" " + arguments;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  assert(CreateProcessW(executable.data(), command.data(), nullptr, nullptr,
      inherit ? TRUE : FALSE, 0, nullptr, nullptr, &startup, &process));
  UniqueHandle thread(process.hThread);
  return UniqueHandle(process.hProcess);
}

void completed(HANDLE process) {
  assert(WaitForSingleObject(process, 60000) == WAIT_OBJECT_0);
  DWORD code = 99;
  assert(GetExitCodeProcess(process, &code) && code == 0);
}

}  // namespace

int wmain(int argc, wchar_t **argv) {
  using citizen_sdk::windows::Bytes;
  using citizen_sdk::windows::HostError;
  using citizen_sdk::windows::PublicStore;

  if (argc >= 3) {
    try {
      PublicStore store{std::filesystem::path(argv[2])};
      if (std::wstring(argv[1]) == L"--cas-child" && argc == 5) {
        auto ready = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::stoull(argv[3])));
        auto start = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::stoull(argv[4])));
        assert(SetEvent(ready));
        assert(WaitForSingleObject(start, 30000) == WAIT_OBJECT_0);
        increment(store, 40);
        return 0;
      }
      if (std::wstring(argv[1]) == L"--commit-child" && argc == 3) {
        const auto result = store.chain_database_compare_and_swap(0, Bytes{73});
        assert(result.error_code == CITIZENSDK_OK && result.revision == 1);
        // 不运行 C++/SQLite 析构，检验已同步提交的 WAL 在下次打开时可恢复。
        ExitProcess(0);
      }
    } catch (...) { return 3; }
    return 2;
  }
  assert(argc == 1);

  citizen_sdk::windows::test::TempDirectory temporary("public-store");
  const auto directory = temporary.path() / "state";
  {
    PublicStore store(directory);
    const auto absent = store.chain_database_load();
    assert(!absent.present);
    assert(absent.error_code == CITIZENSDK_OK);
    assert(absent.domain == CITIZENSDK_HOST_RECORD_CHAIN_DATABASE);

    const auto first = store.chain_database_compare_and_swap(0, Bytes{1, 2});
    assert(first.present && first.revision == 1);
    assert((first.record == Bytes{1, 2}));
    const auto conflict = store.chain_database_compare_and_swap(0, Bytes{3});
    assert(conflict.error_code == CITIZENSDK_ERROR_CONFLICT);
    assert((store.chain_database_load().record == Bytes{1, 2}));
    assert(store.chain_database_compare_and_swap(std::numeric_limits<uint64_t>::max(), Bytes{}).error_code ==
           CITIZENSDK_ERROR_CONFLICT);

    const auto history = store.transaction_history_mutate(
        0, history_mutation(0, 4, Bytes{4, 5}));
    assert(history.revision == 1);
    assert((history_record_payload(store.transaction_history_query(
        history_record_query(1, 4)).record) == Bytes{4, 5}));
    assert(store.transaction_history_query(history_index_query()).revision == 1);
    assert((store.chain_database_load().record == Bytes{1, 2}));

    std::array<uint8_t, 32> hash{};
    hash[31] = 9;
    assert(!store.runtime_cache_load(hash).present);
    store.runtime_cache_store(hash, Bytes{6, 7});
    const auto cached = store.runtime_cache_load(hash);
    assert(cached.present && cached.revision == 0);
    assert((cached.record == Bytes{6, 7}));
    store.runtime_cache_delete(hash);
    assert(!store.runtime_cache_load(hash).present);

    for (uint8_t index = 0; index < 80; ++index) {
      std::array<uint8_t, 32> candidate_hash{};
      candidate_hash[31] = index;
      store.runtime_cache_store(candidate_hash, Bytes{index});
    }
    for (uint8_t index = 0; index < 80; ++index) {
      std::array<uint8_t, 32> candidate_hash{};
      candidate_hash[31] = index;
      assert(store.runtime_cache_load(candidate_hash).present == (index >= 16));
    }
    // REPLACE promotes an existing key to newest and must not grow the table.
    std::array<uint8_t, 32> promoted{};
    promoted[31] = 16;
    store.runtime_cache_store(promoted, Bytes{99});
    std::array<uint8_t, 32> newest{};
    newest[31] = 80;
    store.runtime_cache_store(newest, Bytes{80});
    std::array<uint8_t, 32> evicted{};
    evicted[31] = 17;
    assert(store.runtime_cache_load(promoted).present);
    assert(!store.runtime_cache_load(evicted).present);
    assert(store.runtime_cache_load(newest).present);

    execute_live_sql(directory / "public-state-v1.sqlite3",
                     "CREATE TRIGGER runtime_cache_prune_failure BEFORE "
                     "DELETE ON runtime_cache BEGIN SELECT RAISE(ABORT, "
                     "'test prune failure'); END");
    std::array<uint8_t, 32> rejected{};
    rejected[31] = 81;
    bool prune_failed = false;
    try {
      store.runtime_cache_store(rejected, Bytes{81});
    } catch (const HostError &error) {
      prune_failed = error.code() == CITIZENSDK_ERROR_STORAGE;
    }
    assert(prune_failed);
    std::array<uint8_t, 32> retained{};
    retained[31] = 18;
    assert(!store.runtime_cache_load(rejected).present);
    assert(store.runtime_cache_load(retained).present);
    execute_live_sql(directory / "public-state-v1.sqlite3",
                     "DROP TRIGGER runtime_cache_prune_failure");

    verify_private(directory, "public-state-v1.sqlite3");
    verify_private(directory, "public-state-v1.sqlite3-wal");
    verify_private(directory, "public-state-v1.sqlite3-shm");
    store.close();
    bool closed_failed = false;
    try {
      (void)store.chain_database_load();
    } catch (const HostError &error) {
      closed_failed = error.code() == CITIZENSDK_ERROR_STORAGE;
    }
    assert(closed_failed);
  }

  // reparse point 的组件与子目录拒绝由 directory_test 的真实 junction 覆盖。
  const auto database_directory = temporary.path() / "database-directory";
  make_private(database_directory);
  make_private(database_directory /
                                    "public-state-v1.sqlite3");
  expect_permission_denied(database_directory);

  const auto database_hardlink = temporary.path() / "database-hardlink";
  make_private(database_hardlink);
  const auto hardlink_source = temporary.path() / "hardlink-source";
  touch(hardlink_source);
  std::filesystem::create_hard_link(
      hardlink_source, database_hardlink / "public-state-v1.sqlite3");
  expect_permission_denied(database_hardlink);

  for (const char *companion : {"-journal", "-wal", "-shm"}) {
    const auto companion_directory_state =
        temporary.path() /
        (std::string("companion-directory") + companion + "-state");
    make_private(companion_directory_state);
    make_private(
        companion_directory_state /
            (std::string("public-state-v1.sqlite3") + companion));
    expect_permission_denied(companion_directory_state);

    const auto companion_hardlink_state =
        temporary.path() /
        (std::string("companion-hardlink") + companion + "-state");
    make_private(companion_hardlink_state);
    const auto companion_hardlink_source =
        temporary.path() /
        (std::string("companion-hardlink") + companion + "-source");
    touch(companion_hardlink_source);
    std::filesystem::create_hard_link(
        companion_hardlink_source,
        companion_hardlink_state /
            (std::string("public-state-v1.sqlite3") + companion));
    expect_permission_denied(companion_hardlink_state);
  }

  const auto unsafe_state = temporary.path() / "unsafe-state";
  make_private(unsafe_state);
  const auto unsafe_database = unsafe_state / "public-state-v1.sqlite3";
  touch(unsafe_database);
  widen_test_file(unsafe_database);
  expect_permission_denied(unsafe_state);

  // Windows 不分享删除，活动目录改名必须被系统拒绝，不能改写别的目录。
  const auto bound_state = temporary.path() / "bound-state";
  const auto bound_identity = temporary.path() / "bound-state-original";
  {
    PublicStore store(bound_state);
    (void)store.chain_database_compare_and_swap(0, Bytes{21});
    std::error_code rename_error;
    std::filesystem::rename(bound_state, bound_identity, rename_error);
    assert(rename_error);
    const auto persisted = store.transaction_history_mutate(
        0, history_mutation(0, 22, Bytes{22}));
    assert(persisted.error_code == CITIZENSDK_OK && persisted.revision == 1);
  }
  std::filesystem::rename(bound_state, bound_identity);
  {
    PublicStore store(bound_identity);
    assert((store.chain_database_load().record == Bytes{21}));
    assert((history_record_payload(store.transaction_history_query(
        history_record_query(1, 22)).record) == Bytes{22}));
  }

  const auto wrong_schema = temporary.path() / "wrong-public-schema";
  make_private(wrong_schema);
  execute_sql(wrong_schema / "public-state-v1.sqlite3",
              "CREATE TABLE singleton_records(domain INTEGER PRIMARY KEY);");
  expect_integrity_on_open(wrong_schema);
  // 未知/部分 schema 必须在任何持久 journal-mode 修改之前被拒绝。
  assert(read_text_pragma(wrong_schema / "public-state-v1.sqlite3",
                          "PRAGMA journal_mode") == "delete");

  const auto extra_schema = temporary.path() / "extra-public-schema";
  {
    PublicStore store(extra_schema);
  }
  execute_sql(extra_schema / "public-state-v1.sqlite3",
              "CREATE TABLE unexpected_state(value BLOB);");
  expect_integrity_on_open(extra_schema);

  // '_' 必须是字面下划线；不能用 LIKE 通配符把 sqlitex_* 用户对象当系统对象。
  const auto disguised_table = temporary.path() / "sqlitex-public-table";
  { PublicStore store(disguised_table); }
  execute_sql(disguised_table / "public-state-v1.sqlite3",
              "CREATE TABLE sqlitex_extra(value BLOB);");
  expect_integrity_on_open(disguised_table);
  const auto disguised_trigger = temporary.path() / "sqlitex-public-trigger";
  { PublicStore store(disguised_trigger); }
  execute_sql(disguised_trigger / "public-state-v1.sqlite3",
              "CREATE TRIGGER sqlitex_extra AFTER INSERT ON singleton_records BEGIN SELECT 1; END;");
  expect_integrity_on_open(disguised_trigger);

  const auto corrupt_revision = temporary.path() / "corrupt-revision";
  {
    PublicStore store(corrupt_revision);
    (void)store.chain_database_compare_and_swap(0, Bytes{1});
  }
  execute_sql(corrupt_revision / "public-state-v1.sqlite3",
              "PRAGMA ignore_check_constraints=ON;"
              "UPDATE singleton_records SET revision=0;");
  expect_corrupt_singleton(corrupt_revision);

  const auto corrupt_blob = temporary.path() / "corrupt-blob";
  {
    PublicStore store(corrupt_blob);
    (void)store.chain_database_compare_and_swap(0, Bytes{1});
  }
  execute_sql(corrupt_blob / "public-state-v1.sqlite3",
              "PRAGMA ignore_check_constraints=ON;"
              "UPDATE singleton_records SET record='not-a-blob';");
  expect_corrupt_singleton(corrupt_blob);

  // 直接从生产 SQLiteStore 的同一连接读回全部安全 PRAGMA，避免只验证
  // 配置语句存在却没有验证实际生效值。
  verify_pragmas(temporary.path() / "pragma-public", false);
  verify_pragmas(temporary.path() / "pragma-secure", true);
  verify_vfs_release_and_growth(temporary.path() / "vfs-release-and-growth");

  // 同进程节点按 FileId 共享 WAL-index，不按 VFS 注册名各建一套锁状态。
  const auto concurrent = temporary.path() / "concurrent";
  {
    PublicStore first(concurrent), second(concurrent);
    std::thread a([&] { increment(first, 40); });
    std::thread b([&] { increment(second, 40); });
    a.join(); b.join();
    assert(first.chain_database_load().revision == 80);
    // 单次事务超过首个 32 KiB WAL-index 页，覆盖 64 KiB 系统映射粒度。
    const Bytes large(20 * 1024 * 1024, 31);
    assert(first.transaction_history_mutate(
        0, history_mutation(0, 31, large)).error_code == CITIZENSDK_OK);
    assert(history_record_payload(second.transaction_history_query(
        history_record_query(1, 31)).record) == large);
  }
  const auto cross_process = temporary.path() / "cross-process";
  {
    using citizen_sdk::windows::UniqueHandle;
    PublicStore first(cross_process);
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    UniqueHandle ready(CreateEventW(&attributes, TRUE, FALSE, nullptr));
    UniqueHandle start(CreateEventW(&attributes, TRUE, FALSE, nullptr));
    assert(ready && start);
    auto process = child(L"--cas-child \"" + cross_process.native() + L"\" " +
        std::to_wstring(reinterpret_cast<uintptr_t>(ready.get())) + L" " +
        std::to_wstring(reinterpret_cast<uintptr_t>(start.get())), true);
    assert(WaitForSingleObject(ready.get(), 30000) == WAIT_OBJECT_0);
    assert(SetEvent(start.get()));
    increment(first, 40);
    completed(process.get());
    assert(first.chain_database_load().revision == 80);
  }
  const auto crashed = temporary.path() / "exit-after-commit";
  auto process = child(L"--commit-child \"" + crashed.native() + L"\"", false);
  completed(process.get());
  {
    PublicStore reopened(crashed);
    assert((reopened.chain_database_load().record == Bytes{73}));
    assert(reopened.chain_database_load().revision == 1);
  }

  const std::string sqlite_path =
      std::string(CITIZENSDK_WINDOWS_TEST_SOURCE_DIR) +
      "/src/citizen_sdk_sqlite.cc";
  std::ifstream sqlite_stream(sqlite_path, std::ios::binary);
  assert(sqlite_stream.good());
  const std::string sqlite_source(
      (std::istreambuf_iterator<char>(sqlite_stream)),
      std::istreambuf_iterator<char>());
  assert(sqlite_source.find("count > maximum") != std::string::npos);
  assert(sqlite_source.find("CITIZENSDK_ERROR_INTEGRITY") !=
         std::string::npos);
  assert(sqlite_source.find("class HandleSQLiteVfs final") != std::string::npos);
  assert(sqlite_source.find("::FlushFileBuffers") != std::string::npos);
  assert(sqlite_source.find("::LockFileEx") != std::string::npos);
  assert(sqlite_source.find("::MapViewOfFile") != std::string::npos);
  assert(sqlite_source.find("SQLITE_OPEN_PRIVATECACHE") !=
         std::string::npos);
  assert(sqlite_source.find("verify_schema(database, schema)") !=
         std::string::npos);
  assert(sqlite_source.find("verify_text_pragma(database, \"PRAGMA journal_mode\", \"wal\"") !=
         std::string::npos);
  assert(sqlite_source.find("verify_integer_pragma(database, \"PRAGMA secure_delete\"") !=
         std::string::npos);
  const auto configure =
      sqlite_source.find("void configure_and_verify_database(");
  const auto initialize_transaction =
      sqlite_source.find("execute_checked(\"BEGIN IMMEDIATE\")", configure);
  const auto initialize_version =
      sqlite_source.find("const std::string version_sql =",
                         initialize_transaction);
  const auto initialize_schema =
      sqlite_source.find("verify_schema(database, schema)",
                         initialize_version);
  const auto initialize_commit =
      sqlite_source.find("execute_checked(\"COMMIT\")", initialize_schema);
  const auto wal_configuration =
      sqlite_source.find("execute_checked(\"PRAGMA journal_mode=WAL\")",
                         initialize_commit);
  const auto existing_schema = sqlite_source.rfind(
      "verify_schema(database, schema)", wal_configuration);
  assert(configure != std::string::npos &&
         initialize_transaction != std::string::npos &&
         initialize_version != std::string::npos &&
         initialize_schema != std::string::npos &&
         initialize_commit != std::string::npos &&
         wal_configuration != std::string::npos &&
         existing_schema != std::string::npos &&
         configure < initialize_transaction &&
         initialize_transaction < initialize_version &&
         initialize_version < initialize_schema &&
         initialize_schema < initialize_commit &&
         initialize_commit < existing_schema &&
         existing_schema < wal_configuration);

  const std::string sqlite_header_path =
      std::string(CITIZENSDK_WINDOWS_TEST_SOURCE_DIR) +
      "/src/citizen_sdk_sqlite.hpp";
  std::ifstream sqlite_header_stream(sqlite_header_path, std::ios::binary);
  assert(sqlite_header_stream.good());
  const std::string sqlite_header(
      (std::istreambuf_iterator<char>(sqlite_header_stream)),
      std::istreambuf_iterator<char>());
  const auto transaction = sqlite_header.find("auto transaction(");
  const auto nothrow_result = sqlite_header.find(
      "std::is_nothrow_move_constructible_v<Result>", transaction);
  const auto precommit_check =
      sqlite_header.find("enforce_file_permissions();", transaction);
  const auto commit =
      sqlite_header.find("execute(database, \"COMMIT\")", precommit_check);
  const auto rollback = sqlite_header.find("ROLLBACK", commit);
  assert(transaction != std::string::npos &&
         nothrow_result != std::string::npos &&
         precommit_check != std::string::npos && commit != std::string::npos &&
         rollback != std::string::npos && transaction < nothrow_result &&
         nothrow_result < precommit_check &&
         precommit_check < commit && commit < rollback);
  const auto next_permission_check =
      sqlite_header.find("enforce_file_permissions();", commit);
  assert(next_permission_check == std::string::npos ||
         next_permission_check > rollback);
  return 0;
}
