mod db;
use citizen_sdk_contracts::*;
use citizen_sdk_store::{secure::Format, sqlite::Connection, SecureStore};
use futures::executor::block_on;
fn reference() -> SecretRef {
    SecretRef::account_mini_secret(
        7,
        VaultGeneration::from_bytes([8; 16]),
        SecretOwner::from_bytes([9; 16]),
        AccountId32::from_bytes([10; 32]),
    )
}
#[test]
fn wallet_revision_cas_preserves_records_and_rejects_envelope_tampering() {
    let db = db::Db::open();
    let store = SecureStore::new(db.clone());
    assert_eq!(
        block_on(WalletProfileStore::load(&store)).unwrap(),
        WalletState::empty()
    );
    let next = WalletState::try_from_catalog_parts(1, None, vec![], vec![], 1, None, None, vec![])
        .unwrap();
    assert_eq!(
        block_on(WalletProfileStore::compare_and_swap(
            &store,
            0,
            next.clone()
        ))
        .unwrap(),
        next
    );
    assert_eq!(
        block_on(WalletProfileStore::compare_and_swap(
            &store,
            0,
            next.clone()
        ))
        .unwrap_err()
        .code(),
        ContractErrorCode::Conflict
    );
    let mut corrupt = citizen_sdk_store::codec::encode_wallet_state(&next).unwrap();
    let last = corrupt.len() - 1;
    corrupt[last] ^= 1;
    db.0.lock()
        .unwrap()
        .execute(
            "UPDATE wallet SET record_data=?",
            &[citizen_sdk_store::sqlite::Value::Blob(corrupt)],
        )
        .unwrap();
    assert_eq!(
        block_on(WalletProfileStore::load(&store))
            .unwrap_err()
            .code(),
        ContractErrorCode::Integrity
    );
}
#[test]
fn ciphertext_tombstone_cannot_be_overwritten_or_revived() {
    let db = db::Db::open();
    let store = SecureStore::new(db.clone());
    let reference = reference();
    assert_eq!(
        block_on(EncryptedSecretBlobStore::load(&store, reference)).unwrap(),
        EncryptedSecretBlobSnapshot::empty()
    );
    let next = EncryptedSecretBlobState::Tombstone {
        cleanup_operation_id: [3; 16],
    };
    let stored = block_on(EncryptedSecretBlobStore::compare_and_swap(
        &store,
        reference,
        0,
        next.clone(),
    ))
    .unwrap();
    assert!(stored.is_tombstone());
    assert!(!block_on(store.has_account_secret(reference.account_id())).unwrap());
    assert!(block_on(EncryptedSecretBlobStore::compare_and_swap(
        &store, reference, 1, next
    ))
    .is_err());
    assert_eq!(
        block_on(EncryptedSecretBlobStore::load(&store, reference)).unwrap(),
        stored
    );
}
#[test]
fn all_existing_platform_schemas_open_without_rewriting_records() {
    for format in [Format::Device, Format::Tpm, Format::Cng] {
        let db = db::Db::open();
        {
            let mut conn = db.0.lock().unwrap();
            for sql in format.statements() {
                conn.execute(sql, &[]).unwrap();
            }
            conn.execute("PRAGMA user_version=1", &[]).unwrap();
        }
        let store = SecureStore::with_format(db.clone(), format);
        assert_eq!(
            block_on(WalletProfileStore::load(&store)).unwrap(),
            WalletState::empty()
        );
        db.0.lock()
            .unwrap()
            .execute("CREATE TABLE unexpected(value)", &[])
            .unwrap();
        assert!(block_on(WalletProfileStore::load(&SecureStore::with_format(
            db, format
        )))
        .is_err());
    }
}

