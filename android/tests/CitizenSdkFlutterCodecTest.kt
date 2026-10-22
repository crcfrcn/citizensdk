package org.citizen.sdk
import org.junit.Assert.*
import org.junit.Test
class CitizenSdkFlutterCodecTest {
 @Test fun resourcesUseExactShapes(){
  assertEquals(32,(CitizenSdkFlutterCodec.decode("open",listOf(2,32,false)) as CitizenSdkFlutterCodec.Request.Open).modules)
  val request=CitizenSdkFlutterCodec.decode("openPrivateKey",listOf(2,"sdk",1L,"0x"+"01".repeat(32))) as CitizenSdkFlutterCodec.Request.Account
  assertEquals("sdk",request.sessionId);assertArrayEquals(ByteArray(32){1},request.accountId)
  for(method in listOf("close","readDiagnostics"))CitizenSdkFlutterCodec.decode(method,listOf(2,"sdk",2L))
 }
 @Test fun resourceBoundaryRejectsWrongTypesAndBusinessRequests(){
  for(args in listOf(listOf(2,"sdk",true),listOf(2,"sdk",0L),listOf(2,"sdk",1.5)))assertTrue(runCatching{CitizenSdkFlutterCodec.decode("close",args)}.isFailure)
  assertTrue(runCatching{CitizenSdkFlutterCodec.decode("openPrivateKey",listOf(2,"sdk",1L,17))}.isFailure)
  assertTrue(runCatching{CitizenSdkFlutterCodec.decode("openQrCapture",listOf(2,"sdk",1L,6))}.isFailure)
  val error=runCatching{CitizenSdkFlutterCodec.decode("getWalletState",listOf(2,"sdk",1L))}.exceptionOrNull()
  assertEquals(4,(error as CitizenSdkFlutterCodec.ContractFailure).errorCode)
 }
}
