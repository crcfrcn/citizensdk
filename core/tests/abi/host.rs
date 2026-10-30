use crate::types::*;
use std::future::Future;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;

use crate::types::AccountId32;
use crate::types::SecretOwner;
use futures_executor::block_on;
use futures_util::task::noop_waker_ref;

use super::*;

fn test_secret_ref(wallet: u32, generation: u8, owner: u8, account: u8) -> SecretRef {
    SecretRef::account_mini_secret(
        wallet,
        VaultGeneration::from_bytes([generation; 16]),
        SecretOwner::from_bytes([owner; 16]),
        AccountId32::from_bytes([account; 32]),
    )
}

fn test_bridge(vault: Option<CitizenSdkHostSecretVaultV1>) -> Arc<HostBridge> {
    Arc::new(HostBridge {
        owner_id: next_global_id(&NEXT_HOST_OWNER_ID, "test owner exhausted").unwrap(),
        operation_gate: Mutex::new(HostOperationGate { accepting: true }),
        vault: vault.map(SendSecretVault),
    })
}

fn assert_host_operation_unclaimed(
    operation_id: u64,
    expected_kind: PendingKind,
    receiver: &mut oneshot::Receiver<Result<HostCompletion, ContractError>>,
) {
    let registry = host_operations()
        .lock()
        .unwrap_or_else(|_| panic!("host operation registry is poisoned"));
    assert_eq!(
        registry.pending.get(&operation_id).map(|entry| entry.kind),
        Some(expected_kind)
    );
    assert!(!registry.completing.contains_key(&operation_id));
    drop(registry);
    assert!(matches!(receiver.try_recv(), Ok(None)));
}

fn assert_terminal_integrity(receiver: oneshot::Receiver<Result<HostCompletion, ContractError>>) {
    let error = block_on(receiver)
        .unwrap_or_else(|_| panic!("host completion receiver was cancelled"))
        .err()
        .unwrap_or_else(|| panic!("null completion must terminate with an error"));
    assert_eq!(error.code(), ContractErrorCode::Integrity);
}

unsafe fn borrowed_bytes(view: CitizenSdkBytesView) -> Vec<u8> {
    let len = usize::try_from(view.len)
        .unwrap_or_else(|_| panic!("test host input length exceeds usize"));
    if len == 0 {
        return Vec::new();
    }
    assert!(!view.data.is_null());
    // SAFETY: every production callback contract keeps its borrowed input
    // readable until this callback returns; the fake copies immediately.
    unsafe { std::slice::from_raw_parts(view.data, len) }.to_vec()
}

unsafe fn complete_status_ok(
    operation_id: u64,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostStatusCompletionV1,
) {
    let result = CitizenSdkHostStatusResultV1 {
        host_operation_id: operation_id,
        ..CitizenSdkHostStatusResultV1::default()
    };
    // SAFETY: the result remains readable for this synchronous call.
    unsafe {
        completion.unwrap_or_else(|| panic!("status completion is missing"))(sdk_context, &result)
    };
}

#[derive(Default)]
struct FakeVault {
    key_owner: Mutex<Option<(u32, [u8; 16], [u8; 16])>>,
    retired: Mutex<bool>,
    ensure_calls: Mutex<usize>,
    seen_plaintext_deks: Mutex<Vec<Vec<u8>>>,
    unwrap_mode: AtomicU8,
    unwrap_operations: Mutex<Vec<u64>>,
}

unsafe fn fake_vault<'a>(context: *mut c_void) -> &'a FakeVault {
    assert!(!context.is_null());
    // SAFETY: each test keeps the boxed fake alive through all completions.
    unsafe { &*(context.cast::<FakeVault>()) }
}

