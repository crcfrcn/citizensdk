import Foundation
import SQLite3

/// Small SQLite owner with FULL durability and cross-process atomic CAS.
internal class CitizenSDKSQLite {
    private let lock = NSRecursiveLock()
    private var database: OpaquePointer?

    init(directory: URL, fileName: String, schema: [String], secure: Bool,
         schemaVersion: Int64 = 1, incrementalVacuum: Bool = false) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableDirectory = directory
        try? mutableDirectory.setResourceValues(values)

        #if os(iOS)
        try FileManager.default.setAttributes(
            [.protectionKey: secure ? FileProtectionType.complete : FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
        #endif

        let file = directory.appendingPathComponent(fileName, isDirectory: false)
        var opened: OpaquePointer?
        guard sqlite3_open_v2(file.path, &opened,
                              SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX,
                              nil) == SQLITE_OK, let opened else {
            if let opened { sqlite3_close_v2(opened) }
            throw CitizenSDKError(.storage, "CitizenSDK could not open its state store")
        }
        database = opened
        do {
            func scalar(_ sql: String) throws -> Int64 {
                let statement = try Self.prepare(opened, sql)
                defer { sqlite3_finalize(statement) }
                guard try Self.stepRowOrDone(statement),
                      sqlite3_column_type(statement, 0) == SQLITE_INTEGER else {
                    throw CitizenSDKError(.storage, "CitizenSDK SQLite scalar is unavailable")
                }
                return sqlite3_column_int64(statement, 0)
            }
            let version = try scalar("PRAGMA user_version")
            let objects = try scalar("SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
            let initialize = version == 0 && objects == 0
            guard initialize || version == schemaVersion else {
                throw CitizenSDKError(.integrity,
                                      "CitizenSDK database schema is unsupported; clear the old development database")
            }
            if initialize {
                if incrementalVacuum { try Self.execute(opened, "PRAGMA auto_vacuum=INCREMENTAL") }
                try Self.execute(opened, "BEGIN IMMEDIATE")
                do {
                    for statement in schema { try Self.execute(opened, statement) }
                    try Self.execute(opened, "PRAGMA user_version=\(schemaVersion)")
                    try Self.execute(opened, "COMMIT")
                } catch {
                    try? Self.execute(opened, "ROLLBACK")
                    throw error
                }
            }
            let actualObjectCount = try scalar(
                "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
            guard actualObjectCount == schema.count else {
                throw CitizenSDKError(.integrity,
                                      "CitizenSDK SQLite schema contains unexpected objects")
            }
            func canonical(_ value: String) -> String {
                value.lowercased()
                    .replacingOccurrences(of: "\\s+", with: "",
                                          options: .regularExpression)
                    .replacingOccurrences(of: "ifnotexists", with: "")
            }
            for expectedSQL in schema {
                let tablePrefix = "CREATE TABLE IF NOT EXISTS "
                let indexPrefix = "CREATE INDEX IF NOT EXISTS "
                let isTable = expectedSQL.hasPrefix(tablePrefix)
                let prefix = isTable ? tablePrefix : indexPrefix
                guard isTable || expectedSQL.hasPrefix(indexPrefix) else {
                    throw CitizenSDKError(.internalFailure,
                                          "CitizenSDK embedded SQLite schema is malformed")
                }
                let tail = expectedSQL.dropFirst(prefix.count)
                let delimiter: Character = isTable ? "(" : " "
                guard let end = tail.firstIndex(of: delimiter) else {
                    throw CitizenSDKError(.internalFailure,
                                          "CitizenSDK embedded SQLite object name is malformed")
                }
                let name = String(tail[..<end]).trimmingCharacters(in: .whitespaces)
                let query = try Self.prepare(opened,
                    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
                defer { sqlite3_finalize(query) }
                try Self.bind(query, 1, isTable ? "table" : "index")
                try Self.bind(query, 2, name)
                guard try Self.stepRowOrDone(query),
                      let rawSQL = sqlite3_column_text(query, 0),
                      canonical(String(cString: rawSQL)) == canonical(expectedSQL) else {
                    throw CitizenSDKError(.integrity,
                                          "CitizenSDK SQLite schema differs from its fixed contract")
                }
            }
            guard try scalar("PRAGMA auto_vacuum") == (incrementalVacuum ? 2 : 0) else {
                throw CitizenSDKError(.integrity, "CitizenSDK SQLite auto-vacuum policy differs")
            }
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=FULL")
            try execute("PRAGMA foreign_keys=ON")
            try execute("PRAGMA busy_timeout=5000")
            #if os(iOS)
            try? FileManager.default.setAttributes(
                [.protectionKey: secure ? FileProtectionType.complete : FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: file.path
            )
            #endif
        } catch {
            sqlite3_close_v2(opened)
            database = nil
            throw error
        }
    }

    deinit { close() }

    func close() {
        lock.lock(); defer { lock.unlock() }
        if let database { sqlite3_close_v2(database); self.database = nil }
    }

    func read<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard let database else { throw CitizenSDKError(.storage, "CitizenSDK state store is closed") }
        return try body(database)
    }

    func transaction<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        try read { database in
            try Self.execute(database, "BEGIN IMMEDIATE")
            do {
                let value = try body(database)
                try Self.execute(database, "COMMIT")
                return value
            } catch {
                try? Self.execute(database, "ROLLBACK")
                throw error
            }
        }
    }

    private func execute(_ sql: String) throws {
        try read { try Self.execute($0, sql) }
    }

    static func execute(_ database: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw storageError(database)
        }
    }

    static func prepare(_ database: OpaquePointer, _ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw storageError(database)
        }
        return statement
    }

    static func bind(_ statement: OpaquePointer, _ index: Int32, _ value: Int64) throws {
        guard sqlite3_bind_int64(statement, index, value) == SQLITE_OK else { throw bindError(statement) }
    }

    static func bind(_ statement: OpaquePointer, _ index: Int32, _ value: String) throws {
        let code = value.withCString { sqlite3_bind_text(statement, index, $0, -1, sqliteTransient) }
        guard code == SQLITE_OK else { throw bindError(statement) }
    }

    static func bind(_ statement: OpaquePointer, _ index: Int32, _ value: Data) throws {
        let code = value.withUnsafeBytes { bytes in
            sqlite3_bind_blob(statement, index, bytes.baseAddress, Int32(bytes.count), sqliteTransient)
        }
        guard code == SQLITE_OK else { throw bindError(statement) }
    }

    static func data(_ statement: OpaquePointer, _ column: Int32) -> Data {
        let count = Int(sqlite3_column_bytes(statement, column))
        guard count > 0, let bytes = sqlite3_column_blob(statement, column) else { return Data() }
        return Data(bytes: bytes, count: count)
    }

    /// 持久 CAS revision 必须保持正整数；先检查 SQLite 原始类型，避免自动转换
    /// 把畸形 TEXT/REAL 接受为数字，也避免负数到 UInt64 的运行时 trap。
    static func revision(_ statement: OpaquePointer, _ column: Int32) throws -> UInt64 {
        guard sqlite3_column_type(statement, column) == SQLITE_INTEGER else {
            throw CitizenSDKError(.storage, "CitizenSDK revision is not an integer")
        }
        let value = sqlite3_column_int64(statement, column)
        guard value > 0 else {
            throw CitizenSDKError(.storage, "CitizenSDK revision is outside its valid range")
        }
        return UInt64(value)
    }

    /// Distinguishes a legitimate end-of-result from BUSY/IO/CORRUPT. Treating
    /// every non-ROW as absence would let a failed read become a destructive
    /// first-write CAS.
    static func stepRowOrDone(_ statement: OpaquePointer) throws -> Bool {
        try classifyStepCode(sqlite3_step(statement), statement: statement)
    }

    /// Kept as one shared classifier so every store and its negative tests use
    /// exactly the same ROW/DONE/error contract. A statement is supplied in
    /// production to preserve SQLite's diagnostic; tests may omit it when
    /// proving that BUSY, ERROR and CORRUPT can never become “absent”.
    static func classifyStepCode(_ code: Int32, statement: OpaquePointer? = nil) throws -> Bool {
        switch code {
        case SQLITE_ROW: return true
        case SQLITE_DONE: return false
        default:
            if let statement { throw bindError(statement) }
            throw CitizenSDKError(.storage, "CitizenSDK SQLite step failed")
        }
    }

    private static func storageError(_ database: OpaquePointer) -> CitizenSDKError {
        CitizenSDKError(.storage, String(cString: sqlite3_errmsg(database)))
    }

    private static func bindError(_ statement: OpaquePointer) -> CitizenSDKError {
        guard let database = sqlite3_db_handle(statement) else {
            return CitizenSDKError(.storage, "CitizenSDK SQLite bind failed")
        }
        return storageError(database)
    }
}

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
