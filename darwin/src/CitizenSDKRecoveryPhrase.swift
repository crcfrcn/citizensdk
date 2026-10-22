import Foundation

/// SDK控制的短时备份副本；不承诺清零宿主自行创建的Data或String副本。
public final class CitizenSDKRecoveryPhrase: @unchecked Sendable, CustomStringConvertible {
    public var description: String { "CitizenSDKRecoveryPhrase(<redacted>)" }
    private let lock = NSLock()
    private let buffer: CitizenSDKSensitiveBuffer
    private var closed = false
    init(buffer: CitizenSDKSensitiveBuffer) { self.buffer = buffer }

    public var bytes: Data {
        get throws {
            lock.lock(); defer { lock.unlock() }
            guard !closed else { throw CitizenSDKError(.invalidState, "recovery phrase is released") }
            return buffer.copyData()
        }
    }

    public func release() {
        lock.lock(); defer { lock.unlock() }
        if !closed { closed = true; buffer.clear() }
    }
    deinit { release() }
}

/// 工作线程只在短锁内复制 32 字节；不等待主线程、不反调 Core，也不构造秘密 String。
internal final class CitizenSDKPrivateKeyReceiver: @unchecked Sendable {
    private let lock = NSLock()
    private var value = [UInt8](repeating: 0, count: 32)
    private var viewID: UInt64 = 0
    private var hostOperationID: UInt64?
    private var registerAuthentication: ((UInt64) -> Int32)?
    private var closed = false
    private var populated = false
    private var lastCode: Int32?
    private var listener: (@Sendable (Int32) -> Void)?

    func bind(_ id: UInt64) {
        lock.lock(); defer { lock.unlock() }
        precondition(!closed && id != 0 && (viewID == 0 || viewID == id))
        viewID = id
    }

    func listen(_ value: @escaping @Sendable (Int32) -> Void) {
        lock.lock(); listener = value; let code = lastCode; lock.unlock()
        if let code { value(code) }
    }

    func bindAuthenticationRegistry(_ register: @escaping (UInt64) -> Int32) {
        lock.lock(); defer { lock.unlock() }
        registerAuthentication = register
    }

    /// 只登记本查看真实 unwrap 的身份；其它请求或重复关联不能获得焦点豁免。
    func authorizing(viewID id: UInt64, hostOperationID operationID: UInt64) -> Int32 {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return CitizenSDKErrorCode.cancelled.rawValue }
        guard id != 0, id == viewID, operationID != 0, hostOperationID == nil else {
            return CitizenSDKErrorCode.integrity.rawValue
        }
        guard let registerAuthentication else { return CitizenSDKErrorCode.integrity.rawValue }
        let code = registerAuthentication(operationID)
        guard code == 0 else { return code }
        hostOperationID = operationID
        return 0
    }

    var authenticationID: UInt64? {
        lock.lock(); defer { lock.unlock() }
        return hostOperationID
    }

    func receive(viewID id: UInt64, bytes: citizensdk_bytes_view_t) -> Int32 {
        guard bytes.len == 32, let source = bytes.data else { return CitizenSDKErrorCode.integrity.rawValue }
        lock.lock()
        guard !closed, !populated, id != 0, viewID == id else {
            lock.unlock()
            return CitizenSDKErrorCode.cancelled.rawValue
        }
        for index in 0..<32 { value[index] = source[index] }
        populated = true
        lock.unlock()
        return 0
    }

    func settled(viewID id: UInt64, code: Int32) {
        lock.lock()
        guard !closed, id != 0, viewID == 0 || viewID == id else { lock.unlock(); return }
        // 早到通知先绑定同一编号；后续不能把它交给另一资源。
        if viewID == 0 { viewID = id }
        lastCode = code
        let callback = listener
        lock.unlock()
        callback?(code)
    }

    func copyBytes() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        guard !closed, populated else { throw CitizenSDKError(.invalidState, "private key resource is closed") }
        return Data(value)
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        closed = true; populated = false
        for index in value.indices { value[index] = 0 }
    }

    var isClearedForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return closed && value.allSatisfy { $0 == 0 }
    }

    deinit { clear() }
}