unsafe extern "C" fn fake_vault_availability(
    _host_context: *mut c_void,
    operation_id: u64,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostVaultAvailabilityCompletionV1,
) -> i32 {
    let result = CitizenSdkHostVaultAvailabilityResultV1 {
        host_operation_id: operation_id,
        availability: CitizenSdkHostVaultAvailability::Available as u32,
        ..CitizenSdkHostVaultAvailabilityResultV1::default()
    };
    // SAFETY: the result remains readable for this synchronous call.
    unsafe {
        completion.unwrap_or_else(|| panic!("availability completion is missing"))(
            sdk_context,
            &result,
        )
    };
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn fake_vault_ensure(
    host_context: *mut c_void,
    operation_id: u64,
    wallet_key: CitizenSdkHostWalletKeyRefV1,
    provisioning: CitizenSdkHostId128,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    // SAFETY: 合成金库由测试持有，持久创建归属和退休规则与平台一致。
    let fake = unsafe { fake_vault(host_context) };
    *fake.ensure_calls.lock().unwrap() += 1;
    let identity = (
        wallet_key.wallet_index,
        wallet_key.generation.bytes,
        provisioning.bytes,
    );
    let mut owner = fake.key_owner.lock().unwrap();
    if *fake.retired.lock().unwrap() || owner.as_ref().is_some_and(|old| *old != identity) {
        return CitizenSdkErrorCode::KeyInvalidated.as_i32();
    }
    *owner = Some(identity);
    drop(owner);
    // SAFETY: 同步完成后不保留任何输入借用。
    unsafe { complete_status_ok(operation_id, sdk_context, completion) };
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn fake_vault_has(
    host_context: *mut c_void,
    operation_id: u64,
    wallet_key: CitizenSdkHostWalletKeyRefV1,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostBoolCompletionV1,
) -> i32 {
    // SAFETY: 测试持有合成金库，存在性必须反映创建和退休后的实际状态。
    let fake = unsafe { fake_vault(host_context) };
    let present = !*fake.retired.lock().unwrap()
        && fake.key_owner.lock().unwrap().as_ref().is_some_and(|key| {
            key.0 == wallet_key.wallet_index && key.1 == wallet_key.generation.bytes
        });
    let result = CitizenSdkHostBoolResultV1 {
        host_operation_id: operation_id,
        value: u8::from(present),
        ..CitizenSdkHostBoolResultV1::default()
    };
    // SAFETY: the result remains readable for this synchronous call.
    unsafe {
        completion.unwrap_or_else(|| panic!("bool completion is missing"))(sdk_context, &result)
    };
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn fake_vault_wrap(
    host_context: *mut c_void,
    operation_id: u64,
    wallet_key: CitizenSdkHostWalletKeyRefV1,
    _provisioning_operation_id: CitizenSdkHostId128,
    plaintext_dek: CitizenSdkBytesView,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostBytesCompletionV1,
) -> i32 {
    // SAFETY: 合成提供者只允许使用既有活动钥，封装不会隐式创建。
    let fake = unsafe { fake_vault(host_context) };
    if *fake.retired.lock().unwrap()
        || !fake.key_owner.lock().unwrap().as_ref().is_some_and(|key| {
            key.0 == wallet_key.wallet_index && key.1 == wallet_key.generation.bytes
        })
    {
        return CitizenSdkErrorCode::KeyInvalidated.as_i32();
    }
    // SAFETY: the SDK lends this exact view for the callback duration.
    let dek = unsafe { borrowed_bytes(plaintext_dek) };
    assert_eq!(dek.len(), CITIZENSDK_HOST_DEK_BYTES as usize);
    unsafe { fake_vault(host_context) }
        .seen_plaintext_deks
        .lock()
        .unwrap_or_else(|_| panic!("fake vault DEK log is poisoned"))
        .push(dek.clone());
    let wrapped: Vec<u8> = dek.into_iter().map(|byte| byte ^ 0xa5).collect();
    let result = CitizenSdkHostBytesResultV1 {
        host_operation_id: operation_id,
        kind: CitizenSdkHostBytesKind::WrappedDek as u32,
        bytes: input_view(&wrapped),
        ..CitizenSdkHostBytesResultV1::default()
    };
    // SAFETY: the adapter copies the borrowed wrapped bytes synchronously.
    unsafe {
        completion.unwrap_or_else(|| panic!("wrapped DEK completion is missing"))(
            sdk_context,
            &result,
        )
    };
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn fake_vault_unwrap(
    host_context: *mut c_void,
    operation_id: u64,
    _wallet_key: CitizenSdkHostWalletKeyRefV1,
    wrapped_dek: CitizenSdkBytesView,
    plaintext_dek_out: CitizenSdkMutableBytesView,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    unsafe { fake_vault(host_context) }
        .unwrap_operations
        .lock()
        .unwrap_or_else(|_| panic!("测试操作记录锁损坏"))
        .push(operation_id);
    assert_eq!(plaintext_dek_out.len, CITIZENSDK_HOST_DEK_BYTES);
    assert!(!plaintext_dek_out.data.is_null());
    // SAFETY: both views are valid for this callback, and the SDK-owned
    // output remains exclusively lent until completion returns.
    let wrapped = unsafe { borrowed_bytes(wrapped_dek) };
    let mut dek: Vec<u8> = wrapped.into_iter().map(|byte| byte ^ 0xa5).collect();
    let mode = unsafe { fake_vault(host_context) }
        .unwrap_mode
        .load(Ordering::SeqCst);
    if mode == 2 {
        // Deterministically produce a different complete DEK. A constant
        // replacement has a theoretical chance of equalling the random
        // production DEK and would make this security test probabilistic.
        dek[0] ^= 0xff;
    } else if mode == 1 {
        let final_index = dek.len() - 1;
        // Poison the byte this mode intentionally omits. The SDK buffer is
        // zero-initialized, and an actual DEK may also end in zero; without
        // this sentinel a 31-byte host write could accidentally authenticate.
        // SAFETY: the callback contract provides one writable 32-byte
        // buffer, and `final_index` is the last index of the 32-byte DEK.
        unsafe {
            plaintext_dek_out
                .data
                .add(final_index)
                .write(dek[final_index] ^ 0xff)
        };
    }
    let copied = if mode == 1 { dek.len() - 1 } else { dek.len() };
    // SAFETY: output is exactly 32 bytes, and wrapped DEKs produced by this
    // fake are exactly 32 bytes. Mode 1 intentionally leaves one byte
    // unequal to the expected DEK so AES-GCM must reject the incomplete
    // result.
    unsafe { std::ptr::copy_nonoverlapping(dek.as_ptr(), plaintext_dek_out.data, copied) };
    dek.zeroize();
    // SAFETY: completion terminates the mutable output borrow.
    unsafe { complete_status_ok(operation_id, sdk_context, completion) };
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn fake_vault_authorize_add_accounts(
    host_context: *mut c_void,
    operation_id: u64,
    _key: CitizenSdkHostWalletKeyRefV1,
    _provisioning: CitizenSdkHostId128,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    let fake = unsafe { fake_vault(host_context) };
    if *fake.retired.lock().unwrap() || fake.key_owner.lock().unwrap().is_none() {
        return CitizenSdkErrorCode::KeyInvalidated.as_i32();
    }
    // 合成认证仅回报状态，绝不能调用创建或解封来制造成功。
    unsafe { complete_status_ok(operation_id, sdk_context, completion) };
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn fake_vault_retire(
    host_context: *mut c_void,
    operation_id: u64,
    _wallet_key: CitizenSdkHostWalletKeyRefV1,
    _cleanup_operation_id: CitizenSdkHostId128,
    sdk_context: *mut c_void,
    completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    // SAFETY: 退休只改变本测试拥有的合成金库。
    *unsafe { fake_vault(host_context) }.retired.lock().unwrap() = true;
    // SAFETY: the fake completes synchronously after its durable no-op.
    unsafe { complete_status_ok(operation_id, sdk_context, completion) };
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn fake_wallet_key_presence(
    context: *mut c_void,
    operation: u64,
    wallet: u32,
    token: *mut c_void,
    complete: CitizenSdkHostBoolCompletionV1,
) -> i32 {
    let state = unsafe { fake_vault(context) };
    let present = state
        .key_owner
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|key| key.0 == wallet)
        && !*state.retired.lock().unwrap();
    let result = CitizenSdkHostBoolResultV1 {
        host_operation_id: operation,
        value: u8::from(present),
        ..CitizenSdkHostBoolResultV1::default()
    };
    unsafe { complete.unwrap()(token, &result) };
    CitizenSdkErrorCode::Ok.as_i32()
}

fn vault_harness() -> (Box<FakeVault>, HostSecretVault, Arc<HostBridge>) {
    let mut fake = Box::<FakeVault>::default();
    let context = (&mut *fake as *mut FakeVault).cast::<c_void>();
    let vtable = CitizenSdkHostSecretVaultV1 {
        context,
        availability: Some(fake_vault_availability),
        ensure_wallet_kek: Some(fake_vault_ensure),
        has_wallet_kek: Some(fake_vault_has),
        wrap_dek: Some(fake_vault_wrap),
        unwrap_dek: Some(fake_vault_unwrap),
        retire_wallet_kek: Some(fake_vault_retire),
        authorize_add_accounts: Some(fake_vault_authorize_add_accounts),
        has_any_wallet_key: Some(fake_wallet_key_presence),
        ..CitizenSdkHostSecretVaultV1::default()
    };
    let bridge = test_bridge(Some(vtable));
    let vault = HostSecretVault {
        bridge: Arc::clone(&bridge),
        authorizing: None,
    };
    (fake, vault, bridge)
}

#[test]
fn add_authorization_never_initializes_or_unwraps_a_key() {
    let (fake, vault, _bridge) = vault_harness();
    let generation = VaultGeneration::from_bytes([81; 16]);
    assert!(block_on(vault.authorize_add_accounts([82; 16], 0, generation)).is_err());
    block_on(vault.ensure_wallet_key([83; 16], 0, generation)).unwrap();
    block_on(vault.authorize_add_accounts([82; 16], 0, generation)).unwrap();
    assert_eq!(*fake.ensure_calls.lock().unwrap(), 1);
    assert!(fake.unwrap_operations.lock().unwrap().is_empty());
    assert!(fake.seen_plaintext_deks.lock().unwrap().is_empty());
    *fake.retired.lock().unwrap() = true;
    assert!(block_on(vault.authorize_add_accounts([84; 16], 0, generation)).is_err());
}

#[test]
fn wrapping_reuses_initialized_key_without_rebinding_and_retirement_stays_final() {
    let (fake, vault, bridge) = vault_harness();
    let secret_ref = test_secret_ref(1, 2, 3, 4);
    let seal = || {
        block_on(vault.seal(
            [8; 16],
            secret_ref,
            SecretBuffer::try_new(vec![6; 32]).unwrap(),
        ))
    };
    assert_eq!(
        seal().unwrap_err().code(),
        ContractErrorCode::KeyInvalidated
    );
    assert_eq!(*fake.ensure_calls.lock().unwrap(), 0);
    assert!(
        !block_on(vault.has_wallet_key(secret_ref.wallet_index(), secret_ref.generation()))
            .unwrap()
    );
    block_on(vault.ensure_wallet_key([5; 16], secret_ref.wallet_index(), secret_ref.generation()))
        .unwrap();
    assert!(seal().is_ok(), "另一追加操作应复用原钥");
    assert!(
        block_on(vault.has_wallet_key(secret_ref.wallet_index(), secret_ref.generation())).unwrap()
    );
    assert_eq!(*fake.ensure_calls.lock().unwrap(), 1);
    assert_eq!(
        block_on(vault.ensure_wallet_key(
            [8; 16],
            secret_ref.wallet_index(),
            secret_ref.generation()
        ))
        .unwrap_err()
        .code(),
        ContractErrorCode::KeyInvalidated,
        "另一操作不能抢占创建归属"
    );
    block_on(vault.delete_wallet_key([9; 16], secret_ref.wallet_index(), secret_ref.generation()))
        .unwrap();
    assert!(
        !block_on(vault.has_wallet_key(secret_ref.wallet_index(), secret_ref.generation()))
            .unwrap()
    );
    assert_eq!(
        seal().unwrap_err().code(),
        ContractErrorCode::KeyInvalidated
    );
    assert_eq!(
        block_on(vault.ensure_wallet_key(
            [5; 16],
            secret_ref.wallet_index(),
            secret_ref.generation()
        ))
        .unwrap_err()
        .code(),
        ContractErrorCode::KeyInvalidated
    );
    assert_eq!(bridge.pending_count().unwrap(), 0);
}

fn rebuild_envelope(
    original: &EncryptedSecretEnvelope,
    digest: [u8; 32],
    ciphertext: Vec<u8>,
) -> EncryptedSecretEnvelope {
    EncryptedSecretEnvelope::try_new(
        original.format_version(),
        Hash32Bytes::from_bytes(digest),
        ciphertext,
    )
    .unwrap_or_else(|error| panic!("test envelope rebuild failed: {error}"))
}

#[test]
fn private_view_authorizing_uses_actual_operation_id_and_rejection_drains_without_unwrap() {
    let (fake, ordinary, bridge) = vault_harness();
    let secret_ref = test_secret_ref(7, 8, 9, 10);
    block_on(ordinary.ensure_wallet_key(
        [11; 16],
        secret_ref.wallet_index(),
        secret_ref.generation(),
    ))
    .unwrap();
    // 复用既有公开测试材料，只记录非秘密 operation_id，不打印密钥或密文。
    let envelope = block_on(ordinary.seal(
        [11; 16],
        secret_ref,
        SecretBuffer::try_new(vec![0x37; 32]).unwrap_or_else(|_| panic!("公开测试材料")),
    ))
    .unwrap_or_else(|_| panic!("fixture seal"));
    for code in [
        CitizenSdkErrorCode::Cancelled as i32,
        CitizenSdkErrorCode::Integrity as i32,
        -1,
    ] {
        let notified = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&notified);
        let view_vault = HostSecretVault {
            bridge: Arc::clone(&bridge),
            authorizing: Some(Arc::new(move |id| {
                recorded
                    .lock()
                    .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
                    .push(id);
                code
            })),
        };
        assert!(block_on(view_vault.open(secret_ref, envelope.clone())).is_err());
        assert_eq!(
            notified
                .lock()
                .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
                .len(),
            1
        );
        assert!(fake
            .unwrap_operations
            .lock()
            .unwrap_or_else(|_| panic!("测试操作记录锁损坏"))
            .is_empty());
        assert_eq!(
            bridge.pending_count().unwrap_or_else(|_| panic!("pending")),
            0
        );
    }
    let notified = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&notified);
    let view_vault = HostSecretVault {
        bridge: Arc::clone(&bridge),
        authorizing: Some(Arc::new(move |id| {
            recorded
                .lock()
                .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
                .push(id);
            0
        })),
    };
    drop(
        block_on(view_vault.open(secret_ref, envelope.clone()))
            .unwrap_or_else(|_| panic!("view open")),
    );
    let notifications = notified
        .lock()
        .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
        .clone();
    assert_eq!(
        notifications,
        *fake
            .unwrap_operations
            .lock()
            .unwrap_or_else(|_| panic!("测试操作记录锁损坏"))
    );
    assert_ne!(notifications[0], 0);
    drop(block_on(ordinary.open(secret_ref, envelope)).unwrap_or_else(|_| panic!("ordinary open")));
    assert_eq!(
        notified
            .lock()
            .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
            .len(),
        1,
        "同 HostBridge 普通认证不应误带查看归属"
    );
    assert_eq!(
        bridge.pending_count().unwrap_or_else(|_| panic!("pending")),
        0
    );
}

#[test]
fn rust_aes_gcm_round_trip_binds_every_secret_ref_field_and_hides_the_secret() {
    let (fake, vault, bridge) = vault_harness();
    let expected = test_secret_ref(7, 8, 9, 10);
    block_on(vault.ensure_wallet_key([11; 16], expected.wallet_index(), expected.generation()))
        .unwrap();
    let plaintext = vec![0x37; 32];
    let envelope = block_on(
        vault.seal(
            [11; 16],
            expected,
            SecretBuffer::try_new(plaintext.clone())
                .unwrap_or_else(|error| panic!("secret fixture failed: {error}")),
        ),
    )
    .unwrap_or_else(|error| panic!("vault seal failed: {error}"));
    let second = block_on(
        vault.seal(
            [12; 16],
            expected,
            SecretBuffer::try_new(plaintext.clone())
                .unwrap_or_else(|error| panic!("second secret fixture failed: {error}")),
        ),
    )
    .unwrap_or_else(|error| panic!("second vault seal failed: {error}"));

    let opened = block_on(vault.open(expected, envelope.clone()))
        .unwrap_or_else(|error| panic!("vault open failed: {error}"));
    opened.with_secret(|bytes| assert_eq!(bytes, plaintext));

    let seen = fake
        .seen_plaintext_deks
        .lock()
        .unwrap_or_else(|_| panic!("fake vault DEK log is poisoned"));
    assert_eq!(seen.len(), 2);
    assert!(seen.iter().all(|dek| dek.len() == 32 && dek != &plaintext));
    assert_ne!(
        seen[0], seen[1],
        "each envelope requires a fresh random DEK"
    );
    drop(seen);
    assert_ne!(envelope.ciphertext(), second.ciphertext());

    for crossed in [
        test_secret_ref(6, 8, 9, 10),
        test_secret_ref(7, 7, 9, 10),
        test_secret_ref(7, 8, 8, 10),
        test_secret_ref(7, 8, 9, 11),
    ] {
        assert_eq!(
            block_on(vault.open(crossed, envelope.clone()))
                .err()
                .unwrap_or_else(|| panic!("crossed SecretRef must fail"))
                .code(),
            ContractErrorCode::Integrity
        );
    }

    // SecretKind has one constructible v1 value.  Prove its explicit tag
    // is part of AAD; a future/host-forged kind tag cannot reuse ciphertext.
    let mut different_kind_aad = secret_aad(expected);
    *different_kind_aad
        .last_mut()
        .unwrap_or_else(|| panic!("AAD kind tag is missing")) = 2;
    let different_kind_digest: [u8; 32] = Sha256::digest(&different_kind_aad).into();
    let different_kind = rebuild_envelope(
        &envelope,
        different_kind_digest,
        envelope.ciphertext().to_vec(),
    );
    assert_eq!(
        block_on(vault.open(expected, different_kind))
            .err()
            .unwrap_or_else(|| panic!("different kind digest must fail"))
            .code(),
        ContractErrorCode::Integrity
    );
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("pending count failed: {error}")),
        0
    );
}

#[test]
fn vault_envelope_rejects_truncation_tampering_and_incomplete_unwrap() {
    let (fake, vault, _) = vault_harness();
    let secret_ref = test_secret_ref(1, 2, 3, 4);
    block_on(vault.ensure_wallet_key([5; 16], secret_ref.wallet_index(), secret_ref.generation()))
        .unwrap();
    let envelope = block_on(
        vault.seal(
            [5; 16],
            secret_ref,
            SecretBuffer::try_new(vec![6; 32])
                .unwrap_or_else(|error| panic!("secret fixture failed: {error}")),
        ),
    )
    .unwrap_or_else(|error| panic!("vault seal failed: {error}"));
    let digest = *envelope.associated_data_digest().as_bytes();

    let mut truncated = envelope.ciphertext().to_vec();
    let _ = truncated.pop();
    assert!(
        block_on(vault.open(secret_ref, rebuild_envelope(&envelope, digest, truncated))).is_err()
    );

    let mut nonce_tamper = envelope.ciphertext().to_vec();
    nonce_tamper[8] ^= 1;
    assert_eq!(
        block_on(vault.open(
            secret_ref,
            rebuild_envelope(&envelope, digest, nonce_tamper)
        ))
        .err()
        .unwrap_or_else(|| panic!("nonce tamper must fail"))
        .code(),
        ContractErrorCode::Integrity
    );

    let wrapped_len = u32::from_le_bytes(
        envelope.ciphertext()[20..24]
            .try_into()
            .unwrap_or_else(|_| panic!("wrapped length fixture is malformed")),
    ) as usize;
    let mut wrapped_tamper = envelope.ciphertext().to_vec();
    wrapped_tamper[28] ^= 1;
    assert!(block_on(vault.open(
        secret_ref,
        rebuild_envelope(&envelope, digest, wrapped_tamper)
    ))
    .is_err());

    let mut ciphertext_tamper = envelope.ciphertext().to_vec();
    ciphertext_tamper[28 + wrapped_len] ^= 1;
    assert!(block_on(vault.open(
        secret_ref,
        rebuild_envelope(&envelope, digest, ciphertext_tamper)
    ))
    .is_err());

    let mut bad_wrapped_length = envelope.ciphertext().to_vec();
    bad_wrapped_length[20..24].copy_from_slice(&0_u32.to_le_bytes());
    assert!(block_on(vault.open(
        secret_ref,
        rebuild_envelope(&envelope, digest, bad_wrapped_length)
    ))
    .is_err());

    fake.unwrap_mode.store(1, Ordering::SeqCst);
    assert_eq!(
        block_on(vault.open(secret_ref, envelope.clone()))
            .err()
            .unwrap_or_else(|| panic!("incomplete unwrap must fail authentication"))
            .code(),
        ContractErrorCode::Integrity
    );
    fake.unwrap_mode.store(2, Ordering::SeqCst);
    assert!(block_on(vault.open(secret_ref, envelope)).is_err());

    let mut short_output = [0_u8; 31];
    assert_eq!(
        validate_mutable_dek_view(CitizenSdkMutableBytesView {
            data: short_output.as_mut_ptr(),
            len: short_output.len() as u64,
        })
        .err()
        .unwrap_or_else(|| panic!("non-32-byte output must fail"))
        .code(),
        CitizenSdkErrorCode::InvalidArgument
    );
}

#[test]
fn wrong_completion_kind_and_duplicate_never_settle_another_operation() {
    let bridge = test_bridge(None);
    let (bool_id, bool_receiver) = reserve_host_operation(bridge.owner_id, PendingKind::Bool, None)
        .unwrap_or_else(|error| panic!("bool reserve failed: {error}"));
    let status = CitizenSdkHostStatusResultV1 {
        host_operation_id: bool_id,
        ..CitizenSdkHostStatusResultV1::default()
    };
    unsafe { production_status_completion(operation_token(bool_id), &status) };
    unsafe { production_status_completion(operation_token(bool_id), &status) };
    let error = block_on(bool_receiver)
        .unwrap_or_else(|_| panic!("bool receiver was cancelled"))
        .err()
        .unwrap_or_else(|| panic!("wrong completion kind must fail"));
    assert_eq!(error.code(), ContractErrorCode::Integrity);
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("pending count failed: {error}")),
        0
    );
}

