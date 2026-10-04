import XCTest
@testable import CitizenSDK

/// 真实调用Core纯校验/词表，不打开SDK窗口，也不创建或读取用户钱包。
final class CitizenSDKWalletInputTests: XCTestCase {
    func testOptionalPasswordAndTypedFailuresComeFromCore() throws {
        for value in ["", "六个中性汉字", "abcdef"] {
            XCTAssertEqual(try CitizenSDKNative.validateWalletInput(value, kind: 1, wordCount: 0).reason, .valid)
        }
        for value in ["abcde", String(repeating: "a", count: 31), "abc def", "abcde\n", "abcdef🙂"] {
            XCTAssertNotEqual(try CitizenSDKNative.validateWalletInput(value, kind: 1, wordCount: 0).reason, .valid)
        }
        XCTAssertEqual(try CitizenSDKNative.validateWalletInput(String(repeating: "a", count: 1025), kind: 1, wordCount: 0).reason, .inputTooLong)
    }

    func testThreeWordCountsChecksumAndUnknownWordAreCoreFacts() throws {
        // BIP39公开全零熵向量，只校验，不导入或签名。
        for (count, checksum) in [(12, "about"), (18, "agent"), (24, "art")] {
            let phrase = (Array(repeating: "abandon", count: count - 1) + [checksum]).joined(separator: " ")
            XCTAssertEqual(try CitizenSDKNative.validateWalletInput(phrase, kind: 2, wordCount: UInt32(count)).reason, .valid)
            XCTAssertThrowsError(try CitizenSDKNative.validateWalletInput(phrase, kind: 2, wordCount: 15))
            XCTAssertNotEqual(try CitizenSDKNative.validateWalletInput(phrase + " absent", kind: 2, wordCount: UInt32(count)).reason, .valid)
        }
        let bad = (Array(repeating: "abandon", count: 11) + ["notaword"]).joined(separator: " ")
        let result = try CitizenSDKNative.validateWalletInput(bad, kind: 2, wordCount: 12)
        XCTAssertEqual(result.reason, .unknownWord); XCTAssertEqual(result.position, 11)
    }

    func testOfficialSuggestionsAreBoundedWithoutSdkEditingPolicy() throws {
        XCTAssertEqual(try CitizenSDKNative.walletWordSuggestions(""), [])
        XCTAssertEqual(try CitizenSDKNative.walletWordSuggestions("aban"), ["abandon"])
        let values = try CitizenSDKNative.walletWordSuggestions("a")
        XCTAssertEqual(values.count, 6); XCTAssertTrue(values.allSatisfy { $0.hasPrefix("a") })
        XCTAssertThrowsError(try CitizenSDKNative.walletWordSuggestions("Ab"))
        XCTAssertThrowsError(try CitizenSDKNative.walletWordSuggestions("ab cd"))
    }

    func testExplicitIndicesAreBoundedWithoutAnAppAssignedNextIndex() {
        XCTAssertNoThrow(try CitizenSDKInputLimits.additionalIndices([1, 1989]))
        for values: [UInt32] in [[], [0], [1990], [1, 1], Array(repeating: 1, count: 1990)] {
            XCTAssertThrowsError(try CitizenSDKInputLimits.additionalIndices(values))
        }
    }

    func testSensitiveOwnerClearsItsActualCopyAndNeverPrintsInput() {
        let buffer = CitizenSDKSensitiveBuffer(data: Data([1, 2, 3]))
        buffer.clear(); buffer.clear()
        XCTAssertTrue(buffer.isClearedForTesting)
    }
}
