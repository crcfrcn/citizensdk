import Foundation
import SQLite3

/// Reconstructable chain state and generic SDK execution history; never App business data or secrets.
internal final class CitizenSDKPublicStore: CitizenSDKSQLite {
    private static let maximumHistoryWire = 32 * 1024 * 1024
    private static let maximumHistoryWeight: UInt64 = 31 * 1024 * 1024

    init(directory: URL) throws {
        try super.init(
            directory: directory,
            fileName: "public-state-v1.sqlite3",
            schema: [
                "CREATE TABLE IF NOT EXISTS singleton_records (domain INTEGER PRIMARY KEY CHECK(domain = 1), revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 524288))",
                "CREATE TABLE IF NOT EXISTS runtime_cache (record_key TEXT PRIMARY KEY, record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 8388608))",
                "CREATE TABLE IF NOT EXISTS transaction_history_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL CHECK(revision > 0), record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 4096), durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 0 AND 32505856), open_count INTEGER NOT NULL CHECK(open_count BETWEEN 0 AND record_count), open_weight INTEGER NOT NULL CHECK(open_weight BETWEEN 0 AND durable_weight))",
                "CREATE TABLE IF NOT EXISTS transaction_history_records (execution_id TEXT PRIMARY KEY CHECK(length(execution_id) = 32 AND execution_id NOT GLOB '*[^0-9a-f]*'), created_at_millis INTEGER NOT NULL CHECK(created_at_millis >= 0), updated_at_millis INTEGER NOT NULL CHECK(updated_at_millis >= created_at_millis), durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 1 AND 32505856), retention_terminal INTEGER NOT NULL CHECK(retention_terminal IN (0,1)), chain_terminal INTEGER NOT NULL CHECK(chain_terminal IN (0,1) AND chain_terminal <= retention_terminal), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 33554432))",
                "CREATE INDEX IF NOT EXISTS transaction_history_newest_idx ON transaction_history_records(created_at_millis DESC, execution_id DESC)",
                "CREATE INDEX IF NOT EXISTS transaction_history_retention_idx ON transaction_history_records(retention_terminal, created_at_millis, execution_id)",
                "CREATE INDEX IF NOT EXISTS transaction_history_reconcile_idx ON transaction_history_records(chain_terminal, created_at_millis, execution_id)",
            ],
            secure: false,
            schemaVersion: 2,
            incrementalVacuum: true
        )
    }

    func chainDatabaseLoad() throws -> CitizenSDKHostRecord { try loadSingleton(.chainDatabase) }
    func chainDatabaseCAS(expected: UInt64, candidate: Data) throws -> CitizenSDKHostRecord {
        try compareAndSwapSingleton(.chainDatabase, expected: expected, candidate: candidate)
    }

    func runtimeCacheLoad(hash: Data) throws -> CitizenSDKHostRecord {
        let key = try CitizenSDKRecordKey.blockHash(hash)
        return try read { database in
            let statement = try Self.prepare(database, "SELECT record FROM runtime_cache WHERE record_key = ?")
            defer { sqlite3_finalize(statement) }
            try Self.bind(statement, 1, key)
            if try Self.stepRowOrDone(statement) {
                return .present(.runtimeCache, revision: 0, record: Self.data(statement, 0))
            }
            return .absent(.runtimeCache)
        }
    }

