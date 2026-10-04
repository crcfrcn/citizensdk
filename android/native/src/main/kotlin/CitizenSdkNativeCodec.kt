@file:kotlin.jvm.JvmSynthetic

package org.citizen.sdk.internal

import org.citizen.sdk.*
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/** Decoder for the private JNI wire; the wire is not a public SDK protocol. */
internal object CitizenSdkNativeCodec {
    data class Decoded(val result: CitizenSdkNativeResult?, val error: CitizenSdkException?)

    fun decode(bytes: ByteArray): Decoded = decodeIntegrity("result") {
        val reader = Reader(bytes)
        check(reader.u32Long() == VERSION.toLong()) { "unsupported JNI result version" }
        val errorCode = reader.i32()
        val failureStage = reader.u32Long()
        val kind = reader.u32Long()
        val message = reader.text()
        if (errorCode != 0) {
            reader.finish()
            val stableCode = CitizenSdkErrorCode.fromValue(errorCode)
            check(stableCode.value == errorCode) {
                "JNI returned unknown error code $errorCode"
            }
            val stableStage = CitizenSdkFailureStage.fromValue(failureStage.toInt())
            check(stableStage != null && stableStage.value.toLong() == failureStage) {
                "JNI returned unknown failure stage"
            }
            return@decodeIntegrity Decoded(
                null,
                CitizenSdkException(
                    stableCode,
                    message.ifEmpty { "CitizenSDK operation failed" },
                    stage = stableStage,
                ),
            )
        }
        check(failureStage == 0L) { "successful JNI result contains a failure stage" }
        val result = when (kind) {
            0L -> CitizenSdkNativeResult.Empty
            1L -> CitizenSdkNativeResult.Block(reader.block())
            2L -> CitizenSdkNativeResult.Storage(if (reader.bool()) reader.bytes(64 * 1024 * 1024) else null)
            3L -> {
                var total = 0L
                CitizenSdkNativeResult.StorageBatch(
                    List(reader.boundedCount(1024, "storage batch count")) {
                        if (reader.bool()) reader.bytes(64 * 1024 * 1024).also {
                            total += it.size
                            check(total <= 64L * 1024L * 1024L)
                        } else null
                    },
                )
            }
            4L -> CitizenSdkNativeResult.RuntimeContext(
                CitizenRuntimeContext(
                    reader.block(), reader.u32Long(), reader.u32Long(),
                    reader.bytes(64 * 1024 * 1024).also { check(it.isNotEmpty()) },
                ),
            )
            8L -> CitizenSdkNativeResult.ChainState(
                CitizenChainState(
                    reader.u32Long(), reader.block(),
                    reader.bytes(256 * 1024).also { check(it.isNotEmpty()) },
                ),
            )
            9L -> CitizenSdkNativeResult.Balance(reader.balance())
            10L -> CitizenSdkNativeResult.Nonce(
                CitizenAccountNonce(reader.block(), reader.fixed(32), reader.u64Text()),
            )
            11L -> CitizenSdkNativeResult.Fee(
                CitizenFeeSnapshot(reader.block(), reader.u32Long(), reader.u128(), reader.u128()),
            )
            12L -> CitizenSdkNativeResult.Profile(reader.walletProfile())
            13L -> CitizenSdkNativeResult.Accounts(reader.walletAccounts())
            14L -> CitizenSdkNativeResult.Signature(CitizenSignature(reader.fixed(64)))
            15L -> CitizenSdkNativeResult.Prepared(reader.positiveI64("prepared wallet token"))
            17L -> CitizenSdkNativeResult.TransactionHistoryPage(reader.transactionHistoryPage())
            18L -> CitizenSdkNativeResult.Balances(
                List(reader.boundedCount(1990, "balance result count")) { reader.balance() },
            )
            19L -> CitizenSdkNativeResult.QrReview(reader.positiveI64("QR review token"), reader.text().also {
                check(it.toByteArray(Charsets.UTF_8).size in 1..65536)
            })
            20L -> CitizenSdkNativeResult.QrSigned(CitizenQrDocument.parse(reader.text()).also {
                check(it.kind == 2 && (it.signRequest?.toByteArray(Charsets.UTF_8)?.size ?: 0) in 1..2331)
            })
            21L -> {
                val token = reader.i64().also { check(it >= 0) }
                CitizenSdkNativeResult.WalletState(reader.walletState(), token)
            }
            22L -> CitizenSdkNativeResult.SigningOutcome(reader.signingOutcome())
            23L -> CitizenSdkNativeResult.DefaultAccountChange(reader.defaultAccountChange())
            24L -> CitizenSdkNativeResult.SyncStatus(
                CitizenChainSyncStatus(
                    reader.u64Text(), reader.bool(), reader.bool(), reader.block(), reader.block(),
                ).also {
                    check(it.best.finality == CitizenFinality.BEST)
                    check(it.finalized.finality == CitizenFinality.FINALIZED)
                    check(it.finalized.number.toULong() <= it.best.number.toULong())
                },
            )
            25L -> CitizenSdkNativeResult.BlockHeader(
                CitizenBlockHeader(
                    reader.block(), reader.fixed(32), reader.fixed(32), reader.fixed(32),
                    reader.bytes(1024 * 1024),
                ),
            )
            26L -> CitizenSdkNativeResult.BlockBody(
                reader.blockBody(),
            )
            27L -> CitizenSdkNativeResult.PreparedTransaction(
                reader.positiveI64("prepared transaction token"),
                CitizenPreparedTransaction(
                    preparationId = "0x" + reader.fixed(16).toHex(),
                    sourceAccountId = reader.fixed(32),
                    callDataHash = reader.fixed(32),
                    bestBlock = reader.block().also { check(it.finality == CitizenFinality.BEST) },
                    runtimeSpecNumber = reader.u32Long(),
                    transactionFormatNumber = reader.u32Long(),
                    nonce = reader.u64Text(),
                ),
            )
            28L -> CitizenSdkNativeResult.TransactionExecution(reader.transactionExecution())
            29L -> CitizenSdkNativeResult.ApplicationKey(reader.fixed(32))
            30L -> CitizenSdkNativeResult.ApplicationKeys(
                List(reader.boundedCount(16, "application key count").also { check(it > 0) }) { reader.fixed(32) },
            )
            31L -> CitizenSdkNativeResult.ApplicationKeyPreparation(
                org.citizen.sdk.CitizenApplicationKeyPreparation(
                    List(reader.boundedCount(16, "application key count").also { check(it > 0) }) { reader.fixed(32) },
                    if (reader.u32Long().also { check(it <= 1) } == 1L) reader.fixed(64) else null,
                ),
            )
            else -> throw CitizenSdkException(
                CitizenSdkErrorCode.INTEGRITY,
                "JNI returned unsupported result kind $kind",
            )
        }
        reader.finish()
        Decoded(result, null)
    }

