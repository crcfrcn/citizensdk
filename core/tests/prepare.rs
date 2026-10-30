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
