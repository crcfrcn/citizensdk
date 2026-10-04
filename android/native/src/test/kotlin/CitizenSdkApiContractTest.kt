package org.citizen.sdk

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.ByteBuffer
import java.lang.reflect.Modifier
import org.citizen.sdk.internal.CitizenSdkNative

class CitizenSdkApiContractTest {
    @Test
    fun preparationResultOwnsKeysAndOptionalSignature() {
        assertEquals(CitizenSdkOperation::class.java,
            CitizenSdk::class.java.getMethod("prepareApplicationKeys", ByteArray::class.java,
                ByteArray::class.java, List::class.java, ByteArray::class.java).returnType)
        val bytes = ByteBuffer.allocate(20 + 4 + 32 + 4 + 64).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            .putInt(1).putInt(0).putInt(0).putInt(31).putInt(0)
            .putInt(1).put(ByteArray(32) { 7 }).putInt(1).put(ByteArray(64) { 8 }).array()
        val decoded = org.citizen.sdk.internal.CitizenSdkNativeCodec.decode(bytes)
        val value = (decoded.result as org.citizen.sdk.internal.CitizenSdkNativeResult.ApplicationKeyPreparation).value
        assertEquals(32, value.keys.single().size); assertEquals(64, value.signature!!.size)
        value.dispose(); assertTrue(value.keys.single().all { it == 0.toByte() })
    }

    @Test
    fun batchDerivationKeepsOnePublicOperationAndIndexedNativeResult() {
        assertEquals(CitizenSdkOperation::class.java,
            CitizenSdk::class.java.getMethod("deriveApplicationKeys", ByteArray::class.java,
                ByteArray::class.java, List::class.java).returnType)
        val bytes = ByteBuffer.allocate(20 + 4 + 64).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            .putInt(1).putInt(0).putInt(0).putInt(30).putInt(0)
            .putInt(2).put(ByteArray(64) { it.toByte() }).array()
        val decoded = org.citizen.sdk.internal.CitizenSdkNativeCodec.decode(bytes)
        val keys = (decoded.result as org.citizen.sdk.internal.CitizenSdkNativeResult.ApplicationKeys).values
        assertEquals(2, keys.size)
        assertEquals(32, keys[0].size)
        assertEquals(32, keys[1].size)
    }

    @Test
    fun lifecycleEntriesKeepTheSameZeroArgumentVoidFutureContract() {
        // 统一调用路径只删内部屏障，不改变Java/Kotlin公开签名或增加第二入口。
        val type = Class.forName("org.citizen.sdk.CitizenSdk", false, javaClass.classLoader)
        for (name in listOf("start", "stop")) {
            val methods = type.methods.filter { it.name == name }
            assertEquals(1, methods.size)
            val method = methods.single()
            assertEquals(0, method.parameterCount)
            assertEquals(java.util.concurrent.CompletableFuture::class.java, method.returnType)
            val result = method.genericReturnType as java.lang.reflect.ParameterizedType
            assertEquals(listOf(Void::class.java), result.actualTypeArguments.toList())
        }
    }

