import CitizenSDK
import CoreFoundation
import Foundation

#if os(iOS)
import Flutter
#elseif os(macOS)
import FlutterMacOS
#endif

/// Fixed-position StandardMessageCodec contract shared with Android and Dart.
internal enum CitizenSdkFlutterCodec {
    static let methodChannel = "citizen/sdk/core/v2"
    static let eventChannel = "citizen/sdk/events/v2"
    static let version: Int64 = 2
    static let eventTypes: Set<String> = [
        "lifecycleChanged", "capabilitiesChanged", "historyChanged", "walletChanged", "finalizedBlockChanged",
        "qrCaptureResult", "qrCaptureError", "qrCapturePreview", "qrCaptureClosed", "privateKeyClosed",
    ]
    static let methods: Set<String> = [
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
        "deriveApplicationKey",
        "deriveApplicationKeys",
        "prepareApplicationKeys",
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

    enum Request {
        case open(modules: CitizenSDKModules)
        case encodePayload(kind: UInt32, fieldsJSON: String, payload: Data)
        case empty(method: String, session: String, sequence: Int64)
        case account(method: String, session: String, sequence: Int64, accountID: Data)
        case balances(session: String, sequence: Int64, accountIDs: [Data])
        case blockNumber(session: String, sequence: Int64, number: UInt64)
        case resolveBlock(session: String, sequence: Int64, hash: Data, number: UInt64)
        case block(method: String, session: String, sequence: Int64, block: CitizenBlockRef)
        case storage(session: String, sequence: Int64, block: CitizenBlockRef, key: Data)
        case storageBatch(session: String, sequence: Int64, block: CitizenBlockRef, keys: [Data])
        case storageKeysPage(session: String, sequence: Int64, block: CitizenBlockRef,
                             prefix: Data, startKey: Data?, limit: UInt32)
        case runtimeAPI(session: String, sequence: Int64, block: CitizenBlockRef,
                        method: String, arguments: Data)
        case importState(session: String, sequence: Int64, state: CitizenChainState)
        case walletInput(method: String, session: String, sequence: Int64,
                         text: String, password: String, wordCount: UInt32, indices: [UInt32])
        case resource(method: String, session: String, sequence: Int64, id: String)
        case coldCode(session: String, sequence: Int64, code: String, name: String)
        case walletInspection(method: String, session: String, sequence: Int64, id: String, walletIndex: UInt32, name: String?)
        case walletMetadata(method: String, session: String, sequence: Int64, revision: UInt64, walletIndex: UInt32, name: String?)
        case rename(method: String, session: String, sequence: Int64, accountID: Data, name: String)
        case coldSS58(session: String, sequence: Int64, address: String, name: String)
        case reorder(session: String, sequence: Int64, expectedRevision: UInt64, accountIDs: [Data])
        case sign(session: String, sequence: Int64, accountID: Data, payload: Data)
        case deriveApplicationKey(session: String, sequence: Int64, accountID: Data,
                                  salt: Data, info: Data)
        case deriveApplicationKeys(session: String, sequence: Int64, accountID: Data,
                                   salt: Data, infos: [Data])
        case prepareApplicationKeys(session: String, sequence: Int64, accountID: Data,
                                    salt: Data, infos: [Data], message: Data)
        case beginSigning(session: String, sequence: Int64, intent: CitizenSigningIntent)
        case externalSignature(method: String, session: String, sequence: Int64,
                               signingSessionID: String, response: String)
        case cancelSigning(session: String, sequence: Int64, signingSessionID: String)
        case beginDefaultChange(session: String, sequence: Int64, expectedRevision: UInt64,
                                accountIDs: [Data], ttlSeconds: UInt64)
        case verify(accountID: Data, signature: Data, payload: Data)
        case prepareTransaction(session: String, sequence: Int64, source: Data, callData: Data)
        case cancelPreparedTransaction(session: String, sequence: Int64, preparationID: String)
        case transactionExecution(method: String, session: String, sequence: Int64,
                                  executionID: String, response: String?)
        case transactionHistory(method: String, session: String, sequence: Int64,
                                beforeExecutionID: String?, limit: UInt32)
        case qr(method: String, session: String, sequence: Int64, fields: [Any])

        var sessionID: String? {
            switch self {
            case .open, .verify, .encodePayload: return nil
            case let .walletInspection(_, value, _, _, _, _), let .walletMetadata(_, value, _, _, _, _), let .empty(_, value, _), let .account(_, value, _, _), let .walletInput(_, value, _, _, _, _, _),
                 let .resource(_, value, _, _), let .coldCode(value, _, _, _), let .rename(_, value, _, _, _), let .coldSS58(value, _, _, _),
                 let .reorder(value, _, _, _), let .sign(value, _, _, _),
                 let .beginSigning(value, _, _), let .externalSignature(_, value, _, _, _),
                 let .cancelSigning(value, _, _), let .beginDefaultChange(value, _, _, _, _),
                 let .balances(value, _, _),
                 let .prepareTransaction(value, _, _, _), let .cancelPreparedTransaction(value, _, _),
                 let .transactionExecution(_, value, _, _, _),
                 let .transactionHistory(_, value, _, _, _),
                 let .qr(_, value, _, _), let .blockNumber(value, _, _),
                 let .resolveBlock(value, _, _, _), let .block(_, value, _, _),
                 let .storage(value, _, _, _), let .storageBatch(value, _, _, _),
                 let .storageKeysPage(value, _, _, _, _, _),
                 let .runtimeAPI(value, _, _, _, _),
                 let .deriveApplicationKey(value, _, _, _, _),
                 let .deriveApplicationKeys(value, _, _, _, _),
                 let .prepareApplicationKeys(value, _, _, _, _, _),
                 let .importState(value, _, _): return value
            }
        }
        var sequence: Int64? {
            switch self {
            case .open, .verify, .encodePayload: return nil
            case let .walletInspection(_, _, value, _, _, _), let .walletMetadata(_, _, value, _, _, _), let .empty(_, _, value), let .account(_, _, value, _), let .walletInput(_, _, value, _, _, _, _),
                 let .resource(_, _, value, _), let .coldCode(_, value, _, _), let .rename(_, _, value, _, _), let .coldSS58(_, value, _, _),
                 let .reorder(_, value, _, _), let .sign(_, value, _, _),
                 let .beginSigning(_, value, _), let .externalSignature(_, _, value, _, _),
                 let .cancelSigning(_, value, _), let .beginDefaultChange(_, value, _, _, _),
                 let .balances(_, value, _),
                 let .prepareTransaction(_, value, _, _), let .cancelPreparedTransaction(_, value, _),
                 let .transactionExecution(_, _, value, _, _),
                 let .transactionHistory(_, _, value, _, _),
                 let .qr(_, _, value, _), let .blockNumber(_, value, _),
                 let .resolveBlock(_, value, _, _), let .block(_, _, value, _),
                 let .storage(_, value, _, _), let .storageBatch(_, value, _, _),
                 let .storageKeysPage(_, value, _, _, _, _),
                 let .runtimeAPI(_, value, _, _, _),
                 let .deriveApplicationKey(_, value, _, _, _),
                 let .deriveApplicationKeys(_, value, _, _, _),
                 let .prepareApplicationKeys(_, value, _, _, _, _),
                 let .importState(_, value, _): return value
            }
        }
        var method: String {
            switch self {
            case .open: return "open"
            case .verify: return "verifySignature"
            case .encodePayload: return "encodeSigningPayload"
            case let .empty(method, _, _), let .account(method, _, _, _),
                 let .block(method, _, _, _), let .rename(method, _, _, _, _),
                 let .externalSignature(method, _, _, _, _),
                 let .transactionExecution(method, _, _, _, _),
                 let .transactionHistory(method, _, _, _, _), let .qr(method, _, _, _): return method
            case .balances: return "getAccountBalances"
            case .blockNumber: return "getFinalizedBlockAt"
            case .resolveBlock: return "resolveFinalizedBlock"
            case .storage: return "getStorage"
            case .storageBatch: return "getStorageBatch"
            case .storageKeysPage: return "getStorageKeysPaged"
            case .runtimeAPI: return "callRuntimeApi"
            case .importState: return "importState"
            case let .walletInspection(method, _, _, _, _, _), let .walletMetadata(method, _, _, _, _, _), let .walletInput(method, _, _, _, _, _, _), let .resource(method, _, _, _): return method
            case .coldCode: return "importColdAccountCode"
            case .coldSS58: return "importColdAccountSs58"
            case .reorder: return "reorderWalletAccountsWithoutDefaultChange"
            case .sign: return "signWalletPayload"
            case .deriveApplicationKey: return "deriveApplicationKey"
            case .deriveApplicationKeys: return "deriveApplicationKeys"
            case .prepareApplicationKeys: return "prepareApplicationKeys"
            case .beginSigning: return "beginSigning"
            case .cancelSigning: return "cancelSigning"
            case .beginDefaultChange: return "beginDefaultAccountChange"
            case .prepareTransaction: return "prepareTransaction"
            case .cancelPreparedTransaction: return "cancelPreparedTransaction"
            }
        }
    }

    struct ContractFailure: Error {
        let code: CitizenSDKErrorCode
        let message: String
        let session: String?
        let sequence: Int64?
        let stage: CitizenSDKFailureStage

        init(code: CitizenSDKErrorCode, message: String, session: String? = nil,
             sequence: Int64? = nil, stage: CitizenSDKFailureStage? = nil) {
            self.code = code
            self.message = message
            self.session = session
            self.sequence = sequence
            self.stage = stage ?? .defaultStage(for: code)
        }
    }

    /// 只读取外壳；无会话方法不接纳，必填字段仍严格校验，不解业务参数。
    static func envelope(method: String, arguments: Any?) throws -> Request? {
        if ["open", "verifySignature", "encodeSigningPayload"].contains(method) { return nil }
        guard let tuple = arguments as? [Any?], tuple.count >= 3,
              try integer(tuple[0], "protocolVersion") == version else {
            throw failure(.invalidArgument, "Invalid request envelope")
        }
        let session = try string(tuple[1], "sessionId", 1...128)
        let sequence = try integer(tuple[2], "requestSequence")
        guard sequence > 0 else { throw failure(.invalidArgument, "requestSequence must be positive", session, sequence) }
        return .empty(method: method, session: session, sequence: sequence)
    }

    static func decode(method: String, arguments: Any?) throws -> Request {
        guard methods.contains(method) else { throw failure(.unsupported, "Unsupported method") }
        guard let rawTuple = arguments as? [Any?] else { throw failure(.invalidArgument, "Arguments must be a tuple") }
        // StandardMessageCodec以NSNull承载数组空值；统一投影为nil，必填字段随后仍拒绝。
        let tuple: [Any?] = rawTuple.map { $0 is NSNull ? nil : $0 }
        guard !tuple.isEmpty, try integer(tuple[0], "protocolVersion") == version else {
            throw failure(.unsupported, "Unsupported protocol version")
        }
        if method == "open" {
            guard tuple.count == 3 else { throw failure(.invalidArgument, "Unexpected open arguments") }
            guard let presence = tuple[2] as? NSNumber, CFGetTypeID(presence) == CFBooleanGetTypeID() else {
                throw failure(.invalidArgument, "credential provider presence must be boolean")
            }
            let modules = try integer(tuple[1], "modules")
            guard modules >= 0, modules <= Int64(UInt32.max) else {
                throw failure(.invalidArgument, "modules must be uint32")
            }
            return .open(modules: CitizenSDKModules(rawValue: UInt32(modules)))
        }
        if method == "encodeSigningPayload" {
            guard tuple.count == 4 else { throw failure(.invalidArgument, "Invalid payload tuple length") }
            let kind = try integer(tuple[1], "payloadKind")
            guard (1...6).contains(kind) else { throw failure(.invalidArgument, "Invalid payload kind") }
            return .encodePayload(kind: UInt32(kind), fieldsJSON: try string(tuple[2], "payload fields", 2...4096),
                                  payload: try bytes(tuple[3], maximum: 16 * 1024 * 1024))
        }
        if method == "verifySignature" {
            // 公开验签没有会话或序号；必须先拒绝旧会话形状，不能误读账户为会话。
            guard tuple.count == 4 else { throw failure(.invalidArgument, "Invalid verification tuple length") }
            let signature = try bytes(tuple[2], maximum: 64)
            guard signature.count == 64 else { throw failure(.invalidArgument, "signature must contain 64 bytes") }
            return .verify(accountID: try hash32(tuple[1]), signature: signature,
                           payload: try bytes(tuple[3], maximum: 16 * 1_024 * 1_024))
        }
        guard tuple.count >= 3 else { throw failure(.invalidArgument, "Truncated request") }
        let session = try string(tuple[1], "sessionId", 1...128)
        let sequence = try integer(tuple[2], "requestSequence")
        guard sequence > 0 else { throw failure(.invalidArgument, "requestSequence must be positive", session, sequence) }
        func length(_ expected: Int) throws {
            guard tuple.count == expected else { throw failure(.invalidArgument, "Invalid request tuple length", session, sequence) }
        }
        do {
            switch method {
            case "qrEncodeDocument":
                try length(4)
                return .qr(method: method, session: session, sequence: sequence, fields: [try string(tuple[3], "QR content", 1...65536)])
            case "qrPrepareAccountAuthorization":
                try length(6)
                let action = try integer(tuple[3], "action")
                guard action >= 0, action <= Int64(UInt32.max) else { throw failure(.invalidArgument, "action must be uint32") }
                return .qr(method: method, session: session, sequence: sequence, fields: [UInt32(action),
                    try bytes(tuple[4], maximum: 1920), try string(tuple[5], "accountId", 0...1024)])
            case "respondCredential", "cancelCredential":
                try length(method == "respondCredential" ? 5 : 4)
                let id = try uint64Decimal(tuple[3], "hostOperationId")
                guard id != 0 else { throw failure(.invalidArgument, "hostOperationId must be nonzero") }
                // Apple继续使用真实OS认证，不创建SDK口令窗口或虚构口令挑战。
                if method == "respondCredential", tuple[4] != nil {
                    var credential = try bytes(tuple[4], maximum: 1_024)
                    credential.resetBytes(in: 0..<credential.count)
                }
                return .resource(method: method, session: session, sequence: sequence, id: String(id))
            case "start", "stop", "close", "getCapabilities", "getFinalizedHead", "getSyncStatus",
                 "getBestHead", "exportState", "getGenesisHash", "getFeeSnapshot",
                 "getWalletState", "inspectWallets", "deleteWallet", "signAndDeleteWallet", "reconcileWalletCleanup":
                try length(3); return .empty(method: method, session: session, sequence: sequence)
            case "getFinalizedBlockAt":
                try length(4)
                return .blockNumber(session: session, sequence: sequence,
                                    number: try uint64Decimal(tuple[3], "number"))
            case "resolveFinalizedBlock":
                try length(5)
                return .resolveBlock(session: session, sequence: sequence, hash: try hash32(tuple[3]),
                                     number: try uint64Decimal(tuple[4], "number"))
            case "getBlockHeader", "getBlockBody", "getRuntimeContext", "getSystemEvents":
                try length(4)
                let value = try blockRef(tuple[3])
                guard method != "getSystemEvents" || value.finality == .finalized else {
                    throw failure(.invalidArgument, "getSystemEvents requires a finalized block")
                }
                return .block(method: method, session: session, sequence: sequence, block: value)
            case "getStorage":
                try length(5)
                let key = try bytes(tuple[4], maximum: 4 * 1_024)
                guard !key.isEmpty else { throw failure(.invalidArgument, "storage key is empty") }
                return .storage(session: session, sequence: sequence, block: try blockRef(tuple[3]), key: key)
            case "getStorageBatch":
                try length(5)
                guard let raw = tuple[4] as? [Any?], (1...1_024).contains(raw.count) else {
                    throw failure(.invalidArgument, "storage batch must contain 1...1024 keys")
                }
                let keys = try raw.map { try bytes($0, maximum: 4 * 1_024) }
                guard keys.allSatisfy({ !$0.isEmpty }), keys.reduce(0, { $0 + $1.count }) <= 1_024 * 1_024 else {
                    throw failure(.invalidArgument, "storage batch keys are invalid")
                }
                return .storageBatch(session: session, sequence: sequence,
                                     block: try blockRef(tuple[3]), keys: keys)
            case "getStorageKeysPaged":
                try length(7)
                let block = try blockRef(tuple[3])
                guard block.finality == .finalized else {
                    throw failure(.invalidArgument, "storage keys page requires finalized block")
                }
                let prefix = try bytes(tuple[4], maximum: 4 * 1_024)
                guard !prefix.isEmpty else {
                    throw failure(.invalidArgument, "storage key prefix is empty")
                }
                let start = tuple[5] == nil ? nil : try bytes(tuple[5], maximum: 4 * 1_024)
                guard start == nil || !start!.isEmpty else {
                    throw failure(.invalidArgument, "storage start key is empty")
                }
                let limit = try integer(tuple[6], "storage keys page limit")
                guard (1...1_000).contains(limit) else {
                    throw failure(.invalidArgument, "storage keys page limit must be 1...1000")
                }
                return .storageKeysPage(
                    session: session, sequence: sequence, block: block,
                    prefix: prefix, startKey: start, limit: UInt32(limit))
            case "callRuntimeApi":
                try length(6)
                let methodName = try string(tuple[4], "runtime API method", 1...128)
                guard methodName.range(
                    of: #"^[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+$"#,
                    options: .regularExpression
                ) != nil else {
                    throw failure(.invalidArgument, "runtime API method is invalid")
                }
                return .runtimeAPI(
                    session: session, sequence: sequence, block: try blockRef(tuple[3]),
                    method: methodName,
                    arguments: try bytes(tuple[5], maximum: 1_024 * 1_024))
            case "importState":
                try length(6)
                let format = try integer(tuple[3], "formatVersion"), finalized = try blockRef(tuple[4])
                let database = try bytes(tuple[5], maximum: 256 * 1_024)
                guard format > 0, format <= Int64(UInt32.max), finalized.finality == .finalized,
                      !database.isEmpty else { throw failure(.invalidArgument, "importState fields are invalid") }
                return .importState(session: session, sequence: sequence,
                    state: try CitizenChainState(formatVersion: UInt32(format), finalized: finalized,
                                                 database: database))
            case "getAccountBalance", "getAccountNonce", "setActiveWalletAccount",
                 "deleteAccount", "openPrivateKey":
                try length(4); return .account(method: method, session: session, sequence: sequence,
                                               accountID: try hash32(tuple[3]))
            case "getAccountBalances":
                try length(4)
                guard let raw = tuple[3] as? [Any?], raw.count <= 1_990 else {
                    throw failure(.invalidArgument, "accountIds must contain 0...1990 accounts")
                }
                // 批量查询必须保留顺序和重复项，不能套用历史订阅的唯一性约束。
                return .balances(session: session, sequence: sequence, accountIDs: try raw.map(hash32))
            case "validateWalletPassword", "walletWordSuggestions":
                try length(4)
                return .walletInput(method: method, session: session, sequence: sequence,
                    text: try utf8Text(tuple[3], "wallet input", 0...1024), password: "", wordCount: 0, indices: [])
            case "validateWalletMnemonic":
                try length(5)
                let words = try integer(tuple[4], "wordCount")
                guard [12, 18, 24].contains(words) else { throw failure(.invalidArgument, "word count is invalid") }
                return .walletInput(method: method, session: session, sequence: sequence,
                    text: try utf8Text(tuple[3], "mnemonic", 0...1024), password: "", wordCount: UInt32(words), indices: [])
            case "prepareWalletCreation":
                try length(5)
                let words = try integer(tuple[3], "wordCount")
                guard [12, 18, 24].contains(words) else { throw failure(.invalidArgument, "word count is invalid") }
                return .walletInput(method: method, session: session, sequence: sequence,
                    text: "", password: try utf8Text(tuple[4], "password", 0...1024), wordCount: UInt32(words), indices: [])
            case "importWallet", "addNextWalletAccount", "addWalletAccounts":
                try length(method == "addWalletAccounts" ? 6 : 5)
                var indices: [UInt32] = []
                if method == "addWalletAccounts" {
                    guard let raw = tuple[5] as? [Any?], (1...1989).contains(raw.count) else { throw failure(.invalidArgument, "indices length is invalid") }
                    let values = try raw.map { try integer($0, "index") }
                    guard values.allSatisfy({ (1...1989).contains($0) }), Set(values).count == values.count else {
                        throw failure(.invalidArgument, "indices must be unique within 1...1989")
                    }
                    indices = values.map { UInt32($0) }
                }
                return .walletInput(method: method, session: session, sequence: sequence,
                    text: try utf8Text(tuple[3], "mnemonic", 0...1024), password: try utf8Text(tuple[4], "password", 0...1024),
                    wordCount: 0, indices: indices)
            case "copyRecoveryPhrase", "commitWalletCreation", "releasePreparedWallet", "revealPrivateKey",
                 "closePrivateKey", "cancelOperation", "signQrRequest", "releaseQrReview", "releaseWalletInspection",
                 "closeQrCapture", "pauseQrCapture", "resumeQrCapture":
                try length(4)
                let id = try resourceID(tuple[3])
                if method == "cancelOperation" {
                    guard id.first != "0", id.utf8.allSatisfy({ (48...57).contains($0) }), Int64(id) != nil else {
                        throw failure(.invalidArgument, "operation ID is invalid")
                    }
                }
                return .resource(method: method, session: session, sequence: sequence, id: id)
            case "importColdAccountCode":
                try length(5)
                return .coldCode(session: session, sequence: sequence, code: try qrText(tuple[3], "account code"),
                    name: try accountName(tuple[4], allowEmpty: true))
            case "repairHotWallet", "renameDiagnosticWallet", "deleteDiagnosticWallet":
                try length(method == "renameDiagnosticWallet" ? 6 : 5)
                let id = try resourceID(tuple[3])
                let index = try integer(tuple[4], "walletIndex")
                guard index >= 0, index <= Int64(UInt32.max) else { throw failure(.invalidArgument, "walletIndex must be uint32") }
                let name = method == "renameDiagnosticWallet" ? try accountName(tuple[5], allowEmpty: false) : nil
                return .walletInspection(method: method, session: session, sequence: sequence,
                    id: id, walletIndex: UInt32(index), name: name)
            case "setActiveWallet", "renameWallet":
                try length(method == "renameWallet" ? 6 : 5)
                let revision = try uint64Decimal(tuple[3], "expectedRevision")
                let index = try integer(tuple[4], "walletIndex")
                guard index >= 0, index <= Int64(UInt32.max) else { throw failure(.invalidArgument, "walletIndex must be uint32") }
                let name = method == "renameWallet" ? try accountName(tuple[5], allowEmpty: false) : nil
                return .walletMetadata(method: method, session: session, sequence: sequence,
                    revision: revision, walletIndex: UInt32(index), name: name)
            case "renameAccount", "importColdAccountId":
                try length(5)
                return .rename(method: method, session: session, sequence: sequence, accountID: try hash32(tuple[3]),
                    name: try accountName(tuple[4], allowEmpty: method == "importColdAccountId"))
            case "importColdAccountSs58":
                try length(5)
                return .coldSS58(session: session, sequence: sequence, address: try utf8Text(tuple[3], "ss58Address", 1...64),
                    name: try accountName(tuple[4], allowEmpty: true))
            case "reorderWalletAccountsWithoutDefaultChange":
                try length(5)
                let revision = try uint64Decimal(tuple[3], "expectedRevision")
                guard let raw = tuple[4] as? [Any?], (1...3_980).contains(raw.count) else {
                    throw failure(.invalidArgument, "accountIds must contain 1...3980 accounts")
                }
                return .reorder(session: session, sequence: sequence, expectedRevision: revision,
                                accountIDs: try raw.map(hash32))
            case "signWalletPayload":
                try length(5)
                return .sign(session: session, sequence: sequence, accountID: try hash32(tuple[3]),
                             payload: try bytes(tuple[4], maximum: 16 * 1_024 * 1_024))
            case "deriveApplicationKey":
                try length(6)
                let salt = try bytes(tuple[4], maximum: 32)
                let info = try bytes(tuple[5], maximum: 256)
                guard salt.count == 32, !info.isEmpty else {
                    throw failure(.invalidArgument, "application key salt/info is invalid")
                }
                return .deriveApplicationKey(
                    session: session, sequence: sequence, accountID: try hash32(tuple[3]),
                    salt: salt, info: info)
            case "deriveApplicationKeys":
                try length(6)
                let salt = try bytes(tuple[4], maximum: 32)
                guard salt.count == 32, let rawInfos = tuple[5] as? [Any],
                      (1...16).contains(rawInfos.count) else {
                    throw failure(.invalidArgument, "application key batch is invalid")
                }
                let infos = try rawInfos.map { try bytes($0, maximum: 256) }
                guard infos.allSatisfy({ !$0.isEmpty }) else {
                    throw failure(.invalidArgument, "application key info is empty")
                }
                return .deriveApplicationKeys(
                    session: session, sequence: sequence, accountID: try hash32(tuple[3]),
                    salt: salt, infos: infos)
            case "prepareApplicationKeys":
                try length(7)
                let salt = try bytes(tuple[4], maximum: 32)
                guard salt.count == 32, let rawInfos = tuple[5] as? [Any],
                      (1...16).contains(rawInfos.count) else {
                    throw failure(.invalidArgument, "application key batch is invalid")
                }
                let infos = try rawInfos.map { try bytes($0, maximum: 256) }
                guard infos.allSatisfy({ !$0.isEmpty }) else {
                    throw failure(.invalidArgument, "application key info is empty")
                }
                let message = try bytes(tuple[6], maximum: 32)
                guard message.isEmpty || message.count == 32 else {
                    throw failure(.invalidArgument, "preparation message must be empty or 32 bytes")
                }
                return .prepareApplicationKeys(
                    session: session, sequence: sequence, accountID: try hash32(tuple[3]),
                    salt: salt, infos: infos, message: message)
            case "beginSigning":
                try length(10)
                let payload = try bytes(tuple[4], maximum: 16 * 1_024 * 1_024)
                guard !payload.isEmpty else { throw failure(.invalidArgument, "signing payload is empty") }
                let transformText = try string(tuple[5], "transform", 3...32)
                let transform: CitizenSigningTransform = switch transformText {
                case "raw": .raw
                case "substrateSigningPayload": .substrateSigningPayload
                case "blake2Domain": .blake2Domain
                default: throw failure(.invalidArgument, "Unknown signing transform")
                }
                let domain = try bytes(tuple[6], maximum: 32)
                guard (transform == .blake2Domain && !domain.isEmpty) ||
                      (transform != .blake2Domain && domain.isEmpty) else {
                    throw failure(.invalidArgument, "Invalid signing transform/domain")
                }
                let transportText = try string(tuple[7], "transport", 4...8)
                let transport: CitizenExternalSignerTransport? = switch transportText {
                case "none": nil
                case "qrV1": .qrV1
                default: throw failure(.invalidArgument, "Unknown external signer transport")
                }
                let action = try integer(tuple[8], "opaqueAction")
                let ttl = try integer(tuple[9], "ttlSeconds")
                guard action <= 65_535, (1...300).contains(ttl) else {
                    throw failure(.invalidArgument, "Invalid signing action or TTL")
                }
                return .beginSigning(
                    session: session, sequence: sequence,
                    intent: try CitizenSigningIntent(
                        accountID: hash32(tuple[3]), payload: payload, transform: transform,
                        domain: domain, externalSignerTransport: transport,
                        opaqueAction: UInt16(action), ttlSeconds: UInt64(ttl)))
            case "consumeExternalSignature", "consumeDefaultAccountChange":
                try length(5)
                return .externalSignature(
                    method: method, session: session, sequence: sequence,
                    signingSessionID: try string(tuple[3], "signingSessionID", 1...128),
                    response: try qrText(tuple[4], "response"))
            case "cancelSigning":
                try length(4)
                return .cancelSigning(
                    session: session, sequence: sequence,
                    signingSessionID: try string(tuple[3], "signingSessionID", 1...128))
            case "beginDefaultAccountChange":
                try length(6)
                let revision = try uint64Decimal(tuple[3], "expectedRevision")
                guard let raw = tuple[4] as? [Any?], (1...256).contains(raw.count) else {
                    throw failure(.invalidArgument, "accountIDs must contain 1...256 accounts")
                }
                let ttl = try integer(tuple[5], "ttlSeconds")
                guard (1...300).contains(ttl) else {
                    throw failure(.invalidArgument, "Invalid default-account TTL")
                }
                return .beginDefaultChange(
                    session: session, sequence: sequence, expectedRevision: revision,
                    accountIDs: try raw.map(hash32), ttlSeconds: UInt64(ttl))
            case "prepareTransaction":
                try length(5)
                let callData = try bytes(tuple[4], maximum: 1_024 * 1_024)
                guard !callData.isEmpty else {
                    throw failure(.invalidArgument, "callData must contain 1...1 MiB bytes")
                }
                return .prepareTransaction(
                    session: session, sequence: sequence,
                    source: try hash32(tuple[3]), callData: callData)
            case "cancelPreparedTransaction":
                try length(4)
                let preparationID = try string(tuple[3], "preparationID", 34...34)
                guard preparationID.range(
                    of: #"^0x[0-9a-f]{32}$"#,
                    options: .regularExpression
                ) != nil else {
                    throw failure(.invalidArgument, "preparationID is invalid")
                }
                return .cancelPreparedTransaction(
                    session: session, sequence: sequence, preparationID: preparationID)
            case "executePreparedTransaction", "cancelPreparedTransactionExecution":
                try length(4)
                let identifier = try string(tuple[3], "transaction identifier", 34...34)
                guard identifier.range(of: #"^0x[0-9a-f]{32}$"#, options: .regularExpression) != nil else {
                    throw failure(.invalidArgument, "transaction identifier is invalid")
                }
                return .transactionExecution(
                    method: method, session: session, sequence: sequence,
                    executionID: identifier, response: nil)
            case "consumePreparedTransactionQrResponse":
                try length(5)
                let identifier = try string(tuple[3], "executionID", 34...34)
                guard identifier.range(of: #"^0x[0-9a-f]{32}$"#, options: .regularExpression) != nil else {
                    throw failure(.invalidArgument, "executionID is invalid")
                }
                return .transactionExecution(
                    method: method, session: session, sequence: sequence,
                    executionID: identifier,
                    response: try string(tuple[4], "QR_V1 response", 1...65_536))
            case "getTransactionHistory":
                try length(5)
                let before = tuple[3] == nil ? nil
                    : try executionID(tuple[3], "beforeExecutionID")
                let limit = try integer(tuple[4], "limit")
                guard (1...100).contains(limit) else {
                    throw failure(.invalidArgument, "limit must be in 1...100")
                }
                return .transactionHistory(
                    method: method, session: session, sequence: sequence,
                    beforeExecutionID: before, limit: UInt32(limit))
            case "syncTransactionHistory":
                try length(3)
                return .transactionHistory(
                    method: method, session: session, sequence: sequence,
                    beforeExecutionID: nil, limit: 100)
            case "qrParse", "qrConsumeSignResponse", "reviewQrRequest":
                try length(4)
                return .qr(method: method, session: session, sequence: sequence,
                           fields: [try qrText(tuple[3], "QR text")])
            case "openQrCapture":
                try length(4)
                let purpose = try integer(tuple[3], "purpose")
                guard (1...8).contains(purpose) else { throw failure(.invalidArgument, "scan purpose is invalid") }
                return .qr(method: method, session: session, sequence: sequence, fields: [purpose])
            case "setQrCaptureTorch":
                try length(5)
                guard let enabled = tuple[4] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID() else { throw failure(.invalidArgument, "torch must be boolean") }
                return .qr(method: method, session: session, sequence: sequence, fields: [try resourceID(tuple[3]), enabled.boolValue])
            case "qrDecodeImage":
                try length(5)
                let purpose = try integer(tuple[4], "purpose")
                guard (1...8).contains(purpose) else { throw failure(.invalidArgument, "scan purpose is invalid") }
                let image = try bytes(tuple[3], maximum: 16 * 1024 * 1024)
                guard !image.isEmpty else { throw failure(.invalidArgument, "image is empty") }
                return .qr(method: method, session: session, sequence: sequence, fields: [image, purpose])
            case "qrCreateSignRequest":
                try length(7)
                let action = try integer(tuple[3], "action")
                let ttl = try integer(tuple[6], "ttlSeconds")
                guard (1...65_535).contains(action), (1...300).contains(ttl) else {
                    throw failure(.invalidArgument, "Invalid QR action or TTL")
                }
                let payload = try bytes(tuple[5], maximum: 1_920)
                guard !payload.isEmpty else { throw failure(.invalidArgument, "QR payload is empty") }
                return .qr(method: method, session: session, sequence: sequence,
                           fields: [action, try hash32(tuple[4]), payload, ttl])
            case "qrValidateSignResponse":
                try length(5)
                return .qr(method: method, session: session, sequence: sequence,
                           fields: [try string(tuple[3], "sessionID", 1...128), try qrText(tuple[4], "response")])
            case "qrCancelSignRequest":
                try length(4)
                return .qr(method: method, session: session, sequence: sequence,
                           fields: [try string(tuple[3], "requestID", 16...128)])
            case "qrEncodeAccountId":
                try length(4)
                return .qr(method: method, session: session, sequence: sequence,
                           fields: [try hash32(tuple[3])])
            case "qrDecodeLuminance":
                try length(7)
                let pixels = try bytes(tuple[3], maximum: 16 * 1_024 * 1_024)
                let width = try integer(tuple[4], "width")
                let height = try integer(tuple[5], "height")
                let stride = try integer(tuple[6], "rowStride")
                guard (1...4_096).contains(width), (1...4_096).contains(height), stride >= width,
                      stride <= 4_096, Int64(pixels.count) >= (height - 1) * stride + width else {
                    throw failure(.invalidArgument, "Invalid QR luminance dimensions")
                }
                return .qr(method: method, session: session, sequence: sequence,
                           fields: [pixels, width, height, stride])
            case "qrEncode":
                try length(5)
                let scale = try integer(tuple[4], "scale")
                guard (1...16).contains(scale) else { throw failure(.invalidArgument, "Invalid QR scale") }
                return .qr(method: method, session: session, sequence: sequence,
                           fields: [try qrText(tuple[3], "QR text"), scale])
            default: throw failure(.unsupported, "Unsupported method")
            }
        } catch let error as ContractFailure {
            throw ContractFailure(code: error.code, message: error.message,
                                  session: error.session ?? session, sequence: error.sequence ?? sequence,
                                  stage: error.stage)
        } catch let error as CitizenSDKError {
            throw ContractFailure(code: error.code, message: error.message, session: session,
                                  sequence: sequence, stage: error.stage)
        } catch {
            throw ContractFailure(code: .invalidArgument, message: "Invalid CitizenSDK request",
                                  session: session, sequence: sequence)
        }
    }

    static func response(session: String, sequence: Int64, value: [Any?]) -> [Any?] {
        [version, session, sequence, value]
    }
    static func event(session: String, sequence: Int64, type: String, payload: [Any?]) throws -> [Any?] {
        guard eventTypes.contains(type), sequence > 0,
              ((type != "historyChanged" && type != "walletChanged") || payload.isEmpty),
              (type != "finalizedBlockChanged" || payload.count == 1) else {
            throw CitizenSDKError(.integrity, "Unsupported CitizenSDK event type")
        }
        return [version, session, sequence, type, payload]
    }
    static func error(_ code: CitizenSDKErrorCode, _ message: String,
                      session: String?, sequence: Int64?, method: String,
                      stage: CitizenSDKFailureStage? = nil) -> [Any?] {
        precondition(methods.contains(method))
        let failureStage = stage ?? .defaultStage(for: code)
        return [version, session, sequence, Int64(code.rawValue),
                Int64(failureStage.rawValue), method, message]
    }

    static func errorName(_ code: CitizenSDKErrorCode) -> String {
        switch code {
        case .ok: return "ok"
        case .invalidArgument: return "invalidArgument"
        case .invalidHandle: return "invalidHandle"
        case .invalidState: return "invalidState"
        case .unsupported: return "unsupported"
        case .unavailable: return "unavailable"
        case .notReady: return "notReady"
        case .notFound: return "notFound"
        case .conflict: return "conflict"
        case .integrity: return "integrity"
        case .authenticationCancelled: return "authenticationCancelled"
        case .authenticationRequired: return "authenticationRequired"
        case .keyInvalidated: return "keyInvalidated"
        case .permissionDenied: return "permissionDenied"
        case .storage: return "storage"
        case .network: return "network"
        case .decode: return "decode"
        case .timeout: return "timeout"
        case .busy: return "busy"
        case .queueFull: return "queueFull"
        case .internalFailure: return "internal"
        case .panic: return "panic"
        case .cancelled: return "cancelled"
        @unknown default: return "unknown"
        }
    }

    static func lifecycle(_ value: CitizenSDKLifecycle) -> String {
        switch value {
        case .created: return "created"
        case .importingState: return "importingState"
        case .starting: return "starting"
        case .running: return "running"
        case .startFailed: return "startFailed"
        case .stopped: return "stopped"
        case .disposed: return "disposed"
        @unknown default: return "unknown"
        }
    }

    static func block(_ value: CitizenBlockRef) -> [Any?] {
        [hex(value.hash), String(value.number), value.finality == .best ? "best" : "finalized"]
    }
    static func syncStatus(_ value: CitizenChainSyncStatus) -> [Any?] {
        [String(value.peerCount), value.isSyncing, value.isUsable, block(value.best), block(value.finalized)]
    }
    static func blockHeader(_ value: CitizenBlockHeader) -> [Any?] {
        [block(value.block), hex(value.parentHash), hex(value.stateRoot), hex(value.extrinsicsRoot),
         FlutterStandardTypedData(bytes: value.digest)]
    }
    static func blockBody(_ value: CitizenBlockBody) -> [Any?] {
        [block(value.block), value.extrinsics.map { FlutterStandardTypedData(bytes: $0) }]
    }
    static func runtimeContext(_ value: CitizenRuntimeContext) -> [Any?] {
        [block(value.block), Int64(value.specVersion), Int64(value.transactionVersion),
         FlutterStandardTypedData(bytes: value.metadata)]
    }
    static func chainState(_ value: CitizenChainState) -> [Any?] {
        [Int64(value.formatVersion), block(value.finalized), FlutterStandardTypedData(bytes: value.database)]
    }
    static func optionalBytes(_ value: Data?) -> Any? {
        value.map { FlutterStandardTypedData(bytes: $0) }
    }
    static func capabilities(_ value: CitizenSDKCapabilities) -> [Any?] {
        [String(value.revision), value.statuses.map(capability)]
    }
    static func balance(_ value: CitizenAccountBalance) -> [Any?] {
        [hex(value.accountID), block(value.block), value.freeFen.decimal, value.reservedFen.decimal, value.totalFen.decimal]
    }
    static func nonce(_ value: CitizenAccountNonce) -> [Any?] {
        [hex(value.accountID), block(value.bestBlock), String(value.nonce)]
    }
    static func fee(_ value: CitizenFeeSnapshot) -> [Any?] {
        [block(value.bestBlock), Int64(value.feeRateParts), value.minimumFeeFen.decimal, value.existentialDepositFen.decimal]
    }
    static func profile(_ value: CitizenWalletProfile?) -> [Any?]? {
        value.map { profile in
            [Int64(profile.walletIndex), profile.origin == .created ? "created" : "imported",
             String(profile.createdAtMillis), hex(profile.masterAccountID), hex(profile.activeAccountID),
             profile.accounts.map(account), profile.walletName]
        }
    }
    static func walletState(_ value: CitizenWalletState) -> [Any?] {
        [String(value.revision), profile(value.hotProfile), value.accounts.map(stateAccount), value.initializationState,
         value.cleanupPending, value.activeWalletIndex.map { Int64($0) }, value.diagnostics.map { item -> [Any?] in
            [Int64(item.walletIndex), item.walletName, hex(item.accountID), item.ss58Address, item.diagnosticReason,
             item.signMode.map { $0 == .hot ? "hot" : "cold" },
             item.cleanupTargets.map { [$0.accountIDs.map(hex), $0.deleteWalletWideKey] as [Any?] }]
         }]
    }
    static func signature(_ value: CitizenSignature) -> FlutterStandardTypedData { FlutterStandardTypedData(bytes: value.bytes) }
    static func signingOutcome(_ value: CitizenSigningOutcome) -> [Any?] {
        switch value {
        case let .completed(accountID, payloadHash, signatureValue):
            return ["completed", hex(accountID), hex(payloadHash), signature(signatureValue), nil, nil, nil]
        case let .externalPending(accountID, payloadHash, _, expiresAt, sessionID, request):
            return ["externalPending", hex(accountID), hex(payloadHash), nil,
                    String(expiresAt), sessionID, request]
        }
    }
    static func defaultAccountChangeOutcome(_ value: CitizenDefaultAccountChangeOutcome) -> [Any?] {
        switch value {
        case let .completed(current, payloadHash, revision):
            return ["completed", hex(current), hex(payloadHash), String(revision), nil, nil, nil]
        case let .externalPending(current, payloadHash, _, expiresAt, sessionID, request):
            return ["externalPending", hex(current), hex(payloadHash), nil,
                    String(expiresAt), sessionID, request]
        }
    }
    static func preparedTransaction(_ value: CitizenPreparedTransaction) -> [Any?] {
        [value.preparationID, hex(value.sourceAccountID), hex(value.callDataHash),
         block(value.bestBlock), Int64(value.runtimeSpecNumber),
         Int64(value.transactionFormatNumber), String(value.nonce)]
    }
    static func transactionExecution(_ value: CitizenTransactionExecution) throws -> [Any?] {
        switch value {
        case let .externalSigningPending(pending):
            return [1, pending.executionID, hex(pending.sourceAccountID), hex(pending.callDataHash),
                    nil, String(pending.expiresAt), pending.qrRequest, nil, nil, nil]
        case let .completed(completed):
            let status: Int
            switch completed.resolution {
            case .finalizedSuccess: status = 2
            case .finalizedFailed: status = 3
            case .poolRejected: status = 4
            }
            return [status, completed.executionID, hex(completed.sourceAccountID),
                    hex(completed.callDataHash), hex(completed.transactionHash), nil, nil,
                    try completed.execution.map(execution), completed.poolRejectionReason,
                    completed.replacementHash.map(hex)]
        }
    }
    static func transactionHistoryPage(_ value: CitizenTransactionHistoryPage) throws -> [Any?] {
        [String(value.revision), try value.records.map(transactionHistoryRecord),
         value.nextBeforeExecutionID]
    }

    private static func capability(_ value: CitizenCapabilityStatus) -> [Any?] {
        [capabilityName(value.name), value.supported, value.available, value.enabled, value.ready, capabilityReason(value.reason)]
    }
    private static func account(_ value: CitizenWalletAccount) -> [Any?] {
        [Int64(value.index), hex(value.accountID), value.ss58Address, value.name ?? "", String(value.createdAtMillis), value.active]
    }
    private static func stateAccount(_ value: CitizenWalletStateAccount) -> [Any?] {
        [value.signMode == .hot ? "hot" : "cold", Int64(value.walletIndex),
         value.accountIndex.map { Int64($0) }, hex(value.accountID), value.ss58Address, value.name,
         String(value.createdAtMillis), value.isDefault]
    }
    private static func execution(_ value: CitizenExecution) throws -> [Any?] {
        guard value.status != .unverified, let blockValue = value.block, let extrinsic = value.extrinsicIndex else {
            throw CitizenSDKError(.integrity, "Flutter tuple requires a verified finalized execution")
        }
        return [value.status == .success ? "success" : "failed", block(blockValue),
         Int64(extrinsic), value.status == .failed ? Int64(value.reasonOrDispatchVariant) : nil,
         value.palletIndex.map { Int64($0) }, value.errorIndex.map { Int64($0) }]
    }
    private static func transactionHistoryRecord(_ value: CitizenTransactionHistoryRecord) throws -> [Any?] {
        [value.executionID, hex(value.sourceAccountID), hex(value.callDataHash),
         hex(value.transactionHash), transactionHistoryStatus(value.status),
         value.block.map(block), try value.execution.map(execution), value.replacementHash.map(hex),
         String(value.createdAtMillis), String(value.updatedAtMillis), value.poolRejectionReason]
    }

    private static func hash32(_ raw: Any?) throws -> Data {
        guard let text = raw as? String, text.count == 66, text.hasPrefix("0x"),
              text.dropFirst(2).unicodeScalars.allSatisfy({
                  ($0.value >= 48 && $0.value <= 57) || ($0.value >= 97 && $0.value <= 102)
              }) else {
            throw failure(.invalidArgument, "Invalid 32-byte hex")
        }
        var output = Data(capacity: 32)
        var index = text.index(text.startIndex, offsetBy: 2)
        for _ in 0..<32 {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else { throw failure(.invalidArgument, "Invalid 32-byte hex") }
            output.append(byte); index = next
        }
        return output
    }
    private static func executionID(_ raw: Any?, _ label: String) throws -> String {
        guard let value = raw as? String,
              value.range(of: #"^0x[0-9a-f]{32}$"#, options: .regularExpression) != nil else {
            throw failure(.invalidArgument, "\(label) must be a 16-byte lowercase hex identifier")
        }
        return value
    }
    private static func blockRef(_ raw: Any?) throws -> CitizenBlockRef {
        guard let tuple = raw as? [Any?], tuple.count == 3 else {
            throw failure(.invalidArgument, "Invalid block tuple")
        }
        let finality: CitizenFinality
        switch tuple[2] as? String {
        case "best": finality = .best
        case "finalized": finality = .finalized
        default: throw failure(.invalidArgument, "Invalid block finality")
        }
        return try CitizenBlockRef(hash: hash32(tuple[0]), number: uint64Decimal(tuple[1], "block number"),
                                   finality: finality)
    }
    private static func bytes(_ raw: Any?, maximum: Int) throws -> Data {
        guard let value = raw as? FlutterStandardTypedData,
              // FlutterStandardDataTypeUInt8 is the first NS_ENUM case.  Compare
              // the raw value because Flutter SDK releases have exposed
              // different Swift spellings for this Objective-C enum member.
              value.type.rawValue == 0,
              value.data.count <= maximum else {
            throw failure(.invalidArgument, "Invalid byte tuple")
        }
        return value.data
    }
    private static func resourceID(_ raw: Any?) throws -> String {
        let value = try string(raw, "resource ID", 1...128)
        guard value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) ||
            (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw failure(.invalidArgument, "resource ID is invalid")
        }
        return value
    }
    private static func accountName(_ raw: Any?, allowEmpty: Bool) throws -> String {
        let name = try string(raw, "name", 0...128)
        if allowEmpty && name.isEmpty { return name }
        guard name == name.trimmingCharacters(in: .whitespacesAndNewlines), (1...30).contains(name.unicodeScalars.count),
              !name.unicodeScalars.contains(where: { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) else {
            throw failure(.invalidArgument, "name must be trimmed 1...30 scalars without controls")
        }
        return name
    }
    private static func string(_ raw: Any?, _ label: String, _ range: ClosedRange<Int>) throws -> String {
        guard let value = raw as? String, range.contains(value.utf16.count) else {
            throw failure(.invalidArgument, "Invalid \(label)")
        }
        return value
    }
    private static func utf8Text(_ raw: Any?, _ label: String,
                                 _ range: ClosedRange<Int>) throws -> String {
        let value = try string(raw, label, 0...max(range.upperBound, 1))
        guard range.contains(value.utf8.count) else { throw failure(.invalidArgument, "Invalid \(label) UTF-8 length") }
        return value
    }
    private static func qrText(_ raw: Any?, _ label: String) throws -> String {
        try utf8Text(raw, label, 1...2_331)
    }
    private static func integer(_ raw: Any?, _ label: String) throws -> Int64 {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              !CFNumberIsFloatType(number), number.int64Value >= 0 else {
            throw failure(.invalidArgument, "Invalid \(label)")
        }
        return number.int64Value
    }
    private static func uint64Decimal(_ raw: Any?, _ label: String) throws -> UInt64 {
        guard let value = raw as? String, !value.isEmpty, value.count <= 20,
              value == "0" || (value.first != "0" && value.allSatisfy(\.isNumber)),
              let parsed = UInt64(value) else {
            throw failure(.invalidArgument, "Invalid \(label)")
        }
        return parsed
    }
    private static func failure(_ code: CitizenSDKErrorCode, _ message: String,
                                _ session: String? = nil, _ sequence: Int64? = nil) -> ContractFailure {
        ContractFailure(code: code, message: message, session: session, sequence: sequence)
    }
    static func hex(_ value: Data) -> String { "0x" + value.map { String(format: "%02x", $0) }.joined() }
    private static func capabilityName(_ value: CitizenCapabilityName) -> String {
        switch value {
        case .chainRead: return "chainRead"; case .transactionBuild: return "transactionBuild"
        case .transactionSubmit: return "transactionSubmit"; case .transactionVerify: return "transactionVerify"
        case .walletProfile: return "walletProfile"; case .localSigning: return "localSigning"
        case .hardwareVault: return "hardwareVault"; case .userAuthentication: return "userAuthentication"
        case .history: return "history"; case .backgroundSync: return "backgroundSync"
        @unknown default: return "unknown"
        }
    }
    private static func capabilityReason(_ value: CitizenCapabilityReason) -> String {
        switch value {
        case .none: return "none"; case .buildUnsupported: return "buildUnsupported"
        case .deviceUnavailable: return "deviceUnavailable"; case .hostDisabled: return "hostDisabled"
        case .engineNotRunning: return "engineNotRunning"; case .dependencyNotReady: return "dependencyNotReady"
        case .userAuthenticationRequired: return "userAuthenticationRequired"; case .vaultLocked: return "vaultLocked"
        case .chainStarting: return "chainStarting"; case .chainUnsynced: return "chainUnsynced"
        case .storageUnavailable: return "storageUnavailable"
        @unknown default: return "unknown"
        }
    }
    private static func transactionHistoryStatus(_ value: CitizenTransactionHistoryStatus) -> String {
        switch value {
        case .pending: return "pending"
        case .inBlock: return "inBlock"
        case .poolRejected: return "poolRejected"
        case .finalizedSuccess: return "finalizedSuccess"
        case .finalizedFailed: return "finalizedFailed"
        @unknown default: return "unknown"
        }
    }
}
