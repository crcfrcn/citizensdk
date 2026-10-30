@file:kotlin.jvm.JvmSynthetic
package org.citizen.sdk.internal
import java.util.concurrent.atomic.AtomicBoolean
internal class CoreResult(val handle:Long,val value:Any?,private val release:(Boolean)->Unit):AutoCloseable {
    private val closed=AtomicBoolean(false)
    private var kept=false
    fun keep(){check(!closed.get());kept=true}
    override fun close(){if(closed.compareAndSet(false,true))release(kept)}
}
