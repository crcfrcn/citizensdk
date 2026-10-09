import Foundation

/// 按模块延迟拥有 Apple 类型化存储与 KEK/DEK 金库，不创建未选择的系统资源。
/// 核心在创建时复制回调表；上下文借用和已打开资源一直存活到核心成功销毁。
internal final class CitizenSDKHostBridge {
    private let modules: CitizenSDKModules
    private let base: URL
    private let applicationID: String
    private let resourceLock = NSRecursiveLock()
    private var publicStoreValue: CitizenSDKPublicStore?
    private var secureStoreValue: CitizenSDKSecureStore?
    private var vaultValue: CitizenSDKSecretVault?
    private var privateKeyAuthentications: [UInt64: Bool] = [:]
    private var publicVTable = citizensdk_host_public_store_v1_t()
    private var secureVTable = citizensdk_host_secure_store_v1_t()
    private var vaultVTable = citizensdk_host_secret_vault_v1_t()

    init(root: URL? = nil, applicationID: String? = Bundle.main.bundleIdentifier,
         modules: CitizenSDKModules = .full) throws {
        // 构造仅保存身份和路径，不创建文件、不探测硬件；核心先校验模块，再调用所需资源。
        self.applicationID = try CitizenSDKRecordKey.applicationID(applicationID)
        self.base = try root ?? Self.defaultRoot(applicationID: self.applicationID)
        self.modules = modules
        configureVTables()
    }

    deinit {
        publicStoreValue?.close()
        secureStoreValue?.close()
    }

    private func publicStore() throws -> CitizenSDKPublicStore {
        resourceLock.lock(); defer { resourceLock.unlock() }
        guard modules.contains(.chain) || modules.contains(.history) else {
            throw CitizenSDKError(.unsupported, "public store is not selected")
        }
        if let value = publicStoreValue { return value }
        try prepareStorageRoot()
        let value = try CitizenSDKPublicStore(directory: base.appendingPathComponent("public", isDirectory: true))
        publicStoreValue = value
        return value
    }

    private func secureStore() throws -> CitizenSDKSecureStore {
        resourceLock.lock(); defer { resourceLock.unlock() }
        guard modules.usesSecrets else { throw CitizenSDKError(.unsupported, "secure store is not selected") }
        if let value = secureStoreValue { return value }
        try prepareStorageRoot()
        let value = try CitizenSDKSecureStore(directory: base.appendingPathComponent("secure", isDirectory: true))
        secureStoreValue = value
        return value
    }

    /// 保留既有备份隔离，但只有实际启用持久化资源后才创建目录。
    private func prepareStorageRoot() throws {
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var root = base
        try root.setResourceValues(values)
    }

    private func vault() throws -> CitizenSDKSecretVault {
        resourceLock.lock(); defer { resourceLock.unlock() }
        if let value = vaultValue { return value }
        let value = try CitizenSDKSecretVault(secureStore: secureStore(), applicationID: applicationID)
        vaultValue = value
        return value
    }

    func isAuthenticationActive(_ operationID: UInt64) -> Bool {
        resourceLock.lock()
        let allowed = privateKeyAuthentications[operationID] == false
        let value = vaultValue
        resourceLock.unlock()
        return allowed && (value?.isAuthenticationActive(operationID) ?? false)
    }
    func cancelAuthentication(_ operationID: UInt64) {
        resourceLock.lock()
        guard privateKeyAuthentications[operationID] != nil else { resourceLock.unlock(); return }
        privateKeyAuthentications[operationID] = true
        let value = vaultValue
        resourceLock.unlock()
        value?.cancelAuthentication(operationID)
    }
    func registerPrivateKeyAuthentication(_ operationID: UInt64) -> Int32 {
        resourceLock.lock(); defer { resourceLock.unlock() }
        guard operationID != 0, privateKeyAuthentications[operationID] == nil else { return CitizenSDKErrorCode.integrity.rawValue }
        privateKeyAuthentications[operationID] = false
        return 0
    }
    func releasePrivateKeyAuthentication(_ operationID: UInt64) {
        resourceLock.lock()
        privateKeyAuthentications.removeValue(forKey: operationID)
        let value = vaultValue
        resourceLock.unlock()
        value?.releasePrivateKeyAuthentication(operationID)
    }