    func runtimeCacheStore(hash: Data, candidate: Data) throws {
        let key = try CitizenSDKRecordKey.blockHash(hash)
        try transaction { database in
            let statement = try Self.prepare(database,
                "INSERT OR REPLACE INTO runtime_cache(record_key, record) VALUES(?, ?)")
            defer { sqlite3_finalize(statement) }
            try Self.bind(statement, 1, key)
            try Self.bind(statement, 2, candidate)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw CitizenSDKError(.storage, "runtime cache write failed")
            }
            try Self.execute(database, "DELETE FROM runtime_cache WHERE rowid NOT IN " +
                "(SELECT rowid FROM runtime_cache ORDER BY rowid DESC LIMIT 64)")
        }
    }

    func runtimeCacheDelete(hash: Data) throws {
        let key = try CitizenSDKRecordKey.blockHash(hash)
        try transaction { database in
            let statement = try Self.prepare(database, "DELETE FROM runtime_cache WHERE record_key = ?")
            defer { sqlite3_finalize(statement) }
            try Self.bind(statement, 1, key)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw CitizenSDKError(.storage, "runtime cache delete failed")
            }
        }
    }

    /// Executes Core's fixed THQ1 index/exact/page query without decoding opaque execution records.
    func transactionHistoryQuery(_ bytes: Data) throws -> CitizenSDKHostRecord {
        var reader = try HistoryReader(bytes)
        let query = try reader.query()
        return try read { database in
            let index = try historyIndex(database)
            guard query.kind == 1 || query.expectedRevision == index.revision else {
                return .failure(.transactionHistory, .conflict)
            }
            let selected: [HistoryDescriptor]
            switch query.kind {
            case 1: selected = []
            case 2: selected = try historyExact(database, executionID: query.exactID)
            default: selected = try historyPage(database, query: query)
            }
            let visible = Array(selected.prefix(query.limit))
            return .present(.transactionHistory, revision: index.revision,
                            record: try HistoryWriter.batch(index, visible,
                                                            hasMore: selected.count > visible.count))
        }
    }

    /// Applies one THM1 delete/upsert/meta transition under the supplied revision fence.
    func transactionHistoryMutate(expected: UInt64, bytes: Data) throws -> CitizenSDKHostRecord {
        var reader = try HistoryReader(bytes)
        let mutation = try reader.mutation(expected: expected)
        let result = try transaction { database in
            var computed = try historyIndex(database)
            guard computed.revision == expected else {
                return CitizenSDKHostRecord.failure(.transactionHistory, .conflict)
            }
            for executionID in mutation.deletes {
                guard let current = try historyResource(database, executionID: executionID) else {
                    throw CitizenSDKError(.integrity, "history delete target is missing")
                }
                guard current.retentionTerminal else {
                    throw CitizenSDKError(.integrity,
                                          "history mutation cannot delete an open execution")
                }
                computed = try computed.removing(current)
                let statement = try Self.prepare(database,
                    "DELETE FROM transaction_history_records WHERE execution_id = ?")
                defer { sqlite3_finalize(statement) }
                try Self.bind(statement, 1, executionID)
                guard sqlite3_step(statement) == SQLITE_DONE, sqlite3_changes(database) == 1 else {
                    throw CitizenSDKError(.storage, "history delete failed")
                }
            }
            for record in mutation.upserts {
                if let current = try historyResource(database, executionID: record.executionID) {
                    computed = try computed.removing(current)
                }
                computed = try computed.adding(record)
                let statement = try Self.prepare(database,
                    "INSERT OR REPLACE INTO transaction_history_records(" +
                    "execution_id, created_at_millis, updated_at_millis, durable_weight, " +
                    "retention_terminal, chain_terminal, record) VALUES(?, ?, ?, ?, ?, ?, ?)")
                defer { sqlite3_finalize(statement) }
                try Self.bind(statement, 1, record.executionID)
                try Self.bind(statement, 2, try signed(record.created))
                try Self.bind(statement, 3, try signed(record.updated))
                try Self.bind(statement, 4, try signed(record.weight))
                try Self.bind(statement, 5, record.retentionTerminal ? 1 : 0)
                try Self.bind(statement, 6, record.chainTerminal ? 1 : 0)
                try Self.bind(statement, 7, record.record)
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw CitizenSDKError(.storage, "history upsert failed")
                }
            }
            computed.revision = mutation.next.revision
            guard computed == mutation.next else {
                throw CitizenSDKError(.integrity, "history mutation aggregate is inconsistent")
            }
            let meta = try Self.prepare(database,
                "INSERT OR REPLACE INTO transaction_history_meta(" +
                "singleton, revision, record_count, durable_weight, open_count, open_weight) " +
                "VALUES(1, ?, ?, ?, ?, ?)")
            defer { sqlite3_finalize(meta) }
            try Self.bind(meta, 1, try signed(mutation.next.revision))
            try Self.bind(meta, 2, Int64(mutation.next.recordCount))
            try Self.bind(meta, 3, try signed(mutation.next.durableWeight))
            try Self.bind(meta, 4, Int64(mutation.next.openCount))
            try Self.bind(meta, 5, try signed(mutation.next.openWeight))
            guard sqlite3_step(meta) == SQLITE_DONE else {
                throw CitizenSDKError(.storage, "history meta write failed")
            }
            return .present(.transactionHistory, revision: mutation.next.revision,
                            record: try HistoryWriter.batch(mutation.next, [], hasMore: false))
        }
        if result.errorCode == .ok && !mutation.deletes.isEmpty { try reclaimHistoryPages() }
        return result
    }

    private func historyIndex(_ database: OpaquePointer) throws -> HistoryIndex {
        let statement = try Self.prepare(database,
            "SELECT revision, record_count, durable_weight, open_count, open_weight " +
            "FROM transaction_history_meta WHERE singleton = 1")
        defer { sqlite3_finalize(statement) }
        guard try Self.stepRowOrDone(statement) else { return .empty }
        let result = HistoryIndex(
            revision: try unsignedInteger(statement, 0, minimum: 1, maximum: UInt64(Int64.max)),
            recordCount: Int(try unsignedInteger(statement, 1, maximum: 4096)),
            durableWeight: try unsignedInteger(statement, 2, maximum: Self.maximumHistoryWeight),
            openCount: Int(try unsignedInteger(statement, 3, maximum: 4096)),
            openWeight: try unsignedInteger(statement, 4, maximum: Self.maximumHistoryWeight))
        guard result.openCount <= result.recordCount,
              result.openWeight <= result.durableWeight else {
            throw CitizenSDKError(.integrity, "history meta is inconsistent")
        }
        return result
    }

    private func historyExact(_ database: OpaquePointer,
                              executionID: String) throws -> [HistoryDescriptor] {
        let statement = try Self.prepare(database, historySelect + " WHERE execution_id = ? LIMIT 1")
        defer { sqlite3_finalize(statement) }
        try Self.bind(statement, 1, executionID)
        return try Self.stepRowOrDone(statement) ? [try historyDescriptor(statement)] : []
    }

    private func historyPage(_ database: OpaquePointer,
                             query: HistoryQuery) throws -> [HistoryDescriptor] {
        var sql = historySelect + " WHERE "
        if query.kind == 4 { sql += "retention_terminal = 1" }
        else if query.kind == 5 { sql += "chain_terminal = 0" }
        else { sql += "1 = 1" }
        if query.cursorID != nil {
            sql += query.kind == 3
                ? " AND (created_at_millis < ? OR (created_at_millis = ? AND execution_id < ?))"
                : " AND (created_at_millis > ? OR (created_at_millis = ? AND execution_id > ?))"
        }
        sql += query.kind == 3
            ? " ORDER BY created_at_millis DESC, execution_id DESC LIMIT ?"
            : " ORDER BY created_at_millis ASC, execution_id ASC LIMIT ?"
        let statement = try Self.prepare(database, sql)
        defer { sqlite3_finalize(statement) }
        var parameter: Int32 = 1
        if let cursorID = query.cursorID {
            try Self.bind(statement, parameter, try signed(query.cursorCreated)); parameter += 1
            try Self.bind(statement, parameter, try signed(query.cursorCreated)); parameter += 1
            try Self.bind(statement, parameter, cursorID); parameter += 1
        }
        try Self.bind(statement, parameter, Int64(query.limit + 1))
        var records: [HistoryDescriptor] = []
        while try Self.stepRowOrDone(statement) { records.append(try historyDescriptor(statement)) }
        return records
    }

    private func historyDescriptor(_ statement: OpaquePointer) throws -> HistoryDescriptor {
        let executionID = String(cString: sqlite3_column_text(statement, 0))
        guard executionID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else {
            throw CitizenSDKError(.integrity, "history execution ID is malformed")
        }
        let retention = try unsignedInteger(statement, 4, maximum: 1) != 0
        let chain = try unsignedInteger(statement, 5, maximum: 1) != 0
        let record = Self.data(statement, 6)
        guard !record.isEmpty, record.count <= Self.maximumHistoryWire, !chain || retention else {
            throw CitizenSDKError(.integrity, "history row is malformed")
        }
        return HistoryDescriptor(
            executionID: executionID,
            created: try unsignedInteger(statement, 1),
            updated: try unsignedInteger(statement, 2),
            weight: try unsignedInteger(statement, 3, minimum: 1, maximum: Self.maximumHistoryWeight),
            retentionTerminal: retention, chainTerminal: chain, record: record)
    }

    private func historyResource(_ database: OpaquePointer,
                                 executionID: String) throws -> HistoryResource? {
        let statement = try Self.prepare(database,
            "SELECT durable_weight, retention_terminal FROM transaction_history_records " +
            "WHERE execution_id = ? LIMIT 1")
        defer { sqlite3_finalize(statement) }
        try Self.bind(statement, 1, executionID)
        guard try Self.stepRowOrDone(statement) else { return nil }
        return HistoryResource(
            weight: try unsignedInteger(statement, 0, minimum: 1, maximum: Self.maximumHistoryWeight),
            retentionTerminal: try unsignedInteger(statement, 1, maximum: 1) != 0)
    }

    private func reclaimHistoryPages() throws {
        try read { database in
            func scalar(_ sql: String) throws -> Int64 {
                let statement = try Self.prepare(database, sql)
                defer { sqlite3_finalize(statement) }
                guard try Self.stepRowOrDone(statement), sqlite3_column_type(statement, 0) == SQLITE_INTEGER else {
                    throw CitizenSDKError(.storage, "history database metric is unavailable")
                }
                return sqlite3_column_int64(statement, 0)
            }
            let pages = try scalar("PRAGMA page_count")
            let free = try scalar("PRAGMA freelist_count")
            if free > 16 && free * 4 > pages {
                try Self.execute(database, "PRAGMA incremental_vacuum(128)")
                try Self.execute(database, "PRAGMA wal_checkpoint(PASSIVE)")
            }
        }
    }

    private func loadSingleton(_ domain: CitizenSDKHostDomain) throws -> CitizenSDKHostRecord {
        try read { database in
            let statement = try Self.prepare(database,
                "SELECT revision, record FROM singleton_records WHERE domain = ?")
            defer { sqlite3_finalize(statement) }
            try Self.bind(statement, 1, Int64(domain.rawValue))
            if try Self.stepRowOrDone(statement) {
                return .present(domain, revision: try Self.revision(statement, 0),
                                record: Self.data(statement, 1))
            }
            return .absent(domain)
        }
    }

    private func compareAndSwapSingleton(_ domain: CitizenSDKHostDomain, expected: UInt64,
                                         candidate: Data) throws -> CitizenSDKHostRecord {
        guard expected < UInt64(Int64.max) else { return .failure(domain, .conflict) }
        return try transaction { database in
            let query = try Self.prepare(database,
                "SELECT revision FROM singleton_records WHERE domain = ?")
            defer { sqlite3_finalize(query) }
            try Self.bind(query, 1, Int64(domain.rawValue))
            let actual = try Self.stepRowOrDone(query) ? try Self.revision(query, 0) : 0
            guard actual == expected else { return .failure(domain, .conflict) }
            let next = expected + 1
            let write = try Self.prepare(database,
                "INSERT OR REPLACE INTO singleton_records(domain, revision, record) VALUES(?, ?, ?)")
            defer { sqlite3_finalize(write) }
            try Self.bind(write, 1, Int64(domain.rawValue))
            try Self.bind(write, 2, Int64(next))
            try Self.bind(write, 3, candidate)
            guard sqlite3_step(write) == SQLITE_DONE else {
                throw CitizenSDKError(.storage, "singleton CAS failed")
            }
            return .present(domain, revision: next, record: candidate)
        }
    }

    private func unsignedInteger(_ statement: OpaquePointer, _ column: Int32,
                                 minimum: UInt64 = 0,
                                 maximum: UInt64 = UInt64(Int64.max)) throws -> UInt64 {
        guard sqlite3_column_type(statement, column) == SQLITE_INTEGER else {
            throw CitizenSDKError(.integrity, "history integer has an invalid SQLite type")
        }
        let value = sqlite3_column_int64(statement, column)
        guard value >= 0, UInt64(value) >= minimum, UInt64(value) <= maximum else {
            throw CitizenSDKError(.integrity, "history integer is outside its valid range")
        }
        return UInt64(value)
    }

    private func signed(_ value: UInt64) throws -> Int64 {
        guard value <= UInt64(Int64.max) else {
            throw CitizenSDKError(.invalidArgument, "history integer exceeds SQLite capacity")
        }
        return Int64(value)
    }

    private var historySelect: String {
        "SELECT execution_id, created_at_millis, updated_at_millis, durable_weight, " +
        "retention_terminal, chain_terminal, record FROM transaction_history_records"
    }
}

