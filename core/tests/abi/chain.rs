use super::*;
use smoldot_light::ChainFinalizedBlockSnapshot;

fn runtime_fixture(block: VerifiedBlockRef, version: u32) -> RuntimeContext {
    RuntimeContext::try_new(block, RuntimeVersion::new(version, 1), vec![version as u8])
        .expect("fixture")
}

/// 同块finality推进只改变已独立验证的标记；不同块/升级绝不沿用旧内容。
#[test]
fn runtime_cache_reuses_exact_block_and_separates_forks_and_upgrades() {
    futures::executor::block_on(async {
        let cache = Mutex::new(RuntimeContexts::default());
        let a = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
        let finalized = VerifiedBlockRef::finalized(a.hash(), a.number());
        cached_runtime_context(&cache, a, async { Ok(runtime_fixture(a, 1)) })
            .await
            .expect("first");
        let second = cached_runtime_context(&cache, finalized, async {
            panic!("same block must not reload")
        })
        .await
        .expect("hit");
        assert_eq!(second.block(), finalized);
        assert_eq!(second.version().spec_version(), 1);
        let fork = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 10);
        let upgrade = VerifiedBlockRef::best(Hash32::from_bytes([3; 32]), 11);
        for block in [fork, upgrade] {
            let value =
                cached_runtime_context(&cache, block, async { Ok(runtime_fixture(block, 2)) })
                    .await
                    .expect("distinct block");
            assert_eq!(value.version().spec_version(), 2);
        }
        let wrong_height = VerifiedBlockRef::best(a.hash(), 12);
        assert!(
            cached_runtime_context(&cache, wrong_height, async { panic!("invalid identity") })
                .await
                .is_err()
        );
    });
}

/// 一个网络读取服务并发请求；另一个块可以在其等待期间独立完成。
#[test]
fn runtime_cache_coalesces_requests_without_serializing_other_blocks() {
    futures::executor::block_on(async {
        let cache = Mutex::new(RuntimeContexts::default());
        let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
        let (tx, rx) = oneshot::channel();
        let mut owner = Box::pin(cached_runtime_context(&cache, block, async {
            rx.await.expect("release");
            Ok(runtime_fixture(block, 1))
        }));
        assert!(futures::poll!(&mut owner).is_pending());
        let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
            panic!("duplicate network load")
        }));
        assert!(futures::poll!(&mut waiter).is_pending());
        let other = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 11);
        cached_runtime_context(&cache, other, async { Ok(runtime_fixture(other, 1)) })
            .await
            .expect("independent");
        tx.send(()).expect("send");
        assert_eq!(owner.await.expect("owner"), waiter.await.expect("waiter"));
        assert!(cache.lock().pending.is_empty());
    });
}

/// 失败向全部等待者传播一次且不缓存；下一次显式调用可以重新读取。
#[test]
fn runtime_cache_failure_is_shared_and_retry_is_not_poisoned() {
    futures::executor::block_on(async {
        let cache = Mutex::new(RuntimeContexts::default());
        let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
        let (tx, rx) = oneshot::channel();
        let mut owner = Box::pin(cached_runtime_context(&cache, block, async {
            rx.await.expect("release");
            Err(contract_error(
                ContractErrorCode::Network,
                "fixture failure",
            ))
        }));
        assert!(futures::poll!(&mut owner).is_pending());
        let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
            panic!("must share failure")
        }));
        assert!(futures::poll!(&mut waiter).is_pending());
        tx.send(()).expect("send");
        assert_eq!(
            owner.await.expect_err("failure").code(),
            ContractErrorCode::Network
        );
        assert_eq!(
            waiter.await.expect_err("failure").code(),
            ContractErrorCode::Network
        );
        assert!(cache.lock().ready.is_empty());
        cached_runtime_context(&cache, block, async { Ok(runtime_fixture(block, 1)) })
            .await
            .expect("retry");
    });
}