    func withServices<T>(_ body: (UnsafePointer<citizensdk_host_services_v1_t>) throws -> T) rethrows -> T {
        try withUnsafePointer(to: &publicVTable) { publicPointer in
            try withUnsafePointer(to: &secureVTable) { securePointer in
                try withUnsafePointer(to: &vaultVTable) { vaultPointer in
                    var services = citizensdk_host_services_v1_t()
                    services.struct_size = UInt32(MemoryLayout<citizensdk_host_services_v1_t>.size)
                    services.abi_version = 1
                    services.public_store = (modules.contains(.chain) || modules.contains(.history)) ? publicPointer : nil
                    services.secure_store = modules.usesSecrets ? securePointer : nil
                    services.secret_vault = modules.usesSecrets ? vaultPointer : nil
                    return try withUnsafePointer(to: &services, body)
                }
            }
        }
    }

    func registerSecretPresence(handle: UInt64) throws {
        guard modules.usesSecrets else { return }
        var provider = citizensdk_host_secret_presence_v1_t()
        provider.struct_size = UInt32(MemoryLayout<citizensdk_host_secret_presence_v1_t>.size)
        provider.abi_version = 1
        provider.context = Unmanaged.passUnretained(self).toOpaque()
        provider.has_account_secret = citizenSDKAccountSecretPresence
        provider.has_any_wallet_key = citizenSDKWalletKeyPresence
        try CitizenSDKChecks.requireOK(citizensdk_set_secret_presence_provider(handle, &provider), "秘密存在性提供者登记失败")
    }

    func hasAccountSecret(_ accountID: Data) throws -> Bool { try secureStore().hasAccountSecret(accountID: accountID) }
    func hasAnyWalletKey(_ walletIndex: UInt32) throws -> Bool { try vault().hasAnyWalletKey(walletIndex: walletIndex) }

    private func configureVTables() {
        let context = Unmanaged.passUnretained(self).toOpaque()
        publicVTable.struct_size = UInt32(MemoryLayout<citizensdk_host_public_store_v1_t>.size)
        publicVTable.abi_version = 1
        publicVTable.context = context
        publicVTable.chain_database_load = citizenSDKChainDatabaseLoad
        publicVTable.chain_database_compare_and_swap = citizenSDKChainDatabaseCAS
        publicVTable.runtime_cache_load = citizenSDKRuntimeCacheLoad
        publicVTable.runtime_cache_store = citizenSDKRuntimeCacheStore
        publicVTable.runtime_cache_delete = citizenSDKRuntimeCacheDelete
        if modules.contains(.history) {
            publicVTable.transaction_history_query = citizenSDKTransactionHistoryQuery
            publicVTable.transaction_history_mutate = citizenSDKTransactionHistoryMutate
        }

        secureVTable.struct_size = UInt32(MemoryLayout<citizensdk_host_secure_store_v1_t>.size)
        secureVTable.abi_version = 1
        secureVTable.context = context
        secureVTable.wallet_profile_load = citizenSDKWalletProfileLoad
        secureVTable.wallet_profile_compare_and_swap = citizenSDKWalletProfileCAS
        secureVTable.encrypted_secret_blob_load = citizenSDKEncryptedSecretLoad
        secureVTable.encrypted_secret_blob_compare_and_swap = citizenSDKEncryptedSecretCAS

        vaultVTable.struct_size = UInt32(MemoryLayout<citizensdk_host_secret_vault_v1_t>.size)
        vaultVTable.abi_version = 1
        vaultVTable.context = context
        vaultVTable.availability = citizenSDKVaultAvailability
        vaultVTable.ensure_wallet_kek = citizenSDKVaultEnsure
        vaultVTable.has_wallet_kek = citizenSDKVaultHas
        vaultVTable.wrap_dek = citizenSDKVaultWrap
        vaultVTable.unwrap_dek = citizenSDKVaultUnwrap
        vaultVTable.retire_wallet_kek = citizenSDKVaultRetire
        vaultVTable.authorize_add_accounts = citizenSDKVaultAuthorizeAddAccounts
    }

