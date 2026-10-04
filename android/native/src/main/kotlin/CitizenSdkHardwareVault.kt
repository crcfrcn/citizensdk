@file:kotlin.jvm.JvmSynthetic

package org.citizen.sdk.internal

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import org.citizen.sdk.CitizenSdkErrorCode
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.IdentityHashMap
import java.util.LinkedHashMap
import java.util.concurrent.atomic.AtomicLong
import java.lang.ref.WeakReference
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

/** Generation-scoped hardware KEK service. Child secrets never reach it. */
internal class CitizenSdkHardwareVault(
    private val context: Context,
    private val secureStore: CitizenSdkSecureStore,
) {
    private val activities = CitizenSdkActivityRegistry()
    // 仅由主线程访问；每个 prompt 的取消与销毁观察者都拥有同一 terminal owner。
    private val prompts = IdentityHashMap<FragmentActivity, MutableSet<() -> Unit>>()
    private val authenticationOperations = HashMap<Long, Pair<WeakReference<FragmentActivity>, () -> Unit>>()
    private val cancelledAuthentications = HashSet<Long>()

    /** 只查询当前视图所属实际操作和 Activity，其他 prompt 不提供失焦豁免。 */
    fun isAuthenticationActive(operationId: Long, activity: FragmentActivity): Boolean {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        return authenticationOperations[operationId]?.first?.get() === activity &&
            !cancelledAuthentications.contains(operationId)
    }
    fun cancelAuthentication(operationId: Long) = dispatchAuthentication {
        cancelledAuthentications.add(operationId)
        authenticationOperations[operationId]?.second?.invoke()
    }
    fun releasePrivateKeyAuthentication(operationId: Long) = dispatchAuthentication {
        cancelledAuthentications.remove(operationId)
    }

    fun attachActivity(value: FragmentActivity) {
        activities.attach(value)
    }

    fun detachActivity(value: FragmentActivity) {
        activities.detach(value)
        dispatchAuthentication {
            prompts[value]?.toList()?.forEach { it() }
        }
    }

    /** AndroidX Fragment/Biometric 的唯一 UI 调度入口，调用者可以来自 Rust worker。 */
    internal fun dispatchAuthentication(operation: () -> Unit) {
        ContextCompat.getMainExecutor(context).execute(operation)
    }

    fun whenActivityReady(callback: () -> Unit): AutoCloseable = activities.whenResumed(callback)

    fun setReadinessListener(listener: (() -> Unit)?) = activities.setReadinessListener(listener)
    fun currentActivity(): FragmentActivity? = activities.currentResumed()

    fun availability(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return VAULT_UNSUPPORTED
        val device = when (
            BiometricManager.from(context).canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG,
            )
        ) {
            BiometricManager.BIOMETRIC_SUCCESS -> VAULT_AVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> VAULT_NO_STRONG_AUTH
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED -> VAULT_UNSUPPORTED
            else -> VAULT_UNAVAILABLE
        }
        // Device support and current host readiness are separate facts. The
        // existing ABI v1 has one availability enum, so an otherwise capable
        // device with no RESUMED FragmentActivity is conservatively exposed as
        // authentication-required, never ready.
        return if (device == VAULT_AVAILABLE && activities.currentResumed() == null) {
            VAULT_NO_STRONG_AUTH
        } else {
            device
        }
    }

    @Synchronized
    fun ensureWalletKek(
        walletIndex: Int,
        generation: ByteArray,
        provisioningOperationId: ByteArray,
    ) {
        secureStore.withVaultLock {
            ensureWalletKekLocked(walletIndex, generation, provisioningOperationId)
        }
    }

    private fun ensureWalletKekLocked(
        walletIndex: Int,
        generation: ByteArray,
        provisioningOperationId: ByteArray,
    ) {
        require(walletIndex == 0) { "only wallet index 0 is supported" }
        if (!secureStore.ensureGeneration(walletIndex, generation, provisioningOperationId)) {
            throw VaultFailure(CitizenSdkErrorCode.KEY_INVALIDATED, "wallet generation is retired")
        }
        val alias = CitizenSdkRecordKey.hardwareAlias(walletIndex, generation)
        val keyStore = keyStore()
        if (!keyStore.containsAlias(alias)) generateHardwareKey(alias)
        requireHardwareKey(alias)
    }


    /** 只枚举系统别名，不解锁、不触发弹窗；未知SDK别名和读取错误一律失败。 */
    @Synchronized
    fun hasAnyWalletKey(walletIndex: Int): Boolean = secureStore.withVaultLock {
        val known = HashMap<String, Int>()
        for ((index, generation) in secureStore.vaultGenerations()) {
            val alias = CitizenSdkRecordKey.hardwareAlias(index, generation)
            if (known.put(alias, index) != null) throw VaultFailure(CitizenSdkErrorCode.INTEGRITY, "金库别名重复")
        }
        val aliases = keyStore().aliases()
        val names = ArrayList<String>()
        var count = 0
        while (aliases.hasMoreElements()) {
            if (++count > 65536) throw VaultFailure(CitizenSdkErrorCode.INTEGRITY, "金库别名枚举超限")
            val alias = aliases.nextElement()
            if (alias.startsWith("citizensdk_wallet_")) names.add(alias)
        }
        walletKeyPresent(walletIndex, known, names)
    }

    /** 生产归属判断的有限输入接缝，不把存在或错误转换成热/冷签名结论。 */
    internal fun walletKeyPresent(walletIndex: Int, known: Map<String, Int>, names: List<String>): Boolean {
        if (names.size > 65536) throw VaultFailure(CitizenSdkErrorCode.INTEGRITY, "金库别名枚举超限")
        for (alias in names) {
            if (!alias.startsWith("citizensdk_wallet_")) continue
            val index = known[alias] ?: throw VaultFailure(CitizenSdkErrorCode.INTEGRITY, "存在无法归属的SDK物理钥")
            if (index == walletIndex) return true
        }
        return false
    }

    @Synchronized
    fun hasWalletKek(walletIndex: Int, generation: ByteArray): Boolean {
        return secureStore.withVaultLock {
            if (!secureStore.isGenerationActive(walletIndex, generation)) return@withVaultLock false
            val alias = CitizenSdkRecordKey.hardwareAlias(walletIndex, generation)
            val keyStore = keyStore()
            if (!keyStore.containsAlias(alias)) return@withVaultLock false
            requireHardwareKey(alias)
            true
        }
    }

    /** Reads the exact Rust-owned 32-byte direct view; it never creates a plaintext array. */
    @Synchronized
    fun wrapDek(
        walletIndex: Int,
        generation: ByteArray,
        provisioningOperationId: ByteArray,
        plaintextDek: ByteBuffer,
    ): ByteArray {
        require(plaintextDek.isDirect && plaintextDek.remaining() == DEK_BYTES) {
            "DEK must be an exact direct 32-byte Rust view"
        }
        return secureStore.withVaultLock {
            // 追加复用原活动钥；封装不能创建密钥、改写创建所有者或复活退休代际。
            require(walletIndex == 0 && generation.size == 16 && provisioningOperationId.size == 16) {
                "wallet KEK identity is malformed"
            }
            if (!secureStore.isGenerationActive(walletIndex, generation)) {
                throw VaultFailure(CitizenSdkErrorCode.KEY_INVALIDATED, "wallet generation is not active")
            }
            val alias = CitizenSdkRecordKey.hardwareAlias(walletIndex, generation)
            requireHardwareKey(alias)
            val publicKey = keyStore().getCertificate(alias)?.publicKey
                ?: throw VaultFailure(CitizenSdkErrorCode.KEY_INVALIDATED, "wallet KEK is unavailable")
            // Rebuild the public key without AndroidKeyStore restrictions. Only the
            // private unwrap path requires hardware and biometric authorization.
            val unrestricted = KeyFactory.getInstance(publicKey.algorithm)
                .generatePublic(X509EncodedKeySpec(publicKey.encoded))
            val cipher = Cipher.getInstance(RSA_TRANSFORM).apply {
                init(Cipher.ENCRYPT_MODE, unrestricted, oaepSpec())
            }
            val output = ByteArray(cipher.getOutputSize(DEK_BYTES))
            val written = cipher.doFinal(plaintextDek.asReadOnlyBuffer(), ByteBuffer.wrap(output))
            check(written == output.size) { "wrapped DEK length is not canonical" }
            output
        }
    }

    /** 整批追加独立生物认证；不取得原账户私钥，不缓存成功，也不触碰密钥封装格式。 */
    fun authorizeAddAccounts(hostOperationId: Long, walletIndex: Int, generation: ByteArray,
        provisioningOperationId: ByteArray, completion: (Int) -> Unit) {
        require(hostOperationId != 0L && generation.size == 16 && provisioningOperationId.size == 16 &&
            provisioningOperationId.any { it != 0.toByte() }) { "追加认证身份无效" }
        if (!hasWalletKek(walletIndex, generation)) throw VaultFailure(
            CitizenSdkErrorCode.KEY_INVALIDATED, "wallet KEK is unavailable")
        val host = activities.currentResumed() ?: throw VaultFailure(
            CitizenSdkErrorCode.AUTHENTICATION_REQUIRED, "no foreground wallet activity")
        dispatchAuthentication {
            var prompt: BiometricPrompt? = null
            var observer: DefaultLifecycleObserver? = null
            var cancel: (() -> Unit)? = null
            var finished = false
            // 全部状态只在主线程访问；迟到或重复系统回调不能再次完成，也不能覆盖取消。
            fun finish(code: CitizenSdkErrorCode) {
                if (finished) return
                finished = true
                observer?.let { host.lifecycle.removeObserver(it) }
                cancel?.let { prompts[host]?.remove(it) }
                if (prompts[host]?.isEmpty() == true) prompts.remove(host)
                authenticationOperations.remove(hostOperationId)
                completion(code.value)
            }
            try {
                if (host.isDestroyed || host.isFinishing || activities.currentResumed() !== host ||
                    !host.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || host.supportFragmentManager.isStateSaved) {
                    finish(CitizenSdkErrorCode.AUTHENTICATION_CANCELLED)
                    return@dispatchAuthentication
                }
                prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(host), object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        finish(mapAuthenticationError(errorCode))
                    }
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (finished) return
                        try {
                            finish(if (hasWalletKek(walletIndex, generation)) CitizenSdkErrorCode.OK
                                else CitizenSdkErrorCode.KEY_INVALIDATED)
                        } catch (_: Throwable) { finish(CitizenSdkErrorCode.KEY_INVALIDATED) }
                    }
                })
                cancel = { finish(CitizenSdkErrorCode.AUTHENTICATION_CANCELLED); prompt?.cancelAuthentication() }
                observer = object : DefaultLifecycleObserver {
                    override fun onDestroy(owner: LifecycleOwner) { cancel?.invoke() }
                }
                prompts.getOrPut(host) { LinkedHashSet() }.add(cancel!!)
                authenticationOperations[hostOperationId] = WeakReference(host) to cancel!!
                host.lifecycle.addObserver(observer!!)
                prompt!!.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("验证身份")
                    .setSubtitle("验证身份以添加本批账户")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButtonText("取消").build())
            } catch (_: Throwable) {
                finish(CitizenSdkErrorCode.INTERNAL)
                prompt?.cancelAuthentication()
            }
        }
    }

    /**
     * Authenticates asynchronously, then writes directly into Rust memory.
     * Completion is invoked after the cipher has stopped accessing the view.
     */
    fun unwrapDek(
        hostOperationId: Long,
        privateKeyView: Boolean,
        boundActivity: FragmentActivity?,
        walletIndex: Int,
        generation: ByteArray,
        wrappedDek: ByteArray,
        plaintextDekOut: ByteBuffer,
        completion: (Int) -> Unit,
    ) {
        require(plaintextDekOut.isDirect && plaintextDekOut.remaining() == DEK_BYTES) {
            "DEK output must be an exact direct 32-byte Rust view"
        }
        try {
            if (!hasWalletKek(walletIndex, generation)) {
                throw VaultFailure(CitizenSdkErrorCode.KEY_INVALIDATED, "wallet KEK is unavailable")
            }
            val host = (if (privateKeyView) boundActivity else activities.currentResumed())
                ?: throw VaultFailure(CitizenSdkErrorCode.AUTHENTICATION_REQUIRED, "no foreground wallet activity")
            val alias = CitizenSdkRecordKey.hardwareAlias(walletIndex, generation)
            val privateKey = keyStore().getKey(alias, null) as? PrivateKey
                ?: throw VaultFailure(CitizenSdkErrorCode.KEY_INVALIDATED, "wallet KEK is unavailable")
            val cipher = try {
                Cipher.getInstance(RSA_TRANSFORM).apply {
                    init(Cipher.DECRYPT_MODE, privateKey, oaepSpec())
                }
            } catch (error: KeyPermanentlyInvalidatedException) {
                throw VaultFailure(CitizenSdkErrorCode.KEY_INVALIDATED, "wallet KEK was invalidated", error)
            }

            // Rust worker 只准备密码学对象；Fragment、prompt 创建/启动/取消全部回主线程。
            dispatchAuthentication {
                var prompt: BiometricPrompt? = null
                var observer: DefaultLifecycleObserver? = null
                var cancel: (() -> Unit)? = null
                val accepted = CitizenSdkVaultOperation(plaintextDekOut, wrappedDek) { code ->
                    observer?.let { host.lifecycle.removeObserver(it) }
                    cancel?.let { prompts[host]?.remove(it) }
                    if (prompts[host]?.isEmpty() == true) prompts.remove(host)
                    authenticationOperations.remove(hostOperationId)
                    completion(code)
                }
                try {
                    if (host.isDestroyed || host.isFinishing || !host.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                        accepted.finish { CitizenSdkErrorCode.AUTHENTICATION_CANCELLED }
                        return@dispatchAuthentication
                    }
                    if (privateKeyView && cancelledAuthentications.contains(hostOperationId)) {
                        accepted.finish { CitizenSdkErrorCode.AUTHENTICATION_CANCELLED }
                        return@dispatchAuthentication
                    }
                    // 排队期间宿主可能已销毁、暂停或被替换，不能沿用 worker 的就绪快照。
                    if (activities.currentResumed() !== host || host.supportFragmentManager.isStateSaved) {
                        accepted.finish { CitizenSdkErrorCode.AUTHENTICATION_REQUIRED }
                        return@dispatchAuthentication
                    }
                    val callback = object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            accepted.finish { mapAuthenticationError(errorCode) }
                        }

                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            accepted.finish {
                                try {
                                    val authenticated = result.cryptoObject?.cipher
                                        ?: throw VaultFailure(CitizenSdkErrorCode.INTEGRITY, "biometric cipher is missing")
                                    val written = authenticated.doFinal(ByteBuffer.wrap(wrappedDek), plaintextDekOut.duplicate())
                                    if (written == DEK_BYTES) CitizenSdkErrorCode.OK else CitizenSdkErrorCode.INTEGRITY
                                } catch (_: KeyPermanentlyInvalidatedException) {
                                    CitizenSdkErrorCode.KEY_INVALIDATED
                                } catch (_: Throwable) { CitizenSdkErrorCode.INTEGRITY }
                            }
                        }
                    }
                    prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(host), callback)
                    cancel = {
                        // 私钥查看只请求系统取消，必须等真实认证回调归还借用，不能提前伪造排空。
                        if (!privateKeyView) accepted.finish { CitizenSdkErrorCode.AUTHENTICATION_CANCELLED }
                        prompt?.cancelAuthentication()
                    }
                    observer = object : DefaultLifecycleObserver {
                        override fun onDestroy(owner: LifecycleOwner) { cancel?.invoke() }
                    }
                    prompts.getOrPut(host) { LinkedHashSet() }.add(cancel!!)
                    authenticationOperations[hostOperationId] = WeakReference(host) to cancel!!
                    host.lifecycle.addObserver(observer!!)
                    val promptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("验证身份")
                        .setSubtitle("授权 CitizenSDK 钱包操作以继续")
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                        .setNegativeButtonText("取消")
                        .build()
                    prompt!!.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
                } catch (_: Throwable) {
                    accepted.finish { CitizenSdkErrorCode.INTERNAL }
                    prompt?.cancelAuthentication()
                }
            }
        } catch (error: Throwable) {
            clearDirect(plaintextDekOut)
            wrappedDek.fill(0)
            throw error
        }
    }

    @Synchronized
    fun retireWalletKek(
        walletIndex: Int,
        generation: ByteArray,
        cleanupOperationId: ByteArray,
    ) {
        // The permanent tombstone is the commit point. Physical deletion comes
        // afterward, so a crash or late ensure cannot resurrect this key.
        secureStore.withVaultLock {
            secureStore.retireGeneration(walletIndex, generation, cleanupOperationId)
            val alias = CitizenSdkRecordKey.hardwareAlias(walletIndex, generation)
            val keyStore = keyStore()
            if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
            check(!keyStore.containsAlias(alias)) { "retired wallet KEK still exists" }
        }
    }

    private fun generateHardwareKey(alias: String) {
        if (availability() != VAULT_AVAILABLE) {
            throw VaultFailure(CitizenSdkErrorCode.AUTHENTICATION_REQUIRED, "strong biometric is unavailable")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                generateKey(alias, strongBox = true)
                return
            } catch (_: StrongBoxUnavailableException) {
                // A hardware TEE is the only allowed fallback.
            }
        }
        generateKey(alias, strongBox = false)
    }

    private fun generateKey(alias: String, strongBox: Boolean) {
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            .setKeySize(2048)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, KEYSTORE).apply {
            initialize(builder.build())
            generateKeyPair()
        }
    }

    private fun requireHardwareKey(alias: String) {
        val keyStore = keyStore()
        val privateKey = keyStore.getKey(alias, null) as? PrivateKey
            ?: throw VaultFailure(CitizenSdkErrorCode.KEY_INVALIDATED, "wallet KEK is unavailable")
        val info = KeyFactory.getInstance(privateKey.algorithm, KEYSTORE)
            .getKeySpec(privateKey, KeyInfo::class.java)
        val hardware = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX ||
                info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT
        } else {
            @Suppress("DEPRECATION")
            info.isInsideSecureHardware
        }
        val perUseStrong = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            info.userAuthenticationValidityDurationSeconds == 0 &&
                info.userAuthenticationType == KeyProperties.AUTH_BIOMETRIC_STRONG
        } else {
            @Suppress("DEPRECATION")
            info.userAuthenticationValidityDurationSeconds == -1
        }
        if (!hardware || !info.isUserAuthenticationRequired ||
            !info.isUserAuthenticationRequirementEnforcedBySecureHardware || !perUseStrong
        ) {
            // 查询/校验不能删除已存在的密钥；失败只报告设备事实。
            // 物理删除仅允许走带持久退休记录的retireWalletKek路径。
            throw VaultFailure(CitizenSdkErrorCode.UNAVAILABLE, "wallet KEK is not hardware enforced")
        }
    }

    private fun mapAuthenticationError(code: Int): CitizenSdkErrorCode = when (code) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED -> CitizenSdkErrorCode.AUTHENTICATION_CANCELLED
        BiometricPrompt.ERROR_NO_BIOMETRICS,
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> CitizenSdkErrorCode.AUTHENTICATION_REQUIRED
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_HW_UNAVAILABLE -> CitizenSdkErrorCode.UNAVAILABLE
        else -> CitizenSdkErrorCode.AUTHENTICATION_REQUIRED
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun clearDirect(buffer: ByteBuffer) {
        val destination = buffer.duplicate()
        while (destination.hasRemaining()) destination.put(0)
    }

    private fun oaepSpec() = OAEPParameterSpec(
        "SHA-256",
        "MGF1",
        MGF1ParameterSpec.SHA1,
        PSource.PSpecified.DEFAULT,
    )

    internal class VaultFailure(
        val code: CitizenSdkErrorCode,
        message: String,
        cause: Throwable? = null,
    ) : RuntimeException(message, cause)

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val RSA_TRANSFORM = "RSA/ECB/OAEPPadding"
        private const val DEK_BYTES = 32
        const val VAULT_AVAILABLE = 1
        const val VAULT_NO_STRONG_AUTH = 2
        const val VAULT_UNSUPPORTED = 3
        const val VAULT_UNAVAILABLE = 4
    }
}

