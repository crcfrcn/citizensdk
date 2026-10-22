package org.citizen.sdk.internal
import org.junit.Assert.*
import org.junit.Test
class CitizenSdkRecordKeyTest {
    @Test fun hardwareAliasPreservesPlatformIdentity() {
        val generation = ByteArray(16) { 1 }
        val expected = java.security.MessageDigest.getInstance("SHA-256").digest(("v1:-1:" + "01".repeat(16)).toByteArray(Charsets.US_ASCII)).joinToString("") { "%02x".format(it.toInt() and 255) }
        assertEquals("citizensdk_wallet_" + expected, CitizenSdkRecordKey.hardwareAlias(-1, generation))
        assertNotEquals(CitizenSdkRecordKey.hardwareAlias(0, generation), CitizenSdkRecordKey.hardwareAlias(1, generation))
        assertTrue(runCatching { CitizenSdkRecordKey.hardwareAlias(0, ByteArray(15)) }.isFailure)
    }
}
