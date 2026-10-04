package org.citizen.sdk

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.CompletableFuture

/** SDK拥有的短时显示副本；调用方自建的String或其它副本不在清零保证内。 */
class CitizenSdkRecoveryPhrase private constructor(bytes: ByteArray) : AutoCloseable {
    private val gate = Any()
    private val closed = AtomicBoolean(false)
    private val value = bytes.clone().also { bytes.fill(0) }

    /** 字符仅在回调中借用，回调返回后立即清零。 */
    fun <T> useCharacters(block: (CharBuffer) -> T): T = synchronized(gate) {
        check(!closed.get()) { "recovery phrase is closed" }
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val chars = decoder.decode(ByteBuffer.wrap(value))
        try {
            block(chars.asReadOnlyBuffer())
        } finally {
            for (index in 0 until chars.limit()) chars.put(index, '\u0000')
        }
    }

    /** Flutter显式备份显示通道使用独立字节副本；发送完必须清零该副本。 */
    @JvmSynthetic
    internal fun copyBytes(): ByteArray = synchronized(gate) {
        check(!closed.get()) { "recovery phrase is closed" }
        value.clone()
    }

    override fun close() = synchronized(gate) {
        if (closed.compareAndSet(false, true)) value.fill(0)
    }

    override fun toString(): String = "CitizenSdkRecoveryPhrase(<redacted>)"

    companion object {
        internal fun create(bytes: ByteArray): CitizenSdkRecoveryPhrase = CitizenSdkRecoveryPhrase(bytes)
    }
}

/** 无窗口私钥资源。阶段完成不等于资源结束；close等待Core请求和认证真正排空。 */
class CitizenSdkPrivateKey internal constructor(
    private val sdk: CitizenSdk,
    accountId: ByteArray,
    private val host: androidx.fragment.app.FragmentActivity,
) {
    private val gate = Any()
    private val receiver = CitizenSdkPrivateKeyReceiver()
    private val ready = CompletableFuture<CitizenSdkPrivateKey>()
    private val revealed = CompletableFuture<ByteArray>()
    private val ended = CompletableFuture<Void>()
    private var stage = 0
    private var closing = false
    private var delivered: ByteArray? = null
    private val admission = sdk.openPrivateKeyResource(accountId, receiver, host)
    private val lifecycle = object : androidx.lifecycle.DefaultLifecycleObserver {
        override fun onStop(owner: androidx.lifecycle.LifecycleOwner) { runCatching { close() } }
        override fun onDestroy(owner: androidx.lifecycle.LifecycleOwner) { runCatching { close() } }
    }

    val closed: CompletableFuture<Void> get() = ended
    internal val opened: CompletableFuture<CitizenSdkPrivateKey> get() = ready

    init {
        receiver.bind(admission.first)
        androidx.core.content.ContextCompat.getMainExecutor(host).execute {
            host.lifecycle.addObserver(lifecycle)
            if (!host.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) close()
        }
        // 不在JNI借用回调内执行宿主续体或反调Core。
        receiver.listen { code -> CompletableFuture.runAsync { stageSettled(code) } }
        admission.second.future.whenComplete { _, error ->
            receiver.clear()
            synchronized(gate) { delivered?.fill(0); delivered = null }
            androidx.core.content.ContextCompat.getMainExecutor(host).execute { host.lifecycle.removeObserver(lifecycle) }
            val failure = error ?: CitizenSdkException(CitizenSdkErrorCode.CANCELLED, "private key resource is closed")
            ready.completeExceptionally(failure)
            revealed.completeExceptionally(failure)
            // 业务错误由opened/revealed交付；Core请求已结束即表示真实排空，不能把
            // 一次认证取消变成close永远失败、资源永远无法退役。
            ended.complete(null)
        }
    }

    fun reveal(): CompletableFuture<ByteArray> = synchronized(gate) {
        check(!closing && stage == 1) { "private key is not ready or reveal was already requested" }
        stage = 2
        try { sdk.revealPrivateKeyResource(admission.first) }
        catch (error: Throwable) { revealed.completeExceptionally(error); close() }
        revealed
    }

    fun close(): CompletableFuture<Void> = synchronized(gate) {
        if (!closing) {
            closing = true
            receiver.clear()
            delivered?.fill(0); delivered = null
        }
        if (!admission.second.future.isDone) {
            // 先撤销交付，再取消精确认证；失败仍允许再次close，不丢弃真实排空所有权。
            try {
                sdk.cancelPrivateKeyResource(admission.first)
                receiver.authenticationId()?.let(sdk::cancelPrivateKeyAuthentication)
                sdk.finishPrivateKeyResource(admission.first)
            } catch (error: Throwable) {
                if (!admission.second.future.isDone) throw error
            }
        }
        ended
    }

    private fun stageSettled(code: Int) = synchronized(gate) {
        if (closing) return@synchronized
        if (code != CitizenSdkErrorCode.OK.value) {
            val error = CitizenSdkException(CitizenSdkErrorCode.fromValue(code), "private key authorization failed")
            ready.completeExceptionally(error)
            revealed.completeExceptionally(error)
            close()
        } else if (stage == 0) {
            stage = 1
            ready.complete(this)
        } else if (stage == 2) {
            val bytes = receiver.copyBytes()
            delivered = bytes
            stage = 3
            if (!revealed.complete(bytes)) bytes.fill(0)
        }
    }

    override fun toString(): String = "CitizenSdkPrivateKey(<redacted>)"
}

