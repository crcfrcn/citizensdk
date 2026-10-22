//! smoldot typed nonce 快照到 CitizenSDK `AccountNonceSource` 的安全适配。
//!
//! 请求的best hash/高度直接传入同次Runtime订阅；仅接受该调用返回的账户与nonce。
//! 禁止在调用前后另采样head拼接身份，也不把Runtime未就绪折叠成网络证明失败。

use citizen_sdk_contracts::{
    AccountId32, AccountNonce, AccountNonceSource, BlockFinality, ChainIdentity, ContractError, ContractErrorCode,
    ContractFuture, ContractResult, VerifiedBlockRef,
};
use smoldot_light::{ChainAccountNonceError, ChainAccountNonceSnapshot};

use crate::client::{contract_error, provider_error, SmoldotVerifiedChainClient};

impl AccountNonceSource for SmoldotVerifiedChainClient {
    fn account_next_index(
        &self,
        account_id: AccountId32,
        at_best: VerifiedBlockRef,
    ) -> ContractFuture<'_, AccountNonce> {
        Box::pin(async move {
            require_best_request(at_best)?;
            let running = self.running()?;
            let snapshot_future = {
                let client = running.client.lock();
                client
                    .chain_account_next_index_snapshot(
                        running.chain_id,
                        account_id.as_bytes().to_vec(),
                        at_best.hash().into_bytes(),
                        at_best.number(),
                    )
                    .map_err(provider_error)?
            };
            let snapshot = snapshot_future.await.map_err(nonce_error)?;
            account_nonce_from_snapshot(account_id, at_best, snapshot)
        })
    }
}

// 接纳错误按类型映射；证明请求的原网络诊断保持，不解析自由错误文本。
fn nonce_error(error: ChainAccountNonceError) -> ContractError {
    let code = match &error {
        ChainAccountNonceError::InvalidArgument => ContractErrorCode::InvalidArgument,
        ChainAccountNonceError::NotReady => ContractErrorCode::NotReady,
        ChainAccountNonceError::Conflict => ContractErrorCode::Conflict,
        ChainAccountNonceError::Integrity => ContractErrorCode::Integrity,
        ChainAccountNonceError::Runtime(_) => ContractErrorCode::Network,
    };
    contract_error(code, error.to_string())
}

fn require_best_request(at_best: VerifiedBlockRef) -> ContractResult<()> {
    if at_best.finality() != BlockFinality::Best {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "AccountNonceSource 只接受准确 best 块引用",
        ));
    }
    Ok(())
}

