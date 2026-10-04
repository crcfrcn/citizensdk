package org.citizen.sdk

import org.json.JSONObject
import org.citizen.sdk.internal.CitizenSdkNative


/** 仅保存规范输入字段；短键、Base64、随机编号和协议校验只由Core处理。 */
class CitizenQrContent internal constructor(internal val inputJson: String) {
    companion object {
        private fun content(vararg fields: Pair<String, Any?>) =
            CitizenQrContent(JSONObject(fields.associate { it.first to (it.second ?: JSONObject.NULL) }).toString())
        private fun hex(bytes: ByteArray) = "0x" + bytes.joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
        fun signRequest(action: Int, signerAccountId: String?, reviewPayload: ByteArray, expiresAt: ULong,
                        requestId: String? = null, requestIdPrefix: String = "") =
            content("kind" to 1, "request_id" to requestId, "request_id_prefix" to requestIdPrefix,
                "expires_at" to expiresAt.toString(), "action" to action, "signer_account_id" to signerAccountId,
                "review_payload" to hex(reviewPayload))
        fun signResponse(requestId: String, expiresAt: ULong, signerAccountId: String, signature: ByteArray,
                         currentAccountId: String? = null, currentAccountSignature: ByteArray? = null) =
            content("kind" to 2, "request_id" to requestId, "expires_at" to expiresAt.toString(),
                "signer_account_id" to signerAccountId, "signature" to hex(signature),
                "current_account_id" to currentAccountId, "current_account_signature" to currentAccountSignature?.let(::hex))
        fun userContact(cidNumber: String, accountId: String) =
            content("kind" to 3, "cid_number" to cidNumber, "account_id" to accountId)
        fun userTransfer(requestId: String, expiresAt: ULong, accountId: String, amount: String,
                         symbol: String, memo: String, bankCidNumber: String) =
            content("kind" to 4, "request_id" to requestId, "expires_at" to expiresAt.toString(),
                "account_id" to accountId, "amount" to amount, "symbol" to symbol, "memo" to memo, "bank_cid_number" to bankCidNumber)
        fun accountDataKeyResponse(requestId: String, expiresAt: ULong, signerAccountId: String, signature: ByteArray,
                                   keyExchangePublicKey: ByteArray, encryptionNonce: ByteArray, ciphertext: ByteArray) =
            content("kind" to 6, "request_id" to requestId, "expires_at" to expiresAt.toString(),
                "signer_account_id" to signerAccountId, "signature" to hex(signature),
                "key_exchange_public_key" to hex(keyExchangePublicKey), "encryption_nonce" to hex(encryptionNonce),
                "ciphertext" to hex(ciphertext))
    }
}

enum class CitizenQrAuthorizationReason { VALID, INVALID_TEMPLATE, INVALID_ACCOUNT_ID, SAME_ACCOUNT }

/** Core返回的纯准备事实；不是设备授权或链上资格证明。 */
class CitizenQrAuthorization private constructor(
    val reason: CitizenQrAuthorizationReason, val genesisHash: String?, val cidNumber: String?,
    val currentAccountId: String?, val expectedBindingRevision: ULong?, val expiresAt: ULong?,
    private val materialized: ByteArray?, internal val coreJson: String,
) {
    val materializedPayload: ByteArray? get() = materialized?.clone()
    internal companion object {
        fun parse(json: String): CitizenQrAuthorization = CitizenQrDocument.projection {
            with(CitizenQrDocument) {
                val v = objectValue(json)
                val keys = setOf("reason", "genesis_hash", "cid_number", "current_account_id",
                    "expected_binding_revision", "expires_at", "materialized_payload")
                check(v.keys().asSequence().toSet() == keys)
                val reason = CitizenQrAuthorizationReason.entries[v.getInt("reason")]
                if (reason != CitizenQrAuthorizationReason.VALID) {
                    check(keys.filter { it != "reason" }.all { v.isNull(it) })
                    CitizenQrAuthorization(reason, null, null, null, null, null, null, json)
                } else {
                    val hex = v.hex("materialized_payload").drop(2)
                    check(hex.isNotEmpty() && hex.length <= 3840)
                    val bytes = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
                    CitizenQrAuthorization(reason, v.hex("genesis_hash", 32), v.text("cid_number"),
                        if (v.isNull("current_account_id")) null else v.hex("current_account_id", 32),
                        v.text("expected_binding_revision").toULong(), v.text("expires_at").toULong(), bytes, json)
                }
            }
        }
    }
}

