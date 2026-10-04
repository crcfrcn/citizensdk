import Foundation
import XCTest
@testable import CitizenSDK

final class CitizenSDKRecordKeyTests: XCTestCase {
    func testKeychainIdentityUsesCitizenSdkNamespaceOnly() throws {
        let tag = try XCTUnwrap(String(data: CitizenSDKRecordKey.keychainTag(
            applicationID: "org.example.first", walletIndex: 0, generation: Data(repeating: 1, count: 16)
        ), encoding: .utf8))
        XCTAssertTrue(tag.hasPrefix("citizensdk_wallet_"))
        XCTAssertFalse(tag.contains("citizenapp"))
        XCTAssertFalse(tag.contains("org.citizen.sdk"))
    }

    func testGenerationChangesKeychainIdentity() throws {
        let first = try CitizenSDKRecordKey.keychainTag(applicationID: "org.example.first", walletIndex: 0,
                                                         generation: Data(repeating: 1, count: 16))
        let second = try CitizenSDKRecordKey.keychainTag(applicationID: "org.example.first", walletIndex: 0,
                                                          generation: Data(repeating: 2, count: 16))
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(first, try CitizenSDKRecordKey.keychainTag(
            applicationID: "org.example.first", walletIndex: 0, generation: Data(repeating: 1, count: 16)
        ))
    }

    func testMalformedIdentitiesFailClosed() {
        XCTAssertThrowsError(try CitizenSDKRecordKey.keychainTag(
            applicationID: "org.example.first", walletIndex: 0, generation: Data(repeating: 1, count: 15)
        ))
        XCTAssertThrowsError(try CitizenSDKRecordKey.secret(
            walletIndex: 0, kind: 1, generation: Data(repeating: 0, count: 16),
            owner: Data(repeating: 0, count: 16), accountID: Data(repeating: 0, count: 31)
        ))
    }

    func testHostIdentityPartitionsBothStorageAndKeychain() throws {
        let support = URL(fileURLWithPath: "/example/Application Support", isDirectory: true)
        let first = try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: "org.example.first")
        let second = try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: "org.example.second")
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(first.path, "/example/Application Support/org.example.first/citizensdk/v1")
        XCTAssertEqual(first, try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: "org.example.first"))
        let generation = Data(repeating: 1, count: 16)
        XCTAssertNotEqual(
            try CitizenSDKRecordKey.keychainTag(applicationID: "org.example.first", walletIndex: 0, generation: generation),
            try CitizenSDKRecordKey.keychainTag(applicationID: "org.example.second", walletIndex: 0, generation: generation)
        )
        for invalid: String? in [nil, "", "..", "org..example", "org/example", "org.example\\other", " org.example", "org.example\n"] {
            XCTAssertThrowsError(try CitizenSDKHostBridge.storageRoot(applicationSupport: support, applicationID: invalid))
        }
    }

    func testMissingHostIdentityRejectsBeforeCreatingStores() {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertThrowsError(try CitizenSDKHostBridge(root: root, applicationID: nil))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
}