#[test]
fn runtime_cache_owner_cancel_wakes_waiters_and_stop_rejects_late_success() {
    futures::executor::block_on(async {
        let cache = Mutex::new(RuntimeContexts::default());
        let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
        let mut owner = Box::pin(cached_runtime_context(
            &cache,
            block,
            std::future::pending(),
        ));
        assert!(futures::poll!(&mut owner).is_pending());
        let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
            panic!("duplicate")
        }));
        assert!(futures::poll!(&mut waiter).is_pending());
        drop(owner);
        assert_eq!(
            waiter.await.expect_err("cancel").code(),
            ContractErrorCode::Unavailable
        );
        assert!(cache.lock().pending.is_empty());
        let (tx, rx) = oneshot::channel();
        let mut late = Box::pin(cached_runtime_context(&cache, block, async {
            rx.await.expect("release");
            Ok(runtime_fixture(block, 1))
        }));
        assert!(futures::poll!(&mut late).is_pending());
        let mut stopped_waiter = Box::pin(cached_runtime_context(&cache, block, async {
            panic!("duplicate")
        }));
        assert!(futures::poll!(&mut stopped_waiter).is_pending());
        cache.lock().close();
        assert_eq!(
            stopped_waiter.await.expect_err("stop").code(),
            ContractErrorCode::NotReady
        );
        tx.send(()).expect("send");
        assert_eq!(
            late.await.expect_err("late").code(),
            ContractErrorCode::NotReady
        );
        assert!(cache.lock().ready.is_empty());
        assert!(
            cached_runtime_context(&cache, block, async { panic!("stopped") })
                .await
                .is_err()
        );
    });
}

#[test]
fn runtime_cache_waiter_cancel_preserves_owner_and_bounds_requests() {
    futures::executor::block_on(async {
        let cache = Mutex::new(RuntimeContexts::default());
        let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
        let (tx, rx) = oneshot::channel();
        let mut owner = Box::pin(cached_runtime_context(&cache, block, async {
            rx.await.expect("release");
            Ok(runtime_fixture(block, 1))
        }));
        assert!(futures::poll!(&mut owner).is_pending());
        let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
            panic!("duplicate")
        }));
        assert!(futures::poll!(&mut waiter).is_pending());
        drop(waiter);
        tx.send(()).expect("send");
        owner.await.expect("owner survives");
        for n in 0..=MAX_RUNTIME_CONTEXTS {
            let next = VerifiedBlockRef::best(Hash32::from_bytes([(n + 2) as u8; 32]), n as u64);
            cached_runtime_context(&cache, next, async { Ok(runtime_fixture(next, 1)) })
                .await
                .expect("bounded insert");
        }
        assert_eq!(cache.lock().ready.len(), MAX_RUNTIME_CONTEXTS);
        assert!(cache.lock().bytes <= MAX_RUNTIME_CONTEXT_BYTES);
        let mut pending = RuntimeContexts::default();
        for n in 0..MAX_RUNTIME_CONTEXTS {
            let next = VerifiedBlockRef::best(Hash32::from_bytes([n as u8; 32]), n as u64);
            assert!(matches!(pending.begin(next), Ok(RuntimeContextRead::Fetch)));
        }
        let next = VerifiedBlockRef::best(Hash32::from_bytes([255; 32]), 255);
        assert!(pending.begin(next).is_err());
        let first = VerifiedBlockRef::best(Hash32::from_bytes([0; 32]), 0);
        let mut receivers = Vec::new();
        for _ in 0..MAX_RUNTIME_WAITERS {
            match pending.begin(first).expect("wait") {
                RuntimeContextRead::Wait(receiver) => receivers.push(receiver),
                _ => panic!("expected wait"),
            }
        }
        assert!(pending.begin(first).is_err());
        drop(receivers);
        assert!(matches!(
            pending.begin(first),
            Ok(RuntimeContextRead::Wait(_))
        ));
    });
}

