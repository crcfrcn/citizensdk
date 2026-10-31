@_spi(CitizenSDKFlutter) import CitizenSDK
import CoreFoundation
import Foundation
import CoreVideo

#if os(iOS)
import Flutter
#elseif os(macOS)
import FlutterMacOS
#endif

/// 仅登记真实系统资源会话；Dart借用同一Core句柄，普通业务不经过本路由。
@MainActor
internal final class CitizenSdkFlutterSessions: NSObject, @preconcurrency FlutterStreamHandler {
    @MainActor fileprivate final class Session {
        nonisolated let sdk: CitizenSdk
        var diagnostics: [[Any]] = []
        var diagnosticFile: URL?
        var diagnosticSignatures: [String: String] = [:]
        var nextEvent: Int64 = 1
        var closing = false
        var outstanding: [UUID: Task<Void, Never>] = [:]
        var privateKeys: [String: CitizenSDKPrivateKey] = [:]
        var captures: [String: CaptureBinding] = [:]
        init(_ sdk: CitizenSdk) { self.sdk = sdk }
    }

    private struct ClosePreparation {
        let session: Session
        let outstanding: [Task<Void, Never>]
    }

    private nonisolated let sessions = CitizenSdkFlutterRegistry()
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
    fileprivate final class CaptureTexture: NSObject, FlutterTexture, @unchecked Sendable {
        private let gate = NSLock()
        private var capture: CitizenSDKQrCapture?
        func bind(_ value: CitizenSDKQrCapture?) { gate.lock(); capture = value; gate.unlock() }
        func copyPixelBuffer() -> Unmanaged<CVPixelBuffer>? {
            gate.lock(); let value = capture; gate.unlock()
            return value?.copyPixelBuffer().map { Unmanaged.passRetained($0) }
        }
    }
    @MainActor fileprivate final class CaptureBinding {
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


    override init() {super.init()}

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
        sessions.values.forEach {$0.sdk.detachFfi()}
        let prepared = Array(sessions.values).map(prepareForClose)
        await citizenSDKFlutterCancelAndDrain(
            prepared.flatMap(\.outstanding),
            cancel: { $0.cancel() },
            wait: { await $0.value }
        )
        await citizenSDKFlutterCloseEverySession(
            prepared,
            close: { try await self.finishSupervisedClose($0.session) },
            recover: { preparation in
                // Plugin detach must not abandon a live callback/host context.
                // SDK保有未终结资源，完成检查点停止及Core销毁后才归还所有权。
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
        sessions.values.forEach {$0.sdk.detachFfi()}
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
            attachDiagnostics(session)
            sessions[sdk.sessionID] = session
            success(result, session: sdk.sessionID, sequence: 0,
                    value: [CitizenSdkFlutterCodec.lifecycle(sdk.lifecycle), Int64(1), String(try sdk.ffiHandle())])

        } catch {
            fail(result, error, .open(modules: modules))
        }
    }

    private static let diagnosticMethods: Set<String> = ["open", "start", "stop", "getSyncStatus", "getWalletState", "inspectWallets", "releaseWalletInspection", "cancelOperation"]
    private static let diagnosticPoints: Set<String> = ["NONE", "ADMISSION", "LOCAL_READ", "RESULT_READY", "RESTORE", "BEGIN", "PUBLISH_BEGIN", "PROVIDER_START", "REFRESH", "COMPLETE", "SERVICES", "PUBLISH_COMPLETE"]
    private func validDiagnostic(_ row: [Any]) -> Bool {
        guard row.count == 6, let method = row[0] as? String, Self.diagnosticMethods.contains(method),
              let phase = row[1] as? String, ["ADMISSION", "BEGIN", "DECODE", "COMPLETE"].contains(phase),
              let code = row[2] as? NSNumber, let stage = row[3] as? NSNumber,
              let point = row[4] as? String, Self.diagnosticPoints.contains(point),
              let elapsed = row[5] as? NSNumber else { return false }
        return CFGetTypeID(code) != CFBooleanGetTypeID() && CFGetTypeID(stage) != CFBooleanGetTypeID() &&
            CFGetTypeID(elapsed) != CFBooleanGetTypeID() &&
            code.doubleValue == Double(code.intValue) && (0...22).contains(code.intValue) &&
            stage.doubleValue == Double(stage.intValue) && (0...8).contains(stage.intValue) &&
            elapsed.doubleValue == Double(elapsed.int64Value) && (0...86400000).contains(elapsed.int64Value)
    }
    private func attachDiagnostics(_ session: Session) {
        do {
            guard let identity = Bundle.main.bundleIdentifier,
                  identity.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil else { return }
            let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)
            let directory = base.appendingPathComponent(identity).appendingPathComponent("citizensdk")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            guard directory.resolvingSymlinksInPath().standardizedFileURL == directory.standardizedFileURL else { return }
            let file = directory.appendingPathComponent("diagnostics.json")
            guard file.resolvingSymlinksInPath().standardizedFileURL == file.standardizedFileURL else { return }
            session.diagnosticFile = file
            if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 65536,
               let data = try? Data(contentsOf: file), let rows = try? JSONSerialization.jsonObject(with: data) as? [[Any]],
               rows.count <= 128, rows.allSatisfy(validDiagnostic) { session.diagnostics = rows }
        } catch { /* 诊断失效不能阻止SDK打开。 */ }
    }

