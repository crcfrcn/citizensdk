import Foundation

internal enum CitizenSDKHostDomain: UInt32 {
    case chainDatabase = 1
    case runtimeCache = 2
    case walletProfile = 3
    case transactionHistory = 4
    case encryptedSecretBlob = 5
}

/// Exact opaque host record copied synchronously by the Rust host adapter.
internal struct CitizenSDKHostRecord {
    let domain: CitizenSDKHostDomain
    let errorCode: CitizenSDKErrorCode
    let present: Bool
    let revision: UInt64
    let record: Data?

    static func absent(_ domain: CitizenSDKHostDomain) -> CitizenSDKHostRecord {
        CitizenSDKHostRecord(domain: domain, errorCode: .ok, present: false, revision: 0, record: nil)
    }

    static func present(_ domain: CitizenSDKHostDomain, revision: UInt64, record: Data) -> CitizenSDKHostRecord {
        CitizenSDKHostRecord(domain: domain, errorCode: .ok, present: true, revision: revision, record: record)
    }

    static func failure(_ domain: CitizenSDKHostDomain, _ error: CitizenSDKErrorCode) -> CitizenSDKHostRecord {
        CitizenSDKHostRecord(domain: domain, errorCode: error, present: false, revision: 0, record: nil)
    }
}