/// 总字节淘汰与条数淘汰独立，不能让少量大metadata突破内存上限。
#[test]
fn runtime_cache_evicts_by_total_metadata_bytes() {
    let mut cache = RuntimeContexts::default();
    let size = MAX_RUNTIME_CONTEXT_BYTES / 2 + 1;
    for n in 0..2 {
        let block = VerifiedBlockRef::best(Hash32::from_bytes([n; 32]), u64::from(n));
        assert!(matches!(cache.begin(block), Ok(RuntimeContextRead::Fetch)));
        let context = RuntimeContext::try_new(block, RuntimeVersion::new(1, 1), vec![1; size])
            .expect("large context");
        cache
            .complete(runtime_context_key(block), Ok(Arc::new(context)))
            .expect("cache insert");
    }
    assert_eq!(cache.ready.len(), 1);
    assert_eq!(cache.bytes, size);
}

#[test]
fn runtime_snapshot_rejects_wrong_identity_and_empty_metadata() {
    let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
    for (hash, number, metadata) in [
        ([2; 32], 10, vec![1]),
        ([1; 32], 11, vec![1]),
        ([1; 32], 10, vec![]),
    ] {
        assert!(runtime_context_from_snapshot(
            block,
            ChainRuntimeContextSnapshot {
                block_hash: hash,
                block_number: number,
                spec_version: 1,
                transaction_version: 1,
                metadata,
            }
        )
        .is_err());
    }
    futures::executor::block_on(async {
        let cache = Mutex::new(RuntimeContexts::default());
        let wrong = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 10);
        assert!(
            cached_runtime_context(&cache, block, async { Ok(runtime_fixture(wrong, 1)) })
                .await
                .is_err()
        );
        assert!(cache.lock().ready.is_empty());
    });
}

#[test]
fn transaction_diagnostics_only_expose_fixed_categories() {
    // 成功分类、未知内容、伪装前缀和超长输入都不能透传任意描述。
    assert_eq!(
        transaction_invalid_category("Invalid transaction: Stale"),
        "invalid_stale"
    );
    assert_eq!(
        transaction_invalid_category("Invalid transaction: Payment"),
        "invalid_payment"
    );
    assert_eq!(
        transaction_invalid_category("Invalid transaction: Stale extra"),
        "invalid_other"
    );
    assert_eq!(transaction_invalid_category(""), "invalid_other");
    assert_eq!(
        transaction_invalid_category(&"x".repeat(4096)),
        "invalid_other"
    );
}

#[test]
fn strict_hash_parser_rejects_wrong_width_and_prefix() {
    assert!(parse_hash_value(&json!(format!("0x{}", "11".repeat(32))), "hash").is_ok());
    assert!(parse_hash_value(&json!("11".repeat(32)), "hash").is_err());
    assert!(parse_hash_value(&json!(format!("0x{}", "11".repeat(31))), "hash").is_err());
}

#[test]
fn number_parser_accepts_rpc_hex_and_json_numbers() {
    assert_eq!(parse_u64_value(&json!("0x2a"), "number").ok(), Some(42));
    assert_eq!(parse_u64_value(&json!(42), "number").ok(), Some(42));
}

