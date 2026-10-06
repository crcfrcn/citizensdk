package org.citizen.sdk

import java.math.BigInteger

enum class CitizenSdkLifecycle { CREATED, IMPORTING_STATE, STARTING, RUNNING, START_FAILED, STOPPED, DISPOSED }
enum class CitizenFinality { BEST, FINALIZED }
enum class CitizenWalletOrigin { CREATED, IMPORTED }
enum class CitizenWalletSignMode { HOT, COLD }
/** 与Core闭集数值一一对应；文字展示由宿主决定。 */
enum class CitizenWalletInputReason {
    VALID, INPUT_TOO_LONG, WORD_COUNT, UNKNOWN_WORD, CHECKSUM,
    PASSWORD_FORMAT, MNEMONIC_FORMAT, PASSWORD_LENGTH, PASSWORD_NORMALIZATION,
}
data class CitizenWalletInputValidation(val reason: CitizenWalletInputReason, val position: Int?) {
    val isValid: Boolean get() = reason == CitizenWalletInputReason.VALID
}
enum class CitizenSigningTransform { RAW, SUBSTRATE_SIGNING_PAYLOAD, BLAKE2_DOMAIN }
enum class CitizenExternalSignerTransport { QR_V1 }
enum class CitizenTransactionResolution { FINALIZED_SUCCESS, FINALIZED_FAILED, POOL_REJECTED }
enum class CitizenTransactionHistoryStatus { PENDING, IN_BLOCK, POOL_REJECTED, FINALIZED_SUCCESS, FINALIZED_FAILED }
enum class CitizenExecutionStatus { SUCCESS, FAILED, UNVERIFIED }

enum class CitizenCapabilityName {
    CHAIN_READ,
    TRANSACTION_BUILD,
    TRANSACTION_SUBMIT,
    TRANSACTION_VERIFY,
    WALLET_PROFILE,
    LOCAL_SIGNING,
    HARDWARE_VAULT,
    USER_AUTHENTICATION,
    HISTORY,
    BACKGROUND_SYNC,
}

enum class CitizenCapabilityReason {
    NONE,
    BUILD_UNSUPPORTED,
    DEVICE_UNAVAILABLE,
    HOST_DISABLED,
    ENGINE_NOT_RUNNING,
    DEPENDENCY_NOT_READY,
    USER_AUTHENTICATION_REQUIRED,
    VAULT_LOCKED,
    CHAIN_STARTING,
    CHAIN_UNSYNCED,
    STORAGE_UNAVAILABLE,
}

/** Exact unsigned 128-bit value with a Java-safe decimal representation. */
class CitizenU128(decimal: String) {
    val decimal: String
    @get:JvmSynthetic
    internal val low: Long
    @get:JvmSynthetic
    internal val high: Long

    init {
        // A canonical u128 has at most 39 decimal digits. Reject by O(1)
        // String length before regex or BigInteger performs proportional work.
        require(decimal.length in 1..MAX_DECIMAL_DIGITS) { "u128 is out of range" }
        require(decimal.matches(Regex("0|[1-9][0-9]*"))) { "u128 must be canonical unsigned decimal" }
        val value = BigInteger(decimal)
        require(value.bitLength() <= 128) { "u128 is out of range" }
        this.decimal = value.toString()
        low = value.and(MASK_64).toLong()
        high = value.shiftRight(64).toLong()
    }

    internal constructor(low: Long, high: Long) : this(
        unsignedLong(high).shiftLeft(64).or(unsignedLong(low)).toString(),
    )

    override fun equals(other: Any?): Boolean = other is CitizenU128 && decimal == other.decimal
    override fun hashCode(): Int = decimal.hashCode()
    override fun toString(): String = decimal

    companion object {
        private const val MAX_DECIMAL_DIGITS = 39
        private val MASK_64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE)
        private fun unsignedLong(value: Long): BigInteger =
            BigInteger.valueOf(value and Long.MAX_VALUE).let {
                if (value < 0) it.setBit(63) else it
            }
    }
}

class CitizenBlockRef(
    hash: ByteArray,
    val number: String,
    val finality: CitizenFinality,
) {
    private val hashValue = hash.requireSize(32, "block hash")
    fun hash(): ByteArray = hashValue.clone()
}

class CitizenChainSyncStatus(
    val peerCount: String,
    val isSyncing: Boolean,
    val isUsable: Boolean,
    val best: CitizenBlockRef,
    val finalized: CitizenBlockRef,
)

