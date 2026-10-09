package org.citizen.sdk

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class CitizenSdkNativeAbiTest {
    @Test
    fun qrOnlyRoundTripUsesRustAfterZxingWithoutOpeningChainOrWallet() {
        val sdk = CitizenSdk.open(ApplicationProvider.getApplicationContext(), modules = CitizenSdkModules.QR)
        try {
            val account = ByteArray(32) { 7 }
            val text = sdk.qrEncodeAccountId(account)
            val parsed = sdk.qrParse(text)
            assertEquals(5, parsed.kind)
            assertEquals(CitizenQrDocument.Content.AccountId("0x" + "07".repeat(32)), parsed.content)
            val image = sdk.qrEncode(text)
            assertEquals(text, sdk.qrDecodeLuminance(image.luminance(), image.width, image.height, image.width).canonicalText)
            assertEquals(CitizenSdkLifecycle.CREATED, sdk.lifecycle)
            assertEquals(CitizenSdkErrorCode.UNSUPPORTED, assertThrows(CitizenSdkException::class.java) { sdk.getGenesisHash() }.code)
        } finally { closeAfterCallbacks(sdk) }
    }

    @Test
    fun createdChainEmptyBatchCompletesWithNotReadyBeforeSafeClose() {
        val sdk = CitizenSdk.open(ApplicationProvider.getApplicationContext(), modules = CitizenSdkModules.CHAIN)
        var request: CompletableFuture<List<CitizenAccountBalance>>? = null
        try {
            assertEquals(CitizenSdkLifecycle.CREATED, sdk.lifecycle)
            // 调用真实 JNI/Core 路径；空列表必须返回异步 NOT_READY，不能直接成功。
            val accepted = sdk.getAccountBalances(emptyList())
            request = accepted
            val failure = assertThrows(ExecutionException::class.java) {
                accepted.get(5, TimeUnit.SECONDS)
            }
            assertEquals(CitizenSdkErrorCode.NOT_READY, (failure.cause as? CitizenSdkException)?.code)
            assertEquals(CitizenSdkLifecycle.CREATED, sdk.lifecycle)
        } finally {
            // 不取消或伪造终态；先排空已接受请求，JNI 已释放结果后才关闭宿主。
            request?.handle { _, _ -> null }?.join()
            closeAfterCallbacks(sdk)
        }
        assertEquals(CitizenSdkLifecycle.DISPOSED, sdk.lifecycle)
    }

    private fun closeAfterCallbacks(sdk: CitizenSdk) {
        repeat(500) {
            try {
                sdk.close()
                return
            } catch (failure: CitizenSdkException) {
                if (failure.code != CitizenSdkErrorCode.BUSY) throw failure
                Thread.sleep(10)
            }
        }
        sdk.close()
    }

    @Test
    fun selectedChainExposesGenesisBeforeStartWhileNonChainModulesRejectIt() {
        val chain = CitizenSdk.open(ApplicationProvider.getApplicationContext(), modules = CitizenSdkModules.CHAIN)
        try {
            val genesis = chain.getGenesisHash()
            assertEquals(32, genesis.size)
            assertArrayEquals(genesis, chain.getGenesisHash())
            assertEquals(CitizenSdkLifecycle.CREATED, chain.lifecycle)
        } finally { chain.close() }
        val signing = CitizenSdk.open(ApplicationProvider.getApplicationContext(), modules = CitizenSdkModules.SIGNING)
        try {
            assertEquals(CitizenSdkErrorCode.UNSUPPORTED, assertThrows(CitizenSdkException::class.java) {
                signing.getGenesisHash()
            }.code)
        } finally { signing.close() }
    }

    @Test
    fun coreRejectsInvalidModuleSelectionBeforeCreatingAndroidResources() {
        for (modules in listOf(0, 64, CitizenSdkModules.TRANSACTIONS, CitizenSdkModules.HISTORY, -1)) {
            assertThrows(CitizenSdkException::class.java) {
                CitizenSdk.open(ApplicationProvider.getApplicationContext(), modules = modules)
            }
        }
    }

    @Test
    fun officialAarLoadsAbiVersionOneCore() {
        val sdk = CitizenSdk.open(ApplicationProvider.getApplicationContext())
        assertEquals(CitizenSdkLifecycle.CREATED, sdk.lifecycle)
        sdk.close()
    }
}
