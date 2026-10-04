import XCTest
@testable import CitizenSDK
@testable import CitizenSDKFlutter

/// 真实无UI请求的输入/资源边界；不打开SDK窗口或把合成数据当设备验收。
final class CitizenSDKFlutterWalletFlowTests: XCTestCase {
    func testPrepareAndAppendCarryExplicitBoundedInputsOnly() throws {
        for count: UInt32 in [12, 18, 24] {
            let request = try CitizenSdkFlutterCodec.decode(method: "prepareWalletCreation", arguments: [2, "s", 1, count, ""])
            guard case let .walletInput(_, _, _, _, _, words, indices) = request else { return XCTFail("prepare request") }
            XCTAssertEqual(words, count); XCTAssertTrue(indices.isEmpty)
        }
        let request = try CitizenSdkFlutterCodec.decode(method: "addWalletAccounts", arguments: [2, "s", 2, "synthetic", "", [2, 7]])
        guard case let .walletInput(_, _, _, _, _, _, indices) = request else { return XCTFail("append request") }
        XCTAssertEqual(indices, [2, 7])
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "addNextWalletAccount", arguments: [2, "s", 3, "synthetic", "", 9]))
    }

    func testRemovedWindowsAndInjectedPresentationAreRejected() {
        for method in ["initializeWallet", "createWallet", "importColdAccountWithUi", "viewAccountPrivateKey", "qrScan"] {
            XCTAssertFalse(CitizenSdkFlutterCodec.methods.contains(method))
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1]))
        }
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "prepareWalletCreation", arguments: [2, "s", 1, 18, "", "界面文案"]))
    }

    func testResourceReferencesAreOpaqueAndRejectBareHandlesOrWrongShapes() {
        for method in ["releasePreparedWallet", "copyRecoveryPhrase", "releaseWalletInspection", "revealPrivateKey", "closePrivateKey", "releaseQrReview"] {
            XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1, "owned-resource"]))
            for wrong in ["", "a/b", String(repeating: "a", count: 129)] {
                XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1, wrong]))
            }
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1, 9]))
        }
    }
}
