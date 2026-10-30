package org.citizen.sdk

import org.citizen.sdk.internal.Bindings
import org.citizen.sdk.internal.CitizenSdkCalls
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.ByteOrder
import android.content.Context
import androidx.fragment.app.FragmentActivity
import org.citizen.sdk.internal.CitizenSdkAssets
import org.citizen.sdk.internal.CitizenSdkHostServices
import org.citizen.sdk.internal.CoreResult
import org.citizen.sdk.internal.CitizenSdkRequestRouter
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ConcurrentHashMap

/** 同实例真实快照的受控资源；方法接纳和释放互斥，句柄不进入公开接口。 */
class CitizenWalletInspection internal constructor(
    private val owner: CitizenSdk,
    result: Long,
    val state: CitizenWalletState,
    private val change: (CitizenWalletInspection, Int, Long, String?) -> CitizenSdkOperation<CitizenWalletState>,
    private val released: (CitizenWalletInspection) -> Unit,
) : AutoCloseable {
    private val gate = Any()
    private var handle = result
    @JvmSynthetic internal fun <T> withHandle(owner: CitizenSdk, body: (Long) -> T): T = synchronized(gate) {
        if (owner !== this.owner || handle == 0L) throw CitizenSdkException(CitizenSdkErrorCode.INVALID_STATE, "钱包检查资源已释放或跨实例")
        body(handle)
    }
    fun repairHot(walletIndex: Long): CitizenSdkOperation<CitizenWalletState> = change(this, 1, walletIndex, null)
    fun rename(walletIndex: Long, name: String): CitizenSdkOperation<CitizenWalletState> = change(this, 2, walletIndex, name)
    fun delete(walletIndex: Long): CitizenSdkOperation<CitizenWalletState> = change(this, 3, walletIndex, null)
    fun release() = close()
    override fun close() = synchronized(gate) {
        if (handle != 0L) {
            owner.releaseWalletInspection(handle)
            handle = 0
            released(this)
        }
    }
}

/**
 * 同一Core实例的Kotlin接口；原生句柄不进入公开API。
 * 准备、恢复词和显式取钥由真实受控资源拥有；明确的输入可短时携带秘密并按原规则清零。
 */