class CitizenBlockHeader(
    val block: CitizenBlockRef,
    parentHash: ByteArray,
    stateRoot: ByteArray,
    extrinsicsRoot: ByteArray,
    digest: ByteArray,
) {
    private val parentValue = parentHash.requireSize(32, "parentHash")
    private val stateValue = stateRoot.requireSize(32, "stateRoot")
    private val extrinsicsValue = extrinsicsRoot.requireSize(32, "extrinsicsRoot")
    private val digestValue = digest.clone()
    fun parentHash(): ByteArray = parentValue.clone()
    fun stateRoot(): ByteArray = stateValue.clone()
    fun extrinsicsRoot(): ByteArray = extrinsicsValue.clone()
    fun digest(): ByteArray = digestValue.clone()
}

class CitizenBlockBody(
    val block: CitizenBlockRef,
    extrinsics: List<ByteArray>,
) {
    private val values = extrinsics.map(ByteArray::clone)
    fun extrinsics(): List<ByteArray> = values.map(ByteArray::clone)
}

class CitizenRuntimeContext(
    val block: CitizenBlockRef,
    val specVersion: Long,
    val transactionVersion: Long,
    metadata: ByteArray,
) {
    private val metadataValue = metadata.clone()
    fun metadata(): ByteArray = metadataValue.clone()
}

/** Explicit smoldot state transport only; this is not a legacy-app migration envelope. */
class CitizenChainState(
    val formatVersion: Long,
    val finalized: CitizenBlockRef,
    database: ByteArray,
) {
    init {
        require(formatVersion in 1..0xffff_ffffL) { "chain state format version must be nonzero uint32" }
        require(finalized.finality == CitizenFinality.FINALIZED) { "chain state anchor must be finalized" }
        require(database.isNotEmpty() && database.size <= 256 * 1024) { "chain state database is invalid" }
    }
    private val databaseValue = database.clone()
    fun database(): ByteArray = databaseValue.clone()
}

class CitizenCapabilityStatus(
    val name: CitizenCapabilityName,
    val reason: CitizenCapabilityReason,
    val supported: Boolean,
    val available: Boolean,
    val enabled: Boolean,
    val ready: Boolean,
)

class CitizenSdkCapabilities(
    val revision: String,
    statuses: List<CitizenCapabilityStatus>,
) {
    val statuses: List<CitizenCapabilityStatus> = statuses.toList()
}

class CitizenAccountBalance(
    val block: CitizenBlockRef,
    accountId: ByteArray,
    val freeFen: CitizenU128,
    val reservedFen: CitizenU128,
    val totalFen: CitizenU128,
) {
    private val accountIdValue = accountId.requireSize(32, "accountId")
    fun accountId(): ByteArray = accountIdValue.clone()
}

class CitizenAccountNonce(
    val bestBlock: CitizenBlockRef,
    accountId: ByteArray,
    val nonce: String,
) {
    private val accountIdValue = accountId.requireSize(32, "accountId")
    fun accountId(): ByteArray = accountIdValue.clone()
}

class CitizenFeeSnapshot(
    val bestBlock: CitizenBlockRef,
    val feeRateParts: Long,
    val minimumFeeFen: CitizenU128,
    val existentialDepositFen: CitizenU128,
)

class CitizenWalletAccount(
    val index: Long,
    accountId: ByteArray,
    val ss58Address: String,
    val name: String?,
    val createdAtMillis: String,
    val active: Boolean,
) {
    private val accountIdValue = accountId.requireSize(32, "accountId")
    fun accountId(): ByteArray = accountIdValue.clone()
}

class CitizenWalletProfile(
    val origin: CitizenWalletOrigin,
    val walletIndex: Long,
    val createdAtMillis: String,
    masterAccountId: ByteArray,
    activeAccountId: ByteArray,
    accounts: List<CitizenWalletAccount>,
    /** 钱包级标签独立于账户0的name。 */
    val walletName: String,
) {
    private val masterValue = masterAccountId.requireSize(32, "masterAccountId")
    private val activeValue = activeAccountId.requireSize(32, "activeAccountId")
    val accounts: List<CitizenWalletAccount> = accounts.toList()
    fun masterAccountId(): ByteArray = masterValue.clone()
    fun activeAccountId(): ByteArray = activeValue.clone()
}

class CitizenWalletStateAccount(
    val signMode: CitizenWalletSignMode,
    val walletIndex: Long,
    val accountIndex: Long?,
    accountId: ByteArray,
    val ss58Address: String,
    val name: String,
    val createdAtMillis: String,
    val isDefault: Boolean,
) {
    private val accountIdValue = accountId.requireSize(32, "accountId")
    fun accountId(): ByteArray = accountIdValue.clone()
}

/** Core精确校验的公开关联；不能作为绕过原删除校验的权限。 */
class CitizenWalletCleanupTargets(accountIds: List<ByteArray>, val deleteWalletWideKey: Boolean) {
    private val identities = accountIds.map { it.requireSize(32, "accountId") }
    fun accountIds(): List<ByteArray> = identities.map { it.clone() }
}

