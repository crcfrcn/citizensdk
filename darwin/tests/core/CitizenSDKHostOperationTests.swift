import XCTest
@testable import CitizenSDK

final class CitizenSDKHostOperationTests: XCTestCase {
    func testOperationCompletesObserversExactlyOnce() {
        var cancellations = 0
        var values: [Int] = []
        let operation = CitizenSDKOperation<Int> {
            cancellations += 1
            return true
        }
        operation.observe { if case let .success(value) = $0 { values.append(value) } }
        operation.complete(.success(7))
        operation.complete(.success(8))
        operation.observe { if case let .success(value) = $0 { values.append(value) } }

        XCTAssertEqual(values, [7, 7])
        XCTAssertTrue(try operation.cancel())
        XCTAssertEqual(cancellations, 1)
    }

    func testAcceptedVaultOwnerFinishesAndClearsExactlyOnce() {
        let pointer = UnsafeMutableRawPointer.allocate(byteCount: 32, alignment: 16)
        defer { pointer.deallocate() }
        pointer.initializeMemory(as: UInt8.self, repeating: 0xaa, count: 32)
        var releases = 0
        var completions: [CitizenSDKErrorCode] = []
        let owner = CitizenSDKAcceptedVaultOperation(
            output: UnsafeMutableRawBufferPointer(start: pointer, count: 32),
            releasePending: { releases += 1 },
            completion: { completions.append($0) }
        )

        owner.finish(.authenticationCancelled)
        owner.finish(.ok)

        XCTAssertEqual(releases, 1)
        XCTAssertEqual(completions, [.authenticationCancelled])
        let bytes = UnsafeRawBufferPointer(start: pointer, count: 32)
        XCTAssertTrue(bytes.allSatisfy { $0 == 0 })
    }
}

