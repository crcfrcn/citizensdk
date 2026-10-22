//! Generic, application-neutral transaction preparation and instance registry.
//!
//! The application supplies one opaque SCALE RuntimeCall. CitizenSDK binds it to one exact best
//! block, runtime, nonce and signed-extension layout. Signer messages and extrinsic templates stay
//! inside the Engine and are consumed only by the later signing/submission closure.

use std::collections::HashMap;

use citizen_sdk_contracts::{
    apply_signing_transform, AccountId32, AccountNonce, AccountNonceSource, ChainIdentity,
    ChainSigner, ContractErrorCode, Hash32, ImmortalSigningPayload, OpaqueTransactionCall,
    PreparedTransactionSummary, RuntimeContext, SignedExtrinsic, SignedTransactionBuild,
    SigningIntent, SigningTransform, Sr25519PublicKey, Sr25519Signature,
    TransactionExecutionRecord, TransactionPreparationId, VerifiedChainClient,
    MAX_PREPARED_TRANSACTIONS,
};
use subxt_core::{
    config::{
        substrate::{SubstrateExtrinsicParams, SubstrateExtrinsicParamsBuilder, H256},
        ExtrinsicParams, ExtrinsicParamsEncoder, SubstrateConfig,
    },
    ext::codec::{Compact, Decode},
    tx::{self, ClientState, RuntimeVersion as SubxtRuntimeVersion, TransactionVersion},
    utils::{AccountId32 as SubxtAccountId32, MultiSignature},
};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    account_state::{verified_identity, verified_runtime_context},
    error::EngineError,
    metadata::{signed_extension_identifiers, validate_opaque_runtime_call},
    system_events::decode_metadata_strict,
};

