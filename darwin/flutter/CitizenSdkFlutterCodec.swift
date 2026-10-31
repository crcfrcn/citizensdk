import CoreFoundation
import Foundation
import CitizenSDK
#if os(iOS)
import Flutter
#else
import FlutterMacOS
#endif

/// 只处理平台资源与UI；业务模型由Dart直接读取同一C ABI。
internal enum CitizenSdkFlutterCodec {
 static let methodChannel="citizen/sdk/core/v2",eventChannel="citizen/sdk/events/v2"
 static let version:Int64=2
 static let methods:Set<String>=["open","diagnose","close","readDiagnostics","openPrivateKey","revealPrivateKey","closePrivateKey","respondCredential","cancelCredential","openQrCapture","closeQrCapture","pauseQrCapture","resumeQrCapture","setQrCaptureTorch","qrDecodeImage"]
 static let eventTypes:Set<String>=["qrCaptureResult","qrCaptureError","qrCapturePreview","qrCaptureClosed","privateKeyClosed"]
 enum Request {
  case open(modules:CitizenSDKModules)
  case diagnostic(session:String,row:[Any])
  case empty(method:String,session:String,sequence:Int64)
  case account(method:String,session:String,sequence:Int64,accountID:Data)
  case resource(method:String,session:String,sequence:Int64,id:String)
  case qr(method:String,session:String,sequence:Int64,fields:[Any])
  var sessionID:String?{switch self{case .open:return nil;case let .diagnostic(s,_):return s;case let .empty(_,s,_),let .account(_,s,_,_),let .resource(_,s,_,_),let .qr(_,s,_,_):return s}}
  var sequence:Int64?{switch self{case .open,.diagnostic:return nil;case let .empty(_,_,n),let .account(_,_,n,_),let .resource(_,_,n,_),let .qr(_,_,n,_):return n}}
  var method:String{switch self{case .open:return "open";case .diagnostic:return "diagnose";case let .empty(m,_,_),let .account(m,_,_,_),let .resource(m,_,_,_),let .qr(m,_,_,_):return m}}
 }
 struct ContractFailure:Error {let code:CitizenSDKErrorCode;let message:String;let session:String?;let sequence:Int64?;let stage:CitizenSDKFailureStage
  init(code:CitizenSDKErrorCode,message:String,session:String?=nil,sequence:Int64?=nil,stage:CitizenSDKFailureStage?=nil){self.code=code;self.message=message;self.session=session;self.sequence=sequence;self.stage=stage ?? .defaultStage(for:code)}
 }
 private static func invalid()->ContractFailure{ContractFailure(code:.invalidArgument,message:"Invalid platform resource request")}
 private static func integer(_ value:Any?)throws->Int64{guard let value=value as? NSNumber,CFGetTypeID(value) != CFBooleanGetTypeID(),!["f","d"].contains(String(cString:value.objCType)),value.doubleValue==Double(value.int64Value) else{throw invalid()};return value.int64Value}
 private static func id(_ value:Any?)throws->String{guard let value=value as? String,(1...128).contains(value.utf8.count),value.utf8.allSatisfy({(48...57).contains($0)||(65...90).contains($0)||(97...122).contains($0)||$0==45||$0==95})else{throw invalid()};return value}
 static func envelope(method:String,arguments:Any?)throws->Request?{guard let t=arguments as? [Any?],!t.isEmpty,try integer(t[0])==version else{throw invalid()};if method=="open"||method=="diagnose"{return nil};guard t.count>=3 else{throw invalid()};let s=try id(t[1]),n=try integer(t[2]);guard n>0 else{throw invalid()};return .empty(method:method,session:s,sequence:n)}
 static func decode(method:String,arguments:Any?)throws->Request{
  let outer=try envelope(method:method,arguments:arguments);guard methods.contains(method),let t=arguments as? [Any?] else{throw ContractFailure(code:.unsupported,message:"Unsupported platform operation")}
  if method=="open"{guard t.count==3,let enabled=t[2] as? NSNumber,CFGetTypeID(enabled)==CFBooleanGetTypeID() else{throw invalid()};let mask=try integer(t[1]);guard mask>0&&mask<=Int64(UInt32.max) else{throw invalid()};return .open(modules:CitizenSDKModules(rawValue:UInt32(mask)))}
  if method=="diagnose"{guard t.count==3,let row=t[2] as? [Any],row.count==6 else{throw invalid()};return .diagnostic(session:try id(t[1]),row:row)}
  let s=outer!.sessionID!,n=outer!.sequence!
  if method=="close"||method=="readDiagnostics"{guard t.count==3 else{throw invalid()};return .empty(method:method,session:s,sequence:n)}
  if method=="openPrivateKey"{guard t.count==4,let hex=t[3] as? String,hex.range(of:"^0x[0-9a-f]{64}$",options:.regularExpression) != nil else{throw invalid()};var bytes=Data();var at=hex.index(hex.startIndex,offsetBy:2);for _ in 0..<32{let next=hex.index(at,offsetBy:2);bytes.append(UInt8(hex[at..<next],radix:16)!);at=next};return .account(method:method,session:s,sequence:n,accountID:bytes)}
  if method=="openQrCapture"{guard t.count==4 else{throw invalid()};let purpose=try integer(t[3]);guard [1,2,3,4,5,7,8].contains(purpose)else{throw invalid()};return .qr(method:method,session:s,sequence:n,fields:[purpose])}
  if method=="setQrCaptureTorch"{guard t.count==5,let enabled=t[4] as? NSNumber,CFGetTypeID(enabled)==CFBooleanGetTypeID()else{throw invalid()};return .qr(method:method,session:s,sequence:n,fields:[try id(t[3]),enabled.boolValue])}
  if method=="qrDecodeImage"{guard t.count==5,let data=t[3] as? FlutterStandardTypedData,data.type.rawValue==0,(1...16777216).contains(data.data.count)else{throw invalid()};let purpose=try integer(t[4]);guard [1,2,3,4,5,7,8].contains(purpose)else{throw invalid()};return .qr(method:method,session:s,sequence:n,fields:[data.data,purpose])}
  guard t.count==(method=="respondCredential" ? 5:4)else{throw invalid()}
  if method=="respondCredential"||method=="cancelCredential"{let raw=try id(t[3]);guard let number=UInt64(raw),number>0,String(number)==raw else{throw invalid()};if method=="respondCredential",t[4] != nil{guard let data=t[4] as? FlutterStandardTypedData,data.type.rawValue==0,data.data.count<=1024 else{throw invalid()};var copy=data.data;copy.resetBytes(in:0..<copy.count)}}
  return .resource(method:method,session:s,sequence:n,id:try id(t[3]))
 }
    static func response(session: String, sequence: Int64, value: [Any?]) -> [Any?] {
        [version, session, sequence, value]
    }
    static func event(session: String, sequence: Int64, type: String, payload: [Any?]) throws -> [Any?] {
        guard eventTypes.contains(type), sequence > 0,
              ((type != "historyChanged" && type != "walletChanged") || payload.isEmpty),
              (type != "finalizedBlockChanged" || payload.count == 1) else {
            throw CitizenSDKError(.integrity, "Unsupported CitizenSDK event type")
        }
        return [version, session, sequence, type, payload]
    }
    static func error(_ code: CitizenSDKErrorCode, _ message: String,
                      session: String?, sequence: Int64?, method: String,
                      stage: CitizenSDKFailureStage? = nil) -> [Any?] {
        let method=methods.contains(method) ? method : "open"
        let failureStage = stage ?? .defaultStage(for: code)
        return [version, session, sequence, Int64(code.rawValue),
                Int64(failureStage.rawValue), method, message]
    }
    static func errorName(_ code: CitizenSDKErrorCode) -> String {
        switch code {
        case .ok: return "ok"
        case .invalidArgument: return "invalidArgument"
        case .invalidHandle: return "invalidHandle"
        case .invalidState: return "invalidState"
        case .unsupported: return "unsupported"
        case .unavailable: return "unavailable"
        case .notReady: return "notReady"
        case .notFound: return "notFound"
        case .conflict: return "conflict"
        case .integrity: return "integrity"
        case .authenticationCancelled: return "authenticationCancelled"
        case .authenticationRequired: return "authenticationRequired"
        case .keyInvalidated: return "keyInvalidated"
        case .permissionDenied: return "permissionDenied"
        case .storage: return "storage"
        case .network: return "network"
        case .decode: return "decode"
        case .timeout: return "timeout"
        case .busy: return "busy"
        case .queueFull: return "queueFull"
        case .internalFailure: return "internal"
        case .panic: return "panic"
        case .cancelled: return "cancelled"
        @unknown default: return "unknown"
        }
    }
    static func lifecycle(_ value: CitizenSDKLifecycle) -> String {
        switch value {
        case .created: return "created"
        case .importingState: return "importingState"
        case .starting: return "starting"
        case .running: return "running"
        case .startFailed: return "startFailed"
        case .stopped: return "stopped"
        case .disposed: return "disposed"
        @unknown default: return "unknown"
        }
    }
}