#[test]
fn every_non_null_completion_rejects_crossed_real_identities_before_claim() {
    let bridge = test_bridge(None);
    let (status_id, mut status_receiver) = bridge
        .reserve_operation(PendingKind::Status, None)
        .unwrap_or_else(|error| panic!("status reserve failed: {error}"));
    let (bool_id, mut bool_receiver) = bridge
        .reserve_operation(PendingKind::Bool, None)
        .unwrap_or_else(|error| panic!("bool reserve failed: {error}"));
    let (availability_id, mut availability_receiver) = bridge
        .reserve_operation(PendingKind::VaultAvailability, None)
        .unwrap_or_else(|error| panic!("availability reserve failed: {error}"));
    let (wrapped_id, mut wrapped_receiver) = bridge
        .reserve_operation(
            PendingKind::WrappedDek,
            Some(Zeroizing::new(vec![
                0x11;
                CITIZENSDK_HOST_DEK_BYTES as usize
            ])),
        )
        .unwrap_or_else(|error| panic!("wrapped DEK reserve failed: {error}"));
    let (unwrapped_id, mut unwrapped_receiver) = bridge
        .reserve_operation(
            PendingKind::UnwrappedDek,
            Some(Zeroizing::new(vec![
                0x22;
                CITIZENSDK_HOST_DEK_BYTES as usize
            ])),
        )
        .unwrap_or_else(|error| panic!("unwrapped DEK reserve failed: {error}"));

    // Every result deliberately carries another live operation's ID. The
    // callback receives its own real token, so none of the five operations
    // may move from pending to completing or settle its receiver.
    let status_result = CitizenSdkHostStatusResultV1 {
        host_operation_id: bool_id,
        ..CitizenSdkHostStatusResultV1::default()
    };
    unsafe { production_status_completion(operation_token(status_id), &status_result) };
    assert_host_operation_unclaimed(status_id, PendingKind::Status, &mut status_receiver);

    let bool_result = CitizenSdkHostBoolResultV1 {
        host_operation_id: availability_id,
        ..CitizenSdkHostBoolResultV1::default()
    };
    unsafe { production_bool_completion(operation_token(bool_id), &bool_result) };
    assert_host_operation_unclaimed(bool_id, PendingKind::Bool, &mut bool_receiver);

    let availability_result = CitizenSdkHostVaultAvailabilityResultV1 {
        host_operation_id: wrapped_id,
        ..CitizenSdkHostVaultAvailabilityResultV1::default()
    };
    unsafe {
        production_vault_availability_completion(
            operation_token(availability_id),
            &availability_result,
        )
    };
    assert_host_operation_unclaimed(
        availability_id,
        PendingKind::VaultAvailability,
        &mut availability_receiver,
    );

    let wrapped_result = CitizenSdkHostBytesResultV1 {
        host_operation_id: unwrapped_id,
        kind: CitizenSdkHostBytesKind::WrappedDek as u32,
        ..CitizenSdkHostBytesResultV1::default()
    };
    unsafe { production_wrapped_dek_completion(operation_token(wrapped_id), &wrapped_result) };
    assert_host_operation_unclaimed(wrapped_id, PendingKind::WrappedDek, &mut wrapped_receiver);

    let unwrapped_result = CitizenSdkHostStatusResultV1 {
        host_operation_id: status_id,
        ..CitizenSdkHostStatusResultV1::default()
    };
    unsafe { production_status_completion(operation_token(unwrapped_id), &unwrapped_result) };
    assert_host_operation_unclaimed(
        unwrapped_id,
        PendingKind::UnwrappedDek,
        &mut unwrapped_receiver,
    );
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("crossed completion scan failed: {error}")),
        5
    );

    // Null results have no result ID to cross-check and intentionally
    // remain terminal for the operation selected by their real token.
    unsafe {
        production_status_completion(operation_token(status_id), std::ptr::null());
        production_bool_completion(operation_token(bool_id), std::ptr::null());
        production_vault_availability_completion(
            operation_token(availability_id),
            std::ptr::null(),
        );
        production_wrapped_dek_completion(operation_token(wrapped_id), std::ptr::null());
        production_status_completion(operation_token(unwrapped_id), std::ptr::null());
    }
    assert_terminal_integrity(status_receiver);
    assert_terminal_integrity(bool_receiver);
    assert_terminal_integrity(availability_receiver);
    assert_terminal_integrity(wrapped_receiver);
    assert_terminal_integrity(unwrapped_receiver);
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("post-null completion scan failed: {error}")),
        0
    );
}

