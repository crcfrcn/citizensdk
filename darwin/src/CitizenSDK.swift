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

/// Couples Core's two borrowed Swift lifetimes: HostBridge and Core's ABI
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

/// Owns abandoned facades or core instances until their Core handle reaches
/// successful destruction. Actor dictionaries are the visible recovery owner;
/// Native's ABI lease closes the short handoff interval before actor adoption.
internal actor CitizenSDKLifecycleSupervisor {
    static let shared = CitizenSDKLifecycleSupervisor()
    private var nativeEntries: [ObjectIdentifier: CitizenSDKCore] = [:]
    private var facadeEntries: [ObjectIdentifier: CitizenSdk] = [:]

    func adopt(_ core: CitizenSDKCore) {
        let identity = ObjectIdentifier(core)
        guard nativeEntries[identity] == nil else { return }
        nativeEntries[identity] = core
        Task { await recoverNative(identity) }
    }

    func adopt(_ facade: CitizenSdk) {
        let identity = ObjectIdentifier(facade)
        guard facadeEntries[identity] == nil else { return }
        facadeEntries[identity] = facade
        Task { await recoverFacade(identity) }
    }

    private func recoverNative(_ identity: ObjectIdentifier) async {
        guard let core = nativeEntries[identity] else { return }
        _ = await CitizenSDKSupervisedRetry.run {
            do { try await core.supervisedClose(); return true }
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
internal final class CitizenSDKCore: @unchecked Sendable {
    fileprivate enum DeferredStateEvent: Sendable {
        case history(sequence: UInt64)
        case wallet(sequence: UInt64)
        case finalized(sequence: UInt64, block: CitizenBlockRef)
        case capabilities(sequence: UInt64)
        case lifecycle(sequence: UInt64)
    }

    fileprivate final class Pending {
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

    fileprivate final class Cancellation {
        fileprivate let lock = NSLock()
        fileprivate var requestID: UInt64?
        func bind(_ value: UInt64) { lock.lock(); requestID = value; lock.unlock() }
        func value() -> UInt64? { lock.lock(); defer { lock.unlock() }; return requestID }
    }

    fileprivate let callLock = NSRecursiveLock()
    fileprivate let routerLock = NSLock()
    fileprivate let deferredStateEvents = CitizenSDKDeferredEventGate(
        label: "org.citizen.sdk.apple.state-events"
    )
    fileprivate let teardown = CitizenSDKABITeardownCoordinator()
    fileprivate var handle: UInt64
    fileprivate let selectedModules: CitizenSDKModules
    fileprivate var closed = false
    /// Installed before callback binding and cleared only under `callLock` at
    /// successful destroy. It owns HostBridge plus Native's explicit ABI +1.
    fileprivate var abiResources: CitizenSDKABIBorrowedResources<CitizenSDKHostBridge, CitizenSDKCore>?
    fileprivate var pending: [UInt64: Pending] = [:]
    /// True only while one serialized C admission call may legally callback
    /// before its out_request_id has been observed by Swift.
    fileprivate var admissionInProgress = false
    fileprivate var earlyCompletions: [UInt64: UInt64] = [:]
    /// Includes completion batches removed from maps but not yet fully
    /// decoded, released and delivered to facade observers.
    fileprivate var queuedDeliveries = 0
    fileprivate var preparedHandles: Set<UInt64> = []
    fileprivate var preparedTransactionHandles: [String: UInt64] = [:]
    fileprivate var eventListener: ((CitizenSDKEvent) -> Void)?

    fileprivate init(handle: UInt64, modules: CitizenSDKModules) {
        self.handle = handle
        selectedModules = modules
    }

    static func open(assets: CitizenSDKAssets?, storageRoot: URL? = nil,
                     applicationID: String? = Bundle.main.bundleIdentifier,
                     modules: CitizenSDKModules = .full) throws -> CitizenSDKCore {
        try validateModules(modules)
        // QR不依赖存储或金库；统一资源组允许该选择使用空资源，仍由Rust校验模块。
        let needsHost = modules.contains(.chain) || modules.contains(.history) || modules.usesSecrets
        let host = needsHost
            ? try CitizenSDKHostBridge(root: storageRoot, applicationID: applicationID, modules: modules)
            : nil
        var handle: UInt64 = 0
        let name = Data("CitizenSDK".utf8)
        let version = Data("1.0.0".utf8)
        let create: (UnsafePointer<citizensdk_stores_v1_t>?) -> Int32 = { stores in
            withViews([assets?.manifest ?? Data(), assets?.chainSpec ?? Data(), assets?.lightSyncState ?? Data(), name, version]) { views in
                var options = citizensdk_create_options_t()
                options.struct_size = UInt32(MemoryLayout<citizensdk_create_options_t>.size)
                options.abi_version = CITIZENSDK_ABI_VERSION
                options.asset_manifest = views[0]
                options.chain_spec = views[1]
                options.light_sync_state = views[2]
                options.system_name = views[3]
                options.system_version = views[4]
                return citizensdk_create(&options,modules.rawValue,stores,&handle)
            }
        }
        let code: Int32
        if let host {
            code = host.withStores { create($0) }
        } else {
            var stores=citizensdk_stores_v1_t();stores.struct_size=UInt32(MemoryLayout<citizensdk_stores_v1_t>.size);stores.abi_version = CITIZENSDK_ABI_VERSION
            code = create(&stores)
        }
        try CitizenSDKChecks.requireOK(code, "CitizenSDK Core creation failed")
        guard handle != 0 else { throw CitizenSDKError(.integrity, "Core returned an empty instance handle") }
        let core = CitizenSDKCore(handle: handle, modules: modules)
        // Arm before exposing this object or installing a passUnretained
        // callback context. The lease also keeps every HostBridge context live.
        if let host {
            core.abiResources = CitizenSDKABIBorrowedResources(host: host, owner: core)
        }
        try bindOrRecover(
            bind: {

                try core.bindCallback()
            },
            close: core.close,
            supervise: core.enqueueForSupervisedClose
        )
        return core
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

    func ffiHandle() throws -> UInt64 {try callLock.withLock {try requireOpen();return handle}}

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
            value.abi_version = CITIZENSDK_ABI_VERSION
            try CitizenSDKChecks.requireOK(citizensdk_get_capabilities(handle, &value), "Core capability query failed")
            return try CitizenSDKRead.capabilities(value)
        }
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
        try begin(accept: { citizensdk_stop(handle, $0) }, decode: CitizenSDKRead.empty)
    }









    func storage(_ block: CitizenBlockRef, key: Data) throws -> CitizenSDKOperation<Data?> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try withView(key) { view in
                try begin(accept: { citizensdk_get_storage_at(handle, pointer, view, $0) },
                          decode: CitizenSDKRead.storage)
            }
        }
    }
    func storageBatch(_ block: CitizenBlockRef, keys: [Data]) throws -> CitizenSDKOperation<[Data?]> {
        var value = cBlock(block)
        return try withUnsafePointer(to: &value) { pointer in
            try CitizenSDKCore.withViews(keys) { views in
                try views.withUnsafeBufferPointer { buffer in
                    try begin(accept: {
                        citizensdk_get_storage_batch_at(
                            handle, pointer, buffer.baseAddress, UInt32(buffer.count), $0)
                    }, decode: CitizenSDKRead.storageBatch)
                }
            }
        }
    }







    func walletProfile() throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        try begin(accept: { citizensdk_get_wallet_profile(handle, $0) }, decode: CitizenSDKRead.profile)
    }
    func walletState() throws -> CitizenSDKOperation<CitizenWalletState> {
        try begin(accept: { citizensdk_get_wallet_state(handle, $0) }, decode: CitizenSDKRead.walletState)
    }

    func inspectWallets() throws -> CitizenSDKOperation<CitizenWalletInspection> {
        // 使用同一真实结果及原完成所有权转交，不建立第二目录或额外查库。
        try begin(accept: { citizensdk_get_wallet_state(handle, $0) }, decode: {
            CitizenWalletInspection(owner: self, result: $0, state: try CitizenSDKRead.walletState($0))
        }, retainsResult: true)
    }

    func releaseWalletInspection(_ result: UInt64) throws {
        try CitizenSDKChecks.requireOK(citizensdk_result_release(result), "钱包检查资源释放失败")
    }

    func repairHotWallet(_ inspection: CitizenWalletInspection, walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try inspection.withResult(owner: self) { result in
            try begin(accept: { citizensdk_repair_hot_wallet(handle, result, walletIndex, $0) }, decode: CitizenSDKRead.walletState)
        }
    }

    func renameDiagnosticWallet(_ inspection: CitizenWalletInspection, walletIndex: UInt32, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        try inspection.withResult(owner: self) { result in
            try withView(Data(name.utf8)) { name in
                try begin(accept: { citizensdk_rename_diagnostic_wallet(handle, result, walletIndex, name, $0) }, decode: CitizenSDKRead.walletState)
            }
        }
    }

    func deleteDiagnosticWallet(_ inspection: CitizenWalletInspection, walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try inspection.withResult(owner: self) { result in
            try begin(accept: { citizensdk_delete_diagnostic_wallet(handle, result, walletIndex, $0) }, decode: CitizenSDKRead.walletState)
        }
    }

    func importColdAccountID(_ accountID: Data, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        var account = try cAccount(accountID)
        let bytes = Data(name.utf8)
        return try withUnsafePointer(to: &account) { pointer in
            try withView(bytes) { view in
                try begin(accept: { citizensdk_import_cold_account_id(handle, pointer, view, $0) },
                          decode: CitizenSDKRead.walletState)
            }
        }
    }













    /// 私有回调只借用受控显示缓冲；普通请求只解码 Empty，并持有 context 到真实终态。
    func openPrivateKeyView(accountID: Data, buffer: CitizenSDKPrivateKeyReceiver)
        throws -> (UInt64, CitizenSDKOperation<Void>) {
        var account = try cAccount(accountID)
        guard let host = callLock.withLock({ abiResources?.hostSnapshot }) else {
            throw CitizenSDKError(.invalidState, "fileprivate key view host is closed")
        }
        buffer.bindAuthenticationRegistry(host.registerPrivateKeyAuthentication)
        let context = Unmanaged.passRetained(buffer)
        var view = citizensdk_private_key_receiver_v1_t()
        view.struct_size = UInt32(MemoryLayout<citizensdk_private_key_receiver_v1_t>.size)
        view.abi_version = CITIZENSDK_ABI_VERSION
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
                }, decode: CitizenSDKRead.empty)
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
            try CitizenSDKChecks.requireOK(citizensdk_private_key_reveal(handle, viewID), "fileprivate key view reveal failed")
        }
    }

    func cancelPrivateKeyView(_ viewID: UInt64) throws {
        try callLock.withLock {
            try requireOpen()
            try CitizenSDKChecks.requireOK(citizensdk_private_key_cancel(handle, viewID), "fileprivate key view cancellation failed")
        }
    }

    func finishPrivateKeyView(_ viewID: UInt64) throws {
        try callLock.withLock {
            try requireOpen()
            try CitizenSDKChecks.requireOK(citizensdk_private_key_finish(handle, viewID), "fileprivate key view finish failed")
        }
    }

    func isPrivateKeyAuthenticationActive(_ operationID: UInt64) -> Bool {
        callLock.withLock { abiResources?.hostSnapshot?.isAuthenticationActive(operationID) ?? false }
    }
    func cancelPrivateKeyAuthentication(_ operationID: UInt64) {
        let host = callLock.withLock { abiResources?.hostSnapshot }
        host?.cancelAuthentication(operationID)
    }









    func renameAccount(_ accountID: Data, name: String) throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        var account = try cAccount(accountID)
        let bytes = Data(name.utf8)
        return try withUnsafePointer(to: &account) { pointer in
            try withView(bytes) { view in
                try begin(accept: { citizensdk_rename_wallet_account(handle, pointer, view, $0) }, decode: CitizenSDKRead.profile)
            }
        }
    }

    func deleteAccount(_ accountID: Data) throws -> CitizenSDKOperation<Void> {
        var account = try cAccount(accountID)
        return try withUnsafePointer(to: &account) { pointer in
            try begin(accept: { citizensdk_delete_wallet_account(handle, pointer, $0) }, decode: CitizenSDKRead.empty)
        }
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
            result.abi_version = CITIZENSDK_ABI_VERSION
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

    fileprivate static func withWalletInput<T>(_ value: String, _ body: (citizensdk_bytes_view_t) throws -> T) throws -> T {
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
        try begin(accept: { citizensdk_reconcile_wallet_cleanup(handle, $0) }, decode: CitizenSDKRead.empty)
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






    /// Product-independent signing. Core owns account-mode routing and exact
    /// transform application; this binding only borrows bounded opaque bytes.













    func qrParse(_ text: String) throws -> CitizenQRDocument {
        let input = Data(text.utf8)
        let canonical = try withView(input) { view in
            try qrOutput(maximum: 65_536) { output, capacity, required in
                citizensdk_qr_parse(handle, view, 0, output, capacity, required)
            }
        }
        return try CitizenQRDocument(coreJSON: qrString(canonical))
    }



    func reviewQrSignRequest(_ text: String) throws -> CitizenSDKOperation<CitizenQRReview> {
        try withView(Data(text.utf8)) { view in
            try begin(accept: { citizensdk_review_qr_sign_request(handle, view, $0) }, decode: {
                try CitizenQRReview(owner: self, result: $0, json: CitizenSDKRead.qr($0, kind: 19))
            }, retainsResult: true)
        }
    }

    func signQrRequest(_ review: CitizenQRReview) throws -> CitizenSDKOperation<CitizenQRDocument> {
        let operation = try review.withResult(owner: self) { result in
            try begin(accept: { citizensdk_sign_qr_request(handle, result, $0) }, decode: {
                let value = try CitizenQRDocument(coreJSON: CitizenSDKRead.qr($0, kind: 20))
                guard value.kind == 2, let request = value.signRequest, !request.isEmpty, request.utf8.count <= 2331 else {
                    throw CitizenSDKError(.integrity, "Core QR 签名结果缺少原请求关联")
                }
                return value
            })
        }
        // Core已原子标记领取；显式release单独归还原引用，释放失败不能掩盖已接纳的签名操作。
        return operation
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



    fileprivate func qrOutput(maximum: UInt64 = 2_331,
                          _ call: (UnsafeMutablePointer<UInt8>?, UInt64,
                                   UnsafeMutablePointer<UInt64>) -> Int32) throws -> Data {
        try callLock.withLock {
            try requireOpen()
            return try Self.coreOutput(maximum: maximum, call)
        }
    }

    /// 同一结果复制实现同时服务QR与无实例载荷编码，不复制算法或改变输出上限。
    fileprivate static func coreOutput(maximum: UInt64,
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

    fileprivate func qrString(_ data: Data) throws -> String {
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

    fileprivate func qrImageError(_ status: citizensdk_qr_image_status_t,
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
                decode: CitizenSDKRead.transactionExecution)
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
                    decode: CitizenSDKRead.transactionExecution)
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

    fileprivate func cExecutionID(_ value: String) throws -> citizensdk_transaction_execution_id_t {
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
                                      decode: CitizenSDKRead.profile)
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
            throw CitizenSDKError(.invalidState, "Core reported disposed before core destruction")
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

    fileprivate func bindCallback() throws {
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

    fileprivate func begin<T: Sendable>(accept: (UnsafeMutablePointer<UInt64>) -> Int32,
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

    fileprivate func cancel(_ requestID: UInt64) throws -> Bool {
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
                let block = try CitizenSDKRead.block(event.result)
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

    fileprivate func routeCompletion(result: UInt64, pending: Pending) {
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
    fileprivate func enqueueDeferredStateEvent(_ event: DeferredStateEvent) {
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

    fileprivate func publish(_ event: CitizenSDKEvent) {
        routerLock.lock(); let listener = eventListener; routerLock.unlock()
        listener?(event)
    }

    fileprivate func requireOpen() throws {
        if closed || handle == 0 { throw CitizenSDKError(.invalidState, "CitizenSDK core bridge is closed") }
        try teardown.requireOperational()
    }

    /// Caller holds `callLock` (directly or recursively), so the returned value
    /// cannot race request admission or the first teardown phase.
    fileprivate func readLifecycle() throws -> CitizenSDKLifecycle {
        var value: UInt32 = 0
        try CitizenSDKChecks.requireOK(citizensdk_get_lifecycle(handle, &value), "Core lifecycle query failed")
        guard let lifecycle = CitizenSDKLifecycle(rawValue: value) else {
            throw CitizenSDKError(.integrity, "Core returned an unknown lifecycle")
        }
        return lifecycle
    }

    fileprivate func finishSuccessfulDestroy() {
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

    fileprivate func cAccount(_ data: Data) throws -> citizensdk_account_id_t {
        let checked = try CitizenSDKInputLimits.accountID(data)
        var output = citizensdk_account_id_t()
        _ = withUnsafeMutableBytes(of: &output.bytes) { checked.copyBytes(to: $0) }
        return output
    }

    fileprivate func cBlock(_ block: CitizenBlockRef) -> citizensdk_block_ref_t {
        var output = citizensdk_block_ref_t()
        output.struct_size = UInt32(MemoryLayout<citizensdk_block_ref_t>.size)
        output.abi_version = CITIZENSDK_ABI_VERSION
        _ = withUnsafeMutableBytes(of: &output.hash) { block.hash.copyBytes(to: $0) }
        output.number = block.number
        output.finality = block.finality.rawValue
        output.reserved = 0
        return output
    }

    fileprivate func withAccounts<T>(_ values: [Data], body: (UnsafePointer<citizensdk_account_id_t>?, UInt32) throws -> T) throws -> T {
        let accounts = try values.map(cAccount)
        return try accounts.withUnsafeBufferPointer { try body($0.baseAddress, UInt32($0.count)) }
    }

    fileprivate func withSensitiveViews<T>(_ first: CitizenSDKSensitiveBuffer, _ second: CitizenSDKSensitiveBuffer,
                                       body: (citizensdk_bytes_view_t, citizensdk_bytes_view_t) throws -> T) rethrows -> T {
        try first.withUnsafeBytes { a in try second.withUnsafeBytes { b in
            var av = citizensdk_bytes_view_t(); av.data = a.bindMemory(to: UInt8.self).baseAddress; av.len = UInt64(a.count)
            var bv = citizensdk_bytes_view_t(); bv.data = b.bindMemory(to: UInt8.self).baseAddress; bv.len = UInt64(b.count)
            return try body(av, bv)
        } }
    }

    fileprivate static func withViews<T>(_ values: [Data], body: ([citizensdk_bytes_view_t]) throws -> T) rethrows -> T {
        func descend(_ index: Int, _ collected: [citizensdk_bytes_view_t]) throws -> T {
            if index == values.count { return try body(collected) }
            return try values[index].withUnsafeBytes { bytes in
                var view = citizensdk_bytes_view_t(); view.data = bytes.bindMemory(to: UInt8.self).baseAddress; view.len = UInt64(bytes.count)
                return try descend(index + 1, collected + [view])
            }
        }
        return try descend(0, [])
    }

    fileprivate func withView<T>(_ value: Data, body: (citizensdk_bytes_view_t) throws -> T) rethrows -> T {
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
    Unmanaged<CitizenSDKCore>.fromOpaque(context).takeUnretainedValue().receive(event.pointee)
}

private extension NSRecursiveLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock(); defer { unlock() }
        return try body()
    }
}

import Foundation
import CoreGraphics
import ImageIO

/// 同实例真实钱包快照的拥有者；释放与接纳共用锁，不暴露Core句柄。
public final class CitizenWalletInspection: @unchecked Sendable {
    public let state: CitizenWalletState
    private let owner: CitizenSDKCore
    private let lock = NSLock()
    private var result: UInt64
    private var released: ((CitizenWalletInspection) -> Void)?
    internal init(owner: CitizenSDKCore, result: UInt64, state: CitizenWalletState) {
        self.owner = owner; self.result = result; self.state = state
    }
    internal func withResult<T>(owner: CitizenSDKCore, _ body: (UInt64) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard self.owner === owner, result != 0 else { throw CitizenSDKError(.invalidState, "钱包检查资源已释放或跨实例") }
        return try body(result)
    }
    internal func onRelease(_ handler: @escaping (CitizenWalletInspection) -> Void) {
        lock.lock(); defer { lock.unlock() }; released = handler
    }
    public func repairHot(walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try owner.repairHotWallet(self, walletIndex: walletIndex)
    }
    public func rename(walletIndex: UInt32, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        try owner.renameDiagnosticWallet(self, walletIndex: walletIndex, name: CitizenSDKInputLimits.accountName(name))
    }
    public func delete(walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try owner.deleteDiagnosticWallet(self, walletIndex: walletIndex)
    }
    public func release() throws {
        lock.lock()
        if result != 0 {
            do { try owner.releaseWalletInspection(result) }
            catch { lock.unlock(); throw error }
            result = 0
        }
        let handler = released; released = nil; lock.unlock()
        handler?(self)
    }
    deinit { try? release() }
}

/// Native Swift facade for one CitizenSDK Core instance.
///
/// 不暴露Core裸句柄，不提供页面或窗口。显式钱包输入和受控备份资源可短时
/// 携带敏感内容；普通签名只引用SDK金库，界面与展示文案由宿主负责。
public final class CitizenSdk: @unchecked Sendable {
    @_spi(CitizenSDKFlutter) public func detachFfi() {
        let core=self.core
if let handle=try? core.ffiHandle(){_ = citizensdk_detach(handle)}}
    @_spi(CitizenSDKFlutter) public func ffiHandle() throws -> UInt64 {
        let core=self.core
return try core.ffiHandle()}
    public let sessionID = UUID().uuidString
    private let stateLock = NSLock()
    private let core: CitizenSDKCore
    private var lifecycleValue: CitizenSDKLifecycle
    private var closed = false
    private var resourcesClosing = false
    private var preparedWallets: [ObjectIdentifier: CitizenSDKPreparedWallet] = [:]
    private var privateKeys: [ObjectIdentifier: CitizenSDKPrivateKey] = [:]
    private var qrReviews: [ObjectIdentifier: CitizenQRReview] = [:]
    private var walletInspections: [ObjectIdentifier: CitizenWalletInspection] = [:]
    private var qrCaptures: [ObjectIdentifier: CitizenSDKQrCapture] = [:]
    private var eventHandler: ((CitizenSDKEvent) -> Void)?

    private init(core: CitizenSDKCore, lifecycle: CitizenSDKLifecycle) {
        self.core = core
        lifecycleValue = lifecycle
        CitizenSDKCloseGate.shared.registerOpen(self)
    }

    /// 未选择链时不读取链资产；钱包、签名和链均由同一核心按模块装配。
    public static func open(modules: CitizenSDKModules = .full) throws -> CitizenSdk {
        try CitizenSDKCore.validateModules(modules)
        let core = try CitizenSDKCore.open(
            assets: modules.contains(.chain) ? CitizenSDKAssets.load() : nil, modules: modules
        )
        return try finishOpen(core)
    }

    internal static func open(storageRoot: URL, applicationID: String? = Bundle.main.bundleIdentifier,
                              assets: CitizenSDKAssets? = nil, modules: CitizenSDKModules = .full) throws -> CitizenSdk {
        try CitizenSDKCore.validateModules(modules)
        let core = try CitizenSDKCore.open(
            assets: modules.contains(.chain) ? (assets ?? CitizenSDKAssets.load()) : nil,
            storageRoot: storageRoot, applicationID: applicationID, modules: modules
        )
        return try finishOpen(core)
    }

    private static func finishOpen(_ core: CitizenSDKCore) throws -> CitizenSdk {
        return try finalizeOpen(
            lifecycle: core.lifecycle,
            install: { lifecycle in
            let sdk = CitizenSdk(core: core, lifecycle: lifecycle)
            core.setEventListener { [weak sdk] event in sdk?.receive(event) }
            return sdk
            },
            cleanup: {
            // A freshly created instance is still in the destroyable CREATED
            // state. Preserve the initialization error while closing Core and
            // all host resources best-effort.
            core.setEventListener(nil)
            do { try core.close() }
            catch { core.enqueueForSupervisedClose() }
            }
        )
    }

    deinit {
        stateLock.lock()
        let needsRecovery = !closed
        let keys = Array(privateKeys.values)
        let captures = Array(qrCaptures.values)
        stateLock.unlock()
        keys.forEach { $0.requestClose() }
        captures.forEach { $0.requestClose() }
        if needsRecovery { core.enqueueForSupervisedClose() }
        CitizenSDKCloseGate.shared.forget(self)
    }

    /// One cleanup gate shared by the production constructor and source-level
    /// fault-injection tests. Any lifecycle or listener-install failure must
    /// close the freshly-created Core exactly once while preserving the
    /// original error.
    internal static func finalizeOpen<T>(
        lifecycle: () throws -> CitizenSDKLifecycle,
        install: (CitizenSDKLifecycle) throws -> T,
        cleanup: () -> Void
    ) throws -> T {
        do { return try install(lifecycle()) }
        catch { cleanup(); throw error }
    }

    public var lifecycle: CitizenSDKLifecycle {
        stateLock.lock(); defer { stateLock.unlock() }
        return lifecycleValue
    }

    public func setEventHandler(_ handler: ((CitizenSDKEvent) -> Void)?) throws {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !closed else { throw CitizenSDKError(.invalidState, "CitizenSDK is closed") }
        eventHandler = handler
    }

    public func start() async throws {
        let core=self.core

        try await (core.begin(accept: { citizensdk_start(core.handle, $0) }, decode: CitizenSDKRead.empty)).value()
    }

    /// Flutter资源通道在参数解码前调用；公共接纳算法只在Rust Core实现。
    @_spi(CitizenSDKFlutter) public func acceptRequestSequence(_ sequence: Int64) throws {
        let core=self.core

        try core.acceptRequestSequence(sequence)
    }

    public func stop() async throws {
        let core=self.core

        try await (core.begin(accept: { citizensdk_stop(core.handle, $0) }, decode: CitizenSDKRead.empty)).value()
    }

    public func refreshCapabilities() async throws {
        let core=self.core

        try await (core.begin(accept: { citizensdk_refresh_capabilities(core.handle, $0) }, decode: CitizenSDKRead.empty)).value()
    }

    public func capabilities() throws -> CitizenSDKCapabilities {
        let core=self.core
 return try (core.callLock.withLock {
            try core.requireOpen()
            var value = citizensdk_capability_snapshot_t()
            value.struct_size = UInt32(MemoryLayout<citizensdk_capability_snapshot_t>.size)
            value.abi_version = CITIZENSDK_ABI_VERSION
            try CitizenSDKChecks.requireOK(citizensdk_get_capabilities(core.handle, &value), "Core capability query failed")
            return try CitizenSDKRead.capabilities(value)
        }) }
    public func finalizedHead() async throws -> CitizenBlockRef {
        let core=self.core
 return try await (core.begin(accept: { citizensdk_get_finalized_head(core.handle, $0) }, decode: CitizenSDKRead.block)).value() }
    public func syncStatus() async throws -> CitizenChainSyncStatus {
        let core=self.core
 return try await (core.begin(accept: { citizensdk_get_sync_status(core.handle, $0) }, decode: CitizenSDKRead.syncStatus)).value() }
    public func bestHead() async throws -> CitizenBlockRef {
        let core=self.core
 return try await (core.begin(accept: { citizensdk_get_best_head(core.handle, $0) }, decode: CitizenSDKRead.block)).value() }
    public func finalizedBlock(at number: UInt64) async throws -> CitizenBlockRef {
        let core=self.core

        return try await (core.begin(accept: { citizensdk_get_finalized_block_at(core.handle, (number), $0) },
                  decode: CitizenSDKRead.block)).value()
    }
    public func resolveFinalizedBlock(hash: Data, number: UInt64) async throws -> CitizenBlockRef {
        let core=self.core

let checked = try CitizenSDKInputLimits.accountID((hash), label: "block hash")
        return try await (checked.withUnsafeBytes { bytes in
            try core.begin(accept: {
                citizensdk_resolve_finalized_block(
                    core.handle, bytes.bindMemory(to: UInt8.self).baseAddress, (number), $0)
            }, decode: CitizenSDKRead.block)
        }).value()
    }
    public func blockHeader(_ block: CitizenBlockRef) async throws -> CitizenBlockHeader {
        let core=self.core

var value = core.cBlock((block))
        return try await (withUnsafePointer(to: &value) { pointer in
            try core.begin(accept: { citizensdk_get_block_header_at(core.handle, pointer, $0) },
                      decode: CitizenSDKRead.blockHeader)
        }).value()
    }
    public func blockBody(_ block: CitizenBlockRef) async throws -> CitizenBlockBody {
        let core=self.core

var value = core.cBlock((block))
        return try await (withUnsafePointer(to: &value) { pointer in
            try core.begin(accept: { citizensdk_get_block_body_at(core.handle, pointer, $0) },
                      decode: CitizenSDKRead.blockBody)
        }).value()
    }
    public func runtimeContext(_ block: CitizenBlockRef) async throws -> CitizenRuntimeContext {
        let core=self.core

var value = core.cBlock((block))
        return try await (withUnsafePointer(to: &value) { pointer in
            try core.begin(accept: { citizensdk_get_runtime_context_at(core.handle, pointer, $0) },
                      decode: CitizenSDKRead.runtimeContext)
        }).value()
    }
    public func storage(_ block: CitizenBlockRef, key: Data) async throws -> Data? {
        let core=self.core

var value = core.cBlock((block))
        return try await (withUnsafePointer(to: &value) { pointer in
            try core.withView((CitizenSDKInputLimits.storageKey(key))) { view in
                try core.begin(accept: { citizensdk_get_storage_at(core.handle, pointer, view, $0) },
                          decode: CitizenSDKRead.storage)
            }
        }).value()
    }
    public func storageBatch(_ block: CitizenBlockRef, keys: [Data]) async throws -> [Data?] {
        let core=self.core

var value = core.cBlock((block))
        return try await (withUnsafePointer(to: &value) { pointer in
            try CitizenSDKCore.withViews((CitizenSDKInputLimits.storageKeys(keys))) { views in
                try views.withUnsafeBufferPointer { buffer in
                    try core.begin(accept: {
                        citizensdk_get_storage_batch_at(
                            core.handle, pointer, buffer.baseAddress, UInt32(buffer.count), $0)
                    }, decode: CitizenSDKRead.storageBatch)
                }
            }
        }).value()
    }
    public func storageKeysPaged(_ finalizedBlock: CitizenBlockRef, prefix: Data,
                                 startKey: Data? = nil, limit: UInt32 = 1_000) async throws -> [Data] {
        let core=self.core

        guard finalizedBlock.finality == .finalized, (1...4_096).contains(prefix.count),
              startKey.map({ (1...4_096).contains($0.count) }) ?? true,
              (1...1_000).contains(limit) else {
            throw CitizenSDKError(.invalidArgument, "storage keys page request is invalid")
        }
var value = core.cBlock((finalizedBlock))
        return try await (withUnsafePointer(to: &value) { pointer in
            try CitizenSDKCore.withViews([(prefix), (startKey) ?? Data()]) { views in
                try core.begin(accept: {
                    citizensdk_get_storage_keys_paged(
                        core.handle, pointer, views[0], (startKey) == nil ? 0 : 1,
                        views[1], (limit), $0)
                }, decode: { result in
                    let values = try CitizenSDKRead.storageBatch(result)
                    guard values.allSatisfy({ $0 != nil }) else {
                        throw CitizenSDKError(.integrity, "Core storage key page contains an absent key")
                    }
                    return values.compactMap { $0 }
                })
            }
        }).value()
    }
    public func callRuntimeAPI(_ block: CitizenBlockRef, method: String,
                               arguments: Data) async throws -> Data {
        let core=self.core

        guard (1...128).contains(method.utf8.count),
              method.range(of: #"^[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+$"#,
                           options: .regularExpression) != nil,
              arguments.count <= 1_024 * 1_024 else {
            throw CitizenSDKError(.invalidArgument, "Runtime API request is invalid")
        }
var value = core.cBlock((block))
        return try await (withUnsafePointer(to: &value) { pointer in
            try CitizenSDKCore.withViews([Data((method).utf8), (arguments)]) { views in
                try core.begin(accept: {
                    citizensdk_call_runtime_api(core.handle, pointer, views[0], views[1], $0)
                }, decode: { result in
                    guard let output = try CitizenSDKRead.storage(result) else {
                        throw CitizenSDKError(.integrity, "Core Runtime API output is absent")
                    }
                    return output
                })
            }
        }).value()
    }
    public func systemEvents(_ finalizedBlock: CitizenBlockRef) async throws -> Data? {
        let core=self.core

        guard finalizedBlock.finality == .finalized else {
            throw CitizenSDKError(.invalidArgument, "System.Events requires a finalized block")
        }
var value = core.cBlock((finalizedBlock))
        return try await (withUnsafePointer(to: &value) { pointer in
            try core.begin(accept: { citizensdk_get_system_events_at(core.handle, pointer, $0) },
                      decode: CitizenSDKRead.storage)
        }).value()
    }
    public func exportState() async throws -> CitizenChainState {
        let core=self.core
 return try await (core.begin(accept: { citizensdk_export_state(core.handle, $0) }, decode: CitizenSDKRead.chainState)).value() }
    public func importState(_ state: CitizenChainState) async throws {
        let core=self.core
var block = core.cBlock((state).finalized)
 try await (withUnsafePointer(to: &block) { pointer in
            try core.withView((state).database) { view in
                try core.begin(accept: {
                    citizensdk_import_state(core.handle, pointer, (state).formatVersion, view, $0)
                }, decode: { result in
                    let imported = try CitizenSDKRead.block(result)
                    guard imported == (state).finalized else {
                        throw CitizenSDKError(
                            .integrity,
                            "Core imported-state receipt does not match its finalized anchor")
                    }
                    return ()
                })
            }
        }).value() }

    /// 返回 Core 固定链身份的创世哈希；只要求启用 chain，不要求启动或同步轻节点。
    public func genesisHash() throws -> Data {
        let core=self.core
 return try (core.callLock.withLock {
            try core.requireOpen()
            var output = Data(count: 32)
            let code = output.withUnsafeMutableBytes {
                citizensdk_get_genesis_hash(core.handle, $0.bindMemory(to: UInt8.self).baseAddress)
            }
            try CitizenSDKChecks.requireOK(code, "Core genesis hash query failed")
            return output
        }) }

    public func accountBalance(accountID: Data) async throws -> CitizenAccountBalance {
        let core=self.core

var account = try core.cAccount((CitizenSDKInputLimits.accountID(accountID)))
        return try await (withUnsafePointer(to: &account) { pointer in
            try core.begin(accept: { citizensdk_get_finalized_account_balance(core.handle, pointer, $0) },
                      decode: CitizenSDKRead.balance)
        }).value()
    }

    /// 同一已验证 finalized 块的批量余额；保持输入顺序和重复项，空列表仍交由 Core 校验状态。
    public func accountBalances(accountIDs: [Data]) async throws -> [CitizenAccountBalance] {
        let core=self.core

        return try await (core.withAccounts((CitizenSDKInputLimits.balanceAccountIDs(accountIDs))) { pointer, count in
            try core.begin(accept: { citizensdk_get_finalized_account_balances(core.handle, pointer, count, $0) },
                      decode: { try CitizenSDKRead.balances($0, accountIDs: CitizenSDKInputLimits.balanceAccountIDs(accountIDs)) })
        }).value()
    }

    public func accountNonce(accountID: Data) async throws -> CitizenAccountNonce {
        let core=self.core

var account = try core.cAccount((CitizenSDKInputLimits.accountID(accountID)))
        return try await (withUnsafePointer(to: &account) { pointer in
            try core.begin(accept: { citizensdk_get_account_nonce(core.handle, pointer, $0) }, decode: CitizenSDKRead.nonce)
        }).value()
    }

    public func feeSnapshot() async throws -> CitizenFeeSnapshot {
        let core=self.core
 return try await (core.begin(accept: { citizensdk_get_best_fee_snapshot(core.handle, $0) }, decode: CitizenSDKRead.fee)).value() }
    public func walletState() throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core
 return try (core.begin(accept: { citizensdk_get_wallet_state(core.handle, $0) }, decode: CitizenSDKRead.walletState)) }

    public func inspectWallets() throws -> CitizenSDKOperation<CitizenWalletInspection> {
        let core=self.core

        return try resourceOperation {
            try core.inspectWallets().map { [self] inspection in
                inspection.onRelease { [weak self] value in
                    guard let self else { return }
                    self.stateLock.lock(); defer { self.stateLock.unlock() }
                    self.walletInspections.removeValue(forKey: ObjectIdentifier(value))
                }
                self.stateLock.lock()
                let accepting = !self.closed && !self.resourcesClosing
                let available = self.walletInspections.count < 64
                if accepting && available { self.walletInspections[ObjectIdentifier(inspection)] = inspection }
                self.stateLock.unlock()
                guard accepting && available else {
                    try inspection.release()
                    throw CitizenSDKError(accepting ? .queueFull : .cancelled, "钱包检查资源不能接纳")
                }
                return inspection
            }
        }
    }




    public func importColdAccount(accountID: Data, name: String = "") throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core

        let account = try CitizenSDKInputLimits.accountID(accountID)
        let checkedName = name.isEmpty ? "" : try CitizenSDKInputLimits.accountName(name)
        return try core.importColdAccountID(account, name: checkedName)
    }

    public func importColdAccount(ss58Address: String, name: String = "") throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core

        guard !ss58Address.isEmpty, ss58Address.utf8.count <= 64 else {
            throw CitizenSDKError(.invalidArgument, "cold account SS58 is invalid")
        }
        let checkedName = name.isEmpty ? "" : try CitizenSDKInputLimits.accountName(name)
let address = Data((ss58Address).utf8), nameBytes = Data((checkedName).utf8)
        return try (core.withView(address) { addressView in
            try core.withView(nameBytes) { nameView in
                try core.begin(accept: { citizensdk_import_cold_account_ss58(core.handle, addressView, nameView, $0) },
                          decode: CitizenSDKRead.walletState)
            }
        })
    }

    public func importColdAccountCode(_ code: String, name: String = "") throws -> CitizenSDKOperation<CitizenWalletState> {
        let parsed = try parseForPurpose(code, purpose: .coldAccountImport)
        guard case let .accountID(text) = parsed.document.content else { throw CitizenSDKError(.integrity, "account code has no account ID") }
        var bytes = Data(capacity: 32)
        var index = text.index(text.startIndex, offsetBy: 2)
        for _ in 0..<32 {
            let end = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<end], radix: 16) else { throw CitizenSDKError(.integrity, "Core account ID is invalid") }
            bytes.append(byte); index = end
        }
        return try importColdAccount(accountID: bytes, name: name)
    }

    public func reorderWalletAccountsWithoutDefaultChange(expectedRevision: UInt64, accountIDs: [Data]) throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core

        guard (1...CitizenSDKInputLimits.maximumCatalogAccounts).contains(accountIDs.count) else { throw CitizenSDKError(.invalidArgument, "wallet catalog size is invalid") }
        return try (core.withAccounts((accountIDs.map { try CitizenSDKInputLimits.accountID($0) })) { pointer, count in
            try core.begin(accept: {
                citizensdk_reorder_wallet_accounts_without_default_change(
                    core.handle, (expectedRevision), pointer, count, $0)
            }, decode: CitizenSDKRead.walletState)
        })
    }

    /// 默认顺序只经原默认账户授权的同一Core CAS提交，不在绑定层另建变更门。
    public func beginDefaultAccountChange(expectedRevision: UInt64, accountIDs: [Data], ttlSeconds: UInt64 = 90) throws -> CitizenSDKOperation<CitizenDefaultAccountChangeOutcome> {
        let core=self.core

        guard (1...256).contains(accountIDs.count), (1...300).contains(ttlSeconds) else {
            throw CitizenSDKError(.invalidArgument, "default-account change input is invalid")
        }
        return try (core.withAccounts((accountIDs.map { try CitizenSDKInputLimits.accountID($0) })) { accounts, count in
            try core.begin(accept: {
                citizensdk_begin_default_account_change(
                    core.handle, (expectedRevision), accounts, count, (ttlSeconds), $0)
            }, decode: CitizenSDKRead.defaultAccountChange)
        })
    }

    public func consumeDefaultAccountChange(sessionID: String, response: String) throws -> CitizenSDKOperation<CitizenDefaultAccountChangeOutcome> {
        let core=self.core

        try CitizenSdk.validateExternal(sessionID: sessionID, response: response)
        return try (CitizenSDKCore.withViews([Data((sessionID).utf8), Data((response).utf8)]) { views in
            try core.begin(accept: {
                citizensdk_consume_default_account_change(core.handle, views[0], views[1], $0)
            }, decode: CitizenSDKRead.defaultAccountChange)
        })
    }

    /// 付款选择与钱包级改名不进入签名/默认账户变更；原子修订由Core验证。
    public func setActiveWallet(expectedRevision: UInt64, walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core

        return try (core.begin(accept: { citizensdk_set_active_wallet(core.handle, (expectedRevision), (walletIndex), $0) },
                  decode: CitizenSDKRead.walletState))
    }

    public func renameWallet(expectedRevision: UInt64, walletIndex: UInt32, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core

        return try (core.withView(Data((CitizenSDKInputLimits.accountName(name)).utf8)) { view in
            try core.begin(accept: { citizensdk_rename_wallet(core.handle, (expectedRevision), (walletIndex), view, $0) },
                      decode: CitizenSDKRead.walletState)
        })
    }

    public func renameAccount(accountID: Data, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core

var account = try core.cAccount((CitizenSDKInputLimits.accountID(accountID)))
        let bytes = Data(try CitizenSDKInputLimits.accountName(name).utf8)
        return try (withUnsafePointer(to: &account) { pointer in
            try core.withView(bytes) { view in
                try core.begin(accept: { citizensdk_rename_account(core.handle, pointer, view, $0) },
                          decode: CitizenSDKRead.walletState)
            }
        })
    }

    public func deleteAccount(accountID: Data) throws -> CitizenSDKOperation<CitizenWalletState> {
        let core=self.core

var account = try core.cAccount((CitizenSDKInputLimits.accountID(accountID)))
        return try (withUnsafePointer(to: &account) { pointer in
            try core.begin(accept: { citizensdk_delete_account(core.handle, pointer, $0) },
                      decode: CitizenSDKRead.walletState)
        })
    }

    public func setActiveWalletAccount(accountID: Data) throws -> CitizenSDKOperation<CitizenWalletProfile> {
        let core=self.core

var account = try core.cAccount((CitizenSDKInputLimits.accountID(accountID)))
        return try (withUnsafePointer(to: &account) { pointer in
            try core.begin(accept: { citizensdk_set_active_wallet_account(core.handle, pointer, $0) }, decode: CitizenSDKRead.profile)
        }).map {
            guard let value = $0 else { throw CitizenSDKError(.integrity, "set active account returned no profile") }
            return value
        }
    }

    /// 普通清除不追加授权；“签名并删除”在Core内先完成真实授权签名。
    public func deleteWallet() throws -> CitizenSDKOperation<Void> {
        let core=self.core
 return try (core.begin(accept: { citizensdk_delete_wallet(core.handle, $0) }, decode: CitizenSDKRead.empty)) }
    public func signAndDeleteWallet() throws -> CitizenSDKOperation<Void> {
        let core=self.core
 return try (core.begin(accept: { citizensdk_sign_and_delete_wallet(core.handle, $0) }, decode: CitizenSDKRead.empty)) }

    public func reconcileWalletCleanup() throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        let core=self.core

        let cleanup = try core.reconcileWalletCleanup()
        let result = CitizenSDKOperation<CitizenWalletProfile?>(operationID: cleanup.operationID, cancel: cleanup.cancel)
        cleanup.observe { [core] outcome in
            switch outcome {
            case .success:
                do { try core.walletProfile().observe { result.complete($0) } }
                catch { result.complete(.failure(error)) }
            case let .failure(error): result.complete(.failure(error))
            }
        }
        return result
    }

    /// 签名是独立公开模块，不要求开启钱包管理或轻节点。


    public func qrParse(_ text: String) throws -> CitizenQRDocument {
        let core=self.core

let input = Data((text).utf8)
        let canonical = try core.withView(input) { view in
            try core.qrOutput(maximum: 65_536) { output, capacity, required in
                citizensdk_qr_parse(core.handle, view, 0, output, capacity, required)
            }
        }
        return try (CitizenQRDocument(coreJSON: core.qrString(canonical)))
    }
    public func qrEncodeDocument(_ content: CitizenQRContent) throws -> CitizenQRDocument {
        let core=self.core

let input = Data((content.inputJSON).utf8)
        guard input.count <= 65_536 else { throw CitizenSDKError(.invalidArgument, "QR content exceeds boundary") }
        let output = try core.withView(input) { view in
            try core.qrOutput(maximum: 65_536) { output, capacity, required in
                citizensdk_qr_encode_document(core.handle, view, output, capacity, required)
            }
        }
        return try (CitizenQRDocument(coreJSON: core.qrString(output)))
    }
    @_spi(CitizenSDKFlutter) public func qrEncodeDocument(inputJSON: String) throws -> CitizenQRDocument {
        let core=self.core

        let input=Data(inputJSON.utf8)
        guard input.count<=65_536 else {throw CitizenSDKError(.invalidArgument,"QR content exceeds boundary")}
        let output=try core.withView(input){view in try core.qrOutput(maximum:65_536){citizensdk_qr_encode_document(core.handle,view,$0,$1,$2)}}
        return try CitizenQRDocument(coreJSON:core.qrString(output))
    }
    public func qrPrepareAccountAuthorization(action: UInt32, payload: Data, accountID: String) throws -> CitizenQRAuthorization {
        let core=self.core

let account = Data((accountID).utf8)
        guard (payload).count <= 1920, account.count <= 1024 else { throw CitizenSDKError(.invalidArgument, "Authorization input exceeds boundary") }
        let output = try CitizenSDKCore.withViews([(payload), account]) { views in
            try core.qrOutput(maximum: 65_536) { output, capacity, required in
                citizensdk_qr_prepare_account_authorization(core.handle, (action), views[0], views[1], output, capacity, required)
            }
        }
        return try (CitizenQRAuthorization(coreJSON: core.qrString(output)))
    }

    public func qrCreateSignRequest(action: UInt16, signerAccountID: Data,
                                    reviewPayload: Data, ttlSeconds: UInt64 = 120) throws -> String {
        let core=self.core

var account = try core.cAccount((signerAccountID))
        let output = try withUnsafePointer(to: &account) { account in
            try core.withView((reviewPayload)) { payloadView in
                try core.qrOutput { output, capacity, required in
                    citizensdk_qr_create_sign_request(core.handle, (action), account, payloadView,
                                                       (ttlSeconds), output, capacity, required)
                }
            }
        }
        return try (core.qrString(output))
    }

    /// 同实例非消费验签；不会提交交易或改变目录。
    public func qrValidateSignResponse(sessionID: String, response: String) throws {
        let core=self.core

        try (core.callLock.withLock {
            try core.requireOpen()
            try core.withView(Data((sessionID).utf8)) { session in
                try core.withView(Data((response).utf8)) { text in
                    try CitizenSDKChecks.requireOK(
                        citizensdk_qr_validate_sign_response(core.handle, session, text),
                        "QR response preflight failed")
                }
            }
        })
    }

    public func qrConsumeSignResponse(_ text: String) throws -> Data {
        let core=self.core

        return try (core.callLock.withLock {
            try core.requireOpen()
            var signature = Data(count: 64)
            try core.withView(Data((text).utf8)) { view in
                try signature.withUnsafeMutableBytes { bytes in
                    try CitizenSDKChecks.requireOK(
                        citizensdk_qr_consume_sign_response(core.handle, view, bytes.bindMemory(to: UInt8.self).baseAddress),
                        "QR sign response was rejected"
                    )
                }
            }
            return signature
        })
    }

    public func qrCancelSignRequest(_ requestID: String) throws -> Bool {
        let core=self.core

        return try (core.callLock.withLock {
            try core.requireOpen()
            var cancelled: UInt8 = 0
            try core.withView(Data((requestID).utf8)) { view in
                try CitizenSDKChecks.requireOK(
                    citizensdk_qr_cancel_sign_request(core.handle, view, &cancelled),
                    "QR request cancellation failed"
                )
            }
            guard cancelled <= 1 else { throw CitizenSDKError(.integrity, "Core returned invalid QR cancellation state") }
            return cancelled == 1
        })
    }

    public func qrEncodeAccountID(_ accountID: Data) throws -> String {
        let core=self.core

var account = try core.cAccount((accountID))
        let output = try withUnsafePointer(to: &account) { account in
            try core.qrOutput { output, capacity, required in
                citizensdk_qr_encode_account_id(core.handle, account, output, capacity, required)
            }
        }
        return try (core.qrString(output))
    }

    public func qrDecodeLuminance(_ data: Data, width: UInt32, height: UInt32,
                                  rowStride: UInt32) throws -> CitizenQRDocument {
        let core=self.core

guard let first = try core.qrDecodeLuminanceAll(data, width: width, height: height, rowStride: rowStride, firstOnly: true).first else {
            throw CitizenSDKError(.notFound, "image contains no QR code")
        }
        return first
    }

    public func qrEncode(_ text: String, scale: UInt32 = 4) throws -> CitizenQRImage {
        let core=self.core

        return try (core.callLock.withLock {
            try core.requireQRModule()
            let input = Data((text).utf8)
            var width: UInt32 = 0
            var height: UInt32 = 0
            var required = 0
            let first = input.withUnsafeBytes { bytes in
                citizensdk_qr_image_encode_text(bytes.bindMemory(to: UInt8.self).baseAddress,
                    input.count, (scale), nil, 0, &width, &height, &required)
            }
            guard first == CITIZENSDK_QR_IMAGE_BUFFER_TOO_SMALL, required > 0,
                  required <= 16 * 1_024 * 1_024 else {
                throw core.qrImageError(first, "ZXing-C++ QR encode failed")
            }
            var output = Data(count: required)
            let capacity = output.count
            let second = input.withUnsafeBytes { bytes in
                output.withUnsafeMutableBytes { destination in
                    citizensdk_qr_image_encode_text(bytes.bindMemory(to: UInt8.self).baseAddress,
                        input.count, (scale), destination.bindMemory(to: UInt8.self).baseAddress,
                        capacity, &width, &height, &required)
                }
            }
            guard second == CITIZENSDK_QR_IMAGE_OK, required == capacity,
                  UInt64(width) * UInt64(height) == UInt64(output.count) else {
                throw core.qrImageError(second, "ZXing-C++ QR encode failed")
            }
            return CitizenQRImage(width: width, height: height, luminance: output)
        })
    }

    /// ImageIO仅解编码图片像素，所有码识别、协议与用途判断复用SDK唯一链路。
    public func decodeImage(_ encodedImage: Data, purpose: CitizenQRScanPurpose) throws -> [CitizenQRScanResult] {
        let core=self.core

        guard !encodedImage.isEmpty, encodedImage.count <= 16 * 1024 * 1024 else { throw CitizenSDKError(.invalidArgument, "encoded image size is invalid") }
        try core.requireQRModule()
        guard let source = CGImageSourceCreateWithData(encodedImage as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let rawWidth = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let rawHeight = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              (1...4096).contains(rawWidth.intValue), (1...4096).contains(rawHeight.intValue),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
              (1...4096).contains(image.width), (1...4096).contains(image.height) else {
            throw CitizenSDKError(.decode, "encoded image dimensions are invalid")
        }
        var pixels = Data(count: image.width * image.height * 4)
        var luminance = Data(count: image.width * image.height)
        defer { pixels.resetBytes(in: 0..<pixels.count); luminance.resetBytes(in: 0..<luminance.count) }
        try pixels.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
                throw CitizenSDKError(.unavailable, "image pixel buffer is unavailable")
            }
            context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height)))
        }
        luminance.withUnsafeMutableBytes { (outputBytes: UnsafeMutableRawBufferPointer) in
            let output = outputBytes.bindMemory(to: UInt8.self)
            pixels.withUnsafeBytes { (inputBytes: UnsafeRawBufferPointer) in
                let input = inputBytes.bindMemory(to: UInt8.self)
                for index in 0..<output.count {
                    let pixelOffset = index * 4
                    let red = Int(input[pixelOffset]) * 77
                    let green = Int(input[pixelOffset + 1]) * 150
                    let blue = Int(input[pixelOffset + 2]) * 29
                    let weightedLuminance = red + green + blue
                    output[index] = UInt8(weightedLuminance >> 8)
                }
            }
        }
        do {
            return try core.qrDecodeLuminanceAll(luminance, width: UInt32(image.width), height: UInt32(image.height), rowStride: UInt32(image.width))
                .map { try CitizenQRScanResult(document: $0, purpose: purpose) }
        } catch let error as CitizenSDKError where error.code == .notFound { return [] }
    }

    public func signQrRequest(_ review:CitizenQRReview)throws->CitizenSDKOperation<CitizenQRSigned> {
        let core=self.core
        let operation=try review.withResult(owner:core){result in
            try core.begin(accept:{citizensdk_sign_qr_request(core.handle,result,$0)},decode:{
                let value=try CitizenQRDocument(coreJSON:CitizenSDKRead.qr($0,kind:20))
                guard value.kind==2,let request=value.signRequest,!request.isEmpty,request.utf8.count<=2331 else {throw CitizenSDKError(.integrity,"Core QR签名结果缺少原请求关联")}
                return value
            })
        }
        return operation.map{[self] document in CitizenQRSigned(document:document,qrImage:try self.qrEncode(document.canonicalText,scale:4))}
    }
    public func reviewQrRequest(_ text: String) throws -> CitizenSDKOperation<CitizenQRReview> {
        let core=self.core

        return try resourceOperation {
        try core.reviewQrSignRequest(text).map { [self] review in
            review.onRelease { [weak self] value in
                guard let self else { return }
                self.stateLock.lock(); defer { self.stateLock.unlock() }
                self.qrReviews.removeValue(forKey: ObjectIdentifier(value))
            }
            self.stateLock.lock()
            let accepting = !self.closed && !self.resourcesClosing
            if accepting { self.qrReviews[ObjectIdentifier(review)] = review }
            self.stateLock.unlock()
            guard accepting else { try review.release(); throw CitizenSDKError(.cancelled, "SDK is closed") }
            return review
        }
        }
    }

    /// 显式私钥查看只返回资源；警告、确认、显示与清屏仍由宿主原UI负责。
    @MainActor
    public func openPrivateKey(accountID: Data) async throws -> CitizenSDKPrivateKey {
        let ticket = try CitizenSDKCloseGate.shared.reserve(self)
        defer { CitizenSDKCloseGate.shared.finish(self, token: ticket) }
        let resource = try CitizenSDKPrivateKey(owner: core,
            accountID: CitizenSDKInputLimits.accountID(accountID)) { [weak self] resource in
                self?.removePrivateKey(resource)
            }
        guard registerPrivateKey(resource) else {
            resource.requestClose()
            throw CitizenSDKError(.cancelled, "SDK is closing resources")
        }
        CitizenSDKCloseGate.shared.finish(self, token: ticket)
        do { try await resource.waitUntilReady(); return resource }
        catch { try? await resource.close(); throw error }
    }

    private func registerPrivateKey(_ resource: CitizenSDKPrivateKey) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !closed && !resourcesClosing else { return false }
        privateKeys[ObjectIdentifier(resource)] = resource
        return true
    }
    private func removePrivateKey(_ resource: CitizenSDKPrivateKey) {
        stateLock.lock(); defer { stateLock.unlock() }
        privateKeys.removeValue(forKey: ObjectIdentifier(resource))
    }
    private func ownedPrivateKeys() -> [CitizenSDKPrivateKey] {
        stateLock.lock(); defer { stateLock.unlock() }
        return Array(privateKeys.values)
    }

    /// Binds one application-encoded opaque RuntimeCall to exact chain state without signing.
    public func prepareTransaction(sourceAccountID: Data,
                                   callData: Data) async throws -> CitizenPreparedTransaction {
        let core=self.core

        guard (1...1_024 * 1_024).contains(callData.count) else {
            throw CitizenSDKError(.invalidArgument, "callData must contain 1...1 MiB bytes")
        }
var sourceAccount = try core.cAccount((CitizenSDKInputLimits.accountID(sourceAccountID, label: "sourceAccountID")))
        return try await (withUnsafePointer(to: &sourceAccount) { sourcePointer in
            try core.withView((callData)) { view in
                try core.begin(
                    accept: { citizensdk_prepare_transaction(core.handle, sourcePointer, view, $0) },
                    decode: { result in
                        let (nativeHandle, value) = try CitizenSDKRead.preparedTransaction(result)
                        core.routerLock.lock()
                        let existing = core.preparedTransactionHandles.updateValue(
                            nativeHandle, forKey: value.preparationID)
                        core.routerLock.unlock()
                        guard existing == nil else {
                            _ = citizensdk_prepared_transaction_release(core.handle, nativeHandle)
                            throw CitizenSDKError(.integrity, "Core returned a duplicate preparation identity")
                        }
                        return value
                    }
                )
            }
        }).value()
    }

    public func cancelPreparedTransaction(preparationID: String) throws {
        let core=self.core

        guard preparationID.range(
            of: #"^0x[0-9a-f]{32}$"#,
            options: .regularExpression
        ) != nil else {
            throw CitizenSDKError(.invalidArgument, "preparationID is invalid")
        }
        try (core.callLock.withLock {
            try core.requireOpen()
            core.routerLock.lock()
            let prepared = core.preparedTransactionHandles.removeValue(forKey: (preparationID))
            core.routerLock.unlock()
            guard let prepared else {
                throw CitizenSDKError(.notFound, "Transaction preparation was not found")
            }
            let status = citizensdk_prepared_transaction_release(core.handle, prepared)
            guard status == CITIZENSDK_OK else {
                core.routerLock.lock()
                core.preparedTransactionHandles[(preparationID)] = prepared
                core.routerLock.unlock()
                try CitizenSDKChecks.requireOK(status, "prepared transaction release failed")
                return
            }
        })
    }

    public func executePreparedTransaction(preparationID: String) async throws
        -> CitizenTransactionExecution {
        let core=self.core

        return try await core.executePreparedTransaction(preparationID).value()
    }

    public func consumePreparedTransactionQrResponse(executionID: String, response: String)
        async throws -> CitizenTransactionExecutionCompleted {
        guard (1...2_331).contains(response.utf8.count) else {
            throw CitizenSDKError(.invalidArgument, "response must contain 1...2331 UTF-8 bytes")
        }
        let value = try await core
            .consumePreparedTransactionQrResponse(executionID, response: response).value()
        guard case let .completed(completed) = value else {
            throw CitizenSDKError(.integrity, "Core did not return a terminal transaction execution")
        }
        return completed
    }

    public func cancelPreparedTransactionExecution(executionID: String) throws {
        let core=self.core

        try core.cancelPreparedTransactionExecution(executionID)
    }

    /// Reads the local execution-only history. No account or business filtering is inferred.
    public func getTransactionHistory(beforeExecutionID:String?=nil,limit:UInt32=100) async throws->CitizenTransactionHistoryPage {
        let core=self.core
        guard (1...100).contains(limit) else {throw CitizenSDKError(.invalidArgument,"limit must be in 1...100")}
        let operation:CitizenSDKOperation<CitizenTransactionHistoryPage>
        if let beforeExecutionID {
            var identifier=try core.cExecutionID(beforeExecutionID)
            operation=try withUnsafePointer(to:&identifier){pointer in
                try core.begin(accept:{citizensdk_get_transaction_history(core.handle,pointer,limit,$0)},decode:CitizenSDKRead.transactionHistoryPage)
            }
        } else {
            operation=try core.begin(accept:{citizensdk_get_transaction_history(core.handle,nil,limit,$0)},decode:CitizenSDKRead.transactionHistoryPage)
        }
        return try await operation.value()
    }

    /// Advances a bounded batch of non-terminal SDK-submitted transactions.
    public func syncTransactionHistory() async throws -> CitizenTransactionHistoryPage {
        let core=self.core

        return try await (core.begin(
            accept: { citizensdk_sync_transaction_history(core.handle, $0) },
            decode: CitizenSDKRead.transactionHistoryPage
        )).value()
    }

    /// Destroys only checkpoint-safe Core state. A running instance must first
    /// complete `stop`; accepted requests and owned resources fail BUSY.
    public func close() throws {
        stateLock.lock()
        if closed { stateLock.unlock(); return }
        let state = lifecycleValue
        stateLock.unlock()
        switch state {
        case .created, .stopped, .startFailed: break
        case .disposed: return
        case .running:
            throw CitizenSDKError(.invalidState, "A running CitizenSDK must complete stop before close")
        case .starting, .importingState:
            throw CitizenSDKError(.busy, "CitizenSDK lifecycle transition is still running")
        }
        try finishClose()
    }

    private func finishClose() throws {
        let core=self.core

        let registry = CitizenSDKCloseGate.shared
        guard let reservation = try registry.beginClose(self) else {
            commitClosedFacade(reservation: nil)
            return
        }
        do {
            let keys = ownedPrivateKeys()
            let captures = ownedCaptures()
            keys.forEach { $0.requestClose() }
            captures.forEach { $0.requestClose() }
            guard keys.isEmpty && captures.isEmpty else { throw CitizenSDKError(.busy, "private key resources are still draining") }
            try releasePreparedResources()
            try core.close()
        } catch {
            let requiresSupervisor = registry.failClose(
                self, reservation: reservation, teardownStarted: core.teardownStarted
            )
            if requiresSupervisor { enqueueForSupervisedClose() }
            throw error
        }
        commitClosedFacade(reservation: reservation)
    }

    /// Used only by the detach supervisor. Unlike Native-only recovery this
    /// retains the facade, respects active resource ownership, and runs a
    /// normal checkpointing stop before close when the Core is running.
    @_spi(CitizenSDKFlutter)
    public func supervisedClose() async throws {
        let core=self.core

        // Recovery must not consult `lifecycleValue`: the Core can complete a
        // stop before its lifecycle event reaches this facade. Native queries
        // the authoritative C lifecycle and resumes any partial ABI teardown.
        let registry = CitizenSDKCloseGate.shared
        guard let reservation = try registry.beginClose(self, origin: .supervised) else {
            commitClosedFacade(reservation: nil)
            return
        }
        do {
            for resource in ownedPrivateKeys() { try await resource.close() }
            for resource in ownedCaptures() { try await resource.close() }
            try releasePreparedResources()
            try await core.supervisedClose()
        } catch {
            // This method already runs under the lifecycle supervisor, so even
            // a pre-teardown failure stays closing between actor retries.
            _ = registry.failClose(
                self, reservation: reservation, teardownStarted: core.teardownStarted
            )
            throw error
        }
        commitClosedFacade(reservation: reservation)
    }

    /// Official Flutter adapter SPI; not part of the application-facing API.
    @_spi(CitizenSDKFlutter)
    public func enqueueForSupervisedClose() {
        Task { await CitizenSDKLifecycleSupervisor.shared.adopt(self) }
    }

    /// Commits public disposal only after successful Core destruction. The
    /// idempotent gate also makes concurrent explicit/reaper completion commit
    /// the registry tombstone exactly once.
    private func commitClosedFacade(
        reservation: CitizenSDKCloseGate.CloseReservation?
    ) {
        // Publish the destroyed tombstone first, without holding `stateLock`,
        // so no wallet UI can enter while facade disposal is being committed.
        CitizenSDKCloseGate.shared.commitClosed(self, reservation: reservation)
        stateLock.lock()
        let didCommit = !closed
        if didCommit {
            lifecycleValue = .disposed
            closed = true
            eventHandler = nil
        }
        stateLock.unlock()
    }

    public func validatePassword(_ password: String) throws -> CitizenWalletInputValidation {
        return try CitizenSDKCore.validateWalletInput(password, kind: 1, wordCount: 0)
    }
    public func validateMnemonic(_ mnemonic: String, wordCount: UInt32) throws -> CitizenWalletInputValidation {
        return try CitizenSDKCore.validateWalletInput(mnemonic, kind: 2, wordCount: wordCount)
    }
    public func wordSuggestions(_ prefix: String) throws -> [String] { return try CitizenSDKCore.walletWordSuggestions(prefix) }

    public func prepareCreation(wordCount: UInt32, password: String = "") throws -> CitizenSDKOperation<CitizenSDKPreparedWallet> {
        let core=self.core

        return try resourceOperation {
        try withWalletInputs(mnemonic: "", password: password) { _, password in
            try ((password).withUnsafeBytes { bytes in
            var view = citizensdk_bytes_view_t()
            view.data = bytes.bindMemory(to: UInt8.self).baseAddress
            view.len = UInt64(bytes.count)
            return try core.begin(accept: { citizensdk_prepare_wallet_creation(core.handle, (wordCount), view, $0) }, decode: { result in
                let prepared = try CitizenSDKRead.preparedWallet(result)
                core.routerLock.lock(); core.preparedHandles.insert(prepared); core.routerLock.unlock()
                return prepared
            })
        }).map { [self, core] handle in
                let resource = CitizenSDKPreparedWallet(core: core, handle: handle) { [weak self] value in
                    guard let self else { return }
                    self.stateLock.lock(); defer { self.stateLock.unlock() }
                    self.preparedWallets.removeValue(forKey: ObjectIdentifier(value))
                }
                self.stateLock.lock()
                let accepting = !self.closed && !self.resourcesClosing
                if accepting { self.preparedWallets[ObjectIdentifier(resource)] = resource }
                self.stateLock.unlock()
                guard accepting else { try resource.release(); throw CitizenSDKError(.cancelled, "SDK is closed") }
                return resource
            }
        }
        }
    }

    public func importWallet(mnemonic: String, password: String = "") throws -> CitizenSDKOperation<CitizenWalletProfile> {
        let core=self.core

        return try withWalletInputs(mnemonic: mnemonic, password: password) { mnemonic, password in
            try (core.withSensitiveViews((mnemonic), (password)) { mnemonicView, passwordView in
            try core.begin(accept: { citizensdk_import_wallet(core.handle, mnemonicView, passwordView, $0) },
                      decode: CitizenSDKRead.profile)
        }).map {
                guard let value = $0 else { throw CitizenSDKError(.integrity, "wallet import returned no profile") }
                return value
            }
        }
    }

    public func addAccounts(mnemonic: String, password: String = "", indices: [UInt32]) throws -> CitizenSDKOperation<CitizenWalletProfile> {
        let core=self.core

        let indices = try CitizenSDKInputLimits.additionalIndices(indices)
        return try withWalletInputs(mnemonic: mnemonic, password: password) { mnemonic, password in
            try (core.withSensitiveViews((mnemonic), (password)) { mnemonicView, passwordView in
            try (indices).withUnsafeBufferPointer { values in
                try core.begin(accept: {
                    citizensdk_add_wallet_accounts(core.handle, mnemonicView, passwordView,
                                                   values.baseAddress, UInt32(values.count), $0)
                }, decode: { result in
                    guard let profile = try CitizenSDKRead.profile(result) else {
                        throw CitizenSDKError(.integrity, "add accounts returned no profile")
                    }
                    return profile
                })
            }
        })
        }
    }

    /// 下一编号由Core同一次身份校验和提交决定，宿主不能先读max+1再提交。
    public func addNextAccount(mnemonic: String, password: String = "") throws -> CitizenSDKOperation<CitizenWalletProfile> {
        let core=self.core

        return try withWalletInputs(mnemonic: mnemonic, password: password) { mnemonic, password in
            try (core.withSensitiveViews((mnemonic), (password)) { mnemonicView, passwordView in
            try core.begin(accept: { citizensdk_add_next_wallet_account(core.handle, mnemonicView, passwordView, $0) }, decode: { result in
                guard let profile = try CitizenSDKRead.profile(result) else { throw CitizenSDKError(.integrity, "add next account returned no profile") }
                return profile
            })
        })
        }
    }

    private func withWalletInputs<T>(mnemonic: String, password: String,
        _ body: (CitizenSDKSensitiveBuffer, CitizenSDKSensitiveBuffer) throws -> T) throws -> T {
        func buffer(_ value: String) throws -> CitizenSDKSensitiveBuffer {
            guard value.utf8.count <= 1_024 else { throw CitizenSDKError(.invalidArgument, "wallet input exceeds 1024 bytes") }
            var copy = Data(value.utf8)
            defer { copy.resetBytes(in: 0..<copy.count) }
            return CitizenSDKSensitiveBuffer(data: copy)
        }
        let phrase = try buffer(mnemonic)
        defer { phrase.clear() }
        let password = try buffer(password)
        defer { password.clear() }
        return try body(phrase, password)
    }

    private func releasePreparedResources() throws {
        stateLock.lock()
        let owned = Array(preparedWallets.values)
        let reviews = Array(qrReviews.values)
        let inspections = Array(walletInspections.values)
        stateLock.unlock()
        try owned.forEach { try $0.release() }
        try reviews.forEach { try $0.release() }
        try inspections.forEach { try $0.release() }
    }

    /// 接纳至资源登记之间持有短生命周期票据；不是UI窗口所有权，不禁止同实例其它资源。
    private func resourceOperation<T: Sendable>(_ create: () throws -> CitizenSDKOperation<T>) throws -> CitizenSDKOperation<T> {
        try requireResourceAdmission()
        let ticket = try CitizenSDKCloseGate.shared.reserve(self)
        do {
            let operation = try create()
            operation.observe { [self] _ in CitizenSDKCloseGate.shared.finish(self, token: ticket) }
            return operation
        } catch {
            CitizenSDKCloseGate.shared.finish(self, token: ticket)
            throw error
        }
    }

    public func parseForPurpose(_ text: String, purpose: CitizenQRScanPurpose) throws -> CitizenQRScanResult {
        let core=self.core

        return try CitizenQRScanResult(document: core.qrParse(text), purpose: purpose)
    }

    public func openCapture(purpose: CitizenQRScanPurpose, listener: CitizenSDKQrCapture.Listener) async throws -> CitizenSDKQrCapture {
        let resource = try createCapture(purpose: purpose, listener: listener)
        do { try await resource.start(); return resource }
        catch { try? await resource.close(); throw error }
    }

    private func createCapture(purpose: CitizenQRScanPurpose, listener: CitizenSDKQrCapture.Listener) throws -> CitizenSDKQrCapture {
        let core=self.core

        try requireResourceAdmission()
        let ticket = try CitizenSDKCloseGate.shared.reserve(self)
        defer { CitizenSDKCloseGate.shared.finish(self, token: ticket) }
        try (core.callLock.withLock {
            try core.requireOpen()
            guard core.selectedModules.contains(.qr) else {
                throw CitizenSDKError(.unsupported, "CitizenSDK QR module is not enabled")
            }
        })
        let resource = CitizenSDKQrCapture(core: core, purpose: purpose, listener: listener) { [weak self] value in
            guard let self else { return }
            self.stateLock.lock(); defer { self.stateLock.unlock() }
            self.qrCaptures.removeValue(forKey: ObjectIdentifier(value))
        }
        stateLock.lock()
        let accepting = !closed && !resourcesClosing
        if accepting { qrCaptures[ObjectIdentifier(resource)] = resource }
        stateLock.unlock()
        guard accepting else { resource.requestClose(); throw CitizenSDKError(.cancelled, "SDK is closing resources") }
        return resource
    }
    private func ownedCaptures() -> [CitizenSDKQrCapture] {
        stateLock.lock(); defer { stateLock.unlock() }
        return Array(qrCaptures.values)
    }

    private func requireResourceAdmission() throws {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !closed && !resourcesClosing else { throw CitizenSDKError(.cancelled, "SDK is closing resources") }
    }

    /// Flutter关闭先撤销已交付和仍在打开的资源，再等待其真实任务，避免权限等待死锁。
    @_spi(CitizenSDKFlutter)
    public func requestResourceClose() {
        stateLock.lock()
        resourcesClosing = true
        let keys = Array(privateKeys.values), captures = Array(qrCaptures.values)
        stateLock.unlock()
        keys.forEach { $0.requestClose() }
        captures.forEach { $0.requestClose() }
    }

    private func receive(_ event: CitizenSDKEvent) {
        stateLock.lock()
        if case let .lifecycleChanged(_, lifecycle) = event { lifecycleValue = lifecycle }
        let handler = eventHandler
        stateLock.unlock()
        if case .walletChanged = event { ownedPrivateKeys().forEach { $0.requestClose() } }
        handler?(event)
    }
    public func sign(accountID: Data, message: Data) throws -> CitizenSDKOperation<CitizenSignature> {
        let core=self.core

var account = try core.cAccount((CitizenSDKInputLimits.accountID(accountID)))
        return try (withUnsafePointer(to: &account) { pointer in
            try core.withView((CitizenSDKInputLimits.signingPayload(message))) { view in
                try core.begin(accept: { citizensdk_sign_wallet_payload(core.handle, pointer, view, $0) }, decode: CitizenSDKRead.signature)
            }
        })
    }

    public func beginSigning(_ intent: CitizenSigningIntent) throws -> CitizenSDKOperation<CitizenSigningOutcome> {
        let core=self.core

var account = try core.cAccount((intent).accountID)
        return try (withUnsafePointer(to: &account) { accountPointer in
            try CitizenSDKCore.withViews([(intent).payload, (intent).domain]) { views in
                try core.begin(accept: {
                    citizensdk_begin_signing(
                        core.handle, accountPointer, views[0], (intent).transform.rawValue,
                        views[1], (intent).externalSignerTransport?.rawValue ?? 0,
                        (intent).opaqueAction, (intent).ttlSeconds, $0)
                }, decode: CitizenSDKRead.signingOutcome)
            }
        })
    }

    public func consumeExternalSignature(sessionID: String,
                                         response: String) throws -> CitizenSDKOperation<CitizenSigningOutcome> {
        let core=self.core

        try Self.validateExternal(sessionID: sessionID, response: response)
        return try (CitizenSDKCore.withViews([Data((sessionID).utf8), Data((response).utf8)]) { views in
            try core.begin(accept: {
                citizensdk_consume_external_signature(core.handle, views[0], views[1], $0)
            }, decode: CitizenSDKRead.signingOutcome)
        })
    }

    public func cancelSigning(sessionID: String) throws -> Bool {
        let core=self.core

        guard (1...128).contains(sessionID.utf8.count) else {
            throw CitizenSDKError(.invalidArgument, "external signing sessionID is invalid")
        }
        return try (core.callLock.withLock {
            try core.requireOpen()
            var cancelled: UInt8 = 0
            try core.withView(Data((sessionID).utf8)) { view in
                try CitizenSDKChecks.requireOK(
                    citizensdk_cancel_signing_session(core.handle, view, &cancelled),
                    "Signing session cancellation failed")
            }
            guard cancelled <= 1 else {
                throw CitizenSDKError(.integrity, "Core returned invalid signing cancellation state")
            }
            return cancelled == 1
        })
    }

    internal static func validateExternal(sessionID: String, response: String) throws {
        guard (1...128).contains(sessionID.utf8.count),
              (1...2_331).contains(response.utf8.count) else {
            throw CitizenSDKError(.invalidArgument, "external signing response is invalid")
        }
    }

    public static func verify(accountID: Data, signature: Data, message: Data) throws -> Bool {
        return try CitizenSDKCore.verify(accountID: CitizenSDKInputLimits.accountID(accountID),
                                    signature: signature,
                                    message: CitizenSDKInputLimits.signingPayload(message))
    }
    public static func encodePayload(_ payload: CitizenSigningPayload) throws -> Data {
        return try CitizenSDKCore.encodePayload(kind: payload.kind, fieldsJSON: payload.fieldsJSON, payload: payload.payloadBytes)
    }
    @_spi(CitizenSDKFlutter) public static func encodePayload(kind: UInt32, fieldsJSON: String, payload: Data) throws -> Data {
        return try CitizenSDKCore.encodePayload(kind: kind, fieldsJSON: fieldsJSON, payload: payload)
    }

}