private struct HistoryIndex: Equatable {
    var revision: UInt64
    var recordCount: Int
    var durableWeight: UInt64
    var openCount: Int
    var openWeight: UInt64

    static let empty = HistoryIndex(revision: 0, recordCount: 0, durableWeight: 0,
                                    openCount: 0, openWeight: 0)

    func removing(_ record: HistoryResource) throws -> HistoryIndex {
        guard recordCount > 0, durableWeight >= record.weight,
              record.retentionTerminal || (openCount > 0 && openWeight >= record.weight) else {
            throw CitizenSDKError(.integrity, "history aggregate underflow")
        }
        var next = self
        next.recordCount -= 1
        next.durableWeight -= record.weight
        if !record.retentionTerminal { next.openCount -= 1; next.openWeight -= record.weight }
        return next
    }

    func adding(_ record: HistoryDescriptor) throws -> HistoryIndex {
        guard recordCount < 4096, durableWeight <= 31 * 1024 * 1024 - record.weight else {
            throw CitizenSDKError(.invalidArgument, "history capacity is exceeded")
        }
        var next = self
        next.recordCount += 1
        next.durableWeight += record.weight
        if !record.retentionTerminal { next.openCount += 1; next.openWeight += record.weight }
        return next
    }
}

private struct HistoryResource { let weight: UInt64; let retentionTerminal: Bool }
private struct HistoryDescriptor {
    let executionID: String
    let created: UInt64
    let updated: UInt64
    let weight: UInt64
    let retentionTerminal: Bool
    let chainTerminal: Bool
    let record: Data
}
private struct HistoryQuery {
    let kind: UInt8
    let expectedRevision: UInt64
    let limit: Int
    let exactID: String
    let cursorCreated: UInt64
    let cursorID: String?
}
private struct HistoryMutation {
    let next: HistoryIndex
    let deletes: [String]
    let upserts: [HistoryDescriptor]
}

