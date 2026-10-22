import XCTest
@testable import CitizenSDK

private actor CitizenSDKRetryProbe {
    private var attempts = 0
    func attempt(succeedAt: Int) -> Bool {
        attempts += 1
        return attempts == succeedAt
    }
    func count() -> Int { attempts }
}

private final class CitizenSDKLifetimeProbe {
    private let onDeinit: () -> Void
    init(onDeinit: @escaping () -> Void) { self.onDeinit = onDeinit }
    deinit { onDeinit() }
}

private final class CitizenSDKLockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}

/// XCTest expectations are intentionally kept behind one documented
/// Sendable relay before they cross Dispatch's `@Sendable` closure boundary.
private final class CitizenSDKExpectationRelay: @unchecked Sendable {
    private let expectation: XCTestExpectation
    init(_ expectation: XCTestExpectation) { self.expectation = expectation }
    func fulfill() { expectation.fulfill() }
}

private final class CitizenSDKRecursiveLockProbe: @unchecked Sendable {
    let value = NSRecursiveLock()
}

final class CitizenSDKLifecycleTests: XCTestCase {
    func testHistoryEventPreservesSequenceWithoutSnapshotOrResultOwnership() throws {
        XCTAssertEqual(CitizenSDKEvent.historyChanged(sequence: 7), .historyChanged(sequence: 7))
        XCTAssertNotEqual(CitizenSDKEvent.historyChanged(sequence: 7), .historyChanged(sequence: 8))
        let finalized = try CitizenBlockRef(
            hash: Data(repeating: 3, count: 32), number: 9, finality: .finalized)
        XCTAssertEqual(
            CitizenSDKEvent.finalizedBlockChanged(sequence: 8, finalized: finalized),
            .finalizedBlockChanged(sequence: 8, finalized: finalized))
    }
    private enum ProbeFailure: Error { case lifecycle, install }

    func testOpenLifecycleFailureRunsCleanupAndPreservesError() {
        var cleanups = 0
        XCTAssertThrowsError(try CitizenSdk.finalizeOpen(
            lifecycle: { throw ProbeFailure.lifecycle },
            install: { _ in XCTFail("install must not run") },
            cleanup: { cleanups += 1 }
        )) { XCTAssertTrue($0 is ProbeFailure) }
        XCTAssertEqual(cleanups, 1)
    }

    func testOpenListenerInstallFailureRunsCleanup() {
        var cleanups = 0
        XCTAssertThrowsError(try CitizenSdk.finalizeOpen(
            lifecycle: { .created },
            install: { _ -> Int in throw ProbeFailure.install },
            cleanup: { cleanups += 1 }
        ))
        XCTAssertEqual(cleanups, 1)
    }

    func testSuccessfulOpenFinalizationDoesNotCleanup() throws {
        var cleanups = 0
        let value: Int = try CitizenSdk.finalizeOpen(
            lifecycle: { .created }, install: { _ in 9 }, cleanup: { cleanups += 1 }
        )
        XCTAssertEqual(value, 9)
        XCTAssertEqual(cleanups, 0)
    }

    func testPreparedReleaseFailurePreventsDestroyAndCanRetry() throws {
        var firstAttempt = true
        var destroyed = 0
        func closeAttempt() throws {
            try CitizenSDKNative.releasePreparedBeforeDestroy(
                [7],
                release: { _ in
                    if firstAttempt { firstAttempt = false; throw ProbeFailure.install }
                },
                destroy: { destroyed += 1 }
            )
        }

        XCTAssertThrowsError(try closeAttempt())
        XCTAssertEqual(destroyed, 0)
        XCTAssertNoThrow(try closeAttempt())
        XCTAssertEqual(destroyed, 1)
    }

