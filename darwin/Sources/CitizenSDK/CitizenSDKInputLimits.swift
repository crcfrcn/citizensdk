import Foundation

internal enum CitizenSDKInputLimits {
    static let maximumBalanceAccounts = 1_990
    static let maximumSigningPayloadBytes = 16 * 1_024 * 1_024
    static let maximumWalletSecretBytes = 1_024
    static let maximumAdditionalAccounts = 1_989
    static let maximumAccountNameUTF16Units = 128
    static let maximumStorageKeyBytes = 4 * 1_024
    static let maximumStorageBatchKeys = 1_024
    static let maximumStorageBatchKeyBytes = 1_024 * 1_024

    static func accountID(_ value: Data, label: String = "accountID") throws -> Data {
        try CitizenSDKChecks.require(value.count == 32, "\(label) must contain exactly 32 bytes")
        return value
    }

    /// 批量余额不是历史订阅：允许空列表与重复账户，不排序或去重。
    static func balanceAccountIDs(_ values: [Data]) throws -> [Data] {
        try CitizenSDKChecks.require(values.count <= maximumBalanceAccounts,
                                     "accountIDs must contain 0...\(maximumBalanceAccounts) entries")
        return try values.map { try accountID($0) }
    }

    static func signingPayload(_ value: Data) throws -> Data {
        try CitizenSDKChecks.require(value.count <= maximumSigningPayloadBytes,
                                     "sign payload exceeds \(maximumSigningPayloadBytes) bytes")
        return value
    }

    static func storageKey(_ value: Data) throws -> Data {
        try CitizenSDKChecks.require((1...maximumStorageKeyBytes).contains(value.count),
                                     "storage key must contain 1...4 KiB")
        return value
    }

    static func storageKeys(_ values: [Data]) throws -> [Data] {
        try CitizenSDKChecks.require((1...maximumStorageBatchKeys).contains(values.count),
                                     "storage batch must contain 1...1024 keys")
        let checked = try values.map(storageKey)
        try CitizenSDKChecks.require(
            checked.reduce(0) { $0 + $1.count } <= maximumStorageBatchKeyBytes,
            "storage batch keys exceed 1 MiB")
        return checked
    }

    static func accountName(_ value: String) throws -> String {
        try CitizenSDKChecks.require((1...maximumAccountNameUTF16Units).contains(value.utf16.count),
                                     "wallet account name input is too long")
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        try CitizenSDKChecks.require(normalized == value && (1...30).contains(normalized.unicodeScalars.count),
                                     "wallet account name must contain 1...30 trimmed Unicode scalars")
        try CitizenSDKChecks.require(!normalized.unicodeScalars.contains(where: {
            $0.value <= 0x1f || (0x7f...0x9f).contains($0.value)
        }), "wallet account name must not contain control characters")
        return normalized
    }

    static func additionalIndices(_ values: [UInt32]) throws -> [UInt32] {
        try CitizenSDKChecks.require((1...maximumAdditionalAccounts).contains(values.count),
                                     "wallet index list must contain 1...1989 items")
        try CitizenSDKChecks.require(Set(values).count == values.count && values.allSatisfy { (1...1_989).contains($0) },
                                     "wallet indices must be unique values in 1...1989")
        return values
    }
}