    static func storageRoot(applicationSupport: URL, applicationID: String?) throws -> URL {
        let applicationID = try CitizenSDKRecordKey.applicationID(applicationID)
        return applicationSupport.appendingPathComponent(applicationID, isDirectory: true)
            .appendingPathComponent("citizensdk/v1", isDirectory: true)
    }

    private static func defaultRoot(applicationID: String) throws -> URL {
        guard let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory,
                                                                 in: .userDomainMask).first else {
            throw CitizenSDKError(.storage, "Apple application-support directory is unavailable")
        }
        // 沙盒外的 macOS Application Support 由同用户共享，必须先按宿主分区。
        let root = try storageRoot(applicationSupport: applicationSupport, applicationID: applicationID)
        return root
    }

    fileprivate func chainLoad() throws -> CitizenSDKHostRecord { try publicStore().chainDatabaseLoad() }
    fileprivate func chainCAS(expected: UInt64, candidate: Data) throws -> CitizenSDKHostRecord {
        try publicStore().chainDatabaseCAS(expected: expected, candidate: candidate)
    }
    fileprivate func runtimeLoad(hash: Data) throws -> CitizenSDKHostRecord { try publicStore().runtimeCacheLoad(hash: hash) }
    fileprivate func runtimeStore(hash: Data, candidate: Data) throws { try publicStore().runtimeCacheStore(hash: hash, candidate: candidate) }
    fileprivate func runtimeDelete(hash: Data) throws { try publicStore().runtimeCacheDelete(hash: hash) }
    fileprivate func historyQuery(_ query: Data) throws -> CitizenSDKHostRecord {
        try publicStore().transactionHistoryQuery(query)
    }
    fileprivate func historyMutate(expected: UInt64, mutation: Data) throws -> CitizenSDKHostRecord {
        try publicStore().transactionHistoryMutate(expected: expected, bytes: mutation)
    }
    fileprivate func profileLoad() throws -> CitizenSDKHostRecord { try secureStore().walletProfileLoad() }
    fileprivate func profileCAS(expected: UInt64, candidate: Data) throws -> CitizenSDKHostRecord {
        try secureStore().walletProfileCAS(expected: expected, candidate: candidate)
    }
    fileprivate func secretLoad(_ identity: CitizenSDKHostSecretIdentity) throws -> CitizenSDKHostRecord {
        try secureStore().encryptedSecretLoad(walletIndex: identity.walletIndex, kind: identity.kind,
                                            generation: identity.generation, owner: identity.owner,
                                            accountID: identity.accountID)
    }
    fileprivate func secretCAS(_ identity: CitizenSDKHostSecretIdentity, expected: UInt64,
                               candidate: Data) throws -> CitizenSDKHostRecord {
        try secureStore().encryptedSecretCAS(walletIndex: identity.walletIndex, kind: identity.kind,
                                           generation: identity.generation, owner: identity.owner,
                                           accountID: identity.accountID, expected: expected, candidate: candidate)
    }
    fileprivate func vaultAvailability() -> CitizenSDKVaultAvailability { (try? vault().availability()) ?? .unavailable }
    fileprivate func vaultEnsure(_ key: CitizenSDKHostWalletKey, operationID: Data) throws {
        try vault().ensureWalletKEK(walletIndex: key.walletIndex, generation: key.generation,
                                  provisioningOperationID: operationID)
    }
    fileprivate func vaultHas(_ key: CitizenSDKHostWalletKey) throws -> Bool {
        try vault().hasWalletKEK(walletIndex: key.walletIndex, generation: key.generation)
    }
    fileprivate func vaultWrap(_ key: CitizenSDKHostWalletKey, operationID: Data,
                               plaintext: UnsafeRawBufferPointer) throws -> Data {
        try vault().wrapDEK(walletIndex: key.walletIndex, generation: key.generation,
                          provisioningOperationID: operationID, plaintext: plaintext)
    }
    fileprivate func vaultAuthorizeAddAccounts(hostOperationID: UInt64, key: CitizenSDKHostWalletKey,
        operationID: Data, completion: @escaping (CitizenSDKErrorCode) -> Void) throws {
        try vault().authorizeAddAccounts(operationID: hostOperationID, walletIndex: key.walletIndex,
            generation: key.generation, provisioningOperationID: operationID, completion: completion)
    }
    fileprivate func vaultUnwrap(hostOperationID: UInt64, key: CitizenSDKHostWalletKey,
                                 wrapped: Data, output: UnsafeMutableRawBufferPointer,
                                 completion: @escaping (CitizenSDKErrorCode) -> Void) throws {
        // 持有短资源锁完成实际 Vault 的登记，防止取消落在“已通知但尚未派发”的窗口。
        resourceLock.lock(); defer { resourceLock.unlock() }
        guard privateKeyAuthentications[hostOperationID] != true else {
            throw CitizenSDKError(.authenticationCancelled, "private key authentication was cancelled")
        }
        try vault().unwrapDEK(operationID: hostOperationID, walletIndex: key.walletIndex,
                            generation: key.generation, wrapped: wrapped, output: output,
                            completion: completion)
    }
    fileprivate func vaultRetire(_ key: CitizenSDKHostWalletKey, operationID: Data) throws {
        try vault().retireWalletKEK(walletIndex: key.walletIndex, generation: key.generation,
                                  cleanupOperationID: operationID)
    }
}

