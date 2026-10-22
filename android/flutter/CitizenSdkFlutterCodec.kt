package org.citizen.sdk
import java.nio.ByteBuffer

/** 平台仅解资源与UI输入；业务参数和结果直接使用同一Rust C ABI。 */
internal object CitizenSdkFlutterCodec {
 const val METHOD_CHANNEL="citizen/sdk/core/v2";const val EVENT_CHANNEL="citizen/sdk/events/v2";const val PROTOCOL_VERSION=2
 val methods=setOf("open","diagnose","close","readDiagnostics","openPrivateKey","revealPrivateKey","closePrivateKey","cancelOperation","respondCredential","cancelCredential","openQrCapture","closeQrCapture","pauseQrCapture","resumeQrCapture","setQrCaptureTorch","qrDecodeImage")
 sealed interface Request {
  val sessionId:String?;val requestSequence:Long
  data class Open(val modules:Int):Request{override val sessionId:String?=null;override val requestSequence=0L}
  sealed interface SessionRequest:Request{override val sessionId:String}
  data class Diagnostic(override val sessionId:String,val row:List<Any?>):SessionRequest{override val requestSequence=0L}
  data class Empty(val method:String,override val sessionId:String,override val requestSequence:Long):SessionRequest
  data class Account(val method:String,override val sessionId:String,override val requestSequence:Long,val accountId:ByteArray):SessionRequest
  data class Resource(val method:String,override val sessionId:String,override val requestSequence:Long,val resourceId:String):SessionRequest
  data class Qr(val method:String,override val sessionId:String,override val requestSequence:Long,val fields:List<Any>):SessionRequest
 }
 class ContractFailure(val errorCode:Int,val stableName:String,override val message:String,val sessionId:String?=null,val requestSequence:Long?=null,val stage:CitizenSdkFailureStage=CitizenSdkFailureStage.VALIDATION):RuntimeException(message)
 private fun invalid():Nothing=throw ContractFailure(1,"invalidArgument","Invalid platform resource request")
 private fun integer(v:Any?):Long=when(v){is Int->v.toLong();is Long->v;else->invalid()}
 private fun id(v:Any?):String{val value=v as? String?:invalid();if(!Regex("[A-Za-z0-9_-]{1,128}").matches(value))invalid();return value}
 fun requestMethod(r:Request):String=when(r){is Request.Open->"open";is Request.Diagnostic->"diagnose";is Request.Empty->r.method;is Request.Account->r.method;is Request.Resource->r.method;is Request.Qr->r.method}
 fun envelope(method:String,rawArguments:Any?):Request.Empty?{val t=rawArguments as? List<*>?:invalid();if(t.isEmpty()||integer(t[0])!=2L)invalid();if(method=="open"||method=="diagnose")return null;if(t.size<3)invalid();val s=id(t[1]);val n=integer(t[2]);if(n<=0)invalid();return Request.Empty(method,s,n)}
 fun decode(method:String,rawArguments:Any?):Request{val outer=envelope(method,rawArguments);val t=rawArguments as List<*>;if(method !in methods)throw ContractFailure(4,"unsupported","Unsupported platform operation");
 if(method=="open"){if(t.size!=3||t[2] !is Boolean)invalid();val mask=integer(t[1]);if(mask !in 1L..0xffffffffL)invalid();return Request.Open(mask.toInt())}
 if(method=="diagnose"){if(t.size!=3)invalid();val row=t[2] as? List<*>?:invalid();if(row.size!=6)invalid();return Request.Diagnostic(id(t[1]),row.toList())}
 val s=outer!!.sessionId;val n=outer.requestSequence
 if(method=="close"||method=="readDiagnostics"){if(t.size!=3)invalid();return Request.Empty(method,s,n)}
 if(method=="openPrivateKey"){if(t.size!=4)invalid();val hex=t[3] as? String?:invalid();if(!Regex("0x[0-9a-f]{64}").matches(hex))invalid();return Request.Account(method,s,n,ByteArray(32){hex.substring(2+it*2,4+it*2).toInt(16).toByte()})}
 if(method=="openQrCapture"){if(t.size!=4)invalid();val purpose=integer(t[3]);if(purpose !in listOf(1L,2L,3L,4L,5L,7L,8L))invalid();return Request.Qr(method,s,n,listOf(purpose.toInt()))}
 if(method=="setQrCaptureTorch"){if(t.size!=5||t[4] !is Boolean)invalid();return Request.Qr(method,s,n,listOf(id(t[3]),t[4] as Boolean))}
 if(method=="qrDecodeImage"){if(t.size!=5)invalid();val bytes=t[3] as? ByteArray?:invalid();if(bytes.size !in 1..16777216)invalid();val purpose=integer(t[4]);if(purpose !in listOf(1L,2L,3L,4L,5L,7L,8L))invalid();return Request.Qr(method,s,n,listOf(bytes,purpose.toInt()))}
 if(t.size!=(if(method=="respondCredential")5 else 4))invalid();if(method=="cancelOperation"){val raw=id(t[3]);if(!Regex("[1-9][0-9]{0,18}").matches(raw)||raw.toLongOrNull()==null)invalid()};if(method=="respondCredential"||method=="cancelCredential"){val raw=id(t[3]);if(!Regex("[1-9][0-9]{0,19}").matches(raw)||runCatching{java.lang.Long.parseUnsignedLong(raw)}.isFailure)invalid();if(method=="respondCredential"&&t[4]!=null){val bytes=t[4] as? ByteArray?:invalid();if(bytes.size>1024)invalid();bytes.fill(0)}};return Request.Resource(method,s,n,id(t[3]))
 }
    fun response(sessionId: String, requestSequence: Long, value: List<Any?>): List<Any?> =
        listOf(PROTOCOL_VERSION, sessionId, requestSequence, value)

