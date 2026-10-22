@file:kotlin.jvm.JvmSynthetic

package org.citizen.sdk.internal

import org.citizen.sdk.CitizenSdkErrorCode
import org.citizen.sdk.CitizenSdkException
import org.citizen.sdk.CitizenSdkOperation
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Exact request-ID admission bridge; no callback is associated by ordering. */
internal class CitizenSdkRequestRouter(
    private val cancelNative: (Long) -> Boolean,
    private val releaseResult: (CitizenSdkNativeResult) -> Unit = {},
) : AutoCloseable {
    private class Pending<T>(
        val operationId: String,
        val future: CompletableFuture<T>,
        val decode: (CitizenSdkNativeResult) -> T,
    ) {
        val deliveryGate = Any()
        val deliveries = ArrayDeque<Delivery>()
        var draining = false
    }

    private sealed class Delivery {
        class Completion(val decoded: CitizenSdkNativeCodec.Decoded) : Delivery()
    }

    private val gate = Any()
    private val nextOperation = AtomicLong(1)
    private val closed = AtomicBoolean(false)
    private val pending = HashMap<Long, Pending<*>>()
    private val requestByOperation = HashMap<String, Long>()
    private val earlyCompletions = HashMap<Long, CitizenSdkNativeCodec.Decoded>()
    private var admissionInProgress = false
    private var queuedDeliveries = 0

    fun <T> submit(begin: () -> Long, decode: (CitizenSdkNativeResult) -> T): CompletableFuture<T> =
        submitOperation(begin, decode).future

    fun <T> submitOperation(
        begin: () -> Long,
        decode: (CitizenSdkNativeResult) -> T,
    ): CitizenSdkOperation<T> {
        check(!closed.get()) { "CitizenSdk request router is closed" }
        val operationId = allocateOperationId()
        val future = CompletableFuture<T>()
        val entry = Pending(operationId, future, decode)
        var drainEntry: Pending<*>? = null
        synchronized(gate) {
            check(!closed.get()) { "CitizenSdk request router is closed" }
            // Holding the admission gate across the C call is intentional. A
            // callback that races before return blocks here; a same-thread
            // reentrant test callback is retained in the exact early map.
            admissionInProgress = true
            val coreRequestId = try {
                begin()
            } catch (error: Throwable) {
                // Only one admission owns the gate. Any reentrant callback in
                // these maps belongs to the failed admission and cannot be
                // exposed because no operation was returned to the caller.
                earlyCompletions.values.forEach { it.result?.let(releaseResult) }
                earlyCompletions.clear()
                throw error
            } finally {
                admissionInProgress = false
            }
            check(coreRequestId != 0L) { "Core returned reserved request ID 0" }
            check(pending.put(coreRequestId, entry) == null) { "Core request ID was reused" }
            check(requestByOperation.put(operationId, coreRequestId) == null) { "facade operation ID was reused" }
            earlyCompletions.remove(coreRequestId)?.let { decoded ->
                pending.remove(coreRequestId)
                requestByOperation.remove(operationId)
                if (enqueue(entry, Delivery.Completion(decoded))) drainEntry = entry
            }
        }
        drainEntry?.let(::drain)
        return CitizenSdkOperation(operationId, future) { cancel(operationId) }
    }

    fun onCompletion(coreRequestId: Long, decoded: CitizenSdkNativeCodec.Decoded) {
        val drainEntry = synchronized(gate) {
            if (!pending.containsKey(coreRequestId)) {
                if (admissionInProgress) {
                    check(earlyCompletions.put(coreRequestId, decoded) == null) {
                        "Core delivered duplicate completion"
                    }
                } else { decoded.result?.let(releaseResult) }
                null
            } else {
                val entry = checkNotNull(pending.remove(coreRequestId))
                requestByOperation.remove(entry.operationId)
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

    fun cancel(operationId: String): Boolean {
        return synchronized(gate) {
            val coreRequestId = requestByOperation[operationId] ?: return@synchronized false
            // Keep the same admission gate through the native call. Completion
            // and close cannot remove/destroy the exact request in this gap.
            cancelNative(coreRequestId)
        }
    }

    override fun close() {
        synchronized(gate) {
            requireIdle()
            closed.set(true)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun deliverCompletion(entryValue: Pending<*>, decoded: CitizenSdkNativeCodec.Decoded) {
        val entry = entryValue as Pending<Any?>
        if (decoded.error != null) {
            entry.future.completeExceptionally(decoded.error)
            return
        }
        var projected: Any? = null
        var cleanupAttempted = false
        fun releaseOwned() {
            if (cleanupAttempted) return
            cleanupAttempted = true
            val owned = projected
            // 已构造公开资源时从其唯一close路径归还，避免Core已释放而门面登记仍存活。
            if (owned is AutoCloseable) owned.close() else decoded.result?.let(releaseResult)
        }
        try {
            if (entry.future.isDone) { releaseOwned(); return }
            projected = entry.decode(checkNotNull(decoded.result))
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
        }
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

    private fun allocateOperationId(): String {
        val value = nextOperation.getAndUpdate { current ->
            if (current == Long.MAX_VALUE) 0 else current + 1
        }
        if (value <= 0) throw CitizenSdkException(
            CitizenSdkErrorCode.INTERNAL,
            "CitizenSDK operation ID space is exhausted",
        )
        return value.toString()
    }
}
