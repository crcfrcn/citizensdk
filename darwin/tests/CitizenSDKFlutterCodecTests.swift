import Foundation
import XCTest
@testable import CitizenSDK
@testable import CitizenSDKFlutter
#if os(iOS)
import Flutter
#else
import FlutterMacOS
#endif
final class CitizenSDKFlutterCodecTests:XCTestCase {
 func testResourceInputsHaveOneExactShape()throws{
  guard case let .open(modules)=try CitizenSdkFlutterCodec.decode(method:"open",arguments:[2,32,false])else{return XCTFail()};XCTAssertEqual(modules,.qr)
  let account="0x"+String(repeating:"01",count:32)
  guard case let .account(_,s,n,bytes)=try CitizenSdkFlutterCodec.decode(method:"openPrivateKey",arguments:[2,"sdk",1,account])else{return XCTFail()};XCTAssertEqual(s,"sdk");XCTAssertEqual(n,1);XCTAssertEqual(bytes,Data(repeating:1,count:32))
  for method in ["close","readDiagnostics"]{_ = try CitizenSdkFlutterCodec.decode(method:method,arguments:[2,"sdk",2])}
  for method in ["revealPrivateKey","closePrivateKey","closeQrCapture","pauseQrCapture","resumeQrCapture"]{_ = try CitizenSdkFlutterCodec.decode(method:method,arguments:[2,"sdk",3,"resource"])}
 }
 func testResourceDecoderRejectsWrongTypesAndBounds(){
  for args:[Any?] in [[2,"sdk",true],[2,"sdk",1.0],[2,"sdk",1.5],[2,"sdk",0]]{XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method:"close",arguments:args))}
  XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method:"openPrivateKey",arguments:[2,"sdk",1,17]))
  XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method:"openQrCapture",arguments:[2,"sdk",1,6]))
  XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method:"setQrCaptureTorch",arguments:[2,"sdk",1,"resource",1]))
  XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method:"revealPrivateKey",arguments:[2,"sdk",1,"resource",Data([1])]))
 }
 func testOrdinaryRequestsAreRejectedAtTheResourceBoundary(){XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method:"getWalletState",arguments:[2,"sdk",1])){XCTAssertEqual(($0 as? CitizenSdkFlutterCodec.ContractFailure)?.code,.unsupported)}}
}
