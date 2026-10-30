//! SecretBuffer、同步sr25519函数与SecretVault的隔离合同。

use std::collections::HashSet;
use std::future::Future;
use std::sync::Mutex;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;

use citizensdk::types::AccountId32;

use citizensdk::types::ContractFuture;
use citizensdk::types::ContractResult;
use citizensdk::types::DerivationJunction;
use citizensdk::types::EncryptedSecretEnvelope;
use citizensdk::types::Hash32Bytes;
use citizensdk::types::SecretBuffer;
use citizensdk::types::SecretOwner;
use citizensdk::types::SecretRef;
use citizensdk::types::SecretVault;
use citizensdk::types::Sr25519PublicKey;
use citizensdk::types::Sr25519Signature;
use citizensdk::types::VaultAvailability;
use citizensdk::types::VaultGeneration;
use citizensdk::types::SR25519_SIGNING_CONTEXT;

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

fn value_or_panic<T>(result: ContractResult<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("合同调用失败: {error}"),
    }
}

#[derive(Default)]
struct FakeVault {
    keys: Mutex<HashSet<(u32, VaultGeneration)>>,
    query_error: Mutex<Option<citizensdk::types::ContractErrorCode>>,
}

impl SecretVault for FakeVault {
    fn authorize_add_accounts(
        &self,
        _: [u8; 16],
        _: u32,
        _: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        panic!("此夹具不得执行追加认证")
    }
    fn ensure_wallet_key(
        &self,
        _: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            self.keys
                .lock()
                .unwrap_or_else(|_| panic!("合成测试锁不可用"))
                .insert((wallet_index, generation));
            Ok(())
        })
    }
    fn has_any_wallet_key(&self, wallet_index: u32) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            if let Some(code) = *self
                .query_error
                .lock()
                .unwrap_or_else(|_| panic!("合成测试锁不可用"))
            {
                return Err(citizensdk::types::ContractError::new(
                    code,
                    "合成金库查询失败",
                ));
            }
            Ok(self
                .keys
                .lock()
                .unwrap_or_else(|_| panic!("合成测试锁不可用"))
                .iter()
                .any(|(index, _)| *index == wallet_index))
        })
    }

    fn availability(&self) -> ContractFuture<'_, VaultAvailability> {
        Box::pin(async { Ok(VaultAvailability::Available) })
    }

    fn seal(
        &self,
        _provisioning_operation_id: [u8; 16],
        secret_ref: SecretRef,
        secret: SecretBuffer,
    ) -> ContractFuture<'_, EncryptedSecretEnvelope> {
        Box::pin(async move {
            if !self
                .has_wallet_key(secret_ref.wallet_index(), secret_ref.generation())
                .await?
            {
                return Err(citizensdk::types::ContractError::new(
                    citizensdk::types::ContractErrorCode::KeyInvalidated,
                    "合成密钥缺失",
                ));
            }
            let ciphertext =
                secret.with_secret(|bytes| bytes.iter().map(|byte| *byte ^ 0xaa).collect());
            EncryptedSecretEnvelope::try_new(1, Hash32Bytes::from_bytes([3; 32]), ciphertext)
        })
    }

    fn open(
        &self,
        _secret_ref: SecretRef,
        envelope: EncryptedSecretEnvelope,
    ) -> ContractFuture<'_, SecretBuffer> {
        Box::pin(async move {
            let plaintext = envelope
                .ciphertext()
                .iter()
                .map(|byte| *byte ^ 0xaa)
                .collect();
            SecretBuffer::try_new(plaintext)
        })
    }

    fn has_wallet_key(
        &self,
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            Ok(self
                .keys
                .lock()
                .unwrap_or_else(|_| panic!("合成测试锁不可用"))
                .contains(&(wallet_index, generation)))
        })
    }

    fn delete_wallet_key(
        &self,
        _cleanup_operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            self.keys
                .lock()
                .unwrap_or_else(|_| panic!("合成测试锁不可用"))
                .remove(&(wallet_index, generation));
            Ok(())
        })
    }
}

#[test]
fn secret_debug_is_redacted_and_direct_access_is_scoped_to_rust_closure() {
    let secret = value_or_panic(SecretBuffer::try_new(b"secret-never-print".to_vec()));
    let debug = format!("{secret:?}");
    assert_eq!(debug, "SecretBuffer([REDACTED])");
    assert!(!debug.contains("secret-never-print"));
    assert_eq!(secret.with_secret(<[u8]>::len), 18);
}

#[test]
fn vault_secret_is_borrowed_only_by_real_substrate_crypto() {
    assert_eq!(SR25519_SIGNING_CONTEXT, b"substrate");

    let vault: Box<dyn SecretVault> = Box::new(FakeVault::default());
    let generation = VaultGeneration::from_bytes([1; 16]);
    let secret_ref = SecretRef::account_mini_secret(
        0,
        generation,
        SecretOwner::from_bytes([2; 16]),
        AccountId32::from_bytes([4; 32]),
    );

    assert_eq!(
        value_or_panic(block_on(vault.availability())),
        VaultAvailability::Available
    );
    let secret = value_or_panic(SecretBuffer::try_new(vec![7; 32]));
    value_or_panic(block_on(vault.ensure_wallet_key([9; 16], 0, generation)));
    let envelope = value_or_panic(block_on(vault.seal([9; 16], secret_ref, secret)));
    let unlocked = value_or_panic(block_on(vault.open(secret_ref, envelope)));
    let public_key = value_or_panic(citizensdk::sign::public_key(&unlocked));
    let signature = value_or_panic(citizensdk::sign::sign(&unlocked, b"payload".to_vec()));
    assert!(value_or_panic(citizensdk::sign::verify(
        public_key,
        b"payload".to_vec(),
        signature,
    )));
}

#[test]
fn wallet_key_presence_covers_all_generations_and_propagates_query_failure() {
    use citizensdk::types::ContractErrorCode;
    let vault = FakeVault::default();
    let first = VaultGeneration::from_bytes([1; 16]);
    let second = VaultGeneration::from_bytes([2; 16]);
    assert!(!value_or_panic(block_on(vault.has_any_wallet_key(7))));
    vault
        .keys
        .lock()
        .unwrap_or_else(|_| panic!("合成测试锁不可用"))
        .extend([(7, first), (7, second), (u32::MAX, first)]);
    assert!(value_or_panic(block_on(vault.has_any_wallet_key(7))));
    assert!(!value_or_panic(block_on(vault.has_any_wallet_key(8))));
    value_or_panic(block_on(vault.delete_wallet_key([3; 16], 7, first)));
    assert!(value_or_panic(block_on(vault.has_any_wallet_key(7))));
    value_or_panic(block_on(vault.delete_wallet_key([4; 16], 7, second)));
    assert!(!value_or_panic(block_on(vault.has_any_wallet_key(7))));
    assert!(value_or_panic(block_on(vault.has_any_wallet_key(u32::MAX))));
    for code in [
        ContractErrorCode::Unsupported,
        ContractErrorCode::PermissionDenied,
        ContractErrorCode::AuthenticationCancelled,
    ] {
        *vault
            .query_error
            .lock()
            .unwrap_or_else(|_| panic!("合成测试锁不可用")) = Some(code);
        assert!(block_on(vault.has_any_wallet_key(7)).is_err());
    }
}