/// Engine-owned material that must never be projected into language bindings.
pub(crate) struct PreparedTransaction {
    summary: PreparedTransactionSummary,
    identity: ChainIdentity,
    runtime_context: RuntimeContext,
    nonce: AccountNonce,
    call_data: Zeroizing<Vec<u8>>,
    full_signing_payload: Zeroizing<Vec<u8>>,
    signing_message: Zeroizing<Vec<u8>>,
    extrinsic_template: Zeroizing<Vec<u8>>,
    signature_offset: usize,
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
    /// 签名只覆盖模板中的固定 64-byte 槽，因此签名前即可精确知道持久 extrinsic 长度。
    pub(crate) fn signed_extrinsic_len(&self) -> usize {
        self.extrinsic_template.len()
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

    /// Fill the single frozen signature slot after an independently completed hot/QR signature.
    pub(crate) async fn complete_with_signature(
        self,
        signer: &dyn ChainSigner,
        signature: Sr25519Signature,
    ) -> Result<SignedTransactionBuild, EngineError> {
        let public_key =
            Sr25519PublicKey::from_bytes(self.summary.source_account_id().into_bytes());
        if !signer
            .verify(public_key, self.signing_message.to_vec(), signature)
            .await?
        {
            return Err(EngineError::contract(
                ContractErrorCode::Integrity,
                "transaction signature 与冻结 signer message/source 不一致",
            ));
        }
        self.finish(signature)
    }

    fn finish(self, signature: Sr25519Signature) -> Result<SignedTransactionBuild, EngineError> {
        let mut encoded = self.extrinsic_template.to_vec();
        let end = self
            .signature_offset
            .checked_add(64)
            .ok_or_else(|| EngineError::contract(ContractErrorCode::Internal, "签名偏移溢出"))?;
        encoded
            .get_mut(self.signature_offset..end)
            .ok_or_else(|| EngineError::contract(ContractErrorCode::Integrity, "签名槽无效"))?
            .copy_from_slice(signature.as_bytes());
        let extrinsic = SignedExtrinsic::try_new(encoded)?;
        let payload = ImmortalSigningPayload::try_new(
            &self.identity,
            &self.runtime_context,
            self.nonce,
            self.summary.source_account_id(),
            Sr25519PublicKey::from_bytes(self.summary.source_account_id().into_bytes()),
            self.call_data.to_vec(),
            self.signing_message.to_vec(),
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
    if tx::suggested_version(&metadata)
        .map_err(|error| EngineError::InvalidMetadata(error.to_string()))?
        != TransactionVersion::V4
    {
        return Err(EngineError::contract(
            ContractErrorCode::Unsupported,
            "当前链 extrinsic 格式不受交易准备器支持",
        ));
    }
    let extensions = signed_extension_identifiers(&metadata);
    let state = ClientState::<SubstrateConfig> {
        genesis_hash: H256::from(identity.genesis_hash().into_bytes()),
        runtime_version: SubxtRuntimeVersion {
            spec_version: runtime_context.version().spec_version(),
            transaction_version: runtime_context.version().transaction_version(),
        },
        metadata,
    };
    let params = SubstrateExtrinsicParamsBuilder::<SubstrateConfig>::new()
        .immortal()
        .nonce(nonce.value())
        .tip(0)
        .build();
    let full_params =
        <SubstrateExtrinsicParams<SubstrateConfig> as ExtrinsicParams<SubstrateConfig>>::new(
            &state,
            SubstrateExtrinsicParamsBuilder::<SubstrateConfig>::new()
                .immortal()
                .nonce(nonce.value())
                .tip(0)
                .build(),
        )
        .map_err(|error| map_extrinsic_parameter_error(error.to_string()))?;
    let mut full_signing_payload = call.as_bytes().to_vec();
    full_params.encode_signer_payload_value_to(&mut full_signing_payload);
    full_params.encode_implicit_to(&mut full_signing_payload);
    let raw_call = ExactCallData(call.as_bytes());
    let partial = tx::create_v4_signed(&raw_call, &state, params)
        .map_err(|error| map_extrinsic_parameter_error(error.to_string()))?;
    if partial.call_data() != call.as_bytes() {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "交易构造器改写了已验证的 opaque callData",
        ));
    }
    let signing_message = partial.signer_payload();
    let derived_signing_message = apply_signing_transform(
        &full_signing_payload,
        &SigningTransform::SubstrateSigningPayload,
    )?;
    if signing_message != derived_signing_message {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "完整 SigningPayload 与交易构造器 signer message 不一致",
        ));
    }
    let template = partial
        .sign_with_account_and_signature(
            SubxtAccountId32(source_account_id.into_bytes()),
            &MultiSignature::Sr25519([0; 64]),
        )
        .into_encoded();
    let signature_offset = validate_template_and_signature_offset(&template)?;
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
        signing_message: Zeroizing::new(signing_message),
        extrinsic_template: Zeroizing::new(template),
        signature_offset,
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
    signer: &dyn ChainSigner,
) -> Result<(), EngineError> {
    if identity.genesis_hash() != record.genesis_hash()
        || runtime_context.version() != record.runtime_version()
        || record.call_data_hash()
            != Hash32::from_bytes(citizen_sdk_contracts::blake2_256(record.call_data())?)
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
    if tx::suggested_version(&metadata)
        .map_err(|error| EngineError::InvalidMetadata(error.to_string()))?
        != TransactionVersion::V4
    {
        return Err(EngineError::contract(
            ContractErrorCode::Unsupported,
            "通用交易恢复只接受已冻结的 signed extrinsic V4",
        ));
    }
    let state = ClientState::<SubstrateConfig> {
        genesis_hash: H256::from(identity.genesis_hash().into_bytes()),
        runtime_version: SubxtRuntimeVersion {
            spec_version: runtime_context.version().spec_version(),
            transaction_version: runtime_context.version().transaction_version(),
        },
        metadata,
    };
    let partial = tx::create_v4_signed(
        &ExactCallData(record.call_data()),
        &state,
        SubstrateExtrinsicParamsBuilder::<SubstrateConfig>::new()
            .immortal()
            .nonce(record.nonce())
            .tip(0)
            .build(),
    )
    .map_err(|error| map_extrinsic_parameter_error(error.to_string()))?;
    let mut body = record.signed_extrinsic().as_bytes();
    let declared = Compact::<u32>::decode(&mut body)
        .map_err(|_| {
            EngineError::contract(ContractErrorCode::Integrity, "恢复 extrinsic 长度无效")
        })?
        .0 as usize;
    if declared != body.len() || body.len() < 99 || body[0] != 0x84 || body[1] != 0 || body[34] != 1
    {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "恢复 extrinsic 不是准确 sr25519 V4",
        ));
    }
    let mut signature = [0_u8; 64];
    signature.copy_from_slice(&body[35..99]);
    let encoded = partial
        .sign_with_account_and_signature(
            SubxtAccountId32(record.account_id().into_bytes()),
            &MultiSignature::Sr25519(signature),
        )
        .into_encoded();
    if encoded != record.signed_extrinsic().as_bytes()
        || !signer
            .verify(
                Sr25519PublicKey::from_bytes(record.account_id().into_bytes()),
                partial.signer_payload(),
                Sr25519Signature::from_bytes(signature),
            )
            .await?
    {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "恢复 extrinsic 的账户、调用、nonce 或签名不一致",
        ));
    }
    Ok(())
}