#[test]
fn scale_compact_u64_covers_all_substrate_modes() {
    assert_eq!(scale_compact_u64(0), [0]);
    assert_eq!(scale_compact_u64(63), [0xfc]);
    assert_eq!(scale_compact_u64(64), [0x01, 0x01]);
    assert_eq!(scale_compact_u64((1 << 14) - 1), [0xfd, 0xff]);
    assert_eq!(scale_compact_u64(1 << 14), [0x02, 0x00, 0x01, 0x00]);
    assert_eq!(scale_compact_u64(1 << 30), [0x03, 0x00, 0x00, 0x00, 0x40]);
    assert_eq!(
        scale_compact_u64(u64::MAX),
        [0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    );
}

#[test]
fn header_decoder_rebuilds_and_verifies_the_exact_scale_header_hash() {
    let parent = Hash32::from_bytes([1; 32]);
    let state = Hash32::from_bytes([2; 32]);
    let extrinsics = Hash32::from_bytes([3; 32]);
    let digest_log = vec![0x06, 0x42, 0x41, 0x42, 0x45];
    let mut encoded = Vec::new();
    encoded.extend_from_slice(parent.as_bytes());
    encoded.extend_from_slice(&scale_compact_u64(42));
    encoded.extend_from_slice(state.as_bytes());
    encoded.extend_from_slice(extrinsics.as_bytes());
    encoded.extend_from_slice(&scale_compact_u64(1));
    encoded.extend_from_slice(&digest_log);
    let block = VerifiedBlockRef::finalized(substrate_blake2_256(&encoded), 42);
    let value = json!({
        "number": "0x2a",
        "parentHash": hash_hex(parent),
        "stateRoot": hash_hex(state),
        "extrinsicsRoot": hash_hex(extrinsics),
        "digest": {"logs": [format!("0x{}", hex::encode(&digest_log))]},
    });
    let header = decode_verified_header(block, &value)
        .unwrap_or_else(|error| panic!("verified header failed: {error:?}"));
    assert_eq!(header.block(), block);
    assert_eq!(header.digest(), [scale_compact_u64(1), digest_log].concat());

    let wrong = VerifiedBlockRef::finalized(Hash32::from_bytes([9; 32]), 42);
    let error = decode_verified_header(wrong, &value)
        .err()
        .unwrap_or_else(|| panic!("wrong header hash must fail"));
    assert_eq!(error.code(), ContractErrorCode::Integrity);
}

#[test]
fn current_storage_batch_routes_only_exact_matching_heads() {
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0x11; 32]), 11);
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x09; 32]), 9);
    let heads = StorageBatchHeads {
        best,
        surface_finalized: finalized,
        verified_finalized: finalized,
    };
    assert_eq!(
        select_storage_batch_route(best, heads),
        StorageBatchRoute::CurrentBest
    );
    assert_eq!(
        select_storage_batch_route(finalized.verified(), heads),
        StorageBatchRoute::CurrentVerifiedFinalized
    );

    let historical = VerifiedBlockRef::finalized(Hash32::from_bytes([0x08; 32]), 8);
    assert_eq!(
        select_storage_batch_route(historical, heads),
        StorageBatchRoute::ExactHash
    );

    let warp_surface = StorageBatchHeads {
        surface_finalized: FinalizedBlockRef::from_parts(Hash32::from_bytes([0x0a; 32]), 10),
        ..heads
    };
    assert_eq!(
        select_storage_batch_route(finalized.verified(), warp_surface),
        StorageBatchRoute::ExactHash
    );
}

#[test]
fn best_block_validation_uses_verified_heads_and_rejects_unproven_history() {
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0x11; 32]), 11);
    let verified_finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x09; 32]), 9);
    let heads = StorageBatchHeads {
        best,
        // 表面 finalized 高度不能扩大可接受的历史 best 范围。
        surface_finalized: FinalizedBlockRef::from_parts(Hash32::from_bytes([0x0a; 32]), 10),
        verified_finalized,
    };
    assert_eq!(
        best_block_needs_finalized_proof(best, heads).ok(),
        Some(false)
    );
    let old_finalized = VerifiedBlockRef::best(verified_finalized.hash(), 9);
    assert_eq!(
        best_block_needs_finalized_proof(old_finalized, heads).ok(),
        Some(true)
    );
    // 高度已 finalized 但 hash 错误时仍必须交给 ancestry 核对，不能直接放行。
    let wrong_finalized = VerifiedBlockRef::best(Hash32::from_bytes([0xff; 32]), 9);
    assert_eq!(
        best_block_needs_finalized_proof(wrong_finalized, heads).ok(),
        Some(true)
    );
    for unproven in [
        VerifiedBlockRef::best(Hash32::from_bytes([0x0a; 32]), 10),
        VerifiedBlockRef::best(Hash32::from_bytes([0xff; 32]), 11),
        VerifiedBlockRef::best(Hash32::from_bytes([0x12; 32]), 12),
    ] {
        let error = best_block_needs_finalized_proof(unproven, heads)
            .err()
            .unwrap_or_else(|| panic!("unproven best block must fail"));
        assert_eq!(error.code(), ContractErrorCode::Conflict);
    }
}

