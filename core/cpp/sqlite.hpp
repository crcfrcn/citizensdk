#ifndef CITIZENSDK_SQLITE_HPP
#define CITIZENSDK_SQLITE_HPP
#include "citizensdk.h"
#include "citizensdk_internal.h"
#include "input.hpp"
#include "secret.hpp"
#include <algorithm>
#include <array>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <sqlite3.h>
#include <string>
#include <vector>

namespace citizen_sdk {
// 两桌面端共用的SQLite C适配；Owner仅保留平台文件权限/VFS和连接锁。
template <class Owner, class Error> class Database final {
public:
  explicit Database(std::filesystem::path directory, bool secure = false)
      : directory_(std::move(directory)), secure_(secure) {}
  citizensdk_store_v1_t config() noexcept {
    return {sizeof(citizensdk_store_v1_t),
            CITIZENSDK_ABI_VERSION,
            this,
            run,
            execute,
            query,
            begin,
            end,
            wal};
  }
  void close() noexcept {
    std::lock_guard<std::mutex> guard(lock_);
    owner_.reset();
  }

private:
  struct Statement {
    sqlite3_stmt *value{};
    ~Statement() {
      if (value)
        sqlite3_finalize(value);
    }
  };
  static Database &self(void *p) {
    if (!p)
      throw Error(CITIZENSDK_ERROR_INVALID_ARGUMENT, "SQLite context missing");
    return *static_cast<Database *>(p);
  }
  template <class F> static citizensdk_error_code_t protect(F f) noexcept {
    try {
      return f();
    } catch (const Error &e) {
      return e.code();
    } catch (...) {
      return CITIZENSDK_ERROR_INTERNAL;
    }
  }
  static void check(bool value) {
    if (!value)
      throw Error(CITIZENSDK_ERROR_STORAGE, "SQLite resource failed");
  }
  static void prepare(Database &db, citizensdk_bytes_view_t sql,
                      const citizensdk_sql_value_t *values, uint64_t count,
                      Statement &stmt) {
    check(db.active_ && sql.data && sql.len > 0 && sql.len <= 65536 &&
          count <= 16 && (count == 0 || values));
    std::string text(reinterpret_cast<const char *>(sql.data),
                     static_cast<size_t>(sql.len));
    check(text.find('\0') == std::string::npos);
    const char *tail = nullptr;
    check(sqlite3_prepare_v2(db.active_, text.c_str(),
                             static_cast<int>(text.size() + 1), &stmt.value,
                             &tail) == SQLITE_OK &&
          stmt.value);
    check(tail && *tail == '\0' &&
          sqlite3_bind_parameter_count(stmt.value) == static_cast<int>(count));
    for (uint64_t i = 0; i < count; ++i) {
      const auto &v = values[i];
      check(v.reserved == 0);
      int code = SQLITE_ERROR;
      switch (v.kind) {
      case 0:
        code = sqlite3_bind_null(stmt.value, static_cast<int>(i + 1));
        break;
      case 1:
        code =
            sqlite3_bind_int64(stmt.value, static_cast<int>(i + 1), v.integer);
        break;
      case 2:
      case 3:
        check(v.bytes.len <= 33554432 && (v.bytes.len == 0 || v.bytes.data));
        if (v.kind == 2)
          code = sqlite3_bind_text(
              stmt.value, static_cast<int>(i + 1),
              v.bytes.len ? reinterpret_cast<const char *>(v.bytes.data) : "",
              static_cast<int>(v.bytes.len), SQLITE_TRANSIENT);
        else if (v.bytes.len == 0)
          code = sqlite3_bind_zeroblob(stmt.value, static_cast<int>(i + 1), 0);
        else
          code = sqlite3_bind_blob(stmt.value, static_cast<int>(i + 1),
                                   v.bytes.data, static_cast<int>(v.bytes.len),
                                   SQLITE_TRANSIENT);
        break;
      default:
        break;
      }
      check(code == SQLITE_OK);
    }
  }
  static citizensdk_error_code_t run(void *p, citizensdk_store_job_t job,
                                     void *context) noexcept {
    return protect([&] {
      auto &db = self(p);
      if (!job)
        return CITIZENSDK_ERROR_INVALID_ARGUMENT;
      std::lock_guard<std::mutex> guard(db.lock_);
      if (db.failed_)
        return CITIZENSDK_ERROR_STORAGE;
      if (!db.owner_)
        db.owner_ = std::make_unique<Owner>(
            db.directory_,
            db.secure_ ? "secure-state-v1.sqlite3" : "public-state-v1.sqlite3");
      return db.owner_->run([&](sqlite3 *connection) {
        db.active_ = connection;
        struct Reset {
          sqlite3 *&p;
          ~Reset() { p = nullptr; }
        } reset{db.active_};
        const auto code = job(context);
        if (sqlite3_get_autocommit(connection) == 0) {
          db.failed_ = true;
          db.owner_->close();
          return CITIZENSDK_ERROR_STORAGE;
        }
        return code;
      });
    });
  }
  static citizensdk_error_code_t execute(void *p, citizensdk_bytes_view_t sql,
                                         const citizensdk_sql_value_t *values,
                                         uint64_t count,
                                         uint64_t *changes) noexcept {
    return protect([&] {
      auto &db = self(p);
      check(changes);
      Statement stmt;
      prepare(db, sql, values, count, stmt);
      int code;
      do {
        code = sqlite3_step(stmt.value);
      } while (code == SQLITE_ROW);
      check(code == SQLITE_DONE);
      *changes = static_cast<uint64_t>(sqlite3_changes64(db.active_));
      return CITIZENSDK_OK;
    });
  }
  static citizensdk_error_code_t
  query(void *p, citizensdk_bytes_view_t sql,
        const citizensdk_sql_value_t *values, uint64_t count, uint64_t maximum,
        uint64_t budget, citizensdk_store_row_t row, void *context) noexcept {
    return protect([&] {
      auto &db = self(p);
      check(row && maximum <= 65537 && budget <= 33554432);
      Statement stmt;
      prepare(db, sql, values, count, stmt);
      uint64_t rows = 0;
      int code;
      while ((code = sqlite3_step(stmt.value)) == SQLITE_ROW) {
        check(++rows <= maximum);
        uint64_t remaining = budget;
        const int n = sqlite3_column_count(stmt.value);
        check(n >= 0 && n <= 64);
        std::vector<citizensdk_sql_value_t> cells(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) {
          auto &v = cells[static_cast<size_t>(i)];
          switch (sqlite3_column_type(stmt.value, i)) {
          case SQLITE_NULL:
            v.kind = 0;
            break;
          case SQLITE_INTEGER:
            v.kind = 1;
            v.integer = sqlite3_column_int64(stmt.value, i);
            break;
          case SQLITE_TEXT:
          case SQLITE_BLOB: {
            v.kind = sqlite3_column_type(stmt.value, i) == SQLITE_TEXT ? 2 : 3;
            const int size = sqlite3_column_bytes(stmt.value, i);
            check(size >= 0 && static_cast<uint64_t>(size) <= remaining);
            remaining -= static_cast<uint64_t>(size);
            v.bytes = {static_cast<const uint8_t *>(
                           sqlite3_column_blob(stmt.value, i)),
                       static_cast<uint64_t>(size)};
            check(size == 0 || v.bytes.data);
            break;
          }
          default:
            check(false);
          }
        }
        const auto result = row(context, cells.data(), cells.size());
        if (result != CITIZENSDK_OK)
          return result;
      }
      check(code == SQLITE_DONE);
      return CITIZENSDK_OK;
    });
  }
  static citizensdk_error_code_t command(Database &db, const char *sql) {
    check(db.active_);
    check(sqlite3_exec(db.active_, sql, nullptr, nullptr, nullptr) ==
          SQLITE_OK);
    return CITIZENSDK_OK;
  }
  static citizensdk_error_code_t begin(void *p) noexcept {
    return protect([&] { return command(self(p), "BEGIN IMMEDIATE"); });
  }
  static citizensdk_error_code_t end(void *p, uint8_t commit) noexcept {
    return protect([&] {
      auto &db = self(p);
      check(commit <= 1);
      if (commit)
        db.owner_->check();
      return command(db, commit ? "COMMIT" : "ROLLBACK");
    });
  }
  static citizensdk_error_code_t wal(void *p) noexcept {
    return protect([&] {
      auto &db = self(p);
      Statement stmt;
      check(sqlite3_prepare_v2(db.active_, "PRAGMA journal_mode=WAL", -1,
                               &stmt.value, nullptr) == SQLITE_OK);
      check(sqlite3_step(stmt.value) == SQLITE_ROW);
      const auto *mode = sqlite3_column_text(stmt.value, 0);
      check(mode && std::string(reinterpret_cast<const char *>(mode)) == "wal");
      check(sqlite3_step(stmt.value) == SQLITE_DONE);
      return CITIZENSDK_OK;
    });
  }
  std::filesystem::path directory_;
  std::mutex lock_;
  std::unique_ptr<Owner> owner_;
  sqlite3 *active_{};
  bool failed_{};
  bool secure_{};
};

// 平台硬件金库的薄客户端：只组装POD/缓冲，所有状态规则由同一Rust Store执行。
class VaultStore {
public:
  explicit VaultStore(citizensdk_store_v1_t resource) : resource_(resource) {}
  bool ensure_generation(const WalletKey &key,
                         const std::array<uint8_t, 16> &op) {
    return generation(1, key, op);
  }
  bool is_generation_active(const WalletKey &key) {
    return generation(2, key, {});
  }
  bool generation_owned_by(const WalletKey &key,
                           const std::array<uint8_t, 16> &op) {
    return generation(3, key, op);
  }
  void retire_generation(const WalletKey &key,
                         const std::array<uint8_t, 16> &op) {
    (void)generation(4, key, op);
  }
  bool has_any_wallet_key(uint32_t index) {
    WalletKey key{};
    key.wallet_index = index;
    return generation(5, key, {});
  }
  std::vector<WalletKey> vault_generations() {
    std::vector<citizensdk_host_wallet_key_ref_v1_t> values(65536);
    uint64_t count = 0;
    check(citizensdk_store_generations(&resource_, values.data(), values.size(),
                                       &count));
    require(count <= values.size(), CITIZENSDK_ERROR_INTEGRITY,
            "vault generation count differs");
    std::vector<WalletKey> keys;
    keys.reserve(static_cast<size_t>(count));
    for (size_t i = 0; i < static_cast<size_t>(count); ++i) {
      WalletKey key{};
      key.wallet_index = values[i].wallet_index;
      std::copy(std::begin(values[i].generation.bytes),
                std::end(values[i].generation.bytes), key.generation.begin());
      keys.push_back(key);
    }
    return keys;
  }
  std::optional<VaultObject> load_vault_object(const WalletKey &key) {
    auto ref = reference(key);
    std::array<Bytes, 5> data{Bytes(43), Bytes(8192), Bytes(8192), Bytes(1024),
                              Bytes(16)};
    citizensdk_mutable_bytes_view_t fields[5]{};
    uint64_t sizes[5]{};
    for (size_t i = 0; i < 5; ++i)
      fields[i] = {data[i].data(), data[i].size()};
    uint8_t found = 0;
    check(citizensdk_store_object(&resource_, 1, &ref, nullptr, nullptr, fields,
                                  sizes, &found));
    if (!found)
      return {};
    for (size_t i = 0; i < 5; ++i) {
      require(sizes[i] <= data[i].size(), CITIZENSDK_ERROR_INTEGRITY,
              "vault object output differs");
      data[i].resize(static_cast<size_t>(sizes[i]));
    }
    VaultObject object;
    object.key_name = std::string(data[0].begin(), data[0].end());
    object.public_blob = std::move(data[1]);
    object.private_blob = std::move(data[2]);
    object.name = std::move(data[3]);
    object.auth_salt = std::move(data[4]);
    return object;
  }
  void store_vault_object_if_owned(const WalletKey &key,
                                   const std::array<uint8_t, 16> &operation,
                                   const VaultObject &object) {
    (void)object_call(2, key, operation, &object);
  }
  bool vault_object_is_active(const WalletKey &key, const VaultObject &object) {
    return object_call(3, key, {}, &object);
  }
  void delete_vault_object(const WalletKey &key) {
    (void)object_call(4, key, {}, nullptr);
  }

private:
  static void check(int32_t code) {
    require(code == CITIZENSDK_OK, code, "Rust secure store operation failed");
  }
  static citizensdk_host_wallet_key_ref_v1_t reference(const WalletKey &key) {
    citizensdk_host_wallet_key_ref_v1_t ref{};
    ref.struct_size = sizeof(ref);
    ref.abi_version = CITIZENSDK_ABI_VERSION;
    ref.wallet_index = key.wallet_index;
    std::copy(key.generation.begin(), key.generation.end(),
              ref.generation.bytes);
    return ref;
  }
  bool generation(uint32_t action, const WalletKey &key,
                  const std::array<uint8_t, 16> &operation) {
    auto ref = reference(key);
    citizensdk_host_id128_t op{};
    std::copy(operation.begin(), operation.end(), op.bytes);
    uint8_t value = 0;
    check(citizensdk_store_generation(&resource_, action, &ref, &op, &value));
    return value != 0;
  }
  bool object_call(uint32_t action, const WalletKey &key,
                   const std::array<uint8_t, 16> &operation,
                   const VaultObject *object) {
    auto ref = reference(key);
    citizensdk_host_id128_t op{};
    std::copy(operation.begin(), operation.end(), op.bytes);
    citizensdk_bytes_view_t fields[5]{};
    if (object) {
      fields[0] = {reinterpret_cast<const uint8_t *>(object->key_name.data()),
                   object->key_name.size()};
      fields[1] = {object->public_blob.data(), object->public_blob.size()};
      fields[2] = {object->private_blob.data(), object->private_blob.size()};
      fields[3] = {object->name.data(), object->name.size()};
      fields[4] = {object->auth_salt.data(), object->auth_salt.size()};
    }
    uint8_t found = 0;
    check(citizensdk_store_object(&resource_, action, &ref, &op,
                                  object ? fields : nullptr, nullptr, nullptr,
                                  &found));
    return found != 0;
  }
  citizensdk_store_v1_t resource_;
};

} // namespace citizen_sdk
#endif
