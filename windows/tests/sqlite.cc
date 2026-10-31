// 生产SQLite VFS、文件权限及事务资源验收；公共业务测试归Rust Store。
#include <cassert>
#include <cstdio>
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

#include "citizen_sdk_sqlite.hpp"
#include "sqlite.hpp"
#include "citizen_sdk_test_support.hpp"

#ifndef CITIZENSDK_WINDOWS_TEST_SOURCE_DIR
#error "CITIZENSDK_WINDOWS_TEST_SOURCE_DIR must point at the Windows source root"
#endif
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

void widen_test_file(const std::filesystem::path &path) {
  // 夹具须同时持有读取与设置 DACL 权限；生产存储仍拒绝放宽后的文件。
  citizen_sdk::windows::UniqueHandle file(CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr));
  assert(file);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  assert(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"D:P(A;;FA;;;WD)", SDDL_REVISION_1, &descriptor, nullptr));
  PACL dacl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  assert(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) && present && dacl);
  const DWORD result = SetSecurityInfo(file.get(), SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr);
  if (result != ERROR_SUCCESS)
    std::fprintf(stderr, "CitizenSDK Windows public-store ACL widen failed code=%lu\n",
                 static_cast<unsigned long>(result));
  assert(result == ERROR_SUCCESS);
  LocalFree(descriptor);
}

void expect_permission_denied(const std::filesystem::path &directory,const char *file_name) {
  bool rejected = false;
  try {
    citizen_sdk::windows::SQLiteStore store(directory, file_name);
  } catch (const citizen_sdk::HostError &error) {
    rejected = error.code() == CITIZENSDK_ERROR_PERMISSION_DENIED;
  }
  assert(rejected);
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
    const DWORD result = SetSecurityInfo(handle_.get(), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl_, nullptr);
    if (result != ERROR_SUCCESS)
      std::fprintf(stderr, "CitizenSDK Windows public-store ACL restore failed code=%lu\n",
                   static_cast<unsigned long>(result));
    assert(result == ERROR_SUCCESS);
  }
 private:
  citizen_sdk::windows::UniqueHandle handle_;
  PSECURITY_DESCRIPTOR descriptor_{};
  PACL dacl_{};
};

class InspectableSQLiteStore final : public citizen_sdk::windows::SQLiteStore {
 public:
  InspectableSQLiteStore(const std::filesystem::path &directory, bool secure)
      : SQLiteStore(directory, secure ? "secure-contract.sqlite3" : "public-contract.sqlite3") {
    read([&](sqlite3 *db) {
      execute(db,"PRAGMA journal_mode=WAL");execute(db,"PRAGMA synchronous=FULL");
      execute(db,"PRAGMA busy_timeout=5000");execute(db,"PRAGMA foreign_keys=ON");
      execute(db,"PRAGMA trusted_schema=OFF");execute(db,"PRAGMA temp_store=MEMORY");
      execute(db,secure ? "PRAGMA secure_delete=ON" : "PRAGMA secure_delete=OFF");
      execute(db,"CREATE TABLE IF NOT EXISTS contract_record (identity INTEGER PRIMARY KEY CHECK(identity = 1), value BLOB NOT NULL CHECK(typeof(value) = 'blob'))");
    });
  }

  void write_blob(const citizen_sdk::Bytes &value) {
    (void)transaction([&](sqlite3 *database) {
      Statement query(database,"INSERT OR REPLACE INTO contract_record(identity,value) VALUES(1,?)");
      query.bind(1,value);query.step_done();return 0;
    });
  }
  citizen_sdk::Bytes blob() {
    return read([](sqlite3 *database) {
      Statement query(database,"SELECT value FROM contract_record WHERE identity=1");
      assert(query.step_row_or_done());auto bytes=query.bytes(0,20*1024*1024);
      assert(!query.step_row_or_done());return bytes;
    });
  }
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

