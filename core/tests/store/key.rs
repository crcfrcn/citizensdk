use citizensdk::store::key;
use citizensdk::types::Hash32;
use citizensdk::types::TransactionExecutionId;
use citizensdk::{abi, store, types};

#[test]
fn natural_hash_keys_and_execution_ids_reject_noncanonical_values() {
    assert_eq!(key::block(Hash32::from_bytes([0; 32])), "00".repeat(32));
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