fn validate_template_and_signature_offset(template: &[u8]) -> Result<usize, EngineError> {
    let mut body = template;
    let length = Compact::<u32>::decode(&mut body)
        .map_err(|_| {
            EngineError::contract(ContractErrorCode::Integrity, "extrinsic 模板长度前缀无效")
        })?
        .0 as usize;
    if length != body.len() {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "extrinsic 模板长度前缀与正文不一致",
        ));
    }
    let prefix = template.len().checked_sub(body.len()).ok_or_else(|| {
        EngineError::contract(ContractErrorCode::Internal, "extrinsic 模板前缀溢出")
    })?;
    if body.len() < 99 || body[0] != 0x84 || body[1] != 0 || body[34] != 1 {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "extrinsic 模板不是预期的 sr25519 signed Substrate 形状",
        ));
    }
    prefix
        .checked_add(35)
        .ok_or_else(|| EngineError::contract(ContractErrorCode::Internal, "签名槽偏移溢出"))
}

fn map_extrinsic_parameter_error(message: String) -> EngineError {
    if message.contains("unknown transaction extension")
        || message.contains("UnknownTransactionExtension")
    {
        EngineError::contract(ContractErrorCode::Unsupported, message)
    } else {
        EngineError::InvalidMetadata(message)
    }
}

struct ExactCallData<'a>(&'a [u8]);

impl tx::payload::Payload for ExactCallData<'_> {
    fn encode_call_data_to(
        &self,
        _metadata: &subxt_core::Metadata,
        output: &mut Vec<u8>,
    ) -> Result<(), subxt_core::Error> {
        output.extend_from_slice(self.0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_single_flight_per_source_and_bounded_across_sources() {
        let mut registry = PreparedTransactionRegistry::default();
        let first_source = AccountId32::from_bytes([1; 32]);
        let first = registry.reserve(first_source).expect("first reservation");
        assert_contract_code(
            registry.reserve(first_source).unwrap_err(),
            ContractErrorCode::Conflict,
        );
        registry.release_reservation(first_source, first);
        assert!(registry.reserve(first_source).is_ok());

        let mut bounded = PreparedTransactionRegistry::default();
        for index in 0..MAX_PREPARED_TRANSACTIONS {
            let mut source = [0_u8; 32];
            source[..8].copy_from_slice(&(index as u64 + 1).to_le_bytes());
            bounded
                .reserve(AccountId32::from_bytes(source))
                .expect("capacity reservation");
        }
        assert_contract_code(
            bounded
                .reserve(AccountId32::from_bytes([0xff; 32]))
                .unwrap_err(),
            ContractErrorCode::Conflict,
        );
    }

    fn assert_contract_code(error: EngineError, expected: ContractErrorCode) {
        match error {
            EngineError::Contract(error) => assert_eq!(error.code(), expected),
            other => panic!("expected contract error {expected:?}, got {other:?}"),
        }
    }
}
