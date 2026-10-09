import Foundation
import XCTest
@testable import CitizenSDK
@testable import CitizenSDKFlutter

final class CitizenSDKFlutterSecretBoundaryTests: XCTestCase {
    func testExplicitImportAndAppendInputsStayBoundedAndNeverBecomeErrorText() throws {
        let input = "synthetic-input"
        guard case let .walletInput(_, _, _, text, password, _, _) = try CitizenSdkFlutterCodec.decode(
            method: "importWallet", arguments: [2, "s", 1, input, ""]) else { return XCTFail("import request") }
        XCTAssertEqual(text, input); XCTAssertEqual(password, "")
        for method in ["importWallet", "addNextWalletAccount"] {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1]))
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1, String(repeating: "x", count: 1025), ""])) { error in
                XCTAssertFalse(String(describing: error).contains(String(repeating: "x", count: 64)))
            }
        }
    }

    func testPreparedAndPrivateResourcesNeverAcceptRawCoreHandles() {
        for method in ["copyRecoveryPhrase", "revealPrivateKey", "closePrivateKey"] {
            XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1, "resource-owned"]))
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1, 7]))
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "s", 1, "resource-owned", true]))
        }
    }

    func testErrorTupleContainsOnlyStablePublicFields() {
        let tuple = CitizenSdkFlutterCodec.error(.storage, "safe failure", session: "s", sequence: 4,
                                                 method: "getStorage")
        XCTAssertEqual(tuple.count, 7)
        XCTAssertEqual(tuple[1] as? String, "s")
        XCTAssertEqual(tuple[2] as? Int64, 4)
        XCTAssertEqual(tuple[4] as? Int64, Int64(CitizenSDKFailureStage.persistence.rawValue))
        XCTAssertEqual(tuple[5] as? String, "getStorage")
        XCTAssertEqual(tuple[6] as? String, "safe failure")
    }
}
