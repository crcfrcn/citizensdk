// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

use super::{
    BlockNotification, ConfigRelayChainRuntimeCodeHint, FinalizedBlockRuntime, Notification,
    StartupFinalizedSource, SubscribeAll, SyncActivitySnapshot, SyncPhase, ToBackground,
    WarpFailure,
};
use crate::{log, network_service, platform::PlatformRef, util};

use alloc::{
    borrow::{Cow, ToOwned as _},
    boxed::Box,
    collections::BTreeMap,
    format,
    string::String,
    sync::Arc,
    vec::Vec,
};
use core::{cmp, iter, num::NonZero, pin::Pin, time::Duration};
use futures_lite::FutureExt as _;
use futures_util::{StreamExt as _, future, stream};
use hashbrown::HashMap;
use smoldot::{
    chain, header,
    informant::HashDisplay,
    libp2p,
    network::{self, codec},
    sync::all,
};

/// Starts a sync service background task to synchronize a standalone chain (relay chain or not).
pub(super) async fn start_standalone_chain<TPlat: PlatformRef>(
    log_target: String,
    platform: TPlat,
    chain_information: chain::chain_information::ValidChainInformation,
    startup_finalized_source: StartupFinalizedSource,
    block_number_bytes: usize,
    runtime_code_hint: Option<ConfigRelayChainRuntimeCodeHint>,
    mut from_foreground: Pin<Box<async_channel::Receiver<ToBackground>>>,
    network_service: Arc<network_service::NetworkServiceChain<TPlat>>,
) {
    let waits_for_grandpa_neighbor = matches!(
        chain_information.as_ref().finality,
        chain::chain_information::ChainInformationFinalityRef::Grandpa { .. }
    );
    let startup_finalized_block_number = chain_information.as_ref().finalized_block_header.number;
    let startup_finalized_block_hash = chain_information
        .as_ref()
        .finalized_block_header
        .hash(block_number_bytes);
    let sync = all::AllSync::new(all::Config {
        chain_information,
        block_number_bytes,
        // Since this module doesn't verify block bodies, any block (even invalid) is accepted
        // as long as it comes from a legitimate validator. Consequently, validators could
        // perform attacks by sending completely invalid blocks. Passing `false` to this
        // option would tighten the definition of what a "legitimate" validator is, and thus
        // reduce the feasibility of attacks, but not in a significant way. Passing `true`,
        // on the other hand, allows supporting chains that use custom consensus engines,
        // which is considered worth the trade-off.
        allow_unknown_consensus_engines: true,
        sources_capacity: 32,
        blocks_capacity: {
            // This is the maximum number of blocks between two consecutive justifications.
            1024
        },
        max_disjoint_headers: 1024,
        max_requests_per_block: NonZero::<u32>::new(3).unwrap(),
        download_ahead_blocks: {
            // Assuming a maximum verification speed of 5k blocks/sec and a 95% latency of one
            // second, this keeps the original smoldot download-ahead bound.
            NonZero::<u32>::new(5000).unwrap()
        },
        download_bodies: false,
        download_all_chain_information_storage_proofs: false,
        code_trie_node_hint: runtime_code_hint.map(|hint| all::ConfigCodeTrieNodeHint {
            merkle_value: hint.merkle_value,
            storage_value: hint.storage_value,
            closest_ancestor_excluding: hint.closest_ancestor_excluding,
        }),
    });
    let mut task = Task {
        sync: Some(sync),
        startup_finalized_source,
        startup_finalized_block_number,
        startup_finalized_block_hash,
        peer_finalized_block_numbers: HashMap::new(),
        warp_request_count: 0,
        warp_received_fragment_count: 0,
        warp_verified_fragment_count: 0,
        warp_rejected_fragment_count: 0,
        warp_last_failure: None,
        waits_for_grandpa_neighbor,
        received_grandpa_neighbor: false,
        network_up_to_date_best: true,
        network_up_to_date_finalized: true,
        known_finalized_runtime: None,
        pending_requests: stream::FuturesUnordered::new(),
        active_warp_requests: BTreeMap::new(),
        all_notifications: Vec::<async_channel::Sender<Notification>>::new(),
        log_target,
        from_network_service: None,
        network_service,
        peers_source_id_map: HashMap::with_capacity_and_hasher(
            0,
            util::SipHasherBuild::new({
                let mut seed = [0; 16];
                platform.fill_random_bytes(&mut seed);
                seed
            }),
        ),
        platform,
    };

    // Main loop of the syncing logic.
    //
    // This loop contains some CPU-heavy operations (e.g. verifying finality proofs and warp sync
    // proofs) but also responding to messages sent by the foreground sync service. In order to
    // avoid long delays in responding to foreground messages, the CPU-heavy operations are split
    // into small chunks, and each iteration of the loop processes at most one of these chunks and
    // processes one foreground message.
    loop {
        // Yield at every loop in order to provide better tasks granularity.
        futures_lite::future::yield_now().await;

        // Now waiting for some event to happen: a network event, a request from the frontend
        // of the sync service, or a request being finished.
        enum WakeUpReason {
            SyncProcess(all::ProcessOne<future::AbortHandle, (libp2p::PeerId, codec::Role), ()>),
            MustUpdateNetworkWithBestBlock,
            MustUpdateNetworkWithFinalizedBlock,
            MustSubscribeNetworkEvents,
            NetworkEvent(network_service::Event),
            ForegroundMessage(ToBackground),
            ForegroundClosed,
            StartRequest(all::SourceId, all::DesiredRequest),
            ObsoleteRequest(all::RequestId),
            RequestFinished(all::RequestId, Result<RequestOutcome, future::Aborted>),
        }

        let wake_up_reason = {
            async {
                if let Some(from_network_service) = task.from_network_service.as_mut() {
                    match from_network_service.next().await {
                        Some(ev) => WakeUpReason::NetworkEvent(ev),
                        None => {
                            task.from_network_service = None;
                            WakeUpReason::MustSubscribeNetworkEvents
                        }
                    }
                } else {
                    WakeUpReason::MustSubscribeNetworkEvents
                }
            }
            .or(async {
                from_foreground.next().await.map_or(
                    WakeUpReason::ForegroundClosed,
                    WakeUpReason::ForegroundMessage,
                )
            })
            .or(async {
                if task.pending_requests.is_empty() {
                    future::pending::<()>().await
                }
                let (request_id, result) = task.pending_requests.select_next_some().await;
                WakeUpReason::RequestFinished(request_id, result)
            })
            .or(async {
                if !task.network_up_to_date_finalized {
                    WakeUpReason::MustUpdateNetworkWithFinalizedBlock
                } else {
                    future::pending().await
                }
            })
            .or(async {
                if !task.network_up_to_date_best {
                    WakeUpReason::MustUpdateNetworkWithBestBlock
                } else {
                    future::pending().await
                }
            })
            .or({
                let block_requests_allowed =
                    !task.waits_for_grandpa_neighbor || task.received_grandpa_neighbor;
                let sync = &mut task.sync;
                async move {
                    // `desired_requests()` returns, in decreasing order of priority, the requests
                    // that should be started in order for the syncing to proceed. The fact that
                    // multiple requests are returned could be used to filter out undesired one. We
                    // use this filtering to enforce a maximum of one ongoing request per source.
                    let Some(s) = &sync else { unreachable!() };
                    if let Some((source_id, _, request_detail)) =
                        s.desired_requests().find(|(source_id, _, request_detail)| {
                            let blocks_before_finality_anchor = !block_requests_allowed
                                && matches!(
                                    request_detail,
                                    all::DesiredRequest::BlocksRequest { .. }
                                );
                            !blocks_before_finality_anchor
                                && s.source_num_ongoing_requests(*source_id) == 0
                        })
                    {
                        return WakeUpReason::StartRequest(source_id, request_detail);
                    }

                    // There might be requests that are no longer necessary for a reason or
                    // another.
                    if let Some(request_id) = s.obsolete_requests().next() {
                        return WakeUpReason::ObsoleteRequest(request_id);
                    }

                    // TODO: eventually, process_one() shouldn't take ownership of the AllForks
                    match sync.take().unwrap_or_else(|| unreachable!()).process_one() {
                        all::ProcessOne::AllSync(idle) => {
                            *sync = Some(idle);
                            future::pending().await
                        }
                        other => WakeUpReason::SyncProcess(other),
                    }
                }
            })
            .await
        };

        match wake_up_reason {
            WakeUpReason::SyncProcess(all::ProcessOne::AllSync(_)) => {
                // Shouldn't be reachable.
                unreachable!()
            }

            WakeUpReason::SyncProcess(all::ProcessOne::WarpSyncBuildRuntime(req)) => {
                // Warp syncing compiles the runtime. The compiled runtime will later be yielded
                // in the `WarpSyncFinished` variant, which is then provided as an event.
                let before_instant = task.platform.now();
                // Because the runtime being compiled has been validated by 2/3rds of the
                // validators of the chain, we can assume that it is valid. Doing so significantly
                // increases the compilation speed.
                let (new_sync, error) =
                    req.build(all::ExecHint::CompileWithNonDeterministicValidation, true);
                let elapsed = task.platform.now() - before_instant;
                match error {
                    Ok(()) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "warp-sync-runtime-build-success",
                            success = ?true,
                            duration = ?elapsed
                        );
                    }
                    // StateReset 不是失败:本步骤排队后有新 finalized 块到达、warp 状态机
                    // 被重置(本 fork warp_sync_minimum_gap = 0，每块都会发生)。放弃本轮
                    // 即可，绝不记入 warp_last_failure，否则状态快照会把常态误报成故障。
                    Err(all::WarpSyncBuildRuntimeError::StateReset) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "warp-sync-runtime-build-reset"
                        );
                    }
                    Err(error) => {
                        task.warp_last_failure = Some(WarpFailure::RuntimeBuildFailed);
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "warp-sync-runtime-build-error",
                            ?error
                        );
                        if !matches!(error, all::WarpSyncBuildRuntimeError::SourceMisbehavior(_)) {
                            log!(
                                &task.platform,
                                Debug,
                                &task.log_target,
                                format!(
                                    "Failed to compile runtime during warp syncing process: {}",
                                    error
                                )
                            );
                        }
                    }
                };
                task.sync = Some(new_sync);
            }

            WakeUpReason::SyncProcess(all::ProcessOne::WarpSyncBuildChainInformation(req)) => {
                let (new_sync, error) = req.build();
                match error {
                    Ok(()) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "warp-sync-chain-information-build-success"
                        );
                    }
                    // 同上:StateReset 是被新 finalized 块打断的良性重来，不计入失败。
                    Err(all::WarpSyncBuildChainInformationError::StateReset) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "warp-sync-chain-information-build-reset"
                        );
                    }
                    Err(error) => {
                        task.warp_last_failure = Some(WarpFailure::ChainInformationBuildFailed);
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "warp-sync-chain-information-build-error",
                            ?error
                        );
                        if !matches!(
                            error,
                            all::WarpSyncBuildChainInformationError::SourceMisbehavior(_)
                        ) {
                            log!(
                                &task.platform,
                                Warn,
                                &task.log_target,
                                format!(
                                    "Failed to build the chain information during warp syncing process: {}",
                                    error
                                )
                            );
                        }
                    }
                };
                task.sync = Some(new_sync);
            }

            WakeUpReason::SyncProcess(all::ProcessOne::WarpSyncFinished {
                sync,
                finalized_block_runtime,
                finalized_storage_code,
                finalized_storage_code_closest_ancestor_excluding,
                finalized_storage_heap_pages,
                finalized_storage_code_merkle_value,
                finalized_body: _,
            }) => {
                task.warp_last_failure = None;
                log!(
                    &task.platform,
                    Debug,
                    &task.log_target,
                    format!(
                        "GrandPa warp sync finished to #{} ({})",
                        sync.finalized_block_number(),
                        HashDisplay(sync.finalized_block_hash())
                    )
                );

                task.sync = Some(sync);

                task.known_finalized_runtime = Some(FinalizedBlockRuntime {
                    virtual_machine: finalized_block_runtime,
                    storage_code: finalized_storage_code,
                    storage_heap_pages: finalized_storage_heap_pages,
                    code_merkle_value: finalized_storage_code_merkle_value,
                    closest_ancestor_excluding: finalized_storage_code_closest_ancestor_excluding,
                });

                task.network_up_to_date_finalized = false;
                task.network_up_to_date_best = false;
                // Since there is a gap in the blocks, all active notifications to all blocks
                // must be cleared.
                task.all_notifications.clear();
            }

            WakeUpReason::SyncProcess(all::ProcessOne::VerifyWarpSyncFragment(verify)) => {
                // Grandpa warp sync fragment to verify.
                let sender_if_still_connected = verify
                    .proof_sender()
                    .map(|(_, (peer_id, _))| peer_id.clone());

                let (sync, result) = verify.perform({
                    let mut seed = [0; 32];
                    task.platform.fill_random_bytes(&mut seed);
                    seed
                });
                task.sync = Some(sync);

                match result {
                    Ok((fragment_hash, fragment_number)) => {
                        task.warp_verified_fragment_count =
                            task.warp_verified_fragment_count.saturating_add(1);
                        task.warp_last_failure = None;
                        // TODO: must call `set_local_grandpa_state` and `set_local_best_block` so that other peers notify us of neighbor packets
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "warp-sync-fragment-verify-success",
                            sender = sender_if_still_connected
                                .as_ref()
                                .map(|p| Cow::Owned(p.to_base58()))
                                .unwrap_or(Cow::Borrowed("<disconnected>")),
                            verified_hash = HashDisplay(&fragment_hash),
                            verified_height = fragment_number
                        );
                    }
                    Err(err) => {
                        task.warp_rejected_fragment_count =
                            task.warp_rejected_fragment_count.saturating_add(1);
                        task.warp_last_failure = Some(match &err {
                            all::VerifyFragmentError::EmptyProof => WarpFailure::EmptyProof,
                            all::VerifyFragmentError::InvalidHeader(_) => {
                                WarpFailure::InvalidHeader
                            }
                            all::VerifyFragmentError::InvalidJustification(_) => {
                                WarpFailure::InvalidJustification
                            }
                            all::VerifyFragmentError::BlockNumberNotIncrementing => {
                                WarpFailure::BlockNumberNotIncrementing
                            }
                            all::VerifyFragmentError::TargetHashMismatch { .. } => {
                                WarpFailure::TargetHashMismatch
                            }
                            all::VerifyFragmentError::JustificationVerify(_) => {
                                WarpFailure::JustificationVerifyFailed
                            }
                            all::VerifyFragmentError::NonMinimalProof => {
                                WarpFailure::NonMinimalProof
                            }
                        });
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            format!(
                                "Failed to verify warp sync fragment from {}: {}{}",
                                sender_if_still_connected
                                    .as_ref()
                                    .map(|p| Cow::Owned(p.to_base58()))
                                    .unwrap_or(Cow::Borrowed("<disconnected>")),
                                err,
                                if matches!(err, all::VerifyFragmentError::JustificationVerify(_)) {
                                    ". This might be caused by a forced GrandPa authorities change having \
                                been enacted on the chain. If this is the case, please update the \
                                chain specification with a checkpoint past this forced change."
                                } else {
                                    ""
                                }
                            )
                        );
                        if let Some(sender_if_still_connected) = sender_if_still_connected {
                            task.network_service
                                .ban_and_disconnect(
                                    sender_if_still_connected,
                                    network_service::BanSeverity::High,
                                    "bad-warp-sync-fragment",
                                )
                                .await;
                        }
                    }
                }
            }

            WakeUpReason::SyncProcess(all::ProcessOne::VerifyBlock(verify)) => {
                // Header to verify.
                let verified_hash = verify.hash();
                match verify.verify_header(task.platform.now_from_unix_epoch()) {
                    all::HeaderVerifyOutcome::Success {
                        success,
                        is_new_best,
                        ..
                    } => {
                        let sync = task.sync.insert(success.finish(()));

                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "header-verify-success",
                            hash = HashDisplay(&verified_hash),
                            is_new_best = if is_new_best { "yes" } else { "no" }
                        );

                        if is_new_best {
                            task.network_up_to_date_best = false;
                        }

                        let (parent_hash, scale_encoded_header) = {
                            // TODO: the code below is `O(n)` complexity
                            let header = sync
                                .non_finalized_blocks_unordered()
                                .find(|h| h.hash(sync.block_number_bytes()) == verified_hash)
                                .unwrap();
                            (
                                *header.parent_hash,
                                header.scale_encoding_vec(sync.block_number_bytes()),
                            )
                        };

                        // Notify of the new block.
                        task.dispatch_all_subscribers({
                            Notification::Block(BlockNotification {
                                is_new_best,
                                scale_encoded_header,
                                parent_hash,
                            })
                        });
                    }

                    all::HeaderVerifyOutcome::Error { sync, error, .. } => {
                        task.sync = Some(sync);

                        // TODO: print which peer sent the header
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "header-verify-error",
                            hash = HashDisplay(&verified_hash),
                            ?error
                        );

                        log!(
                            &task.platform,
                            Warn,
                            &task.log_target,
                            format!(
                                "Error while verifying header {}: {}",
                                HashDisplay(&verified_hash),
                                error
                            )
                        );

                        // TODO: ban peers that have announced the block
                        /*for peer_id in task.sync.knows_non_finalized_block(height, hash) {
                            task.network_service
                                .ban_and_disconnect(
                                    peer_id,
                                    network_service::BanSeverity::High,
                                    "bad-block",
                                )
                                .await;
                        }*/
                    }
                }
            }

            WakeUpReason::SyncProcess(all::ProcessOne::VerifyFinalityProof(verify)) => {
                // Finality proof to verify.
                let sender = verify.sender().1.0.clone();
                match verify.perform({
                    let mut seed = [0; 32];
                    task.platform.fill_random_bytes(&mut seed);
                    seed
                }) {
                    (
                        sync,
                        all::FinalityProofVerifyOutcome::NewFinalized {
                            updates_best_block,
                            finalized_blocks_newest_to_oldest,
                            pruned_blocks,
                        },
                    ) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "finality-proof-verify-success",
                            finalized_blocks = finalized_blocks_newest_to_oldest.len(),
                            sender
                        );

                        if updates_best_block {
                            task.network_up_to_date_best = false;
                        }
                        task.network_up_to_date_finalized = false;
                        // Invalidate the cache of the runtime of the finalized blocks if any
                        // of the finalized blocks indicates that a runtime update happened.
                        if finalized_blocks_newest_to_oldest.iter().any(|b| {
                            header::decode(&b.header, sync.block_number_bytes())
                                .unwrap()
                                .digest
                                .has_runtime_environment_updated()
                        }) {
                            task.known_finalized_runtime = None;
                        }
                        task.dispatch_all_subscribers(Notification::Finalized {
                            hash: *sync.finalized_block_hash(),
                            best_block_hash_if_changed: if updates_best_block {
                                Some(*sync.best_block_hash())
                            } else {
                                None
                            },
                            pruned_blocks,
                        });

                        task.sync = Some(sync);
                    }

                    (
                        sync,
                        all::FinalityProofVerifyOutcome::AlreadyFinalized
                        | all::FinalityProofVerifyOutcome::GrandpaCommitPending,
                    ) => {
                        task.sync = Some(sync);
                    }

                    (sync, all::FinalityProofVerifyOutcome::JustificationError(error)) => {
                        task.sync = Some(sync);

                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "finality-proof-verify-error",
                            ?error,
                            sender,
                        );

                        // Errors of type `JustificationEngineMismatch` indicate that the chain
                        // uses a finality engine that smoldot doesn't recognize. This is a benign
                        // error that shouldn't lead to a ban.
                        // `FinalityVerify` errors for unknown target blocks are also benign —
                        // the peer is gossiping a justification for a block we haven't imported
                        // yet or that has already been pruned. Common on PoW chains.
                        let is_benign = matches!(
                            &error,
                            all::JustificationVerifyError::JustificationEngineMismatch
                                | all::JustificationVerifyError::FinalityVerify(_)
                        );
                        if !is_benign {
                            log!(
                                &task.platform,
                                Warn,
                                &task.log_target,
                                format!("Error while verifying justification: {error}")
                            );

                            task.network_service
                                .ban_and_disconnect(
                                    sender,
                                    network_service::BanSeverity::High,
                                    "bad-justification",
                                )
                                .await;
                        }
                    }

                    (sync, all::FinalityProofVerifyOutcome::GrandpaCommitError(error)) => {
                        task.sync = Some(sync);

                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "finality-proof-verify-error",
                            ?error,
                            sender,
                        );

                        log!(
                            &task.platform,
                            Warn,
                            &task.log_target,
                            format!("Error while verifying GrandPa commit: {}", error)
                        );

                        task.network_service
                            .ban_and_disconnect(
                                sender,
                                network_service::BanSeverity::High,
                                "bad-grandpa-commit",
                            )
                            .await;
                    }
                }
            }

            WakeUpReason::NetworkEvent(network_service::Event::Connected {
                peer_id,
                role,
                best_block_number,
                best_block_hash,
            }) => {
                task.peer_finalized_block_numbers.insert(peer_id.clone(), 0);
                task.peers_source_id_map.insert(
                    peer_id.clone(),
                    task.sync
                        .as_mut()
                        .unwrap_or_else(|| unreachable!())
                        .prepare_add_source(best_block_number, best_block_hash)
                        .add_source((peer_id, role), ()),
                );
            }

            WakeUpReason::NetworkEvent(network_service::Event::Disconnected { peer_id }) => {
                task.peer_finalized_block_numbers.remove(&peer_id);
                let sync_source_id = task.peers_source_id_map.remove(&peer_id).unwrap();
                let (_, requests) = task
                    .sync
                    .as_mut()
                    .unwrap_or_else(|| unreachable!())
                    .remove_source(sync_source_id);

                // The `Disconnect` network event indicates that the main notifications substream
                // with that peer has been closed, not necessarily that the connection as a whole
                // has been closed. As such, the in-progress network requests might continue if
                // we don't abort them.
                for (request_id, abort) in requests {
                    if let Some(active) = task.active_warp_requests.remove(&request_id) {
                        debug_assert_eq!(active.peer_id, peer_id);
                    }
                    abort.abort();
                }
            }

            WakeUpReason::NetworkEvent(network_service::Event::BlockAnnounce {
                peer_id,
                announce,
            }) => {
                let sync_source_id = *task.peers_source_id_map.get(&peer_id).unwrap();
                let decoded = announce.decode();

                match task
                    .sync
                    .as_mut()
                    .unwrap_or_else(|| unreachable!())
                    .block_announce(
                        sync_source_id,
                        decoded.scale_encoded_header.to_owned(),
                        decoded.is_best,
                    ) {
                    all::BlockAnnounceOutcome::TooOld {
                        announce_block_height,
                        ..
                    } => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "block-announce",
                            sender = peer_id,
                            hash = HashDisplay(&header::hash_from_scale_encoded_header(
                                decoded.scale_encoded_header
                            )),
                            height = announce_block_height,
                            is_best = decoded.is_best,
                            outcome = "older-than-finalized-block",
                        );
                    }
                    all::BlockAnnounceOutcome::AlreadyVerified(known) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "block-announce",
                            sender = peer_id,
                            hash = HashDisplay(known.hash()),
                            height = known.height(),
                            parent_hash = HashDisplay(known.parent_hash()),
                            is_best = decoded.is_best,
                            outcome = "already-verified",
                        );
                        known.update_source_and_block();
                    }
                    all::BlockAnnounceOutcome::AlreadyPending(known) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "block-announce",
                            sender = peer_id,
                            hash = HashDisplay(known.hash()),
                            height = known.height(),
                            parent_hash = HashDisplay(known.parent_hash()),
                            is_best = decoded.is_best,
                            outcome = "already-pending",
                        );
                        known.update_source_and_block();
                    }
                    all::BlockAnnounceOutcome::Unknown(unknown) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "block-announce",
                            sender = peer_id,
                            hash = HashDisplay(unknown.hash()),
                            height = unknown.height(),
                            parent_hash = HashDisplay(unknown.parent_hash()),
                            is_best = decoded.is_best,
                            outcome = "previously-unknown",
                        );
                        unknown.insert_and_update_source(());
                    }
                    all::BlockAnnounceOutcome::InvalidHeader(error) => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "block-announce",
                            sender = peer_id,
                            hash = HashDisplay(&header::hash_from_scale_encoded_header(
                                decoded.scale_encoded_header
                            )),
                            is_best = decoded.is_best,
                            outcome = "invalid-header",
                            ?error,
                        );
                        task.network_service
                            .ban_and_disconnect(
                                peer_id,
                                network_service::BanSeverity::High,
                                "bad-block-announce",
                            )
                            .await;
                    }
                }
            }

            WakeUpReason::NetworkEvent(network_service::Event::GrandpaNeighborPacket {
                peer_id,
                finalized_block_height,
            }) => {
                task.received_grandpa_neighbor = true;
                task.peer_finalized_block_numbers
                    .insert(peer_id.clone(), finalized_block_height);
                let sync_source_id = *task.peers_source_id_map.get(&peer_id).unwrap();
                task.sync
                    .as_mut()
                    .unwrap_or_else(|| unreachable!())
                    .update_source_finality_state(sync_source_id, finalized_block_height);
            }

            WakeUpReason::NetworkEvent(network_service::Event::GrandpaCommitMessage {
                peer_id,
                message,
            }) => {
                let sync_source_id = *task.peers_source_id_map.get(&peer_id).unwrap();
                match task
                    .sync
                    .as_mut()
                    .unwrap_or_else(|| unreachable!())
                    .grandpa_commit_message(sync_source_id, message.into_encoded())
                {
                    all::GrandpaCommitMessageOutcome::Queued => {
                        // TODO: print more details?
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "grandpa-commit-message-queued",
                            sender = peer_id
                        );
                    }
                    all::GrandpaCommitMessageOutcome::Discarded => {
                        log!(
                            &task.platform,
                            Debug,
                            &task.log_target,
                            "grandpa-commit-message-ignored",
                            sender = peer_id
                        );
                    }
                }
            }

            WakeUpReason::MustSubscribeNetworkEvents => {
                debug_assert!(task.from_network_service.is_none());
                for (_, sync_source_id) in task.peers_source_id_map.drain() {
                    let (_, requests) = task
                        .sync
                        .as_mut()
                        .unwrap_or_else(|| unreachable!())
                        .remove_source(sync_source_id);
                    for (request_id, abort) in requests {
                        task.active_warp_requests.remove(&request_id);
                        abort.abort();
                    }
                }
                task.peer_finalized_block_numbers.clear();
                task.from_network_service = Some(Box::pin(
                    // As documented, `subscribe().await` is expected to return quickly.
                    task.network_service.subscribe().await,
                ));
            }

            WakeUpReason::MustUpdateNetworkWithBestBlock => {
                // The networking service needs to be kept up to date with what the local node
                // considers as the best block.
                // For some reason, first building the future then executing it solves a borrow
                // checker error.
                let Some(sync) = &task.sync else {
                    unreachable!()
                };

                let fut = task
                    .network_service
                    .set_local_best_block(*sync.best_block_hash(), sync.best_block_number());
                fut.await;

                task.network_up_to_date_best = true;
            }

            WakeUpReason::MustUpdateNetworkWithFinalizedBlock => {
                // If the chain uses GrandPa, the networking has to be kept up-to-date with the
                // state of finalization for other peers to send back relevant gossip messages.
                // (code style) `grandpa_set_id` is extracted first in order to avoid borrowing
                // checker issues.
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                let grandpa_set_id =
                    if let chain::chain_information::ChainInformationFinalityRef::Grandpa {
                        after_finalized_block_authorities_set_id,
                        ..
                    } = sync.as_chain_information().as_ref().finality
                    {
                        Some(after_finalized_block_authorities_set_id)
                    } else {
                        None
                    };

                if let Some(set_id) = grandpa_set_id {
                    task.network_service
                        .set_local_grandpa_state(network::service::GrandpaState {
                            set_id,
                            round_number: 1, // TODO:
                            commit_finalized_height: sync.finalized_block_number(),
                        })
                        .await;
                }

                task.network_up_to_date_finalized = true;
            }

            WakeUpReason::ForegroundMessage(ToBackground::IsNearHeadOfChainHeuristic {
                send_back,
            }) => {
                // Frontend is querying something.
                let _ = send_back.send(
                    task.sync
                        .as_ref()
                        .unwrap_or_else(|| unreachable!())
                        .is_near_head_of_chain_heuristic(),
                );
            }

            WakeUpReason::ForegroundMessage(ToBackground::SubscribeAll {
                send_back,
                buffer_size,
                runtime_interest,
            }) => {
                // Frontend would like to subscribe to events.

                let Some(sync) = &task.sync else {
                    unreachable!()
                };

                let (tx, new_blocks) = async_channel::bounded(buffer_size.saturating_sub(1));
                task.all_notifications.push(tx);

                let non_finalized_blocks_ancestry_order = {
                    sync.non_finalized_blocks_ancestry_order()
                        .map(|h| {
                            let scale_encoding = h.scale_encoding_vec(sync.block_number_bytes());
                            BlockNotification {
                                is_new_best: header::hash_from_scale_encoded_header(
                                    &scale_encoding,
                                ) == *sync.best_block_hash(),
                                scale_encoded_header: scale_encoding,
                                parent_hash: *h.parent_hash,
                            }
                        })
                        .collect()
                };

                let _ = send_back.send(SubscribeAll {
                    finalized_block_scale_encoded_header: sync.finalized_block_header().to_owned(),
                    finalized_block_runtime: if runtime_interest {
                        task.known_finalized_runtime.take()
                    } else {
                        None
                    },
                    non_finalized_blocks_ancestry_order,
                    new_blocks,
                });
            }

            WakeUpReason::ForegroundMessage(ToBackground::PeersAssumedKnowBlock {
                send_back,
                block_number,
                block_hash,
            }) => {
                // Frontend queries the list of peers which are expected to know about a certain
                // block.
                let Some(sync) = &task.sync else {
                    unreachable!()
                };

                // 中文注释：peer 选择策略——尽量宽松地放行 gossip-connected peer，
                // 否则在以下场景会返回 0 个 peer 导致 "No node available for storage query"：
                //
                //   * POW + GRANDPA 链停止出块时，所有 peer 的 best == finalized，
                //     原版 strict-greater 过滤失败
                //   * POW 链在 GRANDPA 终局之前 best_hash 可能短暂不一致，
                //     原版 hash equality 失败
                //   * smoldot 刚 gossip-open 完，还没收到 peer 的 block-announce，
                //     `knows_non_finalized_block` 还不知道这个 peer 拥有该块
                //
                // citizenapp 钱包查询时常用 best_block (#64) 而 finalized 是 #62，
                // 走的是 non-finalized 分支；这里同样按 source_best.0 ≥ block_number
                // 放行，足够覆盖"peer 已经在那个高度但还没来得及把 block-announce
                // 推过来给 smoldot"的窗口。
                let outcome: Vec<_> = if block_number <= sync.finalized_block_number() {
                    // finalized 区块是共识终局，任何 gossip-connected peer 都是合法 source。
                    let _ = block_hash;
                    sync.sources().map(|id| sync[id].0.clone()).collect()
                } else {
                    // 非 finalized 区块：先用 smoldot 内部已记录的 "knows_non_finalized_block"
                    // 列表（最权威），如果为空则放宽到所有 best 高度 ≥ block_number 的
                    // peer（覆盖 peer 已在该高度但还没推 block-announce 的窗口）。
                    let primary: Vec<_> = sync
                        .knows_non_finalized_block(block_number, &block_hash)
                        .map(|id| sync[id].0.clone())
                        .collect();
                    if !primary.is_empty() {
                        primary
                    } else {
                        let relaxed: Vec<_> = sync
                            .sources()
                            .filter(|source_id| {
                                sync.source_best_block(*source_id).0 >= block_number
                            })
                            .map(|id| sync[id].0.clone())
                            .collect();
                        if !relaxed.is_empty() {
                            relaxed
                        } else {
                            // 终极兜底：所有已连接 source，让网络层自行尝试。
                            sync.sources().map(|id| sync[id].0.clone()).collect()
                        }
                    }
                };

                let _ = send_back.send(outcome);
            }

            WakeUpReason::ForegroundMessage(ToBackground::SyncingPeers { send_back }) => {
                // Frontend is querying the list of peers.
                let Some(sync) = &task.sync else {
                    unreachable!()
                };

                let out = sync
                    .sources()
                    .map(|src| {
                        let (peer_id, role) = sync[src].clone();
                        let (height, hash) = sync.source_best_block(src);
                        (peer_id, role, height, *hash)
                    })
                    .collect::<Vec<_>>();

                let _ = send_back.send(out);
            }

            WakeUpReason::ForegroundMessage(ToBackground::SyncActivitySnapshot { send_back }) => {
                let sync = task.sync.as_ref().unwrap_or_else(|| unreachable!());
                // 完成判定只读取 warp 内核阶段和完整 chain information。fragment 暂时
                // 指向的目标与已经完整验证的 finalized 必须分别输出，禁止再由高度猜测。
                let (
                    current_verified_finalized_block_number,
                    current_verified_finalized_block_hash,
                ) = sync.verified_finalized_block();
                let highest_peer_finalized_block_number = task
                    .peer_finalized_block_numbers
                    .values()
                    .copied()
                    .max()
                    .filter(|height| *height > 0);
                let (phase, warp_target_finalized_block_number, warp_target_finalized_block_hash) =
                    match sync.status() {
                        all::Status::Sync => (SyncPhase::Regular, None, None),
                        all::Status::WarpSync {
                            phase,
                            target_finalized_block_number,
                            target_finalized_block_hash,
                            ..
                        } => {
                            let phase = match phase {
                                all::WarpSyncPhase::Idle => unreachable!(),
                                all::WarpSyncPhase::DownloadingFragments => {
                                    SyncPhase::WarpDownloadingFragments
                                }
                                all::WarpSyncPhase::VerifyingFragments => {
                                    SyncPhase::WarpVerifyingFragments
                                }
                                all::WarpSyncPhase::DownloadingTargetState => {
                                    SyncPhase::WarpDownloadingTargetState
                                }
                                all::WarpSyncPhase::BuildingRuntime => {
                                    SyncPhase::WarpBuildingRuntime
                                }
                                all::WarpSyncPhase::BuildingChainInformation => {
                                    SyncPhase::WarpBuildingChainInformation
                                }
                            };
                            let (
                                warp_target_finalized_block_number,
                                warp_target_finalized_block_hash,
                            ) = warp_target_snapshot(
                                highest_peer_finalized_block_number,
                                target_finalized_block_number,
                                target_finalized_block_hash,
                                current_verified_finalized_block_number,
                            );
                            (
                                phase,
                                Some(warp_target_finalized_block_number),
                                warp_target_finalized_block_hash,
                            )
                        }
                    };
                let active_warp_fragment_request_count = task
                    .active_warp_requests
                    .values()
                    .filter(|request| request.kind == WarpNetworkRequestKind::Fragments)
                    .count()
                    .try_into()
                    .unwrap_or(u64::MAX);
                let active_warp_storage_request_count = task
                    .active_warp_requests
                    .values()
                    .filter(|request| request.kind == WarpNetworkRequestKind::Storage)
                    .count()
                    .try_into()
                    .unwrap_or(u64::MAX);
                let active_warp_call_proof_request_count = task
                    .active_warp_requests
                    .values()
                    .filter(|request| request.kind == WarpNetworkRequestKind::CallProof)
                    .count()
                    .try_into()
                    .unwrap_or(u64::MAX);
                let _ = send_back.send(SyncActivitySnapshot {
                    phase,
                    startup_finalized_source: Some(task.startup_finalized_source),
                    startup_finalized_block_number: Some(task.startup_finalized_block_number),
                    startup_finalized_block_hash: Some(task.startup_finalized_block_hash),
                    highest_peer_finalized_block_number,
                    current_verified_finalized_block_number,
                    current_verified_finalized_block_hash,
                    warp_target_finalized_block_number,
                    warp_target_finalized_block_hash,
                    warp_request_count: task.warp_request_count,
                    active_warp_fragment_request_count,
                    active_warp_storage_request_count,
                    active_warp_call_proof_request_count,
                    warp_received_fragment_count: task.warp_received_fragment_count,
                    warp_verified_fragment_count: task.warp_verified_fragment_count,
                    warp_rejected_fragment_count: task.warp_rejected_fragment_count,
                    warp_last_failure: task.warp_last_failure,
                });
            }

            WakeUpReason::ForegroundMessage(ToBackground::SerializeChainInformation {
                send_back,
            }) => {
                let sync = task.sync.as_ref().unwrap_or_else(|| unreachable!());
                // warp 活跃时完整 chain information 仍停在 H；此时即使它本身有效，也
                // 不能导出并贴成最新 F 的 database。只有 warp 回到 regular 后才开放。
                let chain_information = matches!(sync.status(), all::Status::Sync)
                    .then(|| sync.as_chain_information().into());
                let _ = send_back.send(chain_information);
            }

            WakeUpReason::ForegroundClosed => {
                // The channel with the frontend sync service has been closed.
                // Closing the sync background task as a result.
                return;
            }

            WakeUpReason::RequestFinished(request_id, Err(_)) => {
                // source 删除或请求过期时，状态机已经恢复对应请求状态；这里只清理
                // 请求级诊断元数据，不能把取消误报为 peer 协议失败。
                task.active_warp_requests.remove(&request_id);
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::Block(Ok(v)))) => {
                // Successful block request.
                task.sync
                    .as_mut()
                    .unwrap_or_else(|| unreachable!())
                    .blocks_request_response(
                        request_id,
                        v.into_iter().filter_map(|block| {
                            Some(all::BlockRequestSuccessBlock {
                                scale_encoded_header: block.header?,
                                scale_encoded_justifications: block
                                    .justifications
                                    .unwrap_or(Vec::new())
                                    .into_iter()
                                    .map(|j| all::Justification {
                                        engine_id: j.engine_id,
                                        justification: j.justification,
                                    })
                                    .collect(),
                                scale_encoded_extrinsics: Vec::new(),
                                user_data: (),
                            })
                        }),
                    );
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::Block(Err(_)))) => {
                // Failed block request.
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                let source_peer_id = sync[sync.request_source_id(request_id)].0.clone();

                task.network_service
                    .ban_and_disconnect(
                        source_peer_id,
                        network_service::BanSeverity::Low,
                        "failed-blocks-request",
                    )
                    .await;

                sync.remove_request(request_id);
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::WarpSync(Ok(result)))) => {
                // Successful warp sync request.
                let active = take_active_warp_request(
                    &mut task.active_warp_requests,
                    &request_id,
                    WarpNetworkRequestKind::Fragments,
                );
                let _elapsed = task.platform.now() - active.started_at;
                let decoded = result.decode();
                task.warp_received_fragment_count = task
                    .warp_received_fragment_count
                    .saturating_add(u64::try_from(decoded.fragments.len()).unwrap_or(u64::MAX));
                let fragments = decoded
                    .fragments
                    .into_iter()
                    .map(|f| all::WarpSyncFragment {
                        scale_encoded_header: f.scale_encoded_header.to_vec(),
                        scale_encoded_justification: f.scale_encoded_justification.to_vec(),
                    })
                    .collect();
                task.sync
                    .as_mut()
                    .unwrap_or_else(|| unreachable!())
                    .grandpa_warp_sync_response(request_id, fragments, decoded.is_finished);
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::WarpSync(Err(_)))) => {
                // Failed warp sync request.
                task.warp_last_failure = Some(WarpFailure::WarpRequestFailed);
                let active = take_active_warp_request(
                    &mut task.active_warp_requests,
                    &request_id,
                    WarpNetworkRequestKind::Fragments,
                );
                let _elapsed = task.platform.now() - active.started_at;
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                task.network_service
                    .ban_and_disconnect(
                        active.peer_id,
                        network_service::BanSeverity::Low,
                        "failed-warp-sync-request",
                    )
                    .await;

                sync.remove_request(request_id);
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::Storage(Ok(r)))) => {
                // Storage proof request.
                let active = take_active_warp_request(
                    &mut task.active_warp_requests,
                    &request_id,
                    WarpNetworkRequestKind::Storage,
                );
                let _elapsed = task.platform.now() - active.started_at;
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                sync.storage_get_response(request_id, r);
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::Storage(Err(_)))) => {
                // Storage proof request.
                task.warp_last_failure = Some(WarpFailure::StorageProofRequestFailed);
                let active = take_active_warp_request(
                    &mut task.active_warp_requests,
                    &request_id,
                    WarpNetworkRequestKind::Storage,
                );
                let _elapsed = task.platform.now() - active.started_at;
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                task.network_service
                    .ban_and_disconnect(
                        active.peer_id,
                        network_service::BanSeverity::Low,
                        "failed-storage-request",
                    )
                    .await;

                sync.remove_request(request_id);
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::CallProof(Ok(r)))) => {
                // Successful call proof request.
                let active = take_active_warp_request(
                    &mut task.active_warp_requests,
                    &request_id,
                    WarpNetworkRequestKind::CallProof,
                );
                let _elapsed = task.platform.now() - active.started_at;
                task.sync
                    .as_mut()
                    .unwrap_or_else(|| unreachable!())
                    .call_proof_response(request_id, r.decode().to_owned());
                // TODO: need help from networking service to avoid this to_owned
            }

            WakeUpReason::RequestFinished(request_id, Ok(RequestOutcome::CallProof(Err(_)))) => {
                // Failed call proof request.
                task.warp_last_failure = Some(WarpFailure::CallProofRequestFailed);
                let active = take_active_warp_request(
                    &mut task.active_warp_requests,
                    &request_id,
                    WarpNetworkRequestKind::CallProof,
                );
                let _elapsed = task.platform.now() - active.started_at;
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                task.network_service
                    .ban_and_disconnect(
                        active.peer_id,
                        network_service::BanSeverity::Low,
                        "failed-call-proof-request",
                    )
                    .await;

                sync.remove_request(request_id);
            }

            WakeUpReason::ObsoleteRequest(request_id) => {
                // We are no longer interested in the answer to that request.
                task.active_warp_requests.remove(&request_id);
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                let abort_handle = sync.remove_request(request_id);
                abort_handle.abort();
            }

            WakeUpReason::StartRequest(
                source_id,
                all::DesiredRequest::BlocksRequest {
                    first_block_hash,
                    first_block_height,
                    num_blocks,
                    request_headers,
                    request_bodies,
                    request_justification,
                },
            ) => {
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                // Before inserting the request back to the syncing state machine, clamp the number
                // of blocks to the number of blocks we expect to receive.
                // This constant corresponds to the maximum number of blocks that nodes will answer
                // in one request. If this constant happens to be inaccurate, everything will still
                // work but less efficiently.
                let num_blocks = NonZero::<u64>::new(cmp::min(64, num_blocks.get())).unwrap();

                let peer_id = sync[source_id].0.clone(); // TODO: why does this require cloning? weird borrow chk issue

                let block_request = task.network_service.clone().blocks_request(
                    peer_id,
                    network::codec::BlocksRequestConfig {
                        start: network::codec::BlocksRequestConfigStart::Hash(first_block_hash),
                        desired_count: NonZero::<u32>::new(
                            u32::try_from(num_blocks.get()).unwrap_or(u32::MAX),
                        )
                        .unwrap(),
                        // The direction is hardcoded based on the documentation of the syncing
                        // state machine.
                        direction: network::codec::BlocksRequestDirection::Descending,
                        fields: network::codec::BlocksRequestFields {
                            header: request_headers,
                            body: request_bodies,
                            justifications: request_justification,
                        },
                    },
                    Duration::from_secs(10),
                );

                let (block_request, abort) = future::abortable(block_request);
                let request_id = sync.add_request(
                    source_id,
                    all::RequestDetail::BlocksRequest {
                        first_block_hash,
                        first_block_height,
                        num_blocks,
                        request_headers,
                        request_bodies,
                        request_justification,
                    },
                    abort,
                );

                task.pending_requests.push(Box::pin(async move {
                    (request_id, block_request.await.map(RequestOutcome::Block))
                }));
            }

            WakeUpReason::StartRequest(
                source_id,
                all::DesiredRequest::WarpSync {
                    sync_start_block_hash,
                },
            ) => {
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                let peer_id = sync[source_id].0.clone(); // TODO: why does this require cloning? weird borrow chk issue

                let grandpa_request = task.network_service.clone().grandpa_warp_sync_request(
                    peer_id.clone(),
                    sync_start_block_hash,
                    // The timeout needs to be long enough to potentially download the maximum
                    // response size of 16 MiB. Assuming a 128 kiB/sec connection, that's
                    // 128 seconds. Unfortunately, 128 seconds is way too large, and for
                    // pragmatic reasons we use a lower value.
                    Duration::from_secs(24),
                );
                task.warp_request_count = task.warp_request_count.saturating_add(1);

                let (grandpa_request, abort) = future::abortable(grandpa_request);
                let request_id = sync.add_request(
                    source_id,
                    all::RequestDetail::WarpSync {
                        sync_start_block_hash,
                    },
                    abort,
                );
                register_active_warp_request(
                    &mut task.active_warp_requests,
                    request_id,
                    ActiveWarpRequest {
                        kind: WarpNetworkRequestKind::Fragments,
                        peer_id: peer_id.clone(),
                        started_at: task.platform.now(),
                    },
                );

                task.pending_requests.push(Box::pin(async move {
                    (
                        request_id,
                        grandpa_request.await.map(RequestOutcome::WarpSync),
                    )
                }));
            }

            WakeUpReason::StartRequest(
                source_id,
                all::DesiredRequest::StorageGetMerkleProof {
                    block_hash, keys, ..
                },
            ) => {
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                let peer_id = sync[source_id].0.clone(); // TODO: why does this require cloning? weird borrow chk issue

                let storage_request = task.network_service.clone().storage_proof_request(
                    peer_id.clone(),
                    network::codec::StorageProofRequestConfig {
                        block_hash,
                        keys: keys.clone().into_iter(),
                    },
                    Duration::from_secs(16),
                );

                let storage_request = async move {
                    if let Ok(outcome) = storage_request.await {
                        // TODO: log what happens
                        Ok(outcome.decode().to_vec()) // TODO: no to_vec() here, needs some API change on the networking
                    } else {
                        Err(())
                    }
                };

                let (storage_request, abort) = future::abortable(storage_request);
                let request_id = sync.add_request(
                    source_id,
                    all::RequestDetail::StorageGet { block_hash, keys },
                    abort,
                );
                register_active_warp_request(
                    &mut task.active_warp_requests,
                    request_id,
                    ActiveWarpRequest {
                        kind: WarpNetworkRequestKind::Storage,
                        peer_id: peer_id.clone(),
                        started_at: task.platform.now(),
                    },
                );

                task.pending_requests.push(Box::pin(async move {
                    (
                        request_id,
                        storage_request.await.map(RequestOutcome::Storage),
                    )
                }));
            }

            WakeUpReason::StartRequest(
                source_id,
                all::DesiredRequest::RuntimeCallMerkleProof {
                    block_hash,
                    function_name,
                    parameter_vectored,
                },
            ) => {
                let Some(sync) = &mut task.sync else {
                    unreachable!()
                };

                let peer_id = sync[source_id].0.clone(); // TODO: why does this require cloning? weird borrow chk issue

                let call_proof_request = {
                    // TODO: all this copying is done because of lifetime requirements in NetworkService::call_proof_request; maybe check if it can be avoided
                    let network_service = task.network_service.clone();
                    let parameter_vectored = parameter_vectored.clone();
                    let function_name = function_name.clone();
                    let call_proof_peer_id = peer_id.clone();
                    async move {
                        let rq = network_service.call_proof_request(
                            call_proof_peer_id,
                            network::codec::CallProofRequestConfig {
                                block_hash,
                                method: Cow::Borrowed(&*function_name),
                                parameter_vectored: iter::once(&parameter_vectored),
                            },
                            Duration::from_secs(16),
                        );

                        match rq.await {
                            Ok(p) => Ok(p),
                            Err(_) => Err(()),
                        }
                    }
                };

                let (call_proof_request, abort) = future::abortable(call_proof_request);
                let request_id = sync.add_request(
                    source_id,
                    all::RequestDetail::RuntimeCallMerkleProof {
                        block_hash,
                        function_name,
                        parameter_vectored,
                    },
                    abort,
                );
                register_active_warp_request(
                    &mut task.active_warp_requests,
                    request_id,
                    ActiveWarpRequest {
                        kind: WarpNetworkRequestKind::CallProof,
                        peer_id: peer_id.clone(),
                        started_at: task.platform.now(),
                    },
                );

                task.pending_requests.push(Box::pin(async move {
                    (
                        request_id,
                        call_proof_request.await.map(RequestOutcome::CallProof),
                    )
                }));
            }
        }
    }
}