private struct HistoryReader {
    private let bytes: [UInt8]
    private var offset = 0

    init(_ data: Data) throws {
        guard data.count <= 32 * 1024 * 1024 else {
            throw CitizenSDKError(.invalidArgument, "history wire is too large")
        }
        bytes = Array(data)
    }

    mutating func query() throws -> HistoryQuery {
        try magic("THQ1")
        let kind = try byte()
        let expected = try uint64()
        let limit = Int(try uint32())
        let exact = try executionID()
        let hasCursor = try boolean()
        let cursorCreated = try uint64()
        let cursor = try executionID()
        try finish()
        let exactZero = exact.allSatisfy { $0 == "0" }
        let cursorZero = cursor.allSatisfy { $0 == "0" }
        let validShape: Bool
        switch kind {
        case 1: validShape = expected == UInt64.max && limit == 0 && exactZero && !hasCursor
        case 2: validShape = limit == 1 && !exactZero && !hasCursor
        case 3...5: validShape = (1...100).contains(limit) && exactZero &&
            (!hasCursor || (!cursorZero && cursorCreated <= UInt64(Int64.max)))
        default: validShape = false
        }
        guard validShape, hasCursor || (cursorCreated == 0 && cursorZero) else {
            throw CitizenSDKError(.invalidArgument, "history query shape is invalid")
        }
        return HistoryQuery(kind: kind, expectedRevision: expected, limit: limit,
                            exactID: exact, cursorCreated: cursorCreated,
                            cursorID: hasCursor ? cursor : nil)
    }

