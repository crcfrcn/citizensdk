use super::*;

#[test]
fn sdk_v16_messages_and_both_pq_envelopes_match_actual_frame_runtime() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("mldsa-runtime-v16.json")).unwrap();
    let bytes = |name: &str| hex::decode(fixture[name].as_str().unwrap()).unwrap();
    let metadata = decode_metadata_strict(&bytes("metadata")).unwrap();
    let genesis: [u8; 32] = bytes("genesis").try_into().unwrap();
    let (explicit, implicit) = crate::metadata::native_extension_bytes(&metadata, genesis, 0, 0, 7).unwrap();
    assert_eq!(explicit, bytes("extensions"));
    let call = bytes("call");
    let mut review = call.clone(); review.extend_from_slice(&explicit); review.extend_from_slice(&implicit);
    assert_eq!(review, bytes("review"));
    let child: [u8; 32] = bytes("child").try_into().unwrap();
    let public = mldsa::public_key(&child);
    let account = mldsa::account_id(&public);
    assert_eq!(account.as_slice(), bytes("account"));
    let message = mldsa::review_message(&account, &review);
    assert_eq!(message.as_slice(), bytes("message"));
    let signature = mldsa::sign(&child, &message).unwrap();
    let first = mldsa::Proof::First { account, public, signature: signature.clone() };
    let stored = mldsa::Proof::Stored { account, signature };
    assert_eq!(mldsa::encode_transaction(&first, &explicit, &call), bytes("first"));
    assert_eq!(mldsa::encode_transaction(&stored, &explicit, &call), bytes("stored"));
    let sr_account: [u8; 32] = bytes("sr_account").try_into().unwrap();
    let sr_signature: [u8; 64] = bytes("sr_signature").try_into().unwrap();
    let sr = mldsa::Proof::Sr25519 { account: sr_account, signature: sr_signature };
    assert_eq!(mldsa::encode_transaction(&sr, &explicit, &call), bytes("sr_extrinsic"));
    assert!(crate::sign::verify(crate::types::AccountId32::from_bytes(sr_account), &mldsa::review_message(&sr_account, &review), crate::types::AccountSignature::from_bytes(sr_signature)).unwrap());
}

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

#[test]
fn v5_persisted_transactions_revalidate_authentication_and_reject_tampering() {
    use crate::types::*;
    use futures::executor::block_on;
    struct KeyClient { block: VerifiedBlockRef, key: Vec<u8>, public: Option<Vec<u8>> }
    fn unused<T>() -> ContractFuture<'static, T> { Box::pin(async { panic!("unexpected provider call") }) }
    impl VerifiedChainClient for KeyClient {
        fn identity(&self) -> ContractFuture<'_, ChainIdentity> { unused() }
        fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> { unused() }
        fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> { unused() }
        fn get_runtime_context_at(&self, _: VerifiedBlockRef) -> ContractFuture<'_, RuntimeContext> { unused() }
        fn get_storage_at(&self, block: VerifiedBlockRef, key: Vec<u8>) -> ContractFuture<'_, Option<Vec<u8>>> {
            assert_eq!(block, self.block); assert_eq!(key, self.key);
            Box::pin(async { Ok(self.public.clone()) })
        }
        fn get_storage_batch_at(&self, _: VerifiedBlockRef, _: Vec<Vec<u8>>) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> { unused() }
        fn get_block_extrinsics_at(&self, _: VerifiedBlockRef) -> ContractFuture<'_, Vec<Vec<u8>>> { unused() }
        fn submit_extrinsic(&self, _: SignedExtrinsic) -> ContractFuture<'_, SubmittedExtrinsic> { unused() }
        fn watch_extrinsic(&self, _: SignedExtrinsic) -> ContractStream<'_, ExtrinsicWatchEvent> { Box::pin(futures::stream::empty()) }
        fn export_state(&self) -> ContractFuture<'_, ExportedChainState> { unused() }
        fn import_state(&self, _: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> { unused() }
    }
    block_on(async {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("mldsa-runtime-v16.json")).unwrap();
        let bytes = |name: &str| hex::decode(fixture[name].as_str().unwrap()).unwrap();
        let block = VerifiedBlockRef::best(Hash32::from_bytes([0x41; 32]), 2);
        let context = RuntimeContext::try_new(block, RuntimeVersion::new(0, 0), bytes("metadata")).unwrap();
        let identity = ChainIdentity::citizenchain();
        let account: [u8; 32] = bytes("account").try_into().unwrap();
        let metadata = decode_metadata_strict(context.metadata()).unwrap();
        let address = subxt_core::dynamic::storage("Mldsa", "PqPublicKey", vec![subxt_core::dynamic::Value::from_bytes(account)]);
        let key = subxt_core::storage::get_address_bytes(&address, &metadata).unwrap();
        let public = mldsa::public_key(&[7; 32]).encode();
        let mut client = KeyClient { block, key, public: Some(public) };
        let record = |extrinsic: Vec<u8>, nonce: u64| {
            let mut body = extrinsic.as_slice(); let _ = Compact::<u32>::decode(&mut body).unwrap();
            let proof = mldsa::Proof::decode(&mut &body[2..]).unwrap();
            let signer = match proof { mldsa::Proof::Sr25519 { account, .. } | mldsa::Proof::First { account, .. } | mldsa::Proof::Stored { account, .. } => account };
            let call = bytes("call");
            TransactionExecutionRecord::try_new(TransactionExecutionId::try_new([1; 16]).unwrap(), AccountId32::from_bytes(signer),
                Hash32::from_bytes(crate::types::blake2_256(&call).unwrap()), call,
                Hash32::from_bytes(crate::types::blake2_256(&extrinsic).unwrap()), SignedExtrinsic::try_new(extrinsic).unwrap(),
                block, context.version(), identity.genesis_hash(), nonce, HistoryTransactionStatus::Pending, 1, 1).unwrap()
        };
        for kind in ["first", "stored", "sr_extrinsic"] {
            let good = record(bytes(kind), 7);
            validate_persisted_transaction_execution(&good, &identity, &context, &client).await.unwrap();
            let wrong_nonce = record(bytes(kind), 8);
            assert!(validate_persisted_transaction_execution(&wrong_nonce, &identity, &context, &client).await.is_err());
            let mut bad = bytes(kind); bad[60] ^= 1;
            assert!(validate_persisted_transaction_execution(&record(bad, 7), &identity, &context, &client).await.is_err());
        }
        client.public = None;
        assert!(validate_persisted_transaction_execution(&record(bytes("stored"), 7), &identity, &context, &client).await.is_err());
    });
}
