//! Generic, application-neutral transaction preparation and instance registry.
//!
//! The application supplies one opaque SCALE RuntimeCall. CitizenSDK binds it to one exact best
//! block, runtime, nonce and signed-extension layout. Signer messages and extrinsic templates stay
//! inside the Engine and are consumed only by the later signing/submission closure.

use std::collections::HashMap;

use crate::types::AccountId32;
use crate::types::AccountNonce;
use crate::types::AccountNonceSource;
use crate::types::ChainIdentity;

use crate::types::AccountPublicKey;
use crate::types::AccountSignature;
use crate::types::ContractErrorCode;
use crate::types::Hash32;
use crate::types::ImmortalSigningPayload;
use crate::types::OpaqueTransactionCall;
use crate::types::PreparedTransactionSummary;
use crate::types::RuntimeContext;
use crate::types::SignedExtrinsic;
use crate::types::SignedTransactionBuild;
use crate::types::SigningIntent;
use crate::types::SigningTransform;
use crate::types::TransactionExecutionRecord;
use crate::types::TransactionPreparationId;
use crate::types::VerifiedChainClient;
use crate::types::MAX_PREPARED_TRANSACTIONS;
use subxt_core::ext::codec::Compact;
use subxt_core::ext::codec::{Decode, Encode};
use zeroize::Zeroize;
use zeroize::Zeroizing;

use crate::account_state::verified_identity;
use crate::account_state::verified_runtime_context;
use crate::error::EngineError;
use crate::metadata::signed_extension_identifiers;
use crate::metadata::validate_opaque_runtime_call;
use crate::system_events::decode_metadata_strict;

/// Engine-owned material that must never be projected into language bindings.
pub(crate) struct PreparedTransaction {
    summary: PreparedTransactionSummary,
    identity: ChainIdentity,
    runtime_context: RuntimeContext,
    nonce: AccountNonce,
    call_data: Zeroizing<Vec<u8>>,
    full_signing_payload: Zeroizing<Vec<u8>>,
    extension_bytes: Vec<u8>,
    pq_registered: bool,
    signed_extensions: Vec<String>,
    generation: u64,
}