class CitizenSdk private constructor(
    context: Context,
    listener: CitizenSdkEvents.Listener?,
    modules: Int,
) : AutoCloseable {
    val sessionId: String = UUID.randomUUID().toString()

    private val lifecycleGate = Any()
    private val closed = AtomicBoolean(false)
    private val selectedModules = modules
    private val closing = AtomicBoolean(false)
    private var closeActive = false
    private val hostServices = CitizenSdkHostServices(context.applicationContext, modules)
    // 链实例创建前把应用 Context 交给同一个 JNI 所有者初始化 Android 系统证书验证器。
    private val calls = CitizenSdkCalls()
    private val assets = if (modules and CitizenSdkModules.CHAIN != 0) CitizenSdkAssets.load(context.applicationContext) else null
    private val bridge = Bindings.nativeCreate(
        context.applicationContext, hostServices,
        assets?.manifest ?: byteArrayOf(), assets?.chainSpec ?: byteArrayOf(), assets?.lightSyncState ?: byteArrayOf(), modules,
    )
    @Volatile private var eventSink: ((CitizenSdkEvents.Event) -> Unit)? = null

    private val requests=CitizenSdkRequestRouter { request -> call{Bindings.nativeCancel(it,request)} }

    /** Only this handles are retained; the public preparation identity is never a Core handle. */
    private val preparedTransactions = ConcurrentHashMap<String, Long>()
    private val privateKeys = ConcurrentHashMap.newKeySet<CitizenSdkPrivateKey>()
    private val preparedWallets = ConcurrentHashMap.newKeySet<CitizenSdkPreparedWallet>()
    private val qrReviews = ConcurrentHashMap.newKeySet<CitizenQrReview>()
    private val walletInspections = ConcurrentHashMap.newKeySet<CitizenWalletInspection>()
    private val qrCaptures = ConcurrentHashMap.newKeySet<CitizenSdkQrCapture>()

    @Volatile
    private var eventListener: CitizenSdkEvents.Listener? = listener

    @Volatile
    var lifecycle: CitizenSdkLifecycle = (call { lifecycleFromValue(Bindings.nativeLifecycle(it)) })
        private set

    // Dynamic Activity readiness is a generation, not an untracked fire-and-
    // forget request. Edges coalesce; BUSY retries after the accepted request
    // that owns the exclusive Core gate reaches terminal completion.
    private var readinessDesiredGeneration = 0L
    private var readinessAppliedGeneration = 0L
    private var readinessInFlight = false
    private var readinessRetryPending = false
    private var readinessConvergence = CompletableFuture.completedFuture<Void>(null)

    init {
        try {
            eventSink = { event ->
                if (event is CitizenSdkEvents.Event.LifecycleChanged) {
                    lifecycle = event.lifecycle
                }
                if (event is CitizenSdkEvents.Event.WalletChanged) {
                    privateKeys.toList().forEach { resource ->
                        CompletableFuture.runAsync { resource.close() }
                    }
                }
                eventListener?.onEvent(event)
            }
            call { Bindings.nativeBind(it, this) }
            hostServices.setActivityReadinessListener {
                readinessChanged()
            }
            readinessChanged()
        } catch (error: Throwable) {
            runCatching { run {
        calls.close {
            Bindings.nativeDestroy(bridge)

            eventSink = null
        }
     } }
            runCatching { requests.close() }
            runCatching { hostServices.close() }
            closed.set(true)
            throw error
        }
    }

    fun setEventListener(listener: CitizenSdkEvents.Listener?) {
        synchronized(lifecycleGate) {
            requireOpen()
            eventListener = listener
        }
    }

    fun attachActivity(activity: FragmentActivity) {
        synchronized(lifecycleGate) {
            requireOpen()
            hostServices.attachActivity(activity)
        }
    }

    fun detachActivity(activity: FragmentActivity) {
        synchronized(lifecycleGate) {
            if (!closed.get()) {
                privateKeys.toList().forEach { it.close() }
                closeQrCaptures()
                hostServices.detachActivity(activity)
            }
        }
    }

    /** 与其他平台一致，直接提交原生启动；并发准入及失败由Core判断，不等待能力刷新。 */
    @JvmSynthetic
    @androidx.annotation.RestrictTo(androidx.annotation.RestrictTo.Scope.LIBRARY_GROUP)
    fun detachFfi() { if(!closed.get()) (call { Bindings.nativeDetachFfi(it) }) }
    @JvmSynthetic
    @androidx.annotation.RestrictTo(androidx.annotation.RestrictTo.Scope.LIBRARY_GROUP)
    fun ffiHandle(): Long = synchronized(lifecycleGate) { requireOpen();(call { Bindings.nativeCoreHandle(it) }) }
    fun start(): CompletableFuture<Void> = unitRequest({ (call { Bindings.nativeStart(it) }) })

    /** 直接提交原生停止，Future仍等待原生检查点及排空完成，不把提交当作停止成功。 */
    fun stop(): CompletableFuture<Void> = unitRequest({ (call { Bindings.nativeStop(it) }) })

    /** 通道关联仅由Core接纳；绑定不保存第二份接收序号。 */
    @JvmSynthetic
    internal fun acceptRequestSequence(sequence: Long) = synchronized(lifecycleGate) {
        requireOpen()
        (call { Bindings.nativeAcceptRequestSequence(it, sequence) })
    }

    fun getCapabilities(): CitizenSdkCapabilities {
        return synchronized(lifecycleGate) {
            requireOpen()
            (call {
        Bindings.nativeCapabilities(it)
    })
        }
    }

    fun getFinalizedHead(): CompletableFuture<CitizenBlockRef> =
        request({ (call { Bindings.nativeGetFinalizedHead(it) }) }) { (it.value as CitizenBlockRef) }

    fun getSyncStatus(): CompletableFuture<CitizenChainSyncStatus> =
        request({ (call { Bindings.nativeGetSyncStatus(it) }) }) { (it.value as CitizenChainSyncStatus) }

    fun getBestHead(): CompletableFuture<CitizenBlockRef> =
        request({ (call { Bindings.nativeGetBestHead(it) }) }) { (it.value as CitizenBlockRef) }

    fun getFinalizedBlockAt(number: String): CompletableFuture<CitizenBlockRef> {
        requireU64(number, "block number")
        return request({ (call {
        Bindings.nativeGetFinalizedBlockAt(it, number.toULong().toLong())
    }) }) {
            (it.value as CitizenBlockRef)
        }
    }

    fun resolveFinalizedBlock(hash: ByteArray, number: String): CompletableFuture<CitizenBlockRef> {
        requireU64(number, "block number")
        val checkedHash = hash.requireSize(32, "block hash")
        return request({ (call {
        Bindings.nativeResolveFinalizedBlock(it, checkedHash.requireSize(32, "block hash"), number.toULong().toLong())
    }) }) {
            (it.value as CitizenBlockRef)
        }
    }

    fun getBlockHeader(block: CitizenBlockRef): CompletableFuture<CitizenBlockHeader> =
        request({ (call {
        Bindings.nativeGetBlockHeader(it, block.hash(), block.number.toULong().toLong(), block.finality.nativeValue())
    }) }) { (it.value as CitizenBlockHeader) }

    fun getBlockBody(block: CitizenBlockRef): CompletableFuture<CitizenBlockBody> =
        request({ (call {
        Bindings.nativeGetBlockBody(it, block.hash(), block.number.toULong().toLong(), block.finality.nativeValue())
    }) }) { (it.value as CitizenBlockBody) }

    fun getRuntimeContext(block: CitizenBlockRef): CompletableFuture<CitizenRuntimeContext> =
        request({ (call {
        Bindings.nativeGetRuntimeContext(it, block.hash(), block.number.toULong().toLong(), block.finality.nativeValue())
    }) }) { (it.value as CitizenRuntimeContext) }

    fun getStorage(block: CitizenBlockRef, key: ByteArray): CompletableFuture<ByteArray?> {
        CitizenSdkInputLimits.requireStorageKey(key)
        val copied = key.clone()
        return request({ (call {
        Bindings.nativeGetStorage(it, block.hash(), block.number.toULong().toLong(), block.finality.nativeValue(), copied)
    }) }) {
            (it.value as ByteArray?)?.clone()
        }
    }

    fun getStorageBatch(block: CitizenBlockRef, keys: List<ByteArray>): CompletableFuture<List<ByteArray?>> {
        CitizenSdkInputLimits.requireStorageKeys(keys)
        val copied = keys.map(ByteArray::clone).toTypedArray()
        return request({ (call {
        Bindings.nativeGetStorageBatch(it, block.hash(), block.number.toULong().toLong(), block.finality.nativeValue(), copied)
    }) }) {
            (it.value as List<ByteArray?>).map { value -> value?.clone() }
        }
    }

    fun getStorageKeysPaged(
        finalizedBlock: CitizenBlockRef,
        prefix: ByteArray,
        startKey: ByteArray? = null,
        limit: Int = 1000,
    ): CompletableFuture<List<ByteArray>> {
        require(finalizedBlock.finality == CitizenFinality.FINALIZED) {
            "storage keys page requires finalized block"
        }
        require(prefix.size in 1..4096 && (startKey == null || startKey.size in 1..4096)) {
            "storage keys page prefix/start key is invalid"
        }
        require(limit in 1..1000) { "storage keys page limit must be 1..1000" }
        val prefixCopy = prefix.clone()
        val startCopy = startKey?.clone()
        return request({ (call {
        Bindings.nativeGetStorageKeysPaged(
            it, finalizedBlock.hash(), finalizedBlock.number.toULong().toLong(), finalizedBlock.finality.nativeValue(),
            prefixCopy, startCopy, limit,
        )
    }) }) {
            (it.value as List<ByteArray?>).map { value ->
                requireNotNull(value).clone()
            }
        }
    }

    fun callRuntimeApi(
        block: CitizenBlockRef,
        method: String,
        arguments: ByteArray,
    ): CompletableFuture<ByteArray> {
        require(method.toByteArray(Charsets.UTF_8).size in 1..128 &&
            Regex("^[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+$").matches(method)) {
            "runtime API method is invalid"
        }
        require(arguments.size <= 1024 * 1024) { "runtime API arguments exceed 1 MiB" }
        val copy = arguments.clone()
        return request({ (call {
        Bindings.nativeCallRuntimeApi(
            it, block.hash(), block.number.toULong().toLong(), block.finality.nativeValue(),
            method.toByteArray(Charsets.UTF_8), copy,
        )
    }) }) {
            requireNotNull((it.value as ByteArray?)).clone()
        }
    }

    fun getSystemEvents(finalizedBlock: CitizenBlockRef): CompletableFuture<ByteArray?> {
        require(finalizedBlock.finality == CitizenFinality.FINALIZED) { "System.Events requires finalized block" }
        return request({ (call {
        Bindings.nativeGetSystemEvents(it, finalizedBlock.hash(), finalizedBlock.number.toULong().toLong(), finalizedBlock.finality.nativeValue())
    }) }) {
            (it.value as ByteArray?)?.clone()
        }
    }




    fun exportState(): CompletableFuture<CitizenChainState> =
        request({ (call { Bindings.nativeExportState(it) }) }) { (it.value as CitizenChainState) }

    fun importState(state: CitizenChainState): CompletableFuture<Void> {
        require(state.formatVersion in 1..0xffff_ffffL) { "chain state formatVersion is invalid" }
        require(state.finalized.finality == CitizenFinality.FINALIZED) { "chain state anchor must be finalized" }
        require(state.database().size in 1..256 * 1024) { "chain state database is invalid" }
        val source = request({ (call {
        Bindings.nativeImportState(
            it, state.formatVersion.toInt(), state.finalized.hash(),
            state.finalized.number.toULong().toLong(), state.finalized.finality.nativeValue(),
            state.database(),
        )
    }) }) {
            val imported = (it.value as? CitizenBlockRef) ?: throw CitizenSdkException(
                CitizenSdkErrorCode.INTEGRITY,
                "Core returned a non-block result for state import",
            )
            if (imported.finality != CitizenFinality.FINALIZED ||
                imported.number != state.finalized.number ||
                !imported.hash().contentEquals(state.finalized.hash())
            ) throw CitizenSdkException(
                CitizenSdkErrorCode.INTEGRITY,
                "Core imported-state receipt does not match its finalized anchor",
            )
            Unit
        }
        val target = CompletableFuture<Void>()
        source.whenComplete { _, error ->
            if (error == null) target.complete(null) else target.completeExceptionally(error)
        }
        return target
    }

    /** 返回 Core 固定链身份，不要求轻节点启动或同步，也不读取钱包金库。 */
    fun getGenesisHash(): ByteArray = synchronized(lifecycleGate) {
        requireOpen()
        (call { Bindings.nativeGetGenesisHash(it) }).requireSize(32, "genesisHash")
    }

    fun getAccountBalance(accountId: ByteArray): CompletableFuture<CitizenAccountBalance> =
        request({ run { val nativeArg0 = accountId.requireSize(32, "accountId"); call { Bindings.nativeGetAccountBalance(it, nativeArg0) } } }) {
            (it.value as CitizenAccountBalance)
        }

    /** 同一已验证 finalized 块的批量余额；保留顺序和重复项，空列表仍提交 Core。 */
    fun getAccountBalances(accountIds: List<ByteArray>): CompletableFuture<List<CitizenAccountBalance>> {
        CitizenSdkInputLimits.requireBalanceAccountCount(accountIds.size)
        val checked = accountIds.map { it.requireSize(32, "accountId") }.toTypedArray()
        return request({ (call { Bindings.nativeGetAccountBalances(it, flattenAccounts(checked), checked.size) }) }) {
            val values = (it.value as? List<CitizenAccountBalance>)
                ?: throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "Core returned an invalid balance result kind")
            values
        }
    }

    fun getAccountNonce(accountId: ByteArray): CompletableFuture<CitizenAccountNonce> =
        request({ run { val nativeArg0 = accountId.requireSize(32, "accountId"); call { Bindings.nativeGetAccountNonce(it, nativeArg0) } } }) {
            (it.value as CitizenAccountNonce)
        }

    fun getFeeSnapshot(): CompletableFuture<CitizenFeeSnapshot> =
        request({ (call { Bindings.nativeGetFeeSnapshot(it) }) }) { (it.value as CitizenFeeSnapshot) }

    /** 所有目录事实均来自同一次Core快照，冷钱包同样满足初始化门禁。 */
    fun getWalletState(): CitizenSdkOperation<CitizenWalletState> =
        requestOperation({ (call { Bindings.nativeGetWalletState(it) }) }) { (it.value as CitizenWalletState) }

    fun inspectWallets(): CitizenSdkOperation<CitizenWalletInspection> =
        requestOperation({ (call { Bindings.nativeInspectWallets(it) }) }) { result ->
            val value=result.value as CitizenWalletState
            CitizenWalletInspection(this,result.handle,value,::changeDiagnostic){walletInspections.remove(it)}
                .also{walletInspections.add(it);result.keep()}

        }

    private fun changeDiagnostic(inspection: CitizenWalletInspection, action: Int, index: Long, name: String?): CitizenSdkOperation<CitizenWalletState> =
        synchronized(lifecycleGate) {
            requireOpen()
            require(index in 0..0xffffffffL)
            val normalized = name?.let(::checkedAccountName)
            // 锁顺序与close一致：实例生命周期门在前，资源门在后。
            inspection.withHandle(this) { token ->
                requestOperation({ (call { Bindings.nativeChangeDiagnostic(it, token, index, action, normalized?.toByteArray(Charsets.UTF_8)) }) }) {
                    (it.value as CitizenWalletState)
                }
            }
        }

    fun importColdAccount(accountId: ByteArray, name: String = ""): CitizenSdkOperation<CitizenWalletState> {
        val normalized = if (name.isEmpty()) "" else checkedAccountName(name)
        return requestOperation({ run { val nativeArg0 = accountId.requireSize(32, "accountId"); call { Bindings.nativeImportColdAccountId(it, nativeArg0, normalized.toByteArray(Charsets.UTF_8)) } } }) {
            (it.value as CitizenWalletState)
        }
    }

    fun importColdAccount(ss58Address: String, name: String = ""): CitizenSdkOperation<CitizenWalletState> {
        require(ss58Address.isNotEmpty() && ss58Address.toByteArray(Charsets.UTF_8).size <= 64) {
            "cold account SS58 is invalid"
        }
        val normalized = if (name.isEmpty()) "" else checkedAccountName(name)
        return requestOperation({ (call {
        Bindings.nativeImportColdAccountSs58(it, ss58Address.toByteArray(Charsets.UTF_8), normalized.toByteArray(Charsets.UTF_8))
    }) }) {
            (it.value as CitizenWalletState)
        }
    }

    /** 扫码导入只接纳账户码，不把用户码或其它码型当作账户输入。 */
    fun importColdAccountCode(code: String, name: String = ""): CitizenSdkOperation<CitizenWalletState> {
        val content = parseForPurpose(code, CitizenQrScanPurpose.COLD_ACCOUNT_IMPORT).document.content as? CitizenQrDocument.Content.AccountId
            ?: throw CitizenSdkException(CitizenSdkErrorCode.INVALID_ARGUMENT, "QR code is not an account code")
        val bytes = ByteArray(32) { index -> content.accountId.substring(2 + index * 2, 4 + index * 2).toInt(16).toByte() }
        return importColdAccount(bytes, name)
    }

    fun reorderWalletAccountsWithoutDefaultChange(
        expectedRevision: String,
        accountIds: List<ByteArray>,
    ): CitizenSdkOperation<CitizenWalletState> {
        require(accountIds.size in 1..CitizenSdkInputLimits.MAX_WALLET_CATALOG_ACCOUNTS) { "wallet catalog exceeds structural count boundary" }
        val revision = java.lang.Long.parseUnsignedLong(expectedRevision)
        val checked = accountIds.map { it.requireSize(32, "accountId") }.toTypedArray()
        return requestOperation({ (call { Bindings.nativeReorderWalletAccounts(it, revision, flattenAccounts(checked), checked.size) }) }) {
            (it.value as CitizenWalletState)
        }
    }

    /** 唯一Core同修订CAS；不触发默认账户授权或金库访问。 */
    fun setActiveWallet(expectedRevision: String, walletIndex: Long): CitizenSdkOperation<CitizenWalletState> {
        require(walletIndex in 0..0xffffffffL)
        require(Regex("^(0|[1-9][0-9]*)$").matches(expectedRevision))
        val revision = java.lang.Long.parseUnsignedLong(expectedRevision)
        return requestOperation({ (call { Bindings.nativeSetActiveWallet(it, revision, walletIndex) }) }) { (it.value as CitizenWalletState) }
    }

    fun renameWallet(expectedRevision: String, walletIndex: Long, name: String): CitizenSdkOperation<CitizenWalletState> {
        require(walletIndex in 0..0xffffffffL)
        require(Regex("^(0|[1-9][0-9]*)$").matches(expectedRevision))
        val revision = java.lang.Long.parseUnsignedLong(expectedRevision)
        val normalized = checkedAccountName(name)
        return requestOperation({ (call { Bindings.nativeRenameWallet(it, revision, walletIndex, normalized.toByteArray(Charsets.UTF_8)) }) }) { (it.value as CitizenWalletState) }
    }

    fun renameAccount(accountId: ByteArray, name: String): CitizenSdkOperation<CitizenWalletState> {
        val normalized = checkedAccountName(name)
        return requestOperation({ run { val nativeArg0 = accountId.requireSize(32, "accountId"); call { Bindings.nativeRenameAccount(it, nativeArg0, normalized.toByteArray(Charsets.UTF_8)) } } }) {
            (it.value as CitizenWalletState)
        }
    }

    fun deleteAccount(accountId: ByteArray): CitizenSdkOperation<CitizenWalletState> =
        requestOperation({ run { val nativeArg0 = accountId.requireSize(32, "accountId"); call { Bindings.nativeDeleteAccount(it, nativeArg0) } } }) {
            (it.value as CitizenWalletState)
        }

    fun setActiveWalletAccount(accountId: ByteArray): CitizenSdkOperation<CitizenWalletProfile> =
        requestOperation({ run { val nativeArg0 = accountId.requireSize(32, "accountId"); call { Bindings.nativeSetActiveWalletAccount(it, nativeArg0) } } }) {
            requireWalletProfile(it, "set active wallet account")
        }

    /** 胁迫/PIN清除不追加认证；用户主动“签名并删除”使用独立授权入口。 */
    fun deleteWallet(): CitizenSdkOperation<Unit> = emptyOperation { (call { Bindings.nativeDeleteWallet(it) }) }
    fun signAndDeleteWallet(): CitizenSdkOperation<Unit> = emptyOperation { (call { Bindings.nativeSignAndDeleteWallet(it) }) }

    /** 清理完成后读公开profile；取消只转交当前真实请求，不提前完成结果。 */
    fun reconcileWalletCleanup(): CitizenSdkOperation<CitizenWalletProfile?> {
        val cleanup = emptyOperation { (call { Bindings.nativeReconcileWalletCleanup(it) }) }
        val current = java.util.concurrent.atomic.AtomicReference<() -> Boolean>(cleanup::cancel)
        val result = cleanup.future.thenCompose {
            val read = requestOperation({ (call { Bindings.nativeGetWalletProfile(it) }) }) { (it.value as CitizenWalletProfile?) }
            current.set(read::cancel)
            read.future
        }
        return CitizenSdkOperation(cleanup.operationId, result) { current.get().invoke() }
    }

    /** 通用签名只接收不透明载荷；应用业务语义不会进入 SDK。 */


    /**
     * SDK 钱包的默认账户变更。完整有序账户集由旧默认账户授权；应用不能指定
     * 签名者、签名域、QR action 或绕过 CAS 直接设置默认账户。
     */
    fun beginDefaultAccountChange(
        expectedRevision: String,
        orderedAccountIds: List<ByteArray>,
        ttlSeconds: Long = 120,
    ): CitizenSdkOperation<CitizenDefaultAccountChangeOutcome> {
        require(orderedAccountIds.size in 1..256) {
            "default-account change must contain 1..256 accounts"
        }
        require(ttlSeconds in 1..300) { "ttlSeconds must be in 1..300" }
        val revision = java.lang.Long.parseUnsignedLong(expectedRevision)
        val checked = orderedAccountIds.map {
            it.requireSize(32, "accountId")
        }.toTypedArray()
        return requestOperation({ (call {
        Bindings.nativeBeginDefaultAccountChange(
            it, revision, flattenAccounts(checked), checked.size, ttlSeconds,
        )
    }) }) {
            (it.value as? CitizenDefaultAccountChangeOutcome)
                ?: throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned an invalid default-account-change result kind",
                )
        }
    }

    fun consumeDefaultAccountChange(
        sessionId: String,
        response: String,
    ): CitizenSdkOperation<CitizenDefaultAccountChangeOutcome> {
        requireExternalSigningText(sessionId, response)
        return requestOperation({ (call {
        Bindings.nativeConsumeDefaultAccountChange(
            it,
            sessionId.toByteArray(Charsets.UTF_8),
            response.toByteArray(Charsets.UTF_8),
        )
    }) }) {
            (it.value as? CitizenDefaultAccountChangeOutcome)
                ?: throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned an invalid default-account-change result kind",
                )
        }
    }

    /** QR 协议与会话都由 Rust 处理；图像编解码在五端共同使用 ZXing-C++。 */
    fun parseForPurpose(text: String, purpose: CitizenQrScanPurpose): CitizenQrScanResult =
        CitizenQrScanResult.forPurpose(qrParse(text), purpose)

    /** 宿主只提供预览纹理和监听器；权限、CameraX、帧识别及资源释放均由SDK管理。 */
    fun openCapture(
        activity: FragmentActivity,
        texture: android.graphics.SurfaceTexture,
        purpose: CitizenQrScanPurpose,
        listener: CitizenSdkQrCapture.Listener,
    ): CompletableFuture<CitizenSdkQrCapture> = synchronized(lifecycleGate) {
        requireOpen(); requireQrModule()
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) { "camera admission requires main thread" }
        if (activity.isDestroyed || activity.isFinishing) throw CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera host is unavailable")
        val resource = CitizenSdkQrCapture(this, activity, texture, purpose, listener)
        qrCaptures.add(resource)
        resource.closed.whenComplete { _, _ -> qrCaptures.remove(resource) }
        try { resource.open() } catch (error: Throwable) {
            resource.close().thenCompose { failedFuture<CitizenSdkQrCapture>(error) }
        }
    }

    /** 包含尚在等待系统权限/初始化的采集，关闭不能只处理已交给Flutter的资源。 */
    @JvmSynthetic
    internal fun closeQrCaptures(): List<CompletableFuture<Void>> = qrCaptures.toList().map { it.close() }

    fun qrParse(text: String): CitizenQrDocument =
        synchronized(lifecycleGate) { requireOpen(); (call {
        CitizenQrDocument.parse(strictUtf8(Bindings.nativeQrParse(it, text.toByteArray(Charsets.UTF_8))))
    }) }
    fun qrEncodeDocument(content: CitizenQrContent): CitizenQrDocument =
        synchronized(lifecycleGate) { requireOpen(); run { val nativeArg0 = content.inputJson; call {
        CitizenQrDocument.parse(strictUtf8(Bindings.nativeQrEncodeDocument(it, nativeArg0.toByteArray(Charsets.UTF_8))))
    } } }
    fun qrPrepareAccountAuthorization(action: Int, payload: ByteArray, accountId: String): CitizenQrAuthorization =
        synchronized(lifecycleGate) { requireOpen(); (call {
        CitizenQrAuthorization.parse(strictUtf8(Bindings.nativeQrPrepareAccountAuthorization(it, action, payload, accountId.toByteArray(Charsets.UTF_8))))
    }) }

    fun qrCreateSignRequest(
        action: Int, signerAccountId: ByteArray, reviewPayload: ByteArray, ttlSeconds: Long,
    ): String = synchronized(lifecycleGate) {
        requireOpen()
        run { val nativeArg1 = signerAccountId.requireSize(32, "signerAccountId"); val nativeArg2 = reviewPayload.clone(); call { strictUtf8(Bindings.nativeQrCreateSignRequest(it, action, nativeArg1, nativeArg2, ttlSeconds)) } }
    }

    /** 只验证本实例会话，不消费；最终提交仍须调用原消费入口。 */
    fun qrValidateSignResponse(sessionId: String, response: String) =
        synchronized(lifecycleGate) { requireOpen(); (call { Bindings.nativeQrValidateSignResponse(it, sessionId.toByteArray(Charsets.UTF_8), response.toByteArray(Charsets.UTF_8)) }) }

    fun qrConsumeSignResponse(text: String): ByteArray =
        synchronized(lifecycleGate) { requireOpen(); (call { Bindings.nativeQrConsumeSignResponse(it, text.toByteArray(Charsets.UTF_8)).also { bytes -> check(bytes.size == 64) } }) }

    fun qrCancelSignRequest(requestId: String): Boolean =
        synchronized(lifecycleGate) { requireOpen(); (call { Bindings.nativeQrCancelSignRequest(it, requestId.toByteArray(Charsets.UTF_8)) }) }

    fun qrEncodeAccountId(accountId: ByteArray): String =
        synchronized(lifecycleGate) { requireOpen(); run { val nativeArg0 = accountId.requireSize(32, "accountId"); call { strictUtf8(Bindings.nativeQrEncodeAccountId(it, nativeArg0)) } } }

    fun qrDecodeLuminance(data: ByteArray, width: Int, height: Int, rowStride: Int): CitizenQrDocument =
        synchronized(lifecycleGate) {
            requireOpen(); requireQrModule()
            run { val nativeArg0 = data.clone(); qrDecodeLuminanceAll(nativeArg0, width, height, rowStride, firstOnly = true).first() }
        }

    /** 相册只提供编码图片字节；尺寸检查、像素解码、ZXing识别和用途过滤全部在SDK。 */
    fun decodeImage(encodedImage: ByteArray, purpose: CitizenQrScanPurpose): List<CitizenQrScanResult> {
        require(encodedImage.isNotEmpty() && encodedImage.size <= 16 * 1024 * 1024) { "encoded image size is invalid" }
        synchronized(lifecycleGate) { requireOpen(); requireQrModule() }
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(encodedImage, 0, encodedImage.size, bounds)
        require(bounds.outWidth in 1..4096 && bounds.outHeight in 1..4096) { "decoded image dimensions are invalid" }
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(encodedImage, 0, encodedImage.size)
            ?: throw CitizenSdkException(CitizenSdkErrorCode.DECODE, "encoded image could not be decoded")
        if (bitmap.width !in 1..4096 || bitmap.height !in 1..4096) {
            bitmap.recycle()
            throw CitizenSdkException(CitizenSdkErrorCode.INVALID_ARGUMENT, "decoded image dimensions are invalid")
        }
        val luminance = ByteArray(bitmap.width * bitmap.height)
        val row = IntArray(bitmap.width)
        try {
            for (y in 0 until bitmap.height) {
                bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
                for (x in row.indices) {
                    val color = row[x]
                    luminance[y * bitmap.width + x] = (((color shr 16 and 255) * 77 +
                        (color shr 8 and 255) * 150 + (color and 255) * 29) shr 8).toByte()
                }
            }
            val documents = try {
                synchronized(lifecycleGate) { requireOpen(); this.qrDecodeLuminanceAll(luminance, bitmap.width, bitmap.height, bitmap.width) }
            } catch (error: CitizenSdkException) {
                if (error.code == CitizenSdkErrorCode.NOT_FOUND) return emptyList()
                throw error
            }
            return documents.map { CitizenQrScanResult.forPurpose(it, purpose) }
        } finally { row.fill(0); luminance.fill(0); bitmap.recycle() }
    }

    fun qrEncode(text: String, scale: Int = 4): CitizenQrImage =
        synchronized(lifecycleGate) {
            requireOpen(); requireQrModule()
            (call {
        val encoded = Bindings.nativeQrEncode(it, text.toByteArray(Charsets.UTF_8), scale)
        require(encoded.size >= 8) { "QR image result is truncated" }
        val header = ByteBuffer.wrap(encoded, 0, 8).order(ByteOrder.LITTLE_ENDIAN)
        val width = header.int
        val height = header.int
        require(width in 1..4096 && height in 1..4096 && encoded.size - 8 == width * height) {
            "QR image result dimensions are invalid"
        }
        CitizenQrImage(width, height, encoded.copyOfRange(8, encoded.size))
    })
        }

    /** Core返回审阅事实；是否确认和如何展示由宿主自己的UI负责。 */
    fun reviewQrRequest(text: String): CitizenSdkOperation<CitizenQrReview> =
        requestOperation({ (call { Bindings.nativeReviewQrSignRequest(it, text.toByteArray(Charsets.UTF_8)) }) }) {
            CitizenQrReview(this,it.handle,it.value as String) { review -> qrReviews.remove(review) }
                .also { review -> qrReviews.add(review);it.keep() }
        }

    fun signQrRequest(review: CitizenQrReview): CitizenSdkOperation<CitizenQrSigned> {
        val operation = review.withHandle(this) { token ->
            requestOperation({ (call { Bindings.nativeSignQrRequest(it, token) }) }) {
                val document=CitizenQrDocument.parse(it.value as String)
                CitizenQrSigned(document,qrEncode(document.canonicalText))
            }
        }
        // Core原子领取阻止重复签名；显式release单独归还引用，清理失败不掩盖已接纳操作。
        return operation
    }

    private fun requireQrModule() {
        if (selectedModules and CitizenSdkModules.QR == 0) throw CitizenSdkException(
            CitizenSdkErrorCode.UNSUPPORTED, "CitizenSDK QR module is not enabled",
        )
    }

    fun sign(accountId: ByteArray, message: ByteArray): CitizenSdkOperation<CitizenSignature> {
        CitizenSdkInputLimits.requireSignPayload(message.size)
        return requestOperation({
            run { val nativeArg0 = accountId.requireSize(32, "accountId"); val nativeArg1 = message.clone(); call { Bindings.nativeSignWalletPayload(it, nativeArg0, nativeArg1) } }
        }) { (it.value as CitizenSignature) }
    }

    fun beginSigning(intent: CitizenSigningIntent): CitizenSdkOperation<CitizenSigningOutcome> =
        requestOperation({ (call {
        Bindings.nativeBeginSigning(
            it,
            intent.accountId(),
            intent.payload(),
            when (intent.transform) {
                CitizenSigningTransform.RAW -> 1
                CitizenSigningTransform.SUBSTRATE_SIGNING_PAYLOAD -> 2
                CitizenSigningTransform.BLAKE2_DOMAIN -> 3
            },
            intent.domain(),
            when (intent.externalSignerTransport) {
                null -> 0
                CitizenExternalSignerTransport.QR_V1 -> 1
            },
            intent.opaqueAction,
            intent.ttlSeconds,
        )
    }) }) {
            (it.value as? CitizenSigningOutcome)
                ?: throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned an invalid signing result kind",
                )
        }

    fun consumeExternalSignature(
        sessionId: String,
        response: String,
    ): CitizenSdkOperation<CitizenSigningOutcome> {
        requireExternalSigningText(sessionId, response)
        return requestOperation({ (call {
        Bindings.nativeConsumeExternalSignature(
            it,
            sessionId.toByteArray(Charsets.UTF_8),
            response.toByteArray(Charsets.UTF_8),
        )
    }) }) {
            (it.value as? CitizenSigningOutcome)
                ?: throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned an invalid signing result kind",
                )
        }
    }

    fun cancelSigningSession(sessionId: String): Boolean {
        require(sessionId.toByteArray(Charsets.UTF_8).size in 1..128) {
            "external signing sessionId must contain 1..128 UTF-8 bytes"
        }
        return synchronized(lifecycleGate) {
            requireOpen()
            (call {
        Bindings.nativeCancelSigningSession(it, sessionId.toByteArray(Charsets.UTF_8))
    })
        }
    }

    private fun requireExternalSigningText(sessionId: String, response: String) {
        require(sessionId.toByteArray(Charsets.UTF_8).size in 1..128) {
            "external signing sessionId must contain 1..128 UTF-8 bytes"
        }
        require(response.toByteArray(Charsets.UTF_8).size in 1..2331) {
            "external signing response must contain 1..2331 UTF-8 bytes"
        }
    }

    /** Prepares application-owned opaque RuntimeCall bytes without touching wallet secrets. */
    fun prepareTransaction(
        sourceAccountId: ByteArray,
        callData: ByteArray,
    ): CompletableFuture<CitizenPreparedTransaction> {
        require(callData.size in 1..1024 * 1024) { "callData must contain 1..1 MiB bytes" }
        val source = sourceAccountId.requireSize(32, "sourceAccountId")
        val copiedCall = callData.clone()
        return request({ (call { Bindings.nativePrepareTransaction(it, source, copiedCall) }) }) { result ->
            val prepared=result.value as CitizenPreparedTransaction
            if(!prepared.sourceAccountId().contentEquals(source)||preparedTransactions.putIfAbsent(prepared.preparationId,prepared.nativeHandle)!=null){
                throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY,"Core返回不匹配或重复的交易准备")
            }
            prepared.release={if(preparedTransactions.remove(prepared.preparationId,prepared.nativeHandle))call{Bindings.nativeReleasePreparedTransaction(it,prepared.nativeHandle)}}
            result.keep()
            prepared

        }
    }

    /** Cancels exactly one preparation owned by this facade. */
    fun cancelPreparedTransaction(preparationId: String) {
        require(PREPARATION_ID.matches(preparationId)) { "preparationId is invalid" }
        val token = preparedTransactions.remove(preparationId)
            ?: throw CitizenSdkException(
                CitizenSdkErrorCode.NOT_FOUND,
                "Transaction preparation was not found",
            )
        try {
            (call { Bindings.nativeReleasePreparedTransaction(it, token) })
        } catch (error: Throwable) {
            preparedTransactions.putIfAbsent(preparationId, token)
            throw error
        }
    }

    fun executePreparedTransaction(preparationId: String): CompletableFuture<CitizenTransactionExecution> {
        require(PREPARATION_ID.matches(preparationId)) { "preparationId is invalid" }
        val token = preparedTransactions.remove(preparationId)
            ?: throw CitizenSdkException(CitizenSdkErrorCode.NOT_FOUND, "Transaction preparation was not found")
        return try {
            request({ (call { Bindings.nativeExecutePreparedTransaction(it, token) }) }) {
                (it.value as CitizenTransactionExecution)
            }
        } catch (error: Throwable) {
            // A synchronous admission failure does not consume the Core handle.
            preparedTransactions.putIfAbsent(preparationId, token)
            throw error
        }
    }

    fun consumePreparedTransactionQrResponse(
        executionId: String,
        response: String,
    ): CompletableFuture<CitizenTransactionExecution.Completed> {
        val id = executionIdBytes(executionId)
        require(response.toByteArray(Charsets.UTF_8).size in 1..2331) {
            "response must contain 1..2331 UTF-8 bytes"
        }
        return request({ run { val nativeArg1 = response.toByteArray(Charsets.UTF_8); call { Bindings.nativeConsumePreparedTransactionQrResponse(it, id, nativeArg1) } } }) {
            val value = (it.value as CitizenTransactionExecution)
            value as? CitizenTransactionExecution.Completed
                ?: throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "Core did not return a terminal execution")
        }
    }

    fun cancelPreparedTransactionExecution(executionId: String) {
        run { val nativeArg0 = executionIdBytes(executionId); call { Bindings.nativeCancelPreparedTransactionExecution(it, nativeArg0) } }
    }

    private fun executionIdBytes(value: String): ByteArray {
        require(PREPARATION_ID.matches(value)) { "executionId is invalid" }
        return ByteArray(16) { index ->
            value.substring(2 + index * 2, 4 + index * 2).toInt(16).toByte()
        }
    }

    /** Reads a deterministic page containing only SDK-submitted generic transactions. */
    fun getTransactionHistory(
        beforeExecutionId: String? = null,
        limit: Int = 100,
    ): CompletableFuture<CitizenTransactionHistoryPage> {
        require(limit in 1..100) { "limit must be within 1..100" }
        val before = beforeExecutionId?.let(::executionIdBytes)
        return request({ (call { Bindings.nativeGetTransactionHistory(it, before, limit) }) }) {
            (it.value as CitizenTransactionHistoryPage)
        }
    }

    /** Reconciles at most one bounded generic execution batch. */
    fun syncTransactionHistory(): CompletableFuture<CitizenTransactionHistoryPage> =
        request({ (call { Bindings.nativeSyncTransactionHistory(it) }) }) {
            (it.value as CitizenTransactionHistoryPage)
        }

    /** 只打开无窗口资源；原应用页面决定何时显示、请求reveal和关闭。 */
    fun openPrivateKey(accountId: ByteArray): CompletableFuture<CitizenSdkPrivateKey> =
        synchronized(lifecycleGate) {
            requireOpen()
            val host = hostServices.privateKeyActivity()
                ?: throw CitizenSdkException(CitizenSdkErrorCode.AUTHENTICATION_REQUIRED, "private key requires a foreground host")
            val resource = CitizenSdkPrivateKey(this, accountId.requireSize(32, "accountId"), host)
            privateKeys.add(resource)
            resource.closed.whenComplete { _, _ -> privateKeys.remove(resource) }
            resource.opened
        }

    @JvmSynthetic
    internal fun openPrivateKeyResource(accountId: ByteArray, buffer: CitizenSdkPrivateKeyReceiver, host: FragmentActivity): Pair<Long, CitizenSdkOperation<Unit>> {
        buffer.bindAuthenticationRegistry { operationId -> hostServices.registerPrivateKeyAuthentication(operationId, host) }
        var identities: LongArray? = null
        val core = synchronized(lifecycleGate) {
            requireOpen()
            requests.submitOperation({
                (call { Bindings.nativeOpenPrivateKeyView(it, accountId, buffer) }).also { identities = it }[0]
            }, {
                check(it.value === Unit) { "private key view returned a non-empty result" }
                Unit
            })
        }
        val ids = checkNotNull(identities)
        val drained = core.future.whenComplete { _, _ ->
            // 普通请求已真实排空，才释放 JNI global ref；阶段 settled 绝不能走此路径。
            run { val nativeArg0 = ids[2]; call { Bindings.nativeReleasePrivateKeyViewContext(nativeArg0) } }
            buffer.authenticationId()?.let(hostServices::releasePrivateKeyAuthentication)
            readinessBoundaryCompleted()
        }
        return ids[1] to CitizenSdkOperation(core.operationId, drained, core::cancel)
    }
    @JvmSynthetic internal fun revealPrivateKeyResource(viewId: Long) = (call { Bindings.nativeRevealPrivateKeyView(it, viewId) })
    @JvmSynthetic internal fun cancelPrivateKeyResource(viewId: Long) = (call { Bindings.nativeCancelPrivateKeyView(it, viewId) })
    @JvmSynthetic internal fun finishPrivateKeyResource(viewId: Long) = (call { Bindings.nativeFinishPrivateKeyView(it, viewId) })
    @JvmSynthetic internal fun isPrivateKeyAuthenticationActive(operationId: Long, activity: FragmentActivity): Boolean =
        hostServices.isPrivateKeyAuthenticationActive(operationId, activity)
    @JvmSynthetic internal fun cancelPrivateKeyAuthentication(operationId: Long) = hostServices.cancelPrivateKeyAuthentication(operationId)

    /** 输入字节仅在同步接纳期间借用；Core在返回请求前复制并负责清零。 */
    fun prepareWalletCreation(wordCount: Int, password: ByteArray = byteArrayOf()): CitizenSdkOperation<CitizenSdkPreparedWallet> =
        requestOperation({
            CitizenSdkInputLimits.requireWalletSecret("password", password.size)
            (call { Bindings.nativePrepareWalletCreation(it, wordCount, password) })
        }) {
            CitizenSdkPreparedWallet.create(this, it.value as Long, ::commitPreparedWallet) {
                prepared -> preparedWallets.remove(prepared)
            }
                .also { prepared -> preparedWallets.add(prepared);it.keep() }
        }

    fun importWallet(mnemonic: ByteArray, password: ByteArray = byteArrayOf()): CitizenSdkOperation<CitizenWalletProfile> =
        requestOperation({
            CitizenSdkInputLimits.requireWalletSecret("mnemonic", mnemonic.size)
            CitizenSdkInputLimits.requireWalletSecret("password", password.size)
            (call { Bindings.nativeImportWallet(it, mnemonic, password) })
        }) { requireWalletProfile(it, "import wallet") }

    fun addWalletAccounts(
        mnemonic: ByteArray,
        password: ByteArray = byteArrayOf(),
        indices: IntArray,
    ): CitizenSdkOperation<CitizenWalletProfile> {
        CitizenSdkInputLimits.requireAddAccountIndices(indices)
        return requestOperation({
            CitizenSdkInputLimits.requireWalletSecret("mnemonic", mnemonic.size)
            CitizenSdkInputLimits.requireWalletSecret("password", password.size)
            (call { Bindings.nativeAddWalletAccounts(it, mnemonic, password, indices) })
        }) { requireWalletProfile(it, "add wallet accounts") }
    }

    /** 编号由Core在同一操作门内分配，绑定层不读max+1，也不进行追加后的二次查询。 */
    fun addNextWalletAccount(mnemonic: ByteArray, password: ByteArray = byteArrayOf()): CitizenSdkOperation<CitizenWalletProfile> =
        requestOperation({
            CitizenSdkInputLimits.requireWalletSecret("mnemonic", mnemonic.size)
            CitizenSdkInputLimits.requireWalletSecret("password", password.size)
            (call { Bindings.nativeAddNextWalletAccount(it, mnemonic, password) })
        }) { requireWalletProfile(it, "add next wallet account") }

    private fun commitPreparedWallet(prepared: CitizenSdkPreparedWallet): CitizenSdkOperation<CitizenWalletProfile> =
        requestOperation({ prepared.commitRequest() }) { requireWalletProfile(it, "commit wallet creation") }

    @JvmSynthetic
    internal fun whenActivityReady(callback: (Throwable?) -> Unit): AutoCloseable =
        hostServices.whenActivityReady {
            val convergence = synchronized(lifecycleGate) { readinessBarrierLocked() }
            convergence.whenComplete { _, failure ->
                callback(failure?.let(::unwrapCompletion))
            }
        }

    /**
     * Destroys only a checkpoint-safe Core state.
     *
     * A RUNNING instance must first complete [stop], which persists the exact
     * host checkpoint. STARTING/IMPORTING or any accepted request fails closed.
     * START_FAILED is intentionally destroyable without stop, as required by
     * the one-way imported-state failure contract. 私钥资源先撤销并排空，准备与
     * 审阅资源先释放；Core回调仍在执行时close返回BUSY，绝不提前报告销毁成功。
     */
    override fun close() {
        synchronized(lifecycleGate) {
            if (closed.get()) return
            if (closeActive) throw CitizenSdkException(CitizenSdkErrorCode.BUSY, "CitizenSDK close is active")
            // 不在事件回调线程等待后续事件完成；未静止时拒绝，调用方在终态后重试。
            if (readinessInFlight || readinessRetryPending) throw CitizenSdkException(
                CitizenSdkErrorCode.BUSY, "CitizenSDK capability refresh is active",
            )
            if (!closing.get()) {
                val captures = qrCaptures.toList()
                captures.forEach { it.close() }
                if (captures.any { !it.closed.isDone }) throw CitizenSdkException(CitizenSdkErrorCode.BUSY, "camera resources are still draining")
                privateKeys.toList().forEach { it.close() }
                requests.requireIdle()
                preparedWallets.toList().forEach { it.close() }
                qrReviews.toList().forEach { it.close() }
                walletInspections.toList().forEach { it.close() }
                CitizenSdkClosePolicy.validate((call { lifecycleFromValue(Bindings.nativeLifecycle(it)) }))
            }
            closing.set(true)
            closeActive = true
        }
        try {
            // 回调可以同步重入公开门面。屏障期间只保留 closing 状态，不占 lifecycleGate。
            run {
        calls.close {
            Bindings.nativeDestroy(bridge)

            eventSink = null
        }
     }
            preparedTransactions.clear()
            preparedWallets.clear()
            qrReviews.clear()
            walletInspections.clear()
            requests.close()
            eventListener = null
            try {
                hostServices.close()
            } finally {
                // Native destruction is the irreversible commit point.
                lifecycle = CitizenSdkLifecycle.DISPOSED
                closed.set(true)
            }
        } finally {
            synchronized(lifecycleGate) { closeActive = false }
        }
    }

    private fun unitRequest(
        begin: () -> Long,
        notifyReadinessBoundary: Boolean = true,
    ): CompletableFuture<Void> {
        val source = request(begin, notifyReadinessBoundary) {
            if (it.value !== Unit) throw CitizenSdkException(
                CitizenSdkErrorCode.INTEGRITY,
                "Core returned a non-empty result for an empty operation",
            )
            Unit
        }
        val target = CompletableFuture<Void>()
        source.whenComplete { _, error ->
            if (error == null) target.complete(null) else target.completeExceptionally(error)
        }
        return target
    }

    private fun readinessChanged() {
        synchronized(lifecycleGate) {
            if (closed.get() || closing.get()) return
            check(readinessDesiredGeneration != Long.MAX_VALUE) {
                "CitizenSDK readiness generation space is exhausted"
            }
            readinessDesiredGeneration += 1
            if (readinessConvergence.isDone) readinessConvergence = CompletableFuture()
            // Activity 变化只标记代际；open 和私钥资源的显式等待才提交刷新。
            // 避免 attachActivity 在 open 返回后抢占紧接着的 Core start 准入。
        }
    }

    /** Starts at most one refresh and preserves the newest requested edge. */
    private fun ensureReadinessRefreshLocked() {
        if (closed.get() || closing.get() || readinessInFlight ||
            readinessAppliedGeneration == readinessDesiredGeneration
        ) return
        val targetGeneration = readinessDesiredGeneration
        readinessInFlight = true
        readinessRetryPending = false
        val refresh = try {
            unitRequest({ (call { Bindings.nativeRefreshCapabilities(it) }) }, notifyReadinessBoundary = false)
        } catch (error: Throwable) {
            readinessInFlight = false
            handleReadinessFailureLocked(error)
            return
        }
        refresh.whenComplete { _, failure ->
            synchronized(lifecycleGate) {
                readinessInFlight = false
                if (failure == null) {
                    readinessAppliedGeneration = maxOf(readinessAppliedGeneration, targetGeneration)
                    if (readinessAppliedGeneration == readinessDesiredGeneration) {
                        readinessConvergence.complete(null)
                    } else {
                        ensureReadinessRefreshLocked()
                    }
                } else {
                    handleReadinessFailureLocked(failure)
                }
            }
        }
    }

    private fun handleReadinessFailureLocked(failure: Throwable) {
        val cause = unwrapCompletion(failure)
        if (cause is CitizenSdkException && cause.code == CitizenSdkErrorCode.BUSY) {
            readinessRetryPending = true
        } else {
            readinessConvergence.completeExceptionally(cause)
        }
    }

    private fun readinessBoundaryCompleted() {
        synchronized(lifecycleGate) {
            if (!closed.get() && readinessRetryPending) ensureReadinessRefreshLocked()
        }
    }

    private fun readinessBarrierLocked(): CompletableFuture<Void> {
        ensureReadinessRefreshLocked()
        return readinessConvergence
    }

    private fun readinessSettledLocked(): Boolean =
        !readinessInFlight && !readinessRetryPending &&
            readinessAppliedGeneration == readinessDesiredGeneration

    private fun awaitReadinessBarrier() {
        while (true) {
            val barrier = synchronized(lifecycleGate) {
                if (closed.get()) return
                readinessBarrierLocked()
            }
            try {
                barrier.get()
            } catch (error: ExecutionException) {
                throw unwrapCompletion(error)
            }
            if (synchronized(lifecycleGate) { closed.get() || readinessSettledLocked() }) return
        }
    }

    private fun unwrapCompletion(error: Throwable): Throwable = when (error) {
        is CompletionException, is ExecutionException -> error.cause ?: error
        else -> error
    }

    private fun <T> requestOperation(
        begin: () -> Long,
        notifyReadinessBoundary: Boolean = true,
        decode: (CoreResult) -> T,
    ): CitizenSdkOperation<T> {
        val operation = synchronized(lifecycleGate) {
            requireOpen()
            requests.submitOperation(begin, decode)
        }
        if (notifyReadinessBoundary) operation.future.whenComplete { _, _ -> readinessBoundaryCompleted() }
        return operation
    }

    private fun <T> request(
        begin: () -> Long,
        notifyReadinessBoundary: Boolean = true,
        decode: (CoreResult) -> T,
    ): CompletableFuture<T> = requestOperation(begin, notifyReadinessBoundary, decode).future

    private fun emptyOperation(begin: () -> Long): CitizenSdkOperation<Unit> =
        requestOperation(begin) {
            if (it.value !== Unit) throw CitizenSdkException(
                CitizenSdkErrorCode.INTEGRITY, "Core returned a non-empty result",
            )
            Unit
        }

    private fun checkedAccountName(name: String): String {
        CitizenSdkInputLimits.requireWalletAccountNameInput(name)
        require(name.codePoints().noneMatch { value ->
            value in 0x00..0x1f || value in 0x7f..0x9f
        }) { "wallet account name must not contain control characters" }
        return name.trim().also { normalized ->
            require(normalized.codePointCount(0, normalized.length) in 1..30) {
                "wallet account name must contain 1..30 Unicode scalars"
            }
        }
    }

    /** 校验只返回Core原因和位置；绑定不复制密码或BIP39规则，不生成UI文案。 */
    fun validateWalletPassword(password: ByteArray): CitizenWalletInputValidation =
        validateWalletInput(1, password, 0)

    fun validateWalletMnemonic(mnemonic: ByteArray, wordCount: Int): CitizenWalletInputValidation =
        validateWalletInput(2, mnemonic, wordCount)

    private fun validateWalletInput(kind: Int, input: ByteArray, wordCount: Int): CitizenWalletInputValidation {
        require(kind == 1 && wordCount == 0 || kind == 2 && wordCount in listOf(12, 18, 24))
        if (input.size > CitizenSdkInputLimits.MAX_WALLET_SECRET_BYTES) {
            return CitizenWalletInputValidation(CitizenWalletInputReason.INPUT_TOO_LONG, null)
        }
        val tuple = (call { Bindings.nativeValidateWalletInput(kind, input, wordCount) })
        check(tuple.size == 2 && tuple[0] in CitizenWalletInputReason.entries.indices)
        val reason = CitizenWalletInputReason.entries[tuple[0]]
        val position = if (tuple[1] == -1) null else tuple[1]
        check(if (reason == CitizenWalletInputReason.UNKNOWN_WORD) position != null && position in 0..23 else position == null)
        return CitizenWalletInputValidation(reason, position)
    }

    fun walletWordSuggestions(prefix: ByteArray): List<String> {
        CitizenSdkInputLimits.requireWalletSecret("prefix", prefix.size)
        val bytes = (call { Bindings.nativeWalletWordSuggestions(prefix) })
        return try { bytes.toString(Charsets.UTF_8).split('\n').filter { it.isNotEmpty() } }
        finally { bytes.fill(0) }
    }

    private fun requireWalletProfile(
        result: CoreResult,
        operation: String,
    ): CitizenWalletProfile = (result.value as? CitizenWalletProfile?)
        ?: throw CitizenSdkException(
            CitizenSdkErrorCode.INTEGRITY,
            "$operation returned no wallet profile",
        )

    private fun <T> failedFuture(error: Throwable): CompletableFuture<T> =
        CompletableFuture<T>().also { it.completeExceptionally(error) }

    private fun requireOpen() {
        check(!closed.get() && !closing.get()) { "CitizenSdk is closing or closed" }
    }

    companion object {
        private val PREPARATION_ID = Regex("^0x[0-9a-f]{32}$")

        @JvmStatic
        @JvmOverloads
        fun open(context: Context, listener: CitizenSdkEvents.Listener? = null,
                 modules: Int = CitizenSdkModules.FULL): CitizenSdk {
            // 先执行唯一 Rust 合同，不加载未选模块资产或探测其设备资源。
            Bindings.validateModules(modules)
            val sdk = CitizenSdk(context, listener, modules)
            return try {
                sdk.awaitReadinessBarrier()
                sdk
            } catch (error: Throwable) {
                runCatching { sdk.close() }
                throw error
            }
        }

        @JvmStatic
        fun verify(accountId: ByteArray, signature: ByteArray, message: ByteArray): Boolean {
            CitizenSdkInputLimits.requireSignPayload(message.size)
            return Bindings.verifySignature(
                accountId.requireSize(32, "accountId"), signature.requireSize(64, "signature"), message,
            )
        }
        @JvmStatic
        fun encodePayload(payload: CitizenSigningPayload): ByteArray =
            Bindings.encodeSigningPayload(payload.kind, payload.fieldsJson.toByteArray(Charsets.UTF_8), payload.payloadBytes())
}


    @JvmSynthetic internal fun renameWalletAccount(accountId: ByteArray, name: String): Long =
        call { Bindings.nativeRenameWalletAccount(it, accountId, name.toByteArray(Charsets.UTF_8)) }

    @JvmSynthetic internal fun deleteWalletAccount(accountId: ByteArray): Long = call { Bindings.nativeDeleteWalletAccount(it, accountId) }

    @JvmSynthetic internal fun qrDecodeLuminanceAll(data: ByteArray, width: Int, height: Int, rowStride: Int, firstOnly: Boolean = false): List<CitizenQrDocument> {
        val encoded = call { Bindings.nativeQrDecodeLuminance(it, data, width, height, rowStride, true) }
        try {
            val reader = ByteBuffer.wrap(encoded).order(ByteOrder.LITTLE_ENDIAN)
            check(reader.remaining() >= 4)
            val count = reader.int
            check(count in 1..64)
            val documents = List(count) { index ->
                check(reader.remaining() >= 4)
                val length = reader.int
                check(length in 1..2331 && length <= reader.remaining())
                val text = ByteArray(length)
                reader.get(text)
                // 实时单次领取保持原入口“首个非空码”语义；不让后面的码改变首码结果。
                try { if (!firstOnly || index == 0) qrParse(strictUtf8(text)) else null } finally { text.fill(0) }
            }.filterNotNull()
            check(!reader.hasRemaining())
            return documents
        } finally { encoded.fill(0) }
    }

    @JvmSynthetic internal fun copyPreparedMnemonic(token: Long): ByteArray = call { Bindings.nativeCopyPreparedMnemonic(it, token) }

    private fun onNativeRequestCompleted(coreRequestId:Long,result:Long):Boolean {
        val decoded=runCatching {
            try {
                CoreResult(result,call{Bindings.nativeReadResult(it,result)}){keep->call{Bindings.nativeReleaseCompletion(it,result,keep)}}
            } catch(error:Throwable){call{Bindings.nativeReleaseCompletion(it,result,false)};throw error}
        }
        requests.onCompletion(coreRequestId,decoded)
        return true
    }
    private fun onNativeCapabilities(sequence:Long) {
        val value=call{Bindings.nativeCapabilities(it)}
        eventSink?.invoke(CitizenSdkEvents.Event.CapabilitiesChanged(java.lang.Long.toUnsignedString(sequence),value))
    }

    private fun onNativeLifecycle(sequence: Long, lifecycle: Int) {
        eventSink?.invoke(
            CitizenSdkEvents.Event.LifecycleChanged(
                java.lang.Long.toUnsignedString(sequence),
                lifecycleFromValue(lifecycle),
            ),
        )
    }

    private fun onNativeHistoryChanged(sequence: Long) {
        if (!calls.isClosed()) eventSink?.invoke(
            CitizenSdkEvents.Event.HistoryChanged(java.lang.Long.toUnsignedString(sequence)),
        )
    }

    private fun onNativeWalletChanged(sequence: Long) {
        if (!calls.isClosed()) eventSink?.invoke(
            CitizenSdkEvents.Event.WalletChanged(java.lang.Long.toUnsignedString(sequence)),
        )
    }

    private fun onNativeFinalizedBlockChanged(sequence:Long,result:Long):Boolean {
        try {
            val block=call{Bindings.nativeReadResult(it,result)} as CitizenBlockRef
            if(block.finality==CitizenFinality.FINALIZED&&!calls.isClosed())eventSink?.invoke(CitizenSdkEvents.Event.FinalizedBlockChanged(java.lang.Long.toUnsignedString(sequence),block))
        } finally {call{Bindings.nativeReleaseCompletion(it,result,false)}}
        return true
    }

    private fun <T> call(block: (Long) -> T): T = calls.call { block(bridge) }

    private fun flattenAccounts(values: Array<ByteArray>): ByteArray =
        ByteArray(values.size * 32).also { output ->
            values.forEachIndexed { index, value -> value.copyInto(output, index * 32) }
        }

    private fun lifecycleFromValue(value: Int): CitizenSdkLifecycle = when (value) {
        1 -> CitizenSdkLifecycle.CREATED
        2 -> CitizenSdkLifecycle.IMPORTING_STATE
        3 -> CitizenSdkLifecycle.STARTING
        4 -> CitizenSdkLifecycle.RUNNING
        5 -> CitizenSdkLifecycle.START_FAILED
        6 -> CitizenSdkLifecycle.STOPPED
        7 -> CitizenSdkLifecycle.DISPOSED
        else -> throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "unknown Core lifecycle $value")
    }

    private fun strictUtf8(value: ByteArray): String = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(value)).toString()

    @JvmSynthetic internal fun releaseQrReview(token: Long) = call { Bindings.nativeReleaseQrReview(it, token) }


    @JvmSynthetic internal fun releasePreparedWallet(token: Long) {
        // 只有成功 destroy 才能把迟到的释放视为已完成；closing 仍明确拒绝。
        if (!calls.isClosed()) call { Bindings.nativeReleasePreparedWallet(it, token) }
    }


    @JvmSynthetic internal fun releaseWalletInspection(token:Long) {
        if(!calls.isClosed()) call{Bindings.nativeReleaseWalletInspection(it,token)}
    }
    @JvmSynthetic internal fun commitPreparedWallet(token:Long):Long = call{Bindings.nativeCommitPreparedWallet(it,token)}
}

