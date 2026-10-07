@_spi(CitizenSDKFlutter) import CitizenSDK
import CoreFoundation
import Foundation
import CoreVideo

#if os(iOS)
import Flutter
#elseif os(macOS)
import FlutterMacOS
#endif

/// Process session registry for the fixed Flutter protocol. Native SDK
/// identities and accepted Core request IDs never leave this object.
@MainActor
internal final class CitizenSdkFlutterSessions: NSObject, @preconcurrency FlutterStreamHandler {
    @MainActor private final class Session {
        let sdk: CitizenSdk
        var nextEvent: Int64 = 1
        var closing = false
        var outstanding: [UUID: Outstanding] = [:]
        var cancellations: [Int64: () throws -> Bool] = [:]
        var prepared: [String: CitizenSDKPreparedWallet] = [:]
        var privateKeys: [String: CitizenSDKPrivateKey] = [:]
        var reviews: [String: CitizenQRReview] = [:]
        var inspections: [String: CitizenWalletInspection] = [:]
        var captures: [String: CaptureBinding] = [:]
        init(_ sdk: CitizenSdk) { self.sdk = sdk }
    }

    private struct Outstanding {
        let task: Task<Void, Never>
        let cancel: (() -> Void)?
    }

    private struct ClosePreparation {
        let session: Session
        let outstanding: [Outstanding]
    }

    private var sessions: [String: Session] = [:]
    private var textures: FlutterTextureRegistry?
    func setTextureRegistry(_ textures: FlutterTextureRegistry) { self.textures = textures }

    // iOS 引擎从 0 分配纹理编号；macOS 注册器则以 0 表示失败。
    static func isCaptureTextureIDValid(_ id: Int64) -> Bool {
        #if os(iOS)
        return id >= 0
        #else
        return id != 0
        #endif
    }

    /// 纹理只借SDK持有的CF帧，不创建UIView/NSView或相机预览窗口。
    private final class CaptureTexture: NSObject, FlutterTexture, @unchecked Sendable {
        private let gate = NSLock()
        private var capture: CitizenSDKQrCapture?
        func bind(_ value: CitizenSDKQrCapture?) { gate.lock(); capture = value; gate.unlock() }
        func copyPixelBuffer() -> Unmanaged<CVPixelBuffer>? {
            gate.lock(); let value = capture; gate.unlock()
            return value?.copyPixelBuffer().map { Unmanaged.passRetained($0) }
        }
    }
    @MainActor private final class CaptureBinding {
        let capture: CitizenSDKQrCapture
        let texture: CaptureTexture
        let textureID: Int64
        var released = false
        var preview: CitizenQRPreview?
        init(_ capture: CitizenSDKQrCapture, _ texture: CaptureTexture, _ textureID: Int64) {
            self.capture = capture; self.texture = texture; self.textureID = textureID
            preview = capture.preview
        }
    }
    private var sink: FlutterEventSink?
    private let subscriptionEpoch = CitizenSdkFlutterSubscriptionEpoch()
    private var detached = false
    private let verifySignature: (Data, Data, Data) throws -> Bool

    init(verifySignature: @escaping (Data, Data, Data) throws -> Bool = {
        try CitizenSigning.verify(accountID: $0, signature: $1, message: $2)
    }) {
        self.verifySignature = verifySignature
        super.init()
    }

    /// 必须在参数解码之前调用；关闭检查留在宿主，序号判断只调用同一Core。
    func acceptRequestSequence(_ request: CitizenSdkFlutterCodec.Request) throws {
        guard !detached, !subscriptionEpoch.isInvalidated,
              let id = request.sessionID, let sequence = request.sequence,
              let session = sessions[id] else {
            throw CitizenSDKError(.notFound, "CitizenSDK session was not found")
        }
        guard !session.closing else { throw CitizenSDKError(.invalidState, "CitizenSDK session is closing") }
        try session.sdk.acceptRequestSequence(sequence)
    }

    func dispatch(_ request: CitizenSdkFlutterCodec.Request, result: @escaping FlutterResult) {
        guard !detached, !subscriptionEpoch.isInvalidated else {
            fail(result, .unavailable, "CitizenSDK Flutter engine is detached", request)
            return
        }
        if case let .verify(accountID, signature, payload) = request {
            // 此分支不查会话、不占序号、不启动事件流，也不创建金库或链资源。
            do { result([CitizenSdkFlutterCodec.version, try verifySignature(accountID, signature, payload)]) }
            catch { fail(result, error, request) }
            return
        }
        if case let .encodePayload(kind, fields, payload) = request {
            do { result([CitizenSdkFlutterCodec.version,
                FlutterStandardTypedData(bytes: try CitizenSigning.encodePayload(kind: kind, fieldsJSON: fields, payload: payload))]) }
            catch { fail(result, error, request) }
            return
        }
        if case let .open(modules) = request { open(modules, result); return }
        guard let sessionID = request.sessionID, let session = sessions[sessionID] else {
            fail(result, .notFound, "CitizenSDK session was not found", request)
            return
        }
        guard !session.closing else {
            fail(result, .invalidState, "CitizenSDK session is closing", request)
            return
        }
        route(session, request: request, result: result)
    }

    func closeAll() async {
        // Prepare every session before awaiting any operation. Otherwise one
        // slow session could prevent later sessions from even receiving their
        // cancellation signal during engine detach.
        let prepared = Array(sessions.values).map(prepareForClose)
        await citizenSDKFlutterCancelAndDrain(
            prepared.flatMap(\.outstanding),
            cancel: Self.cancel,
            wait: { await $0.task.value }
        )
        await citizenSDKFlutterCloseEverySession(
            prepared,
            close: { try await self.finishSupervisedClose($0.session) },
            recover: { preparation in
                // Plugin detach must not abandon a live callback/host context.
                // The facade supervisor retains wallet-flow ownership, retries
                // checkpointing stop, then releases only after Core destroy.
                let session = preparation.session
                session.sdk.enqueueForSupervisedClose()
                sessions.removeValue(forKey: session.sdk.sessionID)
            }
        )
    }

