import Foundation
import SQLite3

/// SQLite连接和Apple文件保护；耐久策略与CAS由Rust Store执行。
internal class CitizenSDKSQLite {
    private let lock = NSRecursiveLock()
    private var database: OpaquePointer?

    init(directory:URL,fileName:String,secure:Bool) throws {
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
        #if os(iOS)
        do {
            try FileManager.default.setAttributes([.protectionKey: secure ? FileProtectionType.complete : FileProtectionType.completeUntilFirstUserAuthentication],ofItemAtPath:file.path)
        } catch {sqlite3_close_v2(opened);database=nil;throw error}
        #endif
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