    func testSuccessfulABITeardownCommitsEveryStageAndReleasesOnce() throws {
        let coordinator = CitizenSDKABITeardownCoordinator()
        var calls: [String] = []
        var releases = 0
        try coordinator.perform(
            unsubscribe: { calls.append("unsubscribe") },
            clearCallback: { calls.append("clear") },
            destroy: { calls.append("destroy") },
            didDestroy: { releases += 1 }
        )
        XCTAssertEqual(calls, ["unsubscribe", "clear", "destroy"])
        XCTAssertEqual(coordinator.snapshot.phase, .closed)
        XCTAssertEqual(releases, 1)

        try coordinator.perform(
            unsubscribe: { XCTFail("closed coordinator unsubscribed twice") },
            clearCallback: { XCTFail("closed coordinator cleared twice") },
            destroy: { XCTFail("closed coordinator destroyed twice") },
            didDestroy: { releases += 1 }
        )
        XCTAssertEqual(releases, 1)
    }

    func testUnsubscribeFailureDoesNotGuessCommitAndBlocksNewWork() throws {
        let coordinator = CitizenSDKABITeardownCoordinator()
        var attempts = 0
        var clearCount = 0
        var destroyCount = 0
        XCTAssertThrowsError(try coordinator.perform(
            unsubscribe: {
                attempts += 1
                if attempts == 1 { throw ProbeFailure.install }
            },
            clearCallback: { clearCount += 1 },
            destroy: { destroyCount += 1 },
            didDestroy: { }
        ))
        XCTAssertEqual(coordinator.snapshot.phase, .live)
        XCTAssertTrue(coordinator.snapshot.teardownStarted)
        XCTAssertThrowsError(try coordinator.requireOperational())
        XCTAssertEqual(clearCount, 0)
        XCTAssertEqual(destroyCount, 0)

        try coordinator.perform(
            unsubscribe: { attempts += 1 },
            clearCallback: { clearCount += 1 },
            destroy: { destroyCount += 1 },
            didDestroy: { }
        )
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(clearCount, 1)
        XCTAssertEqual(destroyCount, 1)
    }

    func testCallbackClearFailureRetriesFromMonitorStopped() throws {
        let coordinator = CitizenSDKABITeardownCoordinator()
        var unsubscribeCount = 0
        var clearCount = 0
        var destroyCount = 0
        XCTAssertThrowsError(try coordinator.perform(
            unsubscribe: { unsubscribeCount += 1 },
            clearCallback: { clearCount += 1; throw ProbeFailure.install },
            destroy: { destroyCount += 1 },
            didDestroy: { }
        ))
        XCTAssertEqual(coordinator.snapshot.phase, .monitorStopped)
        XCTAssertEqual(destroyCount, 0)

        try coordinator.perform(
            unsubscribe: { unsubscribeCount += 1 },
            clearCallback: { clearCount += 1 },
            destroy: { destroyCount += 1 },
            didDestroy: { }
        )
        XCTAssertEqual(unsubscribeCount, 1)
        XCTAssertEqual(clearCount, 2)
        XCTAssertEqual(destroyCount, 1)
    }

    func testEveryDestroyFailureRetriesDestroyOnly() throws {
        for failure in [CitizenSDKError(.busy, "busy"), CitizenSDKError(.storage, "teardown") ] {
            let coordinator = CitizenSDKABITeardownCoordinator()
            var unsubscribeCount = 0
            var clearCount = 0
            var destroyCount = 0
            XCTAssertThrowsError(try coordinator.perform(
                unsubscribe: { unsubscribeCount += 1 },
                clearCallback: { clearCount += 1 },
                destroy: { destroyCount += 1; throw failure },
                didDestroy: { }
            ))
            XCTAssertEqual(coordinator.snapshot.phase, .destroyOnly)

            try coordinator.perform(
                unsubscribe: { unsubscribeCount += 1 },
                clearCallback: { clearCount += 1 },
                destroy: { destroyCount += 1 },
                didDestroy: { }
            )
            XCTAssertEqual(unsubscribeCount, 1)
            XCTAssertEqual(clearCount, 1)
            XCTAssertEqual(destroyCount, 2)
            XCTAssertEqual(coordinator.snapshot.phase, .closed)
        }
    }

