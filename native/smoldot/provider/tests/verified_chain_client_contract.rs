use citizen_sdk_contracts::{
    ChainIdentity, ContractErrorCode, ExportedChainState, FinalizedBlockRef, VerifiedChainClient,
    CITIZENCHAIN_GENESIS_HASH,
};
use citizen_sdk_smoldot_provider::{
    ProviderLifecycle, SmoldotProviderConfig, SmoldotVerifiedChainClient,
};

const CHAIN_SPEC: &str = include_str!("../../../../chain/chainspec.json");
const INVALID_CHAIN_SPEC: &str =
    r#"{"name":"CitizenChain","id":"citizenchain","protocolId":"citizenchain"}"#;

fn assert_verified_client<T: VerifiedChainClient>() {}

fn require_ok<T, E>(result: Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(_) => panic!("{context}"),
    }
}

fn require_err<T, E>(result: Result<T, E>, context: &str) -> E {
    match result {
        Err(error) => error,
        Ok(_) => panic!("{context}"),
    }
}

#[test]
fn concrete_provider_implements_the_formal_chain_contract() {
    assert_verified_client::<SmoldotVerifiedChainClient>();
}

/// 冷启动及同块并发/重复读取只读验收；只输出固定阶段、耗时和一致布尔值。
#[test]
#[ignore = "需要显式执行Runtime只读实网耗时验收"]
fn live_runtime_context_reuses_verified_exact_block() {
    use citizen_sdk_contracts::VerifiedBlockRef;
    use std::time::{Duration, Instant};
    for session in 0..2 {
        let mut spec: serde_json::Value = require_ok(serde_json::from_str(CHAIN_SPEC), "chainspec");
        spec["lightSyncState"] = require_ok(
            serde_json::from_str(include_str!(
                "../../../../chain/light_sync_state.json"
            )),
            "checkpoint",
        );
        let config = require_ok(
            SmoldotProviderConfig::try_new(
                spec.to_string(),
                "CitizenSDK runtime observation",
                "2.4.0",
            ),
            "config",
        )
        .with_bootstrap();
        let provider = require_ok(SmoldotVerifiedChainClient::new(config), "provider");
        let result = require_ok(provider.drive(async {
            tokio::time::timeout(Duration::from_secs(120), async {
                provider.start().await.ok()?;
                let block = loop {
                    if let Ok(Ok(status)) = tokio::time::timeout(Duration::from_secs(3), provider.get_sync_status()).await {
                        if status.is_usable() && status.peer_count() > 0 && status.best().hash() == status.finalized().hash() { break status.best(); }
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                };
                let finalized = VerifiedBlockRef::finalized(block.hash(), block.number());
                let start = Instant::now();
                let (a,b) = futures::join!(provider.get_runtime_context_at(block), provider.get_runtime_context_at(finalized));
                let (a,b) = (a.ok()?, b.ok()?);
                let same = a.metadata() == b.metadata() && a.version() == b.version() && a.block() == block && b.block() == finalized;
                println!("RUNTIME_OBSERVATION session={session} stage=first_pair elapsed_us={} exact_match={same}", start.elapsed().as_micros());
                if !same { return None; }
                for sample in 0..3 {
                    let start = Instant::now();
                    let c = provider.get_runtime_context_at(finalized).await.ok()?;
                    let same = c == b;
                    println!("RUNTIME_OBSERVATION session={session} stage=repeat sample={sample} elapsed_us={} exact_match={same}", start.elapsed().as_micros());
                    if !same { return None; }
                }
                // 历史块仍经准确身份/状态证明读取；仅核对身份，不输出任何链业务值。
                if block.number() > 0 {
                    let historical = provider.get_finalized_block_at(block.number() - 1).await.ok()?;
                    let start = Instant::now();
                    let c = provider.get_finalized_runtime_context_at(historical).await.ok()?;
                    let exact = c.block() == historical.into();
                    println!("RUNTIME_OBSERVATION session={session} stage=historical elapsed_us={} exact_match={exact}", start.elapsed().as_micros());
                    if !exact { return None; }
                }
                Some(true)
            }).await
        }), "executor");
        require_ok(provider.stop(), "stop");
        assert_eq!(
            require_ok(result, "timeout"),
            Some(true),
            "Runtime实网验证失败"
        );
    }
}

/// 防止当前块入口重新拆成两个legacy请求或移除状态证明与历史块校验。
#[test]
fn runtime_context_entry_preserves_pin_proof_and_history() {
    let source = include_str!("../../pow/light-base/src/lib.rs");
    let entry = source
        .split("pub fn chain_runtime_context_at(")
        .nth(1)
        .and_then(|tail| {
            tail.split("pub fn chain_account_next_index_snapshot(")
                .next()
        })
        .expect("runtime entry");
    assert_eq!(entry.matches(".pin_pinned_block_runtime(").count(), 1);
    assert_eq!(entry.matches(".runtime_call(").count(), 1);
    assert!(entry.contains("validate_runtime_header("));
    assert!(entry.contains("compile_runtime_for_block("));
    assert!(entry.contains("Metadata_metadata"));
    assert!(entry.contains("1..=2"));
    assert!(entry.contains("runtime_subscription_cleanup("));
    let provider = include_str!("../src/verified_chain_client.rs");
    let entry = provider
        .split("fn get_runtime_context_at(")
        .nth(1)
        .and_then(|tail| tail.split("fn get_block_header_at(").next())
        .expect("provider entry");
    assert!(!entry.contains("state_getRuntimeVersion"));
    assert!(!entry.contains("state_getMetadata"));
    assert!(entry.contains("cached_runtime_context("));
    assert_eq!(entry.matches("validate_exact_block(").count(), 2);
}

/// 真实网络只读nonce验收：每轮新建provider，覆盖首次读取与同块重复读取。
/// 仅使用合成公有账户，不读取钱包、不提交交易、不输出nonce或块/账户标识。
#[test]
#[ignore = "需要显式执行nonce只读实网耗时验收"]
fn live_nonce_queries_reuse_pinned_runtime_without_transaction_submission() {
    use citizen_sdk_contracts::{AccountId32, AccountNonceSource};
    use std::time::{Duration, Instant};

    for session in 0..2 {
        let mut spec: serde_json::Value = require_ok(serde_json::from_str(CHAIN_SPEC), "chainspec");
        spec["lightSyncState"] = require_ok(
            serde_json::from_str(include_str!(
                "../../../../chain/light_sync_state.json"
            )),
            "light sync state",
        );
        let config = require_ok(
            SmoldotProviderConfig::try_new(
                spec.to_string(),
                "CitizenSDK nonce observation",
                "2.4.0",
            ),
            "config",
        )
        .with_bootstrap();
        let provider = require_ok(SmoldotVerifiedChainClient::new(config), "provider");
        let result = require_ok(provider.drive(async {
            tokio::time::timeout(Duration::from_secs(120), async {
                provider.start().await.ok()?;
                let best = loop {
                    if let Ok(Ok(status)) = tokio::time::timeout(Duration::from_secs(3), provider.get_sync_status()).await {
                        if status.is_usable() && status.peer_count() > 0 && status.best().hash() == status.finalized().hash() {
                            break provider.get_best_head().await.ok()?;
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                };
                let account_id = AccountId32::from_bytes([0x11; 32]);
                let mut previous = None;
                for sample in 0..3 {
                    let started = Instant::now();
                    let nonce = provider.account_next_index(account_id, best).await.ok()?;
                    let matches = nonce.account_id() == account_id && nonce.best_block() == best;
                    let stable = previous.is_none_or(|value| value == nonce.value());
                    previous = Some(nonce.value());
                    println!("NONCE_OBSERVATION session={session} sample={sample} elapsed_us={} identity_match={matches} same_block_value={stable}", started.elapsed().as_micros());
                    if !matches || !stable { return None; }
                }
                let after = provider.get_sync_status().await.ok()?;
                Some(after.best().hash() == best.hash() && after.best().hash() == after.finalized().hash())
            }).await
        }), "nonce executor");
        require_ok(provider.stop(), "stop provider");
        assert_eq!(
            require_ok(result, "nonce observation timeout"),
            Some(true),
            "nonce真实读取或准确空闲块条件失败"
        );
    }
}

#[test]
fn nonce_entry_uses_one_pinned_runtime_path_and_retains_proof_execution() {
    let source = include_str!("../../pow/light-base/src/lib.rs");
    let entry = source
        .split("pub fn chain_account_next_index_snapshot(")
        .nth(1)
        .and_then(|tail| tail.split("pub fn add_chain(").next())
        .expect("nonce entry");
    // 防止最终根分支重新走代码下载，或优化时误删证明执行、API版本和准确身份。
    assert!(!entry.contains("compile_runtime_for_block("));
    assert_eq!(entry.matches(".pin_pinned_block_runtime(").count(), 1);
    assert_eq!(entry.matches(".runtime_call(").count(), 1);
    assert!(entry.contains("AccountNonceApi_account_nonce"));
    assert!(entry.contains("1..=1"));
    assert!(entry.contains("runtime_subscription_cleanup("));
    assert!(entry.contains("requested_account_id"));
}

/// 无peer时不能把已固定Runtime误当作账户状态证明；超时取消后必须能停止实例。
#[test]
fn nonce_without_proof_never_returns_a_cached_or_fabricated_value() {
    use citizen_sdk_contracts::{AccountId32, AccountNonceSource, VerifiedBlockRef};
    use std::time::Duration;
    let mut spec: serde_json::Value = require_ok(serde_json::from_str(CHAIN_SPEC), "chainspec");
    spec["bootNodes"] = serde_json::json!([]);
    spec["lightSyncState"] = require_ok(
        serde_json::from_str(include_str!(
            "../../../../chain/light_sync_state.json"
        )),
        "light sync state",
    );
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(require_ok(
            SmoldotProviderConfig::try_new(spec.to_string(), "CitizenSDK offline nonce", "2.4.0"),
            "config",
        )),
        "provider",
    );
    require_ok(
        require_ok(provider.drive(provider.start()), "start executor"),
        "start provider",
    );
    let result = require_ok(
        provider.drive(async {
            tokio::time::timeout(
                Duration::from_millis(300),
                provider.account_next_index(
                    AccountId32::from_bytes([0x11; 32]),
                    VerifiedBlockRef::best(CITIZENCHAIN_GENESIS_HASH, 0),
                ),
            )
            .await
        }),
        "nonce executor",
    );
    assert!(!matches!(result, Ok(Ok(_))), "没有网络证明不能返回nonce");
    let runtime = require_ok(
        provider.drive(async {
            tokio::time::timeout(
                Duration::from_millis(300),
                provider
                    .get_runtime_context_at(VerifiedBlockRef::best(CITIZENCHAIN_GENESIS_HASH, 0)),
            )
            .await
        }),
        "runtime executor",
    );
    assert!(
        !matches!(runtime, Ok(Ok(_))),
        "没有网络证明不能返回Runtime上下文"
    );
    require_ok(provider.stop(), "stop cancelled provider");
    assert!(futures::executor::block_on(
        provider.get_runtime_context_at(VerifiedBlockRef::best(CITIZENCHAIN_GENESIS_HASH, 0))
    )
    .is_err());
    let stopped = require_err(
        futures::executor::block_on(provider.account_next_index(
            AccountId32::from_bytes([0x11; 32]),
            VerifiedBlockRef::best(CITIZENCHAIN_GENESIS_HASH, 0),
        )),
        "stopped provider must reject nonce",
    );
    assert_eq!(stopped.code(), ContractErrorCode::NotReady);
}

/// 与手机相同 provider、随包信任资产及节点发现的只读实网验收。
/// 不提交交易；只输出公开高度和固定状态，不输出块哈希、账户或原始错误。
/// 必须显式选择，离线回归不依赖实网；宿主观测不能冒充手机进程内部状态。
#[test]
#[ignore = "需要显式执行只读实网链状态验收"]
fn live_chain_status_observation_without_transaction_submission() {
    use std::time::{Duration, Instant};

    let mut spec: serde_json::Value = require_ok(serde_json::from_str(CHAIN_SPEC), "chainspec");
    spec["lightSyncState"] = require_ok(
        serde_json::from_str(include_str!(
            "../../../../chain/light_sync_state.json"
        )),
        "light sync state",
    );
    let config = require_ok(
        SmoldotProviderConfig::try_new(spec.to_string(), "CitizenSDK chain observation", "2.4.0"),
        "config",
    )
    .with_bootstrap();
    let provider = require_ok(SmoldotVerifiedChainClient::new(config), "provider");
    let started = require_ok(
        provider
            .drive(async { tokio::time::timeout(Duration::from_secs(60), provider.start()).await }),
        "start executor",
    );
    require_ok(require_ok(started, "start timeout"), "start failed");

    let (usable_samples, equal_samples) = require_ok(provider.drive(async {
        let start = Instant::now();
        let mut usable_samples = 0;
        let mut equal_samples = 0;
        while start.elapsed() < Duration::from_secs(90) && usable_samples < 12 {
            match tokio::time::timeout(Duration::from_secs(3), provider.get_sync_status()).await {
                Ok(Ok(status)) => {
                    let equal = status.best().hash() == status.finalized().hash();
                    println!("CHAIN_OBSERVATION elapsed_s={} best={} finalized={} equal={} peers={} syncing={} usable={}",
                        start.elapsed().as_secs(), status.best().number(), status.finalized().number(),
                        equal, status.peer_count(), status.is_syncing(), status.is_usable());
                    if status.is_usable() && status.peer_count() > 0 {
                        usable_samples += 1;
                        equal_samples += usize::from(equal);
                    }
                }
                Ok(Err(_)) => println!("CHAIN_OBSERVATION status=unavailable"),
                Err(_) => println!("CHAIN_OBSERVATION status=timeout"),
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        (usable_samples, equal_samples)
    }), "observation executor");
    // 无可用 peer、超时或同步未完成均不能当成空闲链证据；先结束实例再断言。
    require_ok(provider.stop(), "stop provider");
    println!("CHAIN_OBSERVATION usable_samples={usable_samples} equal_samples={equal_samples}");
    assert_eq!(usable_samples, 12, "实网可用状态样本不足");
}

#[test]
fn finalized_subscription_before_start_fails_once_and_ends() {
    use futures::StreamExt;
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(require_ok(
            SmoldotProviderConfig::try_new(CHAIN_SPEC, "CitizenSDK test", "2.4.0"),
            "config",
        )),
        "provider",
    );
    let mut stream = provider.subscribe_finalized_heads();
    let first = futures::executor::block_on(stream.next());
    assert!(matches!(first, Some(Err(error)) if error.code() == ContractErrorCode::NotReady));
    assert!(futures::executor::block_on(stream.next()).is_none());
}

/// 用无账户、无签名的 Timestamp 固有调用走本地外部交易验证；不得通过或广播。
/// 在同一 best==finalized 块上得到 Runtime 拒绝，证明无需等新区块即可启动验证。
#[test]
#[ignore = "需要显式执行空闲实网验证，固有调用不得广播"]
fn live_idle_chain_rejects_inherent_without_a_new_block() {
    use citizen_sdk_contracts::{ExtrinsicWatchEvent, SignedExtrinsic};
    use futures::StreamExt;
    use std::time::Duration;

    let mut spec: serde_json::Value = require_ok(serde_json::from_str(CHAIN_SPEC), "chainspec");
    spec["lightSyncState"] = require_ok(
        serde_json::from_str(include_str!(
            "../../../../chain/light_sync_state.json"
        )),
        "light sync state",
    );
    let config = require_ok(
        SmoldotProviderConfig::try_new(spec.to_string(), "CitizenSDK validation test", "2.4.0"),
        "config",
    )
    .with_bootstrap();
    let provider = require_ok(SmoldotVerifiedChainClient::new(config), "provider");
    let started = require_ok(
        provider
            .drive(async { tokio::time::timeout(Duration::from_secs(60), provider.start()).await }),
        "start executor",
    );
    require_ok(require_ok(started, "start timeout"), "start failed");
    let observation = require_ok(
        provider.drive(async {
            tokio::time::timeout(Duration::from_secs(90), async {
                let before = loop {
                    // 启动过渡中的不可读快照不能提前结束实网验收，仍受外层90秒限制。
                    if let Ok(Ok(status)) = tokio::time::timeout(
                        Duration::from_secs(3), provider.get_sync_status()).await {
                        if status.is_usable()
                            && status.peer_count() > 0
                            && status.best().hash() == status.finalized().hash()
                        {
                            println!("IDLE_VALIDATION stage=ready best={} finalized={} peers={}",
                                status.best().number(), status.finalized().number(), status.peer_count());
                            break status;
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                };
                // SCALE长度4、unsigned v4、Timestamp(1)::set(0)、compact时刻0。
                // 格式合法，Executive 在外部验证中以 MandatoryValidation 拒绝，绝不执行调用。
                let inherent = SignedExtrinsic::try_new(vec![16, 4, 1, 0, 0]).ok()?;
                let mut watch = provider.watch_extrinsic(inherent);
                let first = tokio::time::timeout(Duration::from_secs(45), watch.next())
                    .await
                    .ok()?;
                let runtime_rejected = match first {
                    Some(Ok(ExtrinsicWatchEvent::Invalid)) => true,
                    Some(Err(error)) => {
                        // 只输出固定枚举与分类布尔值，失败也不能回显原始错误。
                        let execution = error.message().contains("Error during the execution of the runtime:");
                        println!("IDLE_VALIDATION error_code={:?} execution={} api_requirement={} inaccessible={} rpc_rejected={}",
                            error.code(), execution,
                            error.message().contains("ApiVersionRequirementUnfulfilled"),
                            error.message().contains("Error trying to access the storage"),
                            error.message().contains("RPC"));
                        false
                    }
                    Some(Ok(event)) => {
                        println!("IDLE_VALIDATION ready={} broadcast={} dropped={}",
                            matches!(event, ExtrinsicWatchEvent::Ready),
                            matches!(event, ExtrinsicWatchEvent::Broadcast { .. }),
                            matches!(event, ExtrinsicWatchEvent::Dropped));
                        false
                    }
                    None => false,
                };
                drop(watch);
                let after = match provider.get_sync_status().await {
                    Ok(status) => status,
                    Err(error) => {
                        println!("IDLE_VALIDATION stage=after_unavailable code={:?}", error.code());
                        return None;
                    }
                };
                Some((
                    runtime_rejected,
                    before.best().hash() == after.best().hash()
                        && after.best().hash() == after.finalized().hash(),
                ))
            })
            .await
        }),
        "validation executor",
    );
    require_ok(
        provider.drive(provider.drain_finalized_subscriptions()),
        "drain executor",
    )
    .unwrap_or_else(|_| panic!("drain failed"));
    require_ok(provider.stop(), "stop provider");
    let (runtime_rejected, same_block) = require_ok(observation, "validation timeout")
        .unwrap_or_else(|| panic!("实网验证状态不可读"));
    println!(
        "IDLE_VALIDATION runtime_rejected={runtime_rejected} same_finalized_block={same_block}"
    );
    assert!(runtime_rejected, "固有调用未得到真实Runtime无效结论");
    assert!(same_block, "验收期间链头改变，不能证明空闲链验证");
}

#[test]
#[allow(clippy::unwrap_used)]
fn real_smoldot_subscription_drops_and_drains_without_peers() {
    use futures::StreamExt;
    let mut spec: serde_json::Value = serde_json::from_str(CHAIN_SPEC).unwrap();
    spec["bootNodes"] = serde_json::json!([]);
    spec["lightSyncState"] = serde_json::from_str(include_str!(
        "../../../../chain/light_sync_state.json"
    ))
    .unwrap();
    let provider = SmoldotVerifiedChainClient::new(
        SmoldotProviderConfig::try_new(spec.to_string(), "CitizenSDK offline test", "2.4.0")
            .unwrap(),
    )
    .unwrap();
    provider.drive(provider.start()).unwrap().unwrap();
    let mut subscription = provider.subscribe_finalized_heads();
    // 有无初始通知取决于上游 runtime readiness；没有 peers 不允许自行终止订阅。
    let event = provider
        .drive(async {
            tokio::time::timeout(std::time::Duration::from_millis(300), subscription.next()).await
        })
        .unwrap();
    assert!(!matches!(event, Ok(None)));
    drop(subscription);
    provider
        .drive(provider.drain_finalized_subscriptions())
        .unwrap()
        .unwrap();
    provider.stop().unwrap();
    assert_eq!(provider.lifecycle().unwrap(), ProviderLifecycle::Stopped);
}

#[test]
fn static_identity_is_available_before_start_but_chain_reads_are_not() {
    let config = require_ok(
        SmoldotProviderConfig::try_new(CHAIN_SPEC, "CitizenSDK test", "1.0.0"),
        "bundled chainspec identity must be valid",
    );
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(config),
        "provider runtime must start",
    );
    assert_eq!(
        require_ok(provider.lifecycle(), "lifecycle must be readable"),
        ProviderLifecycle::Created
    );

    assert_eq!(
        require_ok(
            futures::executor::block_on(provider.identity()),
            "static identity must be readable",
        ),
        ChainIdentity::citizenchain()
    );
    let error = require_err(
        futures::executor::block_on(provider.get_best_head()),
        "chain reads must require a real running smoldot instance",
    );
    assert_eq!(error.code(), ContractErrorCode::NotReady);
    let finalized_error = require_err(
        futures::executor::block_on(provider.get_finalized_block_at(0)),
        "finalized height resolution must require a real running smoldot instance",
    );
    assert_eq!(finalized_error.code(), ContractErrorCode::NotReady);
    let accepted_120_then_lifecycle = require_err(
        futures::executor::block_on(provider.get_finalized_blocks_at(1, 120)),
        "120-block range should pass the range gate then reach lifecycle",
    );
    assert_eq!(
        accepted_120_then_lifecycle.code(),
        ContractErrorCode::NotReady
    );
    let rejected_121 = require_err(
        futures::executor::block_on(provider.get_finalized_blocks_at(0, 120)),
        "121-block range must fail before provider lifecycle or network",
    );
    assert_eq!(rejected_121.code(), ContractErrorCode::InvalidArgument);
    let rejected_overflow = require_err(
        futures::executor::block_on(provider.get_finalized_blocks_at(0, u64::MAX)),
        "overflowing range must fail before provider lifecycle or network",
    );
    assert_eq!(rejected_overflow.code(), ContractErrorCode::InvalidArgument);
}

#[test]
fn import_is_exact_idempotent_and_conflicting_replacement_fails_closed() {
    let config = require_ok(
        SmoldotProviderConfig::try_new(CHAIN_SPEC, "CitizenSDK test", "1.0.0"),
        "bundled chainspec identity must be valid",
    );
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(config),
        "provider runtime must start",
    );
    let finalized = FinalizedBlockRef::from_parts(CITIZENCHAIN_GENESIS_HASH, 0);
    let imported = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        1,
        finalized,
        br#"{"genesisHash":"citizenchain"}"#.to_vec(),
    );
    let imported = require_ok(imported, "valid imported state must construct");
    let receipt = require_ok(
        futures::executor::block_on(provider.import_state(imported.clone())),
        "first import must succeed",
    );
    assert_eq!(receipt.finalized(), finalized);
    let repeated = require_ok(
        futures::executor::block_on(provider.import_state(imported)),
        "identical import must be idempotent",
    );
    assert_eq!(repeated.finalized(), finalized);

    let replacement = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        1,
        finalized,
        br#"{"genesisHash":"replacement"}"#.to_vec(),
    );
    let replacement = require_ok(replacement, "replacement envelope itself must be valid");
    let error = require_err(
        futures::executor::block_on(provider.import_state(replacement)),
        "different pending import must not replace the accepted one",
    );
    assert_eq!(error.code(), ContractErrorCode::Conflict);
}

#[test]
fn public_source_does_not_expose_arbitrary_rpc() {
    let public_source = include_str!("../src/lib.rs");
    assert!(!public_source.contains("pub fn rpc"));
    assert!(!public_source.contains("pub async fn request"));
}

#[test]
fn controlled_executor_is_usable_without_a_tokio_context() {
    let config = require_ok(
        SmoldotProviderConfig::try_new(CHAIN_SPEC, "CitizenSDK worker", "1.0.0"),
        "bundled chainspec identity must be valid",
    );
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(config),
        "provider runtime must start",
    );
    let worker = std::thread::spawn(move || provider.drive(async { "driven" }));
    let output = match worker.join() {
        Ok(output) => require_ok(output, "provider runtime must drive future"),
        Err(_) => panic!("ordinary worker must not panic"),
    };
    assert_eq!(output, "driven");
}

