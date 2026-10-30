package org.citizen.sdk
import org.citizen.sdk.internal.CitizenSdkRequestRouter
import org.citizen.sdk.internal.CoreResult
import org.junit.Assert.*
import org.junit.Test
class CitizenSdkWalletFlowCancellationTest {
 @Test fun cancellationWaitsForActualCoreTerminal(){
  val cancelled=mutableListOf<Long>();var released=0
  val router=CitizenSdkRequestRouter{cancelled+=it;true}
  val operation=router.submitOperation({71L}){check(it.value===Unit);Unit}
  assertEquals("71",operation.operationId);assertTrue(operation.cancel());assertEquals(listOf(71L),cancelled);assertFalse(operation.future.isDone)
  assertFalse(router.cancel("071"));assertThrows(CitizenSdkException::class.java){router.requireIdle()}
  router.onCompletion(71,Result.success(CoreResult(9,Unit){keep->assertFalse(keep);released++}))
  operation.future.join();assertEquals(1,released);assertFalse(operation.cancel());router.requireIdle();router.close()
 }
 @Test fun onlyActualCoreCancellationCompletesAsCancelled(){
  val router=CitizenSdkRequestRouter{true};val operation=router.submitOperation({72L}){Unit}
  router.onCompletion(72,Result.failure(CitizenSdkException(CitizenSdkErrorCode.CANCELLED,"cancelled")))
  assertTrue(operation.future.isCompletedExceptionally);router.requireIdle();router.close()
 }
 @Test fun earlyTerminalKeepsActualCReferenceUntilAdmissionReturns(){
  var released=0;val router=CitizenSdkRequestRouter{false}
  val operation=router.submitOperation({router.onCompletion(73,Result.success(CoreResult(10,Unit){released++}));assertEquals(0,released);73L}){it.value}
  assertEquals("73",operation.operationId);assertEquals(Unit,operation.future.join());assertEquals(1,released);router.requireIdle();router.close()
 }
 @Test fun discardedAndFailedConsumerReleaseExactlyOneCReference(){
  var released=0;val router=CitizenSdkRequestRouter{false}
  val cancelled=router.submitOperation({74L}){error("cancelled consumer decoded")};cancelled.future.cancel(false)
  router.onCompletion(74,Result.success(CoreResult(11,Unit){released++}));assertEquals(1,released)
  val failed=router.submitOperation({75L}){error("decode rejected")};router.onCompletion(75,Result.success(CoreResult(12,Unit){released++}));assertTrue(failed.future.isCompletedExceptionally);assertEquals(2,released)
  router.onCompletion(999,Result.success(CoreResult(13,Unit){released++}));assertEquals(3,released);router.requireIdle();router.close()
 }
}
