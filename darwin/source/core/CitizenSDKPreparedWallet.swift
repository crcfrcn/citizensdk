import Foundation

/// 无窗口的一次性准备资源；接纳失败可重试，接纳后的异步失败不恢复提交资格。
public final class CitizenSDKPreparedWallet: @unchecked Sendable, CustomStringConvertible {
    public var description: String { "CitizenSDKPreparedWallet(<redacted>)" }
    private enum State { case open, committing, committed, releasing, released }
    private let lock = NSLock()
    private let native: CitizenSDKNative
    private let handle: UInt64
    private var state: State = .open
    private var phrases: [CitizenSDKRecoveryPhrase] = []
    private let released: ((CitizenSDKPreparedWallet) -> Void)?

    init(native: CitizenSDKNative, handle: UInt64, released: ((CitizenSDKPreparedWallet) -> Void)? = nil) {
        self.native = native
        self.handle = handle
        self.released = released
    }

    public func recoveryPhrase() throws -> CitizenSDKRecoveryPhrase {
        try lock.withLock {
            guard state == .open else { throw CitizenSDKError(.invalidState, "prepared wallet is already consumed") }
            let phrase = CitizenSDKRecoveryPhrase(buffer: try native.copyPreparedMnemonic(handle))
            phrases.append(phrase)
            return phrase
        }
    }

    /// 只同步完成接纳；实际提交结果与取消都沿原Operation路由。
    public func commit() throws -> CitizenSDKOperation<CitizenWalletProfile> {
        try lock.withLock {
            guard state == .open else { throw CitizenSDKError(.invalidState, "prepared wallet is already consumed") }
            state = .committing
        }
        do {
            let operation = try native.commitPrepared(handle)
            // Acceptance consumes the independent Core prepared handle even if
            // its later durable wallet mutation reports an error.
            lock.withLock { state = .committed }
            return operation.map { value in
                guard let value else { throw CitizenSDKError(.integrity, "wallet commit returned no profile") }
                return value
            }
        } catch {
            lock.withLock { if state == .committing { state = .open } }
            throw error
        }
    }

    public func release() throws {
        let shouldRelease = try lock.withLock { () -> Bool in
            switch state {
            case .open: state = .releasing; return true
            case .committing, .releasing:
                throw CitizenSDKError(.busy, "prepared wallet cleanup is already running")
            case .committed, .released: return false
            }
        }
        if shouldRelease {
            do {
                try native.releasePrepared(handle)
                lock.withLock { state = .released }
            } catch {
                lock.withLock { state = .open }
                throw error
            }
        }
        let owned = lock.withLock { let owned = phrases; phrases.removeAll(); return owned }
        owned.forEach { $0.release() }
        released?(self)
    }

    deinit { try? release() }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock(); defer { unlock() }
        return try body()
    }
}
