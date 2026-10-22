import Foundation
import XCTest
@testable import CitizenSDK
@testable import CitizenSDKFlutter

#if os(iOS)
import Flutter
#elseif os(macOS)
import FlutterMacOS
#endif

@MainActor
final class CitizenSDKFlutterSessionsTests: XCTestCase {
    private enum ProbeFailure: Error { case install, close }

    func testCaptureTextureIDsFollowDarwinRegistryContracts() {
        // iOS 首个真实注册编号是 0；macOS 仅把 0 作为失败哨兵。
        #if os(iOS)
        XCTAssertTrue(CitizenSdkFlutterSessions.isCaptureTextureIDValid(0))
        XCTAssertFalse(CitizenSdkFlutterSessions.isCaptureTextureIDValid(-1))
        #else
        XCTAssertFalse(CitizenSdkFlutterSessions.isCaptureTextureIDValid(0))
        #endif
        XCTAssertTrue(CitizenSdkFlutterSessions.isCaptureTextureIDValid(1))
    }

    func testProtocolVersionRejectsBoolAndFloatingNumbers() {
        XCTAssertTrue(CitizenSdkFlutterSessions.exactProtocolVersion(NSNumber(value: 2)))
        XCTAssertFalse(CitizenSdkFlutterSessions.exactProtocolVersion(NSNumber(value: true)))
        XCTAssertFalse(CitizenSdkFlutterSessions.exactProtocolVersion(NSNumber(value: 2.0)))
    }

    func testSubscriptionEpochRejectsStaleGenerationAndOverflow() throws {
        let epoch = CitizenSdkFlutterSubscriptionEpoch()
        let first = try epoch.advance()
        let queuedGeneration = epoch.snapshot()
        let replacement = try epoch.advance()
        XCTAssertEqual(first, queuedGeneration)
        XCTAssertNotEqual(queuedGeneration, replacement)
        XCTAssertTrue(epoch.accepts(replacement))

        let exhausted = CitizenSdkFlutterSubscriptionEpoch(UInt64.max)
        XCTAssertThrowsError(try exhausted.advance())
    }

    func testDetachPermanentlyInvalidatesCurrentAndFutureEventGenerations() throws {
        let epoch = CitizenSdkFlutterSubscriptionEpoch()
        let queuedGeneration = try epoch.advance()
        XCTAssertTrue(epoch.accepts(queuedGeneration))
        XCTAssertTrue(epoch.accepts(nil))

        epoch.invalidate()
        XCTAssertTrue(epoch.isInvalidated)
        XCTAssertFalse(epoch.accepts(queuedGeneration))
        XCTAssertFalse(epoch.accepts(nil))
        XCTAssertThrowsError(try epoch.advance())
    }

    func testRepeatedDetachRevokesHandlersAndEpochExactlyOnceInOrder() {
        let coordinator = CitizenSdkFlutterDetachCoordinator()
        var order: [String] = []
        let first = coordinator.begin(
            revokeMethodHandler: { order.append("method") },
            revokeEventHandler: { order.append("event") },
            invalidateEventEpoch: { order.append("epoch") }
        )
        let second = coordinator.begin(
            revokeMethodHandler: { order.append("duplicate-method") },
            revokeEventHandler: { order.append("duplicate-event") },
            invalidateEventEpoch: { order.append("duplicate-epoch") }
        )

        XCTAssertTrue(first)
        XCTAssertFalse(second)
        XCTAssertEqual(order, ["method", "event", "epoch"])
    }

    func testDetachCancelsEveryOutstandingOperationBeforeAwaitingAnyCompletion() async {
        var order: [String] = []
        await citizenSDKFlutterCancelAndDrain(
            [1, 2, 3],
            cancel: { order.append("cancel-\($0)") },
            wait: { order.append("wait-\($0)") }
        )
        XCTAssertEqual(order, [
            "cancel-1", "cancel-2", "cancel-3",
            "wait-1", "wait-2", "wait-3",
        ])
    }

    func testDetachClosesEverySessionAndSupervisesOnlyFailures() async {
        var closed: [Int] = []
        var supervised: [Int] = []
        await citizenSDKFlutterCloseEverySession(
            [1, 2, 3],
            close: { value in
                closed.append(value)
                if value == 2 { throw ProbeFailure.close }
            },
            recover: { supervised.append($0) }
        )
        XCTAssertEqual(closed, [1, 2, 3])
        XCTAssertEqual(supervised, [2])
    }

    func testOutstandingOwnershipIsRemovedBeforeReentrantDelivery() {
        let id = UUID()
        var outstanding = [id: "operation"]
        XCTAssertEqual(citizenSDKFlutterTakeOutstanding(id, from: &outstanding), "operation")
        var closeObservedCurrentOperation = true
        closeObservedCurrentOperation = outstanding[id] != nil
        XCTAssertFalse(closeObservedCurrentOperation)
    }

    func testFlutterOpenInstallFailureCleansUpAndPreservesError() {
        var cleanup = 0
        XCTAssertThrowsError(try citizenSDKFlutterFinalizeOpen(
            9,
            install: { _ in throw ProbeFailure.install },
            cleanup: { _ in cleanup += 1 }
        )) { XCTAssertTrue($0 is ProbeFailure) }
        XCTAssertEqual(cleanup, 1)
    }

    func testFlutterOpenCleanupTransfersFailedCloseToSupervisor() {
        var closes = 0
        var supervises = 0
        citizenSDKFlutterCloseOrSupervise(
            close: {
                closes += 1
                throw CitizenSDKError(.busy, "fixture")
            },
            supervise: { supervises += 1 }
        )
        XCTAssertEqual(closes, 1)
        XCTAssertEqual(supervises, 1)

        citizenSDKFlutterCloseOrSupervise(
            close: { closes += 1 },
            supervise: { supervises += 1 }
        )
        XCTAssertEqual(closes, 2)
        XCTAssertEqual(supervises, 1)
    }
}