/** 不在绑定层实现哈希或SCALE；只把六种原输入投影给Rust。 */
class CitizenSigningPayload internal constructor(internal val kind: Int, internal val fieldsJson: String, bytes: ByteArray) {
    private val bytes = bytes.clone()
    internal fun payloadBytes() = bytes.clone()
    companion object {
        private fun hex(bytes: ByteArray) = "0x" + bytes.joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
        fun message(opTag: Int, scalePayload: ByteArray) = CitizenSigningPayload(1, JSONObject(mapOf("op_tag" to opTag)).toString(), scalePayload)
        fun binaryPrefix(opTag: Int) = CitizenSigningPayload(2, JSONObject(mapOf("op_tag" to opTag)).toString(), byteArrayOf())
        fun activateAdmin(cidNumber: String, institutionCode: ByteArray, kind: Int, signerPublicKey: ByteArray, timestamp: ULong, nonce: ByteArray) =
            CitizenSigningPayload(3, JSONObject(mapOf("cid_number" to cidNumber, "institution_code" to hex(institutionCode),
                "kind" to kind, "signer_public_key" to hex(signerPublicKey), "timestamp" to timestamp.toString(), "nonce" to hex(nonce))).toString(), byteArrayOf())
        fun decryptAdmin(cidNumber: String, signerPublicKey: ByteArray, timestamp: ULong, nonce: ByteArray) =
            CitizenSigningPayload(4, JSONObject(mapOf("cid_number" to cidNumber, "signer_public_key" to hex(signerPublicKey),
                "timestamp" to timestamp.toString(), "nonce" to hex(nonce))).toString(), byteArrayOf())
        fun scaleString(value: String) = CitizenSigningPayload(5, "{}", value.toByteArray(Charsets.UTF_8))
        fun u64Le(value: ULong) = CitizenSigningPayload(6, JSONObject(mapOf("value" to value.toString())).toString(), byteArrayOf())
    }
}
enum class CitizenQrScanPurpose(val value: Int) {
    COLD_ACCOUNT_IMPORT(1), TRANSFER_RECIPIENT(2), CONTACT(3), EXTERNAL_SIGNATURE(4),
    SIGNING_REQUEST(5), ACCOUNT_DATA_KEY(6), GENERAL_SCAN(7), ACCOUNT_TARGET(8),
}

class CitizenQrScanResult private constructor(val purpose: CitizenQrScanPurpose, val document: CitizenQrDocument) {
    val canonicalText: String get() = document.canonicalText
    internal companion object {
        fun forPurpose(document: CitizenQrDocument, purpose: CitizenQrScanPurpose): CitizenQrScanResult {
            // 允许集来自Core投影；绑定不维护自己的kind表，宿主也不能放宽冷导入。
            if (document.scanPurposeMask and (1 shl (purpose.value - 1)) == 0) {
                throw CitizenSdkException(CitizenSdkErrorCode.INVALID_ARGUMENT, "QR code does not match scan purpose")
            }
            return CitizenQrScanResult(purpose, document)
        }
    }
}

