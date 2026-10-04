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
internal class CitizenSdkHostServices(context: Context, private val modules: Int = CitizenSdkModules.FULL) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    // 回调首次使用时才创建资源，核心拒绝非法组合前不得产生数据库或金库副作用。
    private val usesSecrets = modules and (CitizenSdkModules.WALLET or CitizenSdkModules.SIGNING) != 0
    private val root by lazy { File(context.noBackupFilesDir, "citizensdk/v1") }
    private val publicStoreDelegate = lazy {
        check(modules and (CitizenSdkModules.CHAIN or CitizenSdkModules.HISTORY) != 0) {
            "public store is not selected"
        }
        CitizenSdkPublicStore(File(root, "public"))
    }
    private val secureStoreDelegate = lazy {
        check(usesSecrets) { "secure store is not selected" }
        CitizenSdkSecureStore(File(root, "secure"))
    }
    private val vaultDelegate = lazy { CitizenSdkHardwareVault(context, secureStore) }
    private val publicStore by publicStoreDelegate
    private val secureStore by secureStoreDelegate
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

    @Suppress("unused")
    fun chainDatabaseLoad(): CitizenSdkHostRecord = protect(CitizenSdkHostDomain.CHAIN_DATABASE) {
        publicStore.chainDatabaseLoad()
    }

    @Suppress("unused")
    fun chainDatabaseCompareAndSwap(expectedRevision: Long, candidate: ByteArray): CitizenSdkHostRecord =
        protect(CitizenSdkHostDomain.CHAIN_DATABASE) {
            publicStore.chainDatabaseCompareAndSwap(expectedRevision, candidate)
        }

    @Suppress("unused")
    fun runtimeCacheLoad(blockHash: ByteArray): CitizenSdkHostRecord =
        protect(CitizenSdkHostDomain.RUNTIME_CACHE) { publicStore.runtimeCacheLoad(blockHash) }

    @Suppress("unused")
    fun runtimeCacheStore(blockHash: ByteArray, candidate: ByteArray): Int = status {
        publicStore.runtimeCacheStore(blockHash, candidate)
    }

    @Suppress("unused")
    fun runtimeCacheDelete(blockHash: ByteArray): Int = status {
        publicStore.runtimeCacheDelete(blockHash)
    }

    @Suppress("unused")
    fun transactionHistoryQuery(query: ByteArray): CitizenSdkHostRecord =
        protect(CitizenSdkHostDomain.TRANSACTION_HISTORY) { publicStore.transactionHistoryQuery(query) }

    @Suppress("unused")
    fun transactionHistoryMutate(expectedRevision: Long, mutation: ByteArray): CitizenSdkHostRecord =
        protect(CitizenSdkHostDomain.TRANSACTION_HISTORY) {
            publicStore.transactionHistoryMutate(expectedRevision, mutation)
        }

    @Suppress("unused")
    fun walletProfileLoad(): CitizenSdkHostRecord =
        protect(CitizenSdkHostDomain.WALLET_PROFILE) { secureStore.walletProfileLoad() }

    @Suppress("unused")
    fun walletProfileCompareAndSwap(expectedRevision: Long, candidate: ByteArray): CitizenSdkHostRecord =
        protect(CitizenSdkHostDomain.WALLET_PROFILE) {
            secureStore.walletProfileCompareAndSwap(expectedRevision, candidate)
        }

    @Suppress("unused")
    // 两项均是实际只读查询；同一Host上下文由JNI/SDK销毁屏障保有，不从App回包推测。
    fun hasAccountSecret(accountId: ByteArray): Boolean = secureStore.hasAccountSecret(accountId)
    fun hasAnyWalletKey(walletIndex: Int): Boolean = vault.hasAnyWalletKey(walletIndex)

    fun encryptedSecretLoad(
        walletIndex: Int,
        kind: Int,
        generation: ByteArray,
        owner: ByteArray,
        accountId: ByteArray,
    ): CitizenSdkHostRecord = protect(CitizenSdkHostDomain.ENCRYPTED_SECRET_BLOB) {
        secureStore.encryptedSecretLoad(walletIndex, kind, generation, owner, accountId)
    }

    @Suppress("unused")
    fun encryptedSecretCompareAndSwap(
        walletIndex: Int,
        kind: Int,
        generation: ByteArray,
        owner: ByteArray,
        accountId: ByteArray,
        expectedRevision: Long,
        candidate: ByteArray,
    ): CitizenSdkHostRecord = protect(CitizenSdkHostDomain.ENCRYPTED_SECRET_BLOB) {
        secureStore.encryptedSecretCompareAndSwap(
            walletIndex,
            kind,
            generation,
            owner,
            accountId,
            expectedRevision,
            candidate,
        )
    }

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
            CitizenSdkNative.completeVaultStatus(nativeBridge, hostOperationId, code)
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
                CitizenSdkNative.completeVaultStatus(nativeBridge, hostOperationId, errorCode)
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
        val publicFailure = runCatching { if (publicStoreDelegate.isInitialized()) publicStore.close() }.exceptionOrNull()
        val secureFailure = runCatching { if (secureStoreDelegate.isInitialized()) secureStore.close() }.exceptionOrNull()
        when {
            publicFailure != null -> {
                if (secureFailure != null) publicFailure.addSuppressed(secureFailure)
                throw publicFailure
            }
            secureFailure != null -> throw secureFailure
        }
    }

    private inline fun protect(domain: Int, block: () -> CitizenSdkHostRecord): CitizenSdkHostRecord =
        try {
            block()
        } catch (error: CitizenSdkHistoryFailure) {
            CitizenSdkHostRecord.failure(domain, error.errorCode)
        } catch (_: Throwable) {
            CitizenSdkHostRecord.failure(domain, CitizenSdkErrorCode.STORAGE.value)
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