#[test]
fn exact_storage_batch_restores_order_duplicates_and_explicit_absence() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0xab; 32]), 42);
    let keys = vec![vec![1], vec![2], vec![1]];
    let result =
        json!([{ "block": hash_hex(block.hash()), "changes": [["0x02", null], ["0x01", "0x"]] }]);
    assert_eq!(
        parse_storage_batch_at(&result, block, &keys).unwrap(),
        vec![Some(vec![]), None, Some(vec![])]
    );
    for bad in [
        json!([]),
        json!([{"block": hash_hex(block.hash()), "changes": []}]),
        json!([{"block": hash_hex(block.hash()), "changes": [["0x01", null]]}]),
        json!([{"block": hash_hex(block.hash()), "changes": [["0x01", null], ["0x01", null], ["0x02", null]]}]),
        json!([{"block": hash_hex(block.hash()), "changes": [["0x01", null], ["0x02", null], ["0x03", null]]}]),
        json!([{"block": format!("0x{}", "cd".repeat(32)), "changes": [["0x01", null], ["0x02", null]]}]),
        json!([{"block": hash_hex(block.hash()), "changes": [["0x01", "invalid"], ["0x02", null]]}]),
    ] {
        assert!(parse_storage_batch_at(&bad, block, &keys).is_err());
    }
}

#[test]
fn historical_storage_params_always_carry_the_requested_exact_hash() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0xab; 32]), 42);
    let params = exact_storage_params(block, vec![0x01, 0x02]);
    assert_eq!(params, json!(["0x0102", format!("0x{}", "ab".repeat(32))]));
    assert!(validate_storage_keys(&[vec![0x01], vec![0x01]]).is_ok());
    let Err(error) = validate_storage_keys(&[vec![0x01], Vec::new()]) else {
        panic!("empty key in a batch must fail before native dispatch");
    };
    assert_eq!(error.code(), ContractErrorCode::InvalidArgument);
    assert!(validate_storage_batch_len(2, 2).is_ok());
    let Err(error) = validate_storage_batch_len(2, 1) else {
        panic!("typed batch length mismatch must fail closed");
    };
    assert_eq!(error.code(), ContractErrorCode::Integrity);

    let oversized_key = vec![0; MAX_STORAGE_KEY_BYTES + 1];
    assert!(validate_storage_keys(&[oversized_key]).is_err());
    let too_many = vec![vec![1]; MAX_STORAGE_BATCH_KEYS + 1];
    assert!(validate_storage_keys(&too_many).is_err());
    let too_large = vec![
        vec![1; MAX_STORAGE_KEY_BYTES];
        MAX_STORAGE_BATCH_KEY_BYTES / MAX_STORAGE_KEY_BYTES + 1
    ];
    assert!(validate_storage_keys(&too_large).is_err());
}