    mutating func mutation(expected: UInt64) throws -> HistoryMutation {
        try magic("THM1")
        let next = try index()
        let deleteCount = Int(try uint32())
        guard deleteCount <= 4096 else { throw CitizenSDKError(.invalidArgument, "delete batch is too large") }
        var identities = Set<String>()
        var deletes: [String] = []
        for _ in 0..<deleteCount {
            let id = try executionID()
            guard !id.allSatisfy({ $0 == "0" }), identities.insert(id).inserted else {
                throw CitizenSDKError(.invalidArgument, "duplicate history ID")
            }
            deletes.append(id)
        }
        let upsertCount = Int(try uint32())
        guard upsertCount <= 100 else { throw CitizenSDKError(.invalidArgument, "upsert batch is too large") }
        var upserts: [HistoryDescriptor] = []
        for _ in 0..<upsertCount {
            let value = try descriptor()
            guard identities.insert(value.executionID).inserted else {
                throw CitizenSDKError(.invalidArgument, "conflicting history ID")
            }
            upserts.append(value)
        }
        try finish()
        guard expected < UInt64(Int64.max), next.revision == expected + 1 else {
            throw CitizenSDKError(.invalidArgument, "history mutation revision is invalid")
        }
        return HistoryMutation(next: next, deletes: deletes, upserts: upserts)
    }

    private mutating func index() throws -> HistoryIndex {
        let value = HistoryIndex(revision: try uint64(), recordCount: Int(try uint32()),
                                 durableWeight: try uint64(), openCount: Int(try uint32()),
                                 openWeight: try uint64())
        guard value.revision <= UInt64(Int64.max), value.recordCount <= 4096,
              value.durableWeight <= 31 * 1024 * 1024, value.openCount <= value.recordCount,
              value.openWeight <= value.durableWeight else {
            throw CitizenSDKError(.invalidArgument, "history index is invalid")
        }
        return value
    }