    /// Permanently rejects callbacks captured by this Flutter engine. This is
    /// deliberately nonisolated so engine detach can invalidate callback epochs
    /// synchronously before its messenger starts deallocating.
    nonisolated func invalidateEventEpochForDetach() {
        subscriptionEpoch.invalidate()
    }

    /// Drops the engine-owned sink on the main actor. The epoch has already
    /// been invalidated synchronously, so no queued native callback can reach
    /// the sink while this actor hop is pending.
    func detachEventSink() {
        detached = true
        sink = nil
    }

    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        guard !detached, !subscriptionEpoch.isInvalidated else {
            return FlutterError(code: "citizensdk.unavailable",
                                message: "CitizenSDK Flutter engine is detached",
                                details: CitizenSdkFlutterCodec.error(.unavailable,
                                    "CitizenSDK Flutter engine is detached", session: nil, sequence: nil, method: "open"))
        }
        guard let tuple = arguments as? [Any?], tuple.count == 1,
              Self.exactProtocolVersion(tuple[0]) else {
            return FlutterError(code: "citizensdk.invalidArgument",
                                message: "CitizenSDK event subscription tuple is invalid",
                                details: CitizenSdkFlutterCodec.error(.invalidArgument,
                                    "CitizenSDK event subscription tuple is invalid", session: nil, sequence: nil, method: "open"))
        }
        guard sink == nil else {
            return FlutterError(code: "citizensdk.busy", message: "CitizenSDK event subscription is already active",
                                details: CitizenSdkFlutterCodec.error(.busy,
                                    "CitizenSDK event subscription is already active", session: nil, sequence: nil, method: "open"))
        }
        do { _ = try subscriptionEpoch.advance() }
        catch {
            return FlutterError(code: "citizensdk.integrity", message: "CitizenSDK event generation is exhausted",
                                details: CitizenSdkFlutterCodec.error(.integrity,
                                    "CitizenSDK event generation is exhausted", session: nil, sequence: nil, method: "open"))
        }
        sink = events
        sessions.values.forEach { session in
            emit(session, type: "lifecycleChanged", payload: [CitizenSdkFlutterCodec.lifecycle(session.sdk.lifecycle)])
            if let value = try? session.sdk.capabilities() {
                emit(session, type: "capabilitiesChanged", payload: [CitizenSdkFlutterCodec.capabilities(value)])
            }
        }
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        if detached || subscriptionEpoch.isInvalidated {
            sink = nil
            return nil
        }
        do { _ = try subscriptionEpoch.advance() }
        catch {
            return FlutterError(code: "citizensdk.integrity", message: "CitizenSDK event generation is exhausted",
                                details: CitizenSdkFlutterCodec.error(.integrity,
                                    "CitizenSDK event generation is exhausted", session: nil, sequence: nil, method: "open"))
        }
        sink = nil
        return nil
    }

    private func open(_ modules: CitizenSDKModules, _ result: @escaping FlutterResult) {
        do {
            let sdk = try CitizenSdk.open(modules: modules)
            let session = Session(sdk)
            let epoch = subscriptionEpoch
            _ = try citizenSDKFlutterFinalizeOpen(
                sdk,
                install: { sdk in
                    try sdk.setEventHandler { [weak self, weak session, epoch] event in
                        let generation = epoch.snapshot()
                        Task { @MainActor in
                            guard let self, let session else { return }
                            self.onSDKEvent(session, event, expectedGeneration: generation)
                        }
                    }
                },
                cleanup: { sdk in
                    try? sdk.setEventHandler(nil)
                    citizenSDKFlutterCloseOrSupervise(
                        close: sdk.close,
                        supervise: sdk.enqueueForSupervisedClose
                    )
                }
            )
            sessions[sdk.sessionID] = session
            success(result, session: sdk.sessionID, sequence: 0,
                    value: [CitizenSdkFlutterCodec.lifecycle(sdk.lifecycle), Int64(1)])
            emit(session, type: "lifecycleChanged", payload: [CitizenSdkFlutterCodec.lifecycle(sdk.lifecycle)])
            if let capabilities = try? sdk.capabilities() {
                emit(session, type: "capabilitiesChanged", payload: [CitizenSdkFlutterCodec.capabilities(capabilities)])
            }
        } catch {
            fail(result, error, .open(modules: modules))
        }
    }

    private func route(_ session: Session, request: CitizenSdkFlutterCodec.Request,
                       result: @escaping FlutterResult) {
        switch request {
        case let .empty(method, _, _):
            switch method {
            case "start": run(session, request, result) {
                try await session.sdk.start(); return [CitizenSdkFlutterCodec.lifecycle(session.sdk.lifecycle)]
            }
            case "stop": run(session, request, result) {
                try await session.sdk.stop(); return [CitizenSdkFlutterCodec.lifecycle(session.sdk.lifecycle)]
            }
            case "close": close(session, request, result)
            case "getCapabilities":
                do { success(result, request, [CitizenSdkFlutterCodec.capabilities(try session.sdk.capabilities())]) }
                catch { fail(result, error, request) }
            case "getFinalizedHead": run(session, request, result) {
                [CitizenSdkFlutterCodec.block(try await session.sdk.finalizedHead())]
            }
            case "getSyncStatus": run(session, request, result) {
                [CitizenSdkFlutterCodec.syncStatus(try await session.sdk.syncStatus())]
            }
            case "getBestHead": run(session, request, result) {
                [CitizenSdkFlutterCodec.block(try await session.sdk.bestHead())]
            }
            case "exportState": run(session, request, result) {
                [CitizenSdkFlutterCodec.chainState(try await session.sdk.exportState())]
            }
            case "getGenesisHash":
                do { success(result, request, [CitizenSdkFlutterCodec.hex(try session.sdk.genesisHash())]) }
                catch { fail(result, error, request) }
            case "getFeeSnapshot": run(session, request, result) {
                [CitizenSdkFlutterCodec.fee(try await session.sdk.feeSnapshot())]
            }
            case "inspectWallets": runOperation(session, request, result, { try session.sdk.inspectWallets() }) { inspection in
                let id = UUID().uuidString
                session.inspections[id] = inspection
                return [id, CitizenSdkFlutterCodec.walletState(inspection.state)]
            }
            case "getWalletState": runOperation(session, request, result, { try session.sdk.walletState() }) {
                [CitizenSdkFlutterCodec.walletState($0)]
            }
            case "deleteWallet": runOperation(session, request, result, { try session.sdk.deleteWallet() }) { _ in [] }
            case "signAndDeleteWallet": runOperation(session, request, result, { try session.sdk.signAndDeleteWallet() }) { _ in [] }
            case "reconcileWalletCleanup": runOperation(session, request, result, { try session.sdk.reconcileWalletCleanup() }) {
                [CitizenSdkFlutterCodec.profile($0)]
            }
            default: fail(result, .unsupported, "Unsupported method", request)
            }
        case let .account(method, _, _, accountID):
            switch method {
            // 请求执行期显式保有上下文；下面的终态监听保持弱引用，避免资源闭环。
            case "openPrivateKey": run(session, request, result) { [self, session] in
                let resource = try await session.sdk.openPrivateKey(accountID: accountID)
                guard !session.closing else { try await resource.close(); throw CitizenSDKError(.cancelled, "session is closing") }
                let id = UUID().uuidString
                session.privateKeys[id] = resource
                Task { @MainActor [weak self, weak session] in
                    do { try await resource.closed } catch { /* 打开/查看操作交付错误；此处只通知排空。 */ }
                    guard let self, let session else { return }
                    self.emit(session, type: "privateKeyClosed", payload: [id])
                }
                return [id]
            }
            case "getAccountBalance": run(session, request, result) {
                [CitizenSdkFlutterCodec.balance(try await session.sdk.accountBalance(accountID: accountID))]
            }
            case "getAccountNonce": run(session, request, result) {
                [CitizenSdkFlutterCodec.nonce(try await session.sdk.accountNonce(accountID: accountID))]
            }
            case "setActiveWalletAccount": runOperation(session, request, result, { try session.sdk.setActiveWalletAccount(accountID: accountID) }) {
                [CitizenSdkFlutterCodec.profile($0)]
            }
            case "deleteAccount": runOperation(session, request, result, { try session.sdk.deleteAccount(accountID: accountID) }) {
                [CitizenSdkFlutterCodec.walletState($0)]
            }
            default: fail(result, .unsupported, "Unsupported method", request)
            }
        case let .balances(_, _, accountIDs): run(session, request, result) {
            [try await session.sdk.accountBalances(accountIDs: accountIDs).map(CitizenSdkFlutterCodec.balance)]
        }
        case let .blockNumber(_, _, number): run(session, request, result) {
            [CitizenSdkFlutterCodec.block(try await session.sdk.finalizedBlock(at: number))]
        }
        case let .resolveBlock(_, _, hash, number): run(session, request, result) {
            [CitizenSdkFlutterCodec.block(try await session.sdk.resolveFinalizedBlock(hash: hash, number: number))]
        }
        case let .block(method, _, _, block):
            switch method {
            case "getBlockHeader": run(session, request, result) {
                [CitizenSdkFlutterCodec.blockHeader(try await session.sdk.blockHeader(block))]
            }
            case "getBlockBody": run(session, request, result) {
                [CitizenSdkFlutterCodec.blockBody(try await session.sdk.blockBody(block))]
            }
            case "getRuntimeContext": run(session, request, result) {
                [CitizenSdkFlutterCodec.runtimeContext(try await session.sdk.runtimeContext(block))]
            }
            case "getSystemEvents": run(session, request, result) {
                [CitizenSdkFlutterCodec.optionalBytes(try await session.sdk.systemEvents(block))]
            }
            default: fail(result, .unsupported, "Unsupported block method", request)
            }
        case let .storage(_, _, block, key): run(session, request, result) {
            [CitizenSdkFlutterCodec.optionalBytes(try await session.sdk.storage(block, key: key))]
        }
        case let .storageBatch(_, _, block, keys): run(session, request, result) {
            [try await session.sdk.storageBatch(block, keys: keys).map(CitizenSdkFlutterCodec.optionalBytes)]
        }
        case let .storageKeysPage(_, _, block, prefix, startKey, limit):
            run(session, request, result) {
                [try await session.sdk.storageKeysPaged(
                    block, prefix: prefix, startKey: startKey, limit: limit)]
            }
        case let .runtimeAPI(_, _, block, method, arguments): run(session, request, result) {
            [try await session.sdk.callRuntimeAPI(block, method: method, arguments: arguments)]
        }
        case let .importState(_, _, state): run(session, request, result) {
            try await session.sdk.importState(state); return []
        }
        case let .walletInput(method, _, _, text, password, wordCount, indices):
            walletInput(session, request, result, method: method, text: text, password: password, wordCount: wordCount, indices: indices)
        case let .resource(method, _, _, id): resource(session, request, result, method: method, id: id)
        case let .coldCode(_, _, code, name): runOperation(session, request, result, { try session.sdk.importColdAccountCode(code, name: name) }) {
            [CitizenSdkFlutterCodec.walletState($0)]
        }
        case let .walletInspection(method, _, _, id, index, name): runOperation(session, request, result, {
            guard let inspection = session.inspections[id] else { throw CitizenSDKError(.notFound, "检查资源不属于当前实例") }
            if method == "repairHotWallet" { return try inspection.repairHot(walletIndex: index) }
            if method == "deleteDiagnosticWallet" { return try inspection.delete(walletIndex: index) }
            guard let name else { throw CitizenSDKError(.invalidArgument, "钱包名称缺失") }
            return try inspection.rename(walletIndex: index, name: name)
        }) { [CitizenSdkFlutterCodec.walletState($0)] }
        case let .walletMetadata(method, _, _, revision, index, name): runOperation(session, request, result, {
            if method == "setActiveWallet" { return try session.sdk.setActiveWallet(expectedRevision: revision, walletIndex: index) }
            guard let name else { throw CitizenSDKError(.integrity, "wallet name missing") }
            return try session.sdk.renameWallet(expectedRevision: revision, walletIndex: index, name: name)
        }) { [CitizenSdkFlutterCodec.walletState($0)] }
        case let .rename(method, _, _, accountID, name): runOperation(session, request, result, {
            if method == "importColdAccountId" { return try session.sdk.importColdAccount(accountID: accountID, name: name) }
            return try session.sdk.renameAccount(accountID: accountID, name: name)
        }) { [CitizenSdkFlutterCodec.walletState($0)] }
        case let .coldSS58(_, _, address, name): runOperation(session, request, result, { try session.sdk.importColdAccount(ss58Address: address, name: name) }) {
            [CitizenSdkFlutterCodec.walletState($0)]
        }
        case let .reorder(_, _, revision, accountIDs): runOperation(session, request, result, {
            try session.sdk.reorderWalletAccountsWithoutDefaultChange(expectedRevision: revision, accountIDs: accountIDs)
        }) { [CitizenSdkFlutterCodec.walletState($0)] }
        case let .sign(_, _, accountID, payload): runOperation(session, request, result, {
            try session.sdk.signing.sign(accountID: accountID, message: payload)
        }) { [CitizenSdkFlutterCodec.signature($0)] }
        case let .beginSigning(_, _, intent): runOperation(session, request, result, { try session.sdk.signing.begin(intent) }) {
            [CitizenSdkFlutterCodec.signingOutcome($0)]
        }
        case let .externalSignature(method, _, _, signingSessionID, response):
            if method == "consumeExternalSignature" {
                runOperation(session, request, result, { try session.sdk.signing.consumeExternalSignature(sessionID: signingSessionID, response: response) }) {
                    [CitizenSdkFlutterCodec.signingOutcome($0)]
                }
            } else {
                runOperation(session, request, result, { try session.sdk.consumeDefaultAccountChange(sessionID: signingSessionID, response: response) }) {
                    [CitizenSdkFlutterCodec.defaultAccountChangeOutcome($0)]
                }
            }
        case let .cancelSigning(_, _, signingSessionID):
            do { success(result, request, [try session.sdk.signing.cancel(sessionID: signingSessionID)]) }
            catch { fail(result, error, request) }
        case let .beginDefaultChange(_, _, revision, accountIDs, ttl): runOperation(session, request, result, {
            try session.sdk.beginDefaultAccountChange(expectedRevision: revision, accountIDs: accountIDs, ttlSeconds: ttl)
        }) { [CitizenSdkFlutterCodec.defaultAccountChangeOutcome($0)] }
        case let .prepareTransaction(_, _, source, callData): run(session, request, result) {
            [CitizenSdkFlutterCodec.preparedTransaction(
                try await session.sdk.prepareTransaction(
                    sourceAccountID: source, callData: callData))]
        }
        case let .cancelPreparedTransaction(_, _, preparationID):
            do {
                try session.sdk.cancelPreparedTransaction(preparationID: preparationID)
                success(result, request, [nil])
            } catch { fail(result, error, request) }
        case let .transactionExecution(method, _, _, executionID, response):
            if method == "cancelPreparedTransactionExecution" {
                do {
                    try session.sdk.cancelPreparedTransactionExecution(executionID: executionID)
                    success(result, request, [nil])
                } catch { fail(result, error, request) }
            } else {
                run(session, request, result) {
                    let value: CitizenTransactionExecution
                    if method == "executePreparedTransaction" {
                        value = try await session.sdk.executePreparedTransaction(preparationID: executionID)
                    } else {
                        value = .completed(try await session.sdk.consumePreparedTransactionQrResponse(
                            executionID: executionID, response: response!))
                    }
                    return [try CitizenSdkFlutterCodec.transactionExecution(value)]
                }
            }
        case let .transactionHistory(method, _, _, beforeExecutionID, limit):
            run(session, request, result) {
                let page = method == "getTransactionHistory"
                    ? try await session.sdk.getTransactionHistory(
                        beforeExecutionID: beforeExecutionID, limit: limit)
                    : try await session.sdk.syncTransactionHistory()
                return [try CitizenSdkFlutterCodec.transactionHistoryPage(page)]
            }
        case let .qr(method, _, _, fields):
            if method == "reviewQrRequest" {
                runOperation(session, request, result, { try session.sdk.signing.reviewQrRequest(fields[0] as! String) }) { review in
                    guard !session.closing else { try review.release(); throw CitizenSDKError(.cancelled, "session is closing") }
                    let id = UUID().uuidString; session.reviews[id] = review
                    return [id, review.coreJSON]
                }
            } else if method == "openQrCapture" {
                openCapture(session, request, result, purpose: CitizenQRScanPurpose(rawValue: UInt8(fields[0] as! Int64))!)
            } else if method == "setQrCaptureTorch" {
                run(session, request, result) {
                    guard let binding = session.captures[fields[0] as! String] else { throw CitizenSDKError(.notFound, "capture is not owned by this session") }
                    try await binding.capture.setTorch(fields[1] as! Bool); return []
                }
            } else {
                run(session, request, result) { try await self.qr(session, method: method, fields: fields) }
            }
        case .open, .verify, .encodePayload: fail(result, .invalidState, "A stateless request cannot be routed as a session request", request)
        }
    }

    private func openCapture(_ session: Session, _ request: CitizenSdkFlutterCodec.Request,
                             _ result: @escaping FlutterResult, purpose: CitizenQRScanPurpose) {
        guard let textures else { fail(result, .unavailable, "texture registry is unavailable", request); return }
        let id = UUID().uuidString
        // 接纳中的请求保有session；长期采集监听只弱引用session/self。
        run(session, request, result) { [weak self, session] in
            guard let self else { throw CitizenSDKError(.cancelled, "engine is detached") }
            // run已通过接纳检查后才注册；尚未开始便取消的请求不遗留空纹理。
            let texture = CaptureTexture()
            let textureID = textures.register(texture)
            guard Self.isCaptureTextureIDValid(textureID) else {
                throw CitizenSDKError(.unavailable, "texture registration failed")
            }
            let listener = CitizenSDKQrCapture.Listener(
                result: { [weak self, weak session] value in
                    Task { @MainActor in
                        guard let self, let session, session.captures[id] != nil else { return }
                        self.emit(session, type: "qrCaptureResult", payload: [id, Int64(value.purpose.rawValue), value.document.coreJSON])
                    }
                }, error: { [weak self, weak session] error in
                    Task { @MainActor in
                        guard let self, let session, session.captures[id] != nil else { return }
                        self.emit(session, type: "qrCaptureError", payload: [id, Int64(error.code.rawValue), CitizenSdkFlutterCodec.errorName(error.code), Int64(error.stage.rawValue)])
                    }
                }, frame: { [weak self, weak session] preview in
                    Task { @MainActor in
                        guard let self, let session, let binding = session.captures[id], !binding.released else { return }
                        self.textures?.textureFrameAvailable(binding.textureID)
                        if binding.preview != preview {
                            binding.preview = preview
                            self.emit(session, type: "qrCapturePreview", payload: [id, Int64(preview.width), Int64(preview.height), Int64(preview.rotationDegrees)])
                        }
                    }
                }, closed: { [weak self, weak session] in
                    Task { @MainActor in
                        guard let self, let session, session.captures[id] != nil else { return }
                        self.releaseCapture(session, id: id, remove: false)
                        self.emit(session, type: "qrCaptureClosed", payload: [id])
                    }
                })
            var owned: CitizenSDKQrCapture?
            do {
                let resource = try await session.sdk.openCapture(purpose: purpose, listener: listener)
                owned = resource
                if session.closing {
                    try await resource.close()
                    throw CitizenSDKError(.cancelled, "session is closing")
                }
                try await resource.pause()
                guard let preview = resource.preview else { try await resource.close(); throw CitizenSDKError(.integrity, "capture has no preview facts") }
                texture.bind(resource)
                session.captures[id] = CaptureBinding(resource, texture, textureID)
                return [id, textureID, Int64(preview.width), Int64(preview.height), Int64(preview.rotationDegrees)]
            } catch {
                if let owned { try? await owned.close() }
                texture.bind(nil)
                textures.unregisterTexture(textureID)
                throw error
            }
        }
    }

    private func releaseCapture(_ session: Session, id: String, remove: Bool = true) {
        guard let binding = session.captures[id] else { return }
        if !binding.released {
            binding.released = true
            binding.texture.bind(nil)
            textures?.unregisterTexture(binding.textureID)
        }
        if remove { session.captures.removeValue(forKey: id) }
    }

    private func walletInput(_ session: Session, _ request: CitizenSdkFlutterCodec.Request, _ result: @escaping FlutterResult,
        method: String, text: String, password: String, wordCount: UInt32, indices: [UInt32]) {
        switch method {
        case "validateWalletPassword", "validateWalletMnemonic":
            do {
                let value = try method == "validateWalletPassword" ? session.sdk.validatePassword(text) : session.sdk.validateMnemonic(text, wordCount: wordCount)
                success(result, request, [Int64(value.reason.rawValue), value.position.map { Int64($0) }])
            } catch { fail(result, error, request) }
        case "walletWordSuggestions":
            do { success(result, request, [try session.sdk.wordSuggestions(text)]) }
            catch { fail(result, error, request) }
        case "prepareWalletCreation": runOperation(session, request, result, { try session.sdk.prepareCreation(wordCount: wordCount, password: password) }) { resource in
            guard !session.closing else { try resource.release(); throw CitizenSDKError(.cancelled, "session is closing") }
            let id = UUID().uuidString; session.prepared[id] = resource
            return [id]
        }
        case "importWallet", "addWalletAccounts", "addNextWalletAccount":
            runOperation(session, request, result, {
                switch method {
                case "importWallet": return try session.sdk.importWallet(mnemonic: text, password: password)
                case "addNextWalletAccount": return try session.sdk.addNextAccount(mnemonic: text, password: password)
                default: return try session.sdk.addAccounts(mnemonic: text, password: password, indices: indices)
                }
            }) { [CitizenSdkFlutterCodec.profile($0)] }
        default: fail(result, .unsupported, "unsupported wallet input", request)
        }
    }

    private func resource(_ session: Session, _ request: CitizenSdkFlutterCodec.Request, _ result: @escaping FlutterResult, method: String, id: String) {
        do {
            switch method {
            case "respondCredential", "cancelCredential":
                throw CitizenSDKError(.invalidState, "No active credential challenge")
            case "cancelOperation": success(result, request, [try session.cancellations[Int64(id)!]?() ?? false])
            case "copyRecoveryPhrase":
                guard let prepared = session.prepared[id] else { throw CitizenSDKError(.notFound, "preparation is not owned by this session") }
                let phrase = try prepared.recoveryPhrase()
                defer { phrase.release() }
                var bytes = try phrase.bytes
                defer { bytes.resetBytes(in: 0..<bytes.count) }
                success(result, request, [FlutterStandardTypedData(bytes: bytes)])
            case "commitWalletCreation":
                guard let prepared = session.prepared[id] else { throw CitizenSDKError(.notFound, "preparation is not owned by this session") }
                runOperation(session, request, result, { try prepared.commit() }) { [CitizenSdkFlutterCodec.profile($0)] }
            case "releasePreparedWallet":
                guard let prepared = session.prepared[id] else { throw CitizenSDKError(.notFound, "preparation is not owned by this session") }
                try prepared.release(); session.prepared.removeValue(forKey: id); success(result, request, [])
            case "revealPrivateKey", "closePrivateKey":
                guard let resource = session.privateKeys[id] else { throw CitizenSDKError(.notFound, "private key is not owned by this session") }
                run(session, request, result) {
                    if method == "closePrivateKey" { try await resource.close(); session.privateKeys.removeValue(forKey: id); return [] }
                    var bytes = try await resource.reveal()
                    defer { bytes.resetBytes(in: 0..<bytes.count) }
                    return [FlutterStandardTypedData(bytes: bytes)]
                }
            case "releaseWalletInspection":
                guard let inspection = session.inspections[id] else { throw CitizenSDKError(.notFound, "检查资源不属于当前实例") }
                try inspection.release(); session.inspections.removeValue(forKey: id); success(result, request, [])
            case "releaseQrReview":
                guard let review = session.reviews[id] else { throw CitizenSDKError(.notFound, "review is not owned by this session") }
                try review.release(); session.reviews.removeValue(forKey: id); success(result, request, [])
            case "signQrRequest":
                guard let review = session.reviews[id] else { throw CitizenSDKError(.notFound, "review is not owned by this session") }
                runOperation(session, request, result, { try session.sdk.signing.signQrRequest(review) }) {
                    [$0.document.coreJSON, Int64($0.qrImage.width), Int64($0.qrImage.height), FlutterStandardTypedData(bytes: $0.qrImage.luminance)]
                }
            case "closeQrCapture", "pauseQrCapture", "resumeQrCapture":
                guard let binding = session.captures[id] else { throw CitizenSDKError(.notFound, "capture is not owned by this session") }
                run(session, request, result) {
                    if method == "closeQrCapture" { try await binding.capture.close(); self.releaseCapture(session, id: id); return [] }
                    if method == "pauseQrCapture" { try await binding.capture.pause() } else { try await binding.capture.resume() }
                    return []
                }
            default: fail(result, .unsupported, "unsupported resource method", request)
            }
        } catch { fail(result, error, request) }
    }

    private func qr(_ session: Session, method: String, fields: [Any]) async throws -> [Any?] {
        switch method {
        case "qrEncodeDocument": return [try session.sdk.qrEncodeDocument(inputJSON: fields[0] as! String).coreJSON]
        case "qrPrepareAccountAuthorization": return [try session.sdk.qrPrepareAccountAuthorization(
            action: fields[0] as! UInt32, payload: fields[1] as! Data, accountID: fields[2] as! String).coreJSON]
        case "qrParse": return [try session.sdk.qrParse(fields[0] as! String).coreJSON]
        case "qrDecodeImage":
            let sdk = session.sdk, data = fields[0] as! Data
            let purpose = CitizenQRScanPurpose(rawValue: UInt8(fields[1] as! Int64))!
            let values = try await Task.detached { try sdk.decodeImage(data, purpose: purpose) }.value
            return [values.map { $0.document.coreJSON }]
        case "qrCreateSignRequest": return [try session.sdk.qrCreateSignRequest(action: UInt16(fields[0] as! Int64),
            signerAccountID: fields[1] as! Data, reviewPayload: fields[2] as! Data, ttlSeconds: UInt64(fields[3] as! Int64))]
        case "qrValidateSignResponse":
            try session.sdk.qrValidateSignResponse(sessionID: fields[0] as! String, response: fields[1] as! String)
            return []
        case "qrConsumeSignResponse": return [FlutterStandardTypedData(bytes: try session.sdk.qrConsumeSignResponse(fields[0] as! String))]
        case "qrCancelSignRequest": return [try session.sdk.qrCancelSignRequest(fields[0] as! String)]
        case "qrEncodeAccountId": return [try session.sdk.qrEncodeAccountID(fields[0] as! Data)]
        case "qrDecodeLuminance": return [try session.sdk.qrDecodeLuminance(fields[0] as! Data,
            width: UInt32(fields[1] as! Int64), height: UInt32(fields[2] as! Int64), rowStride: UInt32(fields[3] as! Int64)).coreJSON]
        case "qrEncode":
            let image = try session.sdk.qrEncode(fields[0] as! String, scale: UInt32(fields[1] as! Int64))
            return [Int64(image.width), Int64(image.height), FlutterStandardTypedData(bytes: image.luminance)]
        default: throw CitizenSDKError(.unsupported, "unsupported QR method")
        }
    }

    private func runOperation<Value: Sendable>(_ session: Session, _ request: CitizenSdkFlutterCodec.Request,
        _ result: @escaping FlutterResult, _ start: () throws -> CitizenSDKOperation<Value>,
        encode: @escaping (Value) throws -> [Any?]) {
        do {
            let operation = try start()
            let sequence = request.sequence!
            session.cancellations[sequence] = operation.cancel
            run(session, request, result, cancel: { _ = try? operation.cancel() }, accepted: true) {
                defer { session.cancellations.removeValue(forKey: sequence) }
                return try encode(try await operation.value())
            }
        } catch { fail(result, error, request) }
    }

    // Flutter 编码值只在 MainActor 内传递；异步操作不把 Any 结果跨执行器发送。
    private func run(_ session: Session, _ request: CitizenSdkFlutterCodec.Request,
                     _ result: @escaping FlutterResult, cancel: (() -> Void)? = nil,
                     accepted: Bool = false, operation: @escaping @MainActor () async throws -> [Any?]) {
        let id = UUID()
        let context = CitizenSdkFlutterCodec.Request.empty(method: request.method, session: request.sessionID!, sequence: request.sequence!)
        let task = Task { [weak self, weak session] in
            guard let self, let session else { return }
            let outcome: Result<[Any?], Error>
            do {
                if !accepted && (session.closing || Task.isCancelled) { throw CitizenSDKError(.cancelled, "request was cancelled before native admission") }
                outcome = .success(try await operation())
            }
            catch { outcome = .failure(error) }
            // Remove ownership before invoking FlutterResult: user test code or
            // the Dart messenger may synchronously reenter `close`.
            _ = citizenSDKFlutterTakeOutstanding(id, from: &session.outstanding)
            // Engine detach revokes the reply channel. The task must still
            // finish so Core can close, but it must not invoke a stale result.
            guard !self.detached, !self.subscriptionEpoch.isInvalidated else { return }
            switch outcome {
            case let .success(value): self.success(result, context, value)
            case let .failure(error): self.fail(result, error, context)
            }
        }
        session.outstanding[id] = Outstanding(task: task, cancel: cancel)
    }

    private func close(_ session: Session, _ request: CitizenSdkFlutterCodec.Request,
                       _ result: @escaping FlutterResult) {
        guard !session.closing else { fail(result, .busy, "CitizenSDK close is already running", request); return }
        session.closing = true
        Task { [weak self, weak session] in
            guard let self, let session else { return }
            do {
                try await self.supervisedClose(session)
                guard !self.detached, !self.subscriptionEpoch.isInvalidated else { return }
                self.success(result, request, ["disposed"])
            } catch {
                if self.detached || self.subscriptionEpoch.isInvalidated {
                    session.sdk.enqueueForSupervisedClose()
                    self.sessions.removeValue(forKey: session.sdk.sessionID)
                    return
                }
                session.closing = false
                self.fail(result, error, request)
            }
        }
    }

    private func supervisedClose(_ session: Session) async throws {
        let prepared = prepareForClose(session)
        await citizenSDKFlutterCancelAndDrain(
            prepared.outstanding,
            cancel: Self.cancel,
            wait: { await $0.task.value }
        )
        try await finishSupervisedClose(session)
    }

    private func prepareForClose(_ session: Session) -> ClosePreparation {
        session.closing = true
        session.sdk.requestResourceClose()
        return ClosePreparation(session: session, outstanding: Array(session.outstanding.values))
    }

    private static func cancel(_ value: Outstanding) {
        value.cancel?()
        value.task.cancel()
    }

    private func finishSupervisedClose(_ session: Session) async throws {
        // The facade's cached lifecycle event may lag behind Core. Its SPI
        // recovery path queries the authoritative C lifecycle, checkpoints a
        // truly running Core, and resumes partial teardown monotonically.
        try await session.sdk.supervisedClose()
        for id in Array(session.captures.keys) { releaseCapture(session, id: id) }
        session.prepared.removeAll(); session.privateKeys.removeAll(); session.reviews.removeAll(); session.inspections.removeAll()
        sessions.removeValue(forKey: session.sdk.sessionID)
    }

    private func onSDKEvent(_ session: Session, _ event: CitizenSDKEvent, expectedGeneration: UInt64) {
        guard sessions[session.sdk.sessionID] === session else { return }
        switch event {
        case .historyChanged:
            emit(session, type: "historyChanged", payload: [], expectedGeneration: expectedGeneration)
        case .walletChanged:
            emit(session, type: "walletChanged", payload: [], expectedGeneration: expectedGeneration)
        case let .finalizedBlockChanged(_, finalized):
            emit(session, type: "finalizedBlockChanged",
                 payload: [CitizenSdkFlutterCodec.block(finalized)],
                 expectedGeneration: expectedGeneration)
        case let .lifecycleChanged(_, lifecycle):
            emit(session, type: "lifecycleChanged", payload: [CitizenSdkFlutterCodec.lifecycle(lifecycle)],
                 expectedGeneration: expectedGeneration)
        case let .capabilitiesChanged(_, capabilities):
            emit(session, type: "capabilitiesChanged", payload: [CitizenSdkFlutterCodec.capabilities(capabilities)],
                 expectedGeneration: expectedGeneration)
        @unknown default: return
        }
    }

    private func emit(_ session: Session, type: String, payload: [Any?], expectedGeneration: UInt64? = nil) {
        guard !detached, subscriptionEpoch.accepts(expectedGeneration),
              let sink, session.nextEvent < Int64.max else { return }
        let sequence = session.nextEvent; session.nextEvent += 1
        guard let encoded = try? CitizenSdkFlutterCodec.event(
            session: session.sdk.sessionID, sequence: sequence, type: type, payload: payload
        ) else { return }
        sink(encoded)
    }

    private func success(_ result: @escaping FlutterResult, _ request: CitizenSdkFlutterCodec.Request,
                         _ value: [Any?]) {
        success(result, session: request.sessionID!, sequence: request.sequence!, value: value)
    }
    private func success(_ result: @escaping FlutterResult, session: String, sequence: Int64, value: [Any?]) {
        result(CitizenSdkFlutterCodec.response(session: session, sequence: sequence, value: value))
    }

    private func fail(_ result: @escaping FlutterResult, _ error: Error,
                      _ request: CitizenSdkFlutterCodec.Request) {
        if let contract = error as? CitizenSdkFlutterCodec.ContractFailure {
            fail(result, contract.code, contract.message, request, session: contract.session,
                 sequence: contract.sequence, stage: contract.stage)
        } else if let sdk = error as? CitizenSDKError {
            fail(result, sdk.code, sdk.message, request, stage: sdk.stage)
        } else if error is CancellationError {
            fail(result, .cancelled, "CitizenSDK operation cancelled", request)
        } else {
            fail(result, .internalFailure, "CitizenSDK host failure", request)
        }
    }
    private func fail(_ result: @escaping FlutterResult, _ code: CitizenSDKErrorCode, _ message: String,
                      _ request: CitizenSdkFlutterCodec.Request, session: String? = nil, sequence: Int64? = nil,
                      stage: CitizenSDKFailureStage? = nil) {
        result(FlutterError(code: "citizensdk.\(CitizenSdkFlutterCodec.errorName(code))", message: message,
                            details: CitizenSdkFlutterCodec.error(code, message,
                                session: session ?? request.sessionID, sequence: sequence ?? request.sequence,
                                method: request.method, stage: stage)))
    }

    internal static func exactProtocolVersion(_ raw: Any?) -> Bool {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              !CFNumberIsFloatType(number) else { return false }
        return number.int64Value == CitizenSdkFlutterCodec.version
    }
}

