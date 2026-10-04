import Foundation
internal import CitizenSDKInternal

/// Monotonic teardown contract matching `citizensdk.h` exactly. Once callback
/// clear succeeds the instance enters `destroyOnly` before its first destroy
/// call; every later retry therefore calls destroy and no other control API.
internal final class CitizenSDKABITeardownCoordinator {
    enum Phase: Equatable, Sendable {
        case live
        case monitorStopped
        case destroyOnly
        case closed
    }

    private let lock = NSLock()
    private var phase: Phase = .live
    private var teardownStarted = false

    var snapshot: (phase: Phase, teardownStarted: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (phase, teardownStarted)
    }

    func requireOperational() throws {
        let state = snapshot
        guard state.phase == .live, !state.teardownStarted else {
            throw CitizenSDKError(.invalidState, "CitizenSDK is closing and accepts only teardown retry")
        }
    }

    func perform(
        unsubscribe: () throws -> Void,
        clearCallback: () throws -> Void,
        destroy: () throws -> Void,
        didDestroy: () -> Void
    ) throws {
        lock.lock(); teardownStarted = true; lock.unlock()
        while true {
            switch snapshot.phase {
            case .live:
                // An error is not guessed to be side-effect-free. The phase
                // advances only after a later idempotent success confirms the
                // monitor is absent.
                try unsubscribe()
                advance(from: .live, to: .monitorStopped)
            case .monitorStopped:
                try clearCallback()
                // Persist before the first destroy call. BUSY and every other
                // destroy failure now have the same direct-retry boundary.
                advance(from: .monitorStopped, to: .destroyOnly)
            case .destroyOnly:
                try destroy()
                advance(from: .destroyOnly, to: .closed)
                didDestroy()
                return
            case .closed:
                return
            }
        }
    }

    private func advance(from expected: Phase, to next: Phase) {
        lock.lock(); defer { lock.unlock() }
        precondition(phase == expected, "CitizenSDK ABI teardown phase drifted")
        phase = next
    }
}

/// Explicit +1 ownership handed to the C ABI. `Unmanaged` is intentional here:
/// callback and host vtable contexts are borrowed by Core beyond Swift's normal
/// object graph, so ARC ownership ends only after successful destroy.
internal final class CitizenSDKABIRetainLease<Owner: AnyObject> {
    private let lock = NSLock()
    private var retained: Unmanaged<Owner>?

    init(_ owner: Owner) { retained = Unmanaged.passRetained(owner) }

    var isArmed: Bool {
        lock.lock(); defer { lock.unlock() }
        return retained != nil
    }

    func releaseAfterSuccessfulDestroy() {
        lock.lock()
        let owner = retained
        retained = nil
        lock.unlock()
        owner?.release()
    }
}

/// Couples Core's two borrowed Swift lifetimes: HostBridge and Native's ABI
/// +1. Successful destroy clears HostBridge first (closing its SQLite stores),
/// then releases the self-retain. A still-live closed facade therefore cannot
/// extend host resource ownership beyond Core.
internal final class CitizenSDKABIBorrowedResources<Host: AnyObject, Owner: AnyObject> {
    private let lock = NSLock()
    private var host: Host?
    private var ownerLease: CitizenSDKABIRetainLease<Owner>?

    init(host: Host, owner: Owner) {
        self.host = host
        ownerLease = CitizenSDKABIRetainLease(owner)
    }

    var hasHost: Bool {
        lock.lock(); defer { lock.unlock() }
        return host != nil
    }

    var hostSnapshot: Host? {
        lock.lock(); defer { lock.unlock() }
        return host
    }

    var isOwnerLeaseArmed: Bool {
        lock.lock(); defer { lock.unlock() }
        return ownerLease?.isArmed == true
    }

    func releaseAfterSuccessfulDestroy() {
        lock.lock()
        // Core has promised no later callback/host operation. Drop the host
        // before the owner +1 so stores close even if a closed facade remains.
        host = nil
        let lease = ownerLease
        ownerLease = nil
        lock.unlock()
        lease?.releaseAfterSuccessfulDestroy()
    }
}

/// Shared retry loop used by the production reaper and deterministic XCTest
/// fixtures. Production has no attempt limit; backoff is capped at five seconds.
internal enum CitizenSDKSupervisedRetry {
    static func run(
        maximumAttempts: Int? = nil,
        initialDelayNanoseconds: UInt64 = 250_000_000,
        attempt: @escaping @Sendable () async -> Bool
    ) async -> Bool {
        var attempts = 0
        var delay = initialDelayNanoseconds
        while maximumAttempts == nil || attempts < maximumAttempts! {
            attempts += 1
            if await attempt() { return true }
            if delay != 0 { try? await Task.sleep(nanoseconds: delay) }
            let doubled = delay.multipliedReportingOverflow(by: 2)
            delay = doubled.overflow ? 5_000_000_000 : min(doubled.partialValue, 5_000_000_000)
        }
        return false
    }
}

internal enum CitizenSDKSupervisedCloseAction: Equatable, Sendable {
    case stopThenClose
    case close
}

/// Serial delivery gate for state notifications that need a synchronous Core
/// query. C callbacks only enqueue and return. Close atomically stops admission
/// when no delivery is active; already-queued work is then skipped without a C
/// call, while an active delivery makes close retry with BUSY.
internal final class CitizenSDKDeferredEventGate: @unchecked Sendable {
    struct Snapshot: Equatable, Sendable {
        let accepting: Bool
        let pending: Int
        let active: Int
    }

    private let lock = NSLock()
    private let queue: DispatchQueue
    private var accepting = true
    /// Scheduled work, including the currently active item.
    private var pending = 0
    private var active = 0

    init(label: String) { queue = DispatchQueue(label: label) }
    internal init(queue: DispatchQueue) { self.queue = queue }

    var snapshot: Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(accepting: accepting, pending: pending, active: active)
    }

    @discardableResult
    func enqueue(_ work: @escaping @Sendable () -> Void) -> Bool {
        lock.lock()
        guard accepting, pending < Int.max else { lock.unlock(); return false }
        pending += 1
        lock.unlock()
        queue.async { [self] in
            guard claim() else { return }
            defer { finishActive() }
            work()
        }
        return true
    }

    /// Linearizes with `enqueue`. Returning true guarantees no work is active,
    /// no later work can be admitted, and all previously queued work will skip.
    func beginTeardownIfNoActiveDelivery() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if !accepting { return active == 0 }
        guard active == 0 else { return false }
        accepting = false
        return true
    }

    private func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        precondition(pending > 0, "CitizenSDK deferred event count underflowed")
        guard accepting else {
            pending -= 1
            return false
        }
        active += 1
        return true
    }

    private func finishActive() {
        lock.lock(); defer { lock.unlock() }
        precondition(active > 0 && pending > 0, "CitizenSDK deferred event count underflowed")
        active -= 1
        pending -= 1
    }
}

/// Owns abandoned facades or native instances until their Core handle reaches
/// successful destruction. Actor dictionaries are the visible recovery owner;
/// Native's ABI lease closes the short handoff interval before actor adoption.
internal actor CitizenSDKLifecycleSupervisor {
    static let shared = CitizenSDKLifecycleSupervisor()
    private var nativeEntries: [ObjectIdentifier: CitizenSDKNative] = [:]
    private var facadeEntries: [ObjectIdentifier: CitizenSdk] = [:]

    func adopt(_ native: CitizenSDKNative) {
        let identity = ObjectIdentifier(native)
        guard nativeEntries[identity] == nil else { return }
        nativeEntries[identity] = native
        Task { await recoverNative(identity) }
    }

    func adopt(_ facade: CitizenSdk) {
        let identity = ObjectIdentifier(facade)
        guard facadeEntries[identity] == nil else { return }
        facadeEntries[identity] = facade
        Task { await recoverFacade(identity) }
    }

    private func recoverNative(_ identity: ObjectIdentifier) async {
        guard let native = nativeEntries[identity] else { return }
        _ = await CitizenSDKSupervisedRetry.run {
            do { try await native.supervisedClose(); return true }
            catch { return false }
        }
        nativeEntries.removeValue(forKey: identity)
    }

    private func recoverFacade(_ identity: ObjectIdentifier) async {
        guard let facade = facadeEntries[identity] else { return }
        _ = await CitizenSDKSupervisedRetry.run {
            do { try await facade.supervisedClose(); return true }
            catch { return false }
        }
        facadeEntries.removeValue(forKey: identity)
    }
}

/// Sole owner of one Core handle, callback, result ownership and host context.
internal final class CitizenSDKNative: @unchecked Sendable {
    private enum DeferredStateEvent: Sendable {
        case history(sequence: UInt64)
        case wallet(sequence: UInt64)
        case finalized(sequence: UInt64, block: CitizenBlockRef)
        case capabilities(sequence: UInt64)
        case lifecycle(sequence: UInt64)
    }

    private final class Pending {
        let decode: (UInt64) throws -> Any
        let complete: (Result<Any, Error>) -> Void
        let retainsResult: Bool

        init(decode: @escaping (UInt64) throws -> Any,
             complete: @escaping (Result<Any, Error>) -> Void,
             retainsResult: Bool) {
            self.decode = decode
            self.complete = complete
            self.retainsResult = retainsResult
        }
    }

    private final class Cancellation {
        private let lock = NSLock()
        private var requestID: UInt64?
        func bind(_ value: UInt64) { lock.lock(); requestID = value; lock.unlock() }
        func value() -> UInt64? { lock.lock(); defer { lock.unlock() }; return requestID }
    }

