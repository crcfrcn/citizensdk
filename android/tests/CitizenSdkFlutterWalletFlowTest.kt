package org.citizen.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletableFuture

/** 仅验证真实无UI绑定；显式输入有界，旧Activity合同必须拒绝。 */
class CitizenSdkFlutterWalletFlowTest {
    @Test
    fun explicitInputsAndAtomicAppendHaveOneOwnedRequest() {
        for (count in listOf(12, 18, 24)) {
            val request = CitizenSdkFlutterCodec.decode("prepareWalletCreation", listOf(2, "s", 1L, count, ""))
                as CitizenSdkFlutterCodec.Request.WalletInput
            assertEquals(count, request.wordCount)
            assertTrue(request.indices.isEmpty())
        }
        val input = CitizenSdkFlutterCodec.decode("addWalletAccounts", listOf(2, "s", 2L, "synthetic", "", listOf(2, 7)))
            as CitizenSdkFlutterCodec.Request.WalletInput
        assertEquals(listOf(2, 7), input.indices.toList())
        assertTrue(!input.toString().contains("synthetic"))
        val next = CitizenSdkFlutterCodec.decode("addNextWalletAccount", listOf(2, "s", 3L, "synthetic", ""))
            as CitizenSdkFlutterCodec.Request.WalletInput
        assertTrue(next.indices.isEmpty())
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("addNextWalletAccount", listOf(2, "s", 3L, "synthetic", "", 9))
        }
    }

    @Test
    fun removedWindowsAndInjectedPresentationNeverReturn() {
        for (method in listOf("initializeWallet", "createWallet", "importColdAccountWithUi", "viewAccountPrivateKey", "qrScan")) {
            assertTrue(method !in CitizenSdkFlutterCodec.methods)
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode(method, listOf(2, "s", 1L))
            }
        }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("prepareWalletCreation", listOf(2, "s", 1L, 18, "", "界面文案"))
        }
    }

    @Test
    fun closeWaitsForRealStopAndFailureNeverDisposes() {
        val stop = CompletableFuture<Void>()
        var closed = 0
        val result = citizenSdkFlutterCloseLifecycle(CitizenSdkLifecycle.RUNNING, { stop }, { closed++ })
        assertTrue(!result.isDone); assertEquals(0, closed)
        stop.completeExceptionally(IllegalStateException("synthetic failure"))
        assertTrue(result.isCompletedExceptionally); assertEquals(0, closed)
        citizenSdkFlutterCloseLifecycle(CitizenSdkLifecycle.STOPPED,
            { throw AssertionError("重复stop") }, { closed++ }).join()
        assertEquals(1, closed)
    }
}