#[test]
fn mismatched_result_id_is_ignored_but_null_first_completion_is_terminal() {
    let bridge = test_bridge(None);
    let (status_id, mut status_receiver) = bridge
        .reserve_operation(PendingKind::Status, None)
        .unwrap_or_else(|error| panic!("status reserve failed: {error}"));
    let wrong_id = CitizenSdkHostStatusResultV1 {
        host_operation_id: 0,
        ..CitizenSdkHostStatusResultV1::default()
    };
    unsafe { production_status_completion(operation_token(status_id), &wrong_id) };
    assert_host_operation_unclaimed(status_id, PendingKind::Status, &mut status_receiver);

    unsafe { production_status_completion(operation_token(status_id), std::ptr::null()) };
    assert_terminal_integrity(status_receiver);

    // A later non-null completion cannot repair the null-terminated op.
    let corrected = CitizenSdkHostStatusResultV1 {
        host_operation_id: status_id,
        ..CitizenSdkHostStatusResultV1::default()
    };
    unsafe { production_status_completion(operation_token(status_id), &corrected) };

    let (bool_id, bool_receiver) = bridge
        .reserve_operation(PendingKind::Bool, None)
        .unwrap_or_else(|error| panic!("bool reserve failed: {error}"));
    unsafe { production_bool_completion(operation_token(bool_id), std::ptr::null()) };
    let error = block_on(bool_receiver)
        .unwrap_or_else(|_| panic!("bool receiver was cancelled"))
        .err()
        .unwrap_or_else(|| panic!("null first completion must fail"));
    assert_eq!(error.code(), ContractErrorCode::Integrity);
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("pending count failed: {error}")),
        0
    );
}

