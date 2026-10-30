use citizen_sdk_contracts::*;
use citizen_sdk_store::codec::*;
#[test]
fn secret_presence_abi_preserves_outputs_on_failure() {
    let account = AccountId32::from_bytes([10; 32]);
    let reference = SecretRef::account_mini_secret(
        7,
        VaultGeneration::from_bytes([8; 16]),
        SecretOwner::from_bytes([9; 16]),
        account,
    );
    let snapshot = EncryptedSecretBlobSnapshot::empty()
        .try_advance(EncryptedSecretBlobState::Tombstone {
            cleanup_operation_id: [15; 16],
        })
        .unwrap();
    let bytes = encode_encrypted_secret_blob_snapshot(reference, &snapshot).unwrap();
    let c_account = crate::abi::CitizenSdkAccountId {
        bytes: *account.as_bytes(),
    };
    let view = crate::abi::CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    };
    let mut output = 77;
    assert_eq!(
        unsafe {
            crate::citizensdk_encrypted_secret_record_has_secret(
                &c_account,
                snapshot.revision(),
                view,
                &mut output,
            )
        },
        0
    );
    assert_eq!(output, 0);
    for length in 0..bytes.len() {
        output = 77;
        let truncated = crate::abi::CitizenSdkBytesView {
            data: bytes.as_ptr(),
            len: length as u64,
        };
        assert_ne!(
            unsafe {
                crate::citizensdk_encrypted_secret_record_has_secret(
                    &c_account,
                    snapshot.revision(),
                    truncated,
                    &mut output,
                )
            },
            0
        );
        assert_eq!(output, 77);
    }
    output = 77;
    assert_ne!(
        unsafe {
            crate::citizensdk_encrypted_secret_record_has_secret(
                std::ptr::null(),
                snapshot.revision(),
                view,
                &mut output,
            )
        },
        0
    );
    assert_eq!(output, 77);
    assert_ne!(
        unsafe {
            crate::citizensdk_encrypted_secret_record_has_secret(
                &c_account,
                snapshot.revision(),
                view,
                std::ptr::null_mut(),
            )
        },
        0
    );
    assert_ne!(
        unsafe {
            crate::citizensdk_encrypted_secret_record_has_secret(
                &c_account,
                snapshot.revision() + 1,
                view,
                &mut output,
            )
        },
        0
    );
    assert_eq!(output, 77);
}
