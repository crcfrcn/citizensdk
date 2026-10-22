import Foundation

/// 与Core同一原因闭集；界面文字由宿主按自己的原交互呈现。
public enum CitizenWalletInputReason: UInt32, Sendable {
    case valid = 0, inputTooLong = 1, wordCount = 2, unknownWord = 3, checksum = 4
    case passwordFormat = 5, mnemonicFormat = 6, passwordLength = 7, passwordNormalization = 8
}
public struct CitizenWalletInputValidation: Sendable, Equatable {
    public let reason: CitizenWalletInputReason
    public let position: UInt32?
    public var isValid: Bool { reason == .valid }
}

/// 同一 Rust 核心的模块集合；这里只投影位值，组合合法性由核心统一校验。
public struct CitizenSDKModules: OptionSet, Sendable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }
    public static let wallet = Self(rawValue: 1)
    public static let signing = Self(rawValue: 2)
    public static let chain = Self(rawValue: 4)
    public static let transactions = Self(rawValue: 8)
    public static let history = Self(rawValue: 16)
    public static let qr = Self(rawValue: 32)
    public static let full: Self = [.wallet, .signing, .chain, .transactions, .history, .qr]

    internal var usesSecrets: Bool { !intersection([.wallet, .signing]).isEmpty }
}

public enum CitizenSDKLifecycle: UInt32, Sendable {
    case created = 1
    case importingState = 2
    case starting = 3
    case running = 4
    case startFailed = 5
    case stopped = 6
    case disposed = 7
}

public enum CitizenFinality: UInt32, Sendable { case best = 1, finalized = 2 }
public enum CitizenWalletOrigin: UInt32, Sendable { case created = 1, imported = 2 }
public enum CitizenWalletSignMode: UInt32, Sendable { case hot = 1, cold = 2 }
public enum CitizenSigningTransform: UInt32, Sendable {
    case raw = 1
    case substrateSigningPayload = 2
    case blake2Domain = 3
}
public enum CitizenExternalSignerTransport: UInt32, Sendable { case qrV1 = 1 }
@frozen public enum CitizenTransactionResolution: UInt32, Sendable {
    case finalizedSuccess = 1, finalizedFailed = 2, poolRejected = 3
}
public enum CitizenTransactionHistoryStatus: UInt32, Sendable {
    case pending = 1, inBlock = 2, poolRejected = 3, finalizedSuccess = 4, finalizedFailed = 5
}
public enum CitizenExecutionStatus: UInt32, Sendable { case success = 1, failed = 2, unverified = 3 }

public enum CitizenCapabilityName: UInt32, CaseIterable, Sendable {
    case chainRead = 1
    case transactionBuild = 2
    case transactionSubmit = 3
    case transactionVerify = 4
    case walletProfile = 5
    case localSigning = 6
    case hardwareVault = 7
    case userAuthentication = 8
    case history = 9
    case backgroundSync = 10
}

public enum CitizenCapabilityReason: UInt32, Sendable {
    case none = 0
    case buildUnsupported = 1
    case deviceUnavailable = 2
    case hostDisabled = 3
    case engineNotRunning = 4
    case dependencyNotReady = 5
    case userAuthenticationRequired = 6
    case vaultLocked = 7
    case chainStarting = 8
    case chainUnsynced = 9
    case storageUnavailable = 10
}

/// Exact unsigned 128-bit integer represented canonically in decimal.
public struct CitizenU128: Equatable, Hashable, Sendable, CustomStringConvertible {
    public let decimal: String
    internal let low: UInt64
    internal let high: UInt64

