import Foundation
import XCTest
@testable import CitizenSDK

final class CitizenSDKSensitiveBufferTests: XCTestCase {
    func testPrivateAuthorizationBindsOnlyThisViewAndRejectsLateOrUnrelatedOperations() {
        let display = CitizenSDKPrivateKeyReceiver()
        display.bind(7)
        var registered: [UInt64] = []
        display.bindAuthenticationRegistry { registered.append($0); return 0 }
        XCTAssertEqual(display.authorizing(viewID: 8, hostOperationID: 19), CitizenSDKErrorCode.integrity.rawValue)
        XCTAssertEqual(display.authorizing(viewID: 7, hostOperationID: 0), CitizenSDKErrorCode.integrity.rawValue)
        XCTAssertNil(display.authenticationID)
        XCTAssertEqual(display.authorizing(viewID: 7, hostOperationID: 19), 0)
        XCTAssertEqual(display.authenticationID, 19)
        XCTAssertEqual(registered, [19])
        XCTAssertEqual(display.authorizing(viewID: 7, hostOperationID: 20), CitizenSDKErrorCode.integrity.rawValue)
        display.clear()
        XCTAssertEqual(display.authorizing(viewID: 7, hostOperationID: 21), CitizenSDKErrorCode.cancelled.rawValue)
        XCTAssertEqual(registered, [19], "late or unrelated authentication must never register")
    }

    func testPrivateViewBufferHasBoundedHexRenderingAndRejectsLateDisplay() throws {
        let display = CitizenSDKPrivateKeyReceiver()
        display.bind(7)
        // 仅构造公开合成字节验证显示边界，不创建或读取钱包/真实密钥。
        let source = (0..<32).map(UInt8.init)
        // XCTest断言所在借用闭包可抛错；经try传回测试运行器，不吞掉失败或延长指针寿命。
        try source.withUnsafeBufferPointer { bytes in
            let borrowed = citizensdk_bytes_view_t(data: bytes.baseAddress, len: 32)
            XCTAssertEqual(display.receive(viewID: 8, bytes: borrowed), CitizenSDKErrorCode.cancelled.rawValue)
            XCTAssertEqual(display.receive(viewID: 7, bytes: borrowed), 0)
            XCTAssertEqual(display.receive(viewID: 7, bytes: borrowed), CitizenSDKErrorCode.cancelled.rawValue)
            XCTAssertEqual(try? display.copyBytes(), Data(source))
            display.clear()
            XCTAssertTrue(display.isClearedForTesting)
            XCTAssertEqual(display.receive(viewID: 7, bytes: borrowed), CitizenSDKErrorCode.cancelled.rawValue)
            XCTAssertThrowsError(try display.copyBytes())
        }
    }

    func testPrivateViewBufferRejectsMalformedLengthBeforeReadingAndHandlesEarlySettlement() {
        let display = CitizenSDKPrivateKeyReceiver()
        display.settled(viewID: 9, code: CitizenSDKErrorCode.notFound.rawValue)
        display.bind(9)
        let notified = expectation(description: "early no-secret settlement")
        display.listen { code in
            XCTAssertEqual(code, CitizenSDKErrorCode.notFound.rawValue)
            notified.fulfill()
        }
        XCTAssertEqual(display.receive(viewID: 9, bytes: .init(data: nil, len: 32)), CitizenSDKErrorCode.integrity.rawValue)
        wait(for: [notified], timeout: 1)
        display.clear()
        XCTAssertTrue(display.isClearedForTesting)
    }

    func testControlledBufferCopiesAndClearsBeforeTerminalCallback() {
        let first = CitizenSDKSensitiveBuffer(data: Data([1, 2, 3]))
        let second = CitizenSDKSensitiveBuffer(data: Data([4, 5, 6]))
        XCTAssertEqual(first.copyData(), Data([1, 2, 3]))
        XCTAssertFalse(first.isClearedForTesting)

        first.clear(); second.clear()
        XCTAssertTrue(first.isClearedForTesting && second.isClearedForTesting)
    }

    func testSensitiveTextRejectsOversizedUtf8() {
        XCTAssertEqual(try? CitizenSDKNative.validateWalletInput(String(repeating: "a", count: 1_025), kind: 1, wordCount: 0).reason, .inputTooLong)
    }
}