    @Test
    fun walletCleanupFlagUsesStrictBooleanWireAndRetainsInitializationChecks() {
        // 仅构造无账户、无秘密的JNI结果；实际调用生产解码器，不镜像钱包算法。
        fun encoded(initialization: Int, cleanup: Int): ByteArray =
            ByteBuffer.allocate(51).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                .putInt(1).putInt(0).putInt(0).putInt(21).putInt(0)
                .putLong(0).putLong(1).put(0).putInt(0)
                .putInt(initialization).put(cleanup.toByte()).put(0).putInt(0).array()
        for ((initialization, cleanup) in listOf(0 to 0, 2 to 0, 2 to 1)) {
            val decoded = org.citizen.sdk.internal.CitizenSdkNativeCodec.decode(encoded(initialization, cleanup))
            assertEquals(null, decoded.error)
            val state = (decoded.result as org.citizen.sdk.internal.CitizenSdkNativeResult.WalletState).value
            assertEquals(initialization, state.initializationState)
            assertEquals(cleanup == 1, state.cleanupPending)
            assertTrue(state.accounts.isEmpty() && state.diagnostics.isEmpty())
        }
        // 无钱包不得带待清理事实；Ready不得缺账户/诊断，未知状态和布尔值仍拒绝。
        for ((initialization, cleanup) in listOf(0 to 1, 1 to 0, 3 to 0, -1 to 0, 2 to 2, 2 to 255)) {
            assertEquals(CitizenSdkErrorCode.INTEGRITY, assertThrows(CitizenSdkException::class.java) {
                org.citizen.sdk.internal.CitizenSdkNativeCodec.decode(encoded(initialization, cleanup))
            }.code)
        }
        val valid = encoded(2, 1)
        for (size in listOf(45, 46, 50)) {
            assertEquals(CitizenSdkErrorCode.INTEGRITY, assertThrows(CitizenSdkException::class.java) {
                org.citizen.sdk.internal.CitizenSdkNativeCodec.decode(valid.copyOf(size))
            }.code)
        }
        assertEquals(CitizenSdkErrorCode.INTEGRITY, assertThrows(CitizenSdkException::class.java) {
            org.citizen.sdk.internal.CitizenSdkNativeCodec.decode(valid + byteArrayOf(0))
        }.code)
    }

    @Test
    fun `static JNI entries keep the exact single registration names`() {
        val type = CitizenSdkNative::class.java
        val expected = listOf("validateModules", "verifySignature", "completeVaultStatus")
        val names = type.declaredMethods.map { it.name }
        for (name in expected) {
            assertEquals(1, names.count { it == name })
            assertTrue(names.none { it.startsWith("${name}\$") })
        }
        assertTrue(Modifier.isStatic(type.getDeclaredMethod(
            "validateModules", Int::class.javaPrimitiveType,
        ).modifiers))
        assertTrue(Modifier.isStatic(type.getDeclaredMethod(
            "verifySignature", ByteArray::class.java, ByteArray::class.java, ByteArray::class.java,
        ).modifiers))
        assertTrue(Modifier.isStatic(type.getDeclaredMethod(
            "completeVaultStatus", Long::class.javaPrimitiveType, Long::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        ).modifiers))
    }

    @Test
    fun `native creation passes application context to Android TLS verifier`() {
        // 反射真实 JVM 签名，防止 Kotlin 与 RegisterNatives 的 Context 参数再次漂移。
        assertNotNull(Class.forName(
            "org.rustls.platformverifier.CertificateVerifier", false, javaClass.classLoader,
        ))
        val create = CitizenSdkNative::class.java.getDeclaredMethod(
            "nativeCreate",
            android.content.Context::class.java,
            org.citizen.sdk.internal.CitizenSdkHostServices::class.java,
            ByteArray::class.java, ByteArray::class.java, ByteArray::class.java,
            Int::class.javaPrimitiveType,
        )
        assertTrue(Modifier.isNative(create.modifiers))
        assertEquals(Long::class.javaPrimitiveType, create.returnType)
    }

    @Test
    fun qrReviewAndCaptureExposeDataResourcesWithoutSdkWindows() {
        assertEquals(CitizenSdkOperation::class.java, CitizenSigning::class.java.getMethod("reviewQrRequest", String::class.java).returnType)
        assertEquals(CitizenSdkOperation::class.java, CitizenSigning::class.java.getMethod("signQrRequest", CitizenQrReview::class.java).returnType)
        assertEquals(CitizenQrDocument::class.java, CitizenSdk::class.java.getMethod("qrParse", String::class.java).returnType)
        for (removed in listOf("qrScan", "viewAccountPrivateKey", "initializeWallet", "qrSigningInput", "qrCreateSignResponse", "qrEncodeImage")) {
            assertTrue(CitizenSdk::class.java.methods.none { it.name == removed })
        }
        assertNotNull(CitizenQrSigned::class.java.getMethod("getQrImage"))
        assertEquals(CitizenSdkOperation::class.java, CitizenSdk::class.java.getMethod("inspectWallets").returnType)
    }