#[test]
fn unknown_synchronous_status_rejects_without_leaking_pending_state() {
    let bridge = test_bridge(None);
    let error = block_on(bridge.call_status(|_, _, _| i32::MAX))
        .err()
        .unwrap_or_else(|| panic!("unknown host status must fail"));
    assert_eq!(error.code(), ContractErrorCode::Internal);
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|count| panic!("pending count failed: {count}")),
        0
    );
}

#[test]
fn operation_gate_linearizes_close_reserve_scan_and_reopen() {
    use std::{sync::Barrier, thread};

    let bridge = test_bridge(None);
    bridge
        .close_operation_gate()
        .unwrap_or_else(|error| panic!("initial gate close failed: {error}"));
    bridge
        .close_operation_gate()
        .unwrap_or_else(|error| panic!("idempotent gate close failed: {error}"));
    assert_eq!(
        bridge
            .reserve_operation(PendingKind::Status, None)
            .err()
            .unwrap_or_else(|| panic!("closed gate must reject"))
            .code(),
        ContractErrorCode::InvalidState
    );
    bridge
        .reopen_operation_gate()
        .unwrap_or_else(|error| panic!("gate reopen failed: {error}"));
    bridge
        .reopen_operation_gate()
        .unwrap_or_else(|error| panic!("idempotent gate reopen failed: {error}"));

    for _ in 0..32 {
        bridge
            .reopen_operation_gate()
            .unwrap_or_else(|error| panic!("loop gate reopen failed: {error}"));
        let barrier = Arc::new(Barrier::new(2));
        let reserve_bridge = Arc::clone(&bridge);
        let reserve_barrier = Arc::clone(&barrier);
        let reserve = thread::spawn(move || {
            reserve_barrier.wait();
            reserve_bridge.reserve_operation(PendingKind::Status, None)
        });
        barrier.wait();
        bridge
            .close_operation_gate()
            .unwrap_or_else(|error| panic!("racing gate close failed: {error}"));
        let reserved = reserve
            .join()
            .unwrap_or_else(|_| panic!("reserve thread panicked"));
        match reserved {
            Ok((operation_id, receiver)) => {
                // If reserve linearized first, the entry is already visible
                // when close returns and therefore cannot be missed by scan.
                assert_eq!(
                    bridge.pending_count().unwrap_or_else(|error| {
                        panic!("post-close pending scan failed: {error}")
                    }),
                    1
                );
                drop(receiver);
                let result = CitizenSdkHostStatusResultV1 {
                    host_operation_id: operation_id,
                    ..CitizenSdkHostStatusResultV1::default()
                };
                unsafe { production_status_completion(operation_token(operation_id), &result) };
            }
            Err(error) => {
                // If close linearized first, the reserve is rejected and no
                // hidden pending entry exists.
                assert_eq!(error.code(), ContractErrorCode::InvalidState);
                assert_eq!(
                    bridge
                        .pending_count()
                        .unwrap_or_else(|count| { panic!("closed pending scan failed: {count}") }),
                    0
                );
            }
        }
    }
    bridge
        .reopen_operation_gate()
        .unwrap_or_else(|error| panic!("final gate reopen failed: {error}"));
}