fn sealed() -> EncryptedSecretBlobState {
    EncryptedSecretBlobState::Sealed {
        provisioning_operation_id: [11; 16],
        envelope: EncryptedSecretEnvelope::try_new(
            1,
            Hash32Bytes::from_bytes([12; 32]),
            vec![13; 48],
        )
        .unwrap(),
    }
}
#[test]
fn secret_presence_and_exact_reference_keys_preserve_sealed_and_retired_generations() {
    let db = db::Db::open();
    let store = SecureStore::new(db.clone());
    let first = reference();
    let second = SecretRef::account_mini_secret(
        first.wallet_index(),
        VaultGeneration::from_bytes([88; 16]),
        first.owner(),
        first.account_id(),
    );
    let changed = SecretRef::account_mini_secret(
        first.wallet_index(),
        first.generation(),
        SecretOwner::from_bytes([55; 16]),
        first.account_id(),
    );
    let stored = block_on(EncryptedSecretBlobStore::compare_and_swap(
        &store,
        first,
        0,
        sealed(),
    ))
    .unwrap();
    assert!(block_on(store.has_account_secret(first.account_id())).unwrap());
    assert!(!block_on(store.has_account_secret(AccountId32::from_bytes([99; 32]))).unwrap());
    assert_eq!(
        block_on(EncryptedSecretBlobStore::load(&store, changed)).unwrap(),
        EncryptedSecretBlobSnapshot::empty()
    );
    assert_eq!(
        block_on(EncryptedSecretBlobStore::load(&store, second)).unwrap(),
        EncryptedSecretBlobSnapshot::empty()
    );
    block_on(EncryptedSecretBlobStore::compare_and_swap(
        &store,
        first,
        stored.revision(),
        EncryptedSecretBlobState::Tombstone {
            cleanup_operation_id: [14; 16],
        },
    ))
    .unwrap();
    assert!(!block_on(store.has_account_secret(first.account_id())).unwrap());
    block_on(EncryptedSecretBlobStore::compare_and_swap(
        &store,
        second,
        0,
        sealed(),
    ))
    .unwrap();
    assert!(block_on(store.has_account_secret(first.account_id())).unwrap());
    assert!(block_on(EncryptedSecretBlobStore::compare_and_swap(
        &store,
        first,
        2,
        sealed()
    ))
    .is_err());
}
#[test]
fn secure_uncertain_commit_requires_exact_candidate_and_keeps_failed_writes_absent() {
    for landed in [false, true] {
        let db = db::Db::open();
        let store = SecureStore::new(db.clone());
        block_on(WalletProfileStore::load(&store)).unwrap();
        {
            let mut conn = db.0.lock().unwrap();
            conn.commit_error = true;
            conn.commit_landed = landed;
        }
        let next =
            WalletState::try_from_catalog_parts(1, None, vec![], vec![], 1, None, None, vec![])
                .unwrap();
        assert_eq!(
            block_on(WalletProfileStore::compare_and_swap(&store, 0, next)).is_ok(),
            landed
        );
        assert_eq!(
            block_on(WalletProfileStore::load(&store))
                .unwrap()
                .revision(),
            u64::from(landed)
        );
        {
            let mut conn = db.0.lock().unwrap();
            conn.commit_error = true;
            conn.commit_landed = landed;
        }
        assert_eq!(
            block_on(EncryptedSecretBlobStore::compare_and_swap(
                &store,
                reference(),
                0,
                sealed()
            ))
            .is_ok(),
            landed
        );
        assert_eq!(
            block_on(store.has_account_secret(reference().account_id())).unwrap(),
            landed
        );
    }
}
#[test]
fn corrupt_private_records_fail_without_reset_or_overwrite() {
    let db = db::Db::open();
    let store = SecureStore::with_format(db.clone(), Format::Device);
    block_on(WalletProfileStore::load(&store)).unwrap();
    db.0.lock()
        .unwrap()
        .execute("INSERT INTO secret VALUES('corrupt',x'01')", &[])
        .unwrap();
    assert!(block_on(store.has_account_secret(reference().account_id())).is_err());
    let rows =
        db.0.lock()
            .unwrap()
            .query("SELECT record_data FROM secret", &[], 1, 1024)
            .unwrap();
    assert_eq!(rows[0].bytes(0, 1).unwrap(), [1]);
}
#[test]
fn secure_schema_literal_changes_are_rejected() {
    let db = db::Db::open();
    {
        let mut conn = db.0.lock().unwrap();
        for sql in Format::Tpm.statements() {
            conn.execute(&sql.replace("'blob'", "'BLOB'"), &[]).unwrap();
        }
        conn.execute("PRAGMA user_version=1", &[]).unwrap();
    }
    assert!(block_on(WalletProfileStore::load(&SecureStore::with_format(
        db,
        Format::Tpm
    )))
    .is_err());
}
#[test]
fn secret_scan_stops_early_and_rejects_more_than_65536_candidates() {
    use citizen_sdk_store::{codec, key, sqlite::Value};
    let db = db::Db::open();
    let store = SecureStore::new(db.clone());
    block_on(WalletProfileStore::load(&store)).unwrap();
    let tomb = EncryptedSecretBlobSnapshot::empty()
        .try_advance(EncryptedSecretBlobState::Tombstone {
            cleanup_operation_id: [1; 16],
        })
        .unwrap();
    let bytes = codec::encode_encrypted_secret_blob_snapshot(reference(), &tomb).unwrap();
    db.0.lock().unwrap().execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<65537) INSERT INTO secret SELECT printf('%05d',x),? FROM n",&[Value::Blob(bytes)]).unwrap();
    assert_eq!(
        block_on(store.has_account_secret(reference().account_id()))
            .unwrap_err()
            .code(),
        ContractErrorCode::Unavailable
    );
    db.0.lock()
        .unwrap()
        .execute("DELETE FROM secret", &[])
        .unwrap();
    block_on(EncryptedSecretBlobStore::compare_and_swap(
        &store,
        reference(),
        0,
        sealed(),
    ))
    .unwrap();
    db.0.lock()
        .unwrap()
        .execute("INSERT INTO secret VALUES('bad',x'01')", &[])
        .unwrap();
    assert!(block_on(store.has_account_secret(reference().account_id())).unwrap());
    assert!(key::secret(reference()).starts_with("v1:7:1:"));
}

