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
/** 诊断只接受闭集事实；保留最新128条，不接收异常、账户或会话标识。 */
internal class CitizenSdkFlutterDiagnostics(private val emit: (String) -> Unit) {
    enum class Phase { BEGIN, ADMISSION, DECODE, COMPLETE }
    enum class Sync { UNKNOWN, SYNCING, USABLE, UNAVAILABLE }
    enum class StartStep { NONE, RESTORE, BEGIN, PUBLISH_BEGIN, PROVIDER_START, REFRESH, COMPLETE, SERVICES, PUBLISH_COMPLETE }
    private val records = java.util.ArrayDeque<List<Any?>>()
    private val last = mutableMapOf<String, List<Any?>>()
    private var journal: java.io.File? = null
    private var buildIdentity: String = "unknown"
    private val allowed = setOf("open", "start", "stop", "getSyncStatus", "getWalletState", "inspectWallets", "releaseWalletInspection", "cancelOperation")
    private val points = setOf("NONE", "ADMISSION", "LOCAL_READ", "RESULT_READY") + StartStep.entries.map { it.name }

    /** 由SDK自己的平台上下文确定私有文件；从不接受宿主交付的任意路径。 */
    @Synchronized fun attachJournal(file: java.io.File, build: String = "unknown") {
        try {
            if (file.parentFile?.canonicalFile != file.parentFile?.absoluteFile ||
                file.canonicalFile != file.absoluteFile) return
            if (build != "unknown" && !Regex("^[0-9]{1,19}:[0-9]{1,19}$").matches(build)) return
            buildIdentity = build
            journal = file
            readJournal(file)?.forEach { append(it) }
        } catch (_: Throwable) { /* 诊断故障不影响SDK操作。 */ }
    }
    private fun valid(row: List<Any?>): Boolean = row.size == 6 && row[0] in allowed &&
        row[1] in Phase.entries.map { it.name } && row[2] is Int && (row[2] as Int) in 0..22 &&
        row[3] is Int && (row[3] as Int) in 0..8 && row[4] in points &&
        (row[5] is Int || row[5] is Long) && (row[5] as Number).toLong() in 0..86_400_000
    private fun readJournal(file: java.io.File): List<List<Any?>>? {
        if (!file.isFile || file.length() > 65536 || file.canonicalFile != file.absoluteFile) return null
        val lines = file.readLines(Charsets.UTF_8)
        if (lines.firstOrNull() != "CitizenSDK/1\t$buildIdentity" || lines.size > 129) return null
        return lines.drop(1).map { line ->
            val fields = line.split('\t')
            if (fields.size != 6) throw IllegalStateException("diagnostic tuple rejected")
            val row = listOf(fields[0], fields[1], fields[2].toInt(), fields[3].toInt(), fields[4], fields[5].toLong())
            if (!valid(row)) throw IllegalStateException("diagnostic tuple rejected")
            row
        }

    }
    @Synchronized fun accept(row:List<Any?>){require(valid(row));append(row);persist(row)}
    private fun append(row: List<Any?>) { records.addLast(row); while (records.size > 128) records.removeFirst() }
    @Synchronized fun snapshot(): List<List<Any?>> = synchronized(journalLock) {
        try { journal?.let(::readJournal) ?: records.toList() } catch (_: Throwable) { records.toList() }
    }
    @Synchronized fun record(method: String, phase: Phase, code: CitizenSdkErrorCode = CitizenSdkErrorCode.OK,
               stage: CitizenSdkFailureStage? = null, lifecycle: CitizenSdkLifecycle? = null,
               elapsedNanos: Long = 0, sync: Sync = Sync.UNKNOWN, startStep: StartStep = StartStep.NONE,
               point: String = "NONE") {
        if (method !in allowed || point !in points) return
        val millis = (elapsedNanos.coerceAtLeast(0) / 1_000_000).coerceAtMost(86_400_000)
        val fixedPoint = if (method == "start") startStep.name else point
        val row = listOf(method, phase.name, code.value, stage?.value ?: 0, fixedPoint, millis)
        // 连续相同健康状态去重；新的失败永不因历史容量耗尽而丢弃。
        val key = "$method/${phase.name}"
        val signature = row.take(5) + listOf(lifecycle?.name ?: "UNKNOWN", sync.name)
        if (code == CitizenSdkErrorCode.OK && last[key] == signature) return
        last[key] = signature
        append(row)
        try { emit("method=$method phase=${phase.name} code=${code.name} stage=${stage?.name ?: "NONE"} lifecycle=${lifecycle?.name ?: "UNKNOWN"} sync=${sync.name} point=$fixedPoint elapsed_ms=$millis") } catch (_: Throwable) {}
        persist(row)
    }
    private fun persist(row:List<Any?>) {
        synchronized(journalLock) {
            val file = journal ?: return
            try {
                if (file.canonicalFile != file.absoluteFile) return
                val rows = ((readJournal(file) ?: emptyList()) + listOf(row)).takeLast(128)
                val text = "CitizenSDK/1\t$buildIdentity\n" + rows.joinToString("\n") { it.joinToString("\t") } + "\n"
                if (text.toByteArray(Charsets.UTF_8).size > 65536) return
                val temporary = java.io.File(file.path + ".new")
                if (temporary.canonicalFile != temporary.absoluteFile || (temporary.exists() && !temporary.isFile)) return
                java.io.FileOutputStream(temporary).use { stream -> stream.write(text.toByteArray(Charsets.UTF_8)); stream.fd.sync() }
                if (!temporary.renameTo(file)) { temporary.delete(); return }
                file.setReadable(false, false); file.setWritable(false, false)
                file.setReadable(true, true); file.setWritable(true, true)
            } catch (_: Throwable) { /* 日志故障不改变原请求结果。 */ }
        }
    }
    companion object { private val journalLock = Any() }
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
        val privateKeys = ConcurrentHashMap<String, CitizenSdkPrivateKey>()
        val diagnosticStarted = ConcurrentHashMap<Long, Long>()
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

    }

    override fun onCancel(arguments: Any?) {
        subscriptions.close()
    }

    private fun open(modules: Int, result: MethodChannel.Result) {
        val diagnostics = CitizenSdkFlutterDiagnostics { android.util.Log.i("CitizenSDK", it) }
        try {
            val info = applicationContext.packageManager.getPackageInfo(applicationContext.packageName, 0)
            @Suppress("DEPRECATION")
            val version = if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
            diagnostics.attachJournal(java.io.File(applicationContext.noBackupFilesDir.canonicalFile, "citizensdk-diagnostics.log"), "$version:${info.lastUpdateTime}")
        } catch (_: Throwable) { /* 不明安装身份时只保留本实例内存诊断，不能冒充旧构建记录。 */ }
        val started = System.nanoTime()
        diagnostics.record("open", CitizenSdkFlutterDiagnostics.Phase.BEGIN)
        var sdk: CitizenSdk? = null
        try {
            val opened = CitizenSdk.open(applicationContext, null, modules)
            sdk = opened
            val session = Session(opened, diagnostics)
            diagnostics.record("open", CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
                lifecycle = opened.lifecycle, elapsedNanos = System.nanoTime() - started)
            activity?.let(opened::attachActivity)
            synchronized(lock) {
                check(sessions.putIfAbsent(opened.sessionId, session) == null)
            }
            success(
                result,
                opened.sessionId,
                0,
                listOf(CitizenSdkFlutterCodec.lifecycle(opened.lifecycle), 1L, java.lang.Long.toUnsignedString(opened.ffiHandle())),
            )

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
        val started = System.nanoTime()
        val method = CitizenSdkFlutterCodec.requestMethod(request)
        val detailed = method == "start" || method == "getSyncStatus"
        session.diagnosticStarted[request.requestSequence] = started
        if (!detailed) session.diagnostics.record(method, CitizenSdkFlutterDiagnostics.Phase.BEGIN, lifecycle = sdk.lifecycle)
        val downstream = result
        val result = object : MethodChannel.Result {
            override fun success(value: Any?) {
                val began = session.diagnosticStarted.remove(request.requestSequence) ?: started
                if (!detailed) session.diagnostics.record(method, CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
                    lifecycle = sdk.lifecycle, elapsedNanos = System.nanoTime() - began)
                downstream.success(value)
            }
            override fun error(code: String, message: String?, details: Any?) {
                // Throwable失败已由fail记录；直接错误同样只投影准确闭集错误码。
                val began = session.diagnosticStarted.remove(request.requestSequence)
                if (began != null) {
                    val stable = CitizenSdkErrorCode.entries.firstOrNull {
                        code == "citizensdk.${CitizenSdkFlutterCodec.errorName(it)}"
                    } ?: CitizenSdkErrorCode.INTERNAL
                    session.diagnostics.record(method, CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
                        stable, CitizenSdkFailureStage.fromErrorCode(stable), sdk.lifecycle, System.nanoTime() - began)
                }
                downstream.error(code, message, details)
            }
            override fun notImplemented() = downstream.notImplemented()
        }
        when(request){
         is CitizenSdkFlutterCodec.Request.Diagnostic->{session.diagnostics.accept(request.row);success(result,request.sessionId,0L,emptyList())}
         is CitizenSdkFlutterCodec.Request.Empty->when(request.method){
          "close"->close(session,request,result)
          "readDiagnostics"->success(result,request.sessionId,request.requestSequence,listOf(session.diagnostics.snapshot()))
          else->throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED,"Unsupported platform operation")
         }
         is CitizenSdkFlutterCodec.Request.Account->{val opened=sdk.openPrivateKey(request.accountId).thenCompose(session::adoptPrivate);complete(session,request,result,opened){listOf(it)}}
         is CitizenSdkFlutterCodec.Request.Resource->routeResource(session,request,result)
         is CitizenSdkFlutterCodec.Request.Qr->when(request.method){
          "openQrCapture"->openCapture(session,request,result)
          "setQrCaptureTorch"->{val capture=session.captures[request.fields[0] as String]?:throw CitizenSdkException(CitizenSdkErrorCode.NOT_FOUND,"capture unavailable");complete(session,request,result,capture.setTorch(request.fields[1] as Boolean)){emptyList()}}
          "qrDecodeImage"->success(result,request.sessionId,request.requestSequence,listOf(sdk.decodeImage(request.fields[0] as ByteArray,CitizenQrScanPurpose.entries.single{it.value==request.fields[1] as Int}).map{it.document.coreJson}))
          else->throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED,"Unsupported platform operation")
         }
        }
    }
    private fun routeResource(session:Session,request:CitizenSdkFlutterCodec.Request.Resource,result:MethodChannel.Result){
      fun missing():Nothing=throw CitizenSdkException(CitizenSdkErrorCode.NOT_FOUND,"resource unavailable")
      val id=request.resourceId
      when(request.method){
       "respondCredential","cancelCredential"->throw CitizenSdkException(CitizenSdkErrorCode.INVALID_STATE,"No active credential challenge")
       "cancelOperation"->success(result,request.sessionId,request.requestSequence,listOf(session.cancel(id.toLong())))
       "revealPrivateKey"->complete(session,request,result,(session.privateKeys[id]?:missing()).reveal()){listOf(it)}
       "closePrivateKey"->{val key=session.privateKeys[id]?:missing();complete(session,request,result,key.close().thenApply{session.privateKeys.remove(id,key);Unit}){emptyList()}}
       "closeQrCapture","pauseQrCapture","resumeQrCapture"->{val capture=session.captures[id]?:missing();val future=when(request.method){"closeQrCapture"->capture.close().thenApply{session.captures.remove(id,capture);null};"pauseQrCapture"->capture.pause();else->capture.resume()};complete(session,request,result,future){emptyList()}}
       else->throw CitizenSdkException(CitizenSdkErrorCode.UNSUPPORTED,"Unsupported platform operation")
      }
    }

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
            citizenSdkFlutterCloseLifecycle(
                session.sdk.lifecycle,
                session.sdk::stop,
                session.sdk::close,
            )
        }.thenRun {
            session.privateKeys.clear()
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
        // 异步完成只保留方法、会话和序号，不延长请求载荷的持有期。
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
                            if (context.method == "revealPrivateKey") {
                                payload.filterIsInstance<ByteArray>().forEach { it.fill(0) }
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
        val active = (request as? CitizenSdkFlutterCodec.Request.SessionRequest)?.let { synchronized(lock) { sessions[it.sessionId] } }
        if (active != null) diagnosticFailure(active.diagnostics, CitizenSdkFlutterCodec.requestMethod(request), error,
            active.sdk.lifecycle, active.diagnosticStarted.remove(request.requestSequence) ?: System.nanoTime())
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
        val point = if (cause?.code == CitizenSdkErrorCode.PANIC) when (cause.message) {
            "CitizenSDK request panicked at ADMISSION" -> "ADMISSION"
            "CitizenSDK request panicked at LOCAL_READ" -> "LOCAL_READ"
            "CitizenSDK request panicked at RESULT_READY" -> "RESULT_READY"
            else -> "NONE"
        } else "NONE"
        diagnostics.record(method, CitizenSdkFlutterDiagnostics.Phase.COMPLETE,
            cause?.code ?: CitizenSdkErrorCode.INTERNAL,
            cause?.stage ?: CitizenSdkFailureStage.TEARDOWN, lifecycle, System.nanoTime() - started,
            startStep = startStep, point = point)
    }

    fun detachFfi() {snapshot().forEach {it.sdk.detachFfi()}}
    private fun snapshot(): List<Session> = synchronized(lock) { sessions.values.toList() }

    private fun unwrap(error: Throwable): Throwable {
        var current = error
        while (current is CompletionException && current.cause != null) current = current.cause!!
        return current
    }

    companion object {internal const val CLOSE_SETTLEMENT_TIMEOUT_MILLIS=30000L}
}
