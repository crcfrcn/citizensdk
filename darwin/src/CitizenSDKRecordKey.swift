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



    static func keychainTag(applicationID: String, walletIndex: UInt32, generation: Data) throws -> Data {
        let applicationID = try self.applicationID(applicationID)
        try CitizenSDKChecks.require(generation.count == 16,"vault generation must contain 16 bytes")
        let identity = "\(applicationID):v1:\(walletIndex):\(generation.hex)"
        let digest = SHA256.hash(data: Data(identity.utf8))
        // 产品标识保持 citizensdk；摘要同时绑定宿主和钱包代际，避免同用户不同 App 选中同一 KEK。
        return Data("citizensdk_wallet_\(Data(digest).hex)".utf8)
    }
}

internal extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