/// 无窗口私钥资源。阶段通知不结束请求；close必须等待实际认证及Core回调排空。
@MainActor
public final class CitizenSDKPrivateKey {
    private let native: CitizenSDKNative
    private let receiver = CitizenSDKPrivateKeyReceiver()
    private let secretID: UInt64
    private let core: CitizenSDKOperation<Void>
    private let ready = CitizenSDKOperation<Void>(cancel: { false })
    private let revealed = CitizenSDKOperation<Void>(cancel: { false })
    private var stage = 0
    private var ending = false
    private var completed = false
    private var security: CitizenSDKScreenSecurity?
    private let ended: @Sendable (CitizenSDKPrivateKey) -> Void

    internal init(native: CitizenSDKNative, accountID: Data,
                  ended: @escaping @Sendable (CitizenSDKPrivateKey) -> Void) throws {
        self.native = native
        self.ended = ended
        (secretID, core) = try native.openPrivateKeyView(accountID: accountID, buffer: receiver)
        receiver.bind(secretID)
        receiver.listen { [weak self] code in
            // Core借用回调不执行用户续体或反调Core。
            Task { @MainActor [weak self] in self?.settled(code) }
        }
        core.observe { [self] result in
            // 结果观察者跨执行器后仍明确保有同一资源，终态只在MainActor收口。
            Task { @MainActor [self] in self.finalize(result) }
        }
        security = CitizenSDKScreenSecurity { [weak self] change in
            guard let self else { return }
            if change == .inactive, let id = self.receiver.authenticationID,
               self.native.isPrivateKeyAuthenticationActive(id) { return }
            self.requestClose()
        }
    }

    internal func waitUntilReady() async throws { try await ready.value() }

    public func reveal() async throws -> Data {
        guard !ending, stage == 1 else { throw CitizenSDKError(.invalidState, "private key is not ready or already revealed") }
        stage = 2
        do {
            try native.revealPrivateKeyView(secretID)
            try await revealed.value()
            guard !ending, security?.allowsDelivery == true else {
                requestClose()
                throw CitizenSDKError(.cancelled, "private key delivery was revoked")
            }
            return try receiver.copyBytes()
        } catch {
            requestClose()
            throw error
        }
    }

    public var closed: Void {
        get async throws {
            do { try await core.value(); finalize(.success(())) }
            catch {
                finalize(.failure(error))
                // 打开/查看阶段交付业务错误；此请求已经真实结束，关闭不能重复抛认证错误。
            }
        }
    }

    public func close() async throws {
        ending = true
        receiver.clear()
        if let operationID = receiver.authenticationID { native.cancelPrivateKeyAuthentication(operationID) }
        while !completed {
            do {
                try native.cancelPrivateKeyView(secretID)
                try native.finishPrivateKeyView(secretID)
                break
            } catch {
                // 控制失败不伪造终态，保留所有权直到真实请求结束；不丢弃授权Future。
                if completed { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        try await closed
    }

    internal nonisolated func requestClose() {
        Task { @MainActor [self] in try? await self.close() }
    }

    private func settled(_ code: Int32) {
        guard !ending else { return }
        guard code == 0 else {
            let error = CitizenSDKError(.checked(code), "private key authorization failed")
            ready.complete(.failure(error)); revealed.complete(.failure(error))
            requestClose()
            return
        }
        if stage == 0 { stage = 1; ready.complete(.success(())) }
        else if stage == 2 {
            guard security?.allowsDelivery == true else { requestClose(); return }
            stage = 3
            revealed.complete(.success(()))
        }
    }

    private func finalize(_ result: Result<Void, Error>) {
        guard !completed else { return }
        completed = true; ending = true; receiver.clear()
        security?.finish(); security = nil
        let error: Error
        switch result {
        case .success: error = CitizenSDKError(.cancelled, "private key resource is closed")
        case let .failure(value): error = value
        }
        ready.complete(.failure(error)); revealed.complete(.failure(error))
        ended(self)
    }

}
