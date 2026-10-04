import Foundation


private func citizenCodecHex(_ value: Data) -> String {
    "0x" + value.map { String(format: "%02x", $0) }.joined()
}
private func citizenCodecJSON(_ fields: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    guard let json = String(data: data, encoding: .utf8) else { throw CitizenSDKError(.invalidArgument, "Encoding fields are not UTF8") }
    return json
}

/// 只投影规范输入字段；不在Swift实现QR短键、Base64、SCALE或密码学计算。
public struct CitizenQRContent: Sendable, CustomStringConvertible {
    internal let inputJSON: String
    internal init(fields: [String: Any]) throws { inputJSON = try citizenCodecJSON(fields) }
    public var description: String { "CitizenQRContent" }
    public static func signRequest(action: UInt16, signerAccountID: String?, reviewPayload: Data, expiresAt: UInt64,
                                   requestID: String? = nil, requestIDPrefix: String = "") throws -> Self {
        try Self(fields: ["kind": 1, "request_id": requestID as Any? ?? NSNull(), "request_id_prefix": requestIDPrefix,
            "expires_at": String(expiresAt), "action": action, "signer_account_id": signerAccountID as Any? ?? NSNull(),
            "review_payload": citizenCodecHex(reviewPayload)])
    }
    public static func signResponse(requestID: String, expiresAt: UInt64, signerAccountID: String, signature: Data,
                                    currentAccountID: String? = nil, currentAccountSignature: Data? = nil) throws -> Self {
        try Self(fields: ["kind": 2, "request_id": requestID, "expires_at": String(expiresAt),
            "signer_account_id": signerAccountID, "signature": citizenCodecHex(signature),
            "current_account_id": currentAccountID as Any? ?? NSNull(),
            "current_account_signature": currentAccountSignature.map(citizenCodecHex) as Any? ?? NSNull()])
    }
    public static func userContact(cidNumber: String, accountID: String) throws -> Self {
        try Self(fields: ["kind": 3, "cid_number": cidNumber, "account_id": accountID])
    }
    public static func userTransfer(requestID: String, expiresAt: UInt64, accountID: String,
                                    amount: String, symbol: String, memo: String, bankCIDNumber: String) throws -> Self {
        try Self(fields: ["kind": 4, "request_id": requestID, "expires_at": String(expiresAt),
            "account_id": accountID, "amount": amount, "symbol": symbol, "memo": memo, "bank_cid_number": bankCIDNumber])
    }
    public static func accountDataKeyResponse(requestID: String, expiresAt: UInt64, signerAccountID: String,
                                              signature: Data, keyExchangePublicKey: Data, encryptionNonce: Data, ciphertext: Data) throws -> Self {
        try Self(fields: ["kind": 6, "request_id": requestID, "expires_at": String(expiresAt),
            "signer_account_id": signerAccountID, "signature": citizenCodecHex(signature),
            "key_exchange_public_key": citizenCodecHex(keyExchangePublicKey),
            "encryption_nonce": citizenCodecHex(encryptionNonce), "ciphertext": citizenCodecHex(ciphertext)])
    }
}