/** 本地签名始终使用 SDK 金库；静态验签只处理公开数据，不创建 SDK 或访问设备密钥。 */


/** Bounded input validation applied before every proportional clone/flatten/JNI copy. */
internal object CitizenSdkInputLimits {
    const val MAX_BALANCE_ACCOUNTS = 1990
    const val MAX_SIGN_PAYLOAD_BYTES = 16 * 1024 * 1024
    const val MAX_WALLET_SECRET_BYTES = 1024
    const val MAX_ADD_ACCOUNT_INDICES = 1989
    // 热派生范围与冷账户容量、批次分别约束，按实际输入检查重复。
    const val MAX_ACCOUNT_INDEX = 19890604
    const val MAX_WALLET_ACCOUNTS = MAX_ACCOUNT_INDEX + 1
    const val MAX_COLD_WALLET_ACCOUNTS = 1990
    const val MAX_WALLET_CATALOG_ACCOUNTS = MAX_WALLET_ACCOUNTS + MAX_COLD_WALLET_ACCOUNTS
    const val MAX_WALLET_ACCOUNT_NAME_CODE_UNITS = 128
    const val MAX_STORAGE_KEY_BYTES = 4 * 1024
    const val MAX_STORAGE_BATCH_KEYS = 1024
    const val MAX_STORAGE_BATCH_KEY_BYTES = 1024 * 1024

