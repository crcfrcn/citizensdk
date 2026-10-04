package org.citizen.sdk.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class CitizenSdkRecordKeyTest {
    @Test
    fun `secret key binds every SecretRef field`() {
        val generation = ByteArray(16) { 1 }
        val owner = ByteArray(16) { 2 }
        val account = ByteArray(32) { 3 }
        val baseline = CitizenSdkRecordKey.secret(0, 1, generation, owner, account)
        assertEquals(baseline, CitizenSdkRecordKey.secret(0, 1, generation, owner, account))
        assertNotEquals(baseline, CitizenSdkRecordKey.secret(0, 1, generation, ByteArray(16) { 4 }, account))
        assertNotEquals(baseline, CitizenSdkRecordKey.secret(0, 1, generation, owner, ByteArray(32) { 5 }))
    }
}

