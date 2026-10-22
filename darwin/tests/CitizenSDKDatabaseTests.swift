import Foundation
import SQLite3
import XCTest
@testable import CitizenSDK

private final class DatabaseTest {
    var config: citizensdk_store_v1_t
    var value: Int64 = -1
    init(_ config: citizensdk_store_v1_t) { self.config=config }
    func execute(_ sql: String) -> Int32 {
        let bytes=Array(sql.utf8); var changed: UInt64=0
        return bytes.withUnsafeBufferPointer { config.execute!(config.context,citizensdk_bytes_view_t(data:$0.baseAddress,len:UInt64($0.count)),nil,0,&changed) }
    }
}
private func databaseTestRow(_ context: UnsafeMutableRawPointer?, _ values: UnsafePointer<citizensdk_sql_value_t>?, _ count: UInt64) -> Int32 {
    guard let context, let values, count == 1, values.pointee.kind == 1 else { return 9 }
    Unmanaged<DatabaseTest>.fromOpaque(context).takeUnretainedValue().value=values.pointee.integer; return 0
}
private func databaseTestJob(_ context: UnsafeMutableRawPointer?) -> Int32 {
    guard let context else { return 1 }
    let test=Unmanaged<DatabaseTest>.fromOpaque(context).takeUnretainedValue(), config=test.config
    guard test.execute("CREATE TABLE resource(value INTEGER)") == 0,
          config.begin!(config.context) == 0, test.execute("INSERT INTO resource VALUES(17)") == 0,
          config.end!(config.context,0) == 0 else { return 14 }
    let bytes=Array("SELECT count(*) FROM resource".utf8)
    return bytes.withUnsafeBufferPointer { config.query!(config.context,citizensdk_bytes_view_t(data:$0.baseAddress,len:UInt64($0.count)),nil,0,1,1024,databaseTestRow,context) }
}
private func unfinishedDatabaseJob(_ context: UnsafeMutableRawPointer?) -> Int32 {
    guard let context else { return 1 }
    let config=Unmanaged<DatabaseTest>.fromOpaque(context).takeUnretainedValue().config
    guard config.begin!(config.context) == 0 else { return 14 }; return 14
}
private func forbiddenDatabaseJob(_ context: UnsafeMutableRawPointer?) -> Int32 { XCTFail("退休连接不得接纳另一个job"); return 0 }
final class CitizenSDKDatabaseTests: XCTestCase {
    func testResourceRunsOnOneConnectionAndRollsBack() {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let database=CitizenSDKDatabase(directory:directory)
        XCTAssertFalse(FileManager.default.fileExists(atPath:directory.path))
        let test=DatabaseTest(database.config())
        XCTAssertEqual(test.config.run!(test.config.context,databaseTestJob,Unmanaged.passUnretained(test).toOpaque()),0)
        XCTAssertEqual(test.value,0)
        XCTAssertEqual(test.config.run!(test.config.context,unfinishedDatabaseJob,Unmanaged.passUnretained(test).toOpaque()),14)
        XCTAssertEqual(test.config.run!(test.config.context,forbiddenDatabaseJob,nil),14)
    }
    func testSQLiteFailureCodesNeverMeanAbsent() throws {
        for code in [SQLITE_BUSY,SQLITE_ERROR,SQLITE_CORRUPT] { XCTAssertThrowsError(try CitizenSDKSQLite.classifyStepCode(code)) }
        XCTAssertTrue(try CitizenSDKSQLite.classifyStepCode(SQLITE_ROW))
        XCTAssertFalse(try CitizenSDKSQLite.classifyStepCode(SQLITE_DONE))
    }
    func testVaultMutationLockSerializesIndependentStores() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = CitizenSDKDatabase(directory: directory, secure: true)
        let second = CitizenSDKDatabase(directory: directory, secure: true)
        defer { first.close(); second.close() }
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            try? first.withVaultLock {
                entered.signal()
                _ = release.wait(timeout: .now() + 2)
            }
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        DispatchQueue.global().async {
            _ = try? second.withVaultLock { finished.signal() }
        }
        XCTAssertEqual(finished.wait(timeout: .now() + 0.1), .timedOut)
        release.signal()
        XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
    }

}