/// Thread-safe epoch captured at native callback time, before hopping to the
/// Flutter main actor. Old queued events can never target a replacement sink.
internal final class CitizenSdkFlutterSubscriptionEpoch: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64
    private var invalidated = false
    init(_ value: UInt64 = 0) { self.value = value }
    func snapshot() -> UInt64 { lock.lock(); defer { lock.unlock() }; return value }
    var isInvalidated: Bool { lock.lock(); defer { lock.unlock() }; return invalidated }
    func advance() throws -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        guard !invalidated else { throw CitizenSDKError(.invalidState, "event generation is invalidated") }
        guard value < UInt64.max else { throw CitizenSDKError(.integrity, "event generation is exhausted") }
        value += 1
        return value
    }
    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        invalidated = true
    }
    func accepts(_ expected: UInt64?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !invalidated && (expected == nil || expected == value)
    }
}

/// Starts a plugin detach exactly once and fixes the synchronous teardown
/// order. Handler revocation happens before epoch invalidation, while the
/// engine messenger is still valid. Session closure is scheduled separately.
internal final class CitizenSdkFlutterDetachCoordinator: @unchecked Sendable {
    private let lock = NSLock()
    private var started = false

    func begin(
        revokeMethodHandler: () -> Void,
        revokeEventHandler: () -> Void,
        invalidateEventEpoch: () -> Void
    ) -> Bool {
        lock.lock()
        guard !started else { lock.unlock(); return false }
        started = true
        lock.unlock()
        revokeMethodHandler()
        revokeEventHandler()
        invalidateEventEpoch()
        return true
    }
}

