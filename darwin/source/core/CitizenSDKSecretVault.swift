import Foundation
import LocalAuthentication
import Security

internal enum CitizenSDKVaultAvailability: UInt32 {
    case available = 1
    case noStrongUserAuthentication = 2
    case unsupported = 3
    case unavailable = 4
}

/// Owns one accepted asynchronous vault borrow until its first terminal
/// completion. The C ABI guarantees the Rust output allocation remains valid
/// until that callback. Keeping the raw pointer and non-Sendable completion
/// inside this lock-protected unchecked owner prevents them from being captured
/// independently by a Dispatch queue.
internal final class CitizenSDKAcceptedVaultOperation: @unchecked Sendable {
    private let lock = NSLock()
    private let output: UnsafeMutableRawBufferPointer
    private let releasePending: () -> Void
    private let completion: (CitizenSDKErrorCode) -> Void
    private var finished = false

    init(output: UnsafeMutableRawBufferPointer,
         releasePending: @escaping () -> Void,
         completion: @escaping (CitizenSDKErrorCode) -> Void) {
        self.output = output
        self.releasePending = releasePending
        self.completion = completion
    }

    func copyDEK(_ bytes: UnsafeRawBufferPointer) throws {
        guard bytes.count == 32, let source = bytes.baseAddress,
              output.count == 32, let destination = output.baseAddress else {
            throw CitizenSDKError(.integrity, "vault DEK copy length is invalid")
        }
        destination.copyMemory(from: source, byteCount: 32)
    }

    func finish(_ code: CitizenSDKErrorCode) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        lock.unlock()
        if code != .ok { output.initializeMemory(as: UInt8.self, repeating: 0) }
        releasePending()
        completion(code)
    }
}

/// Secure Enclave generation-scoped KEK service.
///
/// The enclave never signs sr25519 and never receives a mnemonic, mini-secret,
/// private key, or account child secret. It only wraps/unwraps one random
/// 32-byte DEK whose authenticated secret envelope remains owned by Rust.
internal final class CitizenSDKSecretVault: @unchecked Sendable {
    private static let dekBytes = 32
    private let secureStore: CitizenSDKSecureStore
    private let applicationID: String
    private let queue = DispatchQueue(label: "org.citizen.sdk.apple-vault", qos: .userInitiated)
    private let operationLock = NSLock()
    private var pendingAuthentications: Set<UInt64> = []
    private var authenticationContexts: [UInt64: LAContext] = [:]
    private var cancelledAuthentications: Set<UInt64> = []

    /// 必须同时匹配实际 unwrap 与该 LAContext，不能用任意系统认证作为本视图的豁免。
    func isAuthenticationActive(_ operationID: UInt64) -> Bool {
        operationLock.lock(); defer { operationLock.unlock() }
        return authenticationContexts[operationID] != nil && !cancelledAuthentications.contains(operationID)
    }

    func cancelAuthentication(_ operationID: UInt64) {
        operationLock.lock()
        cancelledAuthentications.insert(operationID)
        let context = authenticationContexts[operationID]
        operationLock.unlock()
        // 仅撤销本次设备认证；不提前结束 accepted，也不释放 Rust 的借用输出。
        context?.invalidate()
    }
    func releasePrivateKeyAuthentication(_ operationID: UInt64) {
        operationLock.lock(); defer { operationLock.unlock() }
        cancelledAuthentications.remove(operationID)
    }

    init(secureStore: CitizenSDKSecureStore, applicationID: String) throws {
        self.applicationID = try CitizenSDKRecordKey.applicationID(applicationID)
        self.secureStore = secureStore
    }