    func testCallbackOrSubscribeSetupFailureConvergesThroughSameMachine() {
        for setupPoint in ["callbackInstall", "capabilitySubscribe"] {
            var calls: [String] = []
            XCTAssertThrowsError(try CitizenSDKNative.bindOrRecover(
                bind: { calls.append(setupPoint); throw ProbeFailure.install },
                close: { calls.append("close") },
                supervise: { calls.append("supervise") }
            )) { XCTAssertTrue($0 is ProbeFailure) }
            XCTAssertEqual(calls, [setupPoint, "close"])
        }
    }

    func testBindingFailureCloseFailureTransfersToSupervisor() {
        var calls: [String] = []
        XCTAssertThrowsError(try CitizenSDKNative.bindOrRecover(
            bind: { calls.append("bind"); throw ProbeFailure.install },
            close: { calls.append("close"); throw CitizenSDKError(.busy, "fixture") },
            supervise: { calls.append("supervise") }
        )) { XCTAssertTrue($0 is ProbeFailure) }
        XCTAssertEqual(calls, ["bind", "close", "supervise"])
    }

    func testABIRetainLeaseSurvivesFailureAndReleasesAfterDestroyOnly() throws {
        var deinits = 0
        var owner: CitizenSDKLifetimeProbe? = CitizenSDKLifetimeProbe { deinits += 1 }
        weak let weakOwner = owner
        let lease = CitizenSDKABIRetainLease(owner!)
        owner = nil
        XCTAssertNotNil(weakOwner)
        XCTAssertTrue(lease.isArmed)

        let coordinator = CitizenSDKABITeardownCoordinator()
        XCTAssertThrowsError(try coordinator.perform(
            unsubscribe: { }, clearCallback: { },
            destroy: { throw CitizenSDKError(.busy, "fixture") },
            didDestroy: { lease.releaseAfterSuccessfulDestroy() }
        ))
        XCTAssertNotNil(weakOwner)
        XCTAssertEqual(deinits, 0)

        try coordinator.perform(
            unsubscribe: { XCTFail("must be destroy-only") },
            clearCallback: { XCTFail("must be destroy-only") },
            destroy: { },
            didDestroy: { lease.releaseAfterSuccessfulDestroy() }
        )
        XCTAssertNil(weakOwner)
        XCTAssertEqual(deinits, 1)
        XCTAssertFalse(lease.isArmed)
        lease.releaseAfterSuccessfulDestroy()
        XCTAssertEqual(deinits, 1)
    }

    func testEveryTeardownStageFailureKeepsBorrowedContextUntilRecovery() throws {
        enum Stage: CaseIterable { case unsubscribe, clearCallback, destroy }

        for failedStage in Stage.allCases {
            var deinits = 0
            var owner: CitizenSDKLifetimeProbe? = CitizenSDKLifetimeProbe { deinits += 1 }
            weak let weakOwner = owner
            let lease = CitizenSDKABIRetainLease(owner!)
            owner = nil
            let coordinator = CitizenSDKABITeardownCoordinator()
            var injectFailure = true

            func failOnce(_ stage: Stage) throws {
                if failedStage == stage, injectFailure {
                    injectFailure = false
                    throw ProbeFailure.install
                }
            }

            func attempt() throws {
                try coordinator.perform(
                    unsubscribe: { try failOnce(.unsubscribe) },
                    clearCallback: { try failOnce(.clearCallback) },
                    destroy: { try failOnce(.destroy) },
                    didDestroy: { lease.releaseAfterSuccessfulDestroy() }
                )
            }

            XCTAssertThrowsError(try attempt())
            XCTAssertNotNil(weakOwner)
            XCTAssertTrue(lease.isArmed)
            XCTAssertEqual(deinits, 0)
            XCTAssertNoThrow(try attempt())
            XCTAssertNil(weakOwner)
            XCTAssertFalse(lease.isArmed)
            XCTAssertEqual(deinits, 1)
        }
    }

