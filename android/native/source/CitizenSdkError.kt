package org.citizen.sdk

/** Stable error vocabulary shared with `citizensdk_error_code_t`. */
enum class CitizenSdkErrorCode(val value: Int) {
    OK(0),
    INVALID_ARGUMENT(1),
    INVALID_HANDLE(2),
    INVALID_STATE(3),
    UNSUPPORTED(4),
    UNAVAILABLE(5),
    NOT_READY(6),
    NOT_FOUND(7),
    CONFLICT(8),
    INTEGRITY(9),
    AUTHENTICATION_CANCELLED(10),
    AUTHENTICATION_REQUIRED(11),
    KEY_INVALIDATED(12),
    PERMISSION_DENIED(13),
    STORAGE(14),
    NETWORK(15),
    DECODE(16),
    TIMEOUT(17),
    BUSY(18),
    QUEUE_FULL(19),
    INTERNAL(20),
    PANIC(21),
    CANCELLED(22);

    companion object {
        @JvmStatic
        fun fromValue(value: Int): CitizenSdkErrorCode =
            entries.firstOrNull { it.value == value } ?: INTEGRITY
    }
}

/** Stable product-independent failure phase shared with `citizensdk_failure_stage_t`. */
enum class CitizenSdkFailureStage(val value: Int) {
    ADMISSION(1),
    VALIDATION(2),
    AUTHENTICATION(3),
    PERSISTENCE(4),
    PROVIDER(5),
    VERIFICATION(6),
    CANCELLATION(7),
    TEARDOWN(8);

    companion object {
        @JvmStatic
        fun fromValue(value: Int): CitizenSdkFailureStage? = entries.firstOrNull { it.value == value }

        @JvmStatic
        fun fromErrorCode(code: CitizenSdkErrorCode): CitizenSdkFailureStage = when (code) {
            CitizenSdkErrorCode.INVALID_ARGUMENT, CitizenSdkErrorCode.DECODE -> VALIDATION
            CitizenSdkErrorCode.AUTHENTICATION_CANCELLED,
            CitizenSdkErrorCode.AUTHENTICATION_REQUIRED,
            CitizenSdkErrorCode.KEY_INVALIDATED,
            CitizenSdkErrorCode.PERMISSION_DENIED -> AUTHENTICATION
            CitizenSdkErrorCode.STORAGE -> PERSISTENCE
            CitizenSdkErrorCode.UNAVAILABLE,
            CitizenSdkErrorCode.NETWORK,
            CitizenSdkErrorCode.TIMEOUT -> PROVIDER
            CitizenSdkErrorCode.INTEGRITY -> VERIFICATION
            CitizenSdkErrorCode.CANCELLED -> CANCELLATION
            CitizenSdkErrorCode.INTERNAL, CitizenSdkErrorCode.PANIC -> TEARDOWN
            else -> ADMISSION
        }
    }
}

/** Public failures never contain secrets or native/result identities. */
class CitizenSdkException(
    val code: CitizenSdkErrorCode,
    message: String,
    cause: Throwable? = null,
    val stage: CitizenSdkFailureStage,
    /** One of the public Flutter/facade method names when the failure crossed that boundary. */
    val method: String? = null,
    val sessionId: String? = null,
    val requestSequence: Long? = null,
) : RuntimeException(message, cause) {
    /** Keeps the exact constructor descriptor used by the JNI exception bridge. */
    constructor(
        code: CitizenSdkErrorCode,
        message: String,
        cause: Throwable? = null,
    ) : this(code, message, cause, CitizenSdkFailureStage.fromErrorCode(code))

    fun contextualized(method: String, sessionId: String? = null, requestSequence: Long? = null) =
        CitizenSdkException(code, message ?: code.name, this, stage, method, sessionId, requestSequence)
}