/** Rust 唯一解析结果；公开结构不暴露可注入签名或内部审阅凭证。 */
class CitizenQrDocument internal constructor(
    val kind: Int,
    val canonicalText: String,
    val content: Content,
    val signRequest: String?,
    @get:JvmSynthetic internal val coreJson: String,
    @get:JvmSynthetic internal val scanPurposeMask: Int,
    @get:JvmSynthetic internal val signedImage: CitizenQrImage? = null,
) {
    internal fun withSignedImage(image: CitizenQrImage) = CitizenQrDocument(kind, canonicalText, content, signRequest, coreJson, scanPurposeMask, image)
    sealed class Content {
        data class SignRequest(val requestId: String, val expiresAt: Long, val action: Int,
            val signerAccountId: String?, val reviewPayload: String) : Content()
        data class SignResponse(val requestId: String, val expiresAt: Long,
            val signerAccountId: String, val signature: String,
            val currentAccountId: String? = null, val currentAccountSignature: String? = null) : Content()
        data class AccountId(val accountId: String) : Content()
        data class UserContact(val cidNumber: String, val accountId: String) : Content()
        data class UserTransfer(val requestId: String, val expiresAt: Long, val accountId: String,
            val amount: String, val symbol: String, val memo: String, val bankCidNumber: String) : Content()
        data class AccountDataKeyResponse(val requestId: String, val expiresAt: Long,
            val signerAccountId: String, val signature: String, val keyExchangePublicKey: String,
            val encryptionNonce: String, val ciphertext: String) : Content()
    }
    internal companion object {
        fun parse(json: String): CitizenQrDocument = projection {
            val value = objectValue(json)
            val kind = value.getInt("kind")
            val canonical = value.text("canonical_text").also { check(it.toByteArray(Charsets.UTF_8).size in 1..2331) }
            val content = when (kind) {
                1 -> Content.SignRequest(value.text("request_id"), value.expiration(),
                    value.getInt("action").also { check(it in 0..65535) },
                    if (value.isNull("signer_account_id")) null else value.hex("signer_account_id", 32), value.hex("review_payload"))
                2 -> Content.SignResponse(value.text("request_id"), value.expiration(),
                    value.hex("signer_account_id", 32), value.hex("signature", 64),
                    if (value.isNull("current_account_id")) null else value.hex("current_account_id", 32),
                    if (value.isNull("current_account_signature")) null else value.hex("current_account_signature", 64)).also {
                        check(value.has("current_account_id") && value.has("current_account_signature"))
                        check((it.currentAccountId == null) == (it.currentAccountSignature == null))
                    }
                3 -> Content.UserContact(value.text("cid_number"), value.hex("account_id", 32))
                4 -> Content.UserTransfer(value.text("request_id"), value.expiration(), value.hex("account_id", 32),
                    value.text("amount"), value.text("symbol"), value.text("memo"), value.text("bank_cid_number"))
                5 -> Content.AccountId(value.hex("account_id", 32))
                6 -> Content.AccountDataKeyResponse(value.text("request_id"), value.expiration(),
                    value.hex("signer_account_id", 32), value.hex("signature", 64),
                    value.hex("key_exchange_public_key", 32), value.hex("encryption_nonce", 12), value.hex("ciphertext"))
                else -> error("unsupported Core QR kind")
            }
            val mask = value.getInt("scan_purpose_mask").also { check(it in 1..255) }
            CitizenQrDocument(kind, canonical, content, if (value.has("sign_request")) value.text("sign_request") else null, json, mask)
        }
        fun objectValue(json: String): JSONObject {
            check(json.toByteArray(Charsets.UTF_8).size in 1..65536)
            return JSONObject(json)
        }
        fun JSONObject.text(key: String): String = get(key).let { check(it is String); it }
        fun JSONObject.unsigned(key: String): String = get(key).let {
            check(it is Number); it.toString().also { number -> check(number.toULongOrNull() != null) }
        }
        fun JSONObject.expiration(): Long = get("expires_at").let {
            // Core 统一为正 i64，拒绝 Double 和字符串，禁止平台自行舍入时间。
            check(it is Long || it is Int)
            (it as Number).toLong().also { expiration -> check(expiration > 0) }
        }
        fun JSONObject.hex(key: String, count: Int? = null): String = text(key).also {
            check(it.startsWith("0x") && it.length % 2 == 0 && it.drop(2).all { char -> char in '0'..'9' || char in 'a'..'f' })
            if (count != null) check(it.length == 2 + 2 * count)
        }
        fun <T> projection(body: () -> T): T = try { body() } catch (error: Throwable) {
            throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "Core QR 文档不完整", error)
        }
    }
}

/** 不可变审阅事实及同实例凭证；不含标题、按钮或排版字符串。 */
class CitizenQrReview internal constructor(
    private val native: CitizenSdkNative,
    result: Long,
    @get:JvmSynthetic internal val coreJson: String,
    private val released: (CitizenQrReview) -> Unit,
) : AutoCloseable {
    private val gate = Any()
    private var handle = result
    val document = CitizenQrDocument.parse(coreJson)
    private val facts = CitizenQrDocument.projection {
        with(CitizenQrDocument) {
            objectValue(coreJson).also {
                check(document.kind == 1)
                check(it.unsigned("spec_version").toULong() <= UInt.MAX_VALUE.toULong())
                check(it.unsigned("transaction_version").toULong() <= UInt.MAX_VALUE.toULong())
            }
        }
    }
    val requestId = (document.content as CitizenQrDocument.Content.SignRequest).requestId
    val signerAccountId = requireNotNull((document.content as CitizenQrDocument.Content.SignRequest).signerAccountId)
    val expiresAt = (document.content as CitizenQrDocument.Content.SignRequest).expiresAt
    val palletName: String = with(CitizenQrDocument) { facts.text("pallet_name") }
    val callName: String = with(CitizenQrDocument) { facts.text("call_name") }
    val callArguments: String = with(CitizenQrDocument) { facts.text("call_arguments") }

    @JvmSynthetic
    internal fun <T> withHandle(owner: CitizenSdkNative, body: (Long) -> T): T = synchronized(gate) {
        check(owner === native && handle != 0L) { "QR review is closed or belongs to another SDK" }
        body(handle)
    }
    override fun close() = synchronized(gate) {
        if (handle != 0L) {
            native.releaseQrReview(handle)
            handle = 0L
            released(this)
        }
    }
}

/** ZXing-C++ 生成的 8 位灰度 QR Code Model 2 图像。 */
data class CitizenQrSigned(val document: CitizenQrDocument, val qrImage: CitizenQrImage)

/** ZXing-C++ 生成的 8 位灰度 QR Code Model 2 图像。 */
data class CitizenQrImage(val width: Int, val height: Int, val luminance: ByteArray) {
    fun luminance(): ByteArray = luminance.clone()
}