  void write_value(uint8_t value) {
    (void)transaction([&](sqlite3 *database) {
      Statement query(database,"INSERT OR REPLACE INTO contract_record(identity,value) VALUES(1,?)");
      query.bind(1,citizen_sdk::Bytes{value});query.step_done();return 0;
    });
  }
  uint8_t value() {
    return read([](sqlite3 *database) {
      Statement query(database,"SELECT value FROM contract_record WHERE identity=1");
      assert(query.step_row_or_done());const auto bytes=query.bytes(0,1);
      assert(bytes.size()==1&&!query.step_row_or_done());return bytes[0];
    });
  }
  void increment(unsigned count) {
    for(unsigned i=0;i<count;++i)(void)transaction([&](sqlite3 *database) {
      Statement query(database,"SELECT value FROM contract_record WHERE identity=1");
      assert(query.step_row_or_done());const auto bytes=query.bytes(0,1);assert(bytes.size()==1&&!query.step_row_or_done());
      Statement write(database,"UPDATE contract_record SET value=? WHERE identity=1");
      write.bind(1,citizen_sdk::Bytes{static_cast<uint8_t>(bytes[0]+1)});write.step_done();return 0;
    });
  }
  void rollback_fixture() {
    bool rejected = false;
    std::atomic<bool> rollback_requested{true};
    try {
      (void)transaction([&](sqlite3 *database) -> bool {
        if (rollback_requested.exchange(false, std::memory_order_relaxed)) {
          execute(database, "INSERT INTO contract_record(identity,value) VALUES(1,X'01')");
          throw citizen_sdk::HostError(CITIZENSDK_ERROR_CANCELLED, "test precommit failure");
        }
        return false;
      });
    } catch (const citizen_sdk::HostError &error) {
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
  // SQLite的扩展标记按零/非零解释，不要求调用方只传数值1。
  shared = nullptr;
  assert(right->pMethods->xShmMap(right, 64, 32768, 2, &shared) == SQLITE_OK && shared == mapped);
  assert(left->pMethods->xShmMap(left, -1, 32768, 1, &mapped) == SQLITE_IOERR_SHMMAP && !mapped);
  assert(left->pMethods->xShmMap(left, 65, 0, 1, &mapped) == SQLITE_IOERR_SHMMAP && !mapped);
  assert(first.integer_pragma("SELECT count(*) FROM contract_record") == 0);
  assert(second.integer_pragma("SELECT count(*) FROM contract_record") == 0);
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

}
int wmain(int argc,wchar_t **argv){
 if(argc>=3){
  InspectableSQLiteStore store(std::filesystem::path(argv[2]),false);
  if(std::wstring(argv[1])==L"--commit-child"){store.write_value(73);ExitProcess(0);}
  if(std::wstring(argv[1])==L"--writer"&&argc==5){
   auto ready=reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::stoull(argv[3])));
   auto start=reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::stoull(argv[4])));
   assert(SetEvent(ready));assert(WaitForSingleObject(start,30000)==WAIT_OBJECT_0);store.increment(40);return 0;
  }
  return 2;
 }
 assert(argc==1);
 citizen_sdk::windows::test::TempDirectory temporary("sqlite");
 verify_vfs_release_and_growth(temporary.path()/"growth");
 for(const char *file_name:{"public-state.sqlite3","secure-state.sqlite3"}) {
  citizen_sdk::windows::test::TempDirectory files("file-security");
  // reparse point 的组件与子目录拒绝由 directory_test 的真实 junction 覆盖。
  const auto database_directory = files.path() / "database-directory";
  make_private(database_directory);
  make_private(database_directory /
                                    file_name);
  expect_permission_denied(database_directory,file_name);

  const auto database_hardlink = files.path() / "database-hardlink";
  make_private(database_hardlink);
  const auto hardlink_source = files.path() / "hardlink-source";
  touch(hardlink_source);
  std::filesystem::create_hard_link(
      hardlink_source, database_hardlink / file_name);
  expect_permission_denied(database_hardlink,file_name);

  for (const char *companion : {"-journal", "-wal", "-shm"}) {
    const auto companion_directory_state =
        files.path() /
        (std::string("companion-directory") + companion + "-state");
    make_private(companion_directory_state);
    make_private(
        companion_directory_state /
            (std::string(file_name) + companion));
    expect_permission_denied(companion_directory_state,file_name);

    const auto companion_hardlink_state =
        files.path() /
        (std::string("companion-hardlink") + companion + "-state");
    make_private(companion_hardlink_state);
    const auto companion_hardlink_source =
        files.path() /
        (std::string("companion-hardlink") + companion + "-source");
    touch(companion_hardlink_source);
    std::filesystem::create_hard_link(
        companion_hardlink_source,
        companion_hardlink_state /
            (std::string(file_name) + companion));
    expect_permission_denied(companion_hardlink_state,file_name);
  }

  const auto unsafe_state = files.path() / "unsafe-state";
  make_private(unsafe_state);
  const auto unsafe_database = unsafe_state / file_name;
  touch(unsafe_database);
  widen_test_file(unsafe_database);
  expect_permission_denied(unsafe_state,file_name);


 }
 // 真实事务跨越首个WAL-index页，不能只模拟内存映射调用。
 { InspectableSQLiteStore first(temporary.path()/"large",false),second(temporary.path()/"large",false);
   const citizen_sdk::Bytes large(20*1024*1024,31);first.write_blob(large);assert(second.blob()==large); }
 // 验证生产VFS继续绑定已打开的目录身份。
 const auto bound=temporary.path()/"bound", original=temporary.path()/"original";
 { InspectableSQLiteStore store(bound,false);store.write_value(21);
 std::error_code error;std::filesystem::rename(bound,original,error);assert(error);
 store.write_value(22); }
 std::filesystem::rename(bound,original);
 { InspectableSQLiteStore store(original,false);assert(store.value()==22); }
 const auto concurrent=temporary.path()/"process";
 { InspectableSQLiteStore store(concurrent,false);store.write_value(0);
   SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE};
   citizen_sdk::windows::UniqueHandle ready(CreateEventW(&attributes,TRUE,FALSE,nullptr)),start(CreateEventW(&attributes,TRUE,FALSE,nullptr));assert(ready&&start);
   auto process=child(L"--writer \""+concurrent.native()+L"\" "+std::to_wstring(reinterpret_cast<uintptr_t>(ready.get()))+L" "+std::to_wstring(reinterpret_cast<uintptr_t>(start.get())),true);
   assert(WaitForSingleObject(ready.get(),30000)==WAIT_OBJECT_0);assert(SetEvent(start.get()));store.increment(40);completed(process.get());assert(store.value()==80);
 }
 const auto crashed=temporary.path()/"unclean";
 auto process=child(L"--commit-child \""+crashed.native()+L"\"",false);completed(process.get());
 { InspectableSQLiteStore store(crashed,false);assert(store.value()==73); }
 { InspectableSQLiteStore fixture(temporary.path()/"rollback-public",false); fixture.rollback_fixture(); }
 { InspectableSQLiteStore fixture(temporary.path()/"rollback-secure",true); fixture.rollback_fixture(); }
 return 0;
}
