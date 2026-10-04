import Foundation

/// 原生公开操作的非秘密编号；与Core request_id独立，全进程单调且不回绕。
internal final class CitizenSDKOperationIdentifiers: @unchecked Sendable {
    static let shared = CitizenSDKOperationIdentifiers()
    private let lock = NSLock()
    private var next: UInt64
    internal init(next: UInt64 = 1) { self.next = next }
    internal func allocate() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        guard next != 0 else { throw CitizenSDKError(.unavailable, "operation identity space exhausted") }
        let value = next
        next = value == UInt64.max ? 0 : value + 1
        return String(value)
    }
}

/// 一个真实接纳操作的结果与取消关联；内部就绪锁存器的ID不进入公开通道。
public final class CitizenSDKOperation<Value: Sendable>: @unchecked Sendable {
    public let operationID: String
    private let lock = NSLock()
    private var outcome: Result<Value, Error>?
    private var waiters: [(Result<Value, Error>) -> Void] = []
    private let cancelAction: () throws -> Bool

    internal init(operationID: String = UUID().uuidString, cancel: @escaping () throws -> Bool) {
        self.operationID = operationID
        self.cancelAction = cancel
    }

    public func value() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            observe { result in
                switch result {
                case let .success(value): continuation.resume(returning: value)
                case let .failure(error): continuation.resume(throwing: error)
                }
            }
        }
    }

    @discardableResult
    public func cancel() throws -> Bool { try cancelAction() }

    /// 只变换完成值，关联标识和取消仍属于同一真实Core操作。
    internal func map<Output: Sendable>(_ transform: @escaping (Value) throws -> Output) -> CitizenSDKOperation<Output> {
        let output = CitizenSDKOperation<Output>(operationID: operationID, cancel: cancel)
        observe { result in output.complete(result.flatMap { value in Result { try transform(value) } }) }
        return output
    }

    internal func observe(_ observer: @escaping (Result<Value, Error>) -> Void) {
        lock.lock()
        if let outcome {
            lock.unlock()
            observer(outcome)
        } else {
            waiters.append(observer)
            lock.unlock()
        }
    }

    internal func complete(_ result: Result<Value, Error>) {
        lock.lock()
        guard outcome == nil else { lock.unlock(); return }
        outcome = result
        let callbacks = waiters
        waiters.removeAll(keepingCapacity: false)
        lock.unlock()
        callbacks.forEach { $0(result) }
    }
}
