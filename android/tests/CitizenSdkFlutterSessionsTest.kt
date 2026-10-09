package org.citizen.sdk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException

class CitizenSdkFlutterSessionsTest {
    @Test
    fun surfaceTexturePreviewCompensatesOnlyRemainingRotationAndKeepsAspectRatio() {
        // 后置传感器90度：已由纹理转正，竖屏不能再旋转；横屏仅补显示方向。
        val expected = listOf(
            CitizenQrPreview(480, 640, 0), CitizenQrPreview(480, 640, 270),
            CitizenQrPreview(480, 640, 180), CitizenQrPreview(480, 640, 90),
        )
        for ((target, sensorToTarget) in listOf(90, 0, 270, 180).withIndex()) {
            assertEquals(expected[target], CitizenQrPreview.fromSurfaceTexture(640, 480, sensorToTarget, target, true))
        }
        // 前置270度与自然横屏设备同样只扣除已有旋转；不额外加入镜像。
        assertEquals(CitizenQrPreview(480, 640, 0), CitizenQrPreview.fromSurfaceTexture(640, 480, 270, 0, true))
        assertEquals(CitizenQrPreview(640, 480, 0), CitizenQrPreview.fromSurfaceTexture(640, 480, 0, 0, true))
        assertEquals(CitizenQrPreview(640, 480, 270), CitizenQrPreview.fromSurfaceTexture(640, 480, 270, 1, true))
        // Surface不含camera transform时，完整角度由宿主应用，宽高不能提前互换。
        for (rotation in listOf(0, 90, 180, 270)) {
            assertEquals(CitizenQrPreview(640, 480, rotation), CitizenQrPreview.fromSurfaceTexture(640, 480, rotation, 0, false))
        }
    }

    @Test
    fun surfaceTexturePreviewRejectsInvalidDimensionsAndRotations() {
        // 拒绝畸形元数据，不能取模吞掉错误后显示错误画面。
        for (input in listOf(listOf(0, 480, 90, 0), listOf(640, -1, 90, 0),
            listOf(640, 480, 45, 0), listOf(640, 480, 360, 0),
            listOf(640, 480, -90, 0), listOf(640, 480, 90, -1), listOf(640, 480, 90, 4))) {
            assertEquals(CitizenSdkErrorCode.INTEGRITY, assertThrows(CitizenSdkException::class.java) {
                CitizenQrPreview.fromSurfaceTexture(input[0], input[1], input[2], input[3], true)
            }.code)
        }
    }

    @Test
    fun `open exposes only bounded single-line host invariant`() {
        assertEquals("Core returned reserved request ID 0", citizenSdkFlutterOpenInvalidState("Core returned reserved request ID 0"))
        for (value in listOf<String?>(null, "", "line\nbreak", "x".repeat(513))) {
            assertEquals(
                "CitizenSDK operation is invalid in the current state",
                citizenSdkFlutterOpenInvalidState(value),
            )
        }
        assertEquals(
            "IllegalArgumentException: host fixture",
            citizenSdkFlutterOpenHostFailure(IllegalArgumentException("host fixture")),
        )
    }

