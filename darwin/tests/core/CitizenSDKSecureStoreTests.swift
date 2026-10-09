import Foundation
import SQLite3
import XCTest
@testable import CitizenSDK

final class CitizenSDKSecureStoreTests: XCTestCase {
    func testAccountSecretPresenceUsesCoreRecordsAcrossGenerations() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }
        func bytes(_ hex: String) -> Data {
            let chars = Array(hex)
            return Data(stride(from: 0, to: chars.count, by: 2).map {
                UInt8(String(chars[$0...($0 + 1)]), radix: 16)!
            })
        }
        let sealed = bytes("43534852010038000500000000000000b8000000000000009481a10e6546da63b1c160907fb48acbfa35c6ffdee717bfd4a0094b3d9e57b901000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d")
        let tombstone = bytes("43534852010038000500000000000000600000000000000017b5fd919396d702e90558844acef60fb5a38a41f42bdfa34a449075559ce09101000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010200000000000000030e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e")
        let second = bytes("43534852010038000500000000000000b800000000000000bbf644dec5dde868148f6f1ffe1151f121f1de7e78e2b7ecd7c9e35e0cdd48a501000700000058585858585858585858585858585858090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d")
        let account = Data(repeating: 10, count: 32), owner = Data(repeating: 9, count: 16)
        let generation = Data(repeating: 8, count: 16)
        XCTAssertFalse(try store.hasAccountSecret(accountID: account))
        _ = try store.encryptedSecretCAS(walletIndex: 7, kind: 1, generation: generation, owner: owner,
                                         accountID: account, expected: 0, candidate: sealed)
        XCTAssertTrue(try store.hasAccountSecret(accountID: account))
        XCTAssertFalse(try store.hasAccountSecret(accountID: Data(repeating: 11, count: 32)))
        _ = try store.encryptedSecretCAS(walletIndex: 7, kind: 1, generation: generation, owner: owner,
                                         accountID: account, expected: 1, candidate: tombstone)
        XCTAssertFalse(try store.hasAccountSecret(accountID: account))
        _ = try store.encryptedSecretCAS(walletIndex: 7, kind: 1, generation: Data(repeating: 88, count: 16), owner: owner,
                                         accountID: account, expected: 0, candidate: second)
        XCTAssertTrue(try store.hasAccountSecret(accountID: account))
        XCTAssertThrowsError(try store.hasAccountSecret(accountID: Data(repeating: 1, count: 31)))
        _ = try store.encryptedSecretCAS(walletIndex: 7, kind: 1, generation: generation, owner: owner,
                                         accountID: account, expected: 2, candidate: Data([1]))
        XCTAssertThrowsError(try store.hasAccountSecret(accountID: Data(repeating: 12, count: 32)))
    }

    func testGenerationQueryIncludesRetiredFactsAndChecksIdentity() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }
        XCTAssertTrue(try store.vaultGenerations().isEmpty)
        let generation = Data(repeating: 4, count: 16)
        XCTAssertTrue(try store.ensureGeneration(walletIndex: 0, generation: generation, operationID: Data(repeating: 5, count: 16)))
        try store.retireGeneration(walletIndex: 0, generation: generation, operationID: Data(repeating: 6, count: 16))
        let values = try store.vaultGenerations()
        XCTAssertEqual(values.count, 1); XCTAssertEqual(values[0].0, 0); XCTAssertEqual(values[0].1, generation)
    }

    func testVaultMutationLockSerializesIndependentStores() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = try CitizenSDKSecureStore(directory: directory)
        let second = try CitizenSDKSecureStore(directory: directory)
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

    func testMalformedSecretRevisionFailsWithoutTrappingOrOverwriting() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let generation = Data(repeating: 3, count: 16)
        let owner = Data(repeating: 4, count: 16)
        let account = Data(repeating: 5, count: 32)
        let key = try CitizenSDKRecordKey.secret(walletIndex: 0, kind: 1,
                                                  generation: generation, owner: owner,
                                                  accountID: account)
        let store = try CitizenSDKSecureStore(directory: directory)
        store.close()
        let escaped = key.replacingOccurrences(of: "'", with: "''")
        try corruptRevision(directory.appendingPathComponent("secure-state-v1.sqlite3"),
                            "INSERT INTO encrypted_secret(record_key, revision, record) VALUES('\(escaped)', -1, X'01')")
        let reopened = try CitizenSDKSecureStore(directory: directory)
        XCTAssertThrowsError(try reopened.encryptedSecretLoad(walletIndex: 0, kind: 1,
            generation: generation, owner: owner, accountID: account))
        XCTAssertThrowsError(try reopened.encryptedSecretCAS(walletIndex: 0, kind: 1,
            generation: generation, owner: owner, accountID: account, expected: 0,
            candidate: Data([2])))
        reopened.close()
    }
    func testHostNamespacesDoNotShareWalletProfileOrRetirement() throws {
        let support = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: support) }
        let firstRoot = try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: "org.example.first")
        let secondRoot = try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: "org.example.second")
        let first = try CitizenSDKSecureStore(directory: firstRoot.appendingPathComponent("secure"))
        let second = try CitizenSDKSecureStore(directory: secondRoot.appendingPathComponent("secure"))
        defer { first.close(); second.close() }
        _ = try first.walletProfileCAS(expected: 0, candidate: Data([1]))
        XCTAssertFalse(try second.walletProfileLoad().present)
        let generation = Data(repeating: 3, count: 16)
        let provision = Data(repeating: 4, count: 16)
        XCTAssertTrue(try first.ensureGeneration(walletIndex: 0, generation: generation, operationID: provision))
        XCTAssertTrue(try second.ensureGeneration(walletIndex: 0, generation: generation, operationID: provision))
        try first.retireGeneration(walletIndex: 0, generation: generation, operationID: Data(repeating: 5, count: 16))
        XCTAssertFalse(try first.isGenerationActive(walletIndex: 0, generation: generation))
        XCTAssertTrue(try second.isGenerationActive(walletIndex: 0, generation: generation))
    }

    func testProfileAndEncryptedSecretCASAreIsolated() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }

        XCTAssertFalse(try store.walletProfileLoad().present)
        XCTAssertEqual(try store.walletProfileCAS(expected: 0, candidate: Data([1])).revision, 1)
        XCTAssertEqual(try store.walletProfileCAS(expected: 0, candidate: Data([2])).errorCode, .conflict)

        let generation = Data(repeating: 3, count: 16)
        let owner = Data(repeating: 4, count: 16)
        let account = Data(repeating: 5, count: 32)
        let secret = try store.encryptedSecretCAS(walletIndex: 0, kind: 1, generation: generation,
                                                   owner: owner, accountID: account, expected: 0,
                                                   candidate: Data([6]))
        XCTAssertEqual(secret.revision, 1)
        XCTAssertEqual(try store.encryptedSecretLoad(walletIndex: 0, kind: 1, generation: generation,
                                                      owner: owner, accountID: account).record, Data([6]))
    }

    func testGenerationTombstoneCannotBeReactivated() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }
        let generation = Data(repeating: 1, count: 16)
        let provision = Data(repeating: 2, count: 16)
        XCTAssertTrue(try store.ensureGeneration(walletIndex: 0, generation: generation,
                                                 operationID: provision))
        XCTAssertFalse(try store.ensureGeneration(walletIndex: 0, generation: generation,
                                                  operationID: Data(repeating: 3, count: 16)))
        try store.retireGeneration(walletIndex: 0, generation: generation,
                                   operationID: Data(repeating: 4, count: 16))
        XCTAssertFalse(try store.isGenerationActive(walletIndex: 0, generation: generation))
        XCTAssertFalse(try store.ensureGeneration(walletIndex: 0, generation: generation,
                                                  operationID: provision))
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    private func corruptRevision(_ file: URL, _ sql: String) throws {
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(file.path, &database, SQLITE_OPEN_READWRITE, nil), SQLITE_OK)
        guard let database else { return XCTFail("SQLite fixture did not open") }
        defer { sqlite3_close_v2(database) }
        XCTAssertEqual(sqlite3_exec(database, sql, nil, nil, nil), SQLITE_OK)
    }
}