#[test]
fn failed_start_is_one_way_and_fallback_requires_a_fresh_provider() {
    let config = require_ok(
        SmoldotProviderConfig::try_new(INVALID_CHAIN_SPEC, "CitizenSDK test", "1.0.0"),
        "identity-only config validation must accept the test fixture",
    );
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(config.clone()),
        "provider runtime must start",
    );
    let first = require_ok(
        provider.drive(provider.start()),
        "executor must drive start",
    );
    let _first_error = require_err(first, "invalid chainspec start must fail");
    assert_eq!(
        require_ok(provider.lifecycle(), "lifecycle must be readable"),
        ProviderLifecycle::StartFailed
    );

    let second = require_ok(
        provider.drive(provider.start()),
        "executor must drive second start rejection",
    );
    let second_error = require_err(second, "StartFailed provider must not restart");
    assert_eq!(second_error.code(), ContractErrorCode::InvalidState);

    let fallback = require_ok(
        SmoldotVerifiedChainClient::new(config),
        "fallback must allocate a fresh provider",
    );
    assert_eq!(
        require_ok(fallback.lifecycle(), "fresh lifecycle must be readable"),
        ProviderLifecycle::Created
    );
}

#[test]
fn transaction_watch_uses_the_upstream_v1_surface_without_legacy_fallback() {
    let legacy = include_str!("../src/legacy.rs");
    assert!(legacy.contains("\"transactionWatch_v1_submitAndWatch\""));
    assert!(legacy.contains("\"transactionWatch_v1_unwatch\""));
    assert!(!legacy.contains("author_submitAndWatchExtrinsic"));
    assert!(!legacy.contains("author_unwatchExtrinsic"));

    let parser = include_str!("../src/verified_chain_client.rs");
    for event in [
        "validated",
        "broadcasted",
        "bestChainBlockIncluded",
        "finalized",
        "invalid",
        "dropped",
        "error",
    ] {
        assert!(parser.contains(&format!("\"{event}\"")), "missing {event}");
    }
    assert!(parser.contains("map.get(\"numPeers\")"));
    assert!(parser.contains("map.get(\"broadcasted\")"));
}

