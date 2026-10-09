import Foundation
import XCTest
@_spi(CitizenSDKFlutter) @testable import CitizenSDK

@testable import CitizenSDKFlutter

#if os(iOS)
import Flutter
#elseif os(macOS)
import FlutterMacOS
#endif

final class CitizenSDKFlutterCodecTests: XCTestCase {
    func testHighWalletIndicesAreIndependentOfBatchSize() throws {
        for indices in [[1, 1989, 1990, 19_890_604], [60000]] {
            let request = try CitizenSdkFlutterCodec.decode(method: "addWalletAccounts",
                arguments: [2, "synthetic", 1, "synthetic", "", indices])
            if case let .walletInput(_, _, _, _, _, _, decoded) = request {
                XCTAssertEqual(decoded, indices.map { UInt32($0) })
            } else { XCTFail("wallet input required") }
        }
        for indices in [[0], [-1], [19_890_605], [8, 19_890_605], [8, 8], Array(1...1990)] {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "addWalletAccounts",
                arguments: [2, "synthetic", 1, "synthetic", "", indices]))
        }
    }

    func testRealChannelNullCursorsAndRejectedParametersKeepCoreSequenceUsable() async throws {
        // 仅QR实例与测试临时根；不打开用户金库、不启动链，不以Swift手写nil代替通道空值。
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {
            if FileManager.default.fileExists(atPath: root.path) { XCTAssertNoThrow(try FileManager.default.removeItem(at: root)) }
        }
        let sdk = try CitizenSdk.open(storageRoot: root, applicationID: "org.citizen.sdk.tests", modules: .qr)
        do {
            let codec = FlutterStandardMethodCodec.sharedInstance()
            let block: [Any] = ["0x" + String(repeating: "00", count: 32), "1", "finalized"]
            let call = FlutterMethodCall(methodName: "getStorageKeysPaged",
                arguments: [2, "synthetic", 1, block, FlutterStandardTypedData(bytes: Data([1])), NSNull(), 256])
            let decoded = codec.decodeMethodCall(codec.encode(call))
            let wireValues = try XCTUnwrap(decoded.arguments as? [Any?])
            XCTAssertTrue(wireValues[5] is NSNull, "真实通道数组空值必须覆盖NSNull，不能用手写Swift nil替代")
            let envelope = try XCTUnwrap(CitizenSdkFlutterCodec.envelope(method: decoded.method, arguments: decoded.arguments))
            try sdk.acceptRequestSequence(try XCTUnwrap(envelope.sequence))
            let request = try CitizenSdkFlutterCodec.decode(method: decoded.method, arguments: decoded.arguments)
            if case let .storageKeysPage(_, _, _, _, start, _) = request { XCTAssertNil(start) }
            else { XCTFail("storage request") }
            let history = codec.decodeMethodCall(codec.encode(FlutterMethodCall(
                methodName: "getTransactionHistory", arguments: [2, "synthetic", 2, NSNull(), 100])))
            try sdk.acceptRequestSequence(2)
            XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: history.method, arguments: history.arguments))
            // 有效外壳接纳后参数拒绝；后续序号与查询继续工作，不自动重建SDK或跳号。
            try sdk.acceptRequestSequence(3)
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "getStorageKeysPaged", arguments: [2, "synthetic", 3]))
            try sdk.acceptRequestSequence(4)
            _ = try sdk.capabilities()
            XCTAssertThrowsError(try sdk.acceptRequestSequence(4))
            XCTAssertThrowsError(try sdk.acceptRequestSequence(6))
            try sdk.acceptRequestSequence(5)
        } catch {
            try await sdk.supervisedClose()
            throw error
        }
        try await sdk.supervisedClose()

    }


    func testWalletMetadataSeparatesRevisionSelectionAndName() throws {
        let select = try CitizenSdkFlutterCodec.decode(method: "setActiveWallet", arguments: [2, "sdk", 1, "18446744073709551615", Int64(UInt32.max)])
        guard case let .walletMetadata(method, _, _, revision, index, name) = select else { return XCTFail("metadata request") }
        XCTAssertEqual(method, "setActiveWallet"); XCTAssertEqual(revision, UInt64.max)
        XCTAssertEqual(index, UInt32.max); XCTAssertNil(name)
        XCTAssertEqual(select.sessionID, "sdk"); XCTAssertEqual(select.sequence, 1)
        XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: "renameWallet", arguments: [2, "sdk", 2, "7", 0, "钱包名"]))
        let invalid: [[Any]] = [[2, "sdk", 3, "01", 0], [2, "sdk", 3, "1", -1],
            [2, "sdk", 3, "1", Int64(UInt32.max) + 1], [2, "sdk", 3, "1", 0, "extra"]]
        for arguments in invalid { XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "setActiveWallet", arguments: arguments)) }
        for name in ["", " bad", String(repeating: "名", count: 31)] {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "renameWallet", arguments: [2, "sdk", 4, "1", 0, name]))
        }
        let profile = CitizenWalletProfile(walletName: "钱包名", origin: .created, walletIndex: 0, createdAtMillis: 1,
            masterAccountID: Data(repeating: 1, count: 32), activeAccountID: Data(repeating: 1, count: 32), accounts: [])
        let projected = CitizenSdkFlutterCodec.profile(profile)
        XCTAssertEqual(projected?.count, 7); XCTAssertEqual(projected?[6] as? String, "钱包名")
        let empty = CitizenWalletState(revision: 0, hotProfile: nil, accounts: [], initializationState: 0, cleanupPending: false, activeWalletIndex: nil)
        let state = CitizenSdkFlutterCodec.walletState(empty)
        XCTAssertEqual(state.count, 7); XCTAssertNil(state[5])
        // 仅验证公开UInt32到Int64投影，不把合成边界值当作真实钱包资格。
        let boundary = CitizenWalletState(revision: 1, hotProfile: nil, accounts: [],
            initializationState: 1, cleanupPending: false, activeWalletIndex: UInt32.max)
        XCTAssertEqual(CitizenSdkFlutterCodec.walletState(boundary)[5] as? Int64, Int64(UInt32.max))
    }

    func testNonConsumingResponseValidationHasExactOwnedFields() throws {
        guard case let .qr(method, _, _, fields) = try CitizenSdkFlutterCodec.decode(
            method: "qrValidateSignResponse", arguments: [2, "sdk", 1, "request", "{}"])
            else { return XCTFail("QR request expected") }
        XCTAssertEqual(method, "qrValidateSignResponse")
        XCTAssertEqual(fields.count, 2)
        let rejected: [[Any]] = [[2, "sdk", 2, "", "{}"], [2, "sdk", 2, "request", "{}", 100],
                                  [2, "sdk", 2, String(repeating: "x", count: 129), "{}"]]
        for arguments in rejected {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "qrValidateSignResponse", arguments: arguments))
        }
    }

    func testEncodingMethodsHaveExactStatelessAndSessionShapes() throws {
        let bytes = FlutterStandardTypedData(bytes: Data())
        let request = try CitizenSdkFlutterCodec.decode(method: "encodeSigningPayload", arguments: [2, 1, "{\"op_tag\":16}", bytes])
        guard case let .encodePayload(kind, _, payload) = request else { return XCTFail("payload request") }
        XCTAssertEqual(kind, 1); XCTAssertTrue(payload.isEmpty)
        XCTAssertNil(request.sessionID); XCTAssertNil(request.sequence)
        XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: "qrEncodeDocument", arguments: [2, "s", 1, "{}"]))
        XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: "qrPrepareAccountAuthorization", arguments: [2, "s", 2, 10, bytes, ""]))
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "encodeSigningPayload", arguments: [2, 7, "{}", bytes]))
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "encodeSigningPayload", arguments: [1, 1, "{}", bytes]))
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "qrPrepareAccountAuthorization", arguments: [2, "s", 3, 10,
            FlutterStandardTypedData(bytes: Data(count: 1921)), ""]))
    }
    func testHeadlessQrRoutesRejectInjectedClockSignatureAndLegacyMethods() throws {
        XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: "openQrCapture", arguments: [2, "session", 1, 1]))
        for method in ["qrParse", "qrConsumeSignResponse", "reviewQrRequest"] {
            XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "session", 2, "{}"]))
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "session", 2, "{}", 123]))
        }
        XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: "signQrRequest", arguments: [2, "session", 2, "owned"]))
        for method in ["qrScan", "viewAccountPrivateKey", "createWallet", "initializeWallet", "qrSigningInput", "qrCreateSignResponse", "qrEncodeImage"] {
            XCTAssertFalse(CitizenSdkFlutterCodec.methods.contains(method))
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: [2, "session", 3, "{}"]))
        }
    }

    func testPrivateKeyViewTransportsOnlyOnePublicAccountAndKeepsSessionIdentity() throws {
        let account = "0x" + String(repeating: "11", count: 32)
        let request = try CitizenSdkFlutterCodec.decode(method: "openPrivateKey", arguments: [2, "session", 7, account])
        guard case let .account(method, session, sequence, accountID) = request else { return XCTFail("expected public account request") }
        XCTAssertEqual(method, "openPrivateKey"); XCTAssertEqual(session, "session")
        XCTAssertEqual(sequence, 7); XCTAssertEqual(accountID.count, 32)
        for tuple: [Any?] in [[2, "session", 7], [2, "session", 7, account, "extra"],
                             [2, "session", 7, "0X" + String(repeating: "11", count: 32)]] {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "openPrivateKey", arguments: tuple))
        }
    }

    func testChainQueriesKeepSessionShapeAndBatchInputOrder() throws {
        let first = "0x" + String(repeating: "11", count: 32)
        let second = "0x" + String(repeating: "22", count: 32)
        let genesis = try CitizenSdkFlutterCodec.decode(method: "getGenesisHash", arguments: [2, "session", 7])
        XCTAssertEqual(genesis.sessionID, "session")
        XCTAssertEqual(genesis.sequence, 7)
        for accounts in [[], [second, first, second], Array(repeating: first, count: 1_990)] {
            let request = try CitizenSdkFlutterCodec.decode(method: "getAccountBalances", arguments: [2, "session", 8, accounts])
            guard case let .balances(session, sequence, values) = request else { return XCTFail("expected balances") }
            XCTAssertEqual(session, "session")
            XCTAssertEqual(sequence, 8)
            XCTAssertEqual(values.count, accounts.count)
            if accounts.count == 3 { XCTAssertEqual(values, [Data(repeating: 0x22, count: 32), Data(repeating: 0x11, count: 32), Data(repeating: 0x22, count: 32)]) }
        }
        let invalid: [[Any?]] = [
            [2, "session", 8, Array(repeating: first, count: 1_991)],
            [2, "session", 8, ["0x" + String(repeating: "AA", count: 32)]],
            [2, "session", 8, first], [2, "session", 8, [], "extra"],
        ]
        for tuple in invalid {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "getAccountBalances", arguments: tuple)) {
                let failure = $0 as? CitizenSdkFlutterCodec.ContractFailure
                XCTAssertEqual(failure?.session, "session")
                XCTAssertEqual(failure?.sequence, 8)
            }
        }
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "getGenesisHash", arguments: [2, "session", 7, "extra"]))
    }

    func testOpenCarriesExactModuleSelectionAndRejectsOldShape() throws {
        for raw in [1, 2, 4, 12, 20, 31, 32, 63] {
            let request = try CitizenSdkFlutterCodec.decode(method: "open", arguments: [2, raw, false])
            guard case let .open(modules) = request else { return XCTFail("expected open") }
            XCTAssertEqual(modules.rawValue, UInt32(raw))
        }
        let invalid: [[Any?]] = [[1, 31, false], [2], [2, 31], [2, true, false], [2, 1.0, false], [2, -1, false], [2, 4_294_967_296, false], [2, 31, 0]]
        for tuple in invalid {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "open", arguments: tuple))
        }
        // 位依赖检查归 Rust；传输层不得另写一套规则或吞掉未知位。
        guard case let .open(modules) = try CitizenSdkFlutterCodec.decode(method: "open", arguments: [2, 32, false]) else {
            return XCTFail("expected unchanged module value")
        }
        XCTAssertEqual(modules.rawValue, 32)
    }

    func testVerifyHasExactPublicSignatureAndAllowsEmptyMessage() throws {
        let account = "0x" + String(repeating: "11", count: 32)
        let prefix: [Any?] = [2, account]
        let payload = FlutterStandardTypedData(bytes: Data())
        for length in [0, 63, 65] {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "verifySignature",
                arguments: prefix + [FlutterStandardTypedData(bytes: Data(repeating: 0, count: length)), payload]))
        }
        let request = try CitizenSdkFlutterCodec.decode(method: "verifySignature",
            arguments: prefix + [FlutterStandardTypedData(bytes: Data(repeating: 0, count: 64)), payload])
        guard case let .verify(_, signature, message) = request else { return XCTFail("expected verify") }
        XCTAssertNil(request.sessionID)
        XCTAssertNil(request.sequence)
        XCTAssertEqual(signature.count, 64)
        XCTAssertTrue(message.isEmpty)
    }

    func testVerifyRejectsSessionShapeAndMalformedPublicValuesWithoutSessionIdentity() {
        let account = "0x" + String(repeating: "11", count: 32)
        let signature = FlutterStandardTypedData(bytes: Data(repeating: 0, count: 64))
        let payload = FlutterStandardTypedData(bytes: Data())
        let invalid: [[Any?]] = [
            [2, "session", 7, account, signature, payload],
            [true, account, signature, payload],
            [2, "0X" + String(repeating: "11", count: 32), signature, payload],
            [2, account, Data(repeating: 0, count: 64), payload],
            [2, account, signature, [1, 2]],
            [2, account, signature, payload, "extra"],
        ]
        for tuple in invalid {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "verifySignature", arguments: tuple)) { error in
                guard let failure = error as? CitizenSdkFlutterCodec.ContractFailure else {
                    return XCTFail("expected contract failure")
                }
                XCTAssertNil(failure.session)
                XCTAssertNil(failure.sequence)
            }
        }
    }

    func testHistoryInvalidationHasNoPayload() throws {
        XCTAssertEqual(try CitizenSdkFlutterCodec.event(session: "session", sequence: 7, type: "walletChanged", payload: [])[3] as? String, "walletChanged")
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.event(session: "session", sequence: 7, type: "walletChanged", payload: [1]))
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.event(session: "session", sequence: 0, type: "walletChanged", payload: []))
        let event = try CitizenSdkFlutterCodec.event(session: "session", sequence: 7, type: "historyChanged", payload: [])
        XCTAssertEqual(event[3] as? String, "historyChanged")
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.event(session: "session", sequence: 7, type: "historyChanged", payload: [1]))
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.event(session: "session", sequence: 0, type: "historyChanged", payload: []))
    }
    func testWalletWordCountsAreExactlyTwelveEighteenTwentyFour() throws {
        for count in [12, 18, 24] {
            let request = try CitizenSdkFlutterCodec.decode(method: "prepareWalletCreation", arguments: [2, "session", 1, count, ""])
            guard case let .walletInput(_, _, _, _, _, actual, _) = request else { return XCTFail("expected prepare request") }
            XCTAssertEqual(actual, UInt32(count))
        }
        for count in [0, 15, 21, 30] {
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: "prepareWalletCreation", arguments: [2, "session", 1, count, ""]))
        }
    }

    func testEveryV2MethodHasOneExactPositionalShape() throws {
        XCTAssertEqual(CitizenSdkFlutterCodec.methodChannel, "citizen/sdk/core/v2")
        XCTAssertEqual(CitizenSdkFlutterCodec.eventChannel, "citizen/sdk/events/v2")
        XCTAssertEqual(CitizenSdkFlutterCodec.version, 2)
        let exactMethods: Set<String> = [
            "open",
            "start",
            "stop",
            "close",
            "getCapabilities",
            "getFinalizedHead",
            "getSyncStatus",
            "getBestHead",
            "getFinalizedBlockAt",
            "resolveFinalizedBlock",
            "getBlockHeader",
            "getBlockBody",
            "getRuntimeContext",
            "getStorage",
            "getStorageBatch",
            "getStorageKeysPaged",
            "callRuntimeApi",
            "getSystemEvents",
            "exportState",
            "importState",
            "getGenesisHash",
            "getAccountBalance",
            "getAccountBalances",
            "getAccountNonce",
            "getFeeSnapshot",
            "getWalletState",
            "inspectWallets",
            "releaseWalletInspection",
            "repairHotWallet",
            "renameDiagnosticWallet",
            "deleteDiagnosticWallet",
            "validateWalletPassword",
            "validateWalletMnemonic",
            "walletWordSuggestions",
            "prepareWalletCreation",
            "copyRecoveryPhrase",
            "commitWalletCreation",
            "releasePreparedWallet",
            "openPrivateKey",
            "revealPrivateKey",
            "closePrivateKey",
            "cancelOperation",
            "respondCredential",
            "cancelCredential",
            "addNextWalletAccount",
            "signAndDeleteWallet",
            "importColdAccountCode",
            "importColdAccountId",
            "importColdAccountSs58",
            "reorderWalletAccountsWithoutDefaultChange",
            "setActiveWallet",
            "renameWallet",
            "renameAccount",
            "deleteAccount",
            "importWallet",
            "addWalletAccounts",
            "setActiveWalletAccount",
            "deleteWallet",
            "reconcileWalletCleanup",
            "signWalletPayload",
            "beginSigning",
            "consumeExternalSignature",
            "cancelSigning",
            "beginDefaultAccountChange",
            "consumeDefaultAccountChange",
            "verifySignature",
            "encodeSigningPayload",
            "qrEncodeDocument",
            "qrPrepareAccountAuthorization",
            "prepareTransaction",
            "cancelPreparedTransaction",
            "executePreparedTransaction",
            "consumePreparedTransactionQrResponse",
            "cancelPreparedTransactionExecution",
            "getTransactionHistory",
            "syncTransactionHistory",
            "qrParse",
            "qrCreateSignRequest",
            "qrValidateSignResponse",
            "qrConsumeSignResponse",
            "qrCancelSignRequest",
            "qrEncodeAccountId",
            "qrDecodeLuminance",
            "qrEncode",
            "reviewQrRequest",
            "releaseQrReview",
            "openQrCapture",
            "closeQrCapture",
            "pauseQrCapture",
            "resumeQrCapture",
            "setQrCaptureTorch",
            "qrDecodeImage",
            "signQrRequest",
        ]
        XCTAssertEqual(CitizenSdkFlutterCodec.methods, exactMethods)

        let version = NSNumber(value: 2)
        let sequence = NSNumber(value: 1)
        let account = "0x" + String(repeating: "11", count: 32)
        let destination = "0x" + String(repeating: "22", count: 32)
        var requests: [String: [Any?]] = ["open": [version, NSNumber(value: 63), false]]
        for method in [
            "start", "stop", "close", "getCapabilities", "getFinalizedHead", "getSyncStatus",
            "getBestHead", "exportState", "getGenesisHash",
            "getFeeSnapshot", "getWalletState", "inspectWallets", "deleteWallet", "signAndDeleteWallet",
            "reconcileWalletCleanup",
        ] { requests[method] = [version, "session-1", sequence] }
        let finalizedBlock: [Any?] = [account, "1", "finalized"]
        requests["getFinalizedBlockAt"] = [version, "session-1", sequence, "1"]
        requests["resolveFinalizedBlock"] = [version, "session-1", sequence, account, "1"]
        for method in ["getBlockHeader", "getBlockBody", "getRuntimeContext", "getSystemEvents"] {
            requests[method] = [version, "session-1", sequence, finalizedBlock]
        }
        requests["getStorage"] = [version, "session-1", sequence, finalizedBlock,
                                  FlutterStandardTypedData(bytes: Data([1]))]
        requests["getStorageBatch"] = [version, "session-1", sequence, finalizedBlock, [
            FlutterStandardTypedData(bytes: Data([1])), FlutterStandardTypedData(bytes: Data([2])),
        ]]
        requests["getStorageKeysPaged"] = [version, "session-1", sequence, finalizedBlock,
            FlutterStandardTypedData(bytes: Data([1])), nil, NSNumber(value: 1000)]
        requests["callRuntimeApi"] = [version, "session-1", sequence, finalizedBlock,
            "CitizenApi_items", FlutterStandardTypedData(bytes: Data())]
        requests["importState"] = [version, "session-1", sequence, NSNumber(value: 1), finalizedBlock,
                                   FlutterStandardTypedData(bytes: Data([1]))]
        for method in [
            "getAccountBalance", "getAccountNonce", "openPrivateKey", "setActiveWalletAccount",
            "deleteAccount",
        ] { requests[method] = [version, "session-1", sequence, account] }
        requests["getAccountBalances"] = [version, "session-1", sequence, [account, account]]
        requests["prepareWalletCreation"] = [version, "session-1", sequence, NSNumber(value: 24), ""]
        requests["addWalletAccounts"] = [version, "session-1", sequence, "synthetic", "",
                                          [NSNumber(value: 1), NSNumber(value: 7)]]
        requests["renameAccount"] = [version, "session-1", sequence, account, "main"]
        requests["importColdAccountId"] = [version, "session-1", sequence, account, "cold"]
        requests["importColdAccountSs58"] = [version, "session-1", sequence,
            "w5CZACAABUbK4jspzPB5be9trhtSgRCRZFafGe7kvFPvxq8M2", "cold"]
        requests["reorderWalletAccountsWithoutDefaultChange"] = [version, "session-1", sequence,
            "7", [account, destination]]
        requests["signWalletPayload"] = [version, "session-1", sequence, account,
                                          FlutterStandardTypedData(bytes: Data([1]))]
        requests["beginSigning"] = [version, "session-1", sequence, account,
            FlutterStandardTypedData(bytes: Data([1])), "raw",
            FlutterStandardTypedData(bytes: Data()), "none", NSNumber(value: 0), NSNumber(value: 120)]
        requests["consumeExternalSignature"] = [version, "session-1", sequence, "signing-session", "{}"]
        requests["cancelSigning"] = [version, "session-1", sequence, "signing-session"]
        requests["beginDefaultAccountChange"] = [version, "session-1", sequence,
            "7", [destination, account], NSNumber(value: 120)]
        requests["consumeDefaultAccountChange"] = [version, "session-1", sequence, "signing-session", "{}"]
        requests["verifySignature"] = [version, account,
                                        FlutterStandardTypedData(bytes: Data(repeating: 0, count: 64)),
                                        FlutterStandardTypedData(bytes: Data())]
        requests["prepareTransaction"] = [version, "session-1", sequence, account,
            FlutterStandardTypedData(bytes: Data([1, 2]))]
        requests["cancelPreparedTransaction"] = [version, "session-1", sequence,
            "0x00112233445566778899aabbccddeeff"]
        requests["executePreparedTransaction"] = [version, "session-1", sequence,
            "0x00112233445566778899aabbccddeeff"]
        requests["consumePreparedTransactionQrResponse"] = [version, "session-1", sequence,
            "0x112233445566778899aabbccddeeff00", ["QR", "_V", "2"].joined()]
        requests["cancelPreparedTransactionExecution"] = [version, "session-1", sequence,
            "0x112233445566778899aabbccddeeff00"]
        requests["getTransactionHistory"] = [version, "session-1", sequence, nil, NSNumber(value: 100)]
        requests["syncTransactionHistory"] = [version, "session-1", sequence]
        requests["qrParse"] = [version, "session-1", sequence, "{}"]
        requests["qrCreateSignRequest"] = [version, "session-1", sequence, NSNumber(value: 0x0400),
            account, FlutterStandardTypedData(bytes: Data([4, 0])), NSNumber(value: 120)]
        requests["signQrRequest"] = [version, "session-1", sequence, "owned"]
        requests["qrConsumeSignResponse"] = [version, "session-1", sequence, "{}"]
        requests["qrCancelSignRequest"] = [version, "session-1", sequence, "abcdefghijklmnop"]
        requests["qrEncodeAccountId"] = [version, "session-1", sequence, account]
        requests["qrDecodeLuminance"] = [version, "session-1", sequence,
            FlutterStandardTypedData(bytes: Data([0])), NSNumber(value: 1), NSNumber(value: 1), NSNumber(value: 1)]
        requests["qrEncode"] = [version, "session-1", sequence, "{}", NSNumber(value: 4)]

        requests["validateWalletPassword"] = [version, "session-1", sequence, ""]
        requests["validateWalletMnemonic"] = [version, "session-1", sequence, "synthetic", 18]
        requests["walletWordSuggestions"] = [version, "session-1", sequence, "ab"]
        for method in ["copyRecoveryPhrase", "commitWalletCreation", "releasePreparedWallet", "revealPrivateKey",
                       "closePrivateKey", "releaseQrReview", "closeQrCapture", "pauseQrCapture", "resumeQrCapture", "releaseWalletInspection"] {
            requests[method] = [version, "session-1", sequence, "owned"]
        }
        requests["cancelOperation"] = [version, "session-1", sequence, "1"]
        requests["respondCredential"] = [version, "session-1", sequence, "1", nil]
        requests["cancelCredential"] = [version, "session-1", sequence, "1"]
        for method in ["importWallet", "addNextWalletAccount"] { requests[method] = [version, "session-1", sequence, "synthetic", ""] }
        requests["importColdAccountCode"] = [version, "session-1", sequence, "{}", ""]
        requests["setActiveWallet"] = [version, "session-1", sequence, "7", 0]
        requests["renameWallet"] = [version, "session-1", sequence, "7", 0, "名字"]
        for method in ["repairHotWallet", "deleteDiagnosticWallet"] { requests[method] = [version, "session-1", sequence, "owned", 0] }
        requests["renameDiagnosticWallet"] = [version, "session-1", sequence, "owned", 0, "名字"]
        requests["qrEncodeDocument"] = [version, "session-1", sequence, "{}"]
        requests["qrPrepareAccountAuthorization"] = [version, "session-1", sequence, 10, FlutterStandardTypedData(bytes: Data()), ""]
        requests["encodeSigningPayload"] = [version, 2, "{\"op_tag\":16}", FlutterStandardTypedData(bytes: Data())]
        requests["qrValidateSignResponse"] = [version, "session-1", sequence, "request", "{}"]
        requests["reviewQrRequest"] = [version, "session-1", sequence, "{}"]
        requests["openQrCapture"] = [version, "session-1", sequence, 1]
        requests["setQrCaptureTorch"] = [version, "session-1", sequence, "owned", true]
        requests["qrDecodeImage"] = [version, "session-1", sequence, FlutterStandardTypedData(bytes: Data([1])), 1]

        XCTAssertEqual(Set(requests.keys), exactMethods)
        for (method, tuple) in requests {
            // 全闭集同时穿过官方编解码，覆盖NSNull/NSNumber/TypedData的实际边界。
            let wire = FlutterStandardMethodCodec.sharedInstance()
            let decoded = wire.decodeMethodCall(wire.encode(
                FlutterMethodCall(methodName: method, arguments: tuple)))
            XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(method: method, arguments: decoded.arguments), method)
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(
                method: method, arguments: tuple + ["forbidden-extra-position"]
            ), method)
        }
    }

    func testInspectionFactsAndOwnedRequestsDoNotConstructNormalAccounts() throws {
        let id = Data(repeating: 1, count: 32)
        let diagnostic = CitizenWalletDiagnostic(walletIndex: 0, walletName: "异常", accountID: id,
            ss58Address: nil, diagnosticReason: 3, signMode: .hot,
            cleanupTargets: CitizenWalletCleanupTargets(accountIDs: [id, Data(repeating: 2, count: 32)], deleteWalletWideKey: true))
        let state = CitizenWalletState(revision: 7, hotProfile: nil, accounts: [], initializationState: 1,
            cleanupPending: false, activeWalletIndex: 0, diagnostics: [diagnostic])
        let tuple = CitizenSdkFlutterCodec.walletState(state)
        XCTAssertEqual(tuple.count, 7)
        let records = try XCTUnwrap(tuple[6] as? [[Any?]])
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records.first?.count, 7)
        XCTAssertEqual(records.first?[5] as? String, "hot")
        XCTAssertNil(records.first?[3])
        for method in ["repairHotWallet", "deleteDiagnosticWallet", "renameDiagnosticWallet"] {
            let fields: [Any?] = [2, "sdk", 1, "inspection-owned", Int64(UInt32.max)] +
                (method == "renameDiagnosticWallet" ? ["名字"] : [])
            let request = try CitizenSdkFlutterCodec.decode(method: method, arguments: fields)
            guard case let .walletInspection(actual, _, _, resource, index, _) = request else { return XCTFail("检查引用") }
            XCTAssertEqual(actual, method); XCTAssertEqual(resource, "inspection-owned"); XCTAssertEqual(index, UInt32.max)
            XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method: method, arguments: fields + [true]))
        }
    }

    func testWalletStateProjectionKeepsColdModeGlobalOrderAndDefaultFirst() {
        let cold = CitizenWalletStateAccount(signMode: .cold, walletIndex: 1, accountIndex: nil,
            accountID: Data(repeating: 0x22, count: 32),
            ss58Address: "w5CZACAABUbK4jspzPB5be9trhtSgRCRZFafGe7kvFPvxq8M2",
            name: "cold", createdAtMillis: 2, isDefault: true)
        let tuple = CitizenSdkFlutterCodec.walletState(
            CitizenWalletState(revision: 7, hotProfile: nil, accounts: [cold], initializationState: 1, cleanupPending: false, activeWalletIndex: 1))
        XCTAssertEqual(tuple[0] as? String, "7")
        XCTAssertNil(tuple[1])
        let accounts = tuple[2] as? [[Any?]]
        XCTAssertEqual(accounts?.first?[0] as? String, "cold")
        XCTAssertEqual(accounts?.first?[1] as? Int64, 1)
        XCTAssertNil(accounts?.first?[2])
        XCTAssertEqual(accounts?.first?[7] as? Bool, true)
    }

    func testHashDecoderRejectsUppercaseAndPreservesCorrelation() {
        let uppercase = "0x" + String(repeating: "AA", count: 32)
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(
            method: "getAccountBalance",
            arguments: [NSNumber(value: 2), "session-a", NSNumber(value: 7), uppercase]
        )) { error in
            guard let failure = error as? CitizenSdkFlutterCodec.ContractFailure else {
                return XCTFail("expected correlated contract failure")
            }
            XCTAssertEqual(failure.code, .invalidArgument)
            XCTAssertEqual(failure.session, "session-a")
            XCTAssertEqual(failure.sequence, 7)
        }
    }

    func testSigningBytesRejectNonUInt8TypedData() throws {
        let account = "0x" + String(repeating: "11", count: 32)
        let prefix: [Any?] = [NSNumber(value: 2), "session", NSNumber(value: 1), account]
        XCTAssertNoThrow(try CitizenSdkFlutterCodec.decode(
            method: "signWalletPayload",
            arguments: prefix + [FlutterStandardTypedData(bytes: Data([1, 2, 3, 4]))]
        ))
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(
            method: "signWalletPayload",
            arguments: prefix + [FlutterStandardTypedData(int32: Data([1, 0, 0, 0]))]
        ))
    }

    func testHistoryCursorFailurePreservesSessionAndSequence() {
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(
            method: "getTransactionHistory",
            arguments: [NSNumber(value: 2), "session-b", NSNumber(value: 8),
                        "0X00112233445566778899aabbccddeeff", NSNumber(value: 100)]
        )) { error in
            let failure = error as? CitizenSdkFlutterCodec.ContractFailure
            XCTAssertEqual(failure?.session, "session-b")
            XCTAssertEqual(failure?.sequence, 8)
            XCTAssertEqual(failure?.code, .invalidArgument)
        }
    }

    func testSessionUsesExactUtf16BoundaryWithoutNormalization() throws {
        let version = NSNumber(value: 2)
        let sequence = NSNumber(value: 1)
        let allowed = String(repeating: "😀", count: 64)
        let request = try CitizenSdkFlutterCodec.decode(
            method: "start", arguments: [version, allowed, sequence]
        )
        XCTAssertEqual(request.sessionID, allowed)
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(
            method: "start",
            arguments: [version, String(repeating: "😀", count: 65), sequence]
        ))

        let decomposed = String(repeating: "e\u{301}", count: 64)
        XCTAssertEqual(decomposed.utf16.count, 128)
        XCTAssertEqual(try CitizenSdkFlutterCodec.decode(
            method: "start", arguments: [version, decomposed, sequence]
        ).sessionID, decomposed)
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(
            method: "start", arguments: [NSNumber(value: 1.0), "session", sequence]
        ))
    }

    func testTransactionHistoryProjectionContainsOnlyGenericExecutionFields() throws {
        let executionID = "0x00112233445566778899aabbccddeeff"
        let record = CitizenTransactionHistoryRecord(
            executionID: executionID,
            sourceAccountID: Data(repeating: 3, count: 32),
            callDataHash: Data(repeating: 4, count: 32),
            transactionHash: Data(repeating: 5, count: 32),
            status: .pending, block: nil, execution: nil, replacementHash: nil,
            createdAtMillis: 1, updatedAtMillis: 1, poolRejectionReason: nil)
        let page = CitizenTransactionHistoryPage(
            revision: 1, records: [record], nextBeforeExecutionID: executionID)
        let tuple = try CitizenSdkFlutterCodec.transactionHistoryPage(page)
        XCTAssertEqual(tuple[0] as? String, "1")
        XCTAssertEqual(tuple[2] as? String, executionID)
        XCTAssertEqual((tuple[1] as? [[Any?]])?.first?.count, 11)
    }

    func testEventVocabularyIsClosed() throws {
        XCTAssertEqual(CitizenSdkFlutterCodec.eventTypes,
                       ["lifecycleChanged", "capabilitiesChanged", "historyChanged", "walletChanged",
                        "finalizedBlockChanged", "qrCaptureResult", "qrCaptureError", "qrCapturePreview", "qrCaptureClosed", "privateKeyClosed"])
        XCTAssertNoThrow(try CitizenSdkFlutterCodec.event(
            session: "s", sequence: 1, type: "lifecycleChanged", payload: ["running"]
        ))
        XCTAssertThrowsError(try CitizenSdkFlutterCodec.event(
            session: "s", sequence: 2, type: "debug", payload: []
        ))
    }
}
