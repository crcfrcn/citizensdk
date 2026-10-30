use citizensdk::store::key;
use citizensdk::types::Hash32;
use citizensdk::types::TransactionExecutionId;
use citizensdk::types;

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

#[test]
fn secret_keys_have_no_storage_version_prefix_and_keep_reference_identity() {
    use types::{AccountId32, SecretOwner, SecretRef, VaultGeneration};
    let reference = SecretRef::account_mini_secret(0, VaultGeneration::from_bytes([1; 16]), SecretOwner::from_bytes([2; 16]), AccountId32::from_bytes([3; 32]));
    assert_eq!(key::secret(reference), format!("0:1:{}:{}:{}", "01".repeat(16), "02".repeat(16), "03".repeat(32)));
    let other = SecretRef::account_mini_secret(1, reference.generation(), reference.owner(), reference.account_id());
    assert_ne!(key::secret(reference), key::secret(other));
}