    func testSuccessfulDestroyDropsHostWhileClosedFacadeOwnerRemainsAlive() throws {
        var hostDeinits = 0
        var ownerDeinits = 0
        var host: CitizenSDKLifetimeProbe? = CitizenSDKLifetimeProbe { hostDeinits += 1 }
        var facadeOwner: CitizenSDKLifetimeProbe? = CitizenSDKLifetimeProbe { ownerDeinits += 1 }
        weak let weakHost = host
        weak let weakOwner = facadeOwner
        let resources = CitizenSDKABIBorrowedResources(host: host!, owner: facadeOwner!)
        host = nil

        let coordinator = CitizenSDKABITeardownCoordinator()
        XCTAssertThrowsError(try coordinator.perform(
            unsubscribe: { },
            clearCallback: { },
            destroy: { throw CitizenSDKError(.busy, "fixture") },
            didDestroy: { resources.releaseAfterSuccessfulDestroy() }
        ))
        XCTAssertNotNil(weakHost)
        XCTAssertNotNil(weakOwner)
        XCTAssertTrue(resources.hasHost)
        XCTAssertTrue(resources.isOwnerLeaseArmed)

        try coordinator.perform(
            unsubscribe: { XCTFail("destroy retry must not unsubscribe") },
            clearCallback: { XCTFail("destroy retry must not clear callback") },
            destroy: { },
            didDestroy: { resources.releaseAfterSuccessfulDestroy() }
        )
        XCTAssertNil(weakHost)
        XCTAssertEqual(hostDeinits, 1)
        XCTAssertNotNil(weakOwner, "a still-live closed facade owner is intentionally retained by the caller")
        XCTAssertFalse(resources.hasHost)
        XCTAssertFalse(resources.isOwnerLeaseArmed)

        resources.releaseAfterSuccessfulDestroy()
        XCTAssertEqual(hostDeinits, 1)
        facadeOwner = nil
        XCTAssertNil(weakOwner)
        XCTAssertEqual(ownerDeinits, 1)
    }

    func testBindingFailureAndFailedCleanupRetainUntilSupervisorRetry() throws {
        var deinits = 0
        var owner: CitizenSDKLifetimeProbe? = CitizenSDKLifetimeProbe { deinits += 1 }
        weak let weakOwner = owner
        let lease = CitizenSDKABIRetainLease(owner!)
        owner = nil
        let coordinator = CitizenSDKABITeardownCoordinator()
        var destroyAttempts = 0
        var supervised = 0

        XCTAssertThrowsError(try CitizenSDKNative.bindOrRecover(
            bind: { throw ProbeFailure.install },
            close: {
                try coordinator.perform(
                    unsubscribe: { },
                    clearCallback: { },
                    destroy: {
                        destroyAttempts += 1
                        throw CitizenSDKError(.busy, "fixture")
                    },
                    didDestroy: { lease.releaseAfterSuccessfulDestroy() }
                )
            },
            supervise: { supervised += 1 }
        )) { XCTAssertTrue($0 is ProbeFailure) }
        XCTAssertEqual(supervised, 1)
        XCTAssertNotNil(weakOwner)
        XCTAssertEqual(deinits, 0)

        try coordinator.perform(
            unsubscribe: { XCTFail("recovery must already be destroy-only") },
            clearCallback: { XCTFail("recovery must already be destroy-only") },
            destroy: { destroyAttempts += 1 },
            didDestroy: { lease.releaseAfterSuccessfulDestroy() }
        )
        XCTAssertEqual(destroyAttempts, 2)
        XCTAssertNil(weakOwner)
        XCTAssertEqual(deinits, 1)
    }

    func testSupervisedRetryEventuallyRecovers() async {
        let probe = CitizenSDKRetryProbe()
        let recovered = await CitizenSDKSupervisedRetry.run(
            maximumAttempts: 4,
            initialDelayNanoseconds: 0
        ) { await probe.attempt(succeedAt: 3) }
        XCTAssertTrue(recovered)
        let attempts = await probe.count()
        XCTAssertEqual(attempts, 3)
    }

