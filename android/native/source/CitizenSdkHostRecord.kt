package org.citizen.sdk.internal

/** Exact opaque record completion consumed only by the JNI host bridge. */
internal class CitizenSdkHostRecord(
    val domain: Int,
    val errorCode: Int,
    val present: Boolean,
    val revision: Long,
    record: ByteArray?,
) {
    private val recordValue = record?.clone()
    fun record(): ByteArray? = recordValue?.clone()

    companion object {
        fun absent(domain: Int) = CitizenSdkHostRecord(domain, 0, false, 0, null)
        fun present(domain: Int, revision: Long, record: ByteArray) =
            CitizenSdkHostRecord(domain, 0, true, revision, record)
        fun failure(domain: Int, errorCode: Int) =
            CitizenSdkHostRecord(domain, errorCode, false, 0, null)
    }
}

internal object CitizenSdkHostDomain {
    const val CHAIN_DATABASE = 1
    const val RUNTIME_CACHE = 2
    const val WALLET_PROFILE = 3
    const val TRANSACTION_HISTORY = 4
    const val ENCRYPTED_SECRET_BLOB = 5
}

