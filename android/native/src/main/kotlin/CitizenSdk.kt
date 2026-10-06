package org.citizen.sdk

import android.content.Context
import androidx.fragment.app.FragmentActivity
import org.citizen.sdk.internal.CitizenSdkAssets
import org.citizen.sdk.internal.CitizenSdkHostServices
import org.citizen.sdk.internal.CitizenSdkNative
import org.citizen.sdk.internal.CitizenSdkNativeCodec
import org.citizen.sdk.internal.CitizenSdkNativeResult
import org.citizen.sdk.internal.CitizenSdkRequestRouter
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ConcurrentHashMap

/** 同实例真实快照的受控资源；方法接纳和释放互斥，句柄不进入公开接口。 */
class CitizenWalletInspection internal constructor(
    private val native: CitizenSdkNative,
    result: Long,
    val state: CitizenWalletState,
    private val change: (CitizenWalletInspection, Int, Long, String?) -> CitizenSdkOperation<CitizenWalletState>,
    private val released: (CitizenWalletInspection) -> Unit,
) : AutoCloseable {
    private val gate = Any()
    private var handle = result
    @JvmSynthetic internal fun <T> withHandle(owner: CitizenSdkNative, body: (Long) -> T): T = synchronized(gate) {
        if (owner !== native || handle == 0L) throw CitizenSdkException(CitizenSdkErrorCode.INVALID_STATE, "钱包检查资源已释放或跨实例")
        body(handle)
    }
    fun repairHot(walletIndex: Long): CitizenSdkOperation<CitizenWalletState> = change(this, 1, walletIndex, null)
    fun rename(walletIndex: Long, name: String): CitizenSdkOperation<CitizenWalletState> = change(this, 2, walletIndex, name)
    fun delete(walletIndex: Long): CitizenSdkOperation<CitizenWalletState> = change(this, 3, walletIndex, null)
    fun release() = close()
    override fun close() = synchronized(gate) {
        if (handle != 0L) {
            native.releaseWalletInspection(handle)
            handle = 0
            released(this)
        }
    }
}

