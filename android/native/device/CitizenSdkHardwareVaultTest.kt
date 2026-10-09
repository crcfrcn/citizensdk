package org.citizen.sdk

import androidx.test.core.app.ApplicationProvider
import org.citizen.sdk.internal.CitizenSdkHardwareVault
import org.citizen.sdk.internal.CitizenSdkSecureStore
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class CitizenSdkHardwareVaultTest {

    /** 无活动代际、物理钥缺失和已退休都不能由封装隐式创建钥。 */
    @Test
    fun wrapNeverInitializesOrRebindsWalletGeneration() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/wrap-" + System.nanoTime())
        try {
            CitizenSdkSecureStore(directory).use { store ->
                val vault = CitizenSdkHardwareVault(context, store)
                val generation = ByteArray(16) { 61 }; val original = ByteArray(16) { 62 }
                val append = ByteArray(16) { 63 }
                val dek = java.nio.ByteBuffer.allocateDirect(32)
                fun rejected() {
                    val failure = runCatching { vault.wrapDek(0, generation, append, dek) }.exceptionOrNull()
                    assertTrue(failure is CitizenSdkHardwareVault.VaultFailure)
                    assertEquals(CitizenSdkErrorCode.KEY_INVALIDATED, (failure as CitizenSdkHardwareVault.VaultFailure).code)
                }
                rejected()
                assertTrue(!store.isGenerationActive(0, generation))
                assertTrue(store.ensureGeneration(0, generation, original))
                rejected()
                assertTrue(store.ensureGeneration(0, generation, original))
                assertTrue(!store.ensureGeneration(0, generation, append))
                store.retireGeneration(0, generation, append)
                rejected()
                assertTrue(!store.isGenerationActive(0, generation))
            }
        } finally { directory.deleteRecursively() }
    }

    /** 缺钥追加认证拒绝受理，不触发生物识别、不产生新代际。 */
    @Test
    fun addAuthorizationFailsBeforePromptWhenKeyIsMissing() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/add-" + System.nanoTime())
        try {
            CitizenSdkSecureStore(directory).use { store ->
                val vault = CitizenSdkHardwareVault(context, store)
                val generation = ByteArray(16) { 41 }
                val failure = runCatching {
                    vault.authorizeAddAccounts(1, 0, generation, ByteArray(16) { 42 }) {
                        throw AssertionError("拒绝前不得受理完成回调")
                    }
                }.exceptionOrNull()
                assertTrue(failure is CitizenSdkHardwareVault.VaultFailure)
                assertEquals(CitizenSdkErrorCode.KEY_INVALIDATED, (failure as CitizenSdkHardwareVault.VaultFailure).code)
                assertTrue(!store.isGenerationActive(0, generation))
            }
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun physicalKeyPresenceRejectsUnknownSdkAliases() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/aliases-" + System.nanoTime())
        try {
            CitizenSdkSecureStore(directory).use { store ->
                val vault = CitizenSdkHardwareVault(context, store)
                val first = "citizensdk_wallet_first"; val second = "citizensdk_wallet_second"
                val known = mapOf(first to 0, second to -1) // -1只承载u32最大值的位，不改变系统别名。
                assertTrue(!vault.walletKeyPresent(0, known, emptyList()))
                assertTrue(!vault.walletKeyPresent(0, known, listOf(second)))
                assertTrue(vault.walletKeyPresent(-1, known, listOf(second)))
                assertTrue(vault.walletKeyPresent(0, known, listOf(first)))
                assertTrue(runCatching { vault.walletKeyPresent(0, known, listOf("citizensdk_wallet_unknown")) }.isFailure)
                assertTrue(runCatching { vault.walletKeyPresent(0, known, List(65537) { first }) }.isFailure)
                assertTrue(!vault.walletKeyPresent(0, known, listOf("another-product")))
            }
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun vaultMutationLockSerializesIndependentStores() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/lock-${System.nanoTime()}")
        try {
            CitizenSdkSecureStore(directory).use { first ->
                CitizenSdkSecureStore(directory).use { second ->
                    val entered = CountDownLatch(1)
                    val release = CountDownLatch(1)
                    val finished = CountDownLatch(1)
                    val owner = Thread {
                        first.withVaultLock {
                            entered.countDown()
                            check(release.await(2, TimeUnit.SECONDS))
                        }
                    }
                    owner.start()
                    assertTrue(entered.await(2, TimeUnit.SECONDS))
                    val waiter = Thread { second.withVaultLock { finished.countDown() } }
                    waiter.start()
                    assertTrue(!finished.await(100, TimeUnit.MILLISECONDS))
                    release.countDown()
                    assertTrue(finished.await(2, TimeUnit.SECONDS))
                    owner.join(2_000)
                    waiter.join(2_000)
                    assertTrue(!owner.isAlive && !waiter.isAlive)
                }
            }
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun rustWorkerAuthenticationDispatchReachesAndroidMainLooper() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/dispatch-${System.nanoTime()}")
        try {
            CitizenSdkSecureStore(directory).use { store ->
                val vault = CitizenSdkHardwareVault(context, store)
                val completed = CountDownLatch(1)
                val actual = AtomicReference<Looper>()
                val worker = Thread {
                    vault.dispatchAuthentication {
                        actual.set(Looper.myLooper())
                        completed.countDown()
                    }
                }
                worker.start()
                worker.join()
                assertTrue(completed.await(2, TimeUnit.SECONDS))
                assertEquals(Looper.getMainLooper(), actual.get())
            }
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun deviceReportsStableFailClosedVaultAvailability() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/secure-${System.nanoTime()}")
        CitizenSdkSecureStore(directory).use { store ->
            val availability = CitizenSdkHardwareVault(context, store).availability()
            assertTrue(availability in 1..4)
        }
    }
}
