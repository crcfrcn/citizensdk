package org.citizen.sdk.internal

import org.citizen.sdk.CitizenSdkErrorCode
import org.citizen.sdk.CitizenSdkException
import org.citizen.sdk.CitizenSdkFailureStage
import org.citizen.sdk.CitizenSdkClosePolicy
import org.citizen.sdk.CitizenSdkLifecycle
import org.citizen.sdk.CitizenAccountBalance
import org.citizen.sdk.CitizenBlockRef
import org.citizen.sdk.CitizenFinality
import org.citizen.sdk.CitizenU128
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

class CitizenSdkHostOperationTest {




    @Test
    fun cameraLuminanceUsesActualStridePositionAndRejectsOverflowBeforeAllocation() {
        val source = ByteBuffer.wrap(byteArrayOf(99, 1, 8, 2, 8, 3, 8, 4))
        source.position(1)
        val pixels = org.citizen.sdk.CitizenSdkQrLuminance.copy(source, 2, 2, 4, 2)
        assertEquals(listOf<Byte>(1, 2, 3, 4), pixels.toList())
        assertEquals(1, source.position())
        pixels[0] = 7
        assertEquals(1.toByte(), source.get(1))
        for (fields in listOf(intArrayOf(0, 2, 4, 2), intArrayOf(4097, 1, Int.MAX_VALUE, 1),
            intArrayOf(2, 2, -1, 2), intArrayOf(2, 2, 4, 0), intArrayOf(4096, 4096, -1, Int.MAX_VALUE),
            intArrayOf(2, 2, Int.MAX_VALUE, Int.MAX_VALUE), intArrayOf(2, 3, 4, 2))) {
            assertThrows(CitizenSdkException::class.java) {
                org.citizen.sdk.CitizenSdkQrLuminance.copy(source, fields[0], fields[1], fields[2], fields[3])
            }
        }
    }











    @Test
    fun `close barrier allows callback reentry to fail immediately without holding admission lock`() {
        val calls = CitizenSdkCalls()
        val destroyEntered = CountDownLatch(1)
        val callbackReturned = CountDownLatch(1)
        val closeFinished = CountDownLatch(1)
        val closer = thread {
            calls.close {
                destroyEntered.countDown()
                assertTrue(callbackReturned.await(2, TimeUnit.SECONDS))
            }
            closeFinished.countDown()
        }
        assertTrue(destroyEntered.await(2, TimeUnit.SECONDS))
        assertThrows(IllegalStateException::class.java) { calls.call { error("entered closing bridge") } }
        assertEquals(CitizenSdkErrorCode.BUSY, assertThrows(CitizenSdkException::class.java) {
            calls.close { error("destroyed twice") }
        }.code)
        callbackReturned.countDown()
        assertTrue(closeFinished.await(2, TimeUnit.SECONDS))
        closer.join()
        calls.close { error("destroyed after successful close") }
    }

    @Test
    fun `native lease prevents destruction and failed teardown is retry only`() {
        val calls = CitizenSdkCalls()
        calls.call {
            assertEquals(CitizenSdkErrorCode.BUSY, assertThrows(CitizenSdkException::class.java) {
                calls.close { error("destroyed a leased bridge") }
            }.code)
        }
        var attempts = 0
        assertThrows(IllegalStateException::class.java) {
            calls.close { attempts += 1; error("injected teardown failure") }
        }
        assertFalse(calls.isClosed())
        assertThrows(IllegalStateException::class.java) { calls.call { error("reopened partially destroyed bridge") } }
        calls.close { attempts += 1 }
        assertEquals(2, attempts)
        assertTrue(calls.isClosed())
    }