/** 先独占 terminal 权再碰 buffer；完成后所有迟到/重复回调均不得读写借用地址。 */
internal class CitizenSdkVaultOperation(
    private val output: ByteBuffer,
    private val wrapped: ByteArray,
    private val completion: (Int) -> Unit,
) {
    private val gate = Any()
    private var finished = false

    fun finish(operation: () -> CitizenSdkErrorCode) {
        val code = synchronized(gate) {
            if (finished) return
            finished = true
            val result = try { operation() } catch (_: Throwable) { CitizenSdkErrorCode.INTERNAL }
            if (result != CitizenSdkErrorCode.OK) {
                val bytes = output.duplicate()
                while (bytes.hasRemaining()) bytes.put(0)
            }
            wrapped.fill(0)
            result
        }
        completion(code.value)
    }
}

/**
 * Generation-owned Activity stack.
 *
 * A secure wallet flow temporarily becomes the newest host. Removing that
 * generation exposes the still-live parent host; a stale lifecycle callback
 * can never remove a newer generation. Deferred flow results are released
 * only after some attached host is RESUMED, so an immediate sign/transfer can
 * safely launch BIOMETRIC_STRONG.
 */
internal class CitizenSdkActivityRegistry {
    private data class Entry(
        val generation: Long,
        val activity: FragmentActivity,
        val observer: DefaultLifecycleObserver,
    )