    func testSupervisedCloseUsesCoreLifecycleInsteadOfDelayedFacadeCache() throws {
        // The public event cache may still say running after Core has already
        // completed stop. Recovery must use the injected C lifecycle instead.
        let delayedFacadeCache = CitizenSDKLifecycle.running
        var coreQueries = 0
        let action = try CitizenSDKNative.supervisedCloseAction(
            teardownStarted: false,
            lifecycle: {
                coreQueries += 1
                return .stopped
            }
        )
        XCTAssertEqual(delayedFacadeCache, .running)
        XCTAssertEqual(coreQueries, 1)
        XCTAssertEqual(action, .close)
    }

    func testSupervisedCloseQueryFailureDoesNotEnterTeardown() {
        XCTAssertThrowsError(try CitizenSDKNative.supervisedCloseAction(
            teardownStarted: false,
            lifecycle: { throw ProbeFailure.lifecycle }
        )) { XCTAssertTrue($0 is ProbeFailure) }
    }

    func testSupervisedCloseLifecyclePolicyIsFailClosed() throws {
        XCTAssertEqual(try CitizenSDKNative.supervisedCloseAction(
            teardownStarted: false, lifecycle: { .running }
        ), .stopThenClose)
        for lifecycle in [CitizenSDKLifecycle.created, .stopped, .startFailed, .disposed] {
            XCTAssertEqual(try CitizenSDKNative.supervisedCloseAction(
                teardownStarted: false, lifecycle: { lifecycle }
            ), .close)
        }
        for lifecycle in [CitizenSDKLifecycle.starting, .importingState] {
            XCTAssertThrowsError(try CitizenSDKNative.supervisedCloseAction(
                teardownStarted: false, lifecycle: { lifecycle }
            )) { error in
                XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
            }
        }
    }

    func testPartialTeardownNeverQueriesLifecycleAgain() throws {
        var queried = false
        let action = try CitizenSDKNative.supervisedCloseAction(
            teardownStarted: true,
            lifecycle: {
                queried = true
                return .running
            }
        )
        XCTAssertFalse(queried)
        XCTAssertEqual(action, .close)
    }

    func testAuthoritativeCloseGateRejectsDelayedRunningLifecycle() {
        let delayedFacadeCache = CitizenSDKLifecycle.created
        XCTAssertEqual(delayedFacadeCache, .created)
        XCTAssertThrowsError(try CitizenSDKNative.requireCheckpointSafeForClose(.running)) { error in
            XCTAssertEqual((error as? CitizenSDKError)?.code, .invalidState)
        }
        for lifecycle in [CitizenSDKLifecycle.starting, .importingState] {
            XCTAssertThrowsError(try CitizenSDKNative.requireCheckpointSafeForClose(lifecycle)) { error in
                XCTAssertEqual((error as? CitizenSDKError)?.code, .busy)
            }
        }
        for lifecycle in [CitizenSDKLifecycle.created, .stopped, .startFailed] {
            XCTAssertNoThrow(try CitizenSDKNative.requireCheckpointSafeForClose(lifecycle))
        }
        XCTAssertThrowsError(try CitizenSDKNative.requireCheckpointSafeForClose(.disposed))
    }

    func testPartialTeardownCloseGateNeverQueriesCoreLifecycle() throws {
        let lock = NSRecursiveLock()
        var queried = false
        var bodyRan = false
        try CitizenSDKNative.withCheckpointSafeCloseGate(
            lock: lock,
            checkpointRequired: { false },
            lifecycle: { queried = true; return .running },
            body: { bodyRan = true }
        )
        XCTAssertFalse(queried)
        XCTAssertTrue(bodyRan)
    }