    public init(_ decimal: String) throws {
        try CitizenSDKChecks.require(!decimal.isEmpty && decimal.count <= 39, "u128 is out of range")
        try CitizenSDKChecks.require(decimal == "0" || (decimal.first != "0" && decimal.allSatisfy(\.isNumber)),
                                     "u128 must be canonical unsigned decimal")
        var high: UInt64 = 0
        var low: UInt64 = 0
        for scalar in decimal.unicodeScalars {
            guard scalar.value >= 48 && scalar.value <= 57 else {
                throw CitizenSDKError(.invalidArgument, "u128 must be canonical unsigned decimal")
            }
            let digit = UInt64(scalar.value - 48)
            let lowProduct = low.multipliedFullWidth(by: 10)
            let highProduct = high.multipliedReportingOverflow(by: 10)
            let highSum = highProduct.partialValue.addingReportingOverflow(lowProduct.high)
            let lowSum = lowProduct.low.addingReportingOverflow(digit)
            let highCarry = highSum.partialValue.addingReportingOverflow(lowSum.overflow ? 1 : 0)
            guard !highProduct.overflow && !highSum.overflow && !highCarry.overflow else {
                throw CitizenSDKError(.invalidArgument, "u128 is out of range")
            }
            high = highCarry.partialValue
            low = lowSum.partialValue
        }
        self.high = high
        self.low = low
        self.decimal = decimal
    }

    internal init(low: UInt64, high: UInt64) {
        self.low = low
        self.high = high
        self.decimal = CitizenU128.decimal(low: low, high: high)
    }

    public var description: String { decimal }

    private static func decimal(low: UInt64, high: UInt64) -> String {
        if high == 0 { return String(low) }
        var highPart = high
        var lowPart = low
        var digits: [UInt8] = []
        repeat {
            let highDivision = highPart.quotientAndRemainder(dividingBy: 10)
            let lowDivision = UInt64(10).dividingFullWidth((high: highDivision.remainder, low: lowPart))
            digits.append(UInt8(lowDivision.remainder) + 48)
            highPart = highDivision.quotient
            lowPart = lowDivision.quotient
        } while highPart != 0 || lowPart != 0
        return String(bytes: digits.reversed(), encoding: .ascii)!
    }
}

public struct CitizenBlockRef: Equatable, Sendable {
    public let hash: Data
    public let number: UInt64
    public let finality: CitizenFinality

    public init(hash: Data, number: UInt64, finality: CitizenFinality) throws {
        try CitizenSDKChecks.require(hash.count == 32, "block hash must contain exactly 32 bytes")
        self.hash = hash
        self.number = number
        self.finality = finality
    }
}

public struct CitizenChainSyncStatus: Equatable, Sendable {
    public let peerCount: UInt64
    public let isSyncing: Bool
    public let isUsable: Bool
    public let best: CitizenBlockRef
    public let finalized: CitizenBlockRef
}

public struct CitizenBlockHeader: Equatable, Sendable {
    public let block: CitizenBlockRef
    public let parentHash: Data
    public let stateRoot: Data
    public let extrinsicsRoot: Data
    public let digest: Data
}

public struct CitizenBlockBody: Equatable, Sendable {
    public let block: CitizenBlockRef
    public let extrinsics: [Data]
}

public struct CitizenRuntimeContext: Equatable, Sendable {
    public let block: CitizenBlockRef
    public let specVersion: UInt32
    public let transactionVersion: UInt32
    public let metadata: Data
}

/// Explicit smoldot state transport only; this is not a legacy-app migration envelope.
public struct CitizenChainState: Equatable, Sendable {
    public let formatVersion: UInt32
    public let finalized: CitizenBlockRef
    public let database: Data

    public init(formatVersion: UInt32, finalized: CitizenBlockRef, database: Data) throws {
        try CitizenSDKChecks.require(formatVersion > 0, "chain state format version must be nonzero")
        try CitizenSDKChecks.require(finalized.finality == .finalized,
                                     "chain state anchor must be finalized")
        try CitizenSDKChecks.require((1...256 * 1_024).contains(database.count),
                                     "chain state database is invalid")
        self.formatVersion = formatVersion
        self.finalized = finalized
        self.database = database
    }
}

public struct CitizenCapabilityStatus: Equatable, Sendable {
    public let name: CitizenCapabilityName
    public let reason: CitizenCapabilityReason
    public let supported: Bool
    public let available: Bool
    public let enabled: Bool
    public let ready: Bool
}

public struct CitizenSDKCapabilities: Equatable, Sendable {
    public let revision: UInt64
    public let statuses: [CitizenCapabilityStatus]
}

public struct CitizenAccountBalance: Equatable, Sendable {
    public let block: CitizenBlockRef
    public let accountID: Data
    public let freeFen: CitizenU128
    public let reservedFen: CitizenU128
    public let totalFen: CitizenU128
}