#[test]
fn malformed_revisions_never_overwrite_and_independent_databases_remain_isolated() {
    use citizen_sdk_store::{key, sqlite::Value};
    for record in [vec![0], vec![1, 2], vec![0xff; 80]] {
        let db = db::Db::open();
        let store = SecureStore::with_format(db.clone(), Format::Device);
        block_on(WalletProfileStore::load(&store)).unwrap();
        db.0.lock()
            .unwrap()
            .execute(
                "INSERT INTO secret VALUES(?,?)",
                &[
                    Value::Text(key::secret(reference())),
                    Value::Blob(record.clone()),
                ],
            )
            .unwrap();
        assert!(block_on(EncryptedSecretBlobStore::load(&store, reference())).is_err());
        assert!(block_on(EncryptedSecretBlobStore::compare_and_swap(
            &store,
            reference(),
            0,
            sealed()
        ))
        .is_err());
        let rows =
            db.0.lock()
                .unwrap()
                .query("SELECT record_data FROM secret", &[], 1, 1024)
                .unwrap();
        assert_eq!(rows[0].0, vec![Value::Blob(record)]);
    }
    let first = SecureStore::new(db::Db::open());
    let second = SecureStore::new(db::Db::open());
    let next = WalletState::try_from_catalog_parts(1, None, vec![], vec![], 1, None, None, vec![])
        .unwrap();
    block_on(WalletProfileStore::compare_and_swap(&first, 0, next)).unwrap();
    assert_eq!(
        block_on(WalletProfileStore::load(&second)).unwrap(),
        WalletState::empty()
    );
    let key = citizen_sdk_store::vault::Key {
        index: 0,
        generation: reference().generation(),
    };
    first.retire_generation(key, [1; 16]).unwrap();
    assert!(second.ensure_generation(key, [1; 16]).unwrap());
}
