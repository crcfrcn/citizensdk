package org.citizen.sdk

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.fragment.app.FragmentActivity
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.TextureRegistry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.UUID
import org.citizen.sdk.internal.CitizenSdkSensitiveBytes

/** Owns public Flutter session identities without exposing Core ownership IDs. */
/** 诊断只接受闭集事实；不接收异常、参数、账户或会话标识，最多3×8条。 */
internal class CitizenSdkFlutterDiagnostics(private val emit: (String) -> Unit) {
    enum class Phase { BEGIN, ADMISSION, DECODE, COMPLETE }
    enum class Sync { UNKNOWN, SYNCING, USABLE, UNAVAILABLE }
    enum class StartStep { NONE, RESTORE, BEGIN, PUBLISH_BEGIN, PROVIDER_START, REFRESH, COMPLETE, SERVICES, PUBLISH_COMPLETE }
    private val seen = mutableMapOf<String, MutableSet<String>>()

    @Synchronized
    fun record(method: String, phase: Phase, code: CitizenSdkErrorCode = CitizenSdkErrorCode.OK,
               stage: CitizenSdkFailureStage? = null, lifecycle: CitizenSdkLifecycle? = null,
               elapsedNanos: Long = 0, sync: Sync = Sync.UNKNOWN, startStep: StartStep = StartStep.NONE) {
        if (method !in setOf("open", "start", "getSyncStatus")) return
        val step = if (method == "start") " start_step=${startStep.name}" else ""
        val signature = "phase=${phase.name} code=${code.name} stage=${stage?.name ?: "NONE"} lifecycle=${lifecycle?.name ?: "UNKNOWN"} sync=${sync.name}$step"
        val entries = seen.getOrPut(method) { mutableSetOf() }
        if (entries.size >= 8 || !entries.add(signature)) return
        val millis = (elapsedNanos.coerceAtLeast(0) / 1_000_000).coerceAtMost(86_400_000)
        // 诊断失效不得改变原请求结果；Android日志缓冲由系统管理，不另存文件。
        try { emit("method=$method $signature elapsed_ms=$millis") } catch (_: Throwable) {}
    }
}

/** 只认可Rust固定文案；异常原文、后缀、控制字符和其它方法一律映射为NONE。 */
internal fun citizenSdkFlutterStartStep(code: CitizenSdkErrorCode, message: String?): CitizenSdkFlutterDiagnostics.StartStep {
    if (code != CitizenSdkErrorCode.PANIC) return CitizenSdkFlutterDiagnostics.StartStep.NONE
    val prefix = "CitizenSDK start panicked at "
    return when (message) {
        "${prefix}RESTORE" -> CitizenSdkFlutterDiagnostics.StartStep.RESTORE
        "${prefix}BEGIN" -> CitizenSdkFlutterDiagnostics.StartStep.BEGIN
        "${prefix}PUBLISH_BEGIN" -> CitizenSdkFlutterDiagnostics.StartStep.PUBLISH_BEGIN
        "${prefix}PROVIDER_START" -> CitizenSdkFlutterDiagnostics.StartStep.PROVIDER_START
        "${prefix}REFRESH" -> CitizenSdkFlutterDiagnostics.StartStep.REFRESH
        "${prefix}COMPLETE" -> CitizenSdkFlutterDiagnostics.StartStep.COMPLETE
        "${prefix}SERVICES" -> CitizenSdkFlutterDiagnostics.StartStep.SERVICES
        "${prefix}PUBLISH_COMPLETE" -> CitizenSdkFlutterDiagnostics.StartStep.PUBLISH_COMPLETE
        else -> CitizenSdkFlutterDiagnostics.StartStep.NONE
    }
}

internal enum class CitizenSdkFlutterCloseAction { STOP_THEN_CLOSE, CLOSE, REJECT_UNSTABLE }

internal fun citizenSdkFlutterCloseAction(lifecycle: CitizenSdkLifecycle): CitizenSdkFlutterCloseAction =
    when (lifecycle) {
        CitizenSdkLifecycle.RUNNING -> CitizenSdkFlutterCloseAction.STOP_THEN_CLOSE
        CitizenSdkLifecycle.CREATED,
        CitizenSdkLifecycle.STOPPED,
        CitizenSdkLifecycle.START_FAILED,
        CitizenSdkLifecycle.DISPOSED,
        -> CitizenSdkFlutterCloseAction.CLOSE
        CitizenSdkLifecycle.STARTING,
        CitizenSdkLifecycle.IMPORTING_STATE,
        -> CitizenSdkFlutterCloseAction.REJECT_UNSTABLE
    }

internal fun citizenSdkFlutterCloseLifecycle(
    lifecycle: CitizenSdkLifecycle,
    stop: () -> CompletableFuture<Void>,
    dispose: () -> Unit,
): CompletableFuture<Void> {
    val prerequisite = when (citizenSdkFlutterCloseAction(lifecycle)) {
        CitizenSdkFlutterCloseAction.STOP_THEN_CLOSE -> stop()
        CitizenSdkFlutterCloseAction.CLOSE -> CompletableFuture.completedFuture(null)
        CitizenSdkFlutterCloseAction.REJECT_UNSTABLE -> CompletableFuture<Void>().also {
            it.completeExceptionally(
                CitizenSdkException(
                    CitizenSdkErrorCode.INVALID_STATE,
                    "CitizenSDK lifecycle did not settle before supervised close",
                ),
            )
        }
    }
    // A running instance reaches dispose only after stop has persisted its
    // checkpoint. A failed stop leaves the instance owned and retryable.
    return prerequisite.thenRun { dispose() }
}

private const val CITIZEN_SDK_OPEN_INVALID_STATE =
    "CitizenSDK operation is invalid in the current state"

/** Open没有业务输入；只允许单行有界宿主不变量穿过Flutter边界，其他内容仍使用通用文案。 */
internal fun citizenSdkFlutterOpenInvalidState(message: String?): String {
    val value = message ?: return CITIZEN_SDK_OPEN_INVALID_STATE
    if (value.toByteArray(Charsets.UTF_8).size !in 1..512 ||
        value.any { it.code < 0x20 || it.code == 0x7f }
    ) return CITIZEN_SDK_OPEN_INVALID_STATE
    return value
}

/** Open宿主错误同样没有业务输入；只暴露受限类型名与单行消息。 */
internal fun citizenSdkFlutterOpenHostFailure(error: Throwable): String {
    val type = error.javaClass.simpleName.takeIf { it.matches(Regex("[A-Za-z][A-Za-z0-9]{0,127}")) }
        ?: return "CitizenSDK host failure"
    val message = citizenSdkFlutterOpenInvalidState(error.message)
    return "$type: $message"
}

internal fun interface CitizenSdkFlutterRetryScheduler {
    fun schedule(delayMillis: Long, task: () -> Unit)
}

