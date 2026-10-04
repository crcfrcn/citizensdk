use std::{
    collections::{hash_map::Entry, HashMap},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
};

use citizen_sdk_contracts::{
    AccountNonce, ChainSyncStatus, ExecutionConclusion, ExportedChainState, ExtrinsicWatchEvent,
    FinalizedAccountBalance, Hash32, PreparedTransactionSummary, RuntimeContext, SecretBuffer,
    SigningCompletion, Sr25519Signature, TransactionExecutionCompleted, TransactionExecutionId,
    TransactionHistoryPage, VerifiedBlockBody, VerifiedBlockHeader, VerifiedBlockRef,
    WalletProfile,
};
use citizen_sdk_engine::WalletStateSnapshot;

#[derive(Clone, Debug)]
pub(crate) struct ExternalSigningPending {
    pub(crate) account_id: citizen_sdk_contracts::AccountId32,
    pub(crate) payload_hash: Hash32,
    pub(crate) expires_at: u64,
    pub(crate) session_id: String,
    pub(crate) transport_request: String,
}

#[derive(Clone, Debug)]
pub(crate) enum SigningOutcomePayload {
    Completed(SigningCompletion),
    ExternalPending(ExternalSigningPending),
}

#[derive(Clone, Debug)]
pub(crate) enum DefaultAccountChangePayload {
    Completed {
        current_default_account_id: citizen_sdk_contracts::AccountId32,
        payload_hash: Hash32,
        committed_revision: u64,
    },
    ExternalPending(ExternalSigningPending),
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PreparedTransactionPayload {
    pub(crate) handle: crate::abi::CitizenSdkPreparedTransactionHandle,
    pub(crate) summary: PreparedTransactionSummary,
}

#[derive(Clone, Debug)]
pub(crate) struct TransactionExternalSigningPending {
    pub(crate) execution_id: TransactionExecutionId,
    pub(crate) source_account_id: citizen_sdk_contracts::AccountId32,
    pub(crate) call_data_hash: Hash32,
    pub(crate) external: ExternalSigningPending,
}

#[derive(Clone, Debug)]
pub(crate) enum TransactionExecutionPayload {
    ExternalPending(TransactionExternalSigningPending),
    Completed(TransactionExecutionCompleted),
}
#[cfg(feature = "chain")]
use citizen_sdk_engine::BestFeeSnapshot;

use crate::{
    abi::{
        CitizenSdkErrorCode, CitizenSdkFailureStage, CitizenSdkResultHandle, CitizenSdkResultInfo,
        CitizenSdkResultKind,
    },
    error::{FfiError, FfiResult},
};

#[derive(Clone, Debug)]
pub enum ResultPayload {
    Empty,
    Block(VerifiedBlockRef),
    Storage(Option<Vec<u8>>),
    StorageBatch(Vec<Option<Vec<u8>>>),
    RuntimeContext(RuntimeContext),
    Hash(Hash32),
    Execution(ExecutionConclusion),
    Watch(ExtrinsicWatchEvent),
    ExportedState(ExportedChainState),
    AccountBalance(FinalizedAccountBalance),
    AccountBalances(Vec<FinalizedAccountBalance>),
    AccountNonce(AccountNonce),
    #[cfg(feature = "chain")]
    FeeSnapshot(BestFeeSnapshot),
    WalletProfile(Option<WalletProfile>),
    Signature(Sr25519Signature),
    PreparedWallet(u64),
    TransactionHistoryPage(TransactionHistoryPage),
    #[cfg(feature = "qr")]
    QrReview(std::sync::Arc<crate::qr_abi::QrReviewResult>),
    #[cfg(feature = "qr")]
    QrSigned(String),
    WalletState(Box<WalletStateSnapshot>),
    SigningOutcome(SigningOutcomePayload),
    DefaultAccountChange(DefaultAccountChangePayload),
    ChainSyncStatus(ChainSyncStatus),
    BlockHeader(VerifiedBlockHeader),
    BlockBody(VerifiedBlockBody),
    PreparedTransaction(PreparedTransactionPayload),
    TransactionExecution(TransactionExecutionPayload),
    ApplicationKey(std::sync::Arc<SecretBuffer>),
    ApplicationKeys(std::sync::Arc<SecretBuffer>),
    ApplicationKeyPreparation(std::sync::Arc<SecretBuffer>, Option<Sr25519Signature>),
}

impl ResultPayload {
    pub const fn kind(&self) -> CitizenSdkResultKind {
        match self {
            Self::Empty => CitizenSdkResultKind::Empty,
            Self::Block(_) => CitizenSdkResultKind::BlockRef,
            Self::Storage(_) => CitizenSdkResultKind::StorageValue,
            Self::StorageBatch(_) => CitizenSdkResultKind::StorageBatch,
            Self::RuntimeContext(_) => CitizenSdkResultKind::RuntimeContext,
            Self::Hash(_) => CitizenSdkResultKind::ExtrinsicHash,
            Self::Execution(_) => CitizenSdkResultKind::ExecutionConclusion,
            Self::Watch(_) => CitizenSdkResultKind::WatchEvent,
            Self::ExportedState(_) => CitizenSdkResultKind::ExportedState,
            Self::AccountBalance(_) => CitizenSdkResultKind::AccountBalance,
            Self::AccountBalances(_) => CitizenSdkResultKind::AccountBalances,
            Self::AccountNonce(_) => CitizenSdkResultKind::AccountNonce,
            #[cfg(feature = "chain")]
            Self::FeeSnapshot(_) => CitizenSdkResultKind::FeeSnapshot,
            Self::WalletProfile(_) => CitizenSdkResultKind::WalletProfile,
            Self::Signature(_) => CitizenSdkResultKind::Signature,
            Self::PreparedWallet(_) => CitizenSdkResultKind::PreparedWallet,
            Self::TransactionHistoryPage(_) => CitizenSdkResultKind::TransactionHistoryPage,
            #[cfg(feature = "qr")]
            Self::QrReview(_) => CitizenSdkResultKind::QrReview,
            #[cfg(feature = "qr")]
            Self::QrSigned(_) => CitizenSdkResultKind::QrSigned,
            Self::WalletState(_) => CitizenSdkResultKind::WalletState,
            Self::SigningOutcome(_) => CitizenSdkResultKind::SigningOutcome,
            Self::DefaultAccountChange(_) => CitizenSdkResultKind::DefaultAccountChange,
            Self::ChainSyncStatus(_) => CitizenSdkResultKind::ChainSyncStatus,
            Self::BlockHeader(_) => CitizenSdkResultKind::BlockHeader,
            Self::BlockBody(_) => CitizenSdkResultKind::BlockBody,
            Self::PreparedTransaction(_) => CitizenSdkResultKind::PreparedTransaction,
            Self::TransactionExecution(_) => CitizenSdkResultKind::TransactionExecution,
            Self::ApplicationKey(_) => CitizenSdkResultKind::ApplicationKey,
            Self::ApplicationKeys(_) => CitizenSdkResultKind::ApplicationKeys,
            Self::ApplicationKeyPreparation(_, _) => {
                CitizenSdkResultKind::ApplicationKeyPreparation
            }
        }
    }