public enum CitizenQRAuthorizationReason: UInt8, Sendable {
    case valid = 0, invalidTemplate = 1, invalidAccountID = 2, sameAccount = 3
}
public struct CitizenQRAuthorization: Sendable {
    public let reason: CitizenQRAuthorizationReason
    public let genesisHash: String?
    public let cidNumber: String?
    public let currentAccountID: String?
    public let expectedBindingRevision: UInt64?
    public let expiresAt: UInt64?
    public let materializedPayload: Data?
    @_spi(CitizenSDKFlutter) public let coreJSON: String
    internal init(coreJSON: String) throws {
        struct Fields: Decodable {
            let reason: UInt8
            let genesis_hash: String?, cid_number: String?, current_account_id: String?
            let expected_binding_revision: String?, expires_at: String?, materialized_payload: String?
        }
        guard coreJSON.utf8.count <= 65_536,
              let reasonValue = try? JSONDecoder().decode(Fields.self, from: Data(coreJSON.utf8)),
              let reason = CitizenQRAuthorizationReason(rawValue: reasonValue.reason) else {
            throw CitizenSDKError(.integrity, "Authorization projection is invalid")
        }
        self.reason = reason; self.coreJSON = coreJSON
        func hex(_ text: String?, count: Int? = nil) throws -> String {
            guard let text, text.hasPrefix("0x"), text.utf8.count % 2 == 0,
                  count.map({ text.utf8.count == 2 + 2 * $0 }) ?? true,
                  text.utf8.dropFirst(2).allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw CitizenSDKError(.integrity, "Authorization byte field is invalid")
            }
            return text
        }
        if reason == .valid {
            genesisHash = try hex(reasonValue.genesis_hash, count: 32)
            guard let cid = reasonValue.cid_number, !cid.isEmpty,
                  let revisionText = reasonValue.expected_binding_revision,
                  let revision = UInt64(revisionText), String(revision) == revisionText,
                  let expiryText = reasonValue.expires_at, let expiry = UInt64(expiryText), String(expiry) == expiryText else {
                throw CitizenSDKError(.integrity, "Authorization facts are missing")
            }
            cidNumber = cid; expectedBindingRevision = revision; expiresAt = expiry
            currentAccountID = try reasonValue.current_account_id.map { try hex($0, count: 32) }
            let text = try hex(reasonValue.materialized_payload)
            guard text.count > 2, text.count <= 3842 else { throw CitizenSDKError(.integrity, "Authorization payload length is invalid") }
            let digits = Array(text.dropFirst(2)); var bytes = Data()
            for i in stride(from: 0, to: digits.count, by: 2) {
                guard let byte = UInt8(String(digits[i...i + 1]), radix: 16) else { throw CitizenSDKError(.integrity, "Authorization payload is invalid") }
                bytes.append(byte)
            }
            materializedPayload = bytes
        } else {
            guard reasonValue.genesis_hash == nil, reasonValue.cid_number == nil, reasonValue.current_account_id == nil,
                  reasonValue.expected_binding_revision == nil, reasonValue.expires_at == nil, reasonValue.materialized_payload == nil else {
                throw CitizenSDKError(.integrity, "Rejected authorization contains success facts")
            }
            genesisHash = nil; cidNumber = nil; currentAccountID = nil
            expectedBindingRevision = nil; expiresAt = nil; materializedPayload = nil
        }
    }
}

public struct CitizenSigningPayload: Sendable, CustomStringConvertible {
    internal let kind: UInt32
    internal let fieldsJSON: String
    internal let payloadBytes: Data
    private init(_ kind: UInt32, _ fields: [String: Any], _ bytes: Data = Data()) throws {
        self.kind = kind; fieldsJSON = try citizenCodecJSON(fields); payloadBytes = bytes
    }
    public var description: String { "CitizenSigningPayload" }
    public static func message(opTag: UInt8, scalePayload: Data) throws -> Self { try Self(1, ["op_tag": opTag], scalePayload) }
    public static func binaryPrefix(opTag: UInt8) throws -> Self { try Self(2, ["op_tag": opTag]) }
    public static func activateAdmin(cidNumber: String, institutionCode: Data, kind: UInt8, signerPublicKey: Data, timestamp: UInt64, nonce: Data) throws -> Self {
        try Self(3, ["cid_number": cidNumber, "institution_code": citizenCodecHex(institutionCode), "kind": kind,
            "signer_public_key": citizenCodecHex(signerPublicKey), "timestamp": String(timestamp), "nonce": citizenCodecHex(nonce)])
    }
    public static func decryptAdmin(cidNumber: String, signerPublicKey: Data, timestamp: UInt64, nonce: Data) throws -> Self {
        try Self(4, ["cid_number": cidNumber, "signer_public_key": citizenCodecHex(signerPublicKey),
            "timestamp": String(timestamp), "nonce": citizenCodecHex(nonce)])
    }
    public static func scaleString(_ value: String) throws -> Self { try Self(5, [:], Data(value.utf8)) }
    public static func u64Le(_ value: UInt64) throws -> Self { try Self(6, ["value": String(value)]) }
}

public enum CitizenQRScanPurpose: UInt8, Sendable {
    case coldAccountImport = 1, transferRecipient = 2, contact = 3, externalSignature = 4
    case signingRequest = 5, accountDataKey = 6, generalScan = 7, accountTarget = 8
}

public struct CitizenQRScanResult: Sendable, Equatable {
    public let purpose: CitizenQRScanPurpose
    public let document: CitizenQRDocument
    internal init(document: CitizenQRDocument, purpose: CitizenQRScanPurpose) throws {
        guard document.scanPurposeMask & (1 << (purpose.rawValue - 1)) != 0 else {
            throw CitizenSDKError(.invalidArgument, "QR code does not match scan purpose")
        }
        self.document = document; self.purpose = purpose
    }
}