#[test]
fn claimed_completion_remains_outstanding_until_sdk_completion_finishes() {
    use std::{sync::mpsc, thread};

    let bridge = test_bridge(None);
    let (operation_id, receiver) = bridge
        .reserve_operation(PendingKind::Status, None)
        .unwrap_or_else(|error| panic!("status reserve failed: {error}"));
    bridge
        .close_operation_gate()
        .unwrap_or_else(|error| panic!("host gate close failed: {error}"));

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let completion = thread::spawn(move || {
        complete_host_operation(operation_id, PendingKind::Status, move |_, _| {
            entered_tx
                .send(())
                .unwrap_or_else(|error| panic!("completion entry signal failed: {error}"));
            release_rx
                .recv()
                .unwrap_or_else(|error| panic!("completion release signal failed: {error}"));
            Ok(HostCompletion::Status(CitizenSdkErrorCode::Ok))
        });
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("completion was not claimed: {error}"));

    // This is the exact outstanding scan used by destroy after closing the
    // host-operation gate. The pending entry has already been claimed, but
    // the completion path still validates/copies host memory and must keep
    // destroy in BUSY rather than allowing instance-owned state to be freed.
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("completion scan failed: {error}")),
        1
    );

    release_tx
        .send(())
        .unwrap_or_else(|error| panic!("completion release failed: {error}"));
    completion
        .join()
        .unwrap_or_else(|_| panic!("completion thread panicked"));
    assert!(matches!(
        block_on(receiver).unwrap_or_else(|_| panic!("completion receiver was cancelled")),
        Ok(HostCompletion::Status(CitizenSdkErrorCode::Ok))
    ));
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("post-completion scan failed: {error}")),
        0
    );
    bridge
        .reopen_operation_gate()
        .unwrap_or_else(|error| panic!("host gate reopen failed: {error}"));
}