/** JNI只同步借用32字节；此接收者只保存受控副本，不渲染、不等待UI、不反调Core。 */
internal class CitizenSdkPrivateKeyReceiver {
    private val gate = Any()
    private val value = ByteArray(32)
    private var closed = false
    private var populated = false
    private var secretId = 0L
    private var hostOperationId: Long? = null
    private var registerAuthentication: ((Long) -> Int)? = null
    private var lastCode: Int? = null
    private var listener: ((Int) -> Unit)? = null

    fun bind(id: Long) = synchronized(gate) { check(!closed && id != 0L && (secretId == 0L || secretId == id)); secretId = id }
    fun listen(callback: (Int) -> Unit) {
        val code = synchronized(gate) { listener = callback; lastCode }
        if (code != null) callback(code)
    }
    fun bindAuthenticationRegistry(register: (Long) -> Int) = synchronized(gate) { registerAuthentication = register }
    fun authenticationId(): Long? = synchronized(gate) { hostOperationId }
    @Suppress("unused") // JNI回调名称固定，不使用internal方法名后缀。
    fun authorizing(id: Long, operationId: Long): Int = synchronized(gate) {
        if (closed) return@synchronized CitizenSdkErrorCode.CANCELLED.value
        if (id == 0L || id != secretId || operationId == 0L || hostOperationId != null) return@synchronized CitizenSdkErrorCode.INTEGRITY.value
        val code = registerAuthentication?.invoke(operationId) ?: CitizenSdkErrorCode.INTEGRITY.value
        if (code == CitizenSdkErrorCode.OK.value) hostOperationId = operationId
        code
    }
    @Suppress("unused")
    fun receive(id: Long, bytes: ByteBuffer): Int = synchronized(gate) {
        if (!bytes.isDirect || bytes.capacity() != 32 || bytes.position() != 0 || bytes.remaining() != 32) return@synchronized CitizenSdkErrorCode.INTEGRITY.value
        if (closed || populated || id == 0L || id != secretId) return@synchronized CitizenSdkErrorCode.CANCELLED.value
        // JNI借用视图的游标不归接收者所有，复制不能改变调用方position。
        bytes.duplicate().get(value)
        populated = true
        CitizenSdkErrorCode.OK.value
    }
    @Suppress("unused")
    fun settled(id: Long, code: Int) {
        val callback = synchronized(gate) {
            if (closed || id == 0L || secretId != 0L && id != secretId) return
            // 早到通知也先绑定真实编号，后续bind不得领取其它资源的通知。
            if (secretId == 0L) secretId = id
            lastCode = code
            listener
        }
        callback?.invoke(code)
    }
    fun copyBytes(): ByteArray = synchronized(gate) { check(!closed && populated); value.clone() }
    fun clear() = synchronized(gate) { closed = true; populated = false; value.fill(0) }
}
