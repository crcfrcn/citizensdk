@file:kotlin.jvm.JvmSynthetic
package org.citizen.sdk.internal
import android.content.Context
import org.citizen.sdk.*
/** 唯一JNI声明；业务直接由CitizenSdk调用Core，不携带业务转发方法。 */
internal object Bindings {

        init { System.loadLibrary("citizensdk_jni") }



        // 中文注释：类本身仍是SDK内部实现；这些@JvmStatic JNI成员必须使用JVM public名称，
        // 否则Kotlin会给internal成员追加模块后缀，破坏C++ RegisterNatives唯一准确表。
        @JvmStatic
        external fun validateModules(modules: Int)

        @JvmStatic
        external fun verifySignature(accountId: ByteArray, signature: ByteArray, message: ByteArray): Boolean

        @JvmStatic
        external fun storeGeneration(host: CitizenSdkHostServices, action: Int, index: Int, generation: ByteArray, operation: ByteArray): Boolean

        @JvmStatic
        external fun storeGenerations(host: CitizenSdkHostServices): ByteArray

        @JvmStatic
        external fun encodeSigningPayload(kind: Int, fields: ByteArray, payload: ByteArray): ByteArray

        @JvmStatic
        external fun completeVaultStatus(nativeBridge: Long, hostOperationId: Long, errorCode: Int)