    func availability() -> CitizenSDKVaultAvailability {
        #if targetEnvironment(simulator)
        return .unsupported
        #elseif os(macOS) && arch(x86_64)
        return .unsupported
        #else
        var error: Unmanaged<CFError>?
        guard SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
            &error
        ) != nil else { return .unavailable }
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 0
        var evaluationError: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &evaluationError) {
            return .available
        }
        switch LAError.Code(rawValue: evaluationError?.code ?? -1) {
        case .biometryNotEnrolled, .biometryLockout: return .noStrongUserAuthentication
        case .biometryNotAvailable: return .unsupported
        default: return .unavailable
        }
        #endif
    }

    func ensureWalletKEK(walletIndex: UInt32, generation: Data, provisioningOperationID: Data) throws {
        try secureStore.withVaultLock {
            try ensureWalletKEKLocked(walletIndex: walletIndex, generation: generation,
                                      provisioningOperationID: provisioningOperationID)
        }
    }

    private func ensureWalletKEKLocked(walletIndex: UInt32, generation: Data,
                                       provisioningOperationID: Data) throws {
        try CitizenSDKChecks.require(walletIndex == 0, "only wallet index 0 is supported")
        try CitizenSDKChecks.require(generation.count == 16 && provisioningOperationID.count == 16,
                                     "wallet KEK identity is malformed")
        guard try secureStore.ensureGeneration(walletIndex: walletIndex, generation: generation,
                                               operationID: provisioningOperationID) else {
            throw CitizenSDKError(.keyInvalidated, "wallet generation is retired or owned by another provisioning operation")
        }
        if let key = try copyPrivateKey(walletIndex: walletIndex, generation: generation,
                                        context: nil, allowInteraction: false) {
            try requireSecureEnclaveKey(key)
            return
        }
        guard availability() == .available else {
            throw CitizenSDKError(.authenticationRequired, "Secure Enclave strong biometric protection is unavailable")
        }
        try createPrivateKey(walletIndex: walletIndex, generation: generation)
    }


    /// 只枚举属性，不读取钥或触发授权；未知SDK别名/系统错误不能被解释为没有钥。
    func hasAnyWalletKey(walletIndex: UInt32) throws -> Bool {
        try secureStore.withVaultLock {
            var known: [Data: UInt32] = [:]
            for (index, generation) in try secureStore.vaultGenerations() {
                let tag = try CitizenSDKRecordKey.keychainTag(applicationID: applicationID, walletIndex: index, generation: generation)
                guard known.updateValue(index, forKey: tag) == nil else {
                    throw CitizenSDKError(.integrity, "金库别名重复")
                }
            }
            let context = LAContext()
            context.interactionNotAllowed = true
            let query: [CFString: Any] = [
                kSecClass: kSecClassKey,
                kSecAttrKeyClass: kSecAttrKeyClassPrivate,
                kSecAttrSynchronizable: kSecAttrSynchronizableAny,
                kSecReturnAttributes: true,
                kSecMatchLimit: NSNumber(value: 65537),
                kSecUseAuthenticationContext: context,
            ]
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { return false }
            guard status == errSecSuccess else { throw mapStatus(status, fallback: "金库存在性枚举失败") }
            guard let values = result as? [[String: Any]], values.count <= 65536 else {
                throw CitizenSDKError(.integrity, "金库枚举结果边界无效")
            }
            let tags = values.compactMap { $0[kSecAttrApplicationTag as String] as? Data }
            return try Self.walletKeyPresent(walletIndex: walletIndex, known: known, tags: tags)
        }
    }

    /// 与生产枚举共用归属判断，有限测试只替换系统返回的非秘密属性。
    static func walletKeyPresent(walletIndex: UInt32, known: [Data: UInt32], tags: [Data]) throws -> Bool {
        guard tags.count <= 65536 else { throw CitizenSDKError(.integrity, "金库枚举结果超限") }
        let prefix = Data("citizensdk_wallet_".utf8)
        for tag in tags where tag.starts(with: prefix) {
            guard let index = known[tag] else { throw CitizenSDKError(.integrity, "存在无法归属的SDK物理钥") }
            if index == walletIndex { return true }
        }
        return false
    }

    func hasWalletKEK(walletIndex: UInt32, generation: Data) throws -> Bool {
        try secureStore.withVaultLock {
            guard try secureStore.isGenerationActive(walletIndex: walletIndex, generation: generation) else { return false }
            guard let key = try copyPrivateKey(walletIndex: walletIndex, generation: generation,
                                               context: nil, allowInteraction: false) else { return false }
            try requireSecureEnclaveKey(key)
            return true
        }
    }

    /// Encrypts directly from the exact Rust-owned borrowed DEK view.
    func wrapDEK(walletIndex: UInt32, generation: Data, provisioningOperationID: Data,
                 plaintext: UnsafeRawBufferPointer) throws -> Data {
        try CitizenSDKChecks.require(plaintext.count == Self.dekBytes && plaintext.baseAddress != nil,
                                     "DEK must be an exact Rust-owned 32-byte view")
        return try secureStore.withVaultLock {
            // 追加只使用原钥；创建所有权由独立初始化步骤验证，封装绝不重新创建钥。
            try CitizenSDKChecks.require(walletIndex == 0 && generation.count == 16 &&
                                         provisioningOperationID.count == 16, "wallet KEK identity is malformed")
            guard try secureStore.isGenerationActive(walletIndex: walletIndex, generation: generation) else {
                throw CitizenSDKError(.keyInvalidated, "wallet generation is not active")
            }
            guard let privateKey = try copyPrivateKey(walletIndex: walletIndex, generation: generation,
                                                      context: nil, allowInteraction: false),
                  let publicKey = SecKeyCopyPublicKey(privateKey) else {
                throw CitizenSDKError(.keyInvalidated, "wallet KEK is unavailable")
            }
            try requireSecureEnclaveKey(privateKey)
            let algorithm = SecKeyAlgorithm.eciesEncryptionCofactorX963SHA256AESGCM
            guard SecKeyIsAlgorithmSupported(publicKey, .encrypt, algorithm) else {
                throw CitizenSDKError(.unsupported, "Secure Enclave ECIES wrapping is unavailable")
            }
            let borrowed = Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: plaintext.baseAddress!),
                                count: plaintext.count, deallocator: .none) as CFData
            var failure: Unmanaged<CFError>?
            guard let wrapped = SecKeyCreateEncryptedData(publicKey, algorithm, borrowed, &failure) else {
                throw mapSecurityError(failure?.takeRetainedValue(), fallback: "wallet DEK wrapping failed")
            }
            return wrapped as Data
        }
    }

    /// 一次整批追加仅执行系统生物认证，不解封既有账户，也不保留成功状态。
    func authorizeAddAccounts(operationID: UInt64, walletIndex: UInt32, generation: Data,
                              provisioningOperationID: Data,
                              completion: @escaping (CitizenSDKErrorCode) -> Void) throws {
        try CitizenSDKChecks.require(operationID != 0 && generation.count == 16 &&
            provisioningOperationID.count == 16 && provisioningOperationID.contains(where: { $0 != 0 }),
            "追加认证身份无效")
        guard try hasWalletKEK(walletIndex: walletIndex, generation: generation) else {
            throw CitizenSDKError(.keyInvalidated, "wallet KEK is unavailable")
        }
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 0
        context.localizedFallbackTitle = ""
        operationLock.lock()
        guard pendingAuthentications.insert(operationID).inserted else {
            operationLock.unlock()
            throw CitizenSDKError(.conflict, "duplicate vault operation identity")
        }
        operationLock.unlock()
        let accepted = CitizenSDKAcceptedVaultOperation(
            output: UnsafeMutableRawBufferPointer(start: nil, count: 0),
            releasePending: { [self] in
                self.operationLock.lock()
                self.pendingAuthentications.remove(operationID)
                self.operationLock.unlock()
                context.invalidate()
            }, completion: completion)
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: "验证身份以添加本批账户") { [self, accepted] success, failure in
            guard success else {
                let code = (failure as? LAError)?.code
                accepted.finish(code == .userCancel || code == .appCancel || code == .systemCancel
                    ? .authenticationCancelled : .authenticationRequired)
                return
            }
            do {
                guard try self.hasWalletKEK(walletIndex: walletIndex, generation: generation) else {
                    accepted.finish(.keyInvalidated); return
                }
                accepted.finish(.ok)
            } catch let failure as CitizenSDKError { accepted.finish(failure.code) }
            catch { accepted.finish(.internalFailure) }
        }
    }

    /// Authenticates once and copies the DEK straight into Rust-owned output.
    /// The temporary CFData returned by Security.framework is released in the
    /// same autorelease scope; no plaintext reaches Swift/Dart public APIs.
    func unwrapDEK(operationID: UInt64, walletIndex: UInt32, generation: Data,
                   wrapped: Data, output: UnsafeMutableRawBufferPointer,
                   completion: @escaping (CitizenSDKErrorCode) -> Void) throws {
        try CitizenSDKChecks.require(output.count == Self.dekBytes && output.baseAddress != nil,
                                     "DEK output must be an exact Rust-owned 32-byte view")
        operationLock.lock()
        guard pendingAuthentications.insert(operationID).inserted else {
            operationLock.unlock()
            throw CitizenSDKError(.conflict, "duplicate vault operation identity")
        }
        operationLock.unlock()

        let accepted = CitizenSDKAcceptedVaultOperation(
            output: output,
            releasePending: { [self] in
            self.operationLock.lock()
            _ = self.pendingAuthentications.remove(operationID)
            self.authenticationContexts.removeValue(forKey: operationID)
            self.operationLock.unlock()
            },
            completion: completion
        )

        queue.async { [self, accepted] in
            autoreleasepool {
                do {
                    guard try self.hasWalletKEK(walletIndex: walletIndex, generation: generation) else {
                        throw CitizenSDKError(.keyInvalidated, "wallet KEK is unavailable")
                    }
                    let context = LAContext()
                    context.localizedReason = "授权 CitizenSDK 钱包操作以继续"
                    context.touchIDAuthenticationAllowableReuseDuration = 0
                    self.operationLock.lock()
                    let cancelled = self.cancelledAuthentications.contains(operationID)
                    if !cancelled { self.authenticationContexts[operationID] = context }
                    self.operationLock.unlock()
                    guard !cancelled else { throw CitizenSDKError(.authenticationCancelled, "private key authentication was cancelled") }
                    guard let key = try self.copyPrivateKey(walletIndex: walletIndex, generation: generation,
                                                            context: context, allowInteraction: true) else {
                        throw CitizenSDKError(.keyInvalidated, "wallet KEK is unavailable")
                    }
                    let algorithm = SecKeyAlgorithm.eciesEncryptionCofactorX963SHA256AESGCM
                    guard SecKeyIsAlgorithmSupported(key, .decrypt, algorithm) else {
                        throw CitizenSDKError(.unsupported, "Secure Enclave ECIES unwrapping is unavailable")
                    }
                    var failure: Unmanaged<CFError>?
                    guard let decrypted = SecKeyCreateDecryptedData(key, algorithm, wrapped as CFData, &failure) else {
                        throw self.mapSecurityError(failure?.takeRetainedValue(), fallback: "wallet DEK unwrapping failed")
                    }
                    // Security.framework owns this immutable CFData until the
                    // surrounding autoreleasepool drains; it cannot be
                    // reliably zeroed in place. Avoid a bridged Swift Data/COW
                    // copy and move its 32 bytes immediately into Rust output.
                    let count = CFDataGetLength(decrypted)
                    guard count == Self.dekBytes, let bytes = CFDataGetBytePtr(decrypted) else {
                        throw CitizenSDKError(.integrity, "unwrapped DEK length is invalid")
                    }
                    try accepted.copyDEK(UnsafeRawBufferPointer(start: bytes, count: count))
                    accepted.finish(.ok)
                } catch let failure as CitizenSDKError {
                    accepted.finish(failure.code)
                } catch {
                    accepted.finish(.internalFailure)
                }
            }
        }
    }

    func retireWalletKEK(walletIndex: UInt32, generation: Data, cleanupOperationID: Data) throws {
        try CitizenSDKChecks.require(generation.count == 16 && cleanupOperationID.count == 16,
                                     "wallet KEK retirement identity is malformed")
        // The durable tombstone is the irreversible commit point. A crash or
        // late ensure can never resurrect this generation.
        try secureStore.withVaultLock {
            try secureStore.retireGeneration(walletIndex: walletIndex, generation: generation,
                                             operationID: cleanupOperationID)
            let tag = try CitizenSDKRecordKey.keychainTag(applicationID: applicationID, walletIndex: walletIndex, generation: generation)
            let status = SecItemDelete(keyQuery(tag: tag, context: nil, allowInteraction: false) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw CitizenSDKError(.storage, "retired wallet KEK could not be removed from Keychain")
            }
        }
    }

    private func createPrivateKey(walletIndex: UInt32, generation: Data) throws {
        let tag = try CitizenSDKRecordKey.keychainTag(applicationID: applicationID, walletIndex: walletIndex, generation: generation)
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
            &accessError
        ) else {
            throw mapSecurityError(accessError?.takeRetainedValue(), fallback: "wallet KEK access control failed")
        }
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent: true,
                kSecAttrApplicationTag: tag,
                kSecAttrAccessControl: access,
                kSecAttrSynchronizable: false,
            ],
        ]
        var failure: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &failure) else {
            throw mapSecurityError(failure?.takeRetainedValue(), fallback: "Secure Enclave wallet KEK creation failed")
        }
        try requireSecureEnclaveKey(key)
    }

    private func copyPrivateKey(walletIndex: UInt32, generation: Data, context: LAContext?,
                                allowInteraction: Bool) throws -> SecKey? {
        let tag = try CitizenSDKRecordKey.keychainTag(applicationID: applicationID, walletIndex: walletIndex, generation: generation)
        var query = keyQuery(tag: tag, context: context, allowInteraction: allowInteraction)
        query[kSecReturnRef] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let key = result as! SecKey? else {
            throw mapStatus(status, fallback: "wallet KEK lookup failed")
        }
        return key
    }

    private func keyQuery(tag: Data, context: LAContext?, allowInteraction: Bool) -> [CFString: Any] {
        var query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag: tag,
            kSecAttrSynchronizable: false,
        ]
        let authentication = context ?? LAContext()
        authentication.interactionNotAllowed = !allowInteraction
        authentication.touchIDAuthenticationAllowableReuseDuration = 0
        query[kSecUseAuthenticationContext] = authentication
        return query
    }

    private func requireSecureEnclaveKey(_ key: SecKey) throws {
        guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
              attributes[kSecAttrTokenID] as? String == (kSecAttrTokenIDSecureEnclave as String) else {
            throw CitizenSDKError(.unavailable, "wallet KEK is not Secure Enclave backed")
        }
    }

    private func mapSecurityError(_ error: CFError?, fallback: String) -> CitizenSDKError {
        guard let error else { return CitizenSDKError(.internalFailure, fallback) }
        return mapStatus(OSStatus(CFErrorGetCode(error)), fallback: fallback)
    }

    private func mapStatus(_ status: OSStatus, fallback: String) -> CitizenSDKError {
        switch status {
        case errSecUserCanceled: return CitizenSDKError(.authenticationCancelled, fallback)
        case errSecAuthFailed, errSecInteractionNotAllowed: return CitizenSDKError(.authenticationRequired, fallback)
        case errSecItemNotFound: return CitizenSDKError(.keyInvalidated, fallback)
        case errSecNotAvailable, errSecUnimplemented: return CitizenSDKError(.unavailable, fallback)
        default: return CitizenSDKError(.internalFailure, fallback)
        }
    }
}