#[test]
fn typed_body_and_current_batches_have_single_native_call_sites() {
    let source = include_str!("../src/verified_chain_client.rs");
    assert_eq!(source.matches("chain_block_extrinsics(").count(), 1);
    assert!(!source.contains("\"chain_getBlock\""));
    assert_eq!(source.matches("chain_storage_values_snapshot(").count(), 1);
    assert_eq!(
        source
            .matches("chain_finalized_storage_values_snapshot(")
            .count(),
        1
    );
    assert!(source.contains("StorageBatchRoute::ExactHash"));
    assert!(source.contains("exact_storage_params(block, key)"));
    assert!(source.contains("storage_snapshot_matches_block(&snapshot, block)"));
    assert!(!source.contains("let after = storage_batch_heads"));
}

#[test]
fn finalized_resolution_uses_verified_ancestry_not_best_or_recent_cache() {
    let provider_source = include_str!("../src/verified_chain_client.rs");
    assert!(provider_source.contains(".chain_finalized_blocks_at("));
    assert!(!provider_source.contains("chain_known_block_hash("));

    let light_base = include_str!("../../pow/light-base/src/lib.rs");
    let start = light_base
        .find("pub fn chain_finalized_blocks_at(")
        .unwrap_or_else(|| panic!("typed finalized ancestry method must exist"));
    let end = light_base[start..]
        .find("pub fn chain_known_block_hash(")
        .map(|offset| start + offset)
        .unwrap_or_else(|| panic!("next typed method must delimit ancestry source"));
    let resolver = &light_base[start..end];
    assert!(resolver.contains("sync_activity_snapshot().await"));
    assert!(resolver.contains("current_verified_finalized_block_number"));
    assert!(resolver.contains("current_verified_finalized_block_hash"));
    assert!(resolver.contains("block_query_unknown_number("));
    assert!(resolver.contains("header: true"));
    assert!(resolver.contains(".accept(block_data, block_number_bytes)"));
    assert!(resolver.contains("finalized_ancestry_cache"));
    let exact_hit = resolver
        .find("anchor_cache.exact_blocks(start_number, end_number)")
        .unwrap_or_else(|| panic!("proof-derived exact cache lookup must exist"));
    let network_walk = resolver
        .find("block_query_unknown_number(")
        .unwrap_or_else(|| panic!("proof-backed network fallback must exist"));
    assert!(exact_hit < network_walk);
    assert!(resolver.contains("commit_proven_batch("));
    assert!(!resolver.contains("recent_block_cache"));
    assert!(!resolver.contains("subscribe_all"));
    assert!(!resolver.contains("best_block"));
}