/// 安全签名的完整结果；响应文档与二维码由同一次 Core 结果生成。
public struct CitizenQRSigned: Sendable, Equatable {
    public let document: CitizenQRDocument
    public let qrImage: CitizenQRImage
}

/// 字段只来自 Rust 展开结果，不解析 QR_V1 短键，也不在平台复算签名载荷。
public struct CitizenQRDocument: Sendable, Equatable {
    public enum Content: Sendable, Equatable {
        case signRequest(requestID: String, expiresAt: UInt64, action: UInt16,
                         signerAccountID: String?, reviewPayload: String)
        case signResponse(requestID: String, expiresAt: UInt64, signerAccountID: String, signature: String)
        case accountID(String)
        case userContact(cidNumber: String, accountID: String)
        case userTransfer(requestID: String, expiresAt: UInt64, accountID: String,
                          amount: String, symbol: String, memo: String, bankCIDNumber: String)
        case accountDataKeyResponse(requestID: String, expiresAt: UInt64, signerAccountID: String,
            signature: String, keyExchangePublicKey: String, encryptionNonce: String, ciphertext: String)
    }
    public let kind: UInt32
    public let canonicalText: String
    public let content: Content
    public let currentAccountID: String?
    public let currentAccountSignature: String?
    /// 仅签名成功结果携带原规范请求；普通解析结果不伪造关联信息。
    public let signRequest: String?
    internal let scanPurposeMask: UInt8
    @_spi(CitizenSDKFlutter) public let coreJSON: String
    internal var signedImage: CitizenQRImage?

    internal init(coreJSON: String) throws {
        let value = try CitizenSDKQrProjection.decode(coreJSON)
        self.coreJSON = coreJSON; kind = value.kind; canonicalText = value.canonical_text
        signRequest = value.sign_request
        guard (value.current_account_id == nil) == (value.current_account_signature == nil) else {
            throw CitizenSDKError(.integrity, "Current account proof is incomplete")
        }
        currentAccountID = try value.current_account_id.map { try value.hex($0, count: 32) }
        currentAccountSignature = try value.current_account_signature.map { try value.hex($0, count: 64) }
        guard value.scan_purpose_mask != 0 else { throw CitizenSDKError(.integrity, "Core QR scan purpose mask is empty") }
        scanPurposeMask = value.scan_purpose_mask
        if let expiration = value.expires_at {
            guard expiration > 0, expiration <= UInt64(Int64.max) else {
                throw CitizenSDKError(.integrity, "Core QR 时间不在统一正 i64 域内")
            }
        }
        switch kind {
        case 1:
            content = .signRequest(requestID: try value.required(value.request_id),
                expiresAt: try value.required(value.expires_at), action: try value.required(value.action),
                signerAccountID: try value.signer_account_id.map { try value.hex($0, count: 32) },
                reviewPayload: try value.hex(value.review_payload))
        case 2:
            content = .signResponse(requestID: try value.required(value.request_id),
                expiresAt: try value.required(value.expires_at),
                signerAccountID: try value.hex(value.signer_account_id, count: 32),
                signature: try value.hex(value.signature, count: 64))
        case 5: content = .accountID(try value.hex(value.account_id, count: 32))
        case 3: content = .userContact(cidNumber: try value.required(value.cid_number), accountID: try value.hex(value.account_id, count: 32))
        case 4: content = .userTransfer(requestID: try value.required(value.request_id), expiresAt: try value.required(value.expires_at),
            accountID: try value.hex(value.account_id, count: 32), amount: try value.required(value.amount),
            symbol: try value.required(value.symbol), memo: try value.required(value.memo), bankCIDNumber: try value.required(value.bank_cid_number))
        case 6: content = .accountDataKeyResponse(requestID: try value.required(value.request_id), expiresAt: try value.required(value.expires_at),
            signerAccountID: try value.hex(value.signer_account_id, count: 32), signature: try value.hex(value.signature, count: 64),
            keyExchangePublicKey: try value.hex(value.key_exchange_public_key, count: 32), encryptionNonce: try value.hex(value.encryption_nonce, count: 12),
            ciphertext: try value.hex(value.ciphertext))
        default: throw CitizenSDKError(.integrity, "Core QR kind is invalid")
        }
    }
}

