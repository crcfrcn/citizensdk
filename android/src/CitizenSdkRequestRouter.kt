@file:kotlin.jvm.JvmSynthetic

package org.citizen.sdk.internal

import org.citizen.sdk.CitizenSdkErrorCode
import org.citizen.sdk.CitizenSdkException
import org.citizen.sdk.CitizenSdkOperation
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean

/** Exact request-ID admission bridge; no callback is associated by ordering. */
internal class CitizenSdkRequestRouter(
    private val cancelNative: (Long) -> Boolean,
) : AutoCloseable {
    private val releaseResult:(CoreResult)->Unit={it.close()}
    private class Pending<T>(
        val future: CompletableFuture<T>,
        val decode: (CoreResult) -> T,
    ) {
        val deliveryGate = Any()
        val deliveries = ArrayDeque<Delivery>()
        var draining = false
    }

    private sealed class Delivery {
        class Completion(val decoded: Result<CoreResult>) : Delivery()
    }

    private val gate = Any()
    private val closed = AtomicBoolean(false)
    private val pending = HashMap<Long, Pending<*>>()
    private val earlyCompletions = HashMap<Long, Result<CoreResult>>()
    private var admissionInProgress = false
    private var queuedDeliveries = 0

    fun <T> submit(begin: () -> Long, decode: (CoreResult) -> T): CompletableFuture<T> =
        submitOperation(begin, decode).future

    fun <T> submitOperation(
        begin: () -> Long,
        decode: (CoreResult) -> T,
    ): CitizenSdkOperation<T> {
        check(!closed.get()) { "CitizenSdk request router is closed" }
        var coreRequestId=0L
        val future = CompletableFuture<T>()
        val entry = Pending(future, decode)
        var drainEntry: Pending<*>? = null
        synchronized(gate) {
            check(!closed.get()) { "CitizenSdk request router is closed" }
            // Holding the admission gate across the C call is intentional. A
            // callback that races before return blocks here; a same-thread
            // reentrant test callback is retained in the exact early map.
            admissionInProgress = true
            coreRequestId = try {
                begin()
            } catch (error: Throwable) {
                // Only one admission owns the gate. Any reentrant callback in
                // these maps belongs to the failed admission and cannot be
                // exposed because no operation was returned to the caller.
                earlyCompletions.values.forEach { it.getOrNull()?.let(releaseResult) }
                earlyCompletions.clear()
                throw error
            } finally {
                admissionInProgress = false
            }
            check(coreRequestId != 0L) { "Core returned reserved request ID 0" }
            check(pending.put(coreRequestId, entry) == null) { "Core request ID was reused" }

            earlyCompletions.remove(coreRequestId)?.let { decoded ->
                pending.remove(coreRequestId)

                if (enqueue(entry, Delivery.Completion(decoded))) drainEntry = entry
            }
        }
        drainEntry?.let(::drain)
        val operationId=java.lang.Long.toUnsignedString(coreRequestId)
        return CitizenSdkOperation(operationId, future) { cancel(operationId) }
    }

    fun onCompletion(coreRequestId: Long, decoded: Result<CoreResult>) {
        val drainEntry = synchronized(gate) {
            if (!pending.containsKey(coreRequestId)) {
                if (admissionInProgress) {
                    check(earlyCompletions.put(coreRequestId, decoded) == null) {
                        "Core delivered duplicate completion"
                    }
                } else { decoded.getOrNull()?.let(releaseResult) }
                null
            } else {
                val entry = checkNotNull(pending.remove(coreRequestId))

                if (enqueue(entry, Delivery.Completion(decoded))) entry else null
            }
        }
        drainEntry?.let(::drain)
    }

    fun requireIdle() = synchronized(gate) {
        if (pending.isNotEmpty() || earlyCompletions.isNotEmpty() || queuedDeliveries != 0
        ) {
            throw CitizenSdkException(CitizenSdkErrorCode.BUSY, "CitizenSDK still owns asynchronous requests")
        }
    }

    fun cancel(operationId:String):Boolean {
        if(!operationId.matches(Regex("^[1-9][0-9]{0,19}$")))return false
        val request=try{java.lang.Long.parseUnsignedLong(operationId)}catch(_:NumberFormatException){return false}
        return synchronized(gate){if(!pending.containsKey(request))false else cancelNative(request)}
    }


    override fun close() {
        synchronized(gate) {
            requireIdle()
            closed.set(true)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun deliverCompletion(entryValue: Pending<*>, decoded: Result<CoreResult>) {
        val entry = entryValue as Pending<Any?>
        if (decoded.exceptionOrNull() != null) {
            entry.future.completeExceptionally(checkNotNull(decoded.exceptionOrNull()))
            return
        }
        var projected: Any? = null
        var cleanupAttempted = false
        fun releaseOwned() {
            if (cleanupAttempted) return
            cleanupAttempted = true
            val owned = projected
            // 已构造公开资源时从其唯一close路径归还，避免Core已释放而门面登记仍存活。
            if (owned is AutoCloseable) owned.close() else decoded.getOrNull()?.let(releaseResult)
        }
        try {
            if (entry.future.isDone) { releaseOwned(); return }
            projected = entry.decode(checkNotNull(decoded.getOrNull()))
            if (!entry.future.complete(projected)) releaseOwned()
        } catch (error: Throwable) {
            try { releaseOwned() } catch (cleanup: Throwable) {
                if (cleanup !== error) error.addSuppressed(cleanup)
            }
            entry.future.completeExceptionally(
                if (error is CitizenSdkException) error else CitizenSdkException(
                    CitizenSdkErrorCode.INTEGRITY,
                    "CitizenSDK result did not match the accepted operation",
                    error,
                ),
            )
        } finally {decoded.getOrNull()?.close()}
    }

    /** Queues under admission order and elects at most one lock-free drainer. */
    private fun enqueue(entry: Pending<*>, delivery: Delivery): Boolean =
        synchronized(entry.deliveryGate) {
            // Every caller owns the router admission gate here.
            queuedDeliveries += 1
            entry.deliveries.addLast(delivery)
            if (entry.draining) false else {
                entry.draining = true
                true
            }
        }

    private fun drain(entry: Pending<*>) {
        while (true) {
            val delivery = synchronized(entry.deliveryGate) {
                if (entry.deliveries.isEmpty()) {
                    entry.draining = false
                    return
                }
                entry.deliveries.removeFirst()
            }
            when (delivery) {
                is Delivery.Completion -> {
                    // Core is terminal before CompletableFuture callbacks run;
                    // a continuation may therefore close the now-idle SDK.
                    synchronized(gate) { queuedDeliveries -= 1 }
                    deliverCompletion(entry, delivery.decoded)
                }
            }
        }
    }


}