fileprivate struct CitizenSDKHostWalletKey {
    let walletIndex: UInt32
    let generation: Data
}

fileprivate struct CitizenSDKHostSecretIdentity {
    let walletIndex: UInt32
    let kind: UInt32
    let generation: Data
    let owner: Data
    let accountID: Data
}

private func citizenSDKHost(_ context: UnsafeMutableRawPointer?) -> CitizenSDKHostBridge? {
    context.map { Unmanaged<CitizenSDKHostBridge>.fromOpaque($0).takeUnretainedValue() }
}

private func citizenSDKData(_ view: citizensdk_bytes_view_t) throws -> Data {
    if view.len == 0 { return Data() }
    guard let data = view.data, view.len <= UInt64(Int.max) else {
        throw CitizenSDKError(.invalidArgument, "host byte view is malformed")
    }
    return Data(bytes: data, count: Int(view.len))
}

private func citizenSDKFixedData<T>(_ value: T, count: Int) -> Data {
    withUnsafeBytes(of: value) { Data($0.prefix(count)) }
}

private func citizenSDKWalletKey(_ value: citizensdk_host_wallet_key_ref_v1_t) throws -> CitizenSDKHostWalletKey {
    try CitizenSDKChecks.require(value.struct_size >= UInt32(MemoryLayout<citizensdk_host_wallet_key_ref_v1_t>.size) && value.abi_version == 1,
                                 "wallet key reference ABI is invalid")
    return CitizenSDKHostWalletKey(walletIndex: value.wallet_index,
                                   generation: citizenSDKFixedData(value.generation.bytes, count: 16))
}

private func citizenSDKSecret(_ value: citizensdk_host_secret_ref_v1_t) throws -> CitizenSDKHostSecretIdentity {
    try CitizenSDKChecks.require(value.struct_size >= UInt32(MemoryLayout<citizensdk_host_secret_ref_v1_t>.size) && value.abi_version == 1,
                                 "secret reference ABI is invalid")
    return CitizenSDKHostSecretIdentity(
        walletIndex: value.wallet_index,
        kind: value.kind,
        generation: citizenSDKFixedData(value.generation.bytes, count: 16),
        owner: citizenSDKFixedData(value.owner.bytes, count: 16),
        accountID: citizenSDKFixedData(value.account_id.bytes, count: 32)
    )
}

