//! 验证自然键和执行标识的规范编码及秘密引用身份。

use citizensdk::types;
use citizensdk::types::Hash32;
use citizensdk::types::TransactionExecutionId;

#[test]
fn natural_hash_keys_and_execution_ids_reject_noncanonical_values() {
    assert_eq!(
        citizensdk::store::block(Hash32::from_bytes([0; 32])),
        "00".repeat(32)
    );
    let id = TransactionExecutionId::try_new([0xab; 16]).unwrap();
    assert_eq!(citizensdk::store::execution(id), "ab".repeat(16));
    assert_eq!(
        citizensdk::store::parse_execution(&citizensdk::store::execution(id)).unwrap(),
        id
    );
    for value in [
        "AB".repeat(16),
        "00".repeat(16),
        "ab".repeat(15),
        "gg".repeat(16),
    ] {
        assert!(citizensdk::store::parse_execution(&value).is_err());
    }
}

#[test]
fn secret_keys_have_no_storage_version_prefix_and_keep_reference_identity() {
    use types::{AccountId32, SecretOwner, SecretRef, VaultGeneration};
    let reference = SecretRef::account_mini_secret(
        0,
        VaultGeneration::from_bytes([1; 16]),
        SecretOwner::from_bytes([2; 16]),
        AccountId32::from_bytes([3; 32]),
    );
    assert_eq!(
        citizensdk::store::secret(reference),
        format!(
            "0:1:{}:{}:{}",
            "01".repeat(16),
            "02".repeat(16),
            "03".repeat(32)
        )
    );
    let other = SecretRef::account_mini_secret(
        1,
        reference.generation(),
        reference.owner(),
        reference.account_id(),
    );
    assert_ne!(
        citizensdk::store::secret(reference),
        citizensdk::store::secret(other)
    );
}
