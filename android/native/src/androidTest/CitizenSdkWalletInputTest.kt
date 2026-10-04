package org.citizen.sdk

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test

/** 直接调用真实Core纯校验，不创建/导入钱包，不把App输入编辑规则放回SDK。 */
class CitizenSdkWalletInputTest {
    @Test
    fun actualCoreInputReasonsAndPublicWordListNeedNoSdkUi() {
        val sdk = CitizenSdk.open(ApplicationProvider.getApplicationContext(), modules = CitizenSdkModules.QR)
        try {
            assertEquals(CitizenWalletInputReason.VALID, sdk.validateWalletPassword(byteArrayOf()).reason)
            assertEquals(CitizenWalletInputReason.VALID, sdk.validateWalletPassword("abcdef".toByteArray()).reason)
            assertEquals(CitizenWalletInputReason.PASSWORD_LENGTH, sdk.validateWalletPassword("abcde".toByteArray()).reason)
            assertEquals(CitizenWalletInputReason.INPUT_TOO_LONG, sdk.validateWalletPassword(ByteArray(1025)).reason)
            assertEquals(listOf("abandon"), sdk.walletWordSuggestions("aban".toByteArray()))
            // BIP39公开全零熵向量，只校验，不生成、存储或签名。
            for ((count, checksum) in listOf(12 to "about", 18 to "agent", 24 to "art")) {
                val phrase = (List(count - 1) { "abandon" } + checksum).joinToString(" ").toByteArray()
                try {
                    assertEquals(CitizenWalletInputReason.VALID, sdk.validateWalletMnemonic(phrase, count).reason)
                    assertThrows(IllegalArgumentException::class.java) { sdk.validateWalletMnemonic(phrase, 15) }
                } finally { phrase.fill(0) }
            }
        } finally { sdk.close() }
    }

    @Test
    fun explicitIndicesAreBoundedAndNextIndexIsNotAssignedByUi() {
        CitizenSdkInputLimits.requireAddAccountIndices(intArrayOf(1, 1989))
        for (indices in listOf(intArrayOf(0), intArrayOf(1990), intArrayOf(1, 1), IntArray(1990) { 1 })) {
            assertThrows(CitizenSdkException::class.java) { CitizenSdkInputLimits.requireAddAccountIndices(indices) }
        }
    }
}