    /// 诊断仅使用固定事实，不保存错误message、session或请求内容。
    private func diagnose(_ session: Session, _ method: String, _ phase: String,
                          _ error: CitizenSDKError? = nil) {
        guard Self.diagnosticMethods.contains(method) else { return }
        let prefix = method == "start" ? "CitizenSDK start panicked at " : "CitizenSDK request panicked at "
        let points = Self.diagnosticPoints.filter { $0 != "NONE" }
        let point = error?.code == .panic ? points.first(where: { error?.message == prefix + $0 }) ?? "NONE" : "NONE"
        let key = method + "/" + phase
        let signature = "\(error?.code.rawValue ?? 0)/\(error?.stage.rawValue ?? 0)/\(point)"
        if error == nil && session.diagnosticSignatures[key] == signature { return }
        session.diagnosticSignatures[key] = signature
        session.diagnostics.append([method, phase, Int(error?.code.rawValue ?? 0),
            Int(error?.stage.rawValue ?? 0), point, 0])
        if session.diagnostics.count > 128 { session.diagnostics.removeFirst() }
        if let file = session.diagnosticFile {
            do {
                guard file.resolvingSymlinksInPath().standardizedFileURL == file.standardizedFileURL else { return }
                let data = try JSONSerialization.data(withJSONObject: session.diagnostics)
                guard data.count <= 65536 else { return }
                try data.write(to: file, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                var location = file; var values = URLResourceValues(); values.isExcludedFromBackup = true
                try location.setResourceValues(values)
            } catch { /* 只写固定事实，不转发原始文件或异常。 */ }
        }
    }

    private func acceptDiagnostic(_ session:Session,_ row:[Any])throws{
      guard validDiagnostic(row)else{throw CitizenSDKError(.invalidArgument,"Invalid diagnostic row")}
      session.diagnostics.append(row);if session.diagnostics.count>128{session.diagnostics.removeFirst()}
      if let file=session.diagnosticFile{do{guard file.resolvingSymlinksInPath().standardizedFileURL==file.standardizedFileURL else{return};let data=try JSONSerialization.data(withJSONObject:session.diagnostics);guard data.count<=65536 else{return};try data.write(to:file,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)}catch{/* 诊断故障不改变原请求结果。 */}}
    }
    private func route(_ session:Session,request:CitizenSdkFlutterCodec.Request,result:@escaping FlutterResult){
      switch request {
       case let .empty(method,_,_):
        if method=="close"{close(session,request,result)}else{success(result,request,[session.diagnostics])}
       case let .account(_,_,_,account):run(session,request,result){[self,session] in
        let resource=try await session.sdk.openPrivateKey(accountID:account)
        guard !session.closing else{try await resource.close();throw CitizenSDKError(.cancelled,"session is closing")}
        let id=UUID().uuidString;session.privateKeys[id]=resource
        Task{@MainActor [weak self,weak session] in do{try await resource.closed}catch{};guard let self,let session else{return};self.emit(session,type:"privateKeyClosed",payload:[id])};return[id]
       }
       case let .resource(method,_,_,id):resource(session,request,result,method:method,id:id)
       case let .qr(method,_,_,fields):
        if method=="openQrCapture"{openCapture(session,request,result,purpose:CitizenQRScanPurpose(rawValue:UInt8(fields[0] as! Int64))!)}
        else if method=="setQrCaptureTorch"{run(session,request,result){guard let value=session.captures[fields[0] as! String]else{throw CitizenSDKError(.notFound,"capture unavailable")};try await value.capture.setTorch(fields[1] as! Bool);return[]}}
        else{run(session,request,result){[try session.sdk.decodeImage(fields[0] as! Data,purpose:CitizenQRScanPurpose(rawValue:UInt8(fields[1] as! Int64))!).map{$0.document.coreJSON}]}}
       case let .diagnostic(_,row):do{try acceptDiagnostic(session,row);success(result,session:session.sdk.sessionID,sequence:0,value:[])}catch{fail(result,error,request)}
       case .open:fail(result,.invalidState,"Invalid resource route",request)
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

    private func resource(_ session: Session, _ request: CitizenSdkFlutterCodec.Request, _ result: @escaping FlutterResult, method: String, id: String) {
        do {
            switch method {
            case "respondCredential", "cancelCredential":
                throw CitizenSDKError(.invalidState, "No active credential challenge")
            case "revealPrivateKey", "closePrivateKey":
                guard let resource = session.privateKeys[id] else { throw CitizenSDKError(.notFound, "private key is not owned by this session") }
                run(session, request, result) {
                    if method == "closePrivateKey" { try await resource.close(); session.privateKeys.removeValue(forKey: id); return [] }
                    var bytes = try await resource.reveal()
                    defer { bytes.resetBytes(in: 0..<bytes.count) }
                    return [FlutterStandardTypedData(bytes: bytes)]
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

    // Flutter 编码值只在 MainActor 内传递；异步操作不把 Any 结果跨执行器发送。
    private func run(_ session: Session, _ request: CitizenSdkFlutterCodec.Request,
                     _ result: @escaping FlutterResult,
                     accepted: Bool = false, operation: @escaping @MainActor () async throws -> [Any?]) {
        diagnose(session, request.method, "BEGIN")
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
            case let .success(value):
                self.diagnose(session, context.method, "COMPLETE")
                self.success(result, context, value)
            case let .failure(error):
                self.diagnose(session, context.method, "COMPLETE", error as? CitizenSDKError ?? CitizenSDKError(.internalFailure, "host failure"))
                self.fail(result, error, context)
            }
        }
        session.outstanding[id] = task
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
            cancel: { $0.cancel() },
            wait: { await $0.value }
        )
        try await finishSupervisedClose(session)
    }

    private func prepareForClose(_ session: Session) -> ClosePreparation {
        session.closing = true
        session.sdk.requestResourceClose()
        return ClosePreparation(session: session, outstanding: Array(session.outstanding.values))
    }

    private func finishSupervisedClose(_ session: Session) async throws {
        // SDK缓存事件不能代替Core真实生命周期；关闭读取实际状态，
        // 运行中的Core先保存检查点，部分销毁继续沿原拥有者完成。
        try await session.sdk.supervisedClose()
        for id in Array(session.captures.keys) { releaseCapture(session, id: id) }
        session.privateKeys.removeAll()
        sessions.removeValue(forKey: session.sdk.sessionID)
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

/// 监听器安装失败仍保有真实ABI回调与Host；同步关闭未完成时交后台继续排空。
@MainActor
internal func citizenSDKFlutterCloseOrSupervise(
    close: () throws -> Void,
    supervise: () -> Void
) {
    do { try close() }
    catch { supervise() }
}

// 唯一平台session容器；锁只保护容器，绝不持锁调用Core或等待认证。
private final class CitizenSdkFlutterRegistry:@unchecked Sendable {
 private let lock=NSLock();private var records:[String:CitizenSdkFlutterSessions.Session]=[:]
 subscript(id:String)->CitizenSdkFlutterSessions.Session?{get{lock.lock();defer{lock.unlock()};return records[id]}set{lock.lock();defer{lock.unlock()};records[id]=newValue}}
 var values:[CitizenSdkFlutterSessions.Session]{lock.lock();defer{lock.unlock()};return Array(records.values)}
 @discardableResult func removeValue(forKey id:String)->CitizenSdkFlutterSessions.Session?{lock.lock();defer{lock.unlock()};return records.removeValue(forKey:id)}
}