/** Process-owned strong registry for detach cleanup that must survive plugin GC. */
internal class CitizenSdkFlutterOrphanSupervisor<T : Any>(
    private val scheduler: CitizenSdkFlutterRetryScheduler,
    private val close: (T) -> CompletableFuture<Void>,
) {
    private class State(var failures: Int = 0)
    private val entries = ConcurrentHashMap<T, State>()

    fun supervise(value: T) {
        val state = State()
        if (entries.putIfAbsent(value, state) == null) attempt(value, state)
    }

    private fun attempt(value: T, state: State) {
        val future = try {
            close(value)
        } catch (error: Throwable) {
            CompletableFuture<Void>().also { it.completeExceptionally(error) }
        }
        future.whenComplete { _, error ->
            if (error == null) {
                entries.remove(value, state)
                return@whenComplete
            }
            // Retry indefinitely, but keep the counter itself bounded so a
            // permanently unavailable provider cannot overflow it.
            if (state.failures < 128) state.failures++
            val delay = retryDelayMillis(state.failures)
            scheduler.schedule(delay) {
                if (entries[value] === state) attempt(value, state)
            }
        }
    }

    internal fun sizeForTest(): Int = entries.size
    internal fun failuresForTest(value: T): Int? = entries[value]?.failures

    companion object {
        internal fun retryDelayMillis(failures: Int): Long {
            val shift = (failures - 1).coerceIn(0, 7)
            return (250L shl shift).coerceAtMost(30_000L)
        }
    }
}

internal object CitizenSdkFlutterProcessOrphans : CitizenSdkFlutterRetryScheduler {
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "citizensdk-flutter-detach").apply { isDaemon = true }
    }
    private val supervisor = CitizenSdkFlutterOrphanSupervisor<CitizenSdkFlutterSessions>(
        CitizenSdkFlutterRetryScheduler { delay, task ->
            executor.schedule({ task() }, delay, TimeUnit.MILLISECONDS)
        },
        CitizenSdkFlutterSessions::closeAll,
    )

    fun supervise(sessions: CitizenSdkFlutterSessions) = supervisor.supervise(sessions)

    override fun schedule(delayMillis: Long, task: () -> Unit) {
        executor.schedule({ task() }, delayMillis, TimeUnit.MILLISECONDS)
    }
}

private data class CitizenSdkFlutterClosePlan(
    val owner: Boolean,
    val outstanding: List<CitizenSdkFlutterOutstanding>,
    val completion: CompletableFuture<Void>,
)

private data class CitizenSdkFlutterOutstanding(
    val future: CompletableFuture<*>,
    val cancel: (() -> Unit)?,
)

internal fun citizenSdkFlutterSettleWithin(
    outstanding: List<CompletableFuture<*>>,
    timeoutMillis: Long,
    scheduler: CitizenSdkFlutterRetryScheduler,
): CompletableFuture<Void> {
    require(timeoutMillis > 0)
    if (outstanding.isEmpty()) return CompletableFuture.completedFuture(null)
    val settlement = CompletableFuture<Void>()
    CompletableFuture.allOf(*outstanding.toTypedArray()).whenComplete { _, _ ->
        settlement.complete(null)
    }
    if (!settlement.isDone) {
        scheduler.schedule(timeoutMillis) {
            settlement.completeExceptionally(
                CitizenSdkException(
                    CitizenSdkErrorCode.TIMEOUT,
                    "CitizenSDK accepted work did not settle before supervised close",
                ),
            )
        }
    }
    return settlement
}

internal class CitizenSdkFlutterSubscriptionGate<T : Any> {
    data class Token<T : Any>(val generation: Long, val value: T)

    private var generation = 0L
    private var current: Token<T>? = null

    @Synchronized
    fun open(value: T): Token<T>? {
        if (current != null || generation == Long.MAX_VALUE) return null
        val token = Token(++generation, value)
        current = token
        return token
    }

    @Synchronized
    fun close() {
        current = null
        if (generation != Long.MAX_VALUE) generation++
    }

    @Synchronized
    fun current(): Token<T>? = current

    @Synchronized
    fun owns(token: Token<T>): Boolean =
        current?.generation == token.generation && current?.value === token.value
}

internal class CitizenSdkFlutterSessions(context: Context, private val textures: TextureRegistry? = null) : EventChannel.StreamHandler {

    private inner class Session(val sdk: CitizenSdk, val diagnostics: CitizenSdkFlutterDiagnostics) {
        val nextEvent = AtomicLong(1)
        private val stateLock = Any()
        private val inFlight = linkedMapOf<CompletableFuture<*>, CitizenSdkFlutterOutstanding>()
        private val cancellations = linkedMapOf<Long, () -> Boolean>()
        val prepared = ConcurrentHashMap<String, CitizenSdkPreparedWallet>()
        val privateKeys = ConcurrentHashMap<String, CitizenSdkPrivateKey>()
        val reviews = ConcurrentHashMap<String, CitizenQrReview>()
        val inspections = ConcurrentHashMap<String, CitizenWalletInspection>()
        val captures = ConcurrentHashMap<String, CitizenSdkQrCapture>()
        private var closing = false
        private var closeCompletion: CompletableFuture<Void>? = null

        fun acceptRequestSequence(sequence: Long) = synchronized(stateLock) {
            if (closing) throw CitizenSdkException(CitizenSdkErrorCode.INVALID_STATE, "CitizenSDK session is closing")
            sdk.acceptRequestSequence(sequence)
        }

        fun dispatchAccepted(action: () -> Unit): Boolean = synchronized(stateLock) {
            if (closing) return false
            // 接纳已在参数解码前由Core执行；本锁仅防detach穿过原生调用及在途登记。
            action()
            true
        }

        fun track(future: CompletableFuture<*>, cancel: (() -> Unit)? = null) {
            val outstanding = CitizenSdkFlutterOutstanding(future, cancel)
            synchronized(stateLock) { inFlight[future] = outstanding }
            future.whenComplete { _, _ -> synchronized(stateLock) { inFlight -= future } }
        }

        fun registerCancel(sequence: Long, future: CompletableFuture<*>, cancel: () -> Boolean) {
            synchronized(stateLock) { cancellations[sequence] = cancel }
            future.whenComplete { _, _ -> synchronized(stateLock) { cancellations.remove(sequence) } }
        }
        fun cancel(sequence: Long): Boolean = synchronized(stateLock) { cancellations[sequence]?.invoke() ?: false }

        fun <T : AutoCloseable> adopt(map: ConcurrentHashMap<String, T>, resource: T): String = synchronized(stateLock) {
            if (closing) {
                resource.close()
                throw CitizenSdkException(CitizenSdkErrorCode.CANCELLED, "session is closing")
            }
            UUID.randomUUID().toString().also { map[it] = resource }
        }
        fun adoptPrivate(resource: CitizenSdkPrivateKey): CompletableFuture<String> = synchronized(stateLock) {
            if (closing) resource.close().thenApply<String> {
                throw CitizenSdkException(CitizenSdkErrorCode.CANCELLED, "session is closing")
            }
            else CompletableFuture.completedFuture(UUID.randomUUID().toString().also { id ->
                privateKeys[id] = resource
                resource.closed.whenComplete { _, _ -> emit(this, "privateKeyClosed", listOf(id)) }
            })
        }

        fun adoptCapture(id: String, resource: CitizenSdkQrCapture): CompletableFuture<CitizenSdkQrCapture> = synchronized(stateLock) {
            if (closing) resource.close().thenApply { throw CitizenSdkException(CitizenSdkErrorCode.CANCELLED, "session is closing") }
            else CompletableFuture.completedFuture(resource.also { captures[id] = it })
        }

        fun beginClose(): CitizenSdkFlutterClosePlan = synchronized(stateLock) {
            closeCompletion?.let { return CitizenSdkFlutterClosePlan(false, emptyList(), it) }
            closing = true
            val completion = CompletableFuture<Void>()
            closeCompletion = completion
            CitizenSdkFlutterClosePlan(true, inFlight.values.toList(), completion)
        }

        fun reopenAfterFailedClose() = synchronized(stateLock) {
            closing = false
            closeCompletion = null
        }
    }