private func citizenSDKCompleteRecord(_ operationID: UInt64, _ sdkContext: UnsafeMutableRawPointer?,
                                      _ completion: citizensdk_host_record_completion_v1_t?,
                                      _ record: CitizenSDKHostRecord) {
    var result = citizensdk_host_record_result_v1_t()
    result.struct_size = UInt32(MemoryLayout<citizensdk_host_record_result_v1_t>.size)
    result.abi_version = 1
    result.host_operation_id = operationID
    result.error_code = record.errorCode.rawValue
    result.domain = record.domain.rawValue
    result.present = record.errorCode == .ok && record.present ? 1 : 0
    result.revision = record.errorCode == .ok ? record.revision : 0
    guard let bytes = record.record, result.present == 1 else {
        completion?(sdkContext, &result)
        return
    }
    bytes.withUnsafeBytes { buffer in
        result.record.data = buffer.bindMemory(to: UInt8.self).baseAddress
        result.record.len = UInt64(buffer.count)
        completion?(sdkContext, &result)
    }
}

private func citizenSDKCompleteStatus(_ operationID: UInt64, _ sdkContext: UnsafeMutableRawPointer?,
                                      _ completion: citizensdk_host_status_completion_v1_t?,
                                      _ code: CitizenSDKErrorCode) {
    var result = citizensdk_host_status_result_v1_t()
    result.struct_size = UInt32(MemoryLayout<citizensdk_host_status_result_v1_t>.size)
    result.abi_version = 1
    result.host_operation_id = operationID
    result.error_code = code.rawValue
    completion?(sdkContext, &result)
}

private func citizenSDKCode(_ error: Error) -> Int32 {
    (error as? CitizenSDKError)?.code.rawValue ?? CitizenSDKErrorCode.storage.rawValue
}

private func citizenSDKChainDatabaseLoad(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                         _ sdkContext: UnsafeMutableRawPointer?,
                                         _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.chainLoad()); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKChainDatabaseCAS(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                        _ expected: UInt64, _ present: UInt8,
                                        _ candidate: citizensdk_bytes_view_t,
                                        _ sdkContext: UnsafeMutableRawPointer?,
                                        _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil, present == 1 else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.chainCAS(expected: expected, candidate: citizenSDKData(candidate))); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKRuntimeCacheLoad(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                        _ hash: citizensdk_host_hash32_t, _ sdkContext: UnsafeMutableRawPointer?,
                                        _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.runtimeLoad(hash: citizenSDKFixedData(hash.bytes, count: 32))); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKRuntimeCacheStore(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                         _ hash: citizensdk_host_hash32_t, _ candidate: citizensdk_bytes_view_t,
                                         _ sdkContext: UnsafeMutableRawPointer?,
                                         _ completion: citizensdk_host_status_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        try host.runtimeStore(hash: citizenSDKFixedData(hash.bytes, count: 32), candidate: citizenSDKData(candidate))
        citizenSDKCompleteStatus(operationID, sdkContext, completion, .ok); return 0
    } catch { return citizenSDKCode(error) }
}

