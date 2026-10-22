package org.citizen.sdk

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class CitizenSdkPreparedWalletTest {
    @Test
    fun `accepted commit consumes preparation even if later completion fails`() {
        val ownership = CitizenSdkPreparedOwnership()
        assertEquals(7L, ownership.consume { 7L })
        assertThrows(IllegalStateException::class.java) { ownership.consume { 8L } }
        assertEquals(CitizenSdkPreparedReleaseStatus.TERMINAL, ownership.release {
            error("accepted Core preparation must not be released twice")
        })
    }

    @Test
    fun `recovery release is idempotent and cannot export after close`() {
        val phrase = CitizenSdkRecoveryPhrase.create("synthetic display".toByteArray())
        val copy = phrase.copyBytes()
        assertEquals("synthetic display", copy.toString(Charsets.UTF_8))
        copy.fill(0)
        assertEquals("CitizenSdkRecoveryPhrase(<redacted>)", phrase.toString())
        phrase.close()
        phrase.close()
        assertThrows(IllegalStateException::class.java) { phrase.copyBytes() }
        assertThrows(IllegalStateException::class.java) { phrase.useCharacters { it.remaining() } }
    }

    @Test
    fun `private key receiver rejects foreign repeated and late delivery`() {
        val receiver = CitizenSdkPrivateKeyReceiver()
        receiver.bind(7)
        val bytes = java.nio.ByteBuffer.allocateDirect(32)
        repeat(32) { bytes.put(it.toByte()) }
        bytes.flip()
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, receiver.receive(8, bytes))
        assertEquals(CitizenSdkErrorCode.OK.value, receiver.receive(7, bytes))
        val copy = receiver.copyBytes()
        assertArrayEquals(ByteArray(32) { it.toByte() }, copy)
        copy.fill(0)
        bytes.position(0)
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, receiver.receive(7, bytes))
        receiver.clear()
        assertThrows(IllegalStateException::class.java) { receiver.copyBytes() }
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, receiver.receive(7, bytes))
        bytes.clear()
        repeat(32) { bytes.put(0) }
    }

    @Test
    fun `private key authorization is bound once to the actual host operation`() {
        val receiver = CitizenSdkPrivateKeyReceiver()
        receiver.bind(9)
        val ids = mutableListOf<Long>()
        receiver.bindAuthenticationRegistry { id -> ids += id; CitizenSdkErrorCode.OK.value }
        assertEquals(CitizenSdkErrorCode.INTEGRITY.value, receiver.authorizing(10, 12))
        assertEquals(CitizenSdkErrorCode.OK.value, receiver.authorizing(9, 12))
        assertEquals(listOf(12L), ids)
        assertEquals(12L, receiver.authenticationId())
        assertEquals(CitizenSdkErrorCode.INTEGRITY.value, receiver.authorizing(9, 13))
        receiver.clear()
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, receiver.authorizing(9, 14))
    }

    @Test
    fun `recovery phrase takes ownership and clears caller buffer`() {
        val input = "alpha beta gamma".toByteArray()
        val phrase = CitizenSdkRecoveryPhrase.create(input)
        assertArrayEquals(ByteArray(input.size), input)
        phrase.useCharacters { chars -> assertEquals("alpha beta gamma", chars.toString()) }
        phrase.close()
    }

    @Test
    fun `prepared release failure restores ownership for exact retry`() {
        val ownership = CitizenSdkPreparedOwnership()
        var attempts = 0
        assertThrows(IllegalStateException::class.java) {
            ownership.release {
                attempts += 1
                throw IllegalStateException("release rejected")
            }
        }
        assertFalse(ownership.isConsumed())
        assertEquals(
            CitizenSdkPreparedReleaseStatus.TERMINAL,
            ownership.release { attempts += 1 },
        )
        assertTrue(ownership.isConsumed())
        assertEquals(2, attempts)
        ownership.release { attempts += 1 }
        assertEquals(2, attempts)
    }

    @Test
    fun `concurrent release in progress never clears retry ownership`() {
        val ownership = CitizenSdkPreparedOwnership()
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val first = thread {
            try {
                ownership.release {
                    entered.countDown()
                    resume.await(1, TimeUnit.SECONDS)
                    throw IllegalStateException("release rejected")
                }
            } catch (error: Throwable) {
                failure.set(error)
            }
        }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        assertEquals(
            CitizenSdkPreparedReleaseStatus.IN_PROGRESS,
            ownership.release { error("must not run a concurrent release") },
        )
        resume.countDown()
        first.join()
        assertTrue(failure.get() is IllegalStateException)
        assertFalse(ownership.isConsumed())
        assertEquals(
            CitizenSdkPreparedReleaseStatus.TERMINAL,
            ownership.release { },
        )
    }

    @Test
    fun `release cannot clear owner while commit is still settling`() {
        val ownership = CitizenSdkPreparedOwnership()
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val commit = thread {
            try {
                ownership.consume<Unit> {
                    entered.countDown()
                    resume.await(1, TimeUnit.SECONDS)
                    throw IllegalStateException("commit rejected")
                }
            } catch (error: Throwable) {
                failure.set(error)
            }
        }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        assertEquals(
            CitizenSdkPreparedReleaseStatus.IN_PROGRESS,
            ownership.release { error("must not release during commit") },
        )
        resume.countDown()
        commit.join()
        assertTrue(failure.get() is IllegalStateException)
        assertFalse(ownership.isConsumed())
        assertEquals(
            CitizenSdkPreparedReleaseStatus.TERMINAL,
            ownership.release { },
        )
    }
}
