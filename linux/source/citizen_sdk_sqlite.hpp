#ifndef CITIZENSDK_LINUX_SQLITE_HPP
#define CITIZENSDK_LINUX_SQLITE_HPP

#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <type_traits>
#include <vector>
#include <sqlite3.h>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::linux {

class OpenAtSQLiteVfs;

class SQLiteStore {
 public:
  class Statement final {
   public:
    Statement(sqlite3 *database, const char *sql);
    Statement(const Statement &) = delete;
    Statement &operator=(const Statement &) = delete;
    ~Statement();
    sqlite3_stmt *get() const noexcept { return statement_; }
    void bind(int index, int64_t value);
    void bind(int index, const std::string &value);
    void bind(int index, const Bytes &value);
    bool step_row_or_done();
    void step_done();
    int64_t integer(int column, int64_t minimum, int64_t maximum) const;
    std::string text(int column, int maximum) const;
    Bytes bytes(int column, int maximum) const;

   private:
    sqlite3_stmt *statement_{};
  };

  SQLiteStore(const std::filesystem::path &directory, const char *file_name,
              const std::vector<std::string> &schema, bool secure,
              int schema_version = 1, bool incremental_vacuum = false);
  SQLiteStore(const SQLiteStore &) = delete;
  SQLiteStore &operator=(const SQLiteStore &) = delete;
  virtual ~SQLiteStore();

  void close() noexcept;

 protected:
  template <typename Function>
  auto read(Function function) -> decltype(function(static_cast<sqlite3 *>(nullptr))) {
    std::lock_guard<std::recursive_mutex> guard(lock_);
    if (database_ == nullptr) {
      throw HostError(CITIZENSDK_ERROR_STORAGE, "CitizenSDK state store is closed");
    }
    enforce_file_permissions();
    return function(database_);
  }

  template <typename Function>
  auto transaction(Function function) -> decltype(function(static_cast<sqlite3 *>(nullptr))) {
    using Result = decltype(function(static_cast<sqlite3 *>(nullptr)));
    static_assert(!std::is_void_v<Result> &&
                      std::is_nothrow_move_constructible_v<Result>,
                  "CitizenSDK transaction results must move without throwing");
    return read([&](sqlite3 *database) {
      execute(database, "BEGIN IMMEDIATE");
      try {
        auto value = function(database);
        // Every fallible security check runs while rollback is still
        // possible. COMMIT is the final operation, so a committed mutation is
        // never subsequently reported as rejected merely because a companion
        // permission check failed.
        enforce_file_permissions();
        execute(database, "COMMIT");
        return value;
      } catch (...) {
        try { execute(database, "ROLLBACK"); } catch (...) {}
        try { enforce_file_permissions(); } catch (...) {}
        throw;
      }
    });
  }

  static void execute(sqlite3 *database, const char *sql);

 private:
  static int open_private_directory(const std::filesystem::path &directory);
  void enforce_file_permissions();
  std::recursive_mutex lock_;
  sqlite3 *database_{};
  int directory_fd_{-1};
  std::string file_name_;
  std::unique_ptr<OpenAtSQLiteVfs> vfs_;
};

}  // namespace citizen_sdk::linux

#endif