    @Test
    fun `private authorization binds exactly one actual host operation and rejects late notification`() {
        val buffer = CitizenSdkPrivateKeyReceiver()
        buffer.bind(7)
        val registered = mutableListOf<Long>()
        buffer.bindAuthenticationRegistry { registered.add(it); CitizenSdkErrorCode.OK.value }
        assertEquals(CitizenSdkErrorCode.INTEGRITY.value, buffer.authorizing(8, 19))
        assertEquals(CitizenSdkErrorCode.INTEGRITY.value, buffer.authorizing(7, 0))
        assertEquals(null, buffer.authenticationId())
        assertEquals(CitizenSdkErrorCode.OK.value, buffer.authorizing(7, 19))
        assertEquals(19L, buffer.authenticationId())
        assertEquals(CitizenSdkErrorCode.INTEGRITY.value, buffer.authorizing(7, 20))
        buffer.clear()
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, buffer.authorizing(7, 21))
        assertEquals(listOf(19L), registered)
    }

    @Test
    fun privateKeyResourcePublicEntryReturnsNoSecretUntilExplicitReveal() {
        val method = CitizenSdk::class.java.getMethod("openPrivateKey", ByteArray::class.java)
        assertEquals(java.util.concurrent.CompletableFuture::class.java, method.returnType)
        assertEquals(1, method.parameterCount)
        assertNotNull(CitizenSdkPrivateKey::class.java.getMethod("reveal"))
        assertNotNull(CitizenSdkPrivateKey::class.java.getMethod("getClosed"))
    }

    @Test
    fun receiverCopiesOnlyOnceWithoutMutatingBorrowedBufferAndClearsOwnedBytes() {
        val buffer = CitizenSdkPrivateKeyReceiver()
        buffer.bind(7)
        val source = ByteBuffer.allocateDirect(32)
        repeat(32) { source.put(it, it.toByte()) }
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, buffer.receive(8, source))
        assertEquals(CitizenSdkErrorCode.INTEGRITY.value, buffer.receive(7, ByteBuffer.allocate(32)))
        assertEquals(CitizenSdkErrorCode.INTEGRITY.value, buffer.receive(7, ByteBuffer.allocateDirect(31)))
        assertEquals(CitizenSdkErrorCode.OK.value, buffer.receive(7, source))
        assertEquals(0, source.position())
        val copied = buffer.copyBytes()
        assertEquals((0..31).map(Int::toByte), copied.toList())
        copied[0] = 99
        assertEquals(0.toByte(), buffer.copyBytes()[0])
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, buffer.receive(7, source))
        buffer.clear()
        assertThrows(IllegalStateException::class.java) { buffer.copyBytes() }
        assertEquals(CitizenSdkErrorCode.CANCELLED.value, buffer.receive(7, source))
        repeat(32) { source.put(it, 0) }
    }

    @Test
    fun `early private settlement retains a no secret notification until the view binds`() {
        val buffer = CitizenSdkPrivateKeyReceiver()
        buffer.settled(9, CitizenSdkErrorCode.NOT_FOUND.value)
        buffer.bind(9)
        var notifications = 0
        buffer.listen { assertEquals(CitizenSdkErrorCode.NOT_FOUND.value, it); notifications += 1 }
        assertEquals(1, notifications)
        buffer.clear()
        assertThrows(IllegalStateException::class.java) { buffer.copyBytes() }
    }
    @Test
    fun `chain facade exposes one genesis and batch balance entry with bounded input`() {
        assertNotNull(CitizenSdk::class.java.getMethod("getGenesisHash"))
        assertNotNull(CitizenSdk::class.java.getMethod("getAccountBalances", List::class.java))
        for (count in listOf(0, 1, 1990)) CitizenSdkInputLimits.requireBalanceAccountCount(count)
        for (count in listOf(-1, 1991)) {
            assertEquals(CitizenSdkErrorCode.INVALID_ARGUMENT, assertThrows(CitizenSdkException::class.java) {
                CitizenSdkInputLimits.requireBalanceAccountCount(count)
            }.code)
        }
    }

    @Test
    fun inspectionResourcesHaveNoJavaSourceNativeHandleGetter() {
        for (type in listOf(CitizenWalletInspection::class.java, CitizenSdkPrivateKey::class.java)) {
            assertTrue(type.methods.filterNot { it.isSynthetic }.none { it.name.contains("handle", ignoreCase = true) })
        }
        assertNotNull(CitizenWalletInspection::class.java.getMethod("getState"))
        assertNotNull(CitizenWalletInspection::class.java.getMethod("release"))
    }

    @Test
    fun `wallet and signing are independent modules with one public signing facade`() {
        assertEquals(listOf(1, 2, 4, 8, 16), listOf(CitizenSdkModules.WALLET,
            CitizenSdkModules.SIGNING, CitizenSdkModules.CHAIN, CitizenSdkModules.TRANSACTIONS,
            CitizenSdkModules.HISTORY))
        assertEquals(63, CitizenSdkModules.FULL)
        assertEquals(0, CitizenSdkModules.WALLET and CitizenSdkModules.SIGNING)
        val names = CitizenSdk::class.java.methods.map { it.name }
        assertTrue("getSigning" in names)
        assertTrue("signWalletPayload" !in names)
        assertNotNull(CitizenSigning::class.java.getMethod("verify", ByteArray::class.java,
            ByteArray::class.java, ByteArray::class.java))
    }

    @Test
    fun `native facade enforces sign and wallet allocation boundaries`() {
        CitizenSdkInputLimits.requireSignPayload(16 * 1024 * 1024)
        CitizenSdkInputLimits.requireSignPayload(0)
        assertEquals(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkInputLimits.requireSignPayload(16 * 1024 * 1024 + 1)
            }.code,
        )
        CitizenSdkInputLimits.requireWalletSecret("mnemonic", 1024)
        assertEquals(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkInputLimits.requireWalletSecret("mnemonic", 1025)
            }.code,
        )
        CitizenSdkInputLimits.requireAddAccountIndices(intArrayOf(1, 1989))
        assertEquals(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkInputLimits.requireAddAccountIndices(IntArray(1990) { 1 })
            }.code,
        )
        assertEquals(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkInputLimits.requireAddAccountIndices(intArrayOf(1, 1))
            }.code,
        )
        CitizenSdkInputLimits.requireWalletAccountNameInput("x".repeat(128))
        assertEquals(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdkInputLimits.requireWalletAccountNameInput("x".repeat(129))
            }.code,
        )
        assertThrows(IllegalArgumentException::class.java) {
            CitizenU128("1".repeat(40))
        }
    }

    @Test
    fun `public facade contains no native handle getter`() {
        val type = Class.forName("org.citizen.sdk.CitizenSdk", false, javaClass.classLoader)
        val names = type.methods.map { it.name }
        assertTrue("start" in names)
        assertTrue("stop" in names)
        assertTrue("getTransactionHistory" in names)
        assertTrue("syncTransactionHistory" in names)
        assertTrue("getStorageKeysPaged" in names)
        assertTrue("callRuntimeApi" in names)
        assertTrue("deriveApplicationKey" in names)
        assertTrue(names.none { it.contains("transferWithRemark", ignoreCase = true) })
        assertTrue(names.none { it.contains("handle", ignoreCase = true) })
        assertNotNull(CitizenSdkOperation::class.java.getMethod("cancel"))
    }
}
