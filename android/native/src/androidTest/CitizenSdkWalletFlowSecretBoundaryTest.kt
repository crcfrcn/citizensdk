package org.citizen.sdk

import java.nio.ByteBuffer
import org.citizen.sdk.internal.CitizenSdkSensitiveBytes
import org.junit.Assert.*
import org.junit.Test

/** 只检查SDK实际拥有的副本；宿主String/Editable及窗口安全策略属于App。 */
class CitizenSdkWalletFlowSecretBoundaryTest {
    @Test
    fun receiverRevocationRejectsLateDeliveryAndExposesNoDrawingSurface() {
        val receiver = CitizenSdkPrivateKeyReceiver()
        receiver.bind(7)
        val source = ByteBuffer.allocateDirect(32)
        repeat(32) { source.put(it, it.toByte()) }
        assertEquals(CitizenSdkErrorCode.OK.value, receiver.receive(7, source))
        val copy = receiver.copyBytes()
        assertEquals(0, source.position())
        receiver.clear()
        assertThrows(IllegalStateException::class.java) { receiver.copyBytes() }
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, receiver.receive(7, source))
        copy.fill(0)
        repeat(32) { source.put(it, 0) }
    }

    @Test
    fun recoveryReleaseAndInputBoundsUseOriginalSensitiveOwners() {
        val input = "synthetic display".toByteArray()
        val phrase = CitizenSdkRecoveryPhrase.create(input)
        assertTrue(input.all { it == 0.toByte() })
        phrase.useCharacters { assertTrue(it.isReadOnly) }
        phrase.close(); phrase.close()
        assertThrows(IllegalStateException::class.java) { phrase.useCharacters { } }
        CitizenSdkSensitiveBytes.utf8("a".repeat(1024)).use { assertEquals(1024, it.size) }
        assertThrows(CitizenSdkException::class.java) { CitizenSdkSensitiveBytes.utf8("a".repeat(1025)) }
    }
}