#[test]
fn storage_key_pages_enforce_prefix_cursor_order_count_and_bytes() {
    assert!(validate_storage_keys_page_request(&[1], None, 1).is_ok());
    assert!(validate_storage_keys_page_request(
        &vec![1; MAX_STORAGE_KEY_BYTES],
        Some(&[1, 0]),
        MAX_STORAGE_KEYS_PAGE_LIMIT,
    )
    .is_ok());
    assert!(validate_storage_keys_page_request(&[], None, 1).is_err());
    assert!(validate_storage_keys_page_request(&[1], None, 0).is_err());
    assert!(
        validate_storage_keys_page_request(&[1], None, MAX_STORAGE_KEYS_PAGE_LIMIT + 1,).is_err()
    );

    let page = json!(["0x0101", "0x0102"]);
    assert_eq!(
        parse_storage_keys_page(&page, &[1], None, 2).unwrap(),
        vec![vec![1, 1], vec![1, 2]],
    );
    let next_page = json!(["0x0102"]);
    assert_eq!(
        parse_storage_keys_page(&next_page, &[1], Some(&[1, 1]), 2).unwrap(),
        vec![vec![1, 2]],
    );
    assert!(
        parse_storage_keys_page(&page, &[1], Some(&[1, 1]), 2).is_err(),
        "排他 start_key 不能在下一页重复返回",
    );
    assert!(parse_storage_keys_page(&page, &[2], None, 2).is_err());
    assert!(parse_storage_keys_page(&json!(["0x0102", "0x0101"]), &[1], None, 2).is_err());
    assert!(parse_storage_keys_page(&page, &[1], None, 1).is_err());
}

#[test]
fn runtime_api_request_is_bounded_opaque_and_requires_trait_method_shape() {
    assert!(validate_runtime_api_request("CitizenApi_items", &[]).is_ok());
    let longest = format!("A_{}", "b".repeat(MAX_RUNTIME_API_METHOD_BYTES - 2));
    let maximum_arguments = vec![0; MAX_RUNTIME_API_ARGUMENT_BYTES];
    assert!(validate_runtime_api_request(&longest, &maximum_arguments).is_ok());
    for invalid in ["", "CitizenApi", "_items", "CitizenApi-items"] {
        assert!(
            validate_runtime_api_request(invalid, &[]).is_err(),
            "{invalid}"
        );
    }
    assert!(validate_runtime_api_request(
        "CitizenApi_items",
        &vec![0; MAX_RUNTIME_API_ARGUMENT_BYTES + 1],
    )
    .is_err());
}

#[test]
fn typed_storage_snapshot_must_identify_the_exact_requested_block() {
    let requested = VerifiedBlockRef::best(Hash32::from_bytes([0x11; 32]), 11);
    let matching = ChainStorageValuesSnapshot {
        block_number: 11,
        block_hash: [0x11; 32],
        values: vec![Some(vec![1]), None, Some(vec![1])],
    };
    assert!(storage_snapshot_matches_block(&matching, requested));
    assert_eq!(matching.values[0], matching.values[2]);

    // Models the dangerous middle observation in an A→B→A head sequence:
    // even if outer head samples both see A, values proved against B are
    // rejected and the caller must fall back to an exact-hash query for A.
    let observed_middle_block = ChainStorageValuesSnapshot {
        block_number: 12,
        block_hash: [0x22; 32],
        values: vec![Some(vec![2]), None, Some(vec![2])],
    };
    assert!(!storage_snapshot_matches_block(
        &observed_middle_block,
        requested
    ));

    let wrong_number = ChainStorageValuesSnapshot {
        block_number: 12,
        block_hash: [0x11; 32],
        values: matching.values.clone(),
    };
    assert!(!storage_snapshot_matches_block(&wrong_number, requested));
}

#[test]
fn submitted_hash_uses_complete_extrinsic_blake2_256() {
    let extrinsic = [0x04, 0x01, 0x02, 0x03];
    let actual = substrate_blake2_256(&extrinsic);
    assert_eq!(
        hex::encode(actual.as_bytes()),
        "d1db84052dee9bd43d7a1c22a4349bab845afcb162da4807166309d92d3dfa40"
    );
    assert!(verify_submitted_hash(&extrinsic, actual).is_ok());
    let Err(error) = verify_submitted_hash(&extrinsic[1..], actual) else {
        panic!("hash calculated without the Compact length prefix must fail");
    };
    assert_eq!(error.code(), ContractErrorCode::Integrity);
}