impl core::fmt::Debug for PreparedTransaction {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("PreparedTransaction")
            .field("summary", &self.summary)
            .field("signed_extensions", &self.signed_extensions)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl PreparedTransaction {
    pub(crate) const fn summary(&self) -> PreparedTransactionSummary {
        self.summary
    }

    pub(crate) const fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn external_action(&self) -> Result<u16, EngineError> {
        let indices = self.call_data.get(..2).ok_or_else(|| {
            EngineError::contract(
                ContractErrorCode::Integrity,
                "RuntimeCall 缺少 pallet/call 索引",
            )
        })?;
        Ok(u16::from_be_bytes([indices[0], indices[1]]))
    }

    pub(crate) fn signing_intent(&self) -> Result<SigningIntent, EngineError> {
        Ok(SigningIntent::try_new(
            self.summary.source_account_id(),
            self.full_signing_payload.to_vec(),
            SigningTransform::SubstrateSigningPayload,
        )?)
    }

    pub(crate) fn call_data(&self) -> &[u8] {
        &self.call_data
    }
    /// 在签名器确定使用 sr 或 PQ 前，预留足够的交易历史容量。
    pub(crate) fn signed_extrinsic_len(&self) -> usize {
        self.call_data.len()
            + self.extension_bytes.len()
            + mldsa::PUBLIC_KEY_BYTES
            + mldsa::SIGNATURE_BYTES
            + 40
    }
    pub(crate) const fn identity(&self) -> &ChainIdentity {
        &self.identity
    }
    pub(crate) const fn runtime_context(&self) -> &RuntimeContext {
        &self.runtime_context
    }
    pub(crate) const fn nonce(&self) -> AccountNonce {
        self.nonce
    }

    /// 核对签名账户与冻结消息后，完成热签或冷签交易组装。
    pub(crate) fn complete_with_signature(
        self,

        signature: AccountSignature,
    ) -> Result<SignedTransactionBuild, EngineError> {
        let signer_account_id = self.summary.source_account_id();
        let message = crate::types::signing_message_for_account(
            self.summary.source_account_id(),
            &self.full_signing_payload,
            &SigningTransform::SubstrateSigningPayload,
            signature.algorithm(),
        )?;
        if !crate::sign::verify(signer_account_id, &message, signature.clone())? {
            return Err(EngineError::contract(
                ContractErrorCode::Integrity,
                "transaction signature 与冻结 signer message/source 不一致",
            ));
        }
        self.finish(signature)
    }

    fn finish(self, signature: AccountSignature) -> Result<SignedTransactionBuild, EngineError> {
        let account = self.summary.source_account_id().into_bytes();
        let message = crate::types::signing_message_for_account(
            self.summary.source_account_id(),
            &self.full_signing_payload,
            &SigningTransform::SubstrateSigningPayload,
            signature.algorithm(),
        )?;
        let proof = match &signature {
            AccountSignature::Sr25519(value) => mldsa::Proof::Sr25519 {
                account,
                signature: *value.as_bytes(),
            },
            AccountSignature::Mldsa65(value) => {
                mldsa::transaction_proof(account, &value.0, &value.1, self.pq_registered)
            }
        };
        let encoded = mldsa::encode_transaction(&proof, &self.extension_bytes, &self.call_data);
        let extrinsic = SignedExtrinsic::try_new(encoded)?;
        let signer_public_key = match &signature {
            AccountSignature::Sr25519(_) => AccountPublicKey::Sr25519(account),
            AccountSignature::Mldsa65(value) => AccountPublicKey::from(value.0.clone()),
        };
        let payload = ImmortalSigningPayload::try_new(
            &self.identity,
            &self.runtime_context,
            self.nonce,
            self.summary.source_account_id(),
            signer_public_key,
            self.call_data.to_vec(),
            message,
        )?;
        Ok(SignedTransactionBuild::new(payload, signature, extrinsic))
    }
}

impl Drop for PreparedTransaction {
    fn drop(&mut self) {
        self.signed_extensions.zeroize();
    }
}

#[derive(Debug, Default)]
pub(crate) struct PreparedTransactionRegistry {
    sources: HashMap<AccountId32, TransactionPreparationId>,
    entries: HashMap<TransactionPreparationId, PreparedTransaction>,
}

impl PreparedTransactionRegistry {
    pub(crate) fn reserve(
        &mut self,
        source: AccountId32,
    ) -> Result<TransactionPreparationId, EngineError> {
        if self.sources.contains_key(&source) {
            return Err(EngineError::contract(
                ContractErrorCode::Conflict,
                "同一 source 已有在途或可消费的 transaction preparation",
            ));
        }
        if self.sources.len() >= MAX_PREPARED_TRANSACTIONS {
            return Err(EngineError::contract(
                ContractErrorCode::Conflict,
                "transaction preparation registry 已达到 256 项上限",
            ));
        }
        for _ in 0..32 {
            let mut bytes = [0_u8; 16];
            getrandom::fill(&mut bytes).map_err(|_| {
                EngineError::contract(
                    ContractErrorCode::Unavailable,
                    "操作系统随机源无法生成 transaction preparation id",
                )
            })?;
            let Ok(id) = TransactionPreparationId::try_new(bytes) else {
                continue;
            };
            if !self.entries.contains_key(&id) && !self.sources.values().any(|value| *value == id) {
                self.sources.insert(source, id);
                return Ok(id);
            }
        }
        Err(EngineError::contract(
            ContractErrorCode::Internal,
            "transaction preparation id 随机碰撞次数超限",
        ))
    }

    pub(crate) fn commit(
        &mut self,
        source: AccountId32,
        id: TransactionPreparationId,
        prepared: PreparedTransaction,
    ) -> Result<PreparedTransactionSummary, EngineError> {
        if self.sources.get(&source) != Some(&id)
            || prepared.summary().preparation_id() != id
            || prepared.summary().source_account_id() != source
        {
            return Err(EngineError::contract(
                ContractErrorCode::Conflict,
                "transaction preparation reservation 已失效",
            ));
        }
        let summary = prepared.summary();
        if self.entries.insert(id, prepared).is_some() {
            return Err(EngineError::contract(
                ContractErrorCode::Internal,
                "transaction preparation id 发生 registry 冲突",
            ));
        }
        Ok(summary)
    }