/// 此模型只解码 Core 的可信输出结构，不是第二个二维码协议解析器。
internal struct CitizenSDKQrProjection: Decodable {
    let kind: UInt32
    let canonical_text: String
    let scan_purpose_mask: UInt8
    let cid_number: String?
    let amount: String?
    let symbol: String?
    let memo: String?
    let bank_cid_number: String?
    let key_exchange_public_key: String?
    let encryption_nonce: String?
    let ciphertext: String?
    let request_id: String?
    let expires_at: UInt64?
    let action: UInt16?
    let signer_account_id: String?
    let current_account_id: String?
    let current_account_signature: String?
    let review_payload: String?
    let signature: String?
    let account_id: String?
    let sign_request: String?
    let pallet_name: String?
    let call_name: String?
    let call_arguments: String?
    let genesis_hash: String?
    let spec_version: UInt32?
    let transaction_version: UInt32?
    let era: String?
    let nonce: String?
    let tip: String?
    let block_hash: String?

    static func decode(_ json: String) throws -> Self {
        let data = Data(json.utf8)
        guard !data.isEmpty, data.count <= 65_536 else { throw CitizenSDKError(.integrity, "Core QR JSON length is invalid") }
        do {
            let value = try JSONDecoder().decode(Self.self, from: data)
            guard !value.canonical_text.isEmpty, value.canonical_text.utf8.count <= 2_331 else {
                throw CitizenSDKError(.integrity, "Core QR canonical text is invalid")
            }
            return value
        } catch { throw CitizenSDKError(.integrity, "Core QR JSON is invalid") }
    }

    func required<T>(_ value: T?) throws -> T {
        guard let value else { throw CitizenSDKError(.integrity, "Core QR field is missing") }
        return value
    }

    func hex(_ value: String?, count: Int? = nil) throws -> String {
        let value = try required(value)
        let bytes = Array(value.utf8)
        guard bytes.count >= 2, bytes[0] == 48, bytes[1] == 120, bytes.count % 2 == 0,
              count.map({ bytes.count == 2 + $0 * 2 }) ?? true,
              bytes.dropFirst(2).allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw CitizenSDKError(.integrity, "Core QR byte field is invalid")
        }
        return value
    }

}

/// 同实例的不可变审阅事实；不生成标题、确认文字或显示排版。
public final class CitizenQRReview: @unchecked Sendable {
    public let document: CitizenQRDocument
    public let requestID: String
    public let signerAccountID: String
    public let expiresAt: UInt64
    public let palletName: String
    public let callName: String
    public let callArguments: String
    @_spi(CitizenSDKFlutter) public var coreJSON: String { document.coreJSON }
    private let lock = NSLock()
    private let owner: CitizenSDKNative
    private var result: UInt64
    private var released: ((CitizenQRReview) -> Void)?
    internal init(owner: CitizenSDKNative, result: UInt64, json: String) throws {
        let projection = try CitizenSDKQrProjection.decode(json)
        guard projection.kind == 1 else { throw CitizenSDKError(.integrity, "QR review is not a request") }
        document = try CitizenQRDocument(coreJSON: json)
        requestID = try projection.required(projection.request_id)
        signerAccountID = try projection.hex(projection.signer_account_id, count: 32)
        expiresAt = try projection.required(projection.expires_at)
        palletName = try projection.required(projection.pallet_name)
        callName = try projection.required(projection.call_name)
        callArguments = try projection.required(projection.call_arguments)
        _ = try projection.hex(projection.genesis_hash, count: 32)
        _ = try projection.hex(projection.block_hash, count: 32)
        _ = try projection.required(projection.spec_version)
        _ = try projection.required(projection.transaction_version)
        _ = try projection.required(projection.era)
        _ = try projection.required(projection.nonce)
        _ = try projection.required(projection.tip)
        self.owner = owner
        self.result = result
    }
    internal func withResult<T>(owner: CitizenSDKNative, _ body: (UInt64) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard self.owner === owner, result != 0 else { throw CitizenSDKError(.invalidState, "QR review is released or belongs to another SDK") }
        return try body(result)
    }
    internal func onRelease(_ handler: @escaping (CitizenQRReview) -> Void) {
        lock.lock(); defer { lock.unlock() }
        released = handler
    }
    public func release() throws {
        lock.lock()
        if result != 0 {
            do { try CitizenSDKChecks.requireOK(citizensdk_result_release(result), "QR review release failed") }
            catch { lock.unlock(); throw error }
            result = 0
        }
        let handler = released; released = nil; lock.unlock()
        handler?(self)
    }
    deinit { try? release() }
}

public struct CitizenQRImage: Sendable, Equatable {
    public let width: UInt32
    public let height: UInt32
    public let luminance: Data
}
