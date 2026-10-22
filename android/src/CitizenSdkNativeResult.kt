@file:kotlin.jvm.JvmSynthetic

package org.citizen.sdk.internal

import org.citizen.sdk.CitizenAccountBalance
import org.citizen.sdk.CitizenAccountNonce
import org.citizen.sdk.CitizenBlockRef
import org.citizen.sdk.CitizenBlockBody
import org.citizen.sdk.CitizenBlockHeader
import org.citizen.sdk.CitizenChainState
import org.citizen.sdk.CitizenChainSyncStatus
import org.citizen.sdk.CitizenRuntimeContext
import org.citizen.sdk.CitizenFeeSnapshot
import org.citizen.sdk.CitizenSignature
import org.citizen.sdk.CitizenSigningOutcome
import org.citizen.sdk.CitizenDefaultAccountChangeOutcome
import org.citizen.sdk.CitizenTransactionHistoryPage
import org.citizen.sdk.CitizenWalletAccount
import org.citizen.sdk.CitizenWalletProfile
import org.citizen.sdk.CitizenWalletState
import org.citizen.sdk.CitizenPreparedTransaction
import org.citizen.sdk.CitizenTransactionExecution

/** JNI 完成结果的内部闭集；只承载原生结果到公开 Kotlin 模型的投影，不形成第二套业务接口。 */
internal sealed class CitizenSdkNativeResult {
    data object Empty : CitizenSdkNativeResult()
    class Block(val value: CitizenBlockRef) : CitizenSdkNativeResult()
    class Balance(val value: CitizenAccountBalance) : CitizenSdkNativeResult()
    class Balances(val value: List<CitizenAccountBalance>) : CitizenSdkNativeResult()
    class Nonce(val value: CitizenAccountNonce) : CitizenSdkNativeResult()
    class Fee(val value: CitizenFeeSnapshot) : CitizenSdkNativeResult()
    class Profile(val value: CitizenWalletProfile?) : CitizenSdkNativeResult()
    class Accounts(val value: List<CitizenWalletAccount>) : CitizenSdkNativeResult()
    class Signature(val value: CitizenSignature) : CitizenSdkNativeResult()
    class Prepared(@get:JvmSynthetic val token: Long) : CitizenSdkNativeResult()
    class TransactionHistoryPage(val value: CitizenTransactionHistoryPage) : CitizenSdkNativeResult()
    class QrReview(val token: Long, val json: String) : CitizenSdkNativeResult()
    class QrSigned(val value: org.citizen.sdk.CitizenQrDocument) : CitizenSdkNativeResult()
    class WalletState(val value: CitizenWalletState, val inspectionToken: Long = 0) : CitizenSdkNativeResult()
    class SigningOutcome(val value: CitizenSigningOutcome) : CitizenSdkNativeResult()
    class DefaultAccountChange(val value: CitizenDefaultAccountChangeOutcome) : CitizenSdkNativeResult()
    class SyncStatus(val value: CitizenChainSyncStatus) : CitizenSdkNativeResult()
    class BlockHeader(val value: CitizenBlockHeader) : CitizenSdkNativeResult()
    class BlockBody(val value: CitizenBlockBody) : CitizenSdkNativeResult()
    class PreparedTransaction(
        val token: Long,
        val value: CitizenPreparedTransaction,
    ) : CitizenSdkNativeResult()
    class TransactionExecution(val value: CitizenTransactionExecution) : CitizenSdkNativeResult()
    class RuntimeContext(val value: CitizenRuntimeContext) : CitizenSdkNativeResult()
    class Storage(val value: ByteArray?) : CitizenSdkNativeResult()
    class StorageBatch(val value: List<ByteArray?>) : CitizenSdkNativeResult()
    class ChainState(val value: CitizenChainState) : CitizenSdkNativeResult()
}