struct Task<TPlat: PlatformRef> {
    /// Log target to use for all logs that are emitted.
    log_target: String,

    /// Access to the platform's capabilities.
    platform: TPlat,

    /// Main syncing state machine. Contains a list of peers, requests, and blocks, and manages
    /// everything about the non-finalized chain.
    ///
    /// For each request, we store a [`future::AbortHandle`] that can be used to abort the
    /// request if desired.
    ///
    /// Always `Some`, except for temporary extraction.
    sync: Option<all::AllSync<future::AbortHandle, (libp2p::PeerId, codec::Role), ()>>,

    /// 本次状态机真实使用的可信 finalized 起点来源。
    startup_finalized_source: StartupFinalizedSource,
    /// 本次 addChain 实际采用的 finalized 起点，用于区分固定 checkpoint 与本机缓存恢复。
    startup_finalized_block_number: u64,
    startup_finalized_block_hash: [u8; 32],
    /// peer 最近一次 GRANDPA neighbor packet 公布的 finalized 高度。
    peer_finalized_block_numbers: HashMap<libp2p::PeerId, u64>,
    warp_request_count: u64,
    warp_received_fragment_count: u64,
    warp_verified_fragment_count: u64,
    warp_rejected_fragment_count: u64,
    warp_last_failure: Option<WarpFailure>,
    /// GRANDPA 链在取得首个 peer finalized 声明前禁止普通区块请求抢跑。
    waits_for_grandpa_neighbor: bool,
    received_grandpa_neighbor: bool,