#[test]
fn finalized_batch_projection_requires_exact_bounds_length_and_order() {
    let snapshot = ChainFinalizedBlocksSnapshot {
        upper_block_number: 42,
        upper_block_hash: [0xaa; 32],
        blocks: vec![
            ChainFinalizedBlockSnapshot {
                block_number: 40,
                block_hash: [0x40; 32],
            },
            ChainFinalizedBlockSnapshot {
                block_number: 41,
                block_hash: [0x41; 32],
            },
        ],
    };
    let refs = finalized_refs_from_snapshot(snapshot.clone(), 40, 41)
        .unwrap_or_else(|error| panic!("valid batch: {error}"));
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].number(), 40);
    assert_eq!(refs[1].number(), 41);

    let mut partial = snapshot.clone();
    partial.blocks.pop();
    assert!(finalized_refs_from_snapshot(partial, 40, 41).is_err());

    let mut wrong_order = snapshot.clone();
    wrong_order.blocks.swap(0, 1);
    assert!(finalized_refs_from_snapshot(wrong_order, 40, 41).is_err());

    assert!(finalized_refs_from_snapshot(snapshot.clone(), 43, 42).is_err());
    assert!(finalized_refs_from_snapshot(snapshot, 41, 43).is_err());
}

#[test]
fn ancestry_error_kinds_preserve_security_classification() {
    let cases = [
        (
            ChainFinalizedAncestryError::InvalidArgument("range".to_owned()),
            ContractErrorCode::InvalidArgument,
        ),
        (
            ChainFinalizedAncestryError::AboveVerifiedUpper("future".to_owned()),
            ContractErrorCode::NotFound,
        ),
        (
            ChainFinalizedAncestryError::Integrity("fork".to_owned()),
            ContractErrorCode::Integrity,
        ),
        (
            ChainFinalizedAncestryError::Unavailable("offline".to_owned()),
            ContractErrorCode::Network,
        ),
    ];
    for (source, expected) in cases {
        assert_eq!(finalized_ancestry_error(source).code(), expected);
    }
}

// 不消费时必须在固定容量停止接纳，并独立保留明确溢出错误。
#[test]
fn transaction_watch_queue_is_bounded_and_reports_overflow() {
    futures::executor::block_on(async {
        let (mut sender, receiver) = mpsc::channel(MAX_WATCH_EVENTS);
        let (overflow, failed) = oneshot::channel();
        let mut overflow = Some(overflow);
        let mut accepted = 0;
        for _ in 0..MAX_WATCH_EVENTS * 2 {
            if !send_watch_event(&mut sender, &mut overflow, Ok(ExtrinsicWatchEvent::Ready)) {
                break;
            }
            accepted += 1;
        }
        // futures mpsc为唯一sender保留一个槽；没有clone，空间始终受限。
        assert!((MAX_WATCH_EVENTS..=MAX_WATCH_EVENTS + 1).contains(&accepted));
        assert!(overflow.is_none());
        drop(sender);
        assert_eq!(receiver.collect::<Vec<_>>().await.len(), accepted);
        assert_eq!(
            failed.await.expect("overflow error").code(),
            ContractErrorCode::Network
        );
    });
}

#[test]
fn transaction_watch_receiver_cancel_is_distinct_from_overflow() {
    let (mut sender, receiver) = mpsc::channel(MAX_WATCH_EVENTS);
    let (overflow, _) = oneshot::channel();
    let mut overflow = Some(overflow);
    drop(receiver);
    assert!(!send_watch_event(
        &mut sender,
        &mut overflow,
        Ok(ExtrinsicWatchEvent::Ready)
    ));
    assert!(overflow.is_some());
}