    private val applicationContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val sessions = linkedMapOf<String, Session>()

    @Volatile private var activity: FragmentActivity? = null
    private val subscriptions = CitizenSdkFlutterSubscriptionGate<EventChannel.EventSink>()

    fun attachActivity(value: FragmentActivity) {
        activity = value
        snapshot().forEach { it.sdk.attachActivity(value) }
    }

    /** Configuration changes only replace the UI host; sessions stay alive. */
    fun detachActivity(value: FragmentActivity) {
        if (activity === value) activity = null
        snapshot().forEach { it.sdk.detachActivity(value) }
    }

    fun acceptRequestSequence(request: CitizenSdkFlutterCodec.Request.Empty) {
        val session = synchronized(lock) { sessions[request.sessionId] }
            ?: throw CitizenSdkException(CitizenSdkErrorCode.NOT_FOUND, "CitizenSDK session was not found")
        try {
            session.acceptRequestSequence(request.requestSequence)
            session.diagnostics.record(request.method, CitizenSdkFlutterDiagnostics.Phase.ADMISSION, lifecycle = session.sdk.lifecycle)
        } catch (error: CitizenSdkException) {
            session.diagnostics.record(request.method, CitizenSdkFlutterDiagnostics.Phase.ADMISSION,
                error.code, error.stage, session.sdk.lifecycle)
            throw error
        }
    }

    fun dispatch(request: CitizenSdkFlutterCodec.Request, result: MethodChannel.Result) {
        if (request is CitizenSdkFlutterCodec.Request.EncodePayload) {
            try { result.success(listOf(CitizenSdkFlutterCodec.PROTOCOL_VERSION,
                CitizenSigning.encodePayload(CitizenSigningPayload(request.kind, request.fieldsJson, request.payload)))) }
            catch (error: Throwable) { fail(result, error, request) }
            return
        }
        if (request is CitizenSdkFlutterCodec.Request.VerifySignature) {
            // 公开验签先于会话、序号和资源装配处理，不要求事件订阅或 Activity。
            try { result.success(verifySignature(request)) }
            catch (error: Throwable) { fail(result, error, request) }
            return
        }
        if (request is CitizenSdkFlutterCodec.Request.Open) {
            open(request.modules, result)
            return
        }
        val sessionRequest = request as CitizenSdkFlutterCodec.Request.SessionRequest
        val session = synchronized(lock) { sessions[sessionRequest.sessionId] }
        if (session == null) {
            fail(result, CitizenSdkErrorCode.NOT_FOUND, "CitizenSDK session was not found", request)
            return
        }
        try {
            if (!session.dispatchAccepted {
                    route(session, sessionRequest, result)
                }
            ) {
                fail(
                    result,
                    CitizenSdkErrorCode.INVALID_STATE,
                    "CitizenSDK session is closing",
                    request,
                )
            }
        } catch (error: Throwable) {
            fail(result, error, request)
        }
    }

    /** Engine detach uses the same checkpointed stop-then-destroy path as close. */
    fun closeAll(): CompletableFuture<Void> {
        val futures = snapshot().map { supervisedClose(it) }
        return CompletableFuture.allOf(*futures.toTypedArray())
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        if (arguments != listOf(CitizenSdkFlutterCodec.PROTOCOL_VERSION)) {
            events.error(
                "citizensdk.invalidArgument",
                "CitizenSDK event subscription tuple is invalid",
                CitizenSdkFlutterCodec.errorDetails(
                    CitizenSdkErrorCode.INVALID_ARGUMENT,
                    "CitizenSDK event subscription tuple is invalid",
                    null,
                    null,
                    "open",
                ),
            )
            return
        }
        if (subscriptions.open(events) == null) {
            events.error(
                "citizensdk.busy",
                "CitizenSDK event subscription is already active",
                CitizenSdkFlutterCodec.errorDetails(
                    CitizenSdkErrorCode.BUSY,
                    "CitizenSDK event subscription is already active",
                    null,
                    null,
                    "open",
                ),
            )
            return
        }
        // Re-subscription gets fresh queryable snapshots; no absent-sink event
        // consumes a Flutter event sequence.
        snapshot().forEach { session ->
            emit(session, "lifecycleChanged", listOf(CitizenSdkFlutterCodec.lifecycle(session.sdk.lifecycle)))
            try {
                emit(
                    session,
                    "capabilitiesChanged",
                    listOf(CitizenSdkFlutterCodec.capabilities(session.sdk.getCapabilities())),
                )
            } catch (_: Throwable) {
                // Capability query failure remains observable through methods;
                // the event stream never transports Throwable details.
            }
        }
    }

    override fun onCancel(arguments: Any?) {
        subscriptions.close()
    }

    private fun open(modules: Int, result: MethodChannel.Result) {
        val diagnostics = CitizenSdkFlutterDiagnostics { android.util.Log.i("CitizenSDK", it) }
        val started = System.nanoTime()
        diagnostics.record("open", CitizenSdkFlutterDiagnostics.Phase.BEGIN)
        var sdk: CitizenSdk? = null
        try {
            val opened = CitizenSdk.open(applicationContext, null, modules)
            sdk = opened
            val session = Session(opened, diagnostics)
            diagnostics.record("open", CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
                lifecycle = opened.lifecycle, elapsedNanos = System.nanoTime() - started)
            opened.setEventListener { event -> onNativeEvent(session, event) }
            activity?.let(opened::attachActivity)
            synchronized(lock) {
                check(sessions.putIfAbsent(opened.sessionId, session) == null)
            }
            success(
                result,
                opened.sessionId,
                0,
                listOf(CitizenSdkFlutterCodec.lifecycle(opened.lifecycle), 1L),
            )
            // The Dart process router subscribes before open and remains the
            // single EventChannel consumer for every session. Emit an explicit
            // per-session baseline because a second Dart listener does not
            // trigger EventChannel.onListen again.
            emit(
                session,
                "lifecycleChanged",
                listOf(CitizenSdkFlutterCodec.lifecycle(opened.lifecycle)),
            )
            try {
                emit(
                    session,
                    "capabilitiesChanged",
                    listOf(CitizenSdkFlutterCodec.capabilities(opened.getCapabilities())),
                )
            } catch (_: Throwable) {
                // Method lookup remains the authoritative observable failure;
                // an unavailable snapshot never transports Throwable details.
            }
        } catch (error: Throwable) {
            diagnosticFailure(diagnostics, "open", error, sdk?.lifecycle, started)
            sdk?.close()
            fail(result, error, CitizenSdkFlutterCodec.Request.Open(modules))
        }
    }