    pub(crate) fn cancel(&mut self, id: TransactionPreparationId) -> Option<PreparedTransaction> {
        let source = self
            .sources
            .iter()
            .find_map(|(source, candidate)| (*candidate == id).then_some(*source));
        if let Some(source) = source {
            self.sources.remove(&source);
        }
        self.entries.remove(&id)
    }

    /// Move the only prepared value into execution while keeping its source single-flight gate.
    pub(crate) fn claim(&mut self, id: TransactionPreparationId) -> Option<PreparedTransaction> {
        self.entries.remove(&id)
    }

    pub(crate) fn finish(&mut self, source: AccountId32, id: TransactionPreparationId) {
        if self.sources.get(&source) == Some(&id) {
            self.sources.remove(&source);
        }
    }

    pub(crate) fn release_reservation(
        &mut self,
        source: AccountId32,
        id: TransactionPreparationId,
    ) {
        if self.sources.get(&source) == Some(&id) && !self.entries.contains_key(&id) {
            self.sources.remove(&source);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.sources.clear();
    }
}

/// Build one exact, unsigned transaction preparation without touching any wallet secret.
pub(crate) async fn build_prepared_transaction(
    chain_client: &dyn VerifiedChainClient,
    nonce_source: &dyn AccountNonceSource,
    preparation_id: TransactionPreparationId,
    generation: u64,
    source_account_id: AccountId32,
    call: OpaqueTransactionCall,
) -> Result<PreparedTransaction, EngineError> {
    let preparation_span = crate::transaction_diagnostic::Span::start("prepare_build");
    let identity = verified_identity(chain_client).await?;
    let best_span = crate::transaction_diagnostic::Span::start("prepare_best");
    let best = chain_client.get_best_head().await?;
    best_span.finish();
    let runtime_span = crate::transaction_diagnostic::Span::start("prepare_runtime");
    let runtime_context = verified_runtime_context(chain_client, best).await?;
    runtime_span.finish();
    let metadata_span = crate::transaction_diagnostic::Span::start("prepare_metadata_decode");
    let metadata = decode_metadata_strict(runtime_context.metadata())?;
    validate_opaque_runtime_call(&metadata, &call)?;
    metadata_span.finish();

    let nonce_span = crate::transaction_diagnostic::Span::start("prepare_nonce");
    let nonce = nonce_source
        .account_next_index(source_account_id, best)
        .await?;
    nonce_span.finish();
    if nonce.account_id() != source_account_id || nonce.best_block() != best {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "AccountNonceSource 返回了不同账户或不同 best 块的 nonce",
        ));
    }
    let full_metadata = &metadata;
    crate::metadata::native_extensions(&metadata)?;
    let address = subxt_core::dynamic::storage(
        "Mldsa",
        "PqPublicKey",
        vec![subxt_core::dynamic::Value::from_bytes(
            source_account_id.as_bytes(),
        )],
    );
    let key = subxt_core::storage::get_address_bytes(&address, full_metadata)
        .map_err(|e| EngineError::InvalidMetadata(e.to_string()))?;
    let finalized = chain_client.get_finalized_head().await?;
    let pq_registered = chain_client
        .get_finalized_storage_at(finalized, key)
        .await?
        .is_some();
    let extensions = signed_extension_identifiers(&metadata);
    let (extension_bytes, implicit) = crate::metadata::native_extension_bytes(
        &metadata,
        identity.genesis_hash().into_bytes(),
        runtime_context.version().spec_version(),
        runtime_context.version().transaction_version(),
        nonce.value(),
    )?;
    let mut full_signing_payload = call.as_bytes().to_vec();
    full_signing_payload.extend_from_slice(&extension_bytes);
    full_signing_payload.extend_from_slice(&implicit);
    let summary = PreparedTransactionSummary::try_new(
        preparation_id,
        source_account_id,
        call.hash()?,
        best,
        runtime_context.version(),
        nonce.value(),
    )?;
    let prepared = PreparedTransaction {
        summary,
        identity,
        runtime_context,
        nonce,
        call_data: Zeroizing::new(call.into_bytes()),
        full_signing_payload: Zeroizing::new(full_signing_payload),
        extension_bytes,
        pq_registered,
        signed_extensions: extensions,
        generation,
    };
    preparation_span.finish();
    Ok(prepared)
}