#[test]
fn cancelled_future_keeps_pending_state_until_safe_late_completion() {
    let bridge = test_bridge(None);
    let deferred = Arc::new(Mutex::new(None));
    let captured = Arc::clone(&deferred);
    let mut future = Box::pin(
        bridge.call_status(move |operation_id, sdk_context, completion| {
            *captured
                .lock()
                .unwrap_or_else(|_| panic!("deferred completion is poisoned")) =
                Some((operation_id, sdk_context as usize, completion));
            CitizenSdkErrorCode::Ok.as_i32()
        }),
    );
    let mut context = Context::from_waker(noop_waker_ref());
    assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("pending count failed: {error}")),
        1
    );
    drop(future);

    let (operation_id, sdk_context, completion) = deferred
        .lock()
        .unwrap_or_else(|_| panic!("deferred completion is poisoned"))
        .take()
        .unwrap_or_else(|| panic!("dispatch did not capture completion"));
    let result = CitizenSdkHostStatusResultV1 {
        host_operation_id: operation_id,
        ..CitizenSdkHostStatusResultV1::default()
    };
    unsafe {
        completion.unwrap_or_else(|| panic!("deferred completion is missing"))(
            sdk_context as *mut c_void,
            &result,
        )
    };
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("pending count failed: {error}")),
        0
    );
    // Duplicate late completion is a safe no-op and never dereferences an
    // instance pointer (sdk_context is only the integer operation token).
    unsafe {
        completion.unwrap_or_else(|| panic!("deferred completion is missing"))(
            sdk_context as *mut c_void,
            &result,
        )
    };
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("pending count failed: {error}")),
        0
    );
}

