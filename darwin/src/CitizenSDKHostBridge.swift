import Foundation

/// 按模块拥有公共SQLite资源、安全存储与 KEK/DEK 金库，不创建未选择的系统资源。
/// 核心在创建时复制回调表；上下文借用和已打开资源一直存活到核心成功销毁。
internal final class CitizenSDKHostBridge {
    private let modules: CitizenSDKModules
    private let base: URL
    private let applicationID: String
    private let resourceLock = NSRecursiveLock()
    private let database: CitizenSDKDatabase
    private let secureDatabase: CitizenSDKDatabase
    private var vaultValue: CitizenSDKSecretVault?
    private var privateKeyAuthentications: [UInt64: Bool] = [:]
    private var vaultVTable = citizensdk_host_secret_vault_v1_t()

    init(root: URL? = nil, applicationID: String? = Bundle.main.bundleIdentifier,
         modules: CitizenSDKModules = .full) throws {
        // 构造仅保存身份和路径，不创建文件、不探测硬件；核心先校验模块，再调用所需资源。
        self.applicationID = try CitizenSDKRecordKey.applicationID(applicationID)
        self.base = try root ?? Self.defaultRoot(applicationID: self.applicationID)
        self.modules = modules
        database = CitizenSDKDatabase(directory: base.appendingPathComponent("public", isDirectory: true))
        secureDatabase = CitizenSDKDatabase(directory: base.appendingPathComponent("secure", isDirectory: true),secure:true)
        configureVTables()
    }

    deinit {
        database.close();secureDatabase.close()
    }

    private func vault() throws -> CitizenSDKSecretVault {
        resourceLock.lock(); defer { resourceLock.unlock() }
        if let value = vaultValue { return value }
        let value = try CitizenSDKSecretVault(secureStore: secureDatabase, applicationID: applicationID)
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

    func withStores<T>(_ body:(UnsafePointer<citizensdk_stores_v1_t>)->T)->T {
      var publicConfig=database.config(),secureConfig=secureDatabase.config()
      return withUnsafePointer(to:&publicConfig){publicPointer in withUnsafePointer(to:&secureConfig){securePointer in withUnsafePointer(to:&vaultVTable){vaultPointer in
        var stores=citizensdk_stores_v1_t();stores.struct_size=UInt32(MemoryLayout<citizensdk_stores_v1_t>.size);stores.abi_version = CITIZENSDK_ABI_VERSION
        stores.public_store=modules.contains(.chain) ? publicPointer : nil;stores.secure_store=modules.usesSecrets ? securePointer : nil;stores.secret_vault=modules.usesSecrets ? vaultPointer : nil
        return withUnsafePointer(to:&stores,body)
      }}}
    }



    func hasAnyWalletKey(_ walletIndex: UInt32) throws -> Bool { try vault().hasAnyWalletKey(walletIndex: walletIndex) }

    private func configureVTables() {
        let context = Unmanaged.passUnretained(self).toOpaque()
        vaultVTable.struct_size = UInt32(MemoryLayout<citizensdk_host_secret_vault_v1_t>.size)
        vaultVTable.abi_version = CITIZENSDK_ABI_VERSION
        vaultVTable.context = context
        vaultVTable.availability = citizenSDKVaultAvailability
        vaultVTable.ensure_wallet_kek = citizenSDKVaultEnsure
        vaultVTable.has_wallet_kek = citizenSDKVaultHas
        vaultVTable.wrap_dek = citizenSDKVaultWrap
        vaultVTable.unwrap_dek = citizenSDKVaultUnwrap
        vaultVTable.retire_wallet_kek = citizenSDKVaultRetire
        vaultVTable.authorize_add_accounts = citizenSDKVaultAuthorizeAddAccounts
        vaultVTable.has_any_wallet_key = citizenSDKWalletKeyPresence
    }

    static func storageRoot(applicationSupport: URL, applicationID: String?) throws -> URL {
        let applicationID = try CitizenSDKRecordKey.applicationID(applicationID)
        return applicationSupport.appendingPathComponent(applicationID, isDirectory: true)
            .appendingPathComponent("citizensdk", isDirectory: true)
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
    try CitizenSDKChecks.require(value.struct_size >= UInt32(MemoryLayout<citizensdk_host_wallet_key_ref_v1_t>.size) && value.abi_version == CITIZENSDK_ABI_VERSION,
                                 "wallet key reference ABI is invalid")
    return CitizenSDKHostWalletKey(walletIndex: value.wallet_index,
                                   generation: citizenSDKFixedData(value.generation.bytes, count: 16))
}




private func citizenSDKCompleteStatus(_ operationID: UInt64, _ sdkContext: UnsafeMutableRawPointer?,
                                      _ completion: citizensdk_host_status_completion_v1_t?,
                                      _ code: CitizenSDKErrorCode) {
    var result = citizensdk_host_status_result_v1_t()
    result.struct_size = UInt32(MemoryLayout<citizensdk_host_status_result_v1_t>.size)
    result.abi_version = CITIZENSDK_ABI_VERSION
    result.host_operation_id = operationID
    result.error_code = code.rawValue
    completion?(sdkContext, &result)
}

private func citizenSDKCode(_ error: Error) -> Int32 {
    (error as? CitizenSDKError)?.code.rawValue ?? CitizenSDKErrorCode.storage.rawValue
}


private func citizenSDKWalletKeyPresence(_ context: UnsafeMutableRawPointer?, _ operationID: UInt64,
    _ walletIndex: UInt32, _ sdkContext: UnsafeMutableRawPointer?,
    _ completion: citizensdk_host_bool_completion_v1_t?) -> Int32 {
    guard let host = citizenSDKHost(context), completion != nil else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    do {
        var result = citizensdk_host_bool_result_v1_t()
        result.struct_size = UInt32(MemoryLayout<citizensdk_host_bool_result_v1_t>.size)
        result.abi_version = CITIZENSDK_ABI_VERSION; result.host_operation_id = operationID; result.error_code = 0
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
    result.abi_version = CITIZENSDK_ABI_VERSION
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
        result.abi_version = CITIZENSDK_ABI_VERSION
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
        result.abi_version = CITIZENSDK_ABI_VERSION
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