    /// If `Some`, contains the runtime of the current finalized block.
    known_finalized_runtime: Option<FinalizedBlockRuntime>,

    /// For each networking peer, the index of the corresponding peer within the [`Task::sync`].
    peers_source_id_map: HashMap<libp2p::PeerId, all::SourceId, util::SipHasherBuild>,

    /// `false` after the best block in the [`Task::sync`] has changed. Set back to `true`
    /// after the networking has been notified of this change.
    network_up_to_date_best: bool,
    /// `false` after the finalized block in the [`Task::sync`] has changed. Set back to `true`
    /// after the networking has been notified of this change.
    network_up_to_date_finalized: bool,

    /// All event subscribers that are interested in events about the chain.
    all_notifications: Vec<async_channel::Sender<Notification>>,

    /// Chain of the network service. Used to send out requests to peers.
    network_service: Arc<network_service::NetworkServiceChain<TPlat>>,
    /// Events coming from the networking service. `None` if not subscribed yet.
    from_network_service: Option<Pin<Box<async_channel::Receiver<network_service::Event>>>>,

    /// List of requests currently in progress.
    pending_requests: stream::FuturesUnordered<
        future::BoxFuture<'static, (all::RequestId, Result<RequestOutcome, future::Aborted>)>,
    >,
    /// 每个 warp 网络请求的真实类型、实际 peer 和启动时间。失败、取消或断连时
    /// 只能处理命中的请求，禁止再用一个“最近 peer”代表整轮 warp。
    active_warp_requests:
        BTreeMap<all::RequestId, ActiveWarpRequest<libp2p::PeerId, TPlat::Instant>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WarpNetworkRequestKind {
    Fragments,
    Storage,
    CallProof,
}

struct ActiveWarpRequest<TPeer, TInstant> {
    kind: WarpNetworkRequestKind,
    peer_id: TPeer,
    started_at: TInstant,
}

fn register_active_warp_request<TKey: Ord, TPeer, TInstant>(
    requests: &mut BTreeMap<TKey, ActiveWarpRequest<TPeer, TInstant>>,
    request_id: TKey,
    active: ActiveWarpRequest<TPeer, TInstant>,
) {
    assert!(
        requests.insert(request_id, active).is_none(),
        "warp request id registered twice"
    );
}

fn take_active_warp_request<TKey: Ord, TPeer, TInstant>(
    requests: &mut BTreeMap<TKey, ActiveWarpRequest<TPeer, TInstant>>,
    request_id: &TKey,
    expected_kind: WarpNetworkRequestKind,
) -> ActiveWarpRequest<TPeer, TInstant> {
    let active = requests
        .remove(request_id)
        .expect("warp request completion missing active request metadata");
    assert_eq!(active.kind, expected_kind, "warp request kind mismatch");
    active
}

/// peer 公布的 `F` 是当前 warp 目标；fragment 尚未把 `F` 的 header 证明出来前，
/// 内核 target 仍是起点 `H`，此时禁止把 `H` 的 hash 冒充 `F` 的 hash。
fn warp_target_snapshot(
    highest_peer_finalized_block_number: Option<u64>,
    proof_target_finalized_block_number: u64,
    proof_target_finalized_block_hash: [u8; 32],
    current_verified_finalized_block_number: u64,
) -> (u64, Option<[u8; 32]>) {
    let target_number = highest_peer_finalized_block_number
        .map(|peer_target| peer_target.max(proof_target_finalized_block_number))
        .unwrap_or(proof_target_finalized_block_number);
    let target_hash = (target_number == proof_target_finalized_block_number
        && proof_target_finalized_block_number > current_verified_finalized_block_number)
        .then_some(proof_target_finalized_block_hash);
    (target_number, target_hash)
}

enum RequestOutcome {
    Block(Result<Vec<codec::BlockData>, network_service::BlocksRequestError>),
    WarpSync(
        Result<
            network::service::EncodedGrandpaWarpSyncResponse,
            network_service::WarpSyncRequestError,
        >,
    ),
    Storage(Result<Vec<u8>, ()>),
    CallProof(Result<network::service::EncodedMerkleProof, ()>),
}

impl<TPlat: PlatformRef> Task<TPlat> {
    /// Sends a notification to all the notification receivers.
    fn dispatch_all_subscribers(&mut self, notification: Notification) {
        // Elements in `all_notifications` are removed one by one and inserted back if the
        // channel is still open.
        for index in (0..self.all_notifications.len()).rev() {
            let subscription = self.all_notifications.swap_remove(index);
            if subscription.try_send(notification.clone()).is_err() {
                continue;
            }

            self.all_notifications.push(subscription);
        }
    }
}

#[cfg(test)]
mod warp_request_registry_tests {
    use super::{
        ActiveWarpRequest, BTreeMap, WarpNetworkRequestKind, register_active_warp_request,
        take_active_warp_request, warp_target_snapshot,
    };

