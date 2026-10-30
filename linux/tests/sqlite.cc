// 生产SQLite VFS、文件权限及事务资源验收；公共业务测试归Rust Store。
#include <cassert>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <string>
#include <sys/stat.h>
#include <sqlite3.h>

#include "citizen_sdk_sqlite.hpp"
#include "sqlite.hpp"
#include "citizen_sdk_test_support.hpp"

#ifndef CITIZENSDK_LINUX_TEST_SOURCE_DIR
#error "CITIZENSDK_LINUX_TEST_SOURCE_DIR must point at the Linux source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif

namespace {
mode_t permissions(const std::filesystem::path &path) {
  struct stat value {};
  assert(::stat(path.c_str(), &value) == 0);
  return value.st_mode & 0777;
}

void touch(const std::filesystem::path &path) {
  std::ofstream stream(path, std::ios::binary | std::ios::trunc);
  assert(stream.good());
}

void expect_permission_denied(const std::filesystem::path &directory,const char *file_name) {
  bool rejected = false;
  try {
    citizen_sdk::linux::SQLiteStore store(directory, file_name);
  } catch (const citizen_sdk::HostError &error) {
    rejected = error.code() == CITIZENSDK_ERROR_PERMISSION_DENIED;
  }
  assert(rejected);
}

class InspectableSQLiteStore final : public citizen_sdk::linux::SQLiteStore {
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

