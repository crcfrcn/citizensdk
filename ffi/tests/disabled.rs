use super::*;
use crate::transaction_abi::{
    citizensdk_get_transaction_history, citizensdk_sync_transaction_history,
};

#[test]
fn chain_symbols_reject_without_dereferencing_host_pointers() {
    // 没有链模块时，无效指针不会被读取；公开符号仍返回统一 Unsupported。
    let unsupported = CitizenSdkErrorCode::Unsupported.as_i32();
    unsafe {
        assert_eq!(citizensdk_get_genesis_hash(0, ptr::null_mut()), unsupported);
        assert_eq!(
            citizensdk_get_finalized_account_balances(0, ptr::null(), u32::MAX, ptr::null_mut()),
            unsupported
        );
        assert_eq!(
            citizensdk_get_finalized_account_balance(0, ptr::null(), ptr::null_mut()),
            unsupported
        );
        assert_eq!(
            citizensdk_get_account_nonce(0, ptr::null(), ptr::null_mut()),
            unsupported
        );
        assert_eq!(
            citizensdk_get_best_fee_snapshot(0, ptr::null_mut()),
            unsupported
        );
        assert_eq!(
            citizensdk_get_transaction_history(0, ptr::null(), 100, ptr::null_mut()),
            unsupported
        );
        assert_eq!(
            citizensdk_sync_transaction_history(0, ptr::null_mut()),
            unsupported
        );
        assert_eq!(
            citizensdk_result_get_fee_snapshot(0, ptr::null_mut()),
            unsupported
        );
    }
}