/** 同次快照的异常事实，不参与普通签名；字节身份对外只返回副本。 */
class CitizenWalletDiagnostic(
    val walletIndex: Long,
    val walletName: String,
    accountId: ByteArray,
    val ss58Address: String?,
    val diagnosticReason: Int,
    val signMode: CitizenWalletSignMode?,
    val cleanupTargets: CitizenWalletCleanupTargets?,
) {
    private val identity = accountId.requireSize(32, "accountId")
    fun accountId(): ByteArray = identity.clone()
}

class CitizenWalletState(
    val revision: String,
    val hotProfile: CitizenWalletProfile?,
    accounts: List<CitizenWalletStateAccount>,
    val initializationState: Int,
    val cleanupPending: Boolean,
    /** 独立付款选择，不代表默认账户或热钱包activeAccountId。 */
    val activeWalletIndex: Long?,
    diagnostics: List<CitizenWalletDiagnostic> = emptyList(),
) {
    val diagnostics: List<CitizenWalletDiagnostic> = diagnostics.toList()
    val accounts: List<CitizenWalletStateAccount> = accounts.toList()
    val defaultAccount: CitizenWalletStateAccount? get() = accounts.firstOrNull()
}

class CitizenSignature(signature: ByteArray) {
    private val value = signature.requireSize(64, "sr25519 signature")
    fun bytes(): ByteArray = value.clone()
}

class CitizenSigningIntent(
    accountId: ByteArray,
    payload: ByteArray,
    val transform: CitizenSigningTransform,
    domain: ByteArray = byteArrayOf(),
    val externalSignerTransport: CitizenExternalSignerTransport? = null,
    val opaqueAction: Int = 0,
    val ttlSeconds: Long = 120,
) {
    private val accountValue = accountId.requireSize(32, "accountId")
    private val payloadValue = payload.clone()
    private val domainValue = domain.clone()

    init {
        require(payloadValue.isNotEmpty() && payloadValue.size <= 16 * 1024 * 1024)
        require(opaqueAction in 0..0xffff && ttlSeconds in 1..300)
        require(
            (transform == CitizenSigningTransform.BLAKE2_DOMAIN && domainValue.size in 1..32) ||
                (transform != CitizenSigningTransform.BLAKE2_DOMAIN && domainValue.isEmpty()),
        )
    }

    fun accountId(): ByteArray = accountValue.clone()
    fun payload(): ByteArray = payloadValue.clone()
    fun domain(): ByteArray = domainValue.clone()
}

sealed class CitizenSigningOutcome(
    accountId: ByteArray,
    payloadHash: ByteArray,
) {
    private val accountValue = accountId.requireSize(32, "accountId")
    private val hashValue = payloadHash.requireSize(32, "payloadHash")
    fun accountId(): ByteArray = accountValue.clone()
    fun payloadHash(): ByteArray = hashValue.clone()

    class Completed(
        accountId: ByteArray,
        payloadHash: ByteArray,
        val signature: CitizenSignature,
    ) : CitizenSigningOutcome(accountId, payloadHash)

    class ExternalPending(
        accountId: ByteArray,
        payloadHash: ByteArray,
        val transport: CitizenExternalSignerTransport,
        val expiresAt: String,
        val sessionId: String,
        val transportRequest: String,
    ) : CitizenSigningOutcome(accountId, payloadHash)
}

sealed class CitizenDefaultAccountChangeOutcome(
    currentDefaultAccountId: ByteArray,
    payloadHash: ByteArray,
) {
    private val currentValue = currentDefaultAccountId.requireSize(32, "currentDefaultAccountId")
    private val hashValue = payloadHash.requireSize(32, "payloadHash")
    fun currentDefaultAccountId(): ByteArray = currentValue.clone()
    fun payloadHash(): ByteArray = hashValue.clone()

    class Completed(
        currentDefaultAccountId: ByteArray,
        payloadHash: ByteArray,
        val committedRevision: String,
    ) : CitizenDefaultAccountChangeOutcome(currentDefaultAccountId, payloadHash)

    class ExternalPending(
        currentDefaultAccountId: ByteArray,
        payloadHash: ByteArray,
        val transport: CitizenExternalSignerTransport,
        val expiresAt: String,
        val sessionId: String,
        val transportRequest: String,
    ) : CitizenDefaultAccountChangeOutcome(currentDefaultAccountId, payloadHash)
}

class CitizenExecution(
    val status: CitizenExecutionStatus,
    val reasonOrDispatchVariant: Long,
    val block: CitizenBlockRef?,
    val extrinsicIndex: Long?,
    val palletIndex: Long?,
    val errorIndex: Long?,
)

