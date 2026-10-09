import XCTest
@testable import CitizenSDK

private final class CitizenSDKWalletRegistryProbe: @unchecked Sendable { }

final class CitizenSDKWalletFlowTests: XCTestCase {
    func testIndependentResourceTicketsDoNotRecreateOneWindowSlot() throws {
        let registry = CitizenSDKCloseGate()
        let sdk = CitizenSDKWalletRegistryProbe()
        registry.registerOpen(sdk)
        let first = try registry.reserve(sdk), second = try registry.reserve(sdk)
        XCTAssertNotEqual(first, second)
        registry.finish(sdk, token: first)
        XCTAssertEqual(registry.status(sdk), .owned)
        XCTAssertThrowsError(try registry.beginClose(sdk))
        registry.finish(sdk, token: second)
        XCTAssertEqual(registry.status(sdk), .open)
        registry.forget(sdk)
    }

    func testWalletAndCloseAdmissionAreOneAtomicStateMachine() throws {
        let registry = CitizenSDKCloseGate()
        let sdk = CitizenSDKWalletRegistryProbe()
        registry.registerOpen(sdk)
        XCTAssertEqual(registry.status(sdk), .open)

        let wallet = try registry.reserve(sdk)
        XCTAssertEqual(registry.status(sdk), .owned)
        registry.finish(sdk, token: UUID())
        XCTAssertEqual(registry.status(sdk), .owned, "a stale resource token must not release ownership")
        XCTAssertThrowsError(try registry.beginClose(sdk)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
        }
        registry.finish(sdk, token: wallet)

        let close = try XCTUnwrap(registry.beginClose(sdk))
        XCTAssertEqual(registry.status(sdk), .closing)
        XCTAssertThrowsError(try registry.beginClose(sdk)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
        }
        XCTAssertThrowsError(try registry.reserve(sdk)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
        }
        registry.commitClosed(sdk, reservation: close)
        XCTAssertEqual(registry.status(sdk), .closed)
        XCTAssertNil(try registry.beginClose(sdk))
        XCTAssertThrowsError(try registry.reserve(sdk)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .invalidState)
        }

        registry.forget(sdk)
        XCTAssertNil(registry.status(sdk))
    }

    func testCloseFailureRollsBackOnlyBeforeABITeardownStarts() throws {
        let registry = CitizenSDKCloseGate()
        let sdk = CitizenSDKWalletRegistryProbe()
        registry.registerOpen(sdk)

        let preTeardown = try XCTUnwrap(registry.beginClose(sdk))
        XCTAssertFalse(registry.failClose(sdk, reservation: preTeardown, teardownStarted: false))
        XCTAssertEqual(registry.status(sdk), .open)
        let wallet = try registry.reserve(sdk)
        registry.finish(sdk, token: wallet)

        let partialTeardown = try XCTUnwrap(registry.beginClose(sdk))
        XCTAssertFalse(registry.failClose(sdk, reservation: preTeardown, teardownStarted: false),
                       "a stale close token must not alter a newer attempt")
        XCTAssertEqual(registry.status(sdk), .closing)
        XCTAssertTrue(registry.failClose(sdk, reservation: partialTeardown, teardownStarted: true))
        XCTAssertEqual(registry.status(sdk), .closing)
        XCTAssertThrowsError(try registry.reserve(sdk))

        let retry = try XCTUnwrap(registry.beginClose(sdk))
        XCTAssertFalse(registry.failClose(sdk, reservation: retry, teardownStarted: false),
                       "a retry inherited from persistent closing must stay fail-closed")
        XCTAssertEqual(registry.status(sdk), .closing)
        let finalRetry = try XCTUnwrap(registry.beginClose(sdk))
        registry.commitClosed(sdk, reservation: finalRetry)
        XCTAssertEqual(registry.status(sdk), .closed)
    }

    func testSupervisedPreTeardownFailureStaysClosingBetweenRetries() throws {
        let registry = CitizenSDKCloseGate()
        let sdk = CitizenSDKWalletRegistryProbe()
        registry.registerOpen(sdk)

        let supervised = try XCTUnwrap(registry.beginClose(sdk, origin: .supervised))
        XCTAssertFalse(registry.failClose(sdk, reservation: supervised, teardownStarted: false),
                       "the existing supervisor owns retry; no second handoff is needed")
        XCTAssertEqual(registry.status(sdk), .closing)
        XCTAssertThrowsError(try registry.reserve(sdk)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
        }

        let retry = try XCTUnwrap(registry.beginClose(sdk, origin: .supervised))
        registry.commitClosed(sdk, reservation: retry)
        XCTAssertEqual(registry.status(sdk), .closed)
    }

    func testConcurrentWalletReserveCannotEnterClosePreflightWindow() throws {
        let registry = CitizenSDKCloseGate()
        let sdk = CitizenSDKWalletRegistryProbe()
        registry.registerOpen(sdk)
        let closeReserved = DispatchSemaphore(value: 0)
        let permitFailure = DispatchSemaphore(value: 0)
        let closeFinished = DispatchSemaphore(value: 0)

        DispatchQueue.global(qos: .userInitiated).async {
            let reservation = try? registry.beginClose(sdk)
            closeReserved.signal()
            permitFailure.wait()
            if let reservation {
                _ = registry.failClose(sdk, reservation: reservation, teardownStarted: false)
            }
            closeFinished.signal()
        }

        XCTAssertEqual(closeReserved.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(registry.status(sdk), .closing)
        XCTAssertThrowsError(try registry.beginClose(sdk)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
        }
        XCTAssertThrowsError(try registry.reserve(sdk)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
        }
        permitFailure.signal()
        XCTAssertEqual(closeFinished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(registry.status(sdk), .open)

        let wallet = try registry.reserve(sdk)
        registry.finish(sdk, token: wallet)
        XCTAssertEqual(registry.status(sdk), .open)
    }
}
