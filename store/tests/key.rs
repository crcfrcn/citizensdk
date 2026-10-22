use citizen_sdk_contracts::{Hash32, TransactionExecutionId};
use citizen_sdk_store::key;

#[test]
fn keys_keep_the_existing_ascii_format_and_reject_noncanonical_ids() {
    assert_eq!(
        key::block(Hash32::from_bytes([0; 32])),
        format!("block:{}", "00".repeat(32))
    );
    let id = TransactionExecutionId::try_new([0xab; 16]).unwrap();
    assert_eq!(key::execution(id), "ab".repeat(16));
    assert_eq!(key::parse_execution(&key::execution(id)).unwrap(), id);
    for value in [
        "AB".repeat(16),
        "00".repeat(16),
        "ab".repeat(15),
        "gg".repeat(16),
    ] {
        assert!(key::parse_execution(&value).is_err());
    }
}