private func citizenSDKRuntimeCacheDelete(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                          _ hash: citizensdk_host_hash32_t, _ sdkContext: UnsafeMutableRawPointer?,
                                          _ completion: citizensdk_host_status_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { try host.runtimeDelete(hash: citizenSDKFixedData(hash.bytes, count: 32)); citizenSDKCompleteStatus(operationID, sdkContext, completion, .ok); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKTransactionHistoryQuery(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                               _ query: citizensdk_bytes_view_t,
                                               _ sdkContext: UnsafeMutableRawPointer?,
                                               _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        let bytes = try citizenSDKData(query)
        guard bytes.count == 58 else { return CitizenSDKErrorCode.invalidArgument.rawValue }
        citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.historyQuery(bytes)); return 0
    }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKTransactionHistoryMutate(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                                _ expected: UInt64, _ mutation: citizensdk_bytes_view_t,
                                                _ sdkContext: UnsafeMutableRawPointer?,
                                                _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.historyMutate(expected: expected, mutation: citizenSDKData(mutation))); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKWalletProfileLoad(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                         _ sdkContext: UnsafeMutableRawPointer?,
                                         _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.profileLoad()); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKWalletProfileCAS(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                        _ expected: UInt64, _ candidate: citizensdk_bytes_view_t,
                                        _ sdkContext: UnsafeMutableRawPointer?,
                                        _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.profileCAS(expected: expected, candidate: citizenSDKData(candidate))); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKEncryptedSecretLoad(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                           _ secret: citizensdk_host_secret_ref_v1_t,
                                           _ sdkContext: UnsafeMutableRawPointer?,
                                           _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.secretLoad(citizenSDKSecret(secret))); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKEncryptedSecretCAS(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                          _ secret: citizensdk_host_secret_ref_v1_t, _ expected: UInt64,
                                          _ candidate: citizensdk_bytes_view_t,
                                          _ sdkContext: UnsafeMutableRawPointer?,
                                          _ completion: citizensdk_host_record_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { citizenSDKCompleteRecord(operationID, sdkContext, completion, try host.secretCAS(citizenSDKSecret(secret), expected: expected, candidate: citizenSDKData(candidate))); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKAccountSecretPresence(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
    _ account: citizensdk_account_id_t, _ sdkContext: UnsafeMutableRawPointer?,
    _ completion: citizensdk_host_bool_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        var result = citizensdk_host_bool_result_v1_t()
        result.struct_size = UInt32(MemoryLayout<citizensdk_host_bool_result_v1_t>.size)
        result.abi_version = 1; result.host_operation_id = operationID; result.error_code = 0
        result.value = try host.hasAccountSecret(citizenSDKFixedData(account.bytes, count: 32)) ? 1 : 0
        completion?(sdkContext, &result); return 0
    } catch { return citizenSDKCode(error) }
}
private func citizenSDKWalletKeyPresence(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
    _ walletIndex: UInt32, _ sdkContext: UnsafeMutableRawPointer?,
    _ completion: citizensdk_host_bool_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        var result = citizensdk_host_bool_result_v1_t()
        result.struct_size = UInt32(MemoryLayout<citizensdk_host_bool_result_v1_t>.size)
        result.abi_version = 1; result.host_operation_id = operationID; result.error_code = 0
        result.value = try host.hasAnyWalletKey(walletIndex) ? 1 : 0
        completion?(sdkContext, &result); return 0
    } catch { return citizenSDKCode(error) }
}

private func citizenSDKVaultAvailability(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                         _ sdkContext: UnsafeMutableRawPointer?,
                                         _ completion: citizensdk_host_vault_availability_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    var result = citizensdk_host_vault_availability_result_v1_t()
    result.struct_size = UInt32(MemoryLayout<citizensdk_host_vault_availability_result_v1_t>.size)
    result.abi_version = 1
    result.host_operation_id = operationID
    result.error_code = 0
    result.availability = host.vaultAvailability().rawValue
    completion?(sdkContext, &result)
    return 0
}

private func citizenSDKVaultEnsure(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                   _ wallet: citizensdk_host_wallet_key_ref_v1_t,
                                   _ provisioning: citizensdk_host_id128_t,
                                   _ sdkContext: UnsafeMutableRawPointer?,
                                   _ completion: citizensdk_host_status_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { try host.vaultEnsure(citizenSDKWalletKey(wallet), operationID: citizenSDKFixedData(provisioning.bytes, count: 16)); citizenSDKCompleteStatus(operationID, sdkContext, completion, .ok); return 0 }
    catch { return citizenSDKCode(error) }
}

private func citizenSDKVaultHas(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                _ wallet: citizensdk_host_wallet_key_ref_v1_t,
                                _ sdkContext: UnsafeMutableRawPointer?,
                                _ completion: citizensdk_host_bool_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        var result = citizensdk_host_bool_result_v1_t()
        result.struct_size = UInt32(MemoryLayout<citizensdk_host_bool_result_v1_t>.size)
        result.abi_version = 1
        result.host_operation_id = operationID
        result.error_code = 0
        result.value = try host.vaultHas(citizenSDKWalletKey(wallet)) ? 1 : 0
        completion?(sdkContext, &result); return 0
    } catch { return citizenSDKCode(error) }
}