    @Test
    fun `terminal vault ownership wipes error output and never touches borrowed buffer twice`() {
        val output = ByteBuffer.allocateDirect(32)
        repeat(32) { output.put(it, 9) }
        val wrapped = ByteArray(16) { 7 }
        var completions = 0
        val operation = CitizenSdkVaultOperation(output, wrapped) { code ->
            assertEquals(CitizenSdkErrorCode.AUTHENTICATION_CANCELLED.value, code)
            assertTrue((0 until 32).all { output.get(it) == 0.toByte() })
            assertTrue(wrapped.all { it == 0.toByte() })
            completions += 1
        }
        operation.finish { CitizenSdkErrorCode.AUTHENTICATION_CANCELLED }
        // 模拟 completion 后 Rust 已回收并复用该区域，迟到 callback 不得再写。
        output.put(0, 42)
        operation.finish { output.put(0, 99); CitizenSdkErrorCode.OK }
        assertEquals(42.toByte(), output.get(0))
        assertEquals(1, completions)
    }

    @Test
    fun `concurrent vault terminal callbacks execute only one cipher operation`() {
        val output = ByteBuffer.allocateDirect(32)
        val ready = CountDownLatch(1)
        val release = CountDownLatch(1)
        val operation = CitizenSdkVaultOperation(output, ByteArray(1)) { }
        var executions = 0
        val winner = thread {
            operation.finish {
                executions += 1
                ready.countDown()
                assertTrue(release.await(2, TimeUnit.SECONDS))
                CitizenSdkErrorCode.OK
            }
        }
        assertTrue(ready.await(2, TimeUnit.SECONDS))
        val loser = thread { operation.finish { executions += 1; CitizenSdkErrorCode.INTERNAL } }
        release.countDown()
        winner.join(); loser.join()
        assertEquals(1, executions)
    }

    @Test
    fun `successful vault output survives late error and thrown cipher is wiped`() {
        val output = ByteBuffer.allocateDirect(32)
        val wrapped = ByteArray(8) { 4 }
        var completions = 0
        val success = CitizenSdkVaultOperation(output, wrapped) { code ->
            assertEquals(CitizenSdkErrorCode.OK.value, code)
            assertTrue(wrapped.all { it == 0.toByte() })
            completions += 1
        }
        success.finish {
            repeat(32) { output.put(it, 8) }
            CitizenSdkErrorCode.OK
        }
        success.finish { error("late authentication error reached consumed output") }
        assertEquals(1, completions)
        assertTrue((0 until 32).all { output.get(it) == 8.toByte() })
        val failed = CitizenSdkVaultOperation(output, ByteArray(1)) { code ->
            assertEquals(CitizenSdkErrorCode.INTERNAL.value, code)
            assertTrue((0 until 32).all { output.get(it) == 0.toByte() })
        }
        failed.finish { error("injected cipher failure") }
    }

    @Test
    fun earlyPrivateSettlementCannotBeClaimedByAnotherIdentityOrAfterClose() {
        val receiver = org.citizen.sdk.CitizenSdkPrivateKeyReceiver()
        receiver.settled(9, CitizenSdkErrorCode.NOT_FOUND.value)
        assertThrows(IllegalStateException::class.java) { receiver.bind(10) }
        receiver.bind(9)
        var calls = 0
        receiver.listen { calls++ }
        assertEquals(1, calls)
        receiver.clear()
        receiver.settled(9, CitizenSdkErrorCode.OK.value)
        assertEquals(1, calls)
        assertThrows(IllegalStateException::class.java) { receiver.bind(9) }
    }

    @Test
    fun `wallet secret encoding is bounded before proportional allocation`() {
        CitizenSdkSensitiveBytes.utf8("a".repeat(1024)).use { value ->
            assertEquals(1024, value.size)
        }
        assertEquals(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkSensitiveBytes.utf8("a".repeat(1025))
            }.code,
        )
    }







    @Test
    fun `close policy requires a completed stop checkpoint`() {
        assertEquals(
            CitizenSdkClosePolicy.Decision.DESTROY,
            CitizenSdkClosePolicy.validate(CitizenSdkLifecycle.STOPPED),
        )
        assertEquals(
            CitizenSdkErrorCode.INVALID_STATE,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkClosePolicy.validate(CitizenSdkLifecycle.RUNNING)
            }.code,
        )
        assertEquals(
            CitizenSdkErrorCode.BUSY,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkClosePolicy.validate(CitizenSdkLifecycle.STARTING)
            }.code,
        )
    }




}
