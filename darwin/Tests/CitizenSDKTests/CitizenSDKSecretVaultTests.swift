import Foundation
import XCTest
@testable import CitizenSDK

final class CitizenSDKSecretVaultTests: XCTestCase {

    /// 缺钥与退休只返回失败；封装不能偷偷创建Keychain钥或改写代际所有者。
    func testWrapRequiresExistingActiveKeyWithoutInitializingGeneration() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }
        let vault = try CitizenSDKSecretVault(secureStore: store, applicationID: "org.example.vault")
        let generation = Data(repeating: 61, count: 16), original = Data(repeating: 62, count: 16)
        let append = Data(repeating: 63, count: 16), dek = Data(repeating: 64, count: 32)
        func rejected() {
            XCTAssertThrowsError(try dek.withUnsafeBytes {
                try vault.wrapDEK(walletIndex: 0, generation: generation, provisioningOperationID: append, plaintext: $0)
            }) { error in
                XCTAssertEqual((error as? CitizenSDKError)?.code, .keyInvalidated)
            }
        }
        rejected()
        XCTAssertFalse(try store.isGenerationActive(walletIndex: 0, generation: generation))
        XCTAssertTrue(try store.ensureGeneration(walletIndex: 0, generation: generation, operationID: original))
        rejected() // 只有活动记录，没有物理钥，仍不得补造。
        XCTAssertTrue(try store.ensureGeneration(walletIndex: 0, generation: generation, operationID: original))
        XCTAssertFalse(try store.ensureGeneration(walletIndex: 0, generation: generation, operationID: append))
        try store.retireGeneration(walletIndex: 0, generation: generation, operationID: append)
        rejected()
        XCTAssertFalse(try store.isGenerationActive(walletIndex: 0, generation: generation))
    }

    /// 追加认证在缺钥时直接失败，不弹认证、不造钥；空输出完成器也只结算一次。
    func testAddAuthorizationRequiresExistingKeyAndCompletionIsSingle() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }
        let vault = try CitizenSDKSecretVault(secureStore: store, applicationID: "org.example.vault")
        XCTAssertThrowsError(try vault.authorizeAddAccounts(operationID: 1, walletIndex: 0,
            generation: Data(repeating: 41, count: 16), provisioningOperationID: Data(repeating: 42, count: 16)) {
                _ in XCTFail("拒绝前不得受理完成回调")
            }) { XCTAssertEqual(($0 as? CitizenSDKError)?.code, .keyInvalidated) }
        var completions = 0
        let accepted = CitizenSDKAcceptedVaultOperation(output: UnsafeMutableRawBufferPointer(start: nil, count: 0),
            releasePending: {}, completion: { code in
                XCTAssertEqual(code, .authenticationCancelled); completions += 1
            })
        accepted.finish(.authenticationCancelled)
        accepted.finish(.ok)
        XCTAssertEqual(completions, 1)
    }

    func testPhysicalPresenceDoesNotGuessUnknownAliasesOrOtherWallets() throws {
        // 调用生产归属判断；这里只提供系统属性的合成返回，不接触Keychain。
        let first = Data("citizensdk_wallet_first".utf8), second = Data("citizensdk_wallet_second".utf8)
        let known: [Data: UInt32] = [first: 0, second: UInt32.max]
        XCTAssertFalse(try CitizenSDKSecretVault.walletKeyPresent(walletIndex: 0, known: known, tags: []))
        XCTAssertFalse(try CitizenSDKSecretVault.walletKeyPresent(walletIndex: 0, known: known, tags: [second]))
        XCTAssertTrue(try CitizenSDKSecretVault.walletKeyPresent(walletIndex: UInt32.max, known: known, tags: [second]))
        XCTAssertTrue(try CitizenSDKSecretVault.walletKeyPresent(walletIndex: 0, known: known, tags: [first]))
        XCTAssertThrowsError(try CitizenSDKSecretVault.walletKeyPresent(walletIndex: 0, known: known,
            tags: [Data("citizensdk_wallet_unknown".utf8)]))
        XCTAssertThrowsError(try CitizenSDKSecretVault.walletKeyPresent(walletIndex: 0, known: known,
            tags: Array(repeating: first, count: 65537)))
        XCTAssertFalse(try CitizenSDKSecretVault.walletKeyPresent(walletIndex: 0, known: known, tags: [Data("another-product".utf8)]))
    }

    func testAcceptedOwnerCopiesExactDekThenCompletes() throws {
        let output = UnsafeMutableRawPointer.allocate(byteCount: 32, alignment: 16)
        defer { output.deallocate() }
        output.initializeMemory(as: UInt8.self, repeating: 0, count: 32)
        var releaseCount = 0
        var completionCount = 0
        let owner = CitizenSDKAcceptedVaultOperation(
            output: UnsafeMutableRawBufferPointer(start: output, count: 32),
            releasePending: { releaseCount += 1 },
            completion: { code in
                XCTAssertEqual(code, .ok)
                completionCount += 1
            }
        )
        let input = Data((0..<32).map(UInt8.init))
        try input.withUnsafeBytes { try owner.copyDEK($0) }
        owner.finish(.ok)
        owner.finish(.internalFailure)

        XCTAssertEqual(Data(bytes: output, count: 32), input)
        XCTAssertEqual(releaseCount, 1)
        XCTAssertEqual(completionCount, 1)
    }

    func testHardwareAvailabilityProbeIsFinite() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }
        let value = try CitizenSDKSecretVault(secureStore: store, applicationID: "org.example.vault").availability()
        XCTAssertTrue([.available, .noStrongUserAuthentication, .unsupported, .unavailable].contains(value))
    }

    /// Secure Enclave key creation, biometric prompt outcome and this-device-
    /// only Keychain persistence are executed only by the canonical real-device
    /// fixture; simulators must never claim that hardware coverage.
    func testSimulatorDoesNotClaimSecureEnclaveHardware() throws {
        #if targetEnvironment(simulator)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CitizenSDKSecureStore(directory: directory)
        defer { store.close() }
        XCTAssertEqual(try CitizenSDKSecretVault(secureStore: store, applicationID: "org.example.vault").availability(), .unsupported)
        #else
        throw XCTSkip("Hardware vault behavior is covered by the signed device fixture")
        #endif
    }
}