/// 本地签名始终经核心账户归属检查与设备金库授权；公开验签不创建钱包或访问金库。


/** 原关闭预约状态机的非UI部分：允许多个资源接纳票据，部分teardown失败保持只准关闭重试。 */
internal final class CitizenSDKCloseGate: @unchecked Sendable {
    enum Status { case open, owned, closing, closed }
    struct CloseReservation: Equatable, Sendable {
        let token: UUID
        let retryCommitted: Bool
    }
    enum CloseOrigin { case explicit, supervised }
    private enum State { case open(Set<UUID>), closing(CloseReservation?), closed }
    static let shared = CitizenSDKCloseGate()
    private let lock = NSLock()
    private var states: [ObjectIdentifier: State] = [:]

    func registerOpen(_ sdk: AnyObject) {
        lock.lock(); defer { lock.unlock() }
        precondition(states[ObjectIdentifier(sdk)] == nil)
        states[ObjectIdentifier(sdk)] = .open([])
    }
    func reserve(_ sdk: AnyObject) throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        guard case var .open(tickets) = states[key] else {
            if case .closing = states[key] { throw CitizenSDKError(.busy, "SDK is closing") }
            throw CitizenSDKError(.invalidState, "SDK is closed or unregistered")
        }
        let token = UUID(); tickets.insert(token); states[key] = .open(tickets)
        return token
    }
    func finish(_ sdk: AnyObject, token: UUID) {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        if case var .open(tickets) = states[key] { tickets.remove(token); states[key] = .open(tickets) }
    }
    func beginClose(_ sdk: AnyObject, origin: CloseOrigin = .explicit) throws -> CloseReservation? {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        switch states[key] {
        case let .open(tickets):
            guard tickets.isEmpty else { throw CitizenSDKError(.busy, "resource admission has not settled") }
            let reservation = CloseReservation(token: UUID(), retryCommitted: origin == .supervised)
            states[key] = .closing(reservation)
            return reservation
        case .closing(nil):
            let reservation = CloseReservation(token: UUID(), retryCommitted: true)
            states[key] = .closing(reservation)
            return reservation
        case .closing: throw CitizenSDKError(.busy, "another close attempt is active")
        case .closed: return nil
        case nil: throw CitizenSDKError(.invalidState, "SDK is not registered")
        }
    }
    @discardableResult
    func failClose(_ sdk: AnyObject, reservation: CloseReservation, teardownStarted: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        guard case let .closing(current?) = states[key], current == reservation else { return false }
        states[key] = teardownStarted || reservation.retryCommitted ? .closing(nil) : .open([])
        return teardownStarted && !reservation.retryCommitted
    }
    func commitClosed(_ sdk: AnyObject, reservation: CloseReservation?) {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        if case .closed = states[key] { return }
        guard let reservation, case let .closing(current?) = states[key], current == reservation else {
            preconditionFailure("close reservation changed before Core destruction")
        }
        states[key] = .closed
    }
    func forget(_ sdk: AnyObject) { lock.lock(); states.removeValue(forKey: ObjectIdentifier(sdk)); lock.unlock() }
    func status(_ sdk: AnyObject) -> Status? {
        lock.lock(); defer { lock.unlock() }
        switch states[ObjectIdentifier(sdk)] {
        case let .open(tickets): return tickets.isEmpty ? .open : .owned
        case .closing: return .closing
        case .closed: return .closed
        case nil: return nil
        }
    }
}
