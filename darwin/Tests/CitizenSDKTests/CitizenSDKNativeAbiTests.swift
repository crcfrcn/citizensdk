import Foundation
import XCTest
@testable import CitizenSDK

final class CitizenSDKNativeAbiTests: XCTestCase {
    func testOperationIdentitiesAreCanonicalDecimalAndNeverWrap() throws {
        let identities = CitizenSDKOperationIdentifiers()
        XCTAssertEqual(try identities.allocate(), "1")
        XCTAssertEqual(try identities.allocate(), "2")
        let exhausted = CitizenSDKOperationIdentifiers(next: UInt64.max)
        XCTAssertEqual(try exhausted.allocate(), String(UInt64.max))
        XCTAssertThrowsError(try exhausted.allocate())
        XCTAssertThrowsError(try exhausted.allocate())
    }

    func testQrOnlyRoundTripRequiresNoWalletVaultOrChain() throws {
        let sdk = try CitizenSdk.open(modules: .qr)
        defer { try? sdk.close() }
        let account = Data(repeating: 7, count: 32)
        let text = try sdk.qrEncodeAccountID(account)
        let document = try sdk.qrParse(text)
        XCTAssertEqual(document.kind, 5)
        XCTAssertEqual(document.content, .accountID("0x" + String(repeating: "07", count: 32)))
        let image = try sdk.qrEncode(text)
        XCTAssertEqual(try sdk.qrDecodeLuminance(image.luminance, width: image.width,
            height: image.height, rowStride: image.width).canonicalText, text)
        XCTAssertEqual(sdk.lifecycle, .created)
        XCTAssertThrowsError(try sdk.genesisHash()) { XCTAssertEqual(($0 as? CitizenSDKError)?.code, .unsupported) }
        let host = try CitizenSDKHostBridge(applicationID: "org.citizen.sdk.qr-tests", modules: .qr)
        host.withServices {
            XCTAssertNil($0.pointee.public_store)
            XCTAssertNil($0.pointee.secure_store)
            XCTAssertNil($0.pointee.secret_vault)
        }
    }

    func testClosedCaptureRejectsLateStartWithoutRequestingCamera() async throws {
        let native = try CitizenSDKNative.open(assets: nil, modules: .qr)
        let closed = expectation(description: "采集关闭通知")
        let ended = expectation(description: "采集所有权结束")
        let camera = CitizenSDKQrCapture(native: native,
            purpose: try XCTUnwrap(CitizenQRScanPurpose(rawValue: 1)),
            listener: .init(result: { _ in XCTFail("关闭后不得识别") },
                            error: { _ in XCTFail("关闭后不得请求权限") },
                            frame: { _ in XCTFail("关闭后不得交付帧") },
                            closed: { closed.fulfill() }),
            ended: { _ in ended.fulfill() })
        camera.requestClose()
        do { try await camera.start(); XCTFail("已撤销资源不能打开") }
        catch { XCTAssertEqual((error as? CitizenSDKError)?.code, .cancelled) }
        try await camera.close()
        try await camera.close()
        await fulfillment(of: [closed, ended], timeout: 2)
        XCTAssertNil(camera.preview)
        XCTAssertNil(camera.copyPixelBuffer())
        try native.close()
    }

    func testCreatedChainRejectsEmptyBatchWithNotReadyBeforeClosing() async throws {
        let sdk = try CitizenSdk.open(modules: .chain)
        XCTAssertEqual(sdk.lifecycle, .created)
        do {
            _ = try await sdk.accountBalances(accountIDs: [])
            XCTFail("Created 状态的空批量不得被平台短路为空成功")
        } catch {
            XCTAssertEqual((error as? CitizenSDKError)?.code, .notReady)
        }
        XCTAssertEqual(sdk.lifecycle, .created)
        // value 返回前已释放 Core 结果；若回调派发还未退出，只重试 BUSY，不能强制销毁。
        for _ in 0..<500 {
            do {
                try sdk.close()
                XCTAssertEqual(sdk.lifecycle, .disposed)
                return
            } catch let error as CitizenSDKError where error.code == .busy {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        }
        try sdk.close()
        XCTAssertEqual(sdk.lifecycle, .disposed)
    }

    func testImportedCoreAbiStructuresAreVersioned() {
        XCTAssertGreaterThan(MemoryLayout<citizensdk_create_options_t>.size, 0)
        XCTAssertGreaterThan(MemoryLayout<citizensdk_host_services_v1_t>.size, 0)
        XCTAssertEqual(MemoryLayout<citizensdk_host_secret_presence_v1_t>.size, 32)
        XCTAssertGreaterThan(MemoryLayout<citizensdk_event_t>.size, 0)
        XCTAssertEqual(CITIZENSDK_HOST_BYTES_WRAPPED_DEK, 1)
        XCTAssertEqual(CITIZENSDK_OK, 0)
        XCTAssertEqual(CITIZENSDK_EXTERNAL_SIGNER_QR_V1, 1)
        XCTAssertEqual(CITIZENSDK_SIGNING_COMPLETED, 1)
    }

    func testHeaderExportsExactUniqueCitizenSdkSymbolsIncludingModulesAndVerify() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let sdkRoot = testFile.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let header = sdkRoot.appendingPathComponent("include/citizensdk.h")
        let source = try String(contentsOf: header, encoding: .utf8)
        // 公开数值合同使用Clang可直接导入Swift的字面量宏，不维护第二份Swift常量。
        XCTAssertEqual(CITIZENSDK_RESULT_ACCOUNT_BALANCES, 18)
        let regex = try NSRegularExpression(pattern: #"\bcitizensdk_[a-z0-9_]+\s*\("#)
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        let names = Set(regex.matches(in: source, range: range).compactMap { match -> String? in
            guard let swiftRange = Range(match.range, in: source) else { return nil }
            return source[swiftRange].split(separator: "(").first.map {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        })
        XCTAssertEqual(names.count, 144)
        XCTAssertTrue(names.isSuperset(of: ["citizensdk_set_secret_presence_provider", "citizensdk_encrypted_secret_record_has_secret"]))
        XCTAssertTrue(names.isSuperset(of: ["citizensdk_review_qr_sign_request", "citizensdk_sign_qr_request", "citizensdk_result_copy_qr"]))
        XCTAssertFalse(names.contains("citizensdk_qr_signing_bytes"))
        XCTAssertFalse(names.contains("citizensdk_qr_create_sign_response"))
        XCTAssertTrue(names.isSuperset(of: ["citizensdk_validate_modules", "citizensdk_create_with_modules", "citizensdk_verify_signature"]))
        XCTAssertTrue(names.isSuperset(of: ["citizensdk_get_genesis_hash", "citizensdk_get_finalized_account_balances",
            "citizensdk_result_get_account_balance_count", "citizensdk_result_get_account_balance_at"]))
        XCTAssertTrue(names.isSuperset(of: ["citizensdk_get_storage_keys_paged", "citizensdk_call_runtime_api"]))
    }
}
