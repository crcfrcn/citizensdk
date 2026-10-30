@file:kotlin.jvm.JvmSynthetic

package org.citizen.sdk.internal

import android.content.Context
import androidx.fragment.app.FragmentActivity
import org.citizen.sdk.CitizenSdkErrorCode
import org.citizen.sdk.CitizenSdkModules
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** JNI 私有宿主：按模块延迟创建类型化存储和 KEK/DEK 金库，关闭只释放已创建资源。 */
internal class CitizenSdkHostServices(context: Context, private val modules: Int = CitizenSdkModules.FULL, private val storageRoot: File? = null) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    // 回调首次使用时才创建资源，核心拒绝非法组合前不得产生数据库或金库副作用。
    private val usesSecrets = modules and (CitizenSdkModules.WALLET or CitizenSdkModules.SIGNING) != 0
    private val root by lazy { storageRoot ?: File(context.noBackupFilesDir, "citizensdk/v1") }
    private val databaseDelegate = lazy {
        check(modules and (CitizenSdkModules.CHAIN or CitizenSdkModules.HISTORY) != 0) {
            "public store is not selected"
        }
        CitizenSdkDatabase(File(root, "public"))
    }
    private val secureDatabaseDelegate = lazy {
        check(usesSecrets) { "secure store is not selected" }
        CitizenSdkDatabase(File(root, "secure"), secure = true)
    }
    private val vaultDelegate = lazy { CitizenSdkHardwareVault(context, this) }
    private val database by databaseDelegate
    private val secureDatabase by secureDatabaseDelegate
    private val vault by vaultDelegate
    private val authenticationGate = Any()
    private data class PrivateKeyAuthentication(val host: java.lang.ref.WeakReference<FragmentActivity>, var cancelled: Boolean = false)
    private val privateKeyAuthentications = HashMap<Long, PrivateKeyAuthentication>()

    fun registerPrivateKeyAuthentication(operationId: Long, activity: FragmentActivity): Int = synchronized(authenticationGate) {
        if (operationId == 0L || privateKeyAuthentications.containsKey(operationId)) {
            return@synchronized CitizenSdkErrorCode.INTEGRITY.value
        }
        privateKeyAuthentications[operationId] = PrivateKeyAuthentication(java.lang.ref.WeakReference(activity))
        CitizenSdkErrorCode.OK.value
    }
    fun isPrivateKeyAuthenticationActive(operationId: Long, activity: FragmentActivity): Boolean {
        val allowed = synchronized(authenticationGate) {
            privateKeyAuthentications[operationId]?.let { !it.cancelled && it.host.get() === activity } == true
        }
        return allowed && vaultDelegate.isInitialized() && vault.isAuthenticationActive(operationId, activity)
    }
    fun cancelPrivateKeyAuthentication(operationId: Long) {
        synchronized(authenticationGate) {
            if (!privateKeyAuthentications.containsKey(operationId)) return
            privateKeyAuthentications[operationId]?.cancelled = true
            if (vaultDelegate.isInitialized()) vault.cancelAuthentication(operationId)
        }
    }
    fun releasePrivateKeyAuthentication(operationId: Long) {
        synchronized(authenticationGate) { privateKeyAuthentications.remove(operationId) }
        if (vaultDelegate.isInitialized()) vault.releasePrivateKeyAuthentication(operationId)
    }

    fun attachActivity(activity: FragmentActivity) { if (usesSecrets) vault.attachActivity(activity) }
    fun privateKeyActivity(): FragmentActivity? = if (usesSecrets) vault.currentActivity() else null
    fun detachActivity(activity: FragmentActivity) { if (vaultDelegate.isInitialized()) vault.detachActivity(activity) }
    fun whenActivityReady(callback: () -> Unit): AutoCloseable =
        if (usesSecrets) vault.whenActivityReady(callback) else AutoCloseable {}
    fun setActivityReadinessListener(listener: (() -> Unit)?) {
        if (usesSecrets && (listener != null || vaultDelegate.isInitialized())) vault.setReadinessListener(listener)
    }

    // JNI在已有Rust请求线程附着JVM并持有此锁，整次job不切换线程。
    private fun resource(secure: Boolean) = if (secure) secureDatabase else database
    fun databaseLock(secure: Boolean): Int = status { resource(secure).acquire() }
    fun databaseUnlock(secure: Boolean): Int = status { resource(secure).release() }
    fun databaseBegin(secure: Boolean): Int = status { resource(secure).begin() }
    fun databaseEnd(secure: Boolean, commit: Boolean): Int = status { resource(secure).end(commit) }
    fun databaseWal(secure: Boolean): Int = status { resource(secure).wal() }
    fun databaseExecute(secure: Boolean, sql: String, values: Array<Any?>): Long = resource(secure).execute(sql, values)
    fun databaseCursor(secure: Boolean, sql: String, values: Array<Any?>): android.database.Cursor = resource(secure).cursor(sql, values)

    fun hasAnyWalletKey(walletIndex: Int): Boolean = vault.hasAnyWalletKey(walletIndex)
    fun ensureGeneration(index: Int, generation: ByteArray, operation: ByteArray): Boolean =
        Bindings.storeGeneration(this, 1, index, generation, operation)
    fun isGenerationActive(index: Int, generation: ByteArray): Boolean =
        Bindings.storeGeneration(this, 2, index, generation, ByteArray(16))
    fun retireGeneration(index: Int, generation: ByteArray, operation: ByteArray) {
        Bindings.storeGeneration(this, 4, index, generation, operation)
    }
    fun vaultGenerations(): List<Pair<Int, ByteArray>> {
        val bytes = Bindings.storeGenerations(this)
        check(bytes.size % 20 == 0 && bytes.size / 20 <= 65536)
        val buffer = ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        return List(bytes.size / 20) { val index = buffer.int; val generation = ByteArray(16); buffer.get(generation); index to generation }
    }
    fun <T> withVaultLock(body: () -> T): T = secureDatabase.withVaultLock(body)

    @Suppress("unused")
    fun vaultAvailability(): Int = vault.availability()

    @Suppress("unused")
    fun ensureWalletKek(
        walletIndex: Int,
        generation: ByteArray,
        provisioningOperationId: ByteArray,
    ): Int = status { vault.ensureWalletKek(walletIndex, generation, provisioningOperationId) }

    @Suppress("unused")
    fun hasWalletKek(walletIndex: Int, generation: ByteArray): Boolean =
        vault.hasWalletKek(walletIndex, generation)

    @Suppress("unused")
    fun wrapDek(
        walletIndex: Int,
        generation: ByteArray,
        provisioningOperationId: ByteArray,
        plaintextDek: ByteBuffer,
    ): ByteArray = vault.wrapDek(walletIndex, generation, provisioningOperationId, plaintextDek)

    @Suppress("unused")
    fun authorizeAddAccounts(nativeBridge: Long, hostOperationId: Long, walletIndex: Int,
        generation: ByteArray, provisioningOperationId: ByteArray): Int = try {
        vault.authorizeAddAccounts(hostOperationId, walletIndex, generation, provisioningOperationId) { code ->
            Bindings.completeVaultStatus(nativeBridge, hostOperationId, code)
        }
        CitizenSdkErrorCode.OK.value
    } catch (error: CitizenSdkHardwareVault.VaultFailure) { error.code.value }
      catch (_: Throwable) { CitizenSdkErrorCode.INTERNAL.value }

    @Suppress("unused")
    fun unwrapDek(
        nativeBridge: Long,
        hostOperationId: Long,
        walletIndex: Int,
        generation: ByteArray,
        wrappedDek: ByteArray,
        plaintextDekOut: ByteBuffer,
    ): Int = try {
        synchronized(authenticationGate) {
            val privateRequest = privateKeyAuthentications[hostOperationId]
            if (privateRequest?.cancelled == true || privateRequest != null && privateRequest.host.get() == null) throw CitizenSdkHardwareVault.VaultFailure(
                CitizenSdkErrorCode.AUTHENTICATION_CANCELLED, "private key authentication was cancelled",
            )
            vault.unwrapDek(hostOperationId, privateRequest != null, privateRequest?.host?.get(),
                walletIndex, generation, wrappedDek, plaintextDekOut) { errorCode ->
                Bindings.completeVaultStatus(nativeBridge, hostOperationId, errorCode)
            }
        }
        CitizenSdkErrorCode.OK.value
    } catch (error: CitizenSdkHardwareVault.VaultFailure) {
        error.code.value
    } catch (_: Throwable) {
        CitizenSdkErrorCode.INTERNAL.value
    }

    @Suppress("unused")
    fun retireWalletKek(
        walletIndex: Int,
        generation: ByteArray,
        cleanupOperationId: ByteArray,
    ): Int = status { vault.retireWalletKek(walletIndex, generation, cleanupOperationId) }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        if (vaultDelegate.isInitialized()) vault.setReadinessListener(null)
        val publicFailure = runCatching { if (databaseDelegate.isInitialized()) database.close() }.exceptionOrNull()
        val secureFailure = runCatching { if (secureDatabaseDelegate.isInitialized()) secureDatabase.close() }.exceptionOrNull()
        when {
            publicFailure != null -> {
                if (secureFailure != null) publicFailure.addSuppressed(secureFailure)
                throw publicFailure
            }
            secureFailure != null -> throw secureFailure
        }
    }

    private inline fun status(block: () -> Unit): Int = try {
        block()
        CitizenSdkErrorCode.OK.value
    } catch (error: CitizenSdkHardwareVault.VaultFailure) {
        error.code.value
    } catch (_: Throwable) {
        CitizenSdkErrorCode.STORAGE.value
    }
}
