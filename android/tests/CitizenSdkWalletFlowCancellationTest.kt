package org.citizen.sdk

import org.citizen.sdk.internal.CitizenSdkRequestRouter
import org.citizen.sdk.internal.CitizenSdkNativeCodec
import org.citizen.sdk.internal.CitizenSdkNativeResult
import org.junit.Assert.*
import org.junit.Test

/** 真实请求路由的有限接缝；取消接纳不能替代Core真实终态。 */
class CitizenSdkWalletFlowCancellationTest {
    @Test
    fun acceptedCancellationWaitsForRealCompletionAndSuccessfulMutationIsNotRewritten() {
        val cancelled = mutableListOf<Long>()
        val router = CitizenSdkRequestRouter({ cancelled += it; true })
        val operation = router.submitOperation({ 71 }, { check(it is CitizenSdkNativeResult.Empty); Unit })
        assertTrue(operation.cancel()); assertEquals(listOf(71L), cancelled)
        assertFalse(operation.future.isDone)
        assertThrows(CitizenSdkException::class.java) { router.requireIdle() }
        router.onCompletion(71, CitizenSdkNativeCodec.Decoded(CitizenSdkNativeResult.Empty, null))
        operation.future.join()
        assertFalse(operation.cancel())
        router.requireIdle(); router.close()
    }

    @Test
    fun coreCancellationRemainsTheOnlyCancelledOutcome() {
        val router = CitizenSdkRequestRouter({ true })
        val operation = router.submitOperation({ 72 }, { Unit })
        router.onCompletion(72, CitizenSdkNativeCodec.Decoded(null, CitizenSdkException(CitizenSdkErrorCode.CANCELLED, "synthetic cancellation")))
        assertTrue(operation.future.isCompletedExceptionally)
        router.requireIdle(); router.close()
    }
}