/// Closes every snapshotted Flutter session. One failing session cannot skip
/// later sessions; the failure path transfers ownership to Core supervision.
@MainActor
internal func citizenSDKFlutterCloseEverySession<Value>(
    _ values: [Value],
    close: @MainActor (Value) async throws -> Void,
    recover: @MainActor (Value) -> Void
) async {
    for value in values {
        do { try await close(value) }
        catch { recover(value) }
    }
}

/// Cancels every operation before awaiting any one of them. This prevents the
/// first slow operation from keeping later sessions or wallet UI alive without
/// having received their cancellation signal.
@MainActor
internal func citizenSDKFlutterCancelAndDrain<Value>(
    _ values: [Value],
    cancel: @MainActor (Value) -> Void,
    wait: @MainActor (Value) async -> Void
) async {
    values.forEach(cancel)
    for value in values { await wait(value) }
}

/// Production uses this removal before invoking FlutterResult, so a reentrant
/// close can never observe or await the operation that is delivering it.
@MainActor
internal func citizenSDKFlutterTakeOutstanding<Value>(
    _ id: UUID,
    from values: inout [UUID: Value]
) -> Value? {
    values.removeValue(forKey: id)
}

/// Installs Flutter event ownership or closes the freshly-opened SDK before
/// propagating the original installation error.
@MainActor
internal func citizenSDKFlutterFinalizeOpen<Value>(
    _ value: Value,
    install: (Value) throws -> Void,
    cleanup: (Value) -> Void
) throws -> Value {
    do { try install(value); return value }
    catch { cleanup(value); throw error }
}

/// A failed Flutter listener installation still owns a live ABI callback and
/// host context. If synchronous close cannot finish, transfer the facade to
/// the supervised reaper instead of relying on a later `deinit` side effect.
@MainActor
internal func citizenSDKFlutterCloseOrSupervise(
    close: () throws -> Void,
    supervise: () -> Void
) {
    do { try close() }
    catch { supervise() }
}