    /** [2, sessionId, eventSequence, type, type-specific payload tuple]. */
    fun event(sessionId: String, eventSequence: Long, type: String, payload: List<Any?>): List<Any?> {
        require(type in setOf(
            "qrCaptureResult", "qrCaptureError", "qrCapturePreview", "qrCaptureClosed", "privateKeyClosed",
        ))
        require(eventSequence > 0)
        return listOf(PROTOCOL_VERSION, sessionId, eventSequence, type, payload)
    }

    /** [2, sessionId?, requestSequence?, errorCode, failureStage, method, errorMessage?]. */
    fun errorDetails(
        code: CitizenSdkErrorCode,
        message: String?,
        sessionId: String?,
        requestSequence: Long?,
        method: String,
        stage: CitizenSdkFailureStage = CitizenSdkFailureStage.fromErrorCode(code),
    ): List<Any?> {
        require(method in methods) { "error method must be public" }
        return listOf(
            PROTOCOL_VERSION,
            sessionId,
            requestSequence,
            code.value,
            stage.value,
            method,
            message,
        )
    }

    fun errorName(code: CitizenSdkErrorCode): String = when (code) {
        CitizenSdkErrorCode.OK -> "ok"
        CitizenSdkErrorCode.INVALID_ARGUMENT -> "invalidArgument"
        CitizenSdkErrorCode.INVALID_HANDLE -> "invalidHandle"
        CitizenSdkErrorCode.INVALID_STATE -> "invalidState"
        CitizenSdkErrorCode.UNSUPPORTED -> "unsupported"
        CitizenSdkErrorCode.UNAVAILABLE -> "unavailable"
        CitizenSdkErrorCode.NOT_READY -> "notReady"
        CitizenSdkErrorCode.NOT_FOUND -> "notFound"
        CitizenSdkErrorCode.CONFLICT -> "conflict"
        CitizenSdkErrorCode.INTEGRITY -> "integrity"
        CitizenSdkErrorCode.AUTHENTICATION_CANCELLED -> "authenticationCancelled"
        CitizenSdkErrorCode.AUTHENTICATION_REQUIRED -> "authenticationRequired"
        CitizenSdkErrorCode.KEY_INVALIDATED -> "keyInvalidated"
        CitizenSdkErrorCode.PERMISSION_DENIED -> "permissionDenied"
        CitizenSdkErrorCode.STORAGE -> "storage"
        CitizenSdkErrorCode.NETWORK -> "network"
        CitizenSdkErrorCode.DECODE -> "decode"
        CitizenSdkErrorCode.TIMEOUT -> "timeout"
        CitizenSdkErrorCode.BUSY -> "busy"
        CitizenSdkErrorCode.QUEUE_FULL -> "queueFull"
        CitizenSdkErrorCode.INTERNAL -> "internal"
        CitizenSdkErrorCode.PANIC -> "panic"
        CitizenSdkErrorCode.CANCELLED -> "cancelled"
    }

    fun lifecycle(value: CitizenSdkLifecycle): String = when (value) {
        CitizenSdkLifecycle.CREATED -> "created"
        CitizenSdkLifecycle.IMPORTING_STATE -> "importingState"
        CitizenSdkLifecycle.STARTING -> "starting"
        CitizenSdkLifecycle.RUNNING -> "running"
        CitizenSdkLifecycle.START_FAILED -> "startFailed"
        CitizenSdkLifecycle.STOPPED -> "stopped"
        CitizenSdkLifecycle.DISPOSED -> "disposed"
    }

}
