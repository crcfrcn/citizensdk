import Foundation
import SQLite3
import XCTest
@testable import CitizenSDK

final class CitizenSDKPublicStoreTests: XCTestCase {
    func testMalformedPersistentRevisionFailsWithoutTrappingOrWriting() throws {
        // 数字文本会被SQLite的INTEGER亲和性转换，因此文本边界使用非数字合成值。
        for (literal, storageClass) in [("-1", "integer"), ("0", "integer"),
                                        ("1.5", "real"), ("'broken'", "text")] {
            let directory = temporaryDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = try CitizenSDKPublicStore(directory: directory)
            store.close()
            let file = directory.appendingPathComponent("public-state-v1.sqlite3")
            try corruptRevision(file,
                                "INSERT INTO singleton_records(domain, revision, record) VALUES(1, \(literal), X'01')")
            let expected = ["1", storageClass, literal, "01"]
            XCTAssertEqual(try revisionRow(file), expected)
            let reopened = try CitizenSDKPublicStore(directory: directory)
            defer { reopened.close() }
            XCTAssertThrowsError(try reopened.chainDatabaseLoad(), literal) { error in
                XCTAssertEqual((error as? CitizenSDKError)?.code, .storage)
            }
            XCTAssertEqual(try revisionRow(file), expected)
            XCTAssertThrowsError(try reopened.chainDatabaseCAS(expected: 0, candidate: Data([2])), literal) { error in
                XCTAssertEqual((error as? CitizenSDKError)?.code, .storage)
            }
            // 拒绝畸形revision后不能把损坏记录当空库覆盖，也不能偷偷改写原字节。
            XCTAssertEqual(try revisionRow(file), expected)
        }
    }
    func testHostNamespacesDoNotShareChainOrHistoryState() throws {
        let support = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: support) }
        let firstRoot = try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: "org.example.first")
        let secondRoot = try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: "org.example.second")
        let first = try CitizenSDKPublicStore(directory: firstRoot.appendingPathComponent("public"))
        let second = try CitizenSDKPublicStore(directory: secondRoot.appendingPathComponent("public"))
        defer { first.close(); second.close() }
        _ = try first.chainDatabaseCAS(expected: 0, candidate: Data([1]))
        _ = try first.transactionHistoryMutate(expected: 0,
                                               bytes: historyMutation(identity: 2, record: Data([2])))
        XCTAssertFalse(try second.chainDatabaseLoad().present)
        XCTAssertEqual(try second.transactionHistoryQuery(historyIndexQuery()).revision, 0)
        XCTAssertEqual(try first.transactionHistoryQuery(historyIndexQuery()).revision, 1)
        _ = try second.chainDatabaseCAS(expected: 0, candidate: Data([3]))
        XCTAssertEqual(try first.chainDatabaseLoad().record, Data([1]))
        XCTAssertEqual(try second.chainDatabaseLoad().record, Data([3]))
    }

    func testSingletonCASAndRuntimeCacheRoundTrip() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKPublicStore(directory: directory)
        defer { store.close() }

        XCTAssertFalse(try store.chainDatabaseLoad().present)
        let first = try store.chainDatabaseCAS(expected: 0, candidate: Data([1, 2]))
        XCTAssertEqual(first.revision, 1)
        XCTAssertEqual(first.record, Data([1, 2]))
        XCTAssertEqual(try store.chainDatabaseCAS(expected: 0, candidate: Data([3])).errorCode, .conflict)

        let hash = Data(repeating: 4, count: 32)
        try store.runtimeCacheStore(hash: hash, candidate: Data([5]))
        XCTAssertEqual(try store.runtimeCacheLoad(hash: hash).record, Data([5]))
        try store.runtimeCacheDelete(hash: hash)
        XCTAssertFalse(try store.runtimeCacheLoad(hash: hash).present)
    }

    func testRuntimeCacheAtomicallyRetainsLatestSixtyFourWrites() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKPublicStore(directory: directory)
        defer { store.close() }

        for index in 0..<80 {
            try store.runtimeCacheStore(hash: blockHash(index), candidate: Data([UInt8(index)]))
        }
        for index in 0..<80 {
            XCTAssertEqual(try store.runtimeCacheLoad(hash: blockHash(index)).present, index >= 16)
        }

        // REPLACE promotes the existing key to newest without creating a 65th row.
        try store.runtimeCacheStore(hash: blockHash(16), candidate: Data([99]))
        try store.runtimeCacheStore(hash: blockHash(80), candidate: Data([80]))
        XCTAssertTrue(try store.runtimeCacheLoad(hash: blockHash(16)).present)
        XCTAssertFalse(try store.runtimeCacheLoad(hash: blockHash(17)).present)
        XCTAssertTrue(try store.runtimeCacheLoad(hash: blockHash(80)).present)

        let database = directory.appendingPathComponent("public-state-v1.sqlite3")
        try executeSQL(
            database,
            "CREATE TRIGGER runtime_cache_prune_failure BEFORE DELETE ON runtime_cache " +
                "BEGIN SELECT RAISE(ABORT, 'test prune failure'); END"
        )
        XCTAssertThrowsError(
            try store.runtimeCacheStore(hash: blockHash(81), candidate: Data([81]))
        )
        XCTAssertFalse(try store.runtimeCacheLoad(hash: blockHash(81)).present)
        XCTAssertTrue(try store.runtimeCacheLoad(hash: blockHash(18)).present)
        try executeSQL(database, "DROP TRIGGER runtime_cache_prune_failure")
    }

    func testSQLiteFailureCodesNeverMeanAbsent() throws {
        for code in [SQLITE_BUSY, SQLITE_ERROR, SQLITE_CORRUPT] {
            XCTAssertThrowsError(try CitizenSDKSQLite.classifyStepCode(code)) { error in
                XCTAssertEqual((error as? CitizenSDKError)?.code, .storage)
            }
        }
        XCTAssertTrue(try CitizenSDKSQLite.classifyStepCode(SQLITE_ROW))
        XCTAssertFalse(try CitizenSDKSQLite.classifyStepCode(SQLITE_DONE))
    }

    func testFixtureSQLFailureThrowsAndDoesNotCreateOrChangeRecords() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKPublicStore(directory: directory)
        defer { store.close() }
        let file = directory.appendingPathComponent("public-state-v1.sqlite3")
        // 语句错误与缺失数据库都必须抛错，READWRITE不得悄悄创建另一份夹具。
        XCTAssertThrowsError(try executeSQL(file, "INSERT INTO absent_fixture_table VALUES(1)"))
        XCTAssertFalse(try store.chainDatabaseLoad().present)
        let missing = directory.appendingPathComponent("missing.sqlite3")
        XCTAssertThrowsError(try executeSQL(missing, "SELECT 1"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    private func blockHash(_ index: Int) -> Data {
        var bytes = Data(repeating: 0, count: 32)
        bytes[31] = UInt8(index)
        return bytes
    }

    private func historyIndexQuery() -> Data {
        var bytes = Data("THQ1".utf8); bytes.append(1)
        append(UInt64.max, to: &bytes); append(UInt32(0), to: &bytes)
        bytes.append(Data(repeating: 0, count: 16)); bytes.append(0)
        append(UInt64(0), to: &bytes); bytes.append(Data(repeating: 0, count: 16))
        return bytes
    }

    private func historyMutation(identity: UInt8, record: Data) -> Data {
        let weight = UInt64(max(1, record.count))
        var bytes = Data("THM1".utf8)
        append(UInt64(1), to: &bytes); append(UInt32(1), to: &bytes); append(weight, to: &bytes)
        append(UInt32(1), to: &bytes); append(weight, to: &bytes)
        append(UInt32(0), to: &bytes); append(UInt32(1), to: &bytes)
        bytes.append(identity); bytes.append(Data(repeating: 0, count: 15))
        append(UInt64(1), to: &bytes); append(UInt64(1), to: &bytes); append(weight, to: &bytes)
        bytes.append(0); bytes.append(0); append(UInt32(record.count), to: &bytes); bytes.append(record)
        return bytes
    }

    private func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var little = value.littleEndian
        withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }

    // 只在当前合成夹具连接内跳过CHECK以模拟磁盘中已有的畸形记录；
    // 先证明正常连接确实拒绝，再注入，退出前恢复，不修改生产schema或全局设置。
    private func corruptRevision(_ file: URL, _ sql: String) throws {
        try withFixtureDatabase(file) { database in
            try requireSQLite(sqlite3_exec(database, sql, nil, nil, nil), SQLITE_CONSTRAINT)
            try executeSQL(database, "PRAGMA ignore_check_constraints = ON")
            defer {
                XCTAssertEqual(sqlite3_exec(database, "PRAGMA ignore_check_constraints = OFF",
                                           nil, nil, nil), SQLITE_OK)
            }
            try executeSQL(database, sql)
        }
    }

    private enum FixtureError: Error {
        case sqlite(actual: Int32, expected: Int32)
    }

    private func requireSQLite(_ actual: Int32, _ expected: Int32 = SQLITE_OK) throws {
        guard actual == expected else { throw FixtureError.sqlite(actual: actual, expected: expected) }
    }

    // 夹具打开/执行失败必须终止当前测试，不能在空数据库上继续做生产拒绝断言。
    private func withFixtureDatabase<T>(_ file: URL, _ body: (OpaquePointer) throws -> T) throws -> T {
        var database: OpaquePointer?
        let result = sqlite3_open_v2(file.path, &database, SQLITE_OPEN_READWRITE, nil)
        defer { if let database { XCTAssertEqual(sqlite3_close_v2(database), SQLITE_OK) } }
        try requireSQLite(result)
        return try body(XCTUnwrap(database))
    }

    private func executeSQL(_ database: OpaquePointer, _ sql: String) throws {
        try requireSQLite(sqlite3_exec(database, sql, nil, nil, nil))
    }

    private func executeSQL(_ file: URL, _ sql: String) throws {
        try withFixtureDatabase(file) { try executeSQL($0, sql) }
    }

    private func revisionRow(_ file: URL) throws -> [String] {
        try withFixtureDatabase(file) { database in
            var statement: OpaquePointer?
            try requireSQLite(sqlite3_prepare_v2(database,
                "SELECT domain, typeof(revision), quote(revision), hex(record) FROM singleton_records ORDER BY domain",
                -1, &statement, nil))
            let query = try XCTUnwrap(statement)
            defer { sqlite3_finalize(query) }
            try requireSQLite(sqlite3_step(query), SQLITE_ROW)
            let row = try (0..<4).map { column in
                String(cString: try XCTUnwrap(sqlite3_column_text(query, Int32(column))))
            }
            try requireSQLite(sqlite3_step(query), SQLITE_DONE)
            return row
        }
    }
}