    @JvmSynthetic
    fun requireStorageKey(key: ByteArray) {
        if (key.size !in 1..MAX_STORAGE_KEY_BYTES) throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "storage key must contain 1..$MAX_STORAGE_KEY_BYTES bytes",
        )
    }

    @JvmSynthetic
    fun requireStorageKeys(keys: List<ByteArray>) {
        if (keys.size !in 1..MAX_STORAGE_BATCH_KEYS) throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "storage batch must contain 1..$MAX_STORAGE_BATCH_KEYS keys",
        )
        var total = 0
        keys.forEach {
            requireStorageKey(it)
            total += it.size
            if (total > MAX_STORAGE_BATCH_KEY_BYTES) throw CitizenSdkException(
                CitizenSdkErrorCode.INVALID_ARGUMENT,
                "storage batch keys exceed $MAX_STORAGE_BATCH_KEY_BYTES bytes",
            )
        }
    }

    @JvmSynthetic
    fun requireBalanceAccountCount(count: Int) {
        if (count !in 0..MAX_BALANCE_ACCOUNTS) throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "balance accountIds must contain 0..$MAX_BALANCE_ACCOUNTS entries",
        )
    }

    @JvmSynthetic
    fun requireSignPayload(size: Int) {
        if (size !in 0..MAX_SIGN_PAYLOAD_BYTES) throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "sign payload exceeds $MAX_SIGN_PAYLOAD_BYTES bytes",
        )
    }

    @JvmSynthetic
    fun requireWalletSecret(label: String, size: Int) {
        if (size !in 0..MAX_WALLET_SECRET_BYTES) throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "$label exceeds $MAX_WALLET_SECRET_BYTES UTF-8 bytes",
        )
    }

    @JvmSynthetic
    fun requireAddAccountIndices(indices: IntArray) {
        if (indices.size !in 1..MAX_ADD_ACCOUNT_INDICES) throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "wallet index list must contain 1..$MAX_ADD_ACCOUNT_INDICES items",
        )
        val seen = HashSet<Int>()
        for (index in indices) {
            if (index !in 1..MAX_ACCOUNT_INDEX || !seen.add(index)) throw CitizenSdkException(
                CitizenSdkErrorCode.INVALID_ARGUMENT,
                "wallet indices must be unique values in 1..$MAX_ACCOUNT_INDEX",
            )
        }
    }

    @JvmSynthetic
    fun requireWalletAccountNameInput(name: String) {
        if (name.length !in 1..MAX_WALLET_ACCOUNT_NAME_CODE_UNITS) throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "wallet account name input exceeds $MAX_WALLET_ACCOUNT_NAME_CODE_UNITS UTF-16 code units",
        )
    }
}

/** Content identity for public 32-byte account ids; never owns secret material. */

/** Pure, testable close-state contract shared by the facade and JVM tests. */
internal object CitizenSdkClosePolicy {
    enum class Decision { DESTROY, ALREADY_DISPOSED }

    fun validate(lifecycle: CitizenSdkLifecycle): Decision = when (lifecycle) {
        CitizenSdkLifecycle.CREATED,
        CitizenSdkLifecycle.STOPPED,
        CitizenSdkLifecycle.START_FAILED -> Decision.DESTROY
        CitizenSdkLifecycle.RUNNING -> throw CitizenSdkException(
            CitizenSdkErrorCode.INVALID_STATE,
            "A running CitizenSDK must complete stop/checkpoint before close",
        )
        CitizenSdkLifecycle.STARTING,
        CitizenSdkLifecycle.IMPORTING_STATE -> throw CitizenSdkException(
            CitizenSdkErrorCode.BUSY,
            "CitizenSDK lifecycle transition is still running",
        )
        CitizenSdkLifecycle.DISPOSED -> Decision.ALREADY_DISPOSED
    }
}

private fun CitizenFinality.nativeValue(): Int = when (this) {
    CitizenFinality.BEST -> 1
    CitizenFinality.FINALIZED -> 2
}