#[test]
fn cancelled_wrap_future_keeps_rust_owned_dek_valid_only_until_completion() {
    let bridge = test_bridge(None);
    let expected_dek = vec![0x93; CITIZENSDK_HOST_DEK_BYTES as usize];
    let deferred = Arc::new(Mutex::new(None));
    let captured = Arc::clone(&deferred);
    let mut future = Box::pin(bridge.call_wrap_dek(
        Zeroizing::new(expected_dek.clone()),
        move |operation_id, plaintext_dek, sdk_context, completion| {
            *captured
                .lock()
                .unwrap_or_else(|_| panic!("deferred wrap is poisoned")) = Some((
                operation_id,
                plaintext_dek.data as usize,
                plaintext_dek.len,
                sdk_context as usize,
                completion,
            ));
            CitizenSdkErrorCode::Ok.as_i32()
        },
    ));
    let mut context = Context::from_waker(noop_waker_ref());
    assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
    drop(future);

    let (operation_id, dek_pointer, dek_len, sdk_context, completion) = deferred
        .lock()
        .unwrap_or_else(|_| panic!("deferred wrap is poisoned"))
        .take()
        .unwrap_or_else(|| panic!("wrap dispatch did not run"));
    assert_eq!(dek_len, CITIZENSDK_HOST_DEK_BYTES);
    // SAFETY: cancellation drops only the receiver; the pending registry
    // owns this zeroizing buffer until the first completion below.
    assert_eq!(
        unsafe {
            std::slice::from_raw_parts(
                dek_pointer as *const u8,
                usize::try_from(dek_len).unwrap_or_else(|_| panic!("DEK length exceeds usize")),
            )
        },
        expected_dek
    );
    let wrapped = vec![0x39; 32];
    let result = CitizenSdkHostBytesResultV1 {
        host_operation_id: operation_id,
        kind: CitizenSdkHostBytesKind::WrappedDek as u32,
        bytes: input_view(&wrapped),
        ..CitizenSdkHostBytesResultV1::default()
    };
    unsafe {
        completion.unwrap_or_else(|| panic!("wrap completion is missing"))(
            sdk_context as *mut c_void,
            &result,
        )
    };
    assert_eq!(
        bridge
            .pending_count()
            .unwrap_or_else(|error| panic!("pending count failed: {error}")),
        0
    );
    // The pointer is deliberately never read after completion: its owner
    // has zeroized and released the allocation at that linearization point.
}

#[test]
fn vault_table_requires_each_physical_callback_before_use() {
    let (fake, vault, _) = vault_harness();
    let config = vault.bridge.vault.unwrap().0;
    validate_secret_vault_v1(&config).unwrap();
    let missing: [fn(&mut CitizenSdkHostSecretVaultV1); 8] = [
        |v| v.availability = None,
        |v| v.ensure_wallet_kek = None,
        |v| v.has_wallet_kek = None,
        |v| v.wrap_dek = None,
        |v| v.unwrap_dek = None,
        |v| v.retire_wallet_kek = None,
        |v| v.authorize_add_accounts = None,
        |v| v.has_any_wallet_key = None,
    ];
    for remove in missing {
        let mut value = config;
        remove(&mut value);
        assert!(validate_secret_vault_v1(&value).is_err());
    }
    let mut value = config;
    value.struct_size -= 1;
    assert!(validate_secret_vault_v1(&value).is_err());
    value = config;
    value.abi_version += 1;
    assert!(validate_secret_vault_v1(&value).is_err());
    assert_eq!(*fake.ensure_calls.lock().unwrap(), 0);
    assert!(fake.unwrap_operations.lock().unwrap().is_empty());
    assert!(fake.seen_plaintext_deks.lock().unwrap().is_empty());
}

#[test]
fn physical_key_presence_uses_the_same_vault_and_tracks_retirement() {
    let (fake, vault, _) = vault_harness();
    assert!(!block_on(vault.has_any_wallet_key(7)).unwrap());
    let generation = VaultGeneration::from_bytes([71; 16]);
    block_on(vault.ensure_wallet_key([72; 16], 7, generation)).unwrap();
    assert!(block_on(vault.has_any_wallet_key(7)).unwrap());
    assert!(!block_on(vault.has_any_wallet_key(8)).unwrap());
    block_on(vault.delete_wallet_key([73; 16], 7, generation)).unwrap();
    assert!(!block_on(vault.has_any_wallet_key(7)).unwrap());
    assert_eq!(*fake.ensure_calls.lock().unwrap(), 1);
    assert!(fake.unwrap_operations.lock().unwrap().is_empty());
}
