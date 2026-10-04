import Foundation

/// Fixed-lifetime mutable bytes that are zeroed before deallocation.
internal final class CitizenSDKSensitiveBuffer {
    private let pointer: UnsafeMutableRawPointer
    let count: Int
    private var cleared = false

    init(bytes: UnsafeRawBufferPointer) {
        count = bytes.count
        pointer = .allocate(byteCount: max(1, count), alignment: 16)
        if count > 0, let base = bytes.baseAddress { pointer.copyMemory(from: base, byteCount: count) }
    }

    init(data: Data) {
        // A Data-backed pointer is valid only inside withUnsafeBytes. Returning
        // that pointer from the closure and delegating afterwards creates a
        // dangling source window, so allocate and copy while Data still owns it.
        let byteCount = data.count
        let storage = UnsafeMutableRawPointer.allocate(
            byteCount: max(1, byteCount),
            alignment: 16
        )
        data.withUnsafeBytes { source in
            if byteCount > 0, let base = source.baseAddress {
                storage.copyMemory(from: base, byteCount: byteCount)
            }
        }
        count = byteCount
        pointer = storage
    }

    init(count: Int) {
        self.count = count
        pointer = .allocate(byteCount: max(1, count), alignment: 16)
        pointer.initializeMemory(as: UInt8.self, repeating: 0, count: count)
    }

    func withUnsafeBytes<T>(_ body: (UnsafeRawBufferPointer) throws -> T) rethrows -> T {
        precondition(!cleared)
        return try body(UnsafeRawBufferPointer(start: pointer, count: count))
    }

    func withUnsafeMutableBytes<T>(_ body: (UnsafeMutableRawBufferPointer) throws -> T) rethrows -> T {
        precondition(!cleared)
        return try body(UnsafeMutableRawBufferPointer(start: pointer, count: count))
    }

    func copyData() -> Data { withUnsafeBytes { Data($0) } }

    /// Source-internal tests use this only to prove terminal callbacks occur
    /// after controlled buffers have been cleared.
    internal var isClearedForTesting: Bool { cleared }

    func clear() {
        guard !cleared else { return }
        pointer.initializeMemory(as: UInt8.self, repeating: 0, count: count)
        cleared = true
    }

    deinit {
        clear()
        pointer.deallocate()
    }
}