    #[test]
    fn completing_one_request_never_consumes_another_peers_request() {
        let mut requests = BTreeMap::new();
        register_active_warp_request(
            &mut requests,
            1_u8,
            ActiveWarpRequest {
                kind: WarpNetworkRequestKind::Fragments,
                peer_id: "fragment-peer",
                started_at: 10_u64,
            },
        );
        register_active_warp_request(
            &mut requests,
            2_u8,
            ActiveWarpRequest {
                kind: WarpNetworkRequestKind::Storage,
                peer_id: "storage-peer",
                started_at: 20_u64,
            },
        );

        let completed =
            take_active_warp_request(&mut requests, &1, WarpNetworkRequestKind::Fragments);
        assert_eq!(completed.peer_id, "fragment-peer");
        assert_eq!(completed.started_at, 10);
        assert_eq!(requests.get(&2).unwrap().peer_id, "storage-peer");
    }

    #[test]
    fn cancelled_request_can_be_registered_again_for_another_peer() {
        let mut requests = BTreeMap::new();
        register_active_warp_request(
            &mut requests,
            7_u8,
            ActiveWarpRequest {
                kind: WarpNetworkRequestKind::CallProof,
                peer_id: "first-peer",
                started_at: 1_u64,
            },
        );
        requests.remove(&7).unwrap();
        register_active_warp_request(
            &mut requests,
            8_u8,
            ActiveWarpRequest {
                kind: WarpNetworkRequestKind::CallProof,
                peer_id: "second-peer",
                started_at: 2_u64,
            },
        );

        assert_eq!(requests.get(&8).unwrap().peer_id, "second-peer");
    }

    #[test]
    fn peer_target_never_reuses_the_start_anchor_hash() {
        let start_hash = [7_u8; 32];
        let (target_number, target_hash) = warp_target_snapshot(Some(50_000), 0, start_hash, 0);
        assert_eq!(target_number, 50_000);
        assert_eq!(target_hash, None);

        let proven_hash = [9_u8; 32];
        let (target_number, target_hash) =
            warp_target_snapshot(Some(50_000), 50_000, proven_hash, 0);
        assert_eq!(target_number, 50_000);
        assert_eq!(target_hash, Some(proven_hash));
    }
}