    private fun route(
        session: Session,
        request: CitizenSdkFlutterCodec.Request.SessionRequest,
        result: MethodChannel.Result,
    ) {
        val sdk = session.sdk
        when (request) {
            is CitizenSdkFlutterCodec.Request.Empty -> when (request.method) {
                "start" -> complete(session, request, result, diagnosed(session, "start") { sdk.start() }) {
                    listOf(CitizenSdkFlutterCodec.lifecycle(sdk.lifecycle))
                }
                "stop" -> complete(session, request, result, sdk.stop()) {
                    listOf(CitizenSdkFlutterCodec.lifecycle(sdk.lifecycle))
                }
                "close" -> close(session, request, result)
                "getCapabilities" -> success(
                    result,
                    request.sessionId,
                    request.requestSequence,
                    listOf(CitizenSdkFlutterCodec.capabilities(sdk.getCapabilities())),
                )
                "getFinalizedHead" -> complete(session, request, result, sdk.getFinalizedHead()) {
                    listOf(CitizenSdkFlutterCodec.block(it))
                }
                "getSyncStatus" -> complete(session, request, result, diagnosed(session, "getSyncStatus") { sdk.getSyncStatus() }) {
                    listOf(CitizenSdkFlutterCodec.syncStatus(it))
                }
                "getBestHead" -> complete(session, request, result, sdk.getBestHead()) {
                    listOf(CitizenSdkFlutterCodec.block(it))
                }
                "exportState" -> complete(session, request, result, sdk.exportState()) {
                    listOf(CitizenSdkFlutterCodec.chainState(it))
                }
                "getGenesisHash" -> success(result, request.sessionId, request.requestSequence,
                    listOf(CitizenSdkFlutterCodec.encodeHash32(sdk.getGenesisHash())))
                "getFeeSnapshot" -> complete(session, request, result, sdk.getFeeSnapshot()) {
                    listOf(CitizenSdkFlutterCodec.fee(it))
                }
                "inspectWallets" -> complete(session, request, result, sdk.inspectWallets()) {
                    listOf(session.adopt(session.inspections, it), CitizenSdkFlutterCodec.walletState(it.state))
                }
                "getWalletState" -> complete(session, request, result, sdk.getWalletState()) {
                    listOf(CitizenSdkFlutterCodec.walletState(it))
                }
                "deleteWallet" -> complete(session, request, result, sdk.deleteWallet()) { emptyList() }
                "signAndDeleteWallet" -> complete(session, request, result, sdk.signAndDeleteWallet()) { emptyList() }
                "reconcileWalletCleanup" -> complete(
                    session,
                    request,
                    result,
                    sdk.reconcileWalletCleanup(),
                ) { listOf(CitizenSdkFlutterCodec.profile(it)) }
                else -> throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED, "Unsupported method")
            }
            is CitizenSdkFlutterCodec.Request.WalletInput -> routeWalletInput(session, request, result)
            is CitizenSdkFlutterCodec.Request.Resource -> routeResource(session, request, result)
            is CitizenSdkFlutterCodec.Request.ColdCode -> complete(
                session, request, result, sdk.importColdAccountCode(request.code, request.name),
            ) { listOf(CitizenSdkFlutterCodec.walletState(it)) }
            is CitizenSdkFlutterCodec.Request.Account -> when (request.method) {
                "openPrivateKey" -> {
                    val opened = sdk.openPrivateKey(request.accountId).thenCompose(session::adoptPrivate)
                    complete(session, request, result, opened) { listOf(it) }
                }
                "getAccountBalance" -> complete(
                    session,
                    request,
                    result,
                    sdk.getAccountBalance(request.accountId),
                ) { listOf(CitizenSdkFlutterCodec.balance(it)) }
                "getAccountNonce" -> complete(
                    session,
                    request,
                    result,
                    sdk.getAccountNonce(request.accountId),
                ) { listOf(CitizenSdkFlutterCodec.nonce(it)) }
                // Core 在同一 mutation 临界区内返回已经提交的原子 profile；
                // 这里不得再查询一次，否则会丢失该结果并扩大并发观察窗口。
                "setActiveWalletAccount" -> complete(
                    session,
                    request,
                    result,
                    sdk.setActiveWalletAccount(request.accountId),
                ) { listOf(CitizenSdkFlutterCodec.profile(it)) }
                "deleteAccount" -> complete(
                    session, request, result, sdk.deleteAccount(request.accountId),
                ) { listOf(CitizenSdkFlutterCodec.walletState(it)) }
                else -> throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED, "Unsupported method")
            }
            is CitizenSdkFlutterCodec.Request.Balances -> complete(
                session, request, result, sdk.getAccountBalances(request.accountIds),
            ) { values -> listOf(values.map(CitizenSdkFlutterCodec::balance)) }
            is CitizenSdkFlutterCodec.Request.BlockNumber -> complete(
                session, request, result, sdk.getFinalizedBlockAt(request.number),
            ) { listOf(CitizenSdkFlutterCodec.block(it)) }
            is CitizenSdkFlutterCodec.Request.ResolveBlock -> complete(
                session, request, result,
                sdk.resolveFinalizedBlock(request.hash, request.number),
            ) { listOf(CitizenSdkFlutterCodec.block(it)) }
            is CitizenSdkFlutterCodec.Request.Block -> {
                when (request.method) {
                    "getBlockHeader" -> complete(
                        session, request, result, sdk.getBlockHeader(request.block),
                    ) { listOf(CitizenSdkFlutterCodec.blockHeader(it)) }
                    "getBlockBody" -> complete(
                        session, request, result, sdk.getBlockBody(request.block),
                    ) { listOf(CitizenSdkFlutterCodec.blockBody(it)) }
                    "getRuntimeContext" -> complete(
                        session, request, result, sdk.getRuntimeContext(request.block),
                    ) { listOf(CitizenSdkFlutterCodec.runtimeContext(it)) }
                    "getSystemEvents" -> complete(
                        session, request, result, sdk.getSystemEvents(request.block),
                    ) { listOf(it) }
                    else -> throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED, "Unsupported block method")
                }
            }
            is CitizenSdkFlutterCodec.Request.Storage -> complete(
                session, request, result, sdk.getStorage(request.block, request.key),
            ) { listOf(it) }
            is CitizenSdkFlutterCodec.Request.StorageBatch -> complete(
                session, request, result, sdk.getStorageBatch(request.block, request.keys),
            ) { listOf(it) }
            is CitizenSdkFlutterCodec.Request.StorageKeysPage -> complete(
                session,
                request,
                result,
                sdk.getStorageKeysPaged(request.block, request.prefix, request.startKey, request.limit),
            ) { listOf(it) }
            is CitizenSdkFlutterCodec.Request.RuntimeApi -> complete(
                session,
                request,
                result,
                sdk.callRuntimeApi(request.block, request.method, request.arguments),
            ) { listOf(it) }
            is CitizenSdkFlutterCodec.Request.ImportState -> complete(
                session, request, result, sdk.importState(request.state),
            ) { emptyList() }
            is CitizenSdkFlutterCodec.Request.WalletInspection -> {
                val inspection = session.inspections[request.resourceId]
                    ?: throw CitizenSdkException(CitizenSdkErrorCode.NOT_FOUND, "检查资源不属于当前实例")
                val operation = when (request.method) {
                    "repairHotWallet" -> inspection.repairHot(request.walletIndex)
                    "deleteDiagnosticWallet" -> inspection.delete(request.walletIndex)
                    else -> inspection.rename(request.walletIndex, requireNotNull(request.name))
                }
                complete(session, request, result, operation) { listOf(CitizenSdkFlutterCodec.walletState(it)) }
            }
            is CitizenSdkFlutterCodec.Request.WalletMetadata -> {
                val operation = if (request.method == "setActiveWallet") sdk.setActiveWallet(request.expectedRevision, request.walletIndex)
                    else sdk.renameWallet(request.expectedRevision, request.walletIndex, requireNotNull(request.name))
                complete(session, request, result, operation) { listOf(CitizenSdkFlutterCodec.walletState(it)) }
            }
            is CitizenSdkFlutterCodec.Request.RenameWalletAccount -> {
                val operation = if (request.method == "importColdAccountId") sdk.importColdAccount(request.accountId, request.name)
                    else sdk.renameAccount(request.accountId, request.name)
                complete(session, request, result, operation) { listOf(CitizenSdkFlutterCodec.walletState(it)) }
            }
            is CitizenSdkFlutterCodec.Request.ColdSs58 -> complete(
                session, request, result, sdk.importColdAccount(request.address, request.name),
            ) { listOf(CitizenSdkFlutterCodec.walletState(it)) }
            is CitizenSdkFlutterCodec.Request.ReorderWalletAccounts -> complete(
                session, request, result,
                sdk.reorderWalletAccountsWithoutDefaultChange(request.expectedRevision, request.accountIds),
            ) { listOf(CitizenSdkFlutterCodec.walletState(it)) }
            is CitizenSdkFlutterCodec.Request.SignWalletPayload -> complete(
                session,
                request,
                result,
                sdk.signing.sign(request.accountId, request.payload),
            ) { listOf(CitizenSdkFlutterCodec.signature(it)) }
            is CitizenSdkFlutterCodec.Request.DeriveApplicationKey -> complete(
                session,
                request,
                result,
                sdk.deriveApplicationKey(request.accountId, request.salt, request.info),
            ) { listOf(it) }
            is CitizenSdkFlutterCodec.Request.DeriveApplicationKeys -> complete(
                session, request, result,
                sdk.deriveApplicationKeys(request.accountId, request.salt, request.infos),
            ) { listOf(it) }
            is CitizenSdkFlutterCodec.Request.PrepareApplicationKeys -> complete(
                session, request, result,
                sdk.prepareApplicationKeys(request.accountId, request.salt, request.infos, request.message.takeIf { it.isNotEmpty() }),
            ) { listOf(it.keys, it.signature ?: ByteArray(0)) }
            is CitizenSdkFlutterCodec.Request.BeginSigning -> complete(
                session, request, result, sdk.signing.begin(request.intent),
            ) { listOf(CitizenSdkFlutterCodec.signingOutcome(it)) }
            is CitizenSdkFlutterCodec.Request.ExternalSignature -> {
                if (request.method == "consumeExternalSignature") {
                    complete(
                        session, request, result,
                        sdk.signing.consumeExternalSignature(request.signingSessionId, request.response),
                    ) { listOf(CitizenSdkFlutterCodec.signingOutcome(it)) }
                } else {
                    complete(
                        session, request, result,
                        sdk.consumeDefaultAccountChange(request.signingSessionId, request.response),
                    ) { listOf(CitizenSdkFlutterCodec.defaultAccountChangeOutcome(it)) }
                }
            }
            is CitizenSdkFlutterCodec.Request.CancelSigning -> success(
                result, request.sessionId, request.requestSequence,
                listOf(sdk.signing.cancel(request.signingSessionId)),
            )
            is CitizenSdkFlutterCodec.Request.BeginDefaultAccountChange -> complete(
                session, request, result,
                sdk.beginDefaultAccountChange(
                    request.expectedRevision, request.accountIds, request.ttlSeconds,
                ),
            ) { listOf(CitizenSdkFlutterCodec.defaultAccountChangeOutcome(it)) }
            is CitizenSdkFlutterCodec.Request.PrepareTransaction -> complete(
                session,
                request,
                result,
                sdk.prepareTransaction(request.sourceAccountId, request.callData),
            ) { listOf(CitizenSdkFlutterCodec.preparedTransaction(it)) }
            is CitizenSdkFlutterCodec.Request.CancelPreparedTransaction -> {
                sdk.cancelPreparedTransaction(request.preparationId)
                success(
                    result,
                    request.sessionId,
                    request.requestSequence,
                    listOf(null),
                )
            }
            is CitizenSdkFlutterCodec.Request.TransactionExecution -> when (request.method) {
                "executePreparedTransaction" -> complete(
                    session, request, result,
                    sdk.executePreparedTransaction(request.executionId),
                ) { listOf(CitizenSdkFlutterCodec.transactionExecution(it)) }
                "consumePreparedTransactionQrResponse" -> complete(
                    session, request, result,
                    sdk.consumePreparedTransactionQrResponse(request.executionId, request.response!!),
                ) { listOf(CitizenSdkFlutterCodec.transactionExecution(it)) }
                else -> {
                    sdk.cancelPreparedTransactionExecution(request.executionId)
                    success(result, request.sessionId, request.requestSequence, listOf(null))
                }
            }
            is CitizenSdkFlutterCodec.Request.TransactionHistory -> {
                val future = if (request.method == "getTransactionHistory") {
                    sdk.getTransactionHistory(request.beforeExecutionId, request.limit)
                } else {
                    sdk.syncTransactionHistory()
                }
                complete(session, request, result, future) {
                    listOf(CitizenSdkFlutterCodec.transactionHistoryPage(it))
                }
            }
            is CitizenSdkFlutterCodec.Request.Qr -> {
                if (request.method == "openQrCapture") {
                    openCapture(session, request, result)
                } else if (request.method == "setQrCaptureTorch") {
                    val capture = session.captures[request.fields[0] as String]
                        ?: throw CitizenSdkException(CitizenSdkErrorCode.NOT_FOUND, "capture belongs to another session or is closed")
                    complete(session, request, result, capture.setTorch(request.fields[1] as Boolean)) { emptyList() }
                } else if (request.method == "reviewQrRequest") {
                    val operation = sdk.signing.reviewQrRequest(request.fields[0] as String)
                    complete(session, request, result, mapOperation(operation) { review ->
                        listOf(session.adopt(session.reviews, review), review.coreJson)
                    }) { it }
                } else complete(session, request, result,
                    CompletableFuture.supplyAsync { routeQr(sdk, request) },
                ) { it }
            }
        }
    }

    /** 受控输入只在同步JNI接纳内转成可清零字节；不在异步续体保留字节副本。 */
    private fun routeWalletInput(session: Session, request: CitizenSdkFlutterCodec.Request.WalletInput, result: MethodChannel.Result) {
        val sdk = session.sdk
        CitizenSdkSensitiveBytes.utf8(request.text).use { text ->
            CitizenSdkSensitiveBytes.utf8(request.password).use { password ->
                when (request.method) {
                    "validateWalletPassword", "validateWalletMnemonic" -> {
                        val validation = if (request.method == "validateWalletPassword") sdk.validateWalletPassword(text)
                            else sdk.validateWalletMnemonic(text, request.wordCount)
                        success(result, request.sessionId, request.requestSequence, listOf(validation.reason.ordinal, validation.position))
                    }
                    "walletWordSuggestions" -> success(result, request.sessionId, request.requestSequence, listOf(sdk.walletWordSuggestions(text)))
                    "prepareWalletCreation" -> complete(session, request, result,
                        mapOperation(sdk.prepareWalletCreation(request.wordCount, password)) { session.adopt(session.prepared, it) },
                    ) { listOf(it) }
                    "importWallet", "addNextWalletAccount", "addWalletAccounts" -> {
                        val operation = when (request.method) {
                            "importWallet" -> sdk.importWallet(text, password)
                            "addNextWalletAccount" -> sdk.addNextWalletAccount(text, password)
                            else -> sdk.addWalletAccounts(text, password, request.indices)
                        }
                        complete(session, request, result, operation) { listOf(CitizenSdkFlutterCodec.profile(it)) }
                    }
                    else -> throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED, "unsupported wallet input")
                }
            }
        }
    }

    private fun routeResource(session: Session, request: CitizenSdkFlutterCodec.Request.Resource, result: MethodChannel.Result) {
        if (request.method == "respondCredential" || request.method == "cancelCredential") {
            throw CitizenSdkException(CitizenSdkErrorCode.INVALID_STATE, "No active credential challenge")
        }
        val id = request.resourceId
        fun missing(): Nothing = throw CitizenSdkException(CitizenSdkErrorCode.NOT_FOUND, "resource is closed or belongs to another session")
        when (request.method) {
            "closeQrCapture", "pauseQrCapture", "resumeQrCapture" -> {
                val resource = session.captures[id] ?: missing()
                val future = when (request.method) {
                    "closeQrCapture" -> resource.close().thenApply { session.captures.remove(id, resource); null }
                    "pauseQrCapture" -> resource.pause()
                    else -> resource.resume()
                }
                complete(session, request, result, future) { emptyList() }
            }
            "cancelOperation" -> success(result, request.sessionId, request.requestSequence, listOf(session.cancel(id.toLong())))
            "copyRecoveryPhrase" -> {
                val phrase = (session.prepared[id] ?: missing()).openRecoveryPhrase()
                try {
                    val bytes = phrase.copyBytes()
                    try { success(result, request.sessionId, request.requestSequence, listOf(bytes)) }
                    finally { bytes.fill(0) }
                } finally { phrase.close() }
            }
            "commitWalletCreation" -> {
                val resource = session.prepared[id] ?: missing()
                val operation = resource.commit()
                // 保留终态资源到显式release；即使Core接纳后提交失败，也能准确释放而不重交。
                complete(session, request, result, operation) { listOf(CitizenSdkFlutterCodec.profile(it)) }
            }
            "releasePreparedWallet" -> {
                val resource = session.prepared[id] ?: missing()
                resource.close()
                session.prepared.remove(id, resource)
                success(result, request.sessionId, request.requestSequence, emptyList())
            }
            "revealPrivateKey" -> complete(session, request, result, (session.privateKeys[id] ?: missing()).reveal()) { listOf(it) }
            "closePrivateKey" -> {
                val resource = session.privateKeys[id] ?: missing()
                complete(session, request, result, resource.close().thenApply {
                    session.privateKeys.remove(id, resource)
                    Unit
                }) { emptyList() }
            }
            "releaseWalletInspection" -> {
                val inspection = session.inspections[id] ?: missing()
                inspection.release()
                session.inspections.remove(id, inspection)
                success(result, request.sessionId, request.requestSequence, emptyList())
            }
            "releaseQrReview" -> {
                val review = session.reviews[id] ?: missing()
                review.close()
                session.reviews.remove(id, review)
                success(result, request.sessionId, request.requestSequence, emptyList())
            }
            "signQrRequest" -> {
                val review = session.reviews[id] ?: missing()
                val operation = session.sdk.signing.signQrRequest(review)
                // 保留资源登记直到显式release，即使签名接纳后失败也不遗失终态所有权。
                complete(session, request, result, operation) {
                    listOf(it.document.coreJson, it.qrImage.width, it.qrImage.height, it.qrImage.luminance())
                }
            }
            else -> throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED, "unsupported resource method")
        }
    }

    private fun <T, R> mapOperation(operation: CitizenSdkOperation<T>, map: (T) -> R): CitizenSdkOperation<R> =
        CitizenSdkOperation(operation.operationId, operation.future.thenApply(map), operation::cancel)

    /** 纹理由Flutter引擎提供，必须等SDK自己的帧/Surface排空后才能归还。 */
    private fun openCapture(session: Session, request: CitizenSdkFlutterCodec.Request.Qr, result: MethodChannel.Result) {
        val host = activity ?: throw CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera host is unavailable")
        val registry = textures ?: throw CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "texture registry is unavailable")
        val purpose = CitizenQrScanPurpose.entries.single { it.value == request.fields[0] as Int }
        val entry = registry.createSurfaceTexture()
        val id = UUID.randomUUID().toString()
        val released = java.util.concurrent.atomic.AtomicBoolean(false)
        var published = false
        var owned: CitizenSdkQrCapture? = null
        val listener = object : CitizenSdkQrCapture.Listener {
            override fun onResult(result: CitizenQrScanResult) {
                if (published) emit(session, "qrCaptureResult", listOf(id, result.purpose.value, result.document.coreJson))
            }
            override fun onError(error: CitizenSdkException) {
                if (published) emit(session, "qrCaptureError", listOf(id, error.code.value, CitizenSdkFlutterCodec.errorName(error.code), error.stage.value))
            }
            override fun onPreview(width: Int, height: Int, rotationDegrees: Int) {
                if (published) emit(session, "qrCapturePreview", listOf(id, width, height, rotationDegrees))
            }
            override fun onClosed() {
                if (released.compareAndSet(false, true)) entry.release()
                if (published) emit(session, "qrCaptureClosed", listOf(id))
            }
        }
        val opening = try {
            session.sdk.openCapture(host, entry.surfaceTexture(), purpose, listener)
        } catch (error: Throwable) {
            if (released.compareAndSet(false, true)) entry.release()
            throw error
        }
        val ready = opening.thenCompose { capture ->
            owned = capture
            capture.pause().thenCompose { session.adoptCapture(id, capture) }
        }.thenApply { capture ->
            published = true
            listOf<Any?>(id, entry.id(), capture.previewWidth, capture.previewHeight, capture.rotationDegrees)
        }
        ready.whenComplete { _, error -> if (error != null) owned?.close() }
        complete(session, request, result, ready, { owned?.close(); Unit }) { it }
    }

    private fun routeQr(
        sdk: CitizenSdk,
        request: CitizenSdkFlutterCodec.Request.Qr,
    ): List<Any?> = when (request.method) {
        "qrEncodeDocument" -> listOf(sdk.qrEncodeDocument(CitizenQrContent(request.fields[0] as String)).coreJson)
        "qrPrepareAccountAuthorization" -> listOf(sdk.qrPrepareAccountAuthorization(
            request.fields[0] as Int, request.fields[1] as ByteArray, request.fields[2] as String).coreJson)
        "qrDecodeImage" -> listOf(sdk.decodeImage(request.fields[0] as ByteArray,
            CitizenQrScanPurpose.entries.single { it.value == request.fields[1] as Int }).map { it.document.coreJson })
        "qrParse" -> listOf(sdk.qrParse(request.fields[0] as String).coreJson)
        "qrCreateSignRequest" -> listOf(sdk.qrCreateSignRequest(
            request.fields[0] as Int, request.fields[1] as ByteArray,
            request.fields[2] as ByteArray, request.fields[3] as Long,
        ))
        "qrValidateSignResponse" -> {
            sdk.qrValidateSignResponse(request.fields[0] as String, request.fields[1] as String)
            emptyList()
        }
        "qrConsumeSignResponse" -> listOf(sdk.qrConsumeSignResponse(request.fields[0] as String))
        "qrCancelSignRequest" -> listOf(sdk.qrCancelSignRequest(request.fields[0] as String))
        "qrEncodeAccountId" -> listOf(sdk.qrEncodeAccountId(request.fields[0] as ByteArray))
        "qrDecodeLuminance" -> listOf(sdk.qrDecodeLuminance(
            request.fields[0] as ByteArray, (request.fields[1] as Long).toInt(),
            (request.fields[2] as Long).toInt(), (request.fields[3] as Long).toInt(),
        ).coreJson)
        "qrEncode" -> sdk.qrEncode(
            request.fields[0] as String, request.fields[1] as Int,
        ).let { listOf(it.width, it.height, it.luminance()) }
        else -> throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED, "Unsupported QR method")
    }

    private fun close(
        session: Session,
        request: CitizenSdkFlutterCodec.Request.SessionRequest,
        result: MethodChannel.Result,
    ) {
        val future = supervisedClose(session)
        future.whenComplete { _, error ->
            main.post {
                if (error == null) {
                    success(result, request.sessionId, request.requestSequence, listOf("disposed"))
                } else {
                    fail(result, error, request)
                }
            }
        }
    }

    private fun supervisedClose(session: Session): CompletableFuture<Void> {
        val plan = session.beginClose()
        if (!plan.owner) return plan.completion
        val resourceClosures = session.privateKeys.values.map { resource -> resource.close() } + session.sdk.closeQrCaptures()
        var cancellationError: Throwable? = null
        plan.outstanding.forEach { outstanding ->
            try {
                outstanding.cancel?.invoke()
            } catch (error: Throwable) {
                if (cancellationError == null) cancellationError = error
            }
        }
        val cancelFailure = cancellationError
        val settled = if (cancelFailure == null) {
            citizenSdkFlutterSettleWithin(
                plan.outstanding.map { it.future } + resourceClosures,
                CLOSE_SETTLEMENT_TIMEOUT_MILLIS,
                CitizenSdkFlutterProcessOrphans,
            )
        } else {
            CompletableFuture<Void>().also { it.completeExceptionally(cancelFailure) }
        }
        settled.thenCompose {
            session.prepared.values.forEach { it.close() }
            session.reviews.values.forEach { it.close() }
            session.inspections.values.forEach { it.close() }
            citizenSdkFlutterCloseLifecycle(
                session.sdk.lifecycle,
                session.sdk::stop,
                session.sdk::close,
            )
        }.thenRun {
            session.prepared.clear()
            session.privateKeys.clear()
            session.reviews.clear()
            session.inspections.clear()
            session.captures.clear()
            synchronized(lock) { sessions.remove(session.sdk.sessionId, session) }
        }.whenComplete { _, error ->
            if (error == null) {
                plan.completion.complete(null)
            } else {
                session.reopenAfterFailedClose()
                plan.completion.completeExceptionally(error)
            }
        }
        return plan.completion
    }

    private fun onNativeEvent(session: Session, event: CitizenSdkEvents.Event) {
        when (event) {
            is CitizenSdkEvents.Event.HistoryChanged -> emit(session, "historyChanged", emptyList())
            is CitizenSdkEvents.Event.WalletChanged -> emit(session, "walletChanged", emptyList())
            is CitizenSdkEvents.Event.FinalizedBlockChanged -> emit(
                session,
                "finalizedBlockChanged",
                listOf(CitizenSdkFlutterCodec.block(event.finalized)),
            )
            is CitizenSdkEvents.Event.LifecycleChanged -> emit(
                session,
                "lifecycleChanged",
                listOf(CitizenSdkFlutterCodec.lifecycle(event.lifecycle)),
            )
            is CitizenSdkEvents.Event.CapabilitiesChanged -> emit(
                session,
                "capabilitiesChanged",
                listOf(CitizenSdkFlutterCodec.capabilities(event.capabilities)),
            )
        }
    }

    private fun emit(session: Session, type: String, payload: List<Any?>) {
        val subscription = subscriptions.current() ?: return
        main.post {
            if (!subscriptions.owns(subscription)) return@post
            subscription.value.success(
                CitizenSdkFlutterCodec.event(
                    session.sdk.sessionId,
                    session.nextEvent.getAndIncrement(),
                    type,
                    payload,
                ),
            )
        }
    }

    private fun <T> complete(
        session: Session,
        request: CitizenSdkFlutterCodec.Request.SessionRequest,
        result: MethodChannel.Result,
        operation: CitizenSdkOperation<T>,
        encode: (T) -> List<Any?>,
    ) {
        session.registerCancel(request.requestSequence, operation.future, operation::cancel)
        complete(session, request, result, operation.future, { operation.cancel(); Unit }, encode)
    }

    private fun <T> complete(
        session: Session,
        request: CitizenSdkFlutterCodec.Request.SessionRequest,
        result: MethodChannel.Result,
        future: CompletableFuture<T>,
        cancel: (() -> Unit)? = null,
        encode: (T) -> List<Any?>,
    ) {
        // 异步完成仅保留公开上下文，不让续体一直引用WalletInput中的宿主String。
        val context = CitizenSdkFlutterCodec.Request.Empty(
            CitizenSdkFlutterCodec.requestMethod(request), request.sessionId, request.requestSequence,
        )
        session.track(future, cancel)
        future.whenComplete { value, error ->
            main.post {
                if (error == null) {
                    try {
                        val payload = encode(value)
                        try { success(result, context.sessionId, context.requestSequence, payload) }
                        finally {
                            if (context.method in setOf("revealPrivateKey", "deriveApplicationKey", "deriveApplicationKeys", "prepareApplicationKeys")) {
                                payload.filterIsInstance<ByteArray>().forEach { it.fill(0) }
                                if (context.method in setOf("deriveApplicationKeys", "prepareApplicationKeys")) {
                                    payload.filterIsInstance<List<*>>().forEach { values ->
                                        values.filterIsInstance<ByteArray>().forEach { it.fill(0) }
                                    }
                                }
                            }
                        }
                    } catch (encodingError: Throwable) {
                        fail(result, encodingError, context)
                    }
                } else {
                    fail(result, error, context)
                }
            }
        }
    }

    private fun success(
        result: MethodChannel.Result,
        sessionId: String,
        requestSequence: Long,
        value: List<Any?>,
    ) = result.success(CitizenSdkFlutterCodec.response(sessionId, requestSequence, value))

    private fun fail(
        result: MethodChannel.Result,
        error: Throwable,
        request: CitizenSdkFlutterCodec.Request,
    ) {
        val cause = unwrap(error)
        val sdkError = when (cause) {
            is CitizenSdkException -> cause
            is CitizenSdkFlutterCodec.ContractFailure -> CitizenSdkException(
                CitizenSdkErrorCode.fromValue(cause.errorCode),
                cause.message,
                stage = cause.stage,
            )
            is IllegalArgumentException -> CitizenSdkException(
                CitizenSdkErrorCode.INVALID_ARGUMENT,
                "Invalid CitizenSDK argument",
            )
            is IllegalStateException -> CitizenSdkException(
                CitizenSdkErrorCode.INVALID_STATE,
                if (request is CitizenSdkFlutterCodec.Request.Open) {
                    citizenSdkFlutterOpenInvalidState(cause.message)
                } else {
                    CITIZEN_SDK_OPEN_INVALID_STATE
                },
            )
            else -> CitizenSdkException(
                CitizenSdkErrorCode.INTERNAL,
                if (request is CitizenSdkFlutterCodec.Request.Open) {
                    citizenSdkFlutterOpenHostFailure(cause)
                } else {
                    "CitizenSDK host failure"
                },
            )
        }
        fail(
            result,
            sdkError.code,
            sdkError.message ?: "CitizenSDK failure",
            request,
            sdkError.stage,
        )
    }

    private fun fail(
        result: MethodChannel.Result,
        code: CitizenSdkErrorCode,
        message: String,
        request: CitizenSdkFlutterCodec.Request,
        stage: CitizenSdkFailureStage = CitizenSdkFailureStage.fromErrorCode(code),
    ) = result.error(
        "citizensdk.${CitizenSdkFlutterCodec.errorName(code)}",
        message,
        CitizenSdkFlutterCodec.errorDetails(
            code,
            message,
            request.sessionId,
            if (request is CitizenSdkFlutterCodec.Request.SessionRequest) request.requestSequence else null,
            CitizenSdkFlutterCodec.requestMethod(request),
            stage,
        ),
    )

    /** 参数解码拒绝只记录闭集枚举，不保留输入或异常内容。 */
    fun diagnoseRejected(request: CitizenSdkFlutterCodec.Request.Empty?, code: CitizenSdkErrorCode,
                         stage: CitizenSdkFailureStage) {
        if (request == null) return
        val session = synchronized(lock) { sessions[request.sessionId] } ?: return
        session.diagnostics.record(request.method, CitizenSdkFlutterDiagnostics.Phase.DECODE,
            code, stage, session.sdk.lifecycle)
    }

    private fun diagnosticFailure(diagnostics: CitizenSdkFlutterDiagnostics, method: String,
                                  error: Throwable, lifecycle: CitizenSdkLifecycle?, started: Long) {
        val cause = unwrap(error) as? CitizenSdkException
        val startStep = if (method == "start" && cause != null)
            citizenSdkFlutterStartStep(cause.code, cause.message)
        else CitizenSdkFlutterDiagnostics.StartStep.NONE
        diagnostics.record(method, CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
            cause?.code ?: CitizenSdkErrorCode.INTERNAL,
            cause?.stage ?: CitizenSdkFailureStage.TEARDOWN, lifecycle, System.nanoTime() - started,
            startStep = startStep)
    }

    private fun <T> diagnosed(session: Session, method: String, begin: () -> CompletableFuture<T>): CompletableFuture<T> {
        val started = System.nanoTime()
        session.diagnostics.record(method, CitizenSdkFlutterDiagnostics.Phase.BEGIN, lifecycle = session.sdk.lifecycle)
        val future = try { begin() } catch (error: Throwable) {
            diagnosticFailure(session.diagnostics, method, error, session.sdk.lifecycle, started)
            throw error
        }
        return future.whenComplete { value, error ->
            if (error != null) diagnosticFailure(session.diagnostics, method, error, session.sdk.lifecycle, started)
            else {
                val status = value as? CitizenChainSyncStatus
                val sync = when {
                    status == null -> CitizenSdkFlutterDiagnostics.Sync.UNKNOWN
                    status.isUsable -> CitizenSdkFlutterDiagnostics.Sync.USABLE
                    status.isSyncing -> CitizenSdkFlutterDiagnostics.Sync.SYNCING
                    else -> CitizenSdkFlutterDiagnostics.Sync.UNAVAILABLE
                }
                session.diagnostics.record(method, CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
                    lifecycle = session.sdk.lifecycle, elapsedNanos = System.nanoTime() - started, sync = sync)
            }
        }
    }

    private fun snapshot(): List<Session> = synchronized(lock) { sessions.values.toList() }

    private fun unwrap(error: Throwable): Throwable {
        var current = error
        while (current is CompletionException && current.cause != null) current = current.cause!!
        return current
    }

    companion object {
        internal const val CLOSE_SETTLEMENT_TIMEOUT_MILLIS = 30_000L

        /** 只投影公开输入到同一原生验签入口；静态调用不构造会话注册表或宿主资源。 */
        internal fun verifySignature(
            request: CitizenSdkFlutterCodec.Request.VerifySignature,
            verify: (ByteArray, ByteArray, ByteArray) -> Boolean = CitizenSigning::verify,
        ): List<Any?> = listOf(
            CitizenSdkFlutterCodec.PROTOCOL_VERSION,
            verify(request.accountId, request.signature, request.payload),
        )
    }
}
