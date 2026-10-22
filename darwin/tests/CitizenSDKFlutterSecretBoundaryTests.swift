import Foundation
import XCTest
@testable import CitizenSDK
@testable import CitizenSDKFlutter
final class CitizenSDKFlutterSecretBoundaryTests:XCTestCase {
 func testFailureEnvelopeContainsOnlyStablePublicFields(){let error=CitizenSdkFlutterCodec.error(.authenticationCancelled,"Cancelled",session:"sdk",sequence:1,method:"openPrivateKey");XCTAssertEqual(error.count,7);XCTAssertEqual(error[3] as? Int64,10);XCTAssertEqual(error[4] as? Int64,3);XCTAssertEqual(error[5] as? String,"openPrivateKey")}
 func testResourceIdentifiersDoNotAcceptPointersOrPayloads(){for value:Any in [1,Data(repeating:1,count:32),["handle":1]]{XCTAssertThrowsError(try CitizenSdkFlutterCodec.decode(method:"revealPrivateKey",arguments:[2,"sdk",1,value]))}}
}