    pub fn payload_len(&self) -> u64 {
        match self {
            Self::Empty
            | Self::Block(_)
            | Self::Hash(_)
            | Self::Execution(_)
            | Self::Watch(_)
            | Self::AccountBalance(_)
            | Self::AccountBalances(_)
            | Self::AccountNonce(_)
            | Self::WalletProfile(_)
            | Self::PreparedWallet(_)
            | Self::TransactionHistoryPage(_) => 0,
            Self::ApplicationKey(_) => 32,
            Self::ApplicationKeys(keys) | Self::ApplicationKeyPreparation(keys, _) => {
                keys.with_secret(|bytes| bytes.len() as u64)
            }
            Self::PreparedTransaction(_) => 0,
            Self::TransactionExecution(TransactionExecutionPayload::Completed(_)) => 0,
            Self::TransactionExecution(TransactionExecutionPayload::ExternalPending(pending)) => {
                (pending.external.session_id.len() + pending.external.transport_request.len())
                    as u64
            }
            Self::ChainSyncStatus(_) => 0,
            Self::WalletState(_) => 0,
            Self::SigningOutcome(SigningOutcomePayload::Completed(_))
            | Self::DefaultAccountChange(DefaultAccountChangePayload::Completed { .. }) => 0,
            Self::SigningOutcome(SigningOutcomePayload::ExternalPending(pending))
            | Self::DefaultAccountChange(DefaultAccountChangePayload::ExternalPending(pending)) => {
                (pending.session_id.len() + pending.transport_request.len()) as u64
            }
            #[cfg(feature = "chain")]
            Self::FeeSnapshot(_) => 0,
            Self::Storage(Some(bytes)) => bytes.len() as u64,
            Self::Storage(None) => 0,
            Self::StorageBatch(values) => values
                .iter()
                .filter_map(Option::as_ref)
                .map(Vec::len)
                .sum::<usize>() as u64,
            Self::RuntimeContext(context) => context.metadata().len() as u64,
            Self::BlockHeader(header) => header.digest().len() as u64,
            Self::BlockBody(body) => body.extrinsics().iter().map(Vec::len).sum::<usize>() as u64,
            Self::ExportedState(state) => state.database().len() as u64,
            Self::Signature(_) => 64,
            #[cfg(feature = "qr")]
            Self::QrReview(review) => review.json.len() as u64,
            #[cfg(feature = "qr")]
            Self::QrSigned(json) => json.len() as u64,
        }
    }
}

#[derive(Clone, Debug)]
pub struct OwnedResult {
    pub owner: u64,
    pub code: CitizenSdkErrorCode,
    pub message: String,
    /// Present only for failed results; successful result metadata stays layout-compatible.
    pub failure_stage: Option<CitizenSdkFailureStage>,
    pub payload: ResultPayload,
}

impl OwnedResult {
    pub fn success(owner: u64, payload: ResultPayload) -> Self {
        Self {
            owner,
            code: CitizenSdkErrorCode::Ok,
            message: String::new(),
            failure_stage: None,
            payload,
        }
    }