fn account_nonce_from_snapshot(
    account_id: AccountId32,
    at_best: VerifiedBlockRef,
    snapshot: ChainAccountNonceSnapshot,
) -> ContractResult<AccountNonce> {
    require_best_request(at_best)?;
    if snapshot.account_id.as_slice() != account_id.as_bytes() {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "typed nonce 快照账户与请求账户不一致",
        ));
    }

    let observed = VerifiedBlockRef::best(
        citizen_sdk_contracts::Hash32::from_bytes(snapshot.block_hash),
        snapshot.block_number,
    );
    if observed != at_best {
        return Err(contract_error(
            ContractErrorCode::Conflict,
            "typed nonce runtime call 不属于调用者指定的准确 best 块",
        ));
    }

    AccountNonce::try_new(
        &ChainIdentity::citizenchain(),
        observed,
        account_id,
        snapshot.nonce,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use citizen_sdk_contracts::{FinalizedBlockRef, Hash32};

    fn account(byte: u8) -> AccountId32 {
        AccountId32::from_bytes([byte; 32])
    }

    fn snapshot(account_id: AccountId32, hash: u8, number: u64) -> ChainAccountNonceSnapshot {
        ChainAccountNonceSnapshot {
            account_id: account_id.as_bytes().to_vec(),
            block_number: number,
            block_hash: [hash; 32],
            nonce: 17,
        }
    }

    #[test]
    fn matching_snapshot_preserves_account_block_and_nonce() {
        let account_id = account(1);
        let best = VerifiedBlockRef::best(Hash32::from_bytes([0xaa; 32]), 42);
        let nonce = account_nonce_from_snapshot(account_id, best, snapshot(account_id, 0xaa, 42));
        let Ok(nonce) = nonce else {
            panic!("matching typed nonce snapshot must be accepted");
        };
        assert_eq!(nonce.account_id(), account_id);
        assert_eq!(nonce.best_block(), best);
        assert_eq!(nonce.value(), 17);
    }

    #[test]
    fn snapshot_rejects_wrong_account_hash_and_number() {
        let account_id = account(1);
        let best = VerifiedBlockRef::best(Hash32::from_bytes([0xaa; 32]), 42);

        let Err(wrong_account) =
            account_nonce_from_snapshot(account_id, best, snapshot(account(2), 0xaa, 42))
        else {
            panic!("different account must fail closed");
        };
        assert_eq!(wrong_account.code(), ContractErrorCode::Integrity);

        let Err(wrong_hash) =
            account_nonce_from_snapshot(account_id, best, snapshot(account_id, 0xbb, 42))
        else {
            panic!("same-height hash drift must fail closed");
        };
        assert_eq!(wrong_hash.code(), ContractErrorCode::Conflict);

        let Err(wrong_number) =
            account_nonce_from_snapshot(account_id, best, snapshot(account_id, 0xaa, 43))
        else {
            panic!("different best height must fail closed");
        };
        assert_eq!(wrong_number.code(), ContractErrorCode::Conflict);
    }

    #[test]
    fn middle_b_snapshot_is_rejected_even_if_outer_view_returns_to_a() {
        let account_id = account(1);
        let outer_a = VerifiedBlockRef::best(Hash32::from_bytes([0xaa; 32]), 42);
        // 调用前后都可能观察到 A；唯一可信事实仍是 runtime call 自带的中间 B 身份。
        let middle_b = snapshot(account_id, 0xbb, 43);
        let Err(error) = account_nonce_from_snapshot(account_id, outer_a, middle_b) else {
            panic!("A→B→A 中间快照不得被外层 A 采样洗白");
        };
        assert_eq!(error.code(), ContractErrorCode::Conflict);
    }

    #[test]
    fn finalized_request_is_never_relabelled_as_best() {
        let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0xaa; 32]), 42);
        let Err(error) = require_best_request(finalized.verified()) else {
            panic!("finalized nonce request must fail");
        };
        assert_eq!(error.code(), ContractErrorCode::InvalidArgument);
    }

    #[test]
    fn matching_snapshot_preserves_zero_and_maximum_runtime_nonce() {
        let account_id = account(1);
        let best = VerifiedBlockRef::best(Hash32::from_bytes([0xaa; 32]), 42);
        // 固定Runtime复用不能引入nonce缓存、自增或零值替代。
        for value in [0, u64::from(u32::MAX)] {
            let mut observed = snapshot(account_id, 0xaa, 42);
            observed.nonce = value;
            let Ok(nonce) = account_nonce_from_snapshot(account_id, best, observed) else {
                panic!("准确快照的合法nonce边界必须保留");
            };
            assert_eq!(nonce.value(), value);
        }
    }

    #[test]
    fn nonce_admission_errors_keep_their_categories_and_network_diagnostics() {
        for (error, code) in [
            (ChainAccountNonceError::InvalidArgument, ContractErrorCode::InvalidArgument),
            (ChainAccountNonceError::NotReady, ContractErrorCode::NotReady),
            (ChainAccountNonceError::Conflict, ContractErrorCode::Conflict),
            (ChainAccountNonceError::Integrity, ContractErrorCode::Integrity),
        ] {
            assert_eq!(nonce_error(error).code(), code);
        }
        let message = "proof_network=3 network_remote_couldnt_answer=3";
        let error = nonce_error(ChainAccountNonceError::Runtime(message.into()));
        assert_eq!(error.code(), ContractErrorCode::Network);
        assert_eq!(error.message(), message);
    }
}