    private let callLock = NSRecursiveLock()
    private let routerLock = NSLock()
    private let deferredStateEvents = CitizenSDKDeferredEventGate(
        label: "org.citizen.sdk.apple.state-events"
    )
    private let teardown = CitizenSDKABITeardownCoordinator()
    private var handle: UInt64
    private let selectedModules: CitizenSDKModules
    private var closed = false
    /// Installed before callback binding and cleared only under `callLock` at
    /// successful destroy. It owns HostBridge plus Native's explicit ABI +1.
    private var abiResources: CitizenSDKABIBorrowedResources<CitizenSDKHostBridge, CitizenSDKNative>?
    private var pending: [UInt64: Pending] = [:]
    /// True only while one serialized C admission call may legally callback
    /// before its out_request_id has been observed by Swift.
    private var admissionInProgress = false
    private var earlyCompletions: [UInt64: UInt64] = [:]
    /// Includes completion batches removed from maps but not yet fully
    /// decoded, released and delivered to facade observers.
    private var queuedDeliveries = 0
    private var preparedHandles: Set<UInt64> = []
    private var preparedTransactionHandles: [String: UInt64] = [:]
    private var eventListener: ((CitizenSDKEvent) -> Void)?

    private init(handle: UInt64, modules: CitizenSDKModules) {
        self.handle = handle
        selectedModules = modules
    }

    static func open(assets: CitizenSDKAssets?, storageRoot: URL? = nil,
                     applicationID: String? = Bundle.main.bundleIdentifier,
                     modules: CitizenSDKModules = .full) throws -> CitizenSDKNative {
        try validateModules(modules)
        // Pure modules such as QR have no storage or vault dependency. Passing
        // an all-null host table would incorrectly turn that valid selection
        // into an invalid host-services request at the C boundary.
        let needsHost = modules.contains(.chain) || modules.contains(.history) || modules.usesSecrets
        let host = needsHost
            ? try CitizenSDKHostBridge(root: storageRoot, applicationID: applicationID, modules: modules)
            : nil
        var handle: UInt64 = 0
        let name = Data("CitizenSDK".utf8)
        let version = Data("1.0.0".utf8)
        let create: (UnsafePointer<citizensdk_host_services_v1_t>?) -> Int32 = { services in
            withViews([assets?.manifest ?? Data(), assets?.chainSpec ?? Data(), assets?.lightSyncState ?? Data(), name, version]) { views in
                var options = citizensdk_create_options_t()
                options.struct_size = UInt32(MemoryLayout<citizensdk_create_options_t>.size)
                options.abi_version = 1
                options.asset_manifest = views[0]
                options.chain_spec = views[1]
                options.light_sync_state = views[2]
                options.system_name = views[3]
                options.system_version = views[4]
                return citizensdk_create_with_modules(&options, services, modules.rawValue, &handle)
            }
        }
        let code = if let host {
            host.withServices { create($0) }
        } else {
            create(nil)
        }
        try CitizenSDKChecks.requireOK(code, "CitizenSDK Core creation failed")
        guard handle != 0 else { throw CitizenSDKError(.integrity, "Core returned an empty instance handle") }
        let native = CitizenSDKNative(handle: handle, modules: modules)
        // Arm before exposing this object or installing a passUnretained
        // callback context. The lease also keeps every HostBridge context live.
        if let host {
            native.abiResources = CitizenSDKABIBorrowedResources(host: host, owner: native)
        }
        try bindOrRecover(
            bind: {
                try host?.registerSecretPresence(handle: handle)
                try native.bindCallback()
            },
            close: native.close,
            supervise: native.enqueueForSupervisedClose
        )
        return native
    }

    /// One setup-failure convergence path for callback installation and
    /// capability subscription. The original setup error is preserved; close
    /// failure transfers the still-retained ABI owner to supervised recovery.
    internal static func bindOrRecover(
        bind: () throws -> Void,
        close: () throws -> Void,
        supervise: () -> Void
    ) throws {
        do { try bind() }
        catch {
            let original = error
            do { try close() }
            catch { supervise() }
            throw original
        }
    }

    func setEventListener(_ listener: ((CitizenSDKEvent) -> Void)?) {
        routerLock.lock(); eventListener = listener; routerLock.unlock()
    }

    func lifecycle() throws -> CitizenSDKLifecycle {
        try callLock.withLock {
            try requireOpen()
            return try readLifecycle()
        }
    }

    func capabilities() throws -> CitizenSDKCapabilities {
        try callLock.withLock {
            try requireOpen()
            var value = citizensdk_capability_snapshot_t()
            value.struct_size = UInt32(MemoryLayout<citizensdk_capability_snapshot_t>.size)
            value.abi_version = 1
            try CitizenSDKChecks.requireOK(citizensdk_get_capabilities(handle, &value), "Core capability query failed")
            return try CitizenSDKNativeCodec.capabilities(value)
        }
    }