/// Reconstruct a persisted generic authorization from its opaque call and exact current runtime.
///
/// Recovery never signs again. This check proves that the stored account, call, nonce, runtime,
/// signature and complete encoded extrinsic are the same bytes originally authorized before the
/// caller is allowed to resubmit those bytes.
pub(crate) async fn validate_persisted_transaction_execution(
    record: &TransactionExecutionRecord,
    identity: &ChainIdentity,
    runtime_context: &RuntimeContext,
    chain: &dyn VerifiedChainClient,
) -> Result<(), EngineError> {
    if identity.genesis_hash() != record.genesis_hash()
        || runtime_context.version() != record.runtime_version()
        || record.call_data_hash()
            != Hash32::from_bytes(crate::types::blake2_256(record.call_data())?)
    {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "通用交易恢复的 chain/runtime/callData 身份不一致",
        ));
    }
    let metadata = decode_metadata_strict(runtime_context.metadata())?;
    validate_opaque_runtime_call(
        &metadata,
        &OpaqueTransactionCall::try_new(record.call_data().to_vec())?,
    )?;
    let (explicit, implicit) = crate::metadata::native_extension_bytes(
        &metadata,
        identity.genesis_hash().into_bytes(),
        runtime_context.version().spec_version(),
        runtime_context.version().transaction_version(),
        record.nonce(),
    )?;
    let mut body = record.signed_extrinsic().as_bytes();
    let declared = Compact::<u32>::decode(&mut body)
        .map_err(|e| EngineError::InvalidMetadata(e.to_string()))?
        .0 as usize;
    if declared != body.len() || !body.starts_with(&[0x45, mldsa::EXTENSION_VERSION]) {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "恢复交易不符合唯一 V5 合同",
        ));
    }
    let proof = mldsa::Proof::decode(&mut &body[2..])
        .map_err(|e| EngineError::InvalidMetadata(e.to_string()))?;
    let account = record.account_id().into_bytes();
    let implication = mldsa::transaction_implication(record.call_data(), &explicit, &implicit);
    let message = mldsa::transaction_message(&account, &implication);
    let valid = match &proof {
        mldsa::Proof::Sr25519 {
            account: signer,
            signature,
        } => {
            *signer == account
                && crate::sign::verify(
                    record.account_id(),
                    &message,
                    AccountSignature::from_bytes(*signature),
                )?
        }
        mldsa::Proof::First {
            account: signer,
            public,
            signature,
        } => {
            *signer == account
                && mldsa::verify_account_signature(&account, public, &message, signature)
        }
        mldsa::Proof::Stored {
            account: signer,
            signature,
        } => {
            let address = subxt_core::dynamic::storage(
                "Mldsa",
                "PqPublicKey",
                vec![subxt_core::dynamic::Value::from_bytes(account)],
            );
            let key = subxt_core::storage::get_address_bytes(&address, &metadata)
                .map_err(|e| EngineError::InvalidMetadata(e.to_string()))?;
            let bytes = chain
                .get_storage_at(runtime_context.block(), key)
                .await?
                .ok_or_else(|| {
                    EngineError::contract(ContractErrorCode::Integrity, "缺少已登记 PQ 公钥")
                })?;
            let mut remaining = bytes.as_slice();
            let public = mldsa::PublicKey::decode(&mut remaining)
                .map_err(|e| EngineError::InvalidMetadata(e.to_string()))?;
            remaining.is_empty()
                && *signer == account
                && mldsa::verify_account_signature(&account, &public, &message, signature)
        }
    };
    if !valid
        || mldsa::encode_transaction(&proof, &explicit, record.call_data())
            != record.signed_extrinsic().as_bytes()
    {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "恢复交易的账户、调用、nonce 或签名不一致",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/prepare.rs"]
mod tests;