    @JvmStatic external fun nativeDetachFfi(bridge: Long)
    @JvmStatic external fun nativeCoreHandle(bridge: Long): Long
    @JvmStatic external fun nativeCreate(
        context: Context,
        hostServices: CitizenSdkHostServices,
        manifest: ByteArray,
        chainSpec: ByteArray,
        lightSyncState: ByteArray,
        modules: Int,
    ): Long
    @JvmStatic external fun nativeBind(bridge: Long, owner: CitizenSdk)
    @JvmStatic external fun nativeLifecycle(bridge: Long): Int
    @JvmStatic external fun nativeCapabilities(bridge: Long): CitizenSdkCapabilities
    @JvmStatic external fun nativeRefreshCapabilities(bridge: Long): Long
    @JvmStatic external fun nativeStart(bridge: Long): Long
    @JvmStatic external fun nativeAcceptRequestSequence(bridge: Long, sequence: Long)
    @JvmStatic external fun nativeStop(bridge: Long): Long
    @JvmStatic external fun nativeCancel(bridge: Long, coreRequestId: Long): Boolean
    @JvmStatic external fun nativeGetFinalizedHead(bridge: Long): Long
    @JvmStatic external fun nativeGetSyncStatus(bridge: Long): Long
    @JvmStatic external fun nativeGetBestHead(bridge: Long): Long
    @JvmStatic external fun nativeGetFinalizedBlockAt(bridge: Long, number: Long): Long
    @JvmStatic external fun nativeResolveFinalizedBlock(bridge: Long, hash: ByteArray, number: Long): Long
    @JvmStatic external fun nativeGetBlockHeader(bridge: Long, hash: ByteArray, number: Long, finality: Int): Long
    @JvmStatic external fun nativeGetBlockBody(bridge: Long, hash: ByteArray, number: Long, finality: Int): Long
    @JvmStatic external fun nativeGetRuntimeContext(bridge: Long, hash: ByteArray, number: Long, finality: Int): Long
    @JvmStatic external fun nativeGetStorage(bridge: Long, hash: ByteArray, number: Long, finality: Int, key: ByteArray): Long
    @JvmStatic external fun nativeGetStorageBatch(bridge: Long, hash: ByteArray, number: Long, finality: Int, keys: Array<ByteArray>): Long
    @JvmStatic external fun nativeGetStorageKeysPaged(bridge: Long, hash: ByteArray, number: Long, finality: Int, prefix: ByteArray, startKey: ByteArray?, limit: Int): Long
    @JvmStatic external fun nativeCallRuntimeApi(bridge: Long, hash: ByteArray, number: Long, finality: Int, method: ByteArray, arguments: ByteArray): Long
    @JvmStatic external fun nativeGetSystemEvents(bridge: Long, hash: ByteArray, number: Long, finality: Int): Long
    @JvmStatic external fun nativeExportState(bridge: Long): Long
    @JvmStatic external fun nativeImportState(bridge: Long, formatVersion: Int, hash: ByteArray, number: Long, finality: Int, database: ByteArray): Long
    @JvmStatic external fun nativeGetGenesisHash(bridge: Long): ByteArray
    @JvmStatic external fun nativeGetAccountBalance(bridge: Long, accountId: ByteArray): Long
    @JvmStatic external fun nativeGetAccountBalances(bridge: Long, accountIds: ByteArray, count: Int): Long
    @JvmStatic external fun nativeGetAccountNonce(bridge: Long, accountId: ByteArray): Long
    @JvmStatic external fun nativeGetFeeSnapshot(bridge: Long): Long
    @JvmStatic external fun nativeGetWalletProfile(bridge: Long): Long
    @JvmStatic external fun nativeGetWalletState(bridge: Long): Long
    @JvmStatic external fun nativeInspectWallets(bridge: Long): Long
    @JvmStatic external fun nativeChangeDiagnostic(bridge: Long, token: Long, index: Long, action: Int, name: ByteArray?): Long
    @JvmStatic external fun nativeReleaseWalletInspection(bridge: Long, token: Long)
    @JvmStatic external fun nativeImportColdAccountId(bridge: Long, accountId: ByteArray, name: ByteArray): Long
    @JvmStatic external fun nativeImportColdAccountSs58(bridge: Long, address: ByteArray, name: ByteArray): Long
    @JvmStatic external fun nativeReorderWalletAccounts(bridge: Long, expectedRevision: Long, accountIds: ByteArray, count: Int): Long
    @JvmStatic external fun nativeSetActiveWallet(bridge: Long, revision: Long, walletIndex: Long): Long
    @JvmStatic external fun nativeRenameWallet(bridge: Long, revision: Long, walletIndex: Long, name: ByteArray): Long
    @JvmStatic external fun nativeRenameAccount(bridge: Long, accountId: ByteArray, name: ByteArray): Long
    @JvmStatic external fun nativeDeleteAccount(bridge: Long, accountId: ByteArray): Long
    @JvmStatic external fun nativeOpenPrivateKeyView(bridge: Long, accountId: ByteArray, buffer: CitizenSdkPrivateKeyReceiver): LongArray
    @JvmStatic external fun nativeRevealPrivateKeyView(bridge: Long, viewId: Long)
    @JvmStatic external fun nativeCancelPrivateKeyView(bridge: Long, viewId: Long)
    @JvmStatic external fun nativeFinishPrivateKeyView(bridge: Long, viewId: Long)
    @JvmStatic external fun nativeReleasePrivateKeyViewContext(context: Long)
    @JvmStatic external fun nativeSetActiveWalletAccount(bridge: Long, accountId: ByteArray): Long
    @JvmStatic external fun nativeRenameWalletAccount(bridge: Long, accountId: ByteArray, name: ByteArray): Long
    @JvmStatic external fun nativeDeleteWalletAccount(bridge: Long, accountId: ByteArray): Long
    @JvmStatic external fun nativeDeleteWallet(bridge: Long): Long
    @JvmStatic external fun nativeSignAndDeleteWallet(bridge: Long): Long
    @JvmStatic external fun nativeReconcileWalletCleanup(bridge: Long): Long
    @JvmStatic external fun nativeSignWalletPayload(bridge: Long, accountId: ByteArray, message: ByteArray): Long
    @JvmStatic external fun nativeBeginSigning(
        bridge: Long,
        accountId: ByteArray,
        payload: ByteArray,
        transform: Int,
        domain: ByteArray,
        externalSignerTransport: Int,
        opaqueAction: Int,
        ttlSeconds: Long,
    ): Long
    @JvmStatic external fun nativeConsumeExternalSignature(
        bridge: Long,
        sessionId: ByteArray,
        response: ByteArray,
    ): Long
    @JvmStatic external fun nativeCancelSigningSession(bridge: Long, sessionId: ByteArray): Boolean
    @JvmStatic external fun nativeBeginDefaultAccountChange(
        bridge: Long,
        expectedRevision: Long,
        accountIds: ByteArray,
        count: Int,
        ttlSeconds: Long,
    ): Long
    @JvmStatic external fun nativeConsumeDefaultAccountChange(
        bridge: Long,
        sessionId: ByteArray,
        response: ByteArray,
    ): Long
    @JvmStatic external fun nativeQrParse(bridge: Long, text: ByteArray): ByteArray
    @JvmStatic external fun nativeQrEncodeDocument(bridge: Long, input: ByteArray): ByteArray
    @JvmStatic external fun nativeQrPrepareAccountAuthorization(bridge: Long, action: Int, payload: ByteArray, accountId: ByteArray): ByteArray
    @JvmStatic external fun nativeQrCreateSignRequest(bridge: Long, action: Int, accountId: ByteArray, payload: ByteArray, ttl: Long): ByteArray
    @JvmStatic external fun nativeReviewQrSignRequest(bridge: Long, text: ByteArray): Long
    @JvmStatic external fun nativeSignQrRequest(bridge: Long, token: Long): Long
    @JvmStatic external fun nativeReleaseQrReview(bridge: Long, token: Long)
    @JvmStatic external fun nativeQrValidateSignResponse(bridge: Long, sessionId: ByteArray, response: ByteArray)
    @JvmStatic external fun nativeQrConsumeSignResponse(bridge: Long, text: ByteArray): ByteArray
    @JvmStatic external fun nativeQrCancelSignRequest(bridge: Long, requestId: ByteArray): Boolean
    @JvmStatic external fun nativeQrEncodeAccountId(bridge: Long, accountId: ByteArray): ByteArray
    @JvmStatic external fun nativeQrDecodeLuminance(bridge: Long, data: ByteArray, width: Int, height: Int, rowStride: Int, all: Boolean): ByteArray
    @JvmStatic external fun nativeQrEncode(bridge: Long, text: ByteArray, scale: Int): ByteArray
    @JvmStatic external fun nativePrepareTransaction(
        bridge: Long,
        source: ByteArray,
        callData: ByteArray,
    ): Long
    @JvmStatic external fun nativeReleasePreparedTransaction(bridge: Long, token: Long)
    @JvmStatic external fun nativeExecutePreparedTransaction(bridge: Long, token: Long): Long
    @JvmStatic external fun nativeConsumePreparedTransactionQrResponse(
        bridge: Long, executionId: ByteArray, response: ByteArray,
    ): Long
    @JvmStatic external fun nativeCancelPreparedTransactionExecution(bridge: Long, executionId: ByteArray)
    @JvmStatic external fun nativeGetTransactionHistory(bridge: Long, beforeExecutionId: ByteArray?, limit: Int): Long
    @JvmStatic external fun nativeSyncTransactionHistory(bridge: Long): Long
    @JvmStatic external fun nativePrepareWalletCreation(bridge: Long, wordCount: Int, password: ByteArray): Long
    @JvmStatic external fun nativeValidateWalletInput(kind: Int, input: ByteArray, wordCount: Int): IntArray
    @JvmStatic external fun nativeWalletWordSuggestions(prefix: ByteArray): ByteArray
    @JvmStatic external fun nativeImportWallet(bridge: Long, mnemonic: ByteArray, password: ByteArray): Long
    @JvmStatic external fun nativeAddWalletAccounts(
        bridge: Long,
        mnemonic: ByteArray,
        password: ByteArray,
        indices: IntArray,
    ): Long
    @JvmStatic external fun nativeCopyPreparedMnemonic(bridge: Long, token: Long): ByteArray
    @JvmStatic external fun nativeAddNextWalletAccount(bridge: Long, mnemonic: ByteArray, password: ByteArray): Long
    @JvmStatic external fun nativeCommitPreparedWallet(bridge: Long, token: Long): Long
    @JvmStatic external fun nativeReleasePreparedWallet(bridge: Long, token: Long)
    @JvmStatic external fun nativeDestroy(bridge: Long)
    @JvmStatic external fun nativeReadResult(bridge:Long,result:Long):Any?
    @JvmStatic external fun nativeReleaseCompletion(bridge:Long,result:Long,keep:Boolean)

}


/** 唯一 native 调用/销毁准入状态。失败后保持 closing，只允许精确重试销毁。 */
internal class CitizenSdkCalls {
    private val gate = Any()
    private var active = 0
    private var closing = false
    private var destroying = false
    private var closed = false

    fun isClosed(): Boolean = synchronized(gate) { closed }

    fun <T> call(body: () -> T): T {
        synchronized(gate) {
            check(!closing && !closed) { "CitizenSDK native bridge is closing or closed" }
            active += 1
        }
        try { return body() }
        finally { synchronized(gate) { active -= 1 } }
    }

    fun close(destroy: () -> Unit) {
        synchronized(gate) {
            if (closed) return
            if (destroying || active != 0) throw CitizenSdkException(
                CitizenSdkErrorCode.BUSY, "CitizenSDK native call or close is active",
            )
            closing = true
            destroying = true
        }
        try {
            // 禁止在 gate 内等待 callback-clear：回调可能同步重入 call/close。
            destroy()
            synchronized(gate) { closed = true }
        } finally {
            synchronized(gate) { destroying = false }
        }
    }
}
