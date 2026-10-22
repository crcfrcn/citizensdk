package org.citizen.sdk

import java.util.concurrent.CompletableFuture

/**
 * Public correlation identity plus completion for an accepted facade call.
 *
 * The decimal `operationId` is allocated before JNI admission and never equals
 * or reveals the Core request ID. It lets Flutter or Java register correlation
 * before an early native callback is delivered.
 */
class CitizenSdkOperation<T> internal constructor(
    val operationId: String,
    val future: CompletableFuture<T>,
    private val cancelAction: () -> Boolean,
) {
    /**
     * Requests cancellation of this exact accepted Core operation.
     *
     * Cancellation never destroys the SDK and never completes [future]
     * locally. The future stays outstanding until Core emits its one terminal
     * `CANCELLED` completion, preserving owned results and durable history.
     */
    fun cancel(): Boolean = cancelAction()
}