    pub fn failure(owner: u64, error: FfiError) -> Self {
        Self {
            owner,
            code: error.code,
            message: error.message,
            failure_stage: Some(error.stage),
            payload: ResultPayload::Empty,
        }
    }

    pub fn info(&self) -> CitizenSdkResultInfo {
        CitizenSdkResultInfo {
            error_code: self.code.as_i32(),
            kind: self.payload.kind() as u32,
            payload_len: self.payload.payload_len(),
            error_message_len: self.message.len() as u64,
            ..CitizenSdkResultInfo::default()
        }
    }
}

pub(crate) struct ResultHandleAllocator {
    next: AtomicU64,
}

impl ResultHandleAllocator {
    pub(crate) const fn new(next: u64) -> Self {
        Self {
            next: AtomicU64::new(next),
        }
    }

    fn reserve_handle(&self) -> FfiResult<CitizenSdkResultHandle> {
        next_nonzero(&self.next)
    }
}

enum ResultEntry {
    Reserved { owner: u64 },
    Ready(Box<OwnedResult>),
}

/// A unique result handle and registry slot reserved before a request becomes
/// accepted. Dropping it before commit removes the unreachable placeholder;
/// the monotonic handle itself is deliberately never reused.
pub struct ResultReservation {
    handle: CitizenSdkResultHandle,
    owner: u64,
    committed: bool,
}

impl ResultReservation {
    pub fn commit(mut self, result: OwnedResult) -> FfiResult<CitizenSdkResultHandle> {
        if result.owner != self.owner {
            return Err(FfiError::internal(
                "result reservation owner does not match completion owner",
            ));
        }
        let mut registry = lock_results();
        let entry = registry
            .get_mut(&self.handle)
            .ok_or_else(|| FfiError::internal("reserved result slot is missing"))?;
        match entry {
            ResultEntry::Reserved { owner } if *owner == self.owner => {
                *entry = ResultEntry::Ready(Box::new(result));
            }
            ResultEntry::Reserved { .. } => {
                return Err(FfiError::internal(
                    "reserved result slot owner changed unexpectedly",
                ));
            }
            ResultEntry::Ready(_) => {
                return Err(FfiError::internal(
                    "reserved result slot was already committed",
                ));
            }
        }
        self.committed = true;
        Ok(self.handle)
    }
}

impl Drop for ResultReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut registry = lock_results();
        if matches!(
            registry.get(&self.handle),
            Some(ResultEntry::Reserved { owner }) if *owner == self.owner
        ) {
            registry.remove(&self.handle);
        }
    }
}

pub(crate) static RESULT_HANDLES: ResultHandleAllocator = ResultHandleAllocator::new(1);
static RESULTS: OnceLock<Mutex<HashMap<CitizenSdkResultHandle, ResultEntry>>> = OnceLock::new();

fn results() -> &'static Mutex<HashMap<CitizenSdkResultHandle, ResultEntry>> {
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_results() -> MutexGuard<'static, HashMap<CitizenSdkResultHandle, ResultEntry>> {
    results()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn reserve_with(
    owner: u64,
    allocator: &ResultHandleAllocator,
) -> FfiResult<ResultReservation> {
    let handle = allocator.reserve_handle()?;
    let mut registry = lock_results();
    match registry.entry(handle) {
        Entry::Vacant(entry) => {
            entry.insert(ResultEntry::Reserved { owner });
        }
        Entry::Occupied(_) => {
            return Err(FfiError::internal(
                "monotonic result handle collided with an existing slot",
            ));
        }
    }
    Ok(ResultReservation {
        handle,
        owner,
        committed: false,
    })
}

pub fn reserve(owner: u64) -> FfiResult<ResultReservation> {
    reserve_with(owner, &RESULT_HANDLES)
}

pub fn insert(result: OwnedResult) -> FfiResult<CitizenSdkResultHandle> {
    reserve(result.owner)?.commit(result)
}