    func testConcurrentStartCannotCrossAuthoritativeCloseGate() {
        let lock = CitizenSDKRecursiveLockProbe()
        let closeAdmitted = DispatchSemaphore(value: 0)
        let releaseClose = DispatchSemaphore(value: 0)
        let closeFinished = DispatchSemaphore(value: 0)
        let startAttempting = DispatchSemaphore(value: 0)
        let startEntered = DispatchSemaphore(value: 0)

        DispatchQueue.global(qos: .userInitiated).async {
            _ = try? CitizenSDKNative.withCheckpointSafeCloseGate(
                lock: lock.value,
                checkpointRequired: { true },
                lifecycle: { .created },
                body: {
                    closeAdmitted.signal()
                    releaseClose.wait()
                }
            )
            closeFinished.signal()
        }
        XCTAssertEqual(closeAdmitted.wait(timeout: .now() + 1), .success)

        DispatchQueue.global(qos: .userInitiated).async {
            startAttempting.signal()
            lock.value.lock()
            startEntered.signal()
            lock.value.unlock()
        }
        XCTAssertEqual(startAttempting.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(startEntered.wait(timeout: .now() + 0.05), .timedOut,
                       "start admission entered while close still owned callLock")

        releaseClose.signal()
        XCTAssertEqual(closeFinished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(startEntered.wait(timeout: .now() + 1), .success)
    }

    func testDeferredStateCallbackReturnsBeforeBlockedCoreQuery() {
        let queue = DispatchQueue(label: "citizensdk.test.deferred-event")
        let gate = CitizenSDKDeferredEventGate(queue: queue)
        let simulatedCallLock = NSLock()
        let claimed = expectation(description: "deferred query claimed")
        let completed = expectation(description: "deferred query completed")
        let drained = expectation(description: "deferred delivery drained")
        let claimedRelay = CitizenSDKExpectationRelay(claimed)
        let completedRelay = CitizenSDKExpectationRelay(completed)
        let drainedRelay = CitizenSDKExpectationRelay(drained)
        simulatedCallLock.lock()

        XCTAssertTrue(gate.enqueue {
            claimedRelay.fulfill()
            simulatedCallLock.lock()
            simulatedCallLock.unlock()
            completedRelay.fulfill()
        })
        // The serial fence runs after the gate wrapper's `defer`, not merely
        // after the test work signals `completed`.
        queue.async { drainedRelay.fulfill() }
        wait(for: [claimed], timeout: 1)
        XCTAssertEqual(gate.snapshot, .init(accepting: true, pending: 1, active: 1))
        XCTAssertFalse(gate.beginTeardownIfNoActiveDelivery())

        simulatedCallLock.unlock()
        wait(for: [completed, drained], timeout: 1)
        XCTAssertEqual(gate.snapshot, .init(accepting: true, pending: 0, active: 0))
        XCTAssertTrue(gate.beginTeardownIfNoActiveDelivery())
    }

    func testTeardownSuppressesQueuedAndFutureStateQueriesWithoutUnderflow() {
        let queue = DispatchQueue(label: "citizensdk.test.suppressed-event")
        queue.suspend()
        let gate = CitizenSDKDeferredEventGate(queue: queue)
        let queried = CitizenSDKLockedFlag()
        let drained = expectation(description: "deferred queue drained")
        let drainedRelay = CitizenSDKExpectationRelay(drained)

        XCTAssertTrue(gate.enqueue { queried.set() })
        XCTAssertEqual(gate.snapshot, .init(accepting: true, pending: 1, active: 0))
        XCTAssertTrue(gate.beginTeardownIfNoActiveDelivery())
        XCTAssertFalse(gate.enqueue { queried.set() })
        queue.async { drainedRelay.fulfill() }
        queue.resume()
        wait(for: [drained], timeout: 1)

        XCTAssertFalse(queried.get())
        XCTAssertEqual(gate.snapshot, .init(accepting: false, pending: 0, active: 0))
        XCTAssertTrue(gate.beginTeardownIfNoActiveDelivery())
    }
}