  sqlite3_file *borrowed_file_for_test() {
    return read([](sqlite3 *database) {
      sqlite3_file *file = nullptr;
      assert(sqlite3_file_control(database, "main", SQLITE_FCNTL_FILE_POINTER, &file) == SQLITE_OK && file);
      return file;
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

  void write_value(uint8_t value,
                   const citizen_sdk::linux::test::ProcessPipe *ready = nullptr,
                   const citizen_sdk::linux::test::ProcessPipe *proceed = nullptr) {
    (void)transaction([&](sqlite3 *database) {
      Statement statement(database,
          "INSERT INTO contract_record(identity,value) VALUES(1,?1) "
          "ON CONFLICT(identity) DO UPDATE SET value=excluded.value");
      statement.bind(1, citizen_sdk::Bytes{value});
      statement.step_done();
      // 故意在 BEGIN IMMEDIATE 与 COMMIT 之间挂起真实 writer。
      if (ready != nullptr && proceed != nullptr) {
        ready->send();
        proceed->receive();
      }
      return 0;
    });
  }

  uint8_t value() {
    return read([](sqlite3 *database) {
      Statement statement(database, "SELECT value FROM contract_record WHERE identity=1");
      assert(statement.step_row_or_done());
      const auto bytes = statement.bytes(0, 1);
      assert(bytes.size() == 1 && !statement.step_row_or_done());
      return bytes[0];
    });
  }
};

void verify_active_writer(const std::filesystem::path &directory, bool secure) {
  using citizen_sdk::linux::test::ProcessPipe;
  const auto shm = directory /
      (secure ? "secure-contract.sqlite3-shm" : "public-contract.sqlite3-shm");
  { InspectableSQLiteStore initial(directory, secure); initial.write_value(1); }
  ProcessPipe ready, proceed;
  const pid_t writer = ::fork();
  assert(writer >= 0);
  if (writer == 0) {
    ::alarm(60);
    InspectableSQLiteStore store(directory, secure);
    store.write_value(2, &ready, &proceed);
    ready.send();
    proceed.receive();
    store.close();
    ::_exit(0);
  }
  ready.receive();
  const auto before = citizen_sdk::linux::test::read_shm(shm);
  {
    InspectableSQLiteStore reader(directory, secure);
    assert(reader.value() == 1);  // writer 未提交，reader 必须保留已有快照。
    const auto after = citizen_sdk::linux::test::read_shm(shm);
    assert(before.size() == after.size());
    assert(std::equal(before.begin(), before.begin() + 96, after.begin()));
    citizen_sdk::linux::test::assert_shared_dms(shm);
    proceed.send();
    ready.receive();
    assert(reader.value() == 2);
    assert(reader.text_pragma("PRAGMA integrity_check") == "ok");
  }
  proceed.send();
  citizen_sdk::linux::test::wait_for_child(writer);
  InspectableSQLiteStore reopened(directory, secure);
  assert(reopened.value() == 2);
}



}
int main(){
 citizen_sdk::linux::test::TempDirectory temporary("sqlite");
 verify_active_writer(temporary.path()/"public-active-writer",false);
 verify_active_writer(temporary.path()/"secure-active-writer",true);
 for(const char *file_name:{"public-state-v1.sqlite3","secure-state-v1.sqlite3"}) {
  citizen_sdk::linux::test::TempDirectory files("file-security");
  const auto symlink_target = files.path() / "symlink-target";
  std::filesystem::create_directory(symlink_target);
  const auto symlink_path = files.path() / "symlink-state";
  std::filesystem::create_directory_symlink(symlink_target, symlink_path);
  expect_permission_denied(symlink_path,file_name);

  const auto database_symlink = files.path() / "database-symlink";
  std::filesystem::create_directory(database_symlink);
  touch(files.path() / "decoy");
  std::filesystem::create_symlink(files.path() / "decoy",
                                  database_symlink /
                                      file_name);
  expect_permission_denied(database_symlink,file_name);

  const auto database_directory = files.path() / "database-directory";
  std::filesystem::create_directory(database_directory);
  std::filesystem::create_directory(database_directory /
                                    file_name);
  expect_permission_denied(database_directory,file_name);

  const auto database_hardlink = files.path() / "database-hardlink";
  std::filesystem::create_directory(database_hardlink);
  const auto hardlink_source = files.path() / "hardlink-source";
  touch(hardlink_source);
  std::filesystem::create_hard_link(
      hardlink_source, database_hardlink / file_name);
  expect_permission_denied(database_hardlink,file_name);

  for (const char *companion : {"-journal", "-wal", "-shm"}) {
    const auto companion_state =
        files.path() / (std::string("companion") + companion + "-state");
    std::filesystem::create_directory(companion_state);
    std::filesystem::create_symlink(
        files.path() / "decoy",
        companion_state /
            (std::string(file_name) + companion));
    expect_permission_denied(companion_state,file_name);

    const auto companion_directory_state =
        files.path() /
        (std::string("companion-directory") + companion + "-state");
    std::filesystem::create_directory(companion_directory_state);
    std::filesystem::create_directory(
        companion_directory_state /
            (std::string(file_name) + companion));
    expect_permission_denied(companion_directory_state,file_name);

    const auto companion_hardlink_state =
        files.path() /
        (std::string("companion-hardlink") + companion + "-state");
    std::filesystem::create_directory(companion_hardlink_state);
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
  std::filesystem::create_directory(unsafe_state);
  const auto unsafe_database = unsafe_state / file_name;
  touch(unsafe_database);
  assert(::chmod(unsafe_database.c_str(), 0666) == 0);
  {
    citizen_sdk::linux::SQLiteStore store(unsafe_state, file_name);
    assert(permissions(unsafe_state) == 0700);
    assert(permissions(unsafe_database) == 0600);
  }


 }
 // 生产VFS的第64页仅约2MiB，不能被任意页数上限拒绝；两连接真实共享字节。
 { InspectableSQLiteStore first(temporary.path()/"growth",false),second(temporary.path()/"growth",false);
   auto *left=first.borrowed_file_for_test(), *right=second.borrowed_file_for_test();
   void volatile *mapped=nullptr,*shared=nullptr;
   assert(left->pMethods->xShmMap(left,64,32768,1,&mapped)==SQLITE_OK&&mapped);
   *static_cast<volatile uint8_t *>(mapped)=37;
   assert(right->pMethods->xShmMap(right,64,32768,0,&shared)==SQLITE_OK&&shared);
   assert(*static_cast<volatile uint8_t *>(shared)==37);
   assert(left->pMethods->xShmMap(left,-1,32768,1,&mapped)==SQLITE_IOERR_SHMMAP&&!mapped);
   assert(left->pMethods->xShmMap(left,65,0,1,&mapped)==SQLITE_IOERR_SHMMAP&&!mapped);
   assert(left->pMethods->xShmMap(left,std::numeric_limits<int>::max(),32768,0,&mapped)==SQLITE_OK&&!mapped);
 }
 // 真实事务跨越首个WAL-index页，不能只模拟内存映射调用。
 { InspectableSQLiteStore first(temporary.path()/"large",false),second(temporary.path()/"large",false);
   const citizen_sdk::Bytes large(20*1024*1024,31);first.write_blob(large);assert(second.blob()==large); }
 // 验证生产VFS继续绑定已打开的目录身份。
 const auto bound=temporary.path()/"bound", original=temporary.path()/"original";
 { InspectableSQLiteStore store(bound,false);store.write_value(21);
 std::filesystem::rename(bound,original);std::filesystem::create_directory(bound);
 store.write_value(22); }
 assert(std::filesystem::is_empty(bound));
 { InspectableSQLiteStore store(original,false);assert(store.value()==22); }
 return 0;
}