public struct CitizenAccountNonce: Equatable, Sendable {
    public let bestBlock: CitizenBlockRef
    public let accountID: Data
    public let nonce: UInt64
}

public struct CitizenFeeSnapshot: Equatable, Sendable {
    public let bestBlock: CitizenBlockRef
    public let feeRateParts: UInt32
    public let minimumFeeFen: CitizenU128
    public let existentialDepositFen: CitizenU128
}

public struct CitizenWalletAccount: Equatable, Sendable {
    public let index: UInt32
    public let accountID: Data
    public let ss58Address: String
    public let name: String?
    public let createdAtMillis: UInt64
    public let active: Bool
}

public struct CitizenWalletProfile: Equatable, Sendable {
    /// 独立钱包级标签，不复用账户0名称。
    public let walletName: String
    public let origin: CitizenWalletOrigin
    public let walletIndex: UInt32
    public let createdAtMillis: UInt64
    public let masterAccountID: Data
    public let activeAccountID: Data
    public let accounts: [CitizenWalletAccount]
}

/// One secret-free entry in the globally ordered hot/cold wallet catalog.
public struct CitizenWalletStateAccount: Equatable, Sendable {
    public let signMode: CitizenWalletSignMode
    public let walletIndex: UInt32
    public let accountIndex: UInt32?
    public let accountID: Data
    public let ss58Address: String
    public let name: String
    public let createdAtMillis: UInt64
    public let isDefault: Bool
}

/// 同一Core精确校验输出的公开清理目标；不含秘密引用，不授予删除权限。
public struct CitizenWalletCleanupTargets: Equatable, Sendable {
    public let accountIDs: [Data]
    public let deleteWalletWideKey: Bool
}

/// 只读异常事实，不是可签名账户；缺失地址不伪造为空地址。
public struct CitizenWalletDiagnostic: Equatable, Sendable {
    public let walletIndex: UInt32
    public let walletName: String
    public let accountID: Data
    public let ss58Address: String?
    public let diagnosticReason: UInt32
    public let signMode: CitizenWalletSignMode?
    public let cleanupTargets: CitizenWalletCleanupTargets?
}

/// Stable public wallet snapshot. The first account is the only default projection.
public struct CitizenWalletState: Equatable, Sendable {
    public let revision: UInt64
    public let hotProfile: CitizenWalletProfile?
    public let accounts: [CitizenWalletStateAccount]
    public let initializationState: UInt32
    public let cleanupPending: Bool
    /// 独立付款钱包，不改变默认账户或热钱包activeAccountID。
    public let activeWalletIndex: UInt32?
    public let diagnostics: [CitizenWalletDiagnostic]

    internal init(revision: UInt64, hotProfile: CitizenWalletProfile?, accounts: [CitizenWalletStateAccount],
                  initializationState: UInt32, cleanupPending: Bool, activeWalletIndex: UInt32?,
                  diagnostics: [CitizenWalletDiagnostic] = []) {
        self.revision = revision; self.hotProfile = hotProfile; self.accounts = accounts
        self.initializationState = initializationState; self.cleanupPending = cleanupPending
        self.activeWalletIndex = activeWalletIndex; self.diagnostics = diagnostics
    }

    public var defaultAccount: CitizenWalletStateAccount? { accounts.first }
}

public struct CitizenSignature: Equatable, Sendable {
    public let bytes: Data
    internal init(_ bytes: Data) throws {
        try CitizenSDKChecks.require(bytes.count == 64, "sr25519 signature must contain exactly 64 bytes")
        self.bytes = bytes
    }
}

/// Product-independent signing input. Payload, domain and QR action are opaque
/// protocol bytes owned by the integrating application.
public struct CitizenSigningIntent: Equatable, Sendable {
    public let accountID: Data
    public let payload: Data
    public let transform: CitizenSigningTransform
    public let domain: Data
    public let externalSignerTransport: CitizenExternalSignerTransport?
    public let opaqueAction: UInt16
    public let ttlSeconds: UInt64