    private mutating func descriptor() throws -> HistoryDescriptor {
        let id = try executionID()
        let created = try uint64(), updated = try uint64(), weight = try uint64()
        let retention = try boolean(), chain = try boolean(), record = try data()
        guard !id.allSatisfy({ $0 == "0" }), created <= UInt64(Int64.max),
              updated >= created, updated <= UInt64(Int64.max), weight > 0,
              weight <= 31 * 1024 * 1024, !chain || retention, !record.isEmpty else {
            throw CitizenSDKError(.invalidArgument, "history descriptor is invalid")
        }
        return HistoryDescriptor(executionID: id, created: created, updated: updated,
                                 weight: weight, retentionTerminal: retention,
                                 chainTerminal: chain, record: record)
    }

    private mutating func magic(_ value: String) throws {
        guard offset + 4 <= bytes.count,
              String(bytes: bytes[offset..<offset + 4], encoding: .utf8) == value else {
            throw CitizenSDKError(.decode, "history wire magic is invalid")
        }
        offset += 4
    }
    private mutating func byte() throws -> UInt8 {
        guard offset < bytes.count else { throw CitizenSDKError(.decode, "history wire is truncated") }
        defer { offset += 1 }; return bytes[offset]
    }
    private mutating func boolean() throws -> Bool {
        let value = try byte(); guard value <= 1 else { throw CitizenSDKError(.decode, "bad history boolean") }
        return value == 1
    }
    private mutating func uint32() throws -> UInt32 {
        var value: UInt32 = 0
        for shift in stride(from: 0, to: 32, by: 8) { value |= UInt32(try byte()) << UInt32(shift) }
        return value
    }
    private mutating func uint64() throws -> UInt64 {
        var value: UInt64 = 0
        for shift in stride(from: 0, to: 64, by: 8) { value |= UInt64(try byte()) << UInt64(shift) }
        return value
    }
    private mutating func executionID() throws -> String {
        guard offset + 16 <= bytes.count else { throw CitizenSDKError(.decode, "history ID is truncated") }
        defer { offset += 16 }
        return bytes[offset..<offset + 16].map { String(format: "%02x", $0) }.joined()
    }
    private mutating func data() throws -> Data {
        let count = Int(try uint32())
        guard count <= 32 * 1024 * 1024, offset + count <= bytes.count else {
            throw CitizenSDKError(.decode, "history byte field is invalid")
        }
        defer { offset += count }; return Data(bytes[offset..<offset + count])
    }
    private func finish() throws {
        guard offset == bytes.count else { throw CitizenSDKError(.decode, "history wire has trailing bytes") }
    }
}

private enum HistoryWriter {
    static func batch(_ index: HistoryIndex, _ records: [HistoryDescriptor],
                      hasMore: Bool) throws -> Data {
        var bytes: [UInt8] = Array("THB1".utf8)
        func append(_ value: UInt8) { bytes.append(value) }
        func append(_ value: UInt32) {
            for shift in stride(from: 0, to: 32, by: 8) { append(UInt8(truncatingIfNeeded: value >> UInt32(shift))) }
        }
        func append(_ value: UInt64) {
            for shift in stride(from: 0, to: 64, by: 8) { append(UInt8(truncatingIfNeeded: value >> UInt64(shift))) }
        }
        append(index.revision); append(UInt32(index.recordCount)); append(index.durableWeight)
        append(UInt32(index.openCount)); append(index.openWeight); append(UInt8(hasMore ? 1 : 0))
        append(UInt32(records.count))
        for record in records {
            for position in stride(from: 0, to: 32, by: 2) {
                bytes.append(UInt8(record.executionID[position..<position + 2], radix: 16)!)
            }
            append(record.created); append(record.updated); append(record.weight)
            append(UInt8(record.retentionTerminal ? 1 : 0))
            append(UInt8(record.chainTerminal ? 1 : 0))
            append(UInt32(record.record.count)); bytes.append(contentsOf: record.record)
        }
        guard bytes.count <= 32 * 1024 * 1024 else {
            throw CitizenSDKError(.invalidArgument, "history response is too large")
        }
        return Data(bytes)
    }
}

private extension String {
    subscript(_ range: Range<Int>) -> Substring {
        self[index(startIndex, offsetBy: range.lowerBound)..<index(startIndex, offsetBy: range.upperBound)]
    }
}
