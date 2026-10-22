package org.citizen.sdk.internal

import java.security.MessageDigest

/** 系统Keystore别名；数据库记录键仅由Rust生成。 */
internal object CitizenSdkRecordKey {

    fun hardwareAlias(walletIndex: Int, generation: ByteArray): String {
        val identity = "v1:$walletIndex:${generation.requireExact(16).hex()}".toByteArray(Charsets.US_ASCII)
        val digest = MessageDigest.getInstance("SHA-256").digest(identity)
        return "citizensdk_wallet_" + digest.hex()
    }

    private fun ByteArray.requireExact(size: Int): ByteArray {
        require(this.size == size) { "record identity has invalid length" }
        return this
    }

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

