// 来源：linux/src/citizen_sdk_public_store.cc；仅平台命名空间不同，THQ1/THM1 与 SQL 合同逐字一致。
#include "citizen_sdk_public_store.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <set>
#include <string>
#include <utility>
#include <vector>
#include "citizen_sdk_record_key.hpp"

namespace citizen_sdk::windows {
namespace {

constexpr std::size_t kMaximumHistoryWireBytes = 32U * 1024U * 1024U;
constexpr uint64_t kMaximumHistoryWeight = 31U * 1024U * 1024U;
constexpr uint32_t kMaximumHistoryRecords = 4096;
constexpr uint32_t kMaximumHistoryPage = 100;
using ExecutionId = std::array<uint8_t, 16>;

struct HistoryIndex {
  uint64_t revision{};
  uint32_t record_count{};
  uint64_t durable_weight{};
  uint32_t open_count{};
  uint64_t open_weight{};
};

struct HistoryDescriptor {
  ExecutionId execution_id{};
  uint64_t created{};
  uint64_t updated{};
  uint64_t weight{};
  bool retention_terminal{};
  bool chain_terminal{};
  Bytes record;
};

class Reader final {
 public:
  explicit Reader(const Bytes &bytes) : bytes_(bytes) {
    require(bytes.size() <= kMaximumHistoryWireBytes,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK history wire value is too large");
  }
  void magic(const char expected[5]) {
    require(remaining() >= 4 &&
                std::equal(bytes_.begin() + static_cast<std::ptrdiff_t>(offset_),
                           bytes_.begin() + static_cast<std::ptrdiff_t>(offset_ + 4),
                           expected),
            CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history wire magic is invalid");
    offset_ += 4;
  }
  uint8_t u8() {
    require(remaining() >= 1, CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history wire is truncated");
    return bytes_[offset_++];
  }
  bool boolean() {
    const uint8_t value = u8();
    require(value <= 1, CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history boolean is invalid");
    return value != 0;
  }
  uint32_t u32() {
    require(remaining() >= 4, CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history wire is truncated");
    uint32_t value = 0;
    for (int shift = 0; shift < 32; shift += 8) value |= uint32_t(u8()) << shift;
    return value;
  }
  uint64_t u64() {
    require(remaining() >= 8, CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history wire is truncated");
    uint64_t value = 0;
    for (int shift = 0; shift < 64; shift += 8) value |= uint64_t(u8()) << shift;
    return value;
  }
  ExecutionId id() {
    require(remaining() >= 16, CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history wire is truncated");
    ExecutionId result{};
    std::copy_n(bytes_.begin() + static_cast<std::ptrdiff_t>(offset_), 16,
                result.begin());
    offset_ += 16;
    return result;
  }
  Bytes bytes(uint32_t maximum) {
    const uint32_t count = u32();
    require(count <= maximum && remaining() >= count,
            CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history byte field is invalid");
    Bytes result(bytes_.begin() + static_cast<std::ptrdiff_t>(offset_),
                 bytes_.begin() + static_cast<std::ptrdiff_t>(offset_ + count));
    offset_ += count;
    return result;
  }
  void finish() const {
    require(offset_ == bytes_.size(), CITIZENSDK_ERROR_DECODE,
            "CitizenSDK history wire has trailing bytes");
  }

 private:
  std::size_t remaining() const { return bytes_.size() - offset_; }
  const Bytes &bytes_;
  std::size_t offset_{};
};

class Writer final {
 public:
  void magic(const char value[5]) { bytes_.insert(bytes_.end(), value, value + 4); }
  void u8(uint8_t value) { bytes_.push_back(value); }
  void u32(uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) u8(static_cast<uint8_t>(value >> shift));
  }
  void u64(uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8) u8(static_cast<uint8_t>(value >> shift));
  }
  void id(const ExecutionId &value) { bytes_.insert(bytes_.end(), value.begin(), value.end()); }
  void bytes(const Bytes &value) {
    require(value.size() <= std::numeric_limits<uint32_t>::max(),
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK history record is too large");
    u32(static_cast<uint32_t>(value.size()));
    bytes_.insert(bytes_.end(), value.begin(), value.end());
  }
  Bytes finish() {
    require(bytes_.size() <= kMaximumHistoryWireBytes,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK history response is too large");
    return std::move(bytes_);
  }

 private:
  Bytes bytes_;
};

bool zero(const ExecutionId &value) {
  return std::all_of(value.begin(), value.end(), [](uint8_t byte) { return byte == 0; });
}

int64_t sqlite_integer(uint64_t value, const char *message) {
  require(value <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max()),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, message);
  return static_cast<int64_t>(value);
}

std::string id_key(const ExecutionId &value) {
  return record_key::hex(value.data(), value.size());
}

ExecutionId decode_id_key(const std::string &value) {
  require(value.size() == 32, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK history execution ID key is malformed");
  ExecutionId result{};
  const auto nibble = [](char character) -> uint8_t {
    if (character >= '0' && character <= '9') return static_cast<uint8_t>(character - '0');
    if (character >= 'a' && character <= 'f') return static_cast<uint8_t>(character - 'a' + 10);
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK history execution ID key is malformed");
  };
  for (std::size_t index = 0; index < result.size(); ++index) {
    result[index] = static_cast<uint8_t>((nibble(value[index * 2]) << 4) |
                                         nibble(value[index * 2 + 1]));
  }
  return result;
}

HistoryIndex decode_index(Reader &reader) {
  HistoryIndex index{reader.u64(), reader.u32(), reader.u64(), reader.u32(), reader.u64()};
  require(index.revision <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) &&
              index.record_count <= kMaximumHistoryRecords &&
              index.durable_weight <= kMaximumHistoryWeight &&
              index.open_count <= index.record_count &&
              index.open_weight <= index.durable_weight,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK history index is invalid");
  return index;
}

void encode_index(Writer &writer, const HistoryIndex &index) {
  writer.u64(index.revision);
  writer.u32(index.record_count);
  writer.u64(index.durable_weight);
  writer.u32(index.open_count);
  writer.u64(index.open_weight);
}

HistoryDescriptor decode_descriptor(Reader &reader) {
  HistoryDescriptor value;
  value.execution_id = reader.id();
  value.created = reader.u64();
  value.updated = reader.u64();
  value.weight = reader.u64();
  value.retention_terminal = reader.boolean();
  value.chain_terminal = reader.boolean();
  value.record = reader.bytes(static_cast<uint32_t>(kMaximumHistoryWireBytes));
  require(!zero(value.execution_id) && value.created <= value.updated && value.weight > 0 &&
              value.weight <= kMaximumHistoryWeight &&
              (!value.chain_terminal || value.retention_terminal) &&
              value.created <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) &&
              value.updated <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) &&
              !value.record.empty(),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK history descriptor is invalid");
  return value;
}

void encode_descriptor(Writer &writer, const HistoryDescriptor &value) {
  writer.id(value.execution_id);
  writer.u64(value.created);
  writer.u64(value.updated);
  writer.u64(value.weight);
  writer.u8(value.retention_terminal ? 1 : 0);
  writer.u8(value.chain_terminal ? 1 : 0);
  writer.bytes(value.record);
}

HistoryIndex load_index(sqlite3 *database) {
  SQLiteStore::Statement query(database,
      "SELECT revision, record_count, durable_weight, open_count, open_weight "
      "FROM transaction_history_meta WHERE singleton = 1");
  if (!query.step_row_or_done()) return {};
  HistoryIndex index{
      static_cast<uint64_t>(query.integer(0, 1, std::numeric_limits<int64_t>::max())),
      static_cast<uint32_t>(query.integer(1, 0, kMaximumHistoryRecords)),
      static_cast<uint64_t>(query.integer(2, 0, kMaximumHistoryWeight)),
      static_cast<uint32_t>(query.integer(3, 0, kMaximumHistoryRecords)),
      static_cast<uint64_t>(query.integer(4, 0, kMaximumHistoryWeight))};
  require(index.open_count <= index.record_count && index.open_weight <= index.durable_weight,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK history meta is inconsistent");
  require(!query.step_row_or_done(), CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK history meta has duplicate rows");
  return index;
}

Bytes encode_batch(const HistoryIndex &index,
                   const std::vector<HistoryDescriptor> &records,
                   bool has_more) {
  Writer writer;
  writer.magic("THB1");
  encode_index(writer, index);
  writer.u8(has_more ? 1 : 0);
  writer.u32(static_cast<uint32_t>(records.size()));
  for (const auto &record : records) encode_descriptor(writer, record);
  return writer.finish();
}

HistoryDescriptor row_descriptor(SQLiteStore::Statement &query) {
  HistoryDescriptor result;
  result.execution_id = decode_id_key(query.text(0, 32));
  result.created = static_cast<uint64_t>(query.integer(1, 0, std::numeric_limits<int64_t>::max()));
  result.updated = static_cast<uint64_t>(query.integer(2, 0, std::numeric_limits<int64_t>::max()));
  result.weight = static_cast<uint64_t>(query.integer(3, 1, kMaximumHistoryWeight));
  result.retention_terminal = query.integer(4, 0, 1) != 0;
  result.chain_terminal = query.integer(5, 0, 1) != 0;
  result.record = query.bytes(6, static_cast<int>(kMaximumHistoryWireBytes));
  require(!result.record.empty() && (!result.chain_terminal || result.retention_terminal),
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK history row is invalid");
  return result;
}

void subtract_record(HistoryIndex &index, uint64_t weight, bool retention_terminal) {
  require(index.record_count > 0 && index.durable_weight >= weight,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK history aggregate underflow");
  --index.record_count;
  index.durable_weight -= weight;
  if (!retention_terminal) {
    require(index.open_count > 0 && index.open_weight >= weight,
            CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK history open aggregate underflow");
    --index.open_count;
    index.open_weight -= weight;
  }
}

void add_record(HistoryIndex &index, const HistoryDescriptor &record) {
  require(index.record_count < kMaximumHistoryRecords &&
              index.durable_weight <= kMaximumHistoryWeight - record.weight,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK history capacity is exceeded");
  ++index.record_count;
  index.durable_weight += record.weight;
  if (!record.retention_terminal) {
    require(index.open_count < kMaximumHistoryRecords &&
                index.open_weight <= kMaximumHistoryWeight - record.weight,
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK history open capacity is exceeded");
    ++index.open_count;
    index.open_weight += record.weight;
  }
}

bool same_index(const HistoryIndex &left, const HistoryIndex &right) {
  return left.revision == right.revision && left.record_count == right.record_count &&
         left.durable_weight == right.durable_weight && left.open_count == right.open_count &&
         left.open_weight == right.open_weight;
}

}  // namespace

PublicStore::PublicStore(const std::filesystem::path &directory)
    : SQLiteStore(directory, "public-state-v1.sqlite3",
                  {"CREATE TABLE IF NOT EXISTS singleton_records ("
                   "domain INTEGER PRIMARY KEY CHECK(domain = 1), "
                   "revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), "
                   "record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 524288))",
                   "CREATE TABLE IF NOT EXISTS runtime_cache ("
                   "record_key TEXT PRIMARY KEY, record BLOB NOT NULL "
                   "CHECK(typeof(record) = 'blob' AND length(record) <= 8388608))",
                   "CREATE TABLE IF NOT EXISTS transaction_history_meta ("
                   "singleton INTEGER PRIMARY KEY CHECK(singleton = 1), "
                   "revision INTEGER NOT NULL CHECK(revision > 0), "
                   "record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 4096), "
                   "durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 0 AND 32505856), "
                   "open_count INTEGER NOT NULL CHECK(open_count BETWEEN 0 AND record_count), "
                   "open_weight INTEGER NOT NULL CHECK(open_weight BETWEEN 0 AND durable_weight))",
                   "CREATE TABLE IF NOT EXISTS transaction_history_records ("
                   "execution_id TEXT PRIMARY KEY CHECK(length(execution_id) = 32 AND execution_id NOT GLOB '*[^0-9a-f]*'), "
                   "created_at_millis INTEGER NOT NULL CHECK(created_at_millis >= 0), "
                   "updated_at_millis INTEGER NOT NULL CHECK(updated_at_millis >= created_at_millis), "
                   "durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 1 AND 32505856), "
                   "retention_terminal INTEGER NOT NULL CHECK(retention_terminal IN (0,1)), "
                   "chain_terminal INTEGER NOT NULL CHECK(chain_terminal IN (0,1) AND chain_terminal <= retention_terminal), "
                   "record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 33554432))",
                   "CREATE INDEX IF NOT EXISTS transaction_history_newest_idx ON "
                   "transaction_history_records(created_at_millis DESC, execution_id DESC)",
                   "CREATE INDEX IF NOT EXISTS transaction_history_retention_idx ON "
                   "transaction_history_records(retention_terminal, created_at_millis, execution_id)",
                   "CREATE INDEX IF NOT EXISTS transaction_history_reconcile_idx ON "
                   "transaction_history_records(chain_terminal, created_at_millis, execution_id)"},
                  false, 2, true) {}

HostRecord PublicStore::chain_database_load() {
  return singleton_load(CITIZENSDK_HOST_RECORD_CHAIN_DATABASE);
}

HostRecord PublicStore::chain_database_compare_and_swap(uint64_t expected,
                                                         const Bytes &candidate) {
  return singleton_compare_and_swap(CITIZENSDK_HOST_RECORD_CHAIN_DATABASE,
                                    expected, candidate);
}

HostRecord PublicStore::transaction_history_query(const Bytes &wire) {
  Reader reader(wire);
  reader.magic("THQ1");
  const uint8_t kind = reader.u8();
  const uint64_t expected = reader.u64();
  const uint32_t limit = reader.u32();
  const ExecutionId exact = reader.id();
  const bool has_cursor = reader.boolean();
  const uint64_t cursor_created = reader.u64();
  const ExecutionId cursor_id = reader.id();
  reader.finish();
  require(kind >= 1 && kind <= 5 &&
              (kind == 1 ? expected == std::numeric_limits<uint64_t>::max() && limit == 0
                         : kind == 2 ? limit == 1 && !zero(exact)
                                     : limit >= 1 && limit <= kMaximumHistoryPage) &&
              (kind == 2 || zero(exact)) &&
              (has_cursor || (cursor_created == 0 && zero(cursor_id))) &&
              (!has_cursor || (kind >= 3 && !zero(cursor_id))),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK history query shape is invalid");

  return read([&](sqlite3 *database) {
    const HistoryIndex index = load_index(database);
    if (kind != 1 && index.revision != expected) {
      return HostRecord::failure(CITIZENSDK_HOST_RECORD_TRANSACTION_HISTORY,
                                 CITIZENSDK_ERROR_CONFLICT);
    }
    std::vector<HistoryDescriptor> records;
    bool more = false;
    if (kind == 2) {
      Statement query(database,
          "SELECT execution_id, created_at_millis, updated_at_millis, durable_weight, "
          "retention_terminal, chain_terminal, record FROM transaction_history_records "
          "WHERE execution_id = ?");
      query.bind(1, id_key(exact));
      if (query.step_row_or_done()) records.push_back(row_descriptor(query));
    } else if (kind >= 3) {
      std::string sql =
          "SELECT execution_id, created_at_millis, updated_at_millis, durable_weight, "
          "retention_terminal, chain_terminal, record FROM transaction_history_records WHERE ";
      if (kind == 4) sql += "retention_terminal = 1";
      else if (kind == 5) sql += "chain_terminal = 0";
      else sql += "1 = 1";
      if (has_cursor) {
        sql += kind == 3
            ? " AND (created_at_millis < ? OR (created_at_millis = ? AND execution_id < ?))"
            : " AND (created_at_millis > ? OR (created_at_millis = ? AND execution_id > ?))";
      }
      sql += kind == 3
          ? " ORDER BY created_at_millis DESC, execution_id DESC LIMIT ?"
          : " ORDER BY created_at_millis ASC, execution_id ASC LIMIT ?";
      Statement query(database, sql.c_str());
      int parameter = 1;
      if (has_cursor) {
        const int64_t created = sqlite_integer(cursor_created,
                                               "CitizenSDK history cursor is too large");
        query.bind(parameter++, created);
        query.bind(parameter++, created);
        query.bind(parameter++, id_key(cursor_id));
      }
      query.bind(parameter, static_cast<int64_t>(limit) + 1);
      while (query.step_row_or_done()) {
        if (records.size() == limit) {
          more = true;
          break;
        }
        records.push_back(row_descriptor(query));
      }
    }
    Bytes response = encode_batch(index, records, more);
    return HostRecord::value(CITIZENSDK_HOST_RECORD_TRANSACTION_HISTORY,
                             index.revision, response);
  });
}

HostRecord PublicStore::transaction_history_mutate(uint64_t expected,
                                                    const Bytes &wire) {
  Reader reader(wire);
  reader.magic("THM1");
  const HistoryIndex next = decode_index(reader);
  const uint32_t delete_count = reader.u32();
  require(delete_count <= kMaximumHistoryRecords,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK history delete batch is too large");
  std::vector<ExecutionId> deletes;
  std::set<ExecutionId> identities;
  for (uint32_t index = 0; index < delete_count; ++index) {
    const ExecutionId id = reader.id();
    require(!zero(id) && identities.insert(id).second,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK history mutation contains duplicate IDs");
    deletes.push_back(id);
  }
  const uint32_t upsert_count = reader.u32();
  require(upsert_count <= kMaximumHistoryPage,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK history upsert batch is too large");
  std::vector<HistoryDescriptor> upserts;
  for (uint32_t index = 0; index < upsert_count; ++index) {
    HistoryDescriptor record = decode_descriptor(reader);
    require(identities.insert(record.execution_id).second,
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK history mutation contains conflicting IDs");
    upserts.push_back(std::move(record));
  }
  reader.finish();
  require(expected < static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) &&
              next.revision == expected + 1,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK history mutation revision is invalid");

  HostRecord result = transaction([&](sqlite3 *database) {
    HistoryIndex computed = load_index(database);
    if (computed.revision != expected) {
      return HostRecord::failure(CITIZENSDK_HOST_RECORD_TRANSACTION_HISTORY,
                                 CITIZENSDK_ERROR_CONFLICT);
    }
    for (const ExecutionId &id : deletes) {
      Statement query(database,
          "SELECT durable_weight, retention_terminal FROM transaction_history_records "
          "WHERE execution_id = ?");
      query.bind(1, id_key(id));
      require(query.step_row_or_done(), CITIZENSDK_ERROR_INTEGRITY,
              "CitizenSDK history delete target is missing");
      const uint64_t weight = static_cast<uint64_t>(
          query.integer(0, 1, kMaximumHistoryWeight));
      const bool terminal = query.integer(1, 0, 1) != 0;
      require(terminal, CITIZENSDK_ERROR_INTEGRITY,
              "CitizenSDK history mutation cannot delete an open execution");
      subtract_record(computed, weight, terminal);
      Statement erase(database,
          "DELETE FROM transaction_history_records WHERE execution_id = ?");
      erase.bind(1, id_key(id));
      erase.step_done();
    }
    for (const HistoryDescriptor &record : upserts) {
      Statement query(database,
          "SELECT durable_weight, retention_terminal FROM transaction_history_records "
          "WHERE execution_id = ?");
      query.bind(1, id_key(record.execution_id));
      if (query.step_row_or_done()) {
        subtract_record(computed,
            static_cast<uint64_t>(query.integer(0, 1, kMaximumHistoryWeight)),
            query.integer(1, 0, 1) != 0);
      }
      add_record(computed, record);
      Statement write(database,
          "INSERT OR REPLACE INTO transaction_history_records("
          "execution_id, created_at_millis, updated_at_millis, durable_weight, "
          "retention_terminal, chain_terminal, record) VALUES(?, ?, ?, ?, ?, ?, ?)");
      write.bind(1, id_key(record.execution_id));
      write.bind(2, sqlite_integer(record.created, "CitizenSDK history timestamp is too large"));
      write.bind(3, sqlite_integer(record.updated, "CitizenSDK history timestamp is too large"));
      write.bind(4, sqlite_integer(record.weight, "CitizenSDK history weight is too large"));
      write.bind(5, static_cast<int64_t>(record.retention_terminal));
      write.bind(6, static_cast<int64_t>(record.chain_terminal));
      write.bind(7, record.record);
      write.step_done();
    }
    computed.revision = next.revision;
    require(same_index(computed, next), CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK history mutation aggregate is inconsistent");
    Statement meta(database,
        "INSERT OR REPLACE INTO transaction_history_meta("
        "singleton, revision, record_count, durable_weight, open_count, open_weight) "
        "VALUES(1, ?, ?, ?, ?, ?)");
    meta.bind(1, sqlite_integer(next.revision, "CitizenSDK history revision is too large"));
    meta.bind(2, static_cast<int64_t>(next.record_count));
    meta.bind(3, sqlite_integer(next.durable_weight, "CitizenSDK history weight is too large"));
    meta.bind(4, static_cast<int64_t>(next.open_count));
    meta.bind(5, sqlite_integer(next.open_weight, "CitizenSDK history weight is too large"));
    meta.step_done();
    return HostRecord::value(CITIZENSDK_HOST_RECORD_TRANSACTION_HISTORY,
                             next.revision, encode_batch(next, {}, false));
  });
  if (result.error_code == CITIZENSDK_OK && !deletes.empty()) reclaim_history_pages();
  return result;
}

HostRecord PublicStore::runtime_cache_load(const std::array<uint8_t, 32> &hash) {
  const std::string key = record_key::block_hash(hash);
  return read([&](sqlite3 *database) {
    Statement statement(database, "SELECT record FROM runtime_cache WHERE record_key = ?");
    statement.bind(1, key);
    if (statement.step_row_or_done()) {
      return HostRecord::value(CITIZENSDK_HOST_RECORD_RUNTIME_CACHE, 0,
                               statement.bytes(0, 8388608));
    }
    return HostRecord::absent(CITIZENSDK_HOST_RECORD_RUNTIME_CACHE);
  });
}

void PublicStore::runtime_cache_store(const std::array<uint8_t, 32> &hash,
                                      const Bytes &candidate) {
  require(candidate.size() <= 8388608, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK runtime cache is too large");
  const std::string key = record_key::block_hash(hash);
  (void)transaction([&](sqlite3 *database) {
    Statement statement(database,
        "INSERT OR REPLACE INTO runtime_cache(record_key, record) VALUES(?, ?)");
    statement.bind(1, key);
    statement.bind(2, candidate);
    statement.step_done();
    Statement prune(database,
        "DELETE FROM runtime_cache WHERE rowid NOT IN "
        "(SELECT rowid FROM runtime_cache ORDER BY rowid DESC LIMIT 64)");
    prune.step_done();
    return true;
  });
}

void PublicStore::runtime_cache_delete(const std::array<uint8_t, 32> &hash) {
  const std::string key = record_key::block_hash(hash);
  (void)transaction([&](sqlite3 *database) {
    Statement statement(database, "DELETE FROM runtime_cache WHERE record_key = ?");
    statement.bind(1, key);
    statement.step_done();
    return true;
  });
}

HostRecord PublicStore::singleton_load(citizensdk_host_record_domain_t domain) {
  return read([&](sqlite3 *database) {
    Statement statement(database,
        "SELECT revision, record FROM singleton_records WHERE domain = ?");
    statement.bind(1, static_cast<int64_t>(domain));
    if (statement.step_row_or_done()) {
      return HostRecord::value(domain,
          static_cast<uint64_t>(statement.integer(0, 1, std::numeric_limits<int64_t>::max())),
          statement.bytes(1, 524288));
    }
    return HostRecord::absent(domain);
  });
}

HostRecord PublicStore::singleton_compare_and_swap(
    citizensdk_host_record_domain_t domain, uint64_t expected,
    const Bytes &candidate) {
  require(domain == CITIZENSDK_HOST_RECORD_CHAIN_DATABASE &&
              candidate.size() <= 524288,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK public record domain or size is invalid");
  if (expected >= static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    return HostRecord::failure(domain, CITIZENSDK_ERROR_CONFLICT);
  }
  return transaction([&](sqlite3 *database) {
    Statement query(database,
        "SELECT revision FROM singleton_records WHERE domain = ?");
    query.bind(1, static_cast<int64_t>(domain));
    uint64_t actual = 0;
    if (query.step_row_or_done()) {
      actual = static_cast<uint64_t>(query.integer(
          0, 1, std::numeric_limits<int64_t>::max()));
    }
    if (actual != expected) return HostRecord::failure(domain, CITIZENSDK_ERROR_CONFLICT);
    const uint64_t next = expected + 1;
    Statement write(database,
        "INSERT OR REPLACE INTO singleton_records(domain, revision, record) VALUES(?, ?, ?)");
    write.bind(1, static_cast<int64_t>(domain));
    write.bind(2, static_cast<int64_t>(next));
    write.bind(3, candidate);
    write.step_done();
    return HostRecord::value(domain, next, candidate);
  });
}

void PublicStore::reclaim_history_pages() {
  read([&](sqlite3 *database) {
    Statement pages(database, "PRAGMA page_count");
    require(pages.step_row_or_done(), CITIZENSDK_ERROR_STORAGE,
            "CitizenSDK history page count is unavailable");
    const int64_t page_count = pages.integer(0, 0, std::numeric_limits<int64_t>::max());
    Statement free_pages(database, "PRAGMA freelist_count");
    require(free_pages.step_row_or_done(), CITIZENSDK_ERROR_STORAGE,
            "CitizenSDK history freelist count is unavailable");
    const int64_t freelist = free_pages.integer(0, 0, std::numeric_limits<int64_t>::max());
    if (freelist > 16 && freelist * 4 > page_count) {
      execute(database, "PRAGMA incremental_vacuum(128)");
      execute(database, "PRAGMA wal_checkpoint(PASSIVE)");
    }
    return true;
  });
}

}  // namespace citizen_sdk::windows