private func citizenSDKVaultWrap(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                 _ wallet: citizensdk_host_wallet_key_ref_v1_t,
                                 _ provisioning: citizensdk_host_id128_t,
                                 _ plaintext: citizensdk_bytes_view_t,
                                 _ sdkContext: UnsafeMutableRawPointer?,
                                 _ completion: citizensdk_host_bytes_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), let pointer = plaintext.data,
          plaintext.len == 32, completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        let wrapped = try host.vaultWrap(citizenSDKWalletKey(wallet),
                                         operationID: citizenSDKFixedData(provisioning.bytes, count: 16),
                                         plaintext: UnsafeRawBufferPointer(start: pointer, count: 32))
        var result = citizensdk_host_bytes_result_v1_t()
        result.struct_size = UInt32(MemoryLayout<citizensdk_host_bytes_result_v1_t>.size)
        result.abi_version = 1
        result.host_operation_id = operationID
        result.error_code = 0
        result.kind = CITIZENSDK_HOST_BYTES_WRAPPED_DEK
        wrapped.withUnsafeBytes { bytes in
            result.bytes.data = bytes.bindMemory(to: UInt8.self).baseAddress
            result.bytes.len = UInt64(bytes.count)
            completion?(sdkContext, &result)
        }
        return 0
    } catch { return citizenSDKCode(error) }
}

private func citizenSDKVaultUnwrap(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                   _ wallet: citizensdk_host_wallet_key_ref_v1_t,
                                   _ wrapped: citizensdk_bytes_view_t,
                                   _ output: citizensdk_mutable_bytes_view_t,
                                   _ sdkContext: UnsafeMutableRawPointer?,
                                   _ completion: citizensdk_host_status_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), let outputPointer = output.data,
          output.len == 32, completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        try host.vaultUnwrap(
            hostOperationID: operationID,
            key: citizenSDKWalletKey(wallet),
            wrapped: citizenSDKData(wrapped),
            output: UnsafeMutableRawBufferPointer(start: outputPointer, count: 32)
        ) { code in citizenSDKCompleteStatus(operationID, sdkContext, completion, code) }
        return 0
    } catch { return citizenSDKCode(error) }
}

private func citizenSDKVaultAuthorizeAddAccounts(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
    _ wallet: citizensdk_host_wallet_key_ref_v1_t, _ provisioning: citizensdk_host_id128_t,
    _ sdkContext: UnsafeMutableRawPointer?, _ completion: citizensdk_host_status_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        try host.vaultAuthorizeAddAccounts(hostOperationID: operationID, key: citizenSDKWalletKey(wallet),
            operationID: citizenSDKFixedData(provisioning.bytes, count: 16)) {
                code in citizenSDKCompleteStatus(operationID, sdkContext, completion, code)
            }
        return 0
    } catch { return citizenSDKCode(error) }
}

private func citizenSDKVaultRetire(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
                                   _ wallet: citizensdk_host_wallet_key_ref_v1_t,
                                   _ cleanup: citizensdk_host_id128_t,
                                   _ sdkContext: UnsafeMutableRawPointer?,
                                   _ completion: citizensdk_host_status_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do { try host.vaultRetire(citizenSDKWalletKey(wallet), operationID: citizenSDKFixedData(cleanup.bytes, count: 16)); citizenSDKCompleteStatus(operationID, sdkContext, completion, .ok); return 0 }
    catch { return citizenSDKCode(error) }
}