    private val gate = Any()
    private val nextGeneration = AtomicLong(1)
    private val nextWaiter = AtomicLong(1)
    private val entries = IdentityHashMap<FragmentActivity, Entry>()
    private val order = ArrayList<Entry>()
    private val waiters = LinkedHashMap<Long, () -> Unit>()
    private var readinessListener: (() -> Unit)? = null
    private var lastReady = false

    fun attach(activity: FragmentActivity) {
        val generation = nextGeneration.getAndIncrement().also { check(it > 0) }
        lateinit var observer: DefaultLifecycleObserver
        observer = object : DefaultLifecycleObserver {
            override fun onResume(owner: LifecycleOwner) = dispatchIfReady()
            override fun onPause(owner: LifecycleOwner) = dispatchIfReady()
            override fun onDestroy(owner: LifecycleOwner) = detach(activity, generation)
        }
        val old = synchronized(gate) {
            entries.remove(activity)?.also(order::remove).also {
                val entry = Entry(generation, activity, observer)
                entries[activity] = entry
                order += entry
            }
        }
        old?.activity?.lifecycle?.removeObserver(old.observer)
        activity.lifecycle.addObserver(observer)
        dispatchIfReady()
    }

    fun detach(activity: FragmentActivity) {
        val generation = synchronized(gate) { entries[activity]?.generation } ?: return
        detach(activity, generation)
    }

