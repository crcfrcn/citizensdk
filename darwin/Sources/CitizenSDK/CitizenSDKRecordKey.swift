import CryptoKit
import Foundation

internal enum CitizenSDKRecordKey {
    /// 采用宿主 Bundle ID 原值，拒绝缺失、路径分隔符和空段；不以 SDK 标识代替宿主。
    static func applicationID(_ value: String?) throws -> String {
        guard let value, (3...253).contains(value.utf8.count),
              value.range(of: "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$", options: .regularExpression) == value.startIndex..<value.endIndex else {
            throw CitizenSDKError(.invalidArgument, "host application_id must be an explicit Bundle identifier")
        }
        return value
    }

    static func blockHash(_ hash: Data) throws -> String {
        try CitizenSDKChecks.require(hash.count == 32, "block hash identity must contain 32 bytes")
        return "block:\(hash.hex)"
    }

    static func secret(walletIndex: UInt32, kind: UInt32, generation: Data, owner: Data, accountID: Data) throws -> String {
        try CitizenSDKChecks.require(generation.count == 16 && owner.count == 16 && accountID.count == 32,
                                     "secret record identity has invalid length")
        return "v1:\(walletIndex):\(kind):\(generation.hex):\(owner.hex):\(accountID.hex)"
    }

    static func generation(walletIndex: UInt32, generation: Data) throws -> String {
        try CitizenSDKChecks.require(generation.count == 16, "vault generation must contain 16 bytes")
        return "v1:\(walletIndex):\(generation.hex)"
    }

    static func keychainTag(applicationID: String, walletIndex: UInt32, generation: Data) throws -> Data {
        let applicationID = try self.applicationID(applicationID)
        let identity = try "\(applicationID):\(self.generation(walletIndex: walletIndex, generation: generation))"
        let digest = SHA256.hash(data: Data(identity.utf8))
        // 产品标识保持 citizensdk；摘要同时绑定宿主和钱包代际，避免同用户不同 App 选中同一 KEK。
        return Data("citizensdk_wallet_\(Data(digest).hex)".utf8)
    }
}

internal extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
