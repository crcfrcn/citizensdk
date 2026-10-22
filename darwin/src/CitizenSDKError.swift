import Foundation

/// Stable error vocabulary shared verbatim with `citizensdk_error_code_t`.
public enum CitizenSDKErrorCode: Int32, CaseIterable, Sendable {
    case ok = 0
    case invalidArgument = 1
    case invalidHandle = 2
    case invalidState = 3
    case unsupported = 4
    case unavailable = 5
    case notReady = 6
    case notFound = 7
    case conflict = 8
    case integrity = 9
    case authenticationCancelled = 10
    case authenticationRequired = 11
    case keyInvalidated = 12
    case permissionDenied = 13
    case storage = 14
    case network = 15
    case decode = 16
    case timeout = 17
    case busy = 18
    case queueFull = 19
    case internalFailure = 20
    case panic = 21
    case cancelled = 22

    internal static func checked(_ rawValue: Int32) -> CitizenSDKErrorCode {
        CitizenSDKErrorCode(rawValue: rawValue) ?? .integrity
    }
}

/// Product-independent failure phase shared verbatim with `citizensdk_failure_stage_t`.
public enum CitizenSDKFailureStage: UInt32, CaseIterable, Sendable {
    case admission = 1
    case validation = 2
    case authentication = 3
    case persistence = 4
    case provider = 5
    case verification = 6
    case cancellation = 7
    case teardown = 8

    public static func defaultStage(for code: CitizenSDKErrorCode) -> Self {
        switch code {
        case .invalidArgument, .decode: return .validation
        case .authenticationCancelled, .authenticationRequired, .keyInvalidated, .permissionDenied:
            return .authentication
        case .storage: return .persistence
        case .unavailable, .network, .timeout: return .provider
        case .integrity: return .verification
        case .cancelled: return .cancellation
        case .internalFailure, .panic: return .teardown
        default: return .admission
        }
    }
}

/// Public failures contain neither secrets nor Core request/result identities.
public struct CitizenSDKError: LocalizedError, Sendable, Equatable {
    public let code: CitizenSDKErrorCode
    public let stage: CitizenSDKFailureStage
    public let message: String
    public let method: String?
    public let sessionID: String?
    public let requestSequence: Int64?

    public init(_ code: CitizenSDKErrorCode, _ message: String,
                stage: CitizenSDKFailureStage? = nil, method: String? = nil,
                sessionID: String? = nil, requestSequence: Int64? = nil) {
        self.code = code
        self.stage = stage ?? .defaultStage(for: code)
        self.message = message
        self.method = method
        self.sessionID = sessionID
        self.requestSequence = requestSequence
    }

    public var errorDescription: String? { message }
}

internal enum CitizenSDKChecks {
    static func requireOK(_ rawCode: Int32, _ fallback: String) throws {
        guard rawCode == CitizenSDKErrorCode.ok.rawValue else {
            throw CitizenSDKError(.checked(rawCode), CitizenSDKNative.lastError(fallback: fallback))
        }
    }

    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw CitizenSDKError(.invalidArgument, message) }
    }
}