pub fn get(handle: CitizenSdkResultHandle) -> FfiResult<OwnedResult> {
    if handle == 0 {
        return Err(FfiError::new(
            CitizenSdkErrorCode::InvalidHandle,
            "result handle 0 is invalid",
        ));
    }
    lock_results()
        .get(&handle)
        .and_then(|entry| match entry {
            ResultEntry::Ready(result) => Some(result.as_ref().clone()),
            ResultEntry::Reserved { .. } => None,
        })
        .ok_or_else(|| {
            FfiError::new(
                CitizenSdkErrorCode::InvalidHandle,
                "result handle is unknown or already released",
            )
        })
}

/// 批量余额按索引读取时不能克隆整批；此处只在 registry 短锁内借用公开事实。
/// 私有闭包在本模块内同步执行，不调用宿主，也不把引用带出锁的生命周期。
fn with_account_balances<T>(
    handle: CitizenSdkResultHandle,
    read: impl FnOnce(&[FinalizedAccountBalance]) -> FfiResult<T>,
) -> FfiResult<T> {
    let registry = lock_results();
    let Some(ResultEntry::Ready(result)) = registry.get(&handle) else {
        return Err(FfiError::new(
            CitizenSdkErrorCode::InvalidHandle,
            "result handle is unknown, reserved, or already released",
        ));
    };
    let ResultPayload::AccountBalances(balances) = &result.payload else {
        return Err(crate::wrong_result("account balances"));
    };
    read(balances)
}

pub fn account_balance_count(handle: CitizenSdkResultHandle) -> FfiResult<u32> {
    with_account_balances(handle, |balances| {
        u32::try_from(balances.len())
            .map_err(|_| FfiError::internal("account balance result count overflowed"))
    })
}

pub fn account_balance_at(
    handle: CitizenSdkResultHandle,
    index: u32,
) -> FfiResult<FinalizedAccountBalance> {
    with_account_balances(handle, |balances| {
        let index = usize::try_from(index)
            .map_err(|_| FfiError::invalid("account balance index is too large"))?;
        balances
            .get(index)
            .copied()
            .ok_or_else(|| FfiError::invalid("account balance index is out of bounds"))
    })
}

pub fn release(handle: CitizenSdkResultHandle) -> FfiResult<OwnedResult> {
    if handle == 0 {
        return Err(FfiError::new(
            CitizenSdkErrorCode::InvalidHandle,
            "result handle 0 is invalid",
        ));
    }
    let mut registry = lock_results();
    if !matches!(registry.get(&handle), Some(ResultEntry::Ready(_))) {
        return Err(FfiError::new(
            CitizenSdkErrorCode::InvalidHandle,
            "result handle is unknown, reserved, or already released",
        ));
    }
    match registry.remove(&handle) {
        Some(ResultEntry::Ready(result)) => Ok(*result),
        Some(ResultEntry::Reserved { .. }) | None => Err(FfiError::new(
            CitizenSdkErrorCode::InvalidHandle,
            "result handle is unknown, reserved, or already released",
        )),
    }
}

fn next_nonzero(counter: &AtomicU64) -> FfiResult<u64> {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_add(1).filter(|next| *next != 0)
        })
        .map_err(|_| FfiError::internal("monotonic handle space is exhausted"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::{
        get, insert, release, reserve_with, OwnedResult, ResultHandleAllocator, ResultPayload,
    };

    #[test]
    fn release_is_exactly_once_and_handles_are_not_reused() {
        let first = insert(OwnedResult::success(1, ResultPayload::Empty))
            .unwrap_or_else(|error| panic!("insert failed: {error:?}"));
        let second = insert(OwnedResult::success(1, ResultPayload::Empty))
            .unwrap_or_else(|error| panic!("insert failed: {error:?}"));
        assert_ne!(first, second);
        assert!(get(first).is_ok());
        assert!(release(first).is_ok());
        assert!(release(first).is_err());
        assert!(release(second).is_ok());
    }

    #[test]
    fn exhaustion_is_reported_before_a_result_slot_is_reserved() {
        let allocator = ResultHandleAllocator::new(u64::MAX);
        for _ in 0..2 {
            let error = reserve_with(77, &allocator)
                .err()
                .unwrap_or_else(|| panic!("exhausted result handle must fail"));
            assert_eq!(error.code, crate::abi::CitizenSdkErrorCode::Internal);
            assert_eq!(allocator.next.load(Ordering::SeqCst), u64::MAX);
        }
    }

    #[test]
    fn dropped_reservation_removes_placeholder_without_reusing_handle() {
        let allocator = ResultHandleAllocator::new(u64::MAX - 1);
        let reservation = reserve_with(88, &allocator)
            .unwrap_or_else(|error| panic!("last reservation failed: {error:?}"));
        let handle = reservation.handle;
        assert!(get(handle).is_err());
        drop(reservation);
        assert!(get(handle).is_err());
        assert_eq!(allocator.next.load(Ordering::SeqCst), u64::MAX);
        assert!(reserve_with(88, &allocator).is_err());
    }
}