    fun currentResumed(): FragmentActivity? = synchronized(gate) { currentResumedLocked() }

    fun setReadinessListener(listener: (() -> Unit)?) {
        synchronized(gate) {
            readinessListener = listener
            lastReady = currentResumedLocked() != null
        }
    }

    fun whenResumed(callback: () -> Unit): AutoCloseable {
        val waiterId = nextWaiter.getAndIncrement().also { check(it > 0) }
        val immediate = synchronized(gate) {
            if (currentResumedLocked() != null) true else {
                waiters[waiterId] = callback
                false
            }
        }
        if (immediate) callback()
        return AutoCloseable { synchronized(gate) { waiters.remove(waiterId) } }
    }

    private fun detach(activity: FragmentActivity, generation: Long) {
        val removed = synchronized(gate) {
            val entry = entries[activity]
            if (entry == null || entry.generation != generation) null else {
                entries.remove(activity)
                order.remove(entry)
                entry
            }
        }
        removed?.activity?.lifecycle?.removeObserver(removed.observer)
        dispatchIfReady()
    }

    private fun dispatchIfReady() {
        var readinessCallback: (() -> Unit)? = null
        val callbacks = synchronized(gate) {
            val ready = currentResumedLocked() != null
            if (ready != lastReady) {
                lastReady = ready
                readinessCallback = readinessListener
            }
            if (!ready || waiters.isEmpty()) emptyList() else {
                waiters.values.toList().also { waiters.clear() }
            }
        }
        runCatching { readinessCallback?.invoke() }
        callbacks.forEach { callback -> runCatching(callback) }
    }

    private fun currentResumedLocked(): FragmentActivity? = order.asReversed()
        .asSequence()
        .map(Entry::activity)
        .firstOrNull { activity ->
            !activity.isDestroyed && !activity.isFinishing &&
                activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
}
