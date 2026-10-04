package org.citizen.sdk.internal

import java.security.MessageDigest

/** Canonical binary identities used as SQLite primary keys. */
internal object CitizenSdkRecordKey {
    fun blockHash(hash: ByteArray): String = "block:" + hash.requireExact(32).hex()

    fun secret(
        walletIndex: Int,
        kind: Int,
        generation: ByteArray,
        owner: ByteArray,
        accountId: ByteArray,
    ): String = buildString(2 + 8 + 1 + 32 + 1 + 32 + 1 + 64) {
        append("v1:")
        append(walletIndex)
        append(':')
        append(kind)
        append(':')
        append(generation.requireExact(16).hex())
        append(':')
        append(owner.requireExact(16).hex())
        append(':')
        append(accountId.requireExact(32).hex())
    }

    fun walletGeneration(walletIndex: Int, generation: ByteArray): String =
        "v1:$walletIndex:${generation.requireExact(16).hex()}"

    fun hardwareAlias(walletIndex: Int, generation: ByteArray): String {
        val identity = walletGeneration(walletIndex, generation).toByteArray(Charsets.US_ASCII)
        val digest = MessageDigest.getInstance("SHA-256").digest(identity)
        return "citizensdk_wallet_" + digest.hex()
    }

    private fun ByteArray.requireExact(size: Int): ByteArray {
        require(this.size == size) { "record identity has invalid length" }
        return this
    }

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

