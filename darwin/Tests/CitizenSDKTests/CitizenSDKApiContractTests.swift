import Foundation
import XCTest
@testable import CitizenSDK

final class CitizenSDKApiContractTests: XCTestCase {
    func testQrProjectionPreservesEveryReviewFieldAndRejectsMalformedCoreData() throws {
        // 合成公开投影只测试 UI 文本完整性，不是链元数据或受保护签名向量。
        let account = "0x" + String(repeating: "11", count: 32)
        let arguments = "destination: 中文\\u0000\\n\namount: 123"
        let fields: [String: Any] = [
            "kind": 1, "canonical_text": "{}", "scan_purpose_mask": 66, "request_id": "test-public-request", "expires_at": 123,
            "action": 1024, "signer_account_id": account, "review_payload": "0x0400",
            "pallet_name": "Balances", "call_name": "transfer", "call_arguments": arguments,
            "genesis_hash": account, "spec_version": 7, "transaction_version": 8,
            "era": "mortal(period=64,phase=1,birth=1)", "nonce": "9", "tip": "10", "block_hash": account,
        ]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), as: UTF8.self)
        let document = try CitizenQRDocument(coreJSON: json)
        XCTAssertEqual(document.kind, 1)
        let projection = try CitizenSDKQrProjection.decode(json)
        XCTAssertEqual(projection.pallet_name, "Balances")
        XCTAssertEqual(projection.call_name, "transfer")
        XCTAssertEqual(projection.call_arguments, arguments)
        XCTAssertEqual(projection.era, "mortal(period=64,phase=1,birth=1)")
        XCTAssertEqual(projection.nonce, "9"); XCTAssertEqual(projection.tip, "10")
        for invalid in ["{}", "[]", String(repeating: "x", count: 65_537),
                        json.replacingOccurrences(of: "\"expires_at\":123", with: "\"expires_at\":9223372036854775808")] {
            XCTAssertThrowsError(try CitizenQRDocument(coreJSON: invalid)) {
                XCTAssertEqual(($0 as? CitizenSDKError)?.code, .integrity)
            }
        }
    }

    func testPrivateAuthorizationDoesNotTreatRegistrationAsActualDeviceAuthentication() throws {
        let host = try CitizenSDKHostBridge(applicationID: "org.citizen.sdk.tests", modules: .wallet)
        XCTAssertFalse(host.isAuthenticationActive(19))
        XCTAssertEqual(host.registerPrivateKeyAuthentication(19), 0)
        XCTAssertEqual(host.registerPrivateKeyAuthentication(19), CitizenSDKErrorCode.integrity.rawValue)
        // 尚无 LAContext，不能因为登记了 ID 就获得焦点豁免或探测/打开金库。
        XCTAssertFalse(host.isAuthenticationActive(19))
        XCTAssertFalse(host.isAuthenticationActive(20))
        host.cancelAuthentication(19)
        XCTAssertFalse(host.isAuthenticationActive(19))
        host.releasePrivateKeyAuthentication(19)
        XCTAssertFalse(host.isAuthenticationActive(19))
    }

    func testBatchBalanceInputKeepsEmptyDuplicatesAndOrder() throws {
        let first = Data(repeating: 1, count: 32)
        let second = Data(repeating: 2, count: 32)
        XCTAssertEqual(try CitizenSDKInputLimits.balanceAccountIDs([]), [])
        XCTAssertEqual(try CitizenSDKInputLimits.balanceAccountIDs([second, first, second]), [second, first, second])
        XCTAssertEqual(try CitizenSDKInputLimits.balanceAccountIDs(Array(repeating: first, count: 1_990)).count, 1_990)
        XCTAssertThrowsError(try CitizenSDKInputLimits.balanceAccountIDs(Array(repeating: first, count: 1_991)))
        XCTAssertThrowsError(try CitizenSDKInputLimits.balanceAccountIDs([Data(repeating: 0, count: 31)]))
    }

    func testBatchBalanceProjectionRejectsPartialReorderedOrMixedBlockResults() throws {
        let first = Data(repeating: 1, count: 32)
        let second = Data(repeating: 2, count: 32)
        let finalized = try CitizenBlockRef(hash: Data(repeating: 3, count: 32), number: 7, finality: .finalized)
        let next = try CitizenBlockRef(hash: Data(repeating: 4, count: 32), number: 8, finality: .finalized)
        let best = try CitizenBlockRef(hash: finalized.hash, number: finalized.number, finality: .best)
        func balance(_ account: Data, _ block: CitizenBlockRef) throws -> CitizenAccountBalance {
            CitizenAccountBalance(block: block, accountID: account, freeFen: try CitizenU128("7"),
                                  reservedFen: try CitizenU128("3"), totalFen: try CitizenU128("10"))
        }
        let a = try balance(first, finalized)
        let b = try balance(second, finalized)
        XCTAssertEqual(try CitizenSDKNativeCodec.validateBalances([], accountIDs: []), [])
        XCTAssertEqual(try CitizenSDKNativeCodec.validateBalances([b, a, b], accountIDs: [second, first, second]), [b, a, b])
        for values in [[a], [b, a], [a, try balance(second, next)], [a, try balance(second, best)]] {
            XCTAssertThrowsError(try CitizenSDKNativeCodec.validateBalances(values, accountIDs: [first, second])) {
                XCTAssertEqual(($0 as? CitizenSDKError)?.code, .integrity)
            }
        }
    }

    func testModulesKeepWalletAndSigningIndependent() {
        XCTAssertEqual(CitizenSDKModules.wallet.rawValue, 1)
        XCTAssertEqual(CitizenSDKModules.signing.rawValue, 2)
        XCTAssertEqual(CitizenSDKModules.chain.rawValue, 4)
        XCTAssertEqual(CitizenSDKModules.transactions.rawValue, 8)
        XCTAssertEqual(CitizenSDKModules.history.rawValue, 16)
        XCTAssertEqual(CitizenSDKModules.qr.rawValue, 32)
        XCTAssertEqual(CitizenSDKModules.full.rawValue, 63)
        XCTAssertFalse(CitizenSDKModules.wallet.contains(.signing))
        XCTAssertFalse(CitizenSDKModules.signing.contains(.wallet))
    }

    func testReadOnlyDiagnosticsAreNotSigningAccountsAndKeepOriginalFacts() {
        let id = Data(repeating: 1, count: 32)
        let diagnostic = CitizenWalletDiagnostic(walletIndex: 0, walletName: "异常", accountID: id,
            ss58Address: nil, diagnosticReason: 3, signMode: .hot,
            cleanupTargets: CitizenWalletCleanupTargets(accountIDs: [id, Data(repeating: 2, count: 32)], deleteWalletWideKey: true))
        let state = CitizenWalletState(revision: 7, hotProfile: nil, accounts: [], initializationState: 1,
            cleanupPending: false, activeWalletIndex: 0, diagnostics: [diagnostic])
        XCTAssertNil(state.defaultAccount); XCTAssertNil(state.hotProfile)
        XCTAssertEqual(state.diagnostics.first?.cleanupTargets?.accountIDs.count, 2)
        XCTAssertEqual(state.diagnostics.first?.signMode, .hot)
        XCTAssertNil(state.diagnostics.first?.ss58Address)
    }

    func testHostProjectsOnlySelectedResourceGroupsWithoutOpeningStores() throws {
        let combinations: [CitizenSDKModules] = [.wallet, .signing, .chain, [.chain, .history], .full]
        for modules in combinations {
            let host = try CitizenSDKHostBridge(applicationID: "org.citizen.sdk.tests", modules: modules)
            host.withServices { pointer in
                let services = pointer.pointee
                XCTAssertEqual(services.public_store != nil, modules.contains(.chain))
                XCTAssertEqual(services.secure_store != nil, modules.usesSecrets)
                XCTAssertEqual(services.secret_vault != nil, modules.usesSecrets)
                if let store = services.public_store {
                    XCTAssertNotNil(store.pointee.chain_database_load)
                    XCTAssertEqual(store.pointee.transaction_history_query != nil, modules.contains(.history))
                    XCTAssertEqual(store.pointee.transaction_history_mutate != nil, modules.contains(.history))
                }
            }
        }
    }

    func testCoreRejectsInvalidModuleCombinationsBeforeHostCreation() {
        for raw: UInt32 in [0, 64, 8, 16, UInt32.max] {
            XCTAssertThrowsError(try CitizenSDKNative.validateModules(CitizenSDKModules(rawValue: raw)))
        }
    }

    func testStandaloneVerifyRejectsMalformedPublicInputsWithoutOpeningSdk() {
        XCTAssertThrowsError(try CitizenSigning.verify(accountID: Data(repeating: 0, count: 31),
                                                       signature: Data(repeating: 0, count: 64), message: Data()))
        XCTAssertThrowsError(try CitizenSigning.verify(accountID: Data(repeating: 0, count: 32),
                                                       signature: Data(repeating: 0, count: 63), message: Data()))
    }

    func testU128CanonicalBoundary() throws {
        XCTAssertEqual(try CitizenU128("0").decimal, "0")
        XCTAssertEqual(
            try CitizenU128("340282366920938463463374607431768211455").decimal,
            "340282366920938463463374607431768211455"
        )
        XCTAssertThrowsError(try CitizenU128("01"))
        XCTAssertThrowsError(try CitizenU128("340282366920938463463374607431768211456"))
    }

    func testBlockIdentityRequiresExactlyThirtyTwoBytes() throws {
        XCTAssertNoThrow(try CitizenBlockRef(hash: Data(repeating: 1, count: 32),
                                              number: 7, finality: .finalized))
        XCTAssertThrowsError(try CitizenBlockRef(hash: Data(repeating: 1, count: 31),
                                                 number: 7, finality: .finalized))
    }

    func testCapabilityVocabularyRemainsComplete() {
        XCTAssertEqual(CitizenCapabilityName.allCases.map(\.rawValue), (1...10).map(UInt32.init))
        XCTAssertEqual(CitizenSDKErrorCode.allCases.map(\.rawValue), (0...22).map(Int32.init))
    }
}