/** Safe projection of an SDK-owned opaque transaction preparation. */
class CitizenPreparedTransaction internal constructor(
    val preparationId: String,
    sourceAccountId: ByteArray,
    callDataHash: ByteArray,
    val bestBlock: CitizenBlockRef,
    val runtimeSpecNumber: Long,
    val transactionFormatNumber: Long,
    val nonce: String,
) {
    private val sourceValue = sourceAccountId.requireSize(32, "sourceAccountId")
    private val callHashValue = callDataHash.requireSize(32, "callDataHash")
    fun sourceAccountId(): ByteArray = sourceValue.clone()
    fun callDataHash(): ByteArray = callHashValue.clone()
}

sealed class CitizenTransactionExecution(
    val executionId: String,
    sourceAccountId: ByteArray,
    callDataHash: ByteArray,
) {
    private val sourceValue = sourceAccountId.requireSize(32, "sourceAccountId")
    private val callHashValue = callDataHash.requireSize(32, "callDataHash")
    fun sourceAccountId(): ByteArray = sourceValue.clone()
    fun callDataHash(): ByteArray = callHashValue.clone()

    class ExternalSigningPending internal constructor(
        executionId: String,
        sourceAccountId: ByteArray,
        callDataHash: ByteArray,
        val expiresAt: String,
        val qrRequest: String,
    ) : CitizenTransactionExecution(executionId, sourceAccountId, callDataHash)

    class Completed internal constructor(
        executionId: String,
        sourceAccountId: ByteArray,
        callDataHash: ByteArray,
        transactionHash: ByteArray,
        val resolution: CitizenTransactionResolution,
        val execution: CitizenExecution?,
        val poolRejectionReason: String?,
        replacementHash: ByteArray?,
    ) : CitizenTransactionExecution(executionId, sourceAccountId, callDataHash) {
        private val transactionHashValue = transactionHash.requireSize(32, "transactionHash")
        private val replacementHashValue = replacementHash?.requireSize(32, "replacementHash")
        fun transactionHash(): ByteArray = transactionHashValue.clone()
        fun replacementHash(): ByteArray? = replacementHashValue?.clone()
    }
}

/** Product-independent public projection of one SDK-submitted transaction. */
class CitizenTransactionHistoryRecord(
    executionId: ByteArray,
    sourceAccountId: ByteArray,
    callDataHash: ByteArray,
    transactionHash: ByteArray,
    val status: CitizenTransactionHistoryStatus,
    val block: CitizenBlockRef?,
    val execution: CitizenExecution?,
    replacementHash: ByteArray?,
    val createdAtMillis: String,
    val updatedAtMillis: String,
    val poolRejectionReason: String?,
) {
    private val executionIdValue = executionId.requireSize(16, "executionId")
    private val sourceValue = sourceAccountId.requireSize(32, "sourceAccountId")
    private val callHashValue = callDataHash.requireSize(32, "callDataHash")
    private val transactionHashValue = transactionHash.requireSize(32, "transactionHash")
    private val replacementHashValue = replacementHash?.requireSize(32, "replacementHash")
    fun executionId(): ByteArray = executionIdValue.clone()
    fun sourceAccountId(): ByteArray = sourceValue.clone()
    fun callDataHash(): ByteArray = callHashValue.clone()
    fun transactionHash(): ByteArray = transactionHashValue.clone()
    fun replacementHash(): ByteArray? = replacementHashValue?.clone()
}

/** Newest-first deterministic page from the SDK's execution-only store. */
class CitizenTransactionHistoryPage(
    val revision: String,
    records: List<CitizenTransactionHistoryRecord>,
    nextBeforeExecutionId: ByteArray?,
) {
    val records: List<CitizenTransactionHistoryRecord> = records.toList()
    private val nextValue = nextBeforeExecutionId?.requireSize(16, "nextBeforeExecutionId")
    fun nextBeforeExecutionId(): ByteArray? = nextValue?.clone()
}

internal fun ByteArray.requireSize(expected: Int, label: String): ByteArray {
    require(size == expected) { "$label must contain exactly $expected bytes" }
    return clone()
}

internal fun requireU64(value: String, label: String): ULong {
    require(value.length in 1..20 && value.matches(Regex("0|[1-9][0-9]*"))) {
        "$label must be canonical unsigned decimal"
    }
    return value.toULong()
}

/** 仅投影 Rust 模块位集合；依赖与非法组合由核心统一判定。 */
object CitizenSdkModules {
    const val WALLET = 1
    const val SIGNING = 2
    const val CHAIN = 4
    const val TRANSACTIONS = 8
    const val HISTORY = 16
    const val QR = 32
    const val FULL = 63
}
