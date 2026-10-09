package org.citizen.sdk

import org.citizen.sdk.internal.CitizenSdkNative

/**
 * 无窗口的一次性准备资源；Core句柄只留在JNI，宿主只能取得受控显示副本或提交。
 * 接纳前失败可重试；Core接纳后即消费准备资源，与提交最终成功或失败无关。
 */
class CitizenSdkPreparedWallet private constructor(
    private val native: CitizenSdkNative,
    private val token: Long,
    private val commitAction: (CitizenSdkPreparedWallet) -> CitizenSdkOperation<CitizenWalletProfile>,
    private val released: (CitizenSdkPreparedWallet) -> Unit,
) : AutoCloseable {
    private val ownership = CitizenSdkPreparedOwnership()
    private val phrases = java.util.concurrent.ConcurrentHashMap.newKeySet<CitizenSdkRecoveryPhrase>()

    fun openRecoveryPhrase(): CitizenSdkRecoveryPhrase {
        check(!ownership.isConsumed()) { "prepared wallet is already consumed" }
        return CitizenSdkRecoveryPhrase.create(native.copyPreparedMnemonic(token)).also { phrases.add(it) }
    }

    fun commit(): CitizenSdkOperation<CitizenWalletProfile> = commitAction(this)

    @JvmSynthetic
    internal fun commitRequest(): Long = ownership.consume {
        native.commitPreparedWallet(token)
    }

    @JvmSynthetic
    internal fun releaseForCleanup(): CitizenSdkPreparedReleaseStatus = ownership.release {
        native.releasePreparedWallet(token)
    }

    override fun close() {
        if (releaseForCleanup() == CitizenSdkPreparedReleaseStatus.IN_PROGRESS) {
            throw CitizenSdkException(CitizenSdkErrorCode.BUSY, "prepared wallet admission is in progress")
        }
        phrases.forEach { it.close() }
        phrases.clear()
        released(this)
    }

    override fun toString(): String = "CitizenSdkPreparedWallet(<redacted>)"

    companion object {
        internal fun create(
            native: CitizenSdkNative,
            token: Long,
            commit: (CitizenSdkPreparedWallet) -> CitizenSdkOperation<CitizenWalletProfile>,
            released: (CitizenSdkPreparedWallet) -> Unit,
        ): CitizenSdkPreparedWallet = CitizenSdkPreparedWallet(native, token, commit, released)
    }
}

/**
 * Retryable one-shot state shared by commit and release.
 *
 * Native rejects do not consume the Core prepared handle. The state therefore
 * rolls back on every exception so the same owner can retry instead of losing
 * the last reference to mnemonic memory.
 */
internal class CitizenSdkPreparedOwnership {
    private val gate = Any()
    private var state = State.OPEN

    fun isConsumed(): Boolean = synchronized(gate) { state != State.OPEN }

    fun <T> consume(action: () -> T): T {
        synchronized(gate) {
            check(state == State.OPEN) { "prepared wallet is already consumed" }
            state = State.COMMITTING
        }
        return try {
            action().also { synchronized(gate) { state = State.COMMITTED } }
        } catch (error: Throwable) {
            synchronized(gate) { state = State.OPEN }
            throw error
        }
    }

    fun release(action: () -> Unit): CitizenSdkPreparedReleaseStatus {
        synchronized(gate) {
            when (state) {
                State.OPEN -> state = State.RELEASING
                State.COMMITTING,
                State.RELEASING -> return CitizenSdkPreparedReleaseStatus.IN_PROGRESS
                State.COMMITTED,
                State.RELEASED -> return CitizenSdkPreparedReleaseStatus.TERMINAL
            }
        }
        try {
            action()
            synchronized(gate) { state = State.RELEASED }
            return CitizenSdkPreparedReleaseStatus.TERMINAL
        } catch (error: Throwable) {
            synchronized(gate) { state = State.OPEN }
            throw error
        }
    }

    private enum class State { OPEN, COMMITTING, COMMITTED, RELEASING, RELEASED }
}

internal enum class CitizenSdkPreparedReleaseStatus { IN_PROGRESS, TERMINAL }