/**
 * Java/Kotlin facade for the one CitizenSDK Core instance.
 *
 * The facade exposes public chain facts and wallet operations. Native handles,
 * result handles, prepared-wallet handles, recovery phrases and passwords are
 * deliberately absent from this surface.
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
    private val native = CitizenSdkNative.create(
        context = context.applicationContext,
        assets = if (modules and CitizenSdkModules.CHAIN != 0) CitizenSdkAssets.load(context.applicationContext) else null,
        modules = modules,
        hostServices = hostServices,
    )
    private val requests = CitizenSdkRequestRouter(native::cancel) {
        when (it) {
            is CitizenSdkNativeResult.QrReview -> native.releaseQrReview(it.token)
            is CitizenSdkNativeResult.WalletState -> if (it.inspectionToken != 0L) native.releaseWalletInspection(it.inspectionToken)
            is CitizenSdkNativeResult.Prepared -> native.releasePreparedWallet(it.token)
            else -> Unit
        }
    }
    /** Only native handles are retained; the public preparation identity is never a Core handle. */
    private val preparedTransactions = ConcurrentHashMap<String, Long>()
    private val privateKeys = ConcurrentHashMap.newKeySet<CitizenSdkPrivateKey>()
    private val preparedWallets = ConcurrentHashMap.newKeySet<CitizenSdkPreparedWallet>()
    private val qrReviews = ConcurrentHashMap.newKeySet<CitizenQrReview>()
    private val walletInspections = ConcurrentHashMap.newKeySet<CitizenWalletInspection>()
    private val qrCaptures = ConcurrentHashMap.newKeySet<CitizenSdkQrCapture>()

    @Volatile
    private var eventListener: CitizenSdkEvents.Listener? = listener

    @Volatile
    var lifecycle: CitizenSdkLifecycle = native.lifecycle()
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
            native.bind(requests) { event ->
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
            hostServices.setActivityReadinessListener {
                readinessChanged()
            }
            readinessChanged()
        } catch (error: Throwable) {
            runCatching { native.close() }
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
    fun start(): CompletableFuture<Void> = unitRequest({ native.start() })

    /** 直接提交原生停止，Future仍等待原生检查点及排空完成，不把提交当作停止成功。 */
    fun stop(): CompletableFuture<Void> = unitRequest({ native.stop() })

    /** 通道关联仅由Core接纳；绑定不保存第二份接收序号。 */
    @JvmSynthetic
    internal fun acceptRequestSequence(sequence: Long) = synchronized(lifecycleGate) {
        requireOpen()
        native.acceptRequestSequence(sequence)
    }

    fun getCapabilities(): CitizenSdkCapabilities {
        return synchronized(lifecycleGate) {
            requireOpen()
            native.capabilities()
        }
    }

    fun getFinalizedHead(): CompletableFuture<CitizenBlockRef> =
        request({ native.getFinalizedHead() }) { (it as CitizenSdkNativeResult.Block).value }

    fun getSyncStatus(): CompletableFuture<CitizenChainSyncStatus> =
        request({ native.getSyncStatus() }) { (it as CitizenSdkNativeResult.SyncStatus).value }

    fun getBestHead(): CompletableFuture<CitizenBlockRef> =
        request({ native.getBestHead() }) { (it as CitizenSdkNativeResult.Block).value }

    fun getFinalizedBlockAt(number: String): CompletableFuture<CitizenBlockRef> {
        requireU64(number, "block number")
        return request({ native.getFinalizedBlockAt(number) }) {
            (it as CitizenSdkNativeResult.Block).value
        }
    }

    fun resolveFinalizedBlock(hash: ByteArray, number: String): CompletableFuture<CitizenBlockRef> {
        requireU64(number, "block number")
        val checkedHash = hash.requireSize(32, "block hash")
        return request({ native.resolveFinalizedBlock(checkedHash, number) }) {
            (it as CitizenSdkNativeResult.Block).value
        }
    }

    fun getBlockHeader(block: CitizenBlockRef): CompletableFuture<CitizenBlockHeader> =
        request({ native.getBlockHeader(block) }) { (it as CitizenSdkNativeResult.BlockHeader).value }

    fun getBlockBody(block: CitizenBlockRef): CompletableFuture<CitizenBlockBody> =
        request({ native.getBlockBody(block) }) { (it as CitizenSdkNativeResult.BlockBody).value }

    fun getRuntimeContext(block: CitizenBlockRef): CompletableFuture<CitizenRuntimeContext> =
        request({ native.getRuntimeContext(block) }) { (it as CitizenSdkNativeResult.RuntimeContext).value }

    fun getStorage(block: CitizenBlockRef, key: ByteArray): CompletableFuture<ByteArray?> {
        CitizenSdkInputLimits.requireStorageKey(key)
        val copied = key.clone()
        return request({ native.getStorage(block, copied) }) {
            (it as CitizenSdkNativeResult.Storage).value?.clone()
        }
    }

    fun getStorageBatch(block: CitizenBlockRef, keys: List<ByteArray>): CompletableFuture<List<ByteArray?>> {
        CitizenSdkInputLimits.requireStorageKeys(keys)
        val copied = keys.map(ByteArray::clone).toTypedArray()
        return request({ native.getStorageBatch(block, copied) }) {
            (it as CitizenSdkNativeResult.StorageBatch).value.map { value -> value?.clone() }
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
        return request({ native.getStorageKeysPaged(finalizedBlock, prefixCopy, startCopy, limit) }) {
            (it as CitizenSdkNativeResult.StorageBatch).value.map { value ->
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
        return request({ native.callRuntimeApi(block, method, copy) }) {
            requireNotNull((it as CitizenSdkNativeResult.Storage).value).clone()
        }
    }

    fun getSystemEvents(finalizedBlock: CitizenBlockRef): CompletableFuture<ByteArray?> {
        require(finalizedBlock.finality == CitizenFinality.FINALIZED) { "System.Events requires finalized block" }
        return request({ native.getSystemEvents(finalizedBlock) }) {
            (it as CitizenSdkNativeResult.Storage).value?.clone()
        }
    }




    fun exportState(): CompletableFuture<CitizenChainState> =
        request({ native.exportState() }) { (it as CitizenSdkNativeResult.ChainState).value }

    fun importState(state: CitizenChainState): CompletableFuture<Void> {
        require(state.formatVersion in 1..0xffff_ffffL) { "chain state formatVersion is invalid" }
        require(state.finalized.finality == CitizenFinality.FINALIZED) { "chain state anchor must be finalized" }
        require(state.database().size in 1..256 * 1024) { "chain state database is invalid" }
        val source = request({ native.importState(state) }) {
            val imported = (it as? CitizenSdkNativeResult.Block)?.value ?: throw CitizenSdkException(
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
        native.getGenesisHash().requireSize(32, "genesisHash")
    }

    fun getAccountBalance(accountId: ByteArray): CompletableFuture<CitizenAccountBalance> =
        request({ native.getAccountBalance(accountId.requireSize(32, "accountId")) }) {
            (it as CitizenSdkNativeResult.Balance).value
        }

    /** 同一已验证 finalized 块的批量余额；保留顺序和重复项，空列表仍提交 Core。 */
    fun getAccountBalances(accountIds: List<ByteArray>): CompletableFuture<List<CitizenAccountBalance>> {
        CitizenSdkInputLimits.requireBalanceAccountCount(accountIds.size)
        val checked = accountIds.map { it.requireSize(32, "accountId") }.toTypedArray()
        return request({ native.getAccountBalances(checked) }) {
            val values = (it as? CitizenSdkNativeResult.Balances)?.value
                ?: throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "Core returned an invalid balance result kind")
            CitizenSdkNativeCodec.validateBalances(values, checked)
        }
    }

    fun getAccountNonce(accountId: ByteArray): CompletableFuture<CitizenAccountNonce> =
        request({ native.getAccountNonce(accountId.requireSize(32, "accountId")) }) {
            (it as CitizenSdkNativeResult.Nonce).value
        }

    fun getFeeSnapshot(): CompletableFuture<CitizenFeeSnapshot> =
        request({ native.getFeeSnapshot() }) { (it as CitizenSdkNativeResult.Fee).value }

    /** 所有目录事实均来自同一次Core快照，冷钱包同样满足初始化门禁。 */
    fun getWalletState(): CitizenSdkOperation<CitizenWalletState> =
        requestOperation({ native.getWalletState() }) { (it as CitizenSdkNativeResult.WalletState).value }

    fun inspectWallets(): CitizenSdkOperation<CitizenWalletInspection> =
        requestOperation({ native.inspectWallets() }) { result ->
            val value = result as CitizenSdkNativeResult.WalletState
            check(value.inspectionToken > 0) { "检查结果缺少真实资源" }
            CitizenWalletInspection(native, value.inspectionToken, value.value, ::changeDiagnostic) { walletInspections.remove(it) }
                .also { walletInspections.add(it) }
        }

    private fun changeDiagnostic(inspection: CitizenWalletInspection, action: Int, index: Long, name: String?): CitizenSdkOperation<CitizenWalletState> =
        synchronized(lifecycleGate) {
            requireOpen()
            require(index in 0..0xffffffffL)
            val normalized = name?.let(::checkedAccountName)
            // 锁顺序与close一致：实例生命周期门在前，资源门在后。
            inspection.withHandle(native) { token ->
                requestOperation({ native.changeDiagnostic(token, index, action, normalized) }) {
                    (it as CitizenSdkNativeResult.WalletState).value
                }
            }
        }

    fun importColdAccount(accountId: ByteArray, name: String = ""): CitizenSdkOperation<CitizenWalletState> {
        val normalized = if (name.isEmpty()) "" else checkedAccountName(name)
        return requestOperation({ native.importColdAccountId(accountId.requireSize(32, "accountId"), normalized) }) {
            (it as CitizenSdkNativeResult.WalletState).value
        }
    }

    fun importColdAccount(ss58Address: String, name: String = ""): CitizenSdkOperation<CitizenWalletState> {
        require(ss58Address.isNotEmpty() && ss58Address.toByteArray(Charsets.UTF_8).size <= 64) {
            "cold account SS58 is invalid"
        }
        val normalized = if (name.isEmpty()) "" else checkedAccountName(name)
        return requestOperation({ native.importColdAccountSs58(ss58Address, normalized) }) {
            (it as CitizenSdkNativeResult.WalletState).value
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
        return requestOperation({ native.reorderWalletAccounts(revision, checked) }) {
            (it as CitizenSdkNativeResult.WalletState).value
        }
    }

    /** 唯一Core同修订CAS；不触发默认账户授权或金库访问。 */
    fun setActiveWallet(expectedRevision: String, walletIndex: Long): CitizenSdkOperation<CitizenWalletState> {
        require(walletIndex in 0..0xffffffffL)
        require(Regex("^(0|[1-9][0-9]*)$").matches(expectedRevision))
        val revision = java.lang.Long.parseUnsignedLong(expectedRevision)
        return requestOperation({ native.setActiveWallet(revision, walletIndex) }) { (it as CitizenSdkNativeResult.WalletState).value }
    }

    fun renameWallet(expectedRevision: String, walletIndex: Long, name: String): CitizenSdkOperation<CitizenWalletState> {
        require(walletIndex in 0..0xffffffffL)
        require(Regex("^(0|[1-9][0-9]*)$").matches(expectedRevision))
        val revision = java.lang.Long.parseUnsignedLong(expectedRevision)
        val normalized = checkedAccountName(name)
        return requestOperation({ native.renameWallet(revision, walletIndex, normalized) }) { (it as CitizenSdkNativeResult.WalletState).value }
    }

    fun renameAccount(accountId: ByteArray, name: String): CitizenSdkOperation<CitizenWalletState> {
        val normalized = checkedAccountName(name)
        return requestOperation({ native.renameAnyAccount(accountId.requireSize(32, "accountId"), normalized) }) {
            (it as CitizenSdkNativeResult.WalletState).value
        }
    }

    fun deleteAccount(accountId: ByteArray): CitizenSdkOperation<CitizenWalletState> =
        requestOperation({ native.deleteAnyAccount(accountId.requireSize(32, "accountId")) }) {
            (it as CitizenSdkNativeResult.WalletState).value
        }

    fun setActiveWalletAccount(accountId: ByteArray): CitizenSdkOperation<CitizenWalletProfile> =
        requestOperation({ native.setActiveWalletAccount(accountId.requireSize(32, "accountId")) }) {
            requireWalletProfile(it, "set active wallet account")
        }

    /** 胁迫/PIN清除不追加认证；用户主动“签名并删除”使用独立授权入口。 */
    fun deleteWallet(): CitizenSdkOperation<Unit> = emptyOperation { native.deleteWallet() }
    fun signAndDeleteWallet(): CitizenSdkOperation<Unit> = emptyOperation { native.signAndDeleteWallet() }

    /** 清理完成后读公开profile；取消只转交当前真实请求，不提前完成结果。 */
    fun reconcileWalletCleanup(): CitizenSdkOperation<CitizenWalletProfile?> {
        val cleanup = emptyOperation { native.reconcileWalletCleanup() }
        val current = java.util.concurrent.atomic.AtomicReference<() -> Boolean>(cleanup::cancel)
        val result = cleanup.future.thenCompose {
            val read = requestOperation({ native.getWalletProfile() }) { (it as CitizenSdkNativeResult.Profile).value }
            current.set(read::cancel)
            read.future
        }
        return CitizenSdkOperation(cleanup.operationId, result) { current.get().invoke() }
    }

    /** 通用签名只接收不透明载荷；应用业务语义不会进入 SDK。 */
    val signing = CitizenSigning.create(
        ::sign,
        ::beginSigning,
        ::consumeExternalSignature,
        ::cancelSigningSession,
        ::reviewQrRequest,
        ::signQrRequest,
    )

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
        return requestOperation({ native.beginDefaultAccountChange(revision, checked, ttlSeconds) }) {
            (it as? CitizenSdkNativeResult.DefaultAccountChange)?.value
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
        return requestOperation({ native.consumeDefaultAccountChange(sessionId, response) }) {
            (it as? CitizenSdkNativeResult.DefaultAccountChange)?.value
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
        synchronized(lifecycleGate) { requireOpen(); native.qrParse(text) }
    fun qrEncodeDocument(content: CitizenQrContent): CitizenQrDocument =
        synchronized(lifecycleGate) { requireOpen(); native.qrEncodeDocument(content.inputJson) }
    fun qrPrepareAccountAuthorization(action: Int, payload: ByteArray, accountId: String): CitizenQrAuthorization =
        synchronized(lifecycleGate) { requireOpen(); native.qrPrepareAccountAuthorization(action, payload, accountId) }

    fun qrCreateSignRequest(
        action: Int, signerAccountId: ByteArray, reviewPayload: ByteArray, ttlSeconds: Long,
    ): String = synchronized(lifecycleGate) {
        requireOpen()
        native.qrCreateSignRequest(action, signerAccountId.requireSize(32, "signerAccountId"), reviewPayload.clone(), ttlSeconds)
    }

    /** 只验证本实例会话，不消费；最终提交仍须调用原消费入口。 */
    fun qrValidateSignResponse(sessionId: String, response: String) =
        synchronized(lifecycleGate) { requireOpen(); native.qrValidateSignResponse(sessionId, response) }

    fun qrConsumeSignResponse(text: String): ByteArray =
        synchronized(lifecycleGate) { requireOpen(); native.qrConsumeSignResponse(text) }

    fun qrCancelSignRequest(requestId: String): Boolean =
        synchronized(lifecycleGate) { requireOpen(); native.qrCancelSignRequest(requestId) }

    fun qrEncodeAccountId(accountId: ByteArray): String =
        synchronized(lifecycleGate) { requireOpen(); native.qrEncodeAccountId(accountId.requireSize(32, "accountId")) }

    fun qrDecodeLuminance(data: ByteArray, width: Int, height: Int, rowStride: Int): CitizenQrDocument =
        synchronized(lifecycleGate) {
            requireOpen(); requireQrModule()
            native.qrDecodeLuminance(data.clone(), width, height, rowStride)
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
                synchronized(lifecycleGate) { requireOpen(); native.qrDecodeLuminanceAll(luminance, bitmap.width, bitmap.height, bitmap.width) }
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
            native.qrEncode(text, scale)
        }

    /** Core返回审阅事实；是否确认和如何展示由宿主自己的UI负责。 */
    private fun reviewQrRequest(text: String): CitizenSdkOperation<CitizenQrReview> =
        requestOperation({ native.reviewQrSignRequest(text) }) {
            check(it is CitizenSdkNativeResult.QrReview)
            CitizenQrReview(native, it.token, it.json) { review -> qrReviews.remove(review) }
                .also { review -> qrReviews.add(review) }
        }

    private fun signQrRequest(review: CitizenQrReview): CitizenSdkOperation<CitizenQrSigned> {
        val operation = review.withHandle(native) { token ->
            requestOperation({ native.signQrRequest(token) }) {
                check(it is CitizenSdkNativeResult.QrSigned)
                CitizenQrSigned(it.value, qrEncode(it.value.canonicalText))
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

    private fun sign(accountId: ByteArray, message: ByteArray): CitizenSdkOperation<CitizenSignature> {
        CitizenSdkInputLimits.requireSignPayload(message.size)
        return requestOperation({
            native.signWalletPayload(accountId.requireSize(32, "accountId"), message.clone())
        }) { (it as CitizenSdkNativeResult.Signature).value }
    }

    private fun beginSigning(intent: CitizenSigningIntent): CitizenSdkOperation<CitizenSigningOutcome> =
        requestOperation({ native.beginSigning(intent) }) {
            (it as? CitizenSdkNativeResult.SigningOutcome)?.value
                ?: throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned an invalid signing result kind",
                )
        }

    private fun consumeExternalSignature(
        sessionId: String,
        response: String,
    ): CitizenSdkOperation<CitizenSigningOutcome> {
        requireExternalSigningText(sessionId, response)
        return requestOperation({ native.consumeExternalSignature(sessionId, response) }) {
            (it as? CitizenSdkNativeResult.SigningOutcome)?.value
                ?: throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned an invalid signing result kind",
                )
        }
    }

    private fun cancelSigningSession(sessionId: String): Boolean {
        require(sessionId.toByteArray(Charsets.UTF_8).size in 1..128) {
            "external signing sessionId must contain 1..128 UTF-8 bytes"
        }
        return synchronized(lifecycleGate) {
            requireOpen()
            native.cancelSigningSession(sessionId)
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
        return request({ native.prepareTransaction(source, copiedCall) }) { result ->
            val prepared = result as? CitizenSdkNativeResult.PreparedTransaction
                ?: throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned an invalid prepared transaction result",
                )
            if (!prepared.value.sourceAccountId().contentEquals(source) ||
                preparedTransactions.putIfAbsent(prepared.value.preparationId, prepared.token) != null
            ) {
                runCatching { native.releasePreparedTransaction(prepared.token) }
                throw CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "Core returned a mismatched or duplicate transaction preparation",
                )
            }
            prepared.value
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
            native.releasePreparedTransaction(token)
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
            request({ native.executePreparedTransaction(token) }) {
                (it as CitizenSdkNativeResult.TransactionExecution).value
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
        return request({ native.consumePreparedTransactionQrResponse(id, response.toByteArray(Charsets.UTF_8)) }) {
            val value = (it as CitizenSdkNativeResult.TransactionExecution).value
            value as? CitizenTransactionExecution.Completed
                ?: throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "Core did not return a terminal execution")
        }
    }

    fun cancelPreparedTransactionExecution(executionId: String) {
        native.cancelPreparedTransactionExecution(executionIdBytes(executionId))
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
        return request({ native.getTransactionHistory(before, limit) }) {
            (it as CitizenSdkNativeResult.TransactionHistoryPage).value
        }
    }

    /** Reconciles at most one bounded generic execution batch. */
    fun syncTransactionHistory(): CompletableFuture<CitizenTransactionHistoryPage> =
        request({ native.syncTransactionHistory() }) {
            (it as CitizenSdkNativeResult.TransactionHistoryPage).value
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
                native.openPrivateKeyView(accountId, buffer).also { identities = it }[0]
            }, {
                check(it is CitizenSdkNativeResult.Empty) { "private key view returned a non-empty result" }
                Unit
            })
        }
        val ids = checkNotNull(identities)
        val drained = core.future.whenComplete { _, _ ->
            // 普通请求已真实排空，才释放 JNI global ref；阶段 settled 绝不能走此路径。
            native.releasePrivateKeyViewContext(ids[2])
            buffer.authenticationId()?.let(hostServices::releasePrivateKeyAuthentication)
            readinessBoundaryCompleted()
        }
        return ids[1] to CitizenSdkOperation(core.operationId, drained, core::cancel)
    }
    @JvmSynthetic internal fun revealPrivateKeyResource(viewId: Long) = native.revealPrivateKeyView(viewId)
    @JvmSynthetic internal fun cancelPrivateKeyResource(viewId: Long) = native.cancelPrivateKeyView(viewId)
    @JvmSynthetic internal fun finishPrivateKeyResource(viewId: Long) = native.finishPrivateKeyView(viewId)
    @JvmSynthetic internal fun isPrivateKeyAuthenticationActive(operationId: Long, activity: FragmentActivity): Boolean =
        hostServices.isPrivateKeyAuthenticationActive(operationId, activity)
    @JvmSynthetic internal fun cancelPrivateKeyAuthentication(operationId: Long) = hostServices.cancelPrivateKeyAuthentication(operationId)

    /** 输入字节仅在同步接纳期间借用；Core在返回请求前复制并负责清零。 */
    fun prepareWalletCreation(wordCount: Int, password: ByteArray = byteArrayOf()): CitizenSdkOperation<CitizenSdkPreparedWallet> =
        requestOperation({
            CitizenSdkInputLimits.requireWalletSecret("password", password.size)
            native.prepareWalletCreation(wordCount, password)
        }) {
            CitizenSdkPreparedWallet.create(native, (it as CitizenSdkNativeResult.Prepared).token, ::commitPreparedWallet) {
                prepared -> preparedWallets.remove(prepared)
            }
                .also { prepared -> preparedWallets.add(prepared) }
        }

    fun importWallet(mnemonic: ByteArray, password: ByteArray = byteArrayOf()): CitizenSdkOperation<CitizenWalletProfile> =
        requestOperation({
            CitizenSdkInputLimits.requireWalletSecret("mnemonic", mnemonic.size)
            CitizenSdkInputLimits.requireWalletSecret("password", password.size)
            native.importWallet(mnemonic, password)
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
            native.addWalletAccounts(mnemonic, password, indices)
        }) { requireWalletProfile(it, "add wallet accounts") }
    }

    /** 编号由Core在同一操作门内分配，绑定层不读max+1，也不进行追加后的二次查询。 */
    fun addNextWalletAccount(mnemonic: ByteArray, password: ByteArray = byteArrayOf()): CitizenSdkOperation<CitizenWalletProfile> =
        requestOperation({
            CitizenSdkInputLimits.requireWalletSecret("mnemonic", mnemonic.size)
            CitizenSdkInputLimits.requireWalletSecret("password", password.size)
            native.addNextWalletAccount(mnemonic, password)
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
                CitizenSdkClosePolicy.validate(native.lifecycle())
            }
            closing.set(true)
            closeActive = true
        }
        try {
            // 回调可以同步重入公开门面。屏障期间只保留 closing 状态，不占 lifecycleGate。
            native.close()
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
            if (it !is CitizenSdkNativeResult.Empty) throw CitizenSdkException(
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
            unitRequest({ native.refreshCapabilities() }, notifyReadinessBoundary = false)
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
        decode: (CitizenSdkNativeResult) -> T,
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
        decode: (CitizenSdkNativeResult) -> T,
    ): CompletableFuture<T> = requestOperation(begin, notifyReadinessBoundary, decode).future

    private fun emptyOperation(begin: () -> Long): CitizenSdkOperation<Unit> =
        requestOperation(begin) {
            if (it !is CitizenSdkNativeResult.Empty) throw CitizenSdkException(
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
        val tuple = native.validateWalletInput(kind, input, wordCount)
        check(tuple.size == 2 && tuple[0] in CitizenWalletInputReason.entries.indices)
        val reason = CitizenWalletInputReason.entries[tuple[0]]
        val position = if (tuple[1] == -1) null else tuple[1]
        check(if (reason == CitizenWalletInputReason.UNKNOWN_WORD) position != null && position in 0..23 else position == null)
        return CitizenWalletInputValidation(reason, position)
    }

    fun walletWordSuggestions(prefix: ByteArray): List<String> {
        CitizenSdkInputLimits.requireWalletSecret("prefix", prefix.size)
        val bytes = native.walletWordSuggestions(prefix)
        return try { bytes.toString(Charsets.UTF_8).split('\n').filter { it.isNotEmpty() } }
        finally { bytes.fill(0) }
    }

    private fun requireWalletProfile(
        result: CitizenSdkNativeResult,
        operation: String,
    ): CitizenWalletProfile = (result as? CitizenSdkNativeResult.Profile)?.value
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
            CitizenSdkNative.validateModules(modules)
            val sdk = CitizenSdk(context, listener, modules)
            return try {
                sdk.awaitReadinessBarrier()
                sdk
            } catch (error: Throwable) {
                runCatching { sdk.close() }
                throw error
            }
        }
    }
}

/** 本地签名始终使用 SDK 金库；静态验签只处理公开数据，不创建 SDK 或访问设备密钥。 */
class CitizenSigning private constructor(
    private val signOperation: (ByteArray, ByteArray) -> CitizenSdkOperation<CitizenSignature>,
    private val beginOperation: (CitizenSigningIntent) -> CitizenSdkOperation<CitizenSigningOutcome>,
    private val consumeOperation: (String, String) -> CitizenSdkOperation<CitizenSigningOutcome>,
    private val cancelOperation: (String) -> Boolean,
    private val reviewOperation: (String) -> CitizenSdkOperation<CitizenQrReview>,
    private val signQrOperation: (CitizenQrReview) -> CitizenSdkOperation<CitizenQrSigned>,
) {
    fun sign(accountId: ByteArray, message: ByteArray): CitizenSdkOperation<CitizenSignature> =
        signOperation(accountId, message)

    fun begin(intent: CitizenSigningIntent): CitizenSdkOperation<CitizenSigningOutcome> =
        beginOperation(intent)

    fun consumeExternalSignature(
        sessionId: String,
        response: String,
    ): CitizenSdkOperation<CitizenSigningOutcome> = consumeOperation(sessionId, response)

    fun cancel(sessionId: String): Boolean = cancelOperation(sessionId)
    fun reviewQrRequest(text: String): CitizenSdkOperation<CitizenQrReview> = reviewOperation(text)
    fun signQrRequest(review: CitizenQrReview): CitizenSdkOperation<CitizenQrSigned> = signQrOperation(review)

    companion object {
        /** 签名分区只能由 SDK 持有的原生请求入口构造，Java 宿主不能注入替代实现。 */
        @JvmSynthetic
        internal fun create(
            sign: (ByteArray, ByteArray) -> CitizenSdkOperation<CitizenSignature>,
            begin: (CitizenSigningIntent) -> CitizenSdkOperation<CitizenSigningOutcome>,
            consume: (String, String) -> CitizenSdkOperation<CitizenSigningOutcome>,
            cancel: (String) -> Boolean,
            review: (String) -> CitizenSdkOperation<CitizenQrReview>,
            signQr: (CitizenQrReview) -> CitizenSdkOperation<CitizenQrSigned>,
        ): CitizenSigning = CitizenSigning(sign, begin, consume, cancel, review, signQr)

        @JvmStatic
        fun verify(accountId: ByteArray, signature: ByteArray, message: ByteArray): Boolean {
            CitizenSdkInputLimits.requireSignPayload(message.size)
            return CitizenSdkNative.verifySignature(
                accountId.requireSize(32, "accountId"), signature.requireSize(64, "signature"), message,
            )
        }
        @JvmStatic
        fun encodePayload(payload: CitizenSigningPayload): ByteArray =
            CitizenSdkNative.encodeSigningPayload(payload.kind, payload.fieldsJson.toByteArray(Charsets.UTF_8), payload.payloadBytes())
    }
}

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