    /** 只检查传输完整性，不能在 Kotlin 重算余额或建立第二套链读取规则。 */
    fun validateBalances(values: List<CitizenAccountBalance>, accountIds: Array<ByteArray>): List<CitizenAccountBalance> {
        val block = values.firstOrNull()?.block
        if (values.size != accountIds.size || values.size > 1990 || values.indices.any { index ->
                val value = values[index]
                !value.accountId().contentEquals(accountIds[index]) ||
                    value.block.finality != CitizenFinality.FINALIZED || block == null ||
                    value.block.number != block.number || !value.block.hash().contentEquals(block.hash())
            }) throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY,
                "Core balance results do not match one finalized request")
        return values.toList()
    }

    fun decodeCapabilities(bytes: ByteArray): CitizenSdkCapabilities = decodeIntegrity("capability") {
        val reader = Reader(bytes)
        check(reader.u32Long() == VERSION.toLong()) { "unsupported capability wire version" }
        val revision = reader.u64Text()
        val count = reader.boundedCount(10, "capability count")
        check(count == 10) { "capability snapshot must contain ten entries" }
        val statuses = ArrayList<CitizenCapabilityStatus>(count)
        repeat(count) {
            statuses += CitizenCapabilityStatus(
                reader.oneBasedEnum(CitizenCapabilityName.entries, "capability name"),
                reader.zeroBasedEnum(CitizenCapabilityReason.entries, "capability reason"),
                reader.bool(),
                reader.bool(),
                reader.bool(),
                reader.bool(),
            )
        }
        reader.finish()
        CitizenSdkCapabilities(revision, statuses)
    }

    private inline fun <T> decodeIntegrity(label: String, block: () -> T): T = try {
        block()
    } catch (error: CitizenSdkException) {
        throw error
    } catch (error: Throwable) {
        throw CitizenSdkException(
            CitizenSdkErrorCode.INTEGRITY,
            "CitizenSDK returned a malformed $label envelope",
            error,
        )
    }

    private class Reader(bytes: ByteArray) {
        private val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        fun i32(): Int = buffer.int
        fun u32Long(): Long = Integer.toUnsignedLong(buffer.int)
        fun i64(): Long = buffer.long
        fun positiveI64(label: String): Long = i64().also { check(it > 0) { "$label is invalid" } }
        fun u64Text(): String = java.lang.Long.toUnsignedString(buffer.long)
        fun bool(): Boolean = when (val value = buffer.get().toInt()) {
            0 -> false
            1 -> true
            else -> error("JNI boolean is invalid: $value")
        }
        fun fixed(size: Int): ByteArray {
            check(size >= 0 && size <= buffer.remaining()) { "JNI byte field exceeds its envelope" }
            return ByteArray(size).also(buffer::get)
        }
        fun bytes(maximum: Int = Int.MAX_VALUE): ByteArray {
            val size = u32Long()
            check(size <= maximum.toLong() && size <= buffer.remaining().toLong()) {
                "JNI byte field exceeds its envelope"
            }
            return fixed(size.toInt())
        }
        fun text(): String {
            val value = bytes()
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(value))
                .toString()
        }
        fun u128(): CitizenU128 = CitizenU128(buffer.long, buffer.long)
        fun block(): CitizenBlockRef = CitizenBlockRef(
            fixed(32),
            u64Text(),
            oneBasedEnum(CitizenFinality.entries, "finality"),
        )

        fun balance(): CitizenAccountBalance = CitizenAccountBalance(block(), fixed(32), u128(), u128(), u128())

        fun blockBody(): CitizenBlockBody {
            val block = block()
            val count = boundedCount(16384, "block body extrinsic count")
            var total = 0L
            val extrinsics = List(count) {
                bytes(64 * 1024 * 1024).also {
                    check(it.isNotEmpty())
                    total += it.size
                    check(total <= 64L * 1024L * 1024L)
                }
            }
            return CitizenBlockBody(block, extrinsics)
        }

        fun walletProfile(): CitizenWalletProfile? {
            if (!bool()) return null
            val origin = oneBasedEnum(CitizenWalletOrigin.entries, "wallet origin")
            val walletIndex = u32Long()
            val created = u64Text()
            val master = fixed(32)
            val active = fixed(32)
            val count = boundedCount(1990, "wallet account count")
            val accounts = walletAccounts(count)
            return CitizenWalletProfile(origin, walletIndex, created, master, active, accounts, text())
        }

        fun walletState(): CitizenWalletState {
            val revision = u64Text()
            data class ProfileHeader(
                val origin: CitizenWalletOrigin,
                val walletIndex: Long,
                val created: String,
                val master: ByteArray,
                val active: ByteArray,
                val count: Int,
                val walletName: String,
            )
            val header = if (bool()) ProfileHeader(
                oneBasedEnum(CitizenWalletOrigin.entries, "wallet origin"),
                u32Long(), u64Text(), fixed(32), fixed(32),
                boundedCount(1990, "hot wallet account count"), text(),
            ) else null
            val count = boundedCount(3980, "wallet state account count")
            val accounts = ArrayList<CitizenWalletStateAccount>(count)
            repeat(count) { index ->
                val mode = oneBasedEnum(CitizenWalletSignMode.entries, "wallet sign mode")
                val walletIndex = u32Long()
                val accountIndex = if (bool()) boundedU32Long(1989, "wallet account index") else null
                val accountId = fixed(32)
                val value = CitizenWalletStateAccount(
                    mode, walletIndex, accountIndex, accountId, text(), text(), u64Text(), bool(),
                )
                check(value.isDefault == (index == 0))
                check((mode == CitizenWalletSignMode.HOT && walletIndex == 0L && accountIndex != null) ||
                    (mode == CitizenWalletSignMode.COLD && walletIndex != 0L && accountIndex == null))
                accounts += value
            }
            fun key(bytes: ByteArray): String = bytes.contentToString()
            check(accounts.map { key(it.accountId()) }.toSet().size == accounts.size)
            check(accounts.filter { it.signMode == CitizenWalletSignMode.COLD }
                .map { it.walletIndex }.toSet().size ==
                accounts.count { it.signMode == CitizenWalletSignMode.COLD })
            check(accounts.filter { it.signMode == CitizenWalletSignMode.HOT }
                .map { it.accountIndex }.toSet().size ==
                accounts.count { it.signMode == CitizenWalletSignMode.HOT })
            val profile = header?.let { value ->
                val hot = accounts.filter { it.signMode == CitizenWalletSignMode.HOT }.map {
                    CitizenWalletAccount(
                        it.accountIndex!!, it.accountId(), it.ss58Address, it.name,
                        it.createdAtMillis, it.accountId().contentEquals(value.active),
                    )
                }
                check(value.walletIndex == 0L && hot.size == value.count)
                check(hot.count { it.active } == 1 && hot.any { it.active && it.accountId().contentEquals(value.active) })
                check(hot.any { it.index == 0L && it.accountId().contentEquals(value.master) })
                CitizenWalletProfile(value.origin, value.walletIndex, value.created,
                    value.master, value.active, hot, value.walletName)
            }
            check(profile != null || accounts.none { it.signMode == CitizenWalletSignMode.HOT })
            val initialization = u32Long().toInt()
            // 清理标记沿用同一严格布尔解码；非法字节不得被投影为有效状态。
            val cleanup = bool()
            check(initialization in 0..2)
            val activeWalletIndex = if (bool()) u32Long() else null
            val walletIndices = accounts.map { it.walletIndex }.toMutableSet()
            val identities = accounts.map { key(it.accountId()) }.toMutableSet()
            val diagnostics = List(boundedCount(1991, "wallet diagnostic count")) {
                val index = u32Long()
                val name = text()
                val account = fixed(32)
                val address = if (bool()) text() else null
                val reason = boundedU32Long(3, "wallet diagnostic reason").toInt()
                check(reason >= 1 && walletIndices.add(index) && identities.add(key(account)))
                check(name.isNotEmpty() && name.toByteArray(Charsets.UTF_8).size <= 120 && name == name.trim())
                check(name.codePointCount(0, name.length) <= 30 && name.none { it.code <= 31 || it.code in 127..159 })
                check(address == null || address.toByteArray(Charsets.UTF_8).size <= 128)
                val rawMode = boundedU32Long(2, "diagnostic sign mode").toInt()
                val mode = if (rawMode == 0) null else CitizenWalletSignMode.entries[rawMode - 1]
                val targetCount = boundedCount(1990, "cleanup account count")
                val wide = bool()
                check(targetCount > 0 || !wide)
                val ids = List(targetCount) { fixed(32) }
                fun less(a: ByteArray, b: ByteArray): Boolean {
                    for (i in a.indices) {
                        val first = a[i].toInt() and 255; val second = b[i].toInt() and 255
                        if (first != second) return first < second
                    }
                    return false
                }
                check(ids.zipWithNext().all { (a, b) -> less(a, b) })
                val targets = if (ids.isEmpty()) null else CitizenWalletCleanupTargets(ids, wide)
                CitizenWalletDiagnostic(index, name, account, address, reason, mode, targets)
            }
            check((initialization == 1) == (accounts.isNotEmpty() || diagnostics.isNotEmpty()) && !(initialization == 0 && cleanup))
            check(activeWalletIndex == null || walletIndices.contains(activeWalletIndex))
            return CitizenWalletState(revision, profile, accounts, initialization, cleanup, activeWalletIndex, diagnostics)
        }

        fun signingOutcome(): CitizenSigningOutcome {
            val status = u32Long()
            val account = fixed(32)
            val hash = fixed(32)
            return when (status) {
                1L -> CitizenSigningOutcome.Completed(account, hash, CitizenSignature(fixed(64)))
                2L -> CitizenSigningOutcome.ExternalPending(
                    account,
                    hash,
                    CitizenExternalSignerTransport.QR_V1,
                    u64Text(),
                    text().also { check(it.length in 16..128) },
                    text().also { check(it.toByteArray(Charsets.UTF_8).size in 1..2331) },
                )
                else -> error("unknown signing outcome status")
            }
        }

        fun defaultAccountChange(): CitizenDefaultAccountChangeOutcome {
            val status = u32Long()
            val account = fixed(32)
            val hash = fixed(32)
            return when (status) {
                1L -> CitizenDefaultAccountChangeOutcome.Completed(account, hash, u64Text())
                2L -> CitizenDefaultAccountChangeOutcome.ExternalPending(
                    account,
                    hash,
                    CitizenExternalSignerTransport.QR_V1,
                    u64Text(),
                    text().also { check(it.length in 16..128) },
                    text().also { check(it.toByteArray(Charsets.UTF_8).size in 1..2331) },
                )
                else -> error("unknown default account change status")
            }
        }

        fun walletAccounts(): List<CitizenWalletAccount> =
            walletAccounts(boundedCount(1990, "wallet account result count"))

        private fun walletAccounts(count: Int): List<CitizenWalletAccount> =
            ArrayList<CitizenWalletAccount>(count).also { accounts ->
                repeat(count) {
                    accounts += CitizenWalletAccount(
                        index = boundedU32Long(1989, "wallet account index"),
                        accountId = fixed(32),
                        ss58Address = text(),
                        name = if (bool()) text() else null,
                        createdAtMillis = u64Text(),
                        active = bool(),
                    )
                }
            }

        fun execution(): CitizenExecution {
            val status = oneBasedEnum(CitizenExecutionStatus.entries, "execution status")
            val reason = u32Long()
            val block = if (bool()) block() else null
            val index = if (bool()) u32Long() else null
            val hasModule = bool()
            val pallet = if (hasModule) u32Long() else null
            val error = if (hasModule) u32Long() else null
            return CitizenExecution(status, reason, block, index, pallet, error)
        }

        fun transactionExecution(): CitizenTransactionExecution {
            val status = u32Long()
            val id = "0x" + fixed(16).toHex()
            val source = fixed(32)
            val callHash = fixed(32)
            val transactionHash = fixed(32)
            val expires = u64Text()
            val execution = if (bool()) execution() else null
            val reason = if (bool()) text() else null
            val replacement = if (bool()) fixed(32) else null
            val request = if (bool()) text() else null
            return when (status) {
                1L -> {
                    check(transactionHash.all { it == 0.toByte() } && execution == null && reason == null && replacement == null)
                    CitizenTransactionExecution.ExternalSigningPending(
                        id, source, callHash, expires,
                        requireNotNull(request).also { check(it.toByteArray(Charsets.UTF_8).size in 1..65536) },
                    )
                }
                2L, 3L, 4L -> {
                    check(request == null)
                    val resolution = when (status) {
                        2L -> CitizenTransactionResolution.FINALIZED_SUCCESS
                        3L -> CitizenTransactionResolution.FINALIZED_FAILED
                        else -> CitizenTransactionResolution.POOL_REJECTED
                    }
                    CitizenTransactionExecution.Completed(
                        id, source, callHash, transactionHash, resolution,
                        execution, reason, replacement,
                    )
                }
                else -> error("unknown transaction execution status")
            }
        }

        fun transactionHistoryPage(): CitizenTransactionHistoryPage {
            val revision = u64Text()
            val recordCount = boundedCount(100, "transaction history record count")
            val records = ArrayList<CitizenTransactionHistoryRecord>(recordCount)
            repeat(recordCount) {
                records += CitizenTransactionHistoryRecord(
                    fixed(16), fixed(32), fixed(32), fixed(32),
                    oneBasedEnum(CitizenTransactionHistoryStatus.entries, "transaction history status"),
                    if (bool()) block() else null,
                    if (bool()) execution() else null,
                    if (bool()) fixed(32) else null,
                    u64Text(), u64Text(), if (bool()) text() else null,
                )
            }
            return CitizenTransactionHistoryPage(
                revision,
                records,
                if (bool()) fixed(16) else null,
            )
        }

        fun boundedCount(maximum: Int, label: String): Int {
            val value = u32Long()
            check(value <= maximum.toLong()) { "$label exceeds $maximum" }
            return value.toInt()
        }

        fun boundedU32Long(maximum: Long, label: String): Long {
            val value = u32Long()
            check(value <= maximum) { "$label exceeds $maximum" }
            return value
        }

        fun <T> oneBasedEnum(values: List<T>, label: String): T {
            val value = u32Long()
            check(value in 1..values.size.toLong()) { "$label is invalid: $value" }
            return values[(value - 1).toInt()]
        }

        fun <T> zeroBasedEnum(values: List<T>, label: String): T {
            val value = u32Long()
            check(value < values.size.toLong()) { "$label is invalid: $value" }
            return values[value.toInt()]
        }

        fun finish() = check(!buffer.hasRemaining()) { "JNI result has trailing bytes" }
    }

    private const val VERSION = 1
}

private fun ByteArray.toHex(): String = joinToString("") { byte ->
    (byte.toInt() and 0xff).toString(16).padStart(2, '0')
}
