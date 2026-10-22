package org.citizen.sdk

/** Android 桥接层在同一有序执行器发布无秘密的历史失效、最终区块、生命周期和能力快照事件。 */
object CitizenSdkEvents {
    sealed class Event(open val sequence: String) {
        /** Invalidation only; query the existing history API for the current state. */
        class HistoryChanged(override val sequence: String) : Event(sequence)
        /** 钱包失效通知；只按后续真实目录修订更新UI，不推断提交成功。 */
        class WalletChanged(override val sequence: String) : Event(sequence)
        class FinalizedBlockChanged(
            override val sequence: String,
            val finalized: CitizenBlockRef,
        ) : Event(sequence)
        class LifecycleChanged(
            override val sequence: String,
            val lifecycle: CitizenSdkLifecycle,
        ) : Event(sequence)

        /** Carries the complete snapshot; consumers never race a follow-up query. */
        class CapabilitiesChanged(
            override val sequence: String,
            val capabilities: CitizenSdkCapabilities,
        ) : Event(sequence)

    }

    fun interface Listener {
        fun onEvent(event: Event)
    }

}
