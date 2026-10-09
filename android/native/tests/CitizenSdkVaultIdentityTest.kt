package org.citizen.sdk.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CitizenSdkVaultIdentityTest {
    @Test
    fun `alias is CitizenSDK scoped and generation exact`() {
        val first = CitizenSdkRecordKey.hardwareAlias(0, ByteArray(16) { 1 })
        assertTrue(first.startsWith("citizensdk_wallet_"))
        assertEquals(first, CitizenSdkRecordKey.hardwareAlias(0, ByteArray(16) { 1 }))
        assertNotEquals(first, CitizenSdkRecordKey.hardwareAlias(0, ByteArray(16) { 2 }))
    }
}