    @Test
    fun `verification projection needs no context session activity or event subscription`() {
        // 独立验签也使用唯一v2通道；旧版本必须拒绝，不能用旧夹具恢复兼容入口。
        val request = CitizenSdkFlutterCodec.decode("verifySignature",
            listOf(2, "0x" + "11".repeat(32), ByteArray(64), byteArrayOf())) as CitizenSdkFlutterCodec.Request.VerifySignature
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("verifySignature",
                listOf(1, "0x" + "11".repeat(32), ByteArray(64), byteArrayOf()))
        }
        var calls = 0
        // 只替换密码学叶节点；生产使用同一静态分派，测试无需构造任何 Android 宿主。
        repeat(2) {
            val response = CitizenSdkFlutterSessions.verifySignature(request) { account, signature, payload ->
                calls++
                assertEquals(32, account.size)
                assertEquals(64, signature.size)
                assertTrue(payload.isEmpty())
                false
            }
            assertEquals(listOf(2, false), response)
        }
        assertEquals(2, calls)
        assertThrows(CitizenSdkException::class.java) {
            CitizenSdkFlutterSessions.verifySignature(request) { _, _, _ ->
                throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "fixture")
            }
        }
    }

    @Test
    fun envelopeSurvivesInvalidParametersAndNeverInspectsSecrets() {
        // 这里只验证平台外壳投影，序号重复/跳号/实例隔离由唯一Rust接纳测试验证。
        val envelope = CitizenSdkFlutterCodec.envelope("getStorageKeysPaged", listOf(2, "synthetic", 1, Any()))
        assertEquals("synthetic", envelope?.sessionId)
        assertEquals(1L, envelope?.requestSequence)
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("getStorageKeysPaged", listOf(2, "synthetic", 1, Any()))
        }
        assertEquals(2L, CitizenSdkFlutterCodec.envelope("getSyncStatus", listOf(2, "synthetic", 2))?.requestSequence)
        assertNull(CitizenSdkFlutterCodec.envelope("verifySignature", null))
        for (bad in listOf(listOf(1, "synthetic", 1), listOf(2, "synthetic", 0), listOf(2))) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.envelope("getSyncStatus", bad)
            }
        }
    }

    @Test
    fun boundedDiagnosticsRejectUnlistedMethodsDeduplicateAndCapEachInstance() {
        val lines = mutableListOf<String>()
        val diagnostic = CitizenSdkFlutterDiagnostics(lines::add)
        diagnostic.record("importWallet", CitizenSdkFlutterDiagnostics.Phase.BEGIN)
        diagnostic.record("untrusted\nmethod", CitizenSdkFlutterDiagnostics.Phase.BEGIN)
        assertTrue(lines.isEmpty())
        repeat(100) {
            diagnostic.record("getSyncStatus", CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
                elapsedNanos = Long.MAX_VALUE, sync = CitizenSdkFlutterDiagnostics.Sync.USABLE)
        }
        assertEquals(1, lines.size)
        assertTrue(lines.single().endsWith("elapsed_ms=86400000"))
        for (code in CitizenSdkErrorCode.entries) {
            diagnostic.record("getSyncStatus", CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
                code, CitizenSdkFailureStage.fromErrorCode(code), elapsedNanos = -1)
        }
        assertEquals(8, lines.size)
        assertTrue(lines.all { it.length < 256 && !it.contains('\n') })
        diagnostic.record("start", CitizenSdkFlutterDiagnostics.Phase.BEGIN)
        assertEquals(9, lines.size)
        CitizenSdkFlutterDiagnostics(lines::add).record("getSyncStatus", CitizenSdkFlutterDiagnostics.Phase.BEGIN)
        assertEquals(10, lines.size)
        // 系统日志失败也不能让诊断反向改变原请求控制流。
        CitizenSdkFlutterDiagnostics { throw IllegalStateException("synthetic sink failure") }
            .record("open", CitizenSdkFlutterDiagnostics.Phase.BEGIN)
    }

    @Test
    fun startPanicStepUsesOnlyTheFixedClosedSet() {
        val expected = listOf("RESTORE", "BEGIN", "PUBLISH_BEGIN", "PROVIDER_START",
            "REFRESH", "COMPLETE", "SERVICES", "PUBLISH_COMPLETE")
        for (name in expected) {
            assertEquals(name, citizenSdkFlutterStartStep(CitizenSdkErrorCode.PANIC,
                "CitizenSDK start panicked at $name").name)
        }
        assertEquals(CitizenSdkFlutterDiagnostics.StartStep.NONE,
            citizenSdkFlutterStartStep(CitizenSdkErrorCode.NETWORK, "CitizenSDK start panicked at RESTORE"))
        assertEquals(CitizenSdkFlutterDiagnostics.StartStep.NONE,
            citizenSdkFlutterStartStep(CitizenSdkErrorCode.PANIC, "CitizenSDK start panicked at RESTORE\nprivate"))
        assertEquals(CitizenSdkFlutterDiagnostics.StartStep.NONE,
            citizenSdkFlutterStartStep(CitizenSdkErrorCode.PANIC, "arbitrary panic text"))

        val lines = mutableListOf<String>()
        CitizenSdkFlutterDiagnostics(lines::add).record("start", CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
            CitizenSdkErrorCode.PANIC, CitizenSdkFailureStage.TEARDOWN,
            startStep = CitizenSdkFlutterDiagnostics.StartStep.PROVIDER_START)
        assertEquals(1, lines.size)
        assertTrue(lines.single().contains("start_step=PROVIDER_START"))
        assertTrue(lines.single().length < 256)
    }

    @Test
    fun `queued event token cannot cross cancel and relisten generation`() {
        val gate = CitizenSdkFlutterSubscriptionGate<Any>()
        val firstSink = Any()
        val first = checkNotNull(gate.open(firstSink))
        assertTrue(gate.owns(first))
        assertNull(gate.open(Any()))

        gate.close()
        val secondSink = Any()
        val second = checkNotNull(gate.open(secondSink))
        assertFalse(gate.owns(first))
        assertTrue(gate.owns(second))
    }

    @Test
    fun `supervised close stops only a running provider`() {
        assertEquals(
            CitizenSdkFlutterCloseAction.STOP_THEN_CLOSE,
            citizenSdkFlutterCloseAction(CitizenSdkLifecycle.RUNNING),
        )
        for (lifecycle in listOf(
            CitizenSdkLifecycle.CREATED,
            CitizenSdkLifecycle.STOPPED,
            CitizenSdkLifecycle.START_FAILED,
            CitizenSdkLifecycle.DISPOSED,
        )) {
            assertEquals(CitizenSdkFlutterCloseAction.CLOSE, citizenSdkFlutterCloseAction(lifecycle))
        }
        for (lifecycle in listOf(
            CitizenSdkLifecycle.STARTING,
            CitizenSdkLifecycle.IMPORTING_STATE,
        )) {
            assertEquals(
                CitizenSdkFlutterCloseAction.REJECT_UNSTABLE,
                citizenSdkFlutterCloseAction(lifecycle),
            )
        }
    }

    @Test
    fun `running close checkpoints before dispose and stop failure never disposes`() {
        val stop = CompletableFuture<Void>()
        var disposeCount = 0
        val close = citizenSdkFlutterCloseLifecycle(
            CitizenSdkLifecycle.RUNNING,
            { stop },
            { disposeCount++ },
        )
        assertFalse(close.isDone)
        assertEquals(0, disposeCount)

        stop.complete(null)
        assertTrue(close.isDone)
        assertFalse(close.isCompletedExceptionally)
        assertEquals(1, disposeCount)

        var failedDisposeCount = 0
        val failed = citizenSdkFlutterCloseLifecycle(
            CitizenSdkLifecycle.RUNNING,
            { failedFuture(IllegalStateException("checkpoint failed")) },
            { failedDisposeCount++ },
        )
        assertTrue(failed.isCompletedExceptionally)
        assertEquals(0, failedDisposeCount)
    }

    @Test
    fun asynchronousStopRejectionPreservesTheNativeErrorWithoutRetryOrDispose() {
        // 调用真实关闭组合器，只替换原生停止结果；BUSY与其他失败不得被吞掉或触发销毁。
        for (code in listOf(CitizenSdkErrorCode.BUSY, CitizenSdkErrorCode.INVALID_STATE)) {
            val stop = CompletableFuture<Void>()
            val failure = CitizenSdkException(code, "synthetic stop rejection")
            var stopCalls = 0
            var disposeCalls = 0
            var completions = 0
            val close = citizenSdkFlutterCloseLifecycle(
                CitizenSdkLifecycle.RUNNING,
                { stopCalls++; stop },
                { disposeCalls++ },
            )
            close.whenComplete { _, _ -> completions++ }
            assertEquals(1, stopCalls)
            assertFalse(close.isDone)
            assertTrue(stop.completeExceptionally(failure))
            // 迟到成功不得把原生拒绝改写成成功，也不能重复交付终态。
            assertFalse(stop.complete(null))
            val error = assertThrows(CompletionException::class.java) { close.join() }
            assertSame(failure, error.cause)
            assertEquals(1, stopCalls)
            assertEquals(1, completions)
            assertEquals(0, disposeCalls)
        }
    }

    @Test
    fun synchronousStopBusyIsReturnedWithoutRetryOrDispose() {
        // 原生接纳前的同步拒绝同样保持原错误；不能靠关闭或重试掩盖并发冲突。
        val failure = CitizenSdkException(CitizenSdkErrorCode.BUSY, "synthetic admission rejection")
        var stopCalls = 0
        var disposeCalls = 0
        val actual = assertThrows(CitizenSdkException::class.java) {
            citizenSdkFlutterCloseLifecycle(
                CitizenSdkLifecycle.RUNNING,
                { stopCalls++; throw failure },
                { disposeCalls++ },
            )
        }
        assertSame(failure, actual)
        assertEquals(1, stopCalls)
        assertEquals(0, disposeCalls)
    }

    @Test
    fun `start failed disposes without stop while unstable lifecycle fails closed`() {
        var stopCount = 0
        var disposeCount = 0
        val startFailed = citizenSdkFlutterCloseLifecycle(
            CitizenSdkLifecycle.START_FAILED,
            { stopCount++; CompletableFuture.completedFuture(null) },
            { disposeCount++ },
        )
        assertTrue(startFailed.isDone)
        assertEquals(0, stopCount)
        assertEquals(1, disposeCount)

        val unstable = citizenSdkFlutterCloseLifecycle(
            CitizenSdkLifecycle.STARTING,
            { stopCount++; CompletableFuture.completedFuture(null) },
            { disposeCount++ },
        )
        assertTrue(unstable.isCompletedExceptionally)
        assertEquals(0, stopCount)
        assertEquals(1, disposeCount)
    }

    @Test
    fun `process orphan supervisor retains detach ownership and retries a failed close`() {
        val scheduled = ArrayDeque<() -> Unit>()
        var closeAttempts = 0
        val supervisor = CitizenSdkFlutterOrphanSupervisor<String>(
            scheduler = CitizenSdkFlutterRetryScheduler { _, task -> scheduled.addLast(task) },
            close = {
                closeAttempts++
                if (closeAttempts == 1) failedFuture(IllegalStateException("stop failed"))
                else CompletableFuture.completedFuture(null)
            },
        )

        supervisor.supervise("detached-registry")
        assertEquals(1, supervisor.sizeForTest())
        assertEquals(1, supervisor.failuresForTest("detached-registry"))
        assertEquals(1, scheduled.size)

        scheduled.removeFirst().invoke()
        assertEquals(2, closeAttempts)
        assertEquals(0, supervisor.sizeForTest())
        assertNull(supervisor.failuresForTest("detached-registry"))
    }

    @Test
    fun `repeated detach close failures remain supervised without a destroy fallback`() {
        val scheduled = ArrayDeque<() -> Unit>()
        var supervisedCloseAttempts = 0
        val supervisor = CitizenSdkFlutterOrphanSupervisor<String>(
            scheduler = CitizenSdkFlutterRetryScheduler { _, task -> scheduled.addLast(task) },
            close = {
                supervisedCloseAttempts++
                failedFuture(IllegalStateException("checkpoint unavailable"))
            },
        )

        supervisor.supervise("detached-registry")
        repeat(4) { scheduled.removeFirst().invoke() }

        assertEquals(5, supervisedCloseAttempts)
        assertEquals(1, supervisor.sizeForTest())
        assertEquals(5, supervisor.failuresForTest("detached-registry"))
        assertEquals(1, scheduled.size)
        assertEquals(250L, CitizenSdkFlutterOrphanSupervisor.retryDelayMillis(1))
        assertEquals(30_000L, CitizenSdkFlutterOrphanSupervisor.retryDelayMillis(128))
    }

    @Test
    fun `accepted work settlement is bounded without completing or destroying the work`() {
        val scheduled = ArrayDeque<() -> Unit>()
        val pending = CompletableFuture<Void>()
        val settlement = citizenSdkFlutterSettleWithin(
            listOf(pending),
            CitizenSdkFlutterSessions.CLOSE_SETTLEMENT_TIMEOUT_MILLIS,
            CitizenSdkFlutterRetryScheduler { _, task -> scheduled.addLast(task) },
        )

        assertFalse(settlement.isDone)
        assertFalse(pending.isDone)
        scheduled.removeFirst().invoke()
        assertTrue(settlement.isCompletedExceptionally)
        assertFalse(pending.isDone)
    }

    @Test
    fun `accepted work failure still counts as settled before lifecycle close`() {
        val scheduled = ArrayDeque<() -> Unit>()
        val failed = failedFuture<Void>(IllegalStateException("operation failed"))
        val settlement = citizenSdkFlutterSettleWithin(
            listOf(failed),
            CitizenSdkFlutterSessions.CLOSE_SETTLEMENT_TIMEOUT_MILLIS,
            CitizenSdkFlutterRetryScheduler { _, task -> scheduled.addLast(task) },
        )

        assertTrue(settlement.isDone)
        assertFalse(settlement.isCompletedExceptionally)
    }

    private fun <T> failedFuture(error: Throwable): CompletableFuture<T> =
        CompletableFuture<T>().also { it.completeExceptionally(error) }
}
