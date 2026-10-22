@file:kotlin.jvm.JvmSynthetic

package org.citizen.sdk.internal

import org.citizen.sdk.CitizenSdkErrorCode
import org.citizen.sdk.CitizenSdkException
import org.citizen.sdk.CitizenSdkInputLimits
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/** Mutable short-lived JVM buffer for the unavoidable Android recovery UI. */
internal class CitizenSdkSensitiveBytes private constructor(
    private val value: ByteArray,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    fun <T> use(block: (ByteArray) -> T): T {
        check(!closed.get()) { "sensitive bytes are closed" }
        return try {
            block(value)
        } finally {
            close()
        }
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) value.fill(0)
    }

    companion object {
        fun utf8(text: CharSequence): CitizenSdkSensitiveBytes {
            // Use one fixed-size staging buffer. A pasted oversized secret is
            // rejected before any proportional UTF-8 allocation or JNI copy.
            val encoded = ByteBuffer.allocate(CitizenSdkInputLimits.MAX_WALLET_SECRET_BYTES)
            return try {
                val encoder = StandardCharsets.UTF_8.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                val input = CharBuffer.wrap(text)
                val encodedResult = encoder.encode(input, encoded, true)
                if (encodedResult.isOverflow) throw tooLarge()
                if (encodedResult.isError) encodedResult.throwException()
                val flushResult = encoder.flush(encoded)
                if (flushResult.isOverflow) throw tooLarge()
                if (flushResult.isError) flushResult.throwException()
                encoded.flip()
                val bytes = ByteArray(encoded.remaining())
                encoded.get(bytes)
                CitizenSdkSensitiveBytes(bytes)
            } catch (error: CitizenSdkException) {
                throw error
            } catch (error: Throwable) {
                throw CitizenSdkException(
                    CitizenSdkErrorCode.INVALID_ARGUMENT,
                    "wallet secret is not valid UTF-8 text",
                    error,
                )
            } finally {
                encoded.clear()
                while (encoded.hasRemaining()) encoded.put(0)
            }
        }

        fun empty(): CitizenSdkSensitiveBytes = CitizenSdkSensitiveBytes(ByteArray(0))

        private fun tooLarge() = CitizenSdkException(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "wallet secret exceeds ${CitizenSdkInputLimits.MAX_WALLET_SECRET_BYTES} UTF-8 bytes",
        )
    }
}
