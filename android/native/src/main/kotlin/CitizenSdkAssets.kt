package org.citizen.sdk.internal

import android.content.Context
import java.io.FileNotFoundException

internal class CitizenSdkAssets private constructor(
    val manifest: ByteArray,
    val chainSpec: ByteArray,
    val lightSyncState: ByteArray,
) {
    companion object {
        // 仅接收正式AAR与Flutter消费位置；源码目录唯一为chain，不读取旧包装路径。
        private val PREFIXES = listOf(
            "chain",
            "flutter_assets/packages/citizen_sdk/chain",
            "packages/citizen_sdk/chain",
        )

        fun load(context: Context): CitizenSdkAssets = CitizenSdkAssets(
            manifest = read(context, "manifest.json", 64 * 1024),
            chainSpec = read(context, "chainspec.json", 16 * 1024 * 1024),
            lightSyncState = read(context, "light_sync_state.json", 16 * 1024 * 1024),
        )

        private fun read(context: Context, name: String, limit: Int): ByteArray {
            for (prefix in PREFIXES) {
                try {
                    return context.assets.open("$prefix/$name").use { input ->
                        input.readBytes().also {
                            require(it.isNotEmpty() && it.size <= limit) { "$name has an invalid size" }
                        }
                    }
                } catch (_: FileNotFoundException) {
                    // Try the next official AAR/Flutter packaged location.
                }
            }
            throw FileNotFoundException("CitizenSDK asset $name is missing")
        }
    }
}