    public init(accountID: Data, payload: Data, transform: CitizenSigningTransform,
                domain: Data = Data(),
                externalSignerTransport: CitizenExternalSignerTransport? = nil,
                opaqueAction: UInt16 = 0, ttlSeconds: UInt64 = 120) throws {
        try CitizenSDKChecks.require(accountID.count == 32, "accountID must contain 32 bytes")
        try CitizenSDKChecks.require((1...16 * 1_024 * 1_024).contains(payload.count),
                                     "payload must contain 1...16 MiB bytes")
        try CitizenSDKChecks.require((1...300).contains(ttlSeconds), "ttlSeconds must be 1...300")
        try CitizenSDKChecks.require(
            (transform == .blake2Domain && (1...32).contains(domain.count)) ||
            (transform != .blake2Domain && domain.isEmpty),
            "signing transform/domain combination is invalid"
        )
        self.accountID = accountID
        self.payload = payload
        self.transform = transform
        self.domain = domain
        self.externalSignerTransport = externalSignerTransport
        self.opaqueAction = opaqueAction
        self.ttlSeconds = ttlSeconds
    }
}

@frozen public enum CitizenSigningOutcome: Equatable, Sendable {
    case completed(accountID: Data, payloadHash: Data, signature: CitizenSignature)
    case externalPending(accountID: Data, payloadHash: Data,
                         transport: CitizenExternalSignerTransport,
                         expiresAt: UInt64, sessionID: String, transportRequest: String)
}

@frozen public enum CitizenDefaultAccountChangeOutcome: Equatable, Sendable {
    case completed(currentDefaultAccountID: Data, payloadHash: Data, committedRevision: UInt64)
    case externalPending(currentDefaultAccountID: Data, payloadHash: Data,
                         transport: CitizenExternalSignerTransport,
                         expiresAt: UInt64, sessionID: String, transportRequest: String)
}

public struct CitizenExecution: Equatable, Sendable {
    public let status: CitizenExecutionStatus
    public let reasonOrDispatchVariant: UInt32
    public let block: CitizenBlockRef?
    public let extrinsicIndex: UInt32?
    public let palletIndex: UInt8?
    public let errorIndex: UInt8?
}

/// Secret-free summary for one non-persistent Core-owned transaction preparation.
public struct CitizenPreparedTransaction: Equatable, Sendable {
    public let preparationID: String
    public let sourceAccountID: Data
    public let callDataHash: Data
    public let bestBlock: CitizenBlockRef
    public let runtimeSpecNumber: UInt32
    public let transactionFormatNumber: UInt32
    public let nonce: UInt64
}

public struct CitizenTransactionExternalSigningPending: Equatable, Sendable {
    public let executionID: String
    public let sourceAccountID: Data
    public let callDataHash: Data
    public let expiresAt: UInt64
    public let qrRequest: String
}

public struct CitizenTransactionExecutionCompleted: Equatable, Sendable {
    public let executionID: String
    public let sourceAccountID: Data
    public let callDataHash: Data
    public let transactionHash: Data
    public let resolution: CitizenTransactionResolution
    public let execution: CitizenExecution?
    public let poolRejectionReason: String?
    public let replacementHash: Data?
}

@frozen public enum CitizenTransactionExecution: Equatable, Sendable {
    case externalSigningPending(CitizenTransactionExternalSigningPending)
    case completed(CitizenTransactionExecutionCompleted)
}

/// Product-independent public projection of one SDK-submitted transaction.
public struct CitizenTransactionHistoryRecord: Equatable, Sendable {
    public let executionID: String
    public let sourceAccountID: Data
    public let callDataHash: Data
    public let transactionHash: Data
    public let status: CitizenTransactionHistoryStatus
    public let block: CitizenBlockRef?
    public let execution: CitizenExecution?
    public let replacementHash: Data?
    public let createdAtMillis: UInt64
    public let updatedAtMillis: UInt64
    public let poolRejectionReason: String?
}

/// Newest-first deterministic page from the SDK's execution-only store.
public struct CitizenTransactionHistoryPage: Equatable, Sendable {
    public let revision: UInt64
    public let records: [CitizenTransactionHistoryRecord]
    public let nextBeforeExecutionID: String?
}