    func start() throws -> CitizenSDKOperation<Void> {
        try begin(accept: { citizensdk_start(handle, $0) }, decode: CitizenSDKNativeCodec.empty)
    }
    /// 只委托Core接纳外壳序号，不分配异步请求或复制计数状态。
    func acceptRequestSequence(_ sequence: Int64) throws {
        try callLock.withLock {
            try requireOpen()
            try CitizenSDKChecks.requireOK(
                citizensdk_accept_request_sequence(handle, UInt64(bitPattern: sequence)),
                "CitizenSDK request sequence admission failed")
        }
    }
    func stop() throws -> CitizenSDKOperation<Void> {
        try begin(accept: { citizensdk_stop(handle, $0) }, decode: CitizenSDKNativeCodec.empty)
    }
    func refreshCapabilities() throws -> CitizenSDKOperation<Void> {
        try begin(accept: { citizensdk_refresh_capabilities(handle, $0) }, decode: CitizenSDKNativeCodec.empty)
    }
    func finalizedHead() throws -> CitizenSDKOperation<CitizenBlockRef> {
        try begin(accept: { citizensdk_get_finalized_head(handle, $0) }, decode: CitizenSDKNativeCodec.block)
    }
    func syncStatus() throws -> CitizenSDKOperation<CitizenChainSyncStatus> {
        try begin(accept: { citizensdk_get_sync_status(handle, $0) }, decode: CitizenSDKNativeCodec.syncStatus)
    }
    func bestHead() throws -> CitizenSDKOperation<CitizenBlockRef> {
        try begin(accept: { citizensdk_get_best_head(handle, $0) }, decode: CitizenSDKNativeCodec.block)
    }
    func finalizedBlock(at number: UInt64) throws -> CitizenSDKOperation<CitizenBlockRef> {
        try begin(accept: { citizensdk_get_finalized_block_at(handle, number, $0) },
                  decode: CitizenSDKNativeCodec.block)
    }
    func resolveFinalizedBlock(hash: Data, number: UInt64) throws -> CitizenSDKOperation<CitizenBlockRef> {
        let checked = try CitizenSDKInputLimits.accountID(hash, label: "block hash")
        return try checked.withUnsafeBytes { bytes in
            try begin(accept: {
                citizensdk_resolve_finalized_block(
                    handle, bytes.bindMemory(to: UInt8.self).baseAddress, number, $0)
            }, decode: CitizenSDKNativeCodec.block)
        }
    }
    func blockHeader(_ block: CitizenBlockRef) throws -> CitizenSDKOperation<CitizenBlockHeader> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try begin(accept: { citizensdk_get_block_header_at(handle, pointer, $0) },
                      decode: CitizenSDKNativeCodec.blockHeader)
        }
    }
    func blockBody(_ block: CitizenBlockRef) throws -> CitizenSDKOperation<CitizenBlockBody> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try begin(accept: { citizensdk_get_block_body_at(handle, pointer, $0) },
                      decode: CitizenSDKNativeCodec.blockBody)
        }
    }
    func runtimeContext(_ block: CitizenBlockRef) throws -> CitizenSDKOperation<CitizenRuntimeContext> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try begin(accept: { citizensdk_get_runtime_context_at(handle, pointer, $0) },
                      decode: CitizenSDKNativeCodec.runtimeContext)
        }
    }
    func storage(_ block: CitizenBlockRef, key: Data) throws -> CitizenSDKOperation<Data?> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try withView(key) { view in
                try begin(accept: { citizensdk_get_storage_at(handle, pointer, view, $0) },
                          decode: CitizenSDKNativeCodec.storage)
            }
        }
    }
    func storageBatch(_ block: CitizenBlockRef, keys: [Data]) throws -> CitizenSDKOperation<[Data?]> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try Self.withViews(keys) { views in
                try views.withUnsafeBufferPointer { buffer in
                    try begin(accept: {
                        citizensdk_get_storage_batch_at(
                            handle, pointer, buffer.baseAddress, UInt32(buffer.count), $0)
                    }, decode: CitizenSDKNativeCodec.storageBatch)
                }
            }
        }
    }
    func storageKeysPaged(_ block: CitizenBlockRef, prefix: Data, startKey: Data?,
                          limit: UInt32) throws -> CitizenSDKOperation<[Data]> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try Self.withViews([prefix, startKey ?? Data()]) { views in
                try begin(accept: {
                    citizensdk_get_storage_keys_paged(
                        handle, pointer, views[0], startKey == nil ? 0 : 1,
                        views[1], limit, $0)
                }, decode: { result in
                    let values = try CitizenSDKNativeCodec.storageBatch(result)
                    guard values.allSatisfy({ $0 != nil }) else {
                        throw CitizenSDKError(.integrity, "Core storage key page contains an absent key")
                    }
                    return values.compactMap { $0 }
                })
            }
        }
    }
    func callRuntimeAPI(_ block: CitizenBlockRef, method: String, arguments: Data)
        throws -> CitizenSDKOperation<Data> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try Self.withViews([Data(method.utf8), arguments]) { views in
                try begin(accept: {
                    citizensdk_call_runtime_api(handle, pointer, views[0], views[1], $0)
                }, decode: { result in
                    guard let output = try CitizenSDKNativeCodec.storage(result) else {
                        throw CitizenSDKError(.integrity, "Core Runtime API output is absent")
                    }
                    return output
                })
            }
        }
    }
    func systemEvents(_ block: CitizenBlockRef) throws -> CitizenSDKOperation<Data?> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try begin(accept: { citizensdk_get_system_events_at(handle, pointer, $0) },
                      decode: CitizenSDKNativeCodec.storage)
        }
    }
    func exportState() throws -> CitizenSDKOperation<CitizenChainState> {
        try begin(accept: { citizensdk_export_state(handle, $0) }, decode: CitizenSDKNativeCodec.chainState)
    }
    func importState(_ state: CitizenChainState) throws -> CitizenSDKOperation<Void> {
        var block = cBlock(state.finalized)
        return try withUnsafePointer(to: &block) { pointer in
            try withView(state.database) { view in
                try begin(accept: {
                    citizensdk_import_state(handle, pointer, state.formatVersion, view, $0)
                }, decode: { result in
                    let imported = try CitizenSDKNativeCodec.block(result)
                    guard imported == state.finalized else {
                        throw CitizenSDKError(
                            .integrity,
                            "Core imported-state receipt does not match its finalized anchor")
                    }
                    return ()
                })
            }
        }
    }
    func genesisHash() throws -> Data {
        try callLock.withLock {
            try requireOpen()
            var output = Data(count: 32)
            let code = output.withUnsafeMutableBytes {
                citizensdk_get_genesis_hash(handle, $0.bindMemory(to: UInt8.self).baseAddress)
            }
            try CitizenSDKChecks.requireOK(code, "Core genesis hash query failed")
            return output
        }
    }
    func feeSnapshot() throws -> CitizenSDKOperation<CitizenFeeSnapshot> {
        try begin(accept: { citizensdk_get_best_fee_snapshot(handle, $0) }, decode: CitizenSDKNativeCodec.fee)
    }
    func walletProfile() throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        try begin(accept: { citizensdk_get_wallet_profile(handle, $0) }, decode: CitizenSDKNativeCodec.profile)
    }
    func walletState() throws -> CitizenSDKOperation<CitizenWalletState> {
        try begin(accept: { citizensdk_get_wallet_state(handle, $0) }, decode: CitizenSDKNativeCodec.walletState)
    }

    func inspectWallets() throws -> CitizenSDKOperation<CitizenWalletInspection> {
        // 使用同一真实结果及原完成所有权转交，不建立第二目录或额外查库。
        try begin(accept: { citizensdk_get_wallet_state(handle, $0) }, decode: {
            CitizenWalletInspection(owner: self, result: $0, state: try CitizenSDKNativeCodec.walletState($0))
        }, retainsResult: true)
    }

    func releaseWalletInspection(_ result: UInt64) throws {
        try CitizenSDKChecks.requireOK(citizensdk_result_release(result), "钱包检查资源释放失败")
    }

    func repairHotWallet(_ inspection: CitizenWalletInspection, walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try inspection.withResult(owner: self) { result in
            try begin(accept: { citizensdk_repair_hot_wallet(handle, result, walletIndex, $0) }, decode: CitizenSDKNativeCodec.walletState)
        }
    }

    func renameDiagnosticWallet(_ inspection: CitizenWalletInspection, walletIndex: UInt32, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        try inspection.withResult(owner: self) { result in
            try withView(Data(name.utf8)) { name in
                try begin(accept: { citizensdk_rename_diagnostic_wallet(handle, result, walletIndex, name, $0) }, decode: CitizenSDKNativeCodec.walletState)
            }
        }
    }

    func deleteDiagnosticWallet(_ inspection: CitizenWalletInspection, walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try inspection.withResult(owner: self) { result in
            try begin(accept: { citizensdk_delete_diagnostic_wallet(handle, result, walletIndex, $0) }, decode: CitizenSDKNativeCodec.walletState)
        }
    }

    func importColdAccountID(_ accountID: Data, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        var account = try cAccount(accountID)
        let bytes = Data(name.utf8)
        return try withUnsafePointer(to: &account) { pointer in
            try withView(bytes) { view in
                try begin(accept: { citizensdk_import_cold_account_id(handle, pointer, view, $0) },
                          decode: CitizenSDKNativeCodec.walletState)
            }
        }
    }

    func importColdAccountSS58(_ ss58: String, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        let address = Data(ss58.utf8), nameBytes = Data(name.utf8)
        return try withView(address) { addressView in
            try withView(nameBytes) { nameView in
                try begin(accept: { citizensdk_import_cold_account_ss58(handle, addressView, nameView, $0) },
                          decode: CitizenSDKNativeCodec.walletState)
            }
        }
    }

    func reorderWalletAccounts(expectedRevision: UInt64, accountIDs: [Data]) throws
        -> CitizenSDKOperation<CitizenWalletState> {
        try withAccounts(accountIDs) { pointer, count in
            try begin(accept: {
                citizensdk_reorder_wallet_accounts_without_default_change(
                    handle, expectedRevision, pointer, count, $0)
            }, decode: CitizenSDKNativeCodec.walletState)
        }
    }

    func setActiveWallet(expectedRevision: UInt64, walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try begin(accept: { citizensdk_set_active_wallet(handle, expectedRevision, walletIndex, $0) },
                  decode: CitizenSDKNativeCodec.walletState)
    }

    func renameWallet(expectedRevision: UInt64, walletIndex: UInt32, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        try withView(Data(name.utf8)) { view in
            try begin(accept: { citizensdk_rename_wallet(handle, expectedRevision, walletIndex, view, $0) },
                      decode: CitizenSDKNativeCodec.walletState)
        }
    }

    func renameAnyAccount(_ accountID: Data, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        var account = try cAccount(accountID)
        let bytes = Data(name.utf8)
        return try withUnsafePointer(to: &account) { pointer in
            try withView(bytes) { view in
                try begin(accept: { citizensdk_rename_account(handle, pointer, view, $0) },
                          decode: CitizenSDKNativeCodec.walletState)
            }
        }
    }

    func deleteAnyAccount(_ accountID: Data) throws -> CitizenSDKOperation<CitizenWalletState> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try begin(accept: { citizensdk_delete_account(handle, pointer, $0) },
                      decode: CitizenSDKNativeCodec.walletState)
        }
    }

    /// 私有回调只借用受控显示缓冲；普通请求只解码 Empty，并持有 context 到真实终态。
    func openPrivateKeyView(accountID: Data, buffer: CitizenSDKPrivateKeyReceiver)
        throws -> (UInt64, CitizenSDKOperation<Void>) {
        var account = try cAccount(accountID)
        guard let host = callLock.withLock({ abiResources?.hostSnapshot }) else {
            throw CitizenSDKError(.invalidState, "private key view host is closed")
        }
        buffer.bindAuthenticationRegistry(host.registerPrivateKeyAuthentication)
        let context = Unmanaged.passRetained(buffer)
        var view = citizensdk_private_key_receiver_v1_t()
        view.struct_size = UInt32(MemoryLayout<citizensdk_private_key_receiver_v1_t>.size)
        view.abi_version = 1
        view.context = context.toOpaque()
        view.receive = { context, viewID, bytes in
            guard let context else { return CitizenSDKErrorCode.invalidArgument.rawValue }
            return Unmanaged<CitizenSDKPrivateKeyReceiver>.fromOpaque(context)
                .takeUnretainedValue().receive(viewID: viewID, bytes: bytes)
        }
        view.settled = { context, viewID, code in
            guard let context else { return }
            Unmanaged<CitizenSDKPrivateKeyReceiver>.fromOpaque(context)
                .takeUnretainedValue().settled(viewID: viewID, code: code)
        }
        view.authorizing = { context, viewID, operationID in
            guard let context else { return CitizenSDKErrorCode.invalidArgument.rawValue }
            return Unmanaged<CitizenSDKPrivateKeyReceiver>.fromOpaque(context)
                .takeUnretainedValue().authorizing(viewID: viewID, hostOperationID: operationID)
        }
        do {
            var viewID: UInt64 = 0
            let operation = try withUnsafePointer(to: &account) { account in
                try begin(accept: {
                    citizensdk_private_key_open(handle, account, &view, &viewID, $0)
                }, decode: CitizenSDKNativeCodec.empty)
            }
            operation.observe { _ in
                if let id = buffer.authenticationID { host.releasePrivateKeyAuthentication(id) }
                context.release()
            }
            return (viewID, operation)
        } catch {
            context.release()
            throw error
        }
    }

    func revealPrivateKeyView(_ viewID: UInt64) throws {
        try callLock.withLock {
            try requireOpen()
            try CitizenSDKChecks.requireOK(citizensdk_private_key_reveal(handle, viewID), "private key view reveal failed")
        }
    }

    func cancelPrivateKeyView(_ viewID: UInt64) throws {
        try callLock.withLock {
            try requireOpen()
            try CitizenSDKChecks.requireOK(citizensdk_private_key_cancel(handle, viewID), "private key view cancellation failed")
        }
    }

    func finishPrivateKeyView(_ viewID: UInt64) throws {
        try callLock.withLock {
            try requireOpen()
            try CitizenSDKChecks.requireOK(citizensdk_private_key_finish(handle, viewID), "private key view finish failed")
        }
    }

    func isPrivateKeyAuthenticationActive(_ operationID: UInt64) -> Bool {
        callLock.withLock { abiResources?.hostSnapshot?.isAuthenticationActive(operationID) ?? false }
    }
    func cancelPrivateKeyAuthentication(_ operationID: UInt64) {
        let host = callLock.withLock { abiResources?.hostSnapshot }
        host?.cancelAuthentication(operationID)
    }

    func accountBalance(_ accountID: Data) throws -> CitizenSDKOperation<CitizenAccountBalance> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try begin(accept: { citizensdk_get_finalized_account_balance(handle, pointer, $0) },
                      decode: CitizenSDKNativeCodec.balance)
        }
    }

    func accountBalances(_ accountIDs: [Data]) throws -> CitizenSDKOperation<[CitizenAccountBalance]> {
        try withAccounts(accountIDs) { pointer, count in
            try begin(accept: { citizensdk_get_finalized_account_balances(handle, pointer, count, $0) },
                      decode: { try CitizenSDKNativeCodec.balances($0, accountIDs: accountIDs) })
        }
    }

    func accountNonce(_ accountID: Data) throws -> CitizenSDKOperation<CitizenAccountNonce> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try begin(accept: { citizensdk_get_account_nonce(handle, pointer, $0) }, decode: CitizenSDKNativeCodec.nonce)
        }
    }

    func setActiveAccount(_ accountID: Data) throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try begin(accept: { citizensdk_set_active_wallet_account(handle, pointer, $0) }, decode: CitizenSDKNativeCodec.profile)
        }
    }

    func renameAccount(_ accountID: Data, name: String) throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        var account = try cAccount(accountID)
        let bytes = Data(name.utf8)
        return try withUnsafePointer(to: &account) { pointer in
            try withView(bytes) { view in
                try begin(accept: { citizensdk_rename_wallet_account(handle, pointer, view, $0) }, decode: CitizenSDKNativeCodec.profile)
            }
        }
    }

    func deleteAccount(_ accountID: Data) throws -> CitizenSDKOperation<Void> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try begin(accept: { citizensdk_delete_wallet_account(handle, pointer, $0) }, decode: CitizenSDKNativeCodec.empty)
        }
    }

    func deleteWallet() throws -> CitizenSDKOperation<Void> {
        try begin(accept: { citizensdk_delete_wallet(handle, $0) }, decode: CitizenSDKNativeCodec.empty)
    }

    func signAndDeleteWallet() throws -> CitizenSDKOperation<Void> {
        try begin(accept: { citizensdk_sign_and_delete_wallet(handle, $0) }, decode: CitizenSDKNativeCodec.empty)
    }

    /// 同步借用受控输入，只返回Core校验事实，不带UI文案或规范化后的秘密。
    static func validateWalletInput(_ value: String, kind: UInt32, wordCount: UInt32) throws -> CitizenWalletInputValidation {
        guard (kind == 1 && wordCount == 0) || (kind == 2 && [12, 18, 24].contains(wordCount)) else {
            throw CitizenSDKError(.invalidArgument, "wallet input kind or word count is invalid")
        }
        guard value.utf8.count <= 1_024 else { return CitizenWalletInputValidation(reason: .inputTooLong, position: nil) }
        return try withWalletInput(value) { view in
            var result = citizensdk_wallet_input_validation_v1_t()
            result.struct_size = UInt32(MemoryLayout.size(ofValue: result))
            result.abi_version = 1
            try CitizenSDKChecks.requireOK(citizensdk_validate_wallet_input(kind, view, wordCount, &result), "wallet validation failed")
            guard let reason = CitizenWalletInputReason(rawValue: result.reason),
                  (reason == .unknownWord ? result.position < 24 : result.position == UInt32.max) else {
                throw CitizenSDKError(.integrity, "wallet validation result is invalid")
            }
            return CitizenWalletInputValidation(reason: reason, position: result.position == UInt32.max ? nil : result.position)
        }
    }

    static func walletWordSuggestions(_ prefix: String) throws -> [String] {
        try withWalletInput(prefix) { input in
            var required: UInt64 = 0
            try CitizenSDKChecks.requireOK(citizensdk_wallet_word_suggestions(input, nil, 0, &required), "word suggestions failed")
            guard required <= 128 else { throw CitizenSDKError(.integrity, "word suggestions exceed limit") }
            var output = Data(count: Int(required))
            defer { output.resetBytes(in: 0..<output.count) }
            let code = output.withUnsafeMutableBytes {
                citizensdk_wallet_word_suggestions(input, $0.bindMemory(to: UInt8.self).baseAddress, UInt64($0.count), &required)
            }
            try CitizenSDKChecks.requireOK(code, "word suggestions failed")
            guard let words = String(data: output, encoding: .utf8) else { throw CitizenSDKError(.integrity, "word suggestions are not UTF-8") }
            return words.split(separator: "\n").map(String.init)
        }
    }

    private static func withWalletInput<T>(_ value: String, _ body: (citizensdk_bytes_view_t) throws -> T) throws -> T {
        guard value.utf8.count <= 1_024 else { throw CitizenSDKError(.invalidArgument, "wallet input exceeds 1024 bytes") }
        var input = Data(value.utf8)
        defer { input.resetBytes(in: 0..<input.count) }
        return try input.withUnsafeBytes { bytes in
            var view = citizensdk_bytes_view_t()
            view.data = bytes.bindMemory(to: UInt8.self).baseAddress
            view.len = UInt64(bytes.count)
            return try body(view)
        }
    }

    func reconcileWalletCleanup() throws -> CitizenSDKOperation<Void> {
        try begin(accept: { citizensdk_reconcile_wallet_cleanup(handle, $0) }, decode: CitizenSDKNativeCodec.empty)
    }

    /// 资源或资产创建前先由核心拒绝非法组合；平台不复制模块依赖规则。
    static func validateModules(_ modules: CitizenSDKModules) throws {
        try CitizenSDKChecks.requireOK(citizensdk_validate_modules(modules.rawValue), "Invalid CitizenSDK modules")
    }

    /// 无实例、无宿主资源的公开验签，只借用公开输入并调用同一 Rust 实现。
    static func encodePayload(kind: UInt32, fieldsJSON: String, payload: Data) throws -> Data {
        let fields = Data(fieldsJSON.utf8)
        guard (1...6).contains(kind), fields.count <= 4096, payload.count <= 16 * 1024 * 1024 else {
            throw CitizenSDKError(.invalidArgument, "Payload input exceeds boundary")
        }
        return try withViews([fields, payload]) { views in
            try coreOutput(maximum: 16 * 1024 * 1024) { output, capacity, required in
                citizensdk_encode_signing_payload(kind, views[0], views[1], output, capacity, required)
            }
        }
    }

    static func encryptedSecretRecordHasSecret(accountID: Data, revision: UInt64, record: Data) throws -> Bool {
        guard accountID.count == 32, !record.isEmpty, record.count <= 65536 else {
            throw CitizenSDKError(.invalidArgument, "密文存在性输入边界无效")
        }
        var account = citizensdk_account_id_t()
        _ = withUnsafeMutableBytes(of: &account.bytes) { accountID.copyBytes(to: $0) }
        var present: UInt8 = 0
        let code = withViews([record]) { views in
            citizensdk_encrypted_secret_record_has_secret(&account, revision, views[0], &present)
        }
        try CitizenSDKChecks.requireOK(code, "密文存在性检查失败")
        guard present <= 1 else { throw CitizenSDKError(.integrity, "Core存在性结果无效") }
        return present == 1
    }

    static func verify(accountID: Data, signature: Data, message: Data) throws -> Bool {
        guard accountID.count == 32, signature.count == 64 else {
            throw CitizenSDKError(.invalidArgument, "accountId/signature length is invalid")
        }
        var account = citizensdk_account_id_t()
        _ = withUnsafeMutableBytes(of: &account.bytes) { accountID.copyBytes(to: $0) }
        var valid: UInt8 = 0
        let code = withViews([signature, message]) { views in
            citizensdk_verify_signature(&account, views[0], views[1], &valid)
        }
        try CitizenSDKChecks.requireOK(code, "CitizenSDK signature verification failed")
        guard valid <= 1 else { throw CitizenSDKError(.integrity, "Core returned an invalid verification result") }
        return valid == 1
    }

    func sign(accountID: Data, message: Data) throws -> CitizenSDKOperation<CitizenSignature> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try withView(message) { view in
                try begin(accept: { citizensdk_sign_wallet_payload(handle, pointer, view, $0) }, decode: CitizenSDKNativeCodec.signature)
            }
        }
    }

    func deriveApplicationKey(accountID: Data, salt: Data, info: Data)
        throws -> CitizenSDKOperation<Data> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try Self.withViews([salt, info]) { views in
                try begin(accept: {
                    citizensdk_derive_application_key(handle, pointer, views[0], views[1], $0)
                }, decode: CitizenSDKNativeCodec.applicationKey)
            }
        }
    }

    func deriveApplicationKeys(accountID: Data, salt: Data, infos: [Data])
        throws -> CitizenSDKOperation<[Data]> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try Self.withViews([salt] + infos) { views in
                let infoViews = Array(views.dropFirst())
                return try infoViews.withUnsafeBufferPointer { infoBuffer in
                    try begin(accept: {
                        citizensdk_derive_application_keys(handle, pointer, views[0],
                            infoBuffer.baseAddress, UInt32(infos.count), $0)
                    }, decode: { try CitizenSDKNativeCodec.applicationKeys($0, count: infos.count) })
                }
            }
        }
    }

    func prepareApplicationKeys(accountID: Data, salt: Data, infos: [Data], signingMessage: Data?)
        throws -> CitizenSDKOperation<CitizenApplicationKeyPreparation> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try Self.withViews([salt, signingMessage ?? Data()] + infos) { views in
                let infoViews = Array(views.dropFirst(2))
                return try infoViews.withUnsafeBufferPointer { infoBuffer in
                    try begin(accept: {
                        citizensdk_prepare_application_keys(handle, pointer, views[0],
                            infoBuffer.baseAddress, UInt32(infos.count), views[1], $0)
                    }, decode: { try CitizenSDKNativeCodec.applicationKeyPreparation($0, count: infos.count, signed: signingMessage != nil) })
                }
            }
        }
    }

    /// Product-independent signing. Core owns account-mode routing and exact
    /// transform application; this binding only borrows bounded opaque bytes.
    func beginSigning(_ intent: CitizenSigningIntent) throws -> CitizenSDKOperation<CitizenSigningOutcome> {
        var account = try cAccount(intent.accountID)
        return try withUnsafePointer(to: &account) { accountPointer in
            try Self.withViews([intent.payload, intent.domain]) { views in
                try begin(accept: {
                    citizensdk_begin_signing(
                        handle, accountPointer, views[0], intent.transform.rawValue,
                        views[1], intent.externalSignerTransport?.rawValue ?? 0,
                        intent.opaqueAction, intent.ttlSeconds, $0)
                }, decode: CitizenSDKNativeCodec.signingOutcome)
            }
        }
    }

    func consumeExternalSignature(sessionID: String, response: String) throws
        -> CitizenSDKOperation<CitizenSigningOutcome> {
        try Self.withViews([Data(sessionID.utf8), Data(response.utf8)]) { views in
            try begin(accept: {
                citizensdk_consume_external_signature(handle, views[0], views[1], $0)
            }, decode: CitizenSDKNativeCodec.signingOutcome)
        }
    }

    func cancelSigningSession(_ sessionID: String) throws -> Bool {
        try callLock.withLock {
            try requireOpen()
            var cancelled: UInt8 = 0
            try withView(Data(sessionID.utf8)) { view in
                try CitizenSDKChecks.requireOK(
                    citizensdk_cancel_signing_session(handle, view, &cancelled),
                    "Signing session cancellation failed")
            }
            guard cancelled <= 1 else {
                throw CitizenSDKError(.integrity, "Core returned invalid signing cancellation state")
            }
            return cancelled == 1
        }
    }

    func beginDefaultAccountChange(expectedRevision: UInt64, accountIDs: [Data],
                                   ttlSeconds: UInt64) throws
        -> CitizenSDKOperation<CitizenDefaultAccountChangeOutcome> {
        try withAccounts(accountIDs) { accounts, count in
            try begin(accept: {
                citizensdk_begin_default_account_change(
                    handle, expectedRevision, accounts, count, ttlSeconds, $0)
            }, decode: CitizenSDKNativeCodec.defaultAccountChange)
        }
    }

    func consumeDefaultAccountChange(sessionID: String, response: String) throws
        -> CitizenSDKOperation<CitizenDefaultAccountChangeOutcome> {
        try Self.withViews([Data(sessionID.utf8), Data(response.utf8)]) { views in
            try begin(accept: {
                citizensdk_consume_default_account_change(handle, views[0], views[1], $0)
            }, decode: CitizenSDKNativeCodec.defaultAccountChange)
        }
    }

    func qrEncodeDocument(_ inputJSON: String) throws -> CitizenQRDocument {
        let input = Data(inputJSON.utf8)
        guard input.count <= 65_536 else { throw CitizenSDKError(.invalidArgument, "QR content exceeds boundary") }
        let output = try withView(input) { view in
            try qrOutput(maximum: 65_536) { output, capacity, required in
                citizensdk_qr_encode_document(handle, view, output, capacity, required)
            }
        }
        return try CitizenQRDocument(coreJSON: qrString(output))
    }
    func qrPrepareAccountAuthorization(action: UInt32, payload: Data, accountID: String) throws -> CitizenQRAuthorization {
        let account = Data(accountID.utf8)
        guard payload.count <= 1920, account.count <= 1024 else { throw CitizenSDKError(.invalidArgument, "Authorization input exceeds boundary") }
        let output = try Self.withViews([payload, account]) { views in
            try qrOutput(maximum: 65_536) { output, capacity, required in
                citizensdk_qr_prepare_account_authorization(handle, action, views[0], views[1], output, capacity, required)
            }
        }
        return try CitizenQRAuthorization(coreJSON: qrString(output))
    }

    func qrParse(_ text: String) throws -> CitizenQRDocument {
        let input = Data(text.utf8)
        let canonical = try withView(input) { view in
            try qrOutput(maximum: 65_536) { output, capacity, required in
                citizensdk_qr_parse(handle, view, output, capacity, required)
            }
        }
        return try CitizenQRDocument(coreJSON: qrString(canonical))
    }

    func qrCreateSignRequest(action: UInt16, accountID: Data, payload: Data,
                             ttl: UInt64) throws -> String {
        var account = try cAccount(accountID)
        let output = try withUnsafePointer(to: &account) { account in
            try withView(payload) { payloadView in
                try qrOutput { output, capacity, required in
                    citizensdk_qr_create_sign_request(handle, action, account, payloadView,
                                                       ttl, output, capacity, required)
                }
            }
        }
        return try qrString(output)
    }

    func reviewQrSignRequest(_ text: String) throws -> CitizenSDKOperation<CitizenQRReview> {
        try withView(Data(text.utf8)) { view in
            try begin(accept: { citizensdk_review_qr_sign_request(handle, view, $0) }, decode: {
                try CitizenQRReview(owner: self, result: $0, json: CitizenSDKNativeCodec.qr($0, kind: 19))
            }, retainsResult: true)
        }
    }

    func signQrRequest(_ review: CitizenQRReview) throws -> CitizenSDKOperation<CitizenQRDocument> {
        let operation = try review.withResult(owner: self) { result in
            try begin(accept: { citizensdk_sign_qr_request(handle, result, $0) }, decode: {
                let value = try CitizenQRDocument(coreJSON: CitizenSDKNativeCodec.qr($0, kind: 20))
                guard value.kind == 2, let request = value.signRequest, !request.isEmpty, request.utf8.count <= 2331 else {
                    throw CitizenSDKError(.integrity, "Core QR 签名结果缺少原请求关联")
                }
                return value
            })
        }
        // Core已原子标记领取；显式release单独归还原引用，释放失败不能掩盖已接纳的签名操作。
        return operation
    }

    func qrValidateSignResponse(sessionID: String, response: String) throws {
        try callLock.withLock {
            try requireOpen()
            try withView(Data(sessionID.utf8)) { session in
                try withView(Data(response.utf8)) { text in
                    try CitizenSDKChecks.requireOK(
                        citizensdk_qr_validate_sign_response(handle, session, text),
                        "QR response preflight failed")
                }
            }
        }
    }

    func qrConsumeSignResponse(_ text: String) throws -> Data {
        try callLock.withLock {
            try requireOpen()
            var signature = Data(count: 64)
            try withView(Data(text.utf8)) { view in
                try signature.withUnsafeMutableBytes { bytes in
                    try CitizenSDKChecks.requireOK(
                        citizensdk_qr_consume_sign_response(handle, view, bytes.bindMemory(to: UInt8.self).baseAddress),
                        "QR sign response was rejected"
                    )
                }
            }
            return signature
        }
    }

    func qrCancelSignRequest(_ requestID: String) throws -> Bool {
        try callLock.withLock {
            try requireOpen()
            var cancelled: UInt8 = 0
            try withView(Data(requestID.utf8)) { view in
                try CitizenSDKChecks.requireOK(
                    citizensdk_qr_cancel_sign_request(handle, view, &cancelled),
                    "QR request cancellation failed"
                )
            }
            guard cancelled <= 1 else { throw CitizenSDKError(.integrity, "Core returned invalid QR cancellation state") }
            return cancelled == 1
        }
    }

    func qrEncodeAccountID(_ accountID: Data) throws -> String {
        var account = try cAccount(accountID)
        let output = try withUnsafePointer(to: &account) { account in
            try qrOutput { output, capacity, required in
                citizensdk_qr_encode_account_id(handle, account, output, capacity, required)
            }
        }
        return try qrString(output)
    }

    func qrDecodeLuminance(_ data: Data, width: UInt32, height: UInt32,
                           rowStride: UInt32) throws -> CitizenQRDocument {
        guard let first = try qrDecodeLuminanceAll(data, width: width, height: height, rowStride: rowStride, firstOnly: true).first else {
            throw CitizenSDKError(.notFound, "image contains no QR code")
        }
        return first
    }

    func qrDecodeLuminanceAll(_ data: Data, width: UInt32, height: UInt32,
                              rowStride: UInt32, firstOnly: Bool = false) throws -> [CitizenQRDocument] {
        try callLock.withLock {
            try requireQRModule()
            var required = 0
            let first = data.withUnsafeBytes { bytes in
                citizensdk_qr_image_decode_luminance_all(bytes.bindMemory(to: UInt8.self).baseAddress,
                    data.count, width, height, rowStride, nil, 0, &required)
            }
            guard first == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL, required >= 4, required <= 4 + 64 * (4 + 2_331) else {
                throw qrImageError(first, "ZXing-C++ QR decode failed")
            }
            var output = Data(count: required)
            defer { output.resetBytes(in: 0..<output.count) }
            let capacity = output.count
            let second = data.withUnsafeBytes { bytes in
                output.withUnsafeMutableBytes { destination in
                    citizensdk_qr_image_decode_luminance_all(bytes.bindMemory(to: UInt8.self).baseAddress,
                        data.count, width, height, rowStride, destination.bindMemory(to: UInt8.self).baseAddress,
                        capacity, &required)
                }
            }
            guard second == CITIZENSDK_QR_IMAGE_OK, required == capacity else { throw qrImageError(second, "ZXing-C++ QR decode failed") }
            var offset = 0
            func integer() throws -> Int {
                guard offset + 4 <= output.count else { throw CitizenSDKError(.integrity, "QR image tuple is truncated") }
                let value = (0..<4).reduce(0) { $0 | Int(output[offset + $1]) << ($1 * 8) }
                offset += 4
                return value
            }
            let count = try integer()
            guard (1...64).contains(count) else { throw CitizenSDKError(.integrity, "QR image count is invalid") }
            var documents: [CitizenQRDocument] = []
            for index in 0..<count {
                let length = try integer()
                guard (1...2_331).contains(length), offset + length <= output.count else { throw CitizenSDKError(.integrity, "QR image text length is invalid") }
                if !firstOnly || index == 0 {
                    documents.append(try qrParse(qrString(Data(output[offset..<offset + length]))))
                }
                offset += length
            }
            guard offset == output.count else { throw CitizenSDKError(.integrity, "QR image tuple has trailing bytes") }
            return documents
        }
    }

    func qrEncode(_ text: String, scale: UInt32) throws -> CitizenQRImage {
        try callLock.withLock {
            try requireQRModule()
            let input = Data(text.utf8)
            var width: UInt32 = 0
            var height: UInt32 = 0
            var required = 0
            let first = input.withUnsafeBytes { bytes in
                citizensdk_qr_image_encode_text(bytes.bindMemory(to: UInt8.self).baseAddress,
                    input.count, scale, nil, 0, &width, &height, &required)
            }
            guard first == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL, required > 0,
                  required <= 16 * 1_024 * 1_024 else {
                throw qrImageError(first, "ZXing-C++ QR encode failed")
            }
            var output = Data(count: required)
            let capacity = output.count
            let second = input.withUnsafeBytes { bytes in
                output.withUnsafeMutableBytes { destination in
                    citizensdk_qr_image_encode_text(bytes.bindMemory(to: UInt8.self).baseAddress,
                        input.count, scale, destination.bindMemory(to: UInt8.self).baseAddress,
                        capacity, &width, &height, &required)
                }
            }
            guard second == CITIZENSDK_QR_IMAGE_OK, required == capacity,
                  UInt64(width) * UInt64(height) == UInt64(output.count) else {
                throw qrImageError(second, "ZXing-C++ QR encode failed")
            }
            return CitizenQRImage(width: width, height: height, luminance: output)
        }
    }

    private func qrOutput(maximum: UInt64 = 2_331,
                          _ call: (UnsafeMutablePointer<UInt8>?, UInt64,
                                   UnsafeMutablePointer<UInt64>) -> Int32) throws -> Data {
        try callLock.withLock {
            try requireOpen()
            return try Self.coreOutput(maximum: maximum, call)
        }
    }

    /// 同一结果复制实现同时服务QR与无实例载荷编码，不复制算法或改变输出上限。
    private static func coreOutput(maximum: UInt64,
                          _ call: (UnsafeMutablePointer<UInt8>?, UInt64,
                                   UnsafeMutablePointer<UInt64>) -> Int32) throws -> Data {
            var required: UInt64 = 0
            try CitizenSDKChecks.requireOK(call(nil, 0, &required), "QR output query failed")
            guard required > 0, required <= maximum, required <= UInt64(Int.max) else {
                throw CitizenSDKError(.integrity, "QR output length is invalid")
            }
            var output = Data(count: Int(required))
            let code = output.withUnsafeMutableBytes {
                call($0.bindMemory(to: UInt8.self).baseAddress, UInt64($0.count), &required)
            }
            try CitizenSDKChecks.requireOK(code, "QR output copy failed")
            guard required == UInt64(output.count) else { throw CitizenSDKError(.integrity, "QR output length changed") }
            return output
    }

    private func qrString(_ data: Data) throws -> String {
        guard let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            throw CitizenSDKError(.integrity, "QR output is not UTF-8")
        }
        return value
    }

    func requireQRModule() throws {
        try callLock.withLock {
            try requireOpen()
            guard selectedModules.contains(.qr) else {
                throw CitizenSDKError(.unsupported, "CitizenSDK QR module is not enabled")
            }
        }
    }

    private func qrImageError(_ status: citizensdk_qr_image_status_t,
                              _ fallback: String) -> CitizenSDKError {
        let code: CitizenSDKErrorCode = switch status {
        case CITIZENSDK_QR_IMAGE_INVALID_ARGUMENT, CITIZENSDK_QR_IMAGE_CAPACITY_EXCEEDED: .invalidArgument
        case CITIZENSDK_QR_IMAGE_NO_CODE: .notFound
        case CITIZENSDK_QR_IMAGE_MULTIPLE_CODES: .conflict
        case CITIZENSDK_QR_IMAGE_INVALID_UTF8: .decode
        default: .internalFailure
        }
        return CitizenSDKError(code, fallback)
    }

    func prepareTransaction(source: Data, callData: Data)
        throws -> CitizenSDKOperation<CitizenPreparedTransaction> {
        var sourceAccount = try cAccount(source)
        return try withUnsafePointer(to: &sourceAccount) { sourcePointer in
            try withView(callData) { view in
                try begin(
                    accept: { citizensdk_prepare_transaction(handle, sourcePointer, view, $0) },
                    decode: { result in
                        let (nativeHandle, value) = try CitizenSDKNativeCodec.preparedTransaction(result)
                        self.routerLock.lock()
                        let existing = self.preparedTransactionHandles.updateValue(
                            nativeHandle, forKey: value.preparationID)
                        self.routerLock.unlock()
                        guard existing == nil else {
                            _ = citizensdk_prepared_transaction_release(self.handle, nativeHandle)
                            throw CitizenSDKError(.integrity, "Core returned a duplicate preparation identity")
                        }
                        return value
                    }
                )
            }
        }
    }

    func cancelPreparedTransaction(_ preparationID: String) throws {
        try callLock.withLock {
            try requireOpen()
            routerLock.lock()
            let prepared = preparedTransactionHandles.removeValue(forKey: preparationID)
            routerLock.unlock()
            guard let prepared else {
                throw CitizenSDKError(.notFound, "Transaction preparation was not found")
            }
            let status = citizensdk_prepared_transaction_release(handle, prepared)
            guard status == CITIZENSDK_OK else {
                routerLock.lock()
                preparedTransactionHandles[preparationID] = prepared
                routerLock.unlock()
                try CitizenSDKChecks.requireOK(status, "prepared transaction release failed")
                return
            }
        }
    }

    func executePreparedTransaction(_ preparationID: String)
        throws -> CitizenSDKOperation<CitizenTransactionExecution> {
        routerLock.lock()
        let prepared = preparedTransactionHandles.removeValue(forKey: preparationID)
        routerLock.unlock()
        guard let prepared else {
            throw CitizenSDKError(.notFound, "Transaction preparation was not found")
        }
        do {
            return try begin(
                accept: { citizensdk_execute_prepared_transaction(handle, prepared, $0) },
                decode: CitizenSDKNativeCodec.transactionExecution)
        } catch {
            // Core retains the prepared handle when bounded admission fails synchronously.
            routerLock.lock()
            preparedTransactionHandles[preparationID] = prepared
            routerLock.unlock()
            throw error
        }
    }

    func consumePreparedTransactionQrResponse(_ executionID: String, response: String)
        throws -> CitizenSDKOperation<CitizenTransactionExecution> {
        var identifier = try cExecutionID(executionID)
        return try withUnsafePointer(to: &identifier) { pointer in
            try withView(Data(response.utf8)) { responseView in
                try begin(
                    accept: {
                        citizensdk_transaction_execution_consume_qr_response(
                            handle, pointer, responseView, $0)
                    },
                    decode: CitizenSDKNativeCodec.transactionExecution)
            }
        }
    }

    func cancelPreparedTransactionExecution(_ executionID: String) throws {
        var identifier = try cExecutionID(executionID)
        try withUnsafePointer(to: &identifier) { pointer in
            try CitizenSDKChecks.requireOK(
                citizensdk_transaction_execution_cancel(handle, pointer),
                "transaction execution cancel failed")
        }
    }

    private func cExecutionID(_ value: String) throws -> citizensdk_transaction_execution_id_t {
        guard value.range(of: #"^0x[0-9a-f]{32}$"#, options: .regularExpression) != nil else {
            throw CitizenSDKError(.invalidArgument, "executionID is invalid")
        }
        var result = citizensdk_transaction_execution_id_t()
        let bytes = stride(from: 2, to: value.count, by: 2).compactMap { offset -> UInt8? in
            let start = value.index(value.startIndex, offsetBy: offset)
            let end = value.index(start, offsetBy: 2)
            return UInt8(value[start..<end], radix: 16)
        }
        guard bytes.count == 16 else { throw CitizenSDKError(.invalidArgument, "executionID is invalid") }
        withUnsafeMutableBytes(of: &result.bytes) { $0.copyBytes(from: bytes) }
        return result
    }

    func getTransactionHistory(beforeExecutionID: String?, limit: UInt32)
        throws -> CitizenSDKOperation<CitizenTransactionHistoryPage> {
        if let beforeExecutionID {
            var identifier = try cExecutionID(beforeExecutionID)
            return try withUnsafePointer(to: &identifier) { pointer in
                try begin(
                    accept: { citizensdk_get_transaction_history(handle, pointer, limit, $0) },
                    decode: CitizenSDKNativeCodec.transactionHistoryPage
                )
            }
        }
        return try begin(
            accept: { citizensdk_get_transaction_history(handle, nil, limit, $0) },
            decode: CitizenSDKNativeCodec.transactionHistoryPage
        )
    }

    func syncTransactionHistory() throws -> CitizenSDKOperation<CitizenTransactionHistoryPage> {
        try begin(
            accept: { citizensdk_sync_transaction_history(handle, $0) },
            decode: CitizenSDKNativeCodec.transactionHistoryPage
        )
    }

    func prepareWallet(wordCount: UInt32, password: CitizenSDKSensitiveBuffer) throws -> CitizenSDKOperation<UInt64> {
        try password.withUnsafeBytes { bytes in
            var view = citizensdk_bytes_view_t()
            view.data = bytes.bindMemory(to: UInt8.self).baseAddress
            view.len = UInt64(bytes.count)
            return try begin(accept: { citizensdk_prepare_wallet_creation(handle, wordCount, view, $0) }, decode: { result in
                let prepared = try CitizenSDKNativeCodec.preparedWallet(result)
                self.routerLock.lock(); self.preparedHandles.insert(prepared); self.routerLock.unlock()
                return prepared
            })
        }
    }

    func importWallet(mnemonic: CitizenSDKSensitiveBuffer,
                      password: CitizenSDKSensitiveBuffer) throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        try withSensitiveViews(mnemonic, password) { mnemonicView, passwordView in
            try begin(accept: { citizensdk_import_wallet(handle, mnemonicView, passwordView, $0) },
                      decode: CitizenSDKNativeCodec.profile)
        }
    }

    func addAccounts(mnemonic: CitizenSDKSensitiveBuffer, password: CitizenSDKSensitiveBuffer,
                     indices: [UInt32]) throws -> CitizenSDKOperation<CitizenWalletProfile> {
        try withSensitiveViews(mnemonic, password) { mnemonicView, passwordView in
            try indices.withUnsafeBufferPointer { values in
                try begin(accept: {
                    citizensdk_add_wallet_accounts(handle, mnemonicView, passwordView,
                                                   values.baseAddress, UInt32(values.count), $0)
                }, decode: { result in
                    guard let profile = try CitizenSDKNativeCodec.profile(result) else {
                        throw CitizenSDKError(.integrity, "add accounts returned no profile")
                    }
                    return profile
                })
            }
        }
    }

    func addNextAccount(mnemonic: CitizenSDKSensitiveBuffer, password: CitizenSDKSensitiveBuffer) throws -> CitizenSDKOperation<CitizenWalletProfile> {
        try withSensitiveViews(mnemonic, password) { mnemonicView, passwordView in
            try begin(accept: { citizensdk_add_next_wallet_account(handle, mnemonicView, passwordView, $0) }, decode: { result in
                guard let profile = try CitizenSDKNativeCodec.profile(result) else { throw CitizenSDKError(.integrity, "add next account returned no profile") }
                return profile
            })
        }
    }

    func copyPreparedMnemonic(_ prepared: UInt64) throws -> CitizenSDKSensitiveBuffer {
        try callLock.withLock {
            try requireOpen()
            routerLock.lock(); let owned = preparedHandles.contains(prepared); routerLock.unlock()
            guard owned else { throw CitizenSDKError(.invalidHandle, "prepared wallet is unknown") }
            var required: UInt64 = 0
            try CitizenSDKChecks.requireOK(
                citizensdk_prepared_wallet_copy_mnemonic(handle, prepared, nil, 0, &required),
                "prepared wallet mnemonic size query failed"
            )
            guard required <= 1_024 else { throw CitizenSDKError(.integrity, "prepared mnemonic exceeds the wallet contract") }
            let output = CitizenSDKSensitiveBuffer(count: Int(required))
            var confirmed = required
            let code = output.withUnsafeMutableBytes { bytes in
                citizensdk_prepared_wallet_copy_mnemonic(handle, prepared,
                                                         bytes.bindMemory(to: UInt8.self).baseAddress,
                                                         UInt64(bytes.count), &confirmed)
            }
            do {
                try CitizenSDKChecks.requireOK(code, "prepared wallet mnemonic copy failed")
                guard confirmed == required else { throw CitizenSDKError(.integrity, "prepared mnemonic length changed") }
                return output
            } catch {
                output.clear()
                throw error
            }
        }
    }

    func commitPrepared(_ prepared: UInt64) throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        try callLock.withLock {
            try requireOpen()
            routerLock.lock(); let owned = preparedHandles.contains(prepared); routerLock.unlock()
            guard owned else { throw CitizenSDKError(.invalidHandle, "prepared wallet is unknown") }
            let operation = try begin(accept: { citizensdk_commit_wallet_creation(handle, prepared, $0) },
                                      decode: CitizenSDKNativeCodec.profile)
            routerLock.lock(); preparedHandles.remove(prepared); routerLock.unlock()
            return operation
        }
    }

    func releasePrepared(_ prepared: UInt64) throws {
        try callLock.withLock {
            try requireOpen()
            routerLock.lock(); let owned = preparedHandles.contains(prepared); routerLock.unlock()
            guard owned else { return }
            try CitizenSDKChecks.requireOK(citizensdk_prepared_wallet_release(handle, prepared), "prepared wallet release failed")
            routerLock.lock(); preparedHandles.remove(prepared); routerLock.unlock()
        }
    }

    func close() throws {
        var prepared: Set<UInt64> = []
        var preparedTransactions: [String] = []
        try Self.withCheckpointSafeCloseGate(
            lock: callLock,
            checkpointRequired: {
                if closed { return false }
                routerLock.lock()
                let isBusy = !pending.isEmpty || !earlyCompletions.isEmpty || queuedDeliveries != 0
                prepared = preparedHandles
                preparedTransactions = preparedTransactionHandles.keys.sorted()
                routerLock.unlock()
                guard !isBusy else {
                    throw CitizenSDKError(.busy, "CitizenSDK has accepted work that has not completed")
                }
                return !teardown.snapshot.teardownStarted
            },
            lifecycle: readLifecycle
        ) {
            if closed { return }
            for identifier in preparedTransactions {
                try cancelPreparedTransaction(identifier)
                routerLock.lock()
                let removed = preparedTransactionHandles[identifier] == nil
                routerLock.unlock()
                guard removed else {
                    throw CitizenSDKError(.integrity, "prepared transaction release did not commit")
                }
            }
            try Self.releasePreparedBeforeDestroy(
                prepared.sorted(),
                release: { try releasePrepared($0) },
                destroy: {
                    guard deferredStateEvents.beginTeardownIfNoActiveDelivery() else {
                        throw CitizenSDKError(.busy, "CitizenSDK state event delivery is active")
                    }
                    try teardown.perform(
                        unsubscribe: {
                            try CitizenSDKChecks.requireOK(
                                citizensdk_unsubscribe_capability_changes(handle),
                                "Core capability monitor could not stop"
                            )
                        },
                        clearCallback: {
                            try CitizenSDKChecks.requireOK(
                                citizensdk_set_event_callback(handle, nil, nil),
                                "Core callback could not be cleared"
                            )
                        },
                        destroy: {
                            try CitizenSDKChecks.requireOK(
                                citizensdk_destroy(handle),
                                "CitizenSDK Core destruction failed"
                            )
                        },
                        didDestroy: { finishSuccessfulDestroy() }
                    )
                }
            )
        }
    }

    /// Serializes the authoritative lifecycle check and all subsequent close
    /// work with every request admission. Tests inject the same recursive lock
    /// to prove a concurrent start cannot cross this checkpoint.
    internal static func withCheckpointSafeCloseGate<T>(
        lock: NSRecursiveLock,
        checkpointRequired: () throws -> Bool,
        lifecycle: () throws -> CitizenSDKLifecycle,
        body: () throws -> T
    ) throws -> T {
        try lock.withLock {
            if try checkpointRequired() { try requireCheckpointSafeForClose(lifecycle()) }
            return try body()
        }
    }

    /// Rust shutdown is destructive for a running provider; graceful stop and
    /// checkpoint completion must precede the first ABI teardown call.
    internal static func requireCheckpointSafeForClose(_ lifecycle: CitizenSDKLifecycle) throws {
        switch lifecycle {
        case .created, .stopped, .startFailed:
            return
        case .running:
            throw CitizenSDKError(.invalidState, "A running CitizenSDK must complete stop before close")
        case .starting, .importingState:
            throw CitizenSDKError(.busy, "CitizenSDK lifecycle transition is still running")
        case .disposed:
            throw CitizenSDKError(.invalidState, "Core reported disposed before native destruction")
        }
    }

    /// Recovery owns no public facade. A live running instance first attempts
    /// the normal checkpointing stop; partial teardown skips every lifecycle
    /// query/control and resumes the phase machine directly.
    func supervisedClose() async throws {
        switch try Self.supervisedCloseAction(
            teardownStarted: teardown.snapshot.teardownStarted,
            lifecycle: self.lifecycle
        ) {
        case .stopThenClose:
            // Stop/checkpoint failure is retryable and must not silently
            // degrade into destructive teardown of a still-running instance.
            try await stop().value()
        case .close:
            break
        }
        try close()
    }

    /// Chooses recovery from the authoritative C lifecycle, never the facade's
    /// eventually-delivered event cache. Query failure is propagated before
    /// teardown begins; partial teardown bypasses every further control call.
    internal static func supervisedCloseAction(
        teardownStarted: Bool,
        lifecycle: () throws -> CitizenSDKLifecycle
    ) throws -> CitizenSDKSupervisedCloseAction {
        if teardownStarted { return .close }
        switch try lifecycle() {
        case .running:
            return .stopThenClose
        case .starting, .importingState:
            throw CitizenSDKError(.busy, "CitizenSDK lifecycle transition is still running")
        case .created, .stopped, .startFailed, .disposed:
            return .close
        }
    }

    func enqueueForSupervisedClose() {
        Task { await CitizenSDKLifecycleSupervisor.shared.adopt(self) }
    }

    var teardownStarted: Bool { teardown.snapshot.teardownStarted }

    /// Destruction is strictly after every prepared owner is released. A
    /// release failure stops teardown, leaves Native's prepared set intact and
    /// permits a later `close()` retry on the same live Core.
    internal static func releasePreparedBeforeDestroy(
        _ prepared: [UInt64],
        release: (UInt64) throws -> Void,
        destroy: () throws -> Void
    ) throws {
        for handle in prepared { try release(handle) }
        try destroy()
    }

    private func bindCallback() throws {
        try CitizenSDKChecks.requireOK(
            citizensdk_set_event_callback(handle, citizenSDKEventCallback,
                                           Unmanaged.passUnretained(self).toOpaque()),
            "Core callback binding failed"
        )
        try CitizenSDKChecks.requireOK(
            citizensdk_subscribe_capability_changes(handle),
            "Core capability subscription failed"
        )
    }

    private func begin<T: Sendable>(accept: (UnsafeMutablePointer<UInt64>) -> Int32,
                                    decode: @escaping (UInt64) throws -> T,
                                    retainsResult: Bool = false) throws -> CitizenSDKOperation<T> {
        try callLock.withLock {
            try requireOpen()
            let cancellation = Cancellation()
            let operationID = try CitizenSDKOperationIdentifiers.shared.allocate()
            let operation = CitizenSDKOperation<T>(operationID: operationID) { [weak self, cancellation] in
                guard let self, let request = cancellation.value() else { return false }
                return try self.cancel(request)
            }
            routerLock.lock()
            guard !admissionInProgress, earlyCompletions.isEmpty else {
                routerLock.unlock()
                throw CitizenSDKError(.integrity, "Core admission router is not quiescent")
            }
            admissionInProgress = true
            routerLock.unlock()

            var requestID: UInt64 = 0
            let code = accept(&requestID)
            let pending = Pending(
                decode: { try decode($0) },
                complete: { result in
                    operation.complete(result.flatMap { value in
                        guard let typed = value as? T else {
                            return .failure(CitizenSDKError(.integrity, "Core result type drifted"))
                        }
                        return .success(typed)
                    })
                },
                retainsResult: retainsResult
            )
            routerLock.lock()
            admissionInProgress = false
            let accepted = code == 0 && requestID != 0 && self.pending[requestID] == nil
            let completion = accepted ? earlyCompletions.removeValue(forKey: requestID) : nil
            let ownsEarlyDelivery = accepted && completion != nil
            if ownsEarlyDelivery { queuedDeliveries += 1 }
            let rejectedCompletions = Array(earlyCompletions.values)
            earlyCompletions.removeAll(keepingCapacity: true)
            if accepted && completion == nil { self.pending[requestID] = pending }
            routerLock.unlock()
            rejectedCompletions.forEach { _ = citizensdk_result_release($0) }

            if code != 0 { try CitizenSDKChecks.requireOK(code, "Core request was rejected") }
            guard requestID != 0 else { throw CitizenSDKError(.integrity, "Core returned an empty request identity") }
            guard accepted else { throw CitizenSDKError(.integrity, "Core reused an active request identity") }
            cancellation.bind(requestID)
            defer {
                if ownsEarlyDelivery {
                    routerLock.lock(); queuedDeliveries -= 1; routerLock.unlock()
                }
            }
            if let completion { routeCompletion(result: completion, pending: pending) }
            return operation
        }
    }

    private func cancel(_ requestID: UInt64) throws -> Bool {
        try callLock.withLock {
            try requireOpen()
            let code = citizensdk_cancel_request(handle, requestID)
            if code == CitizenSDKErrorCode.unsupported.rawValue { return false }
            try CitizenSDKChecks.requireOK(code, "Core cancellation was rejected")
            return true
        }
    }

    fileprivate func receive(_ event: citizensdk_event_t) {
        switch event.event_type {
        case 1:
            var release: UInt64?
            routerLock.lock()
            if let pending = pending.removeValue(forKey: event.request_id) {
                // Removal and delivery ownership are one router-lock commit.
                // Close therefore observes either `pending` or queued delivery,
                // so even a synchronously resumed/reentrant completion observer
                // cannot overlap callback teardown.
                queuedDeliveries += 1
                routerLock.unlock(); routeCompletion(result: event.result, pending: pending)
                routerLock.lock(); queuedDeliveries -= 1; routerLock.unlock()
            } else if admissionInProgress {
                if earlyCompletions[event.request_id] == nil {
                    earlyCompletions[event.request_id] = event.result
                } else {
                    release = event.result
                }
                routerLock.unlock()
            } else {
                release = event.result
                routerLock.unlock()
            }
            if let release { _ = citizensdk_result_release(release) }
        case 2:
            // Flutter/Darwin no longer exposes the removed transfer convenience
            // route. Raw Core watch results remain owned and are released here.
            if event.result != 0 { _ = citizensdk_result_release(event.result) }
        case 3:
            enqueueDeferredStateEvent(.capabilities(sequence: event.sequence))
        case 4:
            enqueueDeferredStateEvent(.lifecycle(sequence: event.sequence))
        case 5:
            guard event.request_id == 0, event.result == 0,
                  event.capability_revision == 0, event.reserved == 0 else { return }
            enqueueDeferredStateEvent(.history(sequence: event.sequence))
        case 7:
            guard event.request_id == 0, event.result == 0,
                  event.capability_revision == 0, event.reserved == 0 else { return }
            enqueueDeferredStateEvent(.wallet(sequence: event.sequence))
        case 6:
            guard event.request_id == 0, event.result != 0,
                  event.capability_revision == 0, event.reserved == 0 else {
                if event.result != 0 { _ = citizensdk_result_release(event.result) }
                return
            }
            do {
                let block = try CitizenSDKNativeCodec.block(event.result)
                guard block.finality == .finalized else {
                    throw CitizenSDKError(.integrity, "Core finalized event carried a best block")
                }
                _ = citizensdk_result_release(event.result)
                enqueueDeferredStateEvent(.finalized(sequence: event.sequence, block: block))
            } catch {
                _ = citizensdk_result_release(event.result)
            }
        default:
            if event.result != 0 { _ = citizensdk_result_release(event.result) }
        }
    }

    private func routeCompletion(result: UInt64, pending: Pending) {
        let outcome: Result<Any, Error>
        do { outcome = .success(try pending.decode(result)) }
        catch { outcome = .failure(error) }
        if pending.retainsResult, case .success = outcome {
            // 只有 QrReview 转移结果所有权，内部 owner 在确认接纳或取消后释放。
            pending.complete(outcome)
            return
        }
        let release = citizensdk_result_release(result)
        if release != 0, case .success = outcome {
            pending.complete(.failure(CitizenSDKError(.integrity, "Core result ownership could not be released")))
        } else {
            pending.complete(outcome)
        }
    }

    /// Runs only after the C callback has returned. The delivery gate and
    /// `callLock` linearize against close: either this query owns an active
    /// delivery and close returns BUSY, or teardown wins and the work is skipped.
    private func enqueueDeferredStateEvent(_ event: DeferredStateEvent) {
        deferredStateEvents.enqueue { [self] in
            do {
                switch event {
                case let .history(sequence):
                    publish(.historyChanged(sequence: sequence))
                case let .wallet(sequence):
                    publish(.walletChanged(sequence: sequence))
                case let .finalized(sequence, block):
                    publish(.finalizedBlockChanged(sequence: sequence, finalized: block))
                case let .capabilities(sequence):
                    publish(.capabilitiesChanged(sequence: sequence, capabilities: try capabilities()))
                case let .lifecycle(sequence):
                    publish(.lifecycleChanged(sequence: sequence, lifecycle: try lifecycle()))
                }
            } catch {
                // Lifecycle state is synchronously queryable. A failed or
                // teardown-raced notification is deliberately not invented.
            }
        }
    }

    private func publish(_ event: CitizenSDKEvent) {
        routerLock.lock(); let listener = eventListener; routerLock.unlock()
        listener?(event)
    }

    private func requireOpen() throws {
        if closed || handle == 0 { throw CitizenSDKError(.invalidState, "CitizenSDK native bridge is closed") }
        try teardown.requireOperational()
    }

    /// Caller holds `callLock` (directly or recursively), so the returned value
    /// cannot race request admission or the first teardown phase.
    private func readLifecycle() throws -> CitizenSDKLifecycle {
        var value: UInt32 = 0
        try CitizenSDKChecks.requireOK(citizensdk_get_lifecycle(handle, &value), "Core lifecycle query failed")
        guard let lifecycle = CitizenSDKLifecycle(rawValue: value) else {
            throw CitizenSDKError(.integrity, "Core returned an unknown lifecycle")
        }
        return lifecycle
    }

    private func finishSuccessfulDestroy() {
        handle = 0
        closed = true
        routerLock.lock(); eventListener = nil; routerLock.unlock()
        // Called only from `close()` while `callLock` is held. HostBridge (and
        // its SQLite stores) ends exactly at successful Core destruction, even
        // when the public facade remains strongly reachable afterward.
        let resources = abiResources
        abiResources = nil
        resources?.releaseAfterSuccessfulDestroy()
    }

    private func cAccount(_ data: Data) throws -> citizensdk_account_id_t {
        let checked = try CitizenSDKInputLimits.accountID(data)
        var output = citizensdk_account_id_t()
        _ = withUnsafeMutableBytes(of: &output.bytes) { checked.copyBytes(to: $0) }
        return output
    }

    private func cBlock(_ block: CitizenBlockRef) -> citizensdk_block_ref_t {
        var output = citizensdk_block_ref_t()
        output.struct_size = UInt32(MemoryLayout<citizensdk_block_ref_t>.size)
        output.abi_version = 1
        _ = withUnsafeMutableBytes(of: &output.hash) { block.hash.copyBytes(to: $0) }
        output.number = block.number
        output.finality = block.finality.rawValue
        output.reserved = 0
        return output
    }

    private func withAccounts<T>(_ values: [Data], body: (UnsafePointer<citizensdk_account_id_t>?, UInt32) throws -> T) throws -> T {
        let accounts = try values.map(cAccount)
        return try accounts.withUnsafeBufferPointer { try body($0.baseAddress, UInt32($0.count)) }
    }

    private func withSensitiveViews<T>(_ first: CitizenSDKSensitiveBuffer, _ second: CitizenSDKSensitiveBuffer,
                                       body: (citizensdk_bytes_view_t, citizensdk_bytes_view_t) throws -> T) rethrows -> T {
        try first.withUnsafeBytes { a in try second.withUnsafeBytes { b in
            var av = citizensdk_bytes_view_t(); av.data = a.bindMemory(to: UInt8.self).baseAddress; av.len = UInt64(a.count)
            var bv = citizensdk_bytes_view_t(); bv.data = b.bindMemory(to: UInt8.self).baseAddress; bv.len = UInt64(b.count)
            return try body(av, bv)
        } }
    }

    private static func withViews<T>(_ values: [Data], body: ([citizensdk_bytes_view_t]) throws -> T) rethrows -> T {
        func descend(_ index: Int, _ collected: [citizensdk_bytes_view_t]) throws -> T {
            if index == values.count { return try body(collected) }
            return try values[index].withUnsafeBytes { bytes in
                var view = citizensdk_bytes_view_t(); view.data = bytes.bindMemory(to: UInt8.self).baseAddress; view.len = UInt64(bytes.count)
                return try descend(index + 1, collected + [view])
            }
        }
        return try descend(0, [])
    }

    private func withView<T>(_ value: Data, body: (citizensdk_bytes_view_t) throws -> T) rethrows -> T {
        try value.withUnsafeBytes { bytes in
            var view = citizensdk_bytes_view_t(); view.data = bytes.bindMemory(to: UInt8.self).baseAddress; view.len = UInt64(bytes.count)
            return try body(view)
        }
    }

    static func lastError(fallback: String) -> String {
        var required: UInt64 = 0
        guard citizensdk_last_error_copy(nil, 0, &required) == 0, required <= UInt64(Int.max) else { return fallback }
        var bytes = Data(count: Int(required))
        var confirmed = required
        let code = bytes.withUnsafeMutableBytes {
            citizensdk_last_error_copy($0.bindMemory(to: UInt8.self).baseAddress, UInt64($0.count), &confirmed)
        }
        guard code == 0, confirmed == required, let value = String(data: bytes, encoding: .utf8), !value.isEmpty else { return fallback }
        return value
    }
}

private func citizenSDKEventCallback(_ context: UnsafeMutableRawPointer?,
                                     _ event: UnsafePointer<citizensdk_event_t>?) {
    guard let context, let event else { return }
    Unmanaged<CitizenSDKNative>.fromOpaque(context).takeUnretainedValue().receive(event.pointee)
}

private extension NSRecursiveLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock(); defer { unlock() }
        return try body()
    }
}
