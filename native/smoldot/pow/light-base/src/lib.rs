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

//! Smoldot light client library.
//!
//! This library provides an easy way to create a light client.
//!
//! This light client is opinionated towards certain aspects: what it downloads, how much memory
//! and CPU it is willing to consume, etc.
//!
//! # Usage
//!
//! ## Initialization
//!
//! In order to use the light client, call [`Client::new`], passing an implementation of the
//! [`platform::PlatformRef`] trait. See the documentation of the [`platform::PlatformRef`] trait
//! for more information.
//!
//! The [`Client`] contains two generic parameters:
//!
//! - An implementation of the [`platform::PlatformRef`] trait.
//! - An opaque user data. If you do not use this, you can simply use `()`.
//!
//! When the `std` feature of this library is enabled, the [`platform::DefaultPlatform`] struct
//! can be used as an implementation of [`platform::PlatformRef`].
//!
//! For example:
//!
//! ```rust
//! use smoldot_light::{Client, platform::DefaultPlatform};
//! let client = Client::new(DefaultPlatform::new(env!("CARGO_PKG_NAME").into(), env!("CARGO_PKG_VERSION").into()));
//! # let _: Client<_, ()> = client;  // Used in this example to infer the generic parameters of the Client
//! ```
//!
//! If the `std` feature of this library is disabled, then you need to implement the
//! [`platform::PlatformRef`] trait manually.
//!
//! ## Adding a chain
//!
//! After the client has been initialized, use [`Client::add_chain`] to ask the client to connect
//! to said chain. See the documentation of [`AddChainConfig`] for information about what to
//! provide.
//!
//! [`Client::add_chain`] returns a [`ChainId`], which identifies the chain within the [`Client`].
//! A [`Client`] can be thought of as a collection of chain connections, each identified by their
//! [`ChainId`], akin to a `HashMap<ChainId, ...>`.
//!
//! A chain can be removed at any time using [`Client::remove_chain`]. This will cause the client
//! to stop all connections and clean up its internal services. The [`ChainId`] is instantly
//! considered as invalid as soon as the method is called.
//!
//! ## JSON-RPC requests and responses
//!
//! Once a chain has been added, one can send JSON-RPC requests using [`Client::json_rpc_request`].
//!
//! The request parameter of this function must be a JSON-RPC request in its text form. For
//! example: `{"id":53,"jsonrpc":"2.0","method":"system_name","params":[]}`.
//!
//! Calling [`Client::json_rpc_request`] queues the request in the internals of the client. Later,
//! the client will process it.
//!
//! Responses can be pulled by calling the [`AddChainSuccess::json_rpc_responses`] that is returned
//! after a chain has been added.
//!

#![cfg_attr(not(any(test, feature = "std")), no_std)]
#![forbid(unsafe_code)]
#![deny(rustdoc::broken_intra_doc_links)]
// 开发依赖会触发 Rust 误报，因此在上游 rust-lang/rust#95513 解决前不启用此 lint。
// #![deny(unused_crate_dependencies)]

extern crate alloc;

// WASM 的 no_std 目标不提供 std prelude，字符串错误分支必须显式引入 alloc Trait。
use alloc::{
    borrow::ToOwned as _,
    boxed::Box,
    collections::BTreeMap,
    format,
    string::{String, ToString as _},
    sync::Arc,
    vec,
    vec::Vec,
};
use core::{fmt, num::NonZero, ops, pin::Pin, time::Duration};
use hashbrown::{HashMap, hash_map::Entry};
use itertools::Itertools as _;
use platform::PlatformRef;
use smoldot::{
    chain, chain_spec, header,
    informant::HashDisplay,
    libp2p::{multiaddr, peer_id},
    network::codec,
};

mod database;
mod json_rpc_service;
mod runtime_service;
mod sync_service;
mod transactions_service;

pub use sync_service::{StartupFinalizedSource, SyncPhase, WarpFailure};
mod util;

pub mod network_service;
pub mod platform;

pub use json_rpc_service::HandleRpcError;

/// See [`Client::add_chain`].
#[derive(Debug, Clone)]
pub struct AddChainConfig<'a, TChain, TRelays> {
    /// Opaque user data that the [`Client`] will hold for this chain. Can later be accessed using
    /// the `Index` and `IndexMut` trait implementations on the [`Client`].
    pub user_data: TChain,

    /// JSON text containing the specification of the chain (the so-called "chain spec").
    pub specification: &'a str,

    /// Opaque data containing the database content that was retrieved by calling
    /// the `chainHead_unstable_finalizedDatabase` JSON-RPC function in the past.
    ///
    /// Pass an empty string if no database content exists or is known.
    ///
    /// No error is generated if this data is invalid and/or can't be decoded. The implementation
    /// reserves the right to break the format of this data at any point.
    pub database_content: &'a str,

    /// If [`AddChainConfig`] defines a parachain, contains the list of relay chains to choose
    /// from. Ignored if not a parachain.
    ///
    /// This field is necessary because multiple different chain can have the same identity. If
    /// the client tried to find the corresponding relay chain in all the previously-spawned
    /// chains, it means that a call to [`Client::add_chain`] could influence the outcome of a
    /// subsequent call to [`Client::add_chain`].
    ///
    /// For example: if user A adds a chain named "Kusama", then user B adds a different chain
    /// also named "Kusama", then user B adds a parachain whose relay chain is "Kusama", it would
    /// be wrong to connect to the "Kusama" created by user A.
    pub potential_relay_chains: TRelays,

    /// Configuration for the JSON-RPC endpoint.
    pub json_rpc: AddChainConfigJsonRpc,
}

/// See [`AddChainConfig::json_rpc`].
#[derive(Debug, Clone)]
pub enum AddChainConfigJsonRpc {
    /// No JSON-RPC endpoint is available for this chain.  This saves up a lot of resources, but
    /// will cause all JSON-RPC requests targeting this chain to fail.
    Disabled,

    /// The JSON-RPC endpoint is enabled. Normal operations.
    Enabled {
        /// Maximum number of JSON-RPC requests that can be added to a queue if it is not ready to
        /// be processed immediately. Any additional request will be immediately rejected.
        ///
        /// This parameter is necessary in order to prevent JSON-RPC clients from using up too
        /// much memory within the client.
        /// If the JSON-RPC client is entirely trusted, then passing `u32::MAX` is
        /// completely reasonable.
        ///
        /// A typical value is 128.
        max_pending_requests: NonZero<u32>,

        /// Maximum number of active subscriptions that can be started through JSON-RPC functions.
        /// Any request that causes the JSON-RPC server to generate notifications counts as a
        /// subscription.
        /// Any additional subscription over this limit will be immediately rejected.
        ///
        /// This parameter is necessary in order to prevent JSON-RPC clients from using up too
        /// much memory within the client.
        /// If the JSON-RPC client is entirely trusted, then passing `u32::MAX` is
        /// completely reasonable.
        ///
        /// While a typical reasonable value would be for example 64, existing UIs tend to start
        /// a lot of subscriptions, and a value such as 1024 is recommended.
        max_subscriptions: u32,
    },
}

/// Chain registered in a [`Client`].
///
/// This type is a simple wrapper around a `usize`. Use the `From<usize> for ChainId` and
/// `From<ChainId> for usize` trait implementations to convert back and forth if necessary.
//
// Implementation detail: corresponds to indices within [`Client::public_api_chains`].
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChainId(usize);

impl From<usize> for ChainId {
    fn from(id: usize) -> ChainId {
        ChainId(id)
    }
}

impl From<ChainId> for usize {
    fn from(chain_id: ChainId) -> usize {
        chain_id.0
    }
}

/// Holds a list of chains, connections, and JSON-RPC services.
pub struct Client<TPlat: platform::PlatformRef, TChain = ()> {
    /// Access to the platform capabilities.
    platform: TPlat,

    /// List of chains currently running according to the public API. Indices in this container
    /// are reported through the public API. The values are either an error if the chain has failed
    /// to initialize, or key found in [`Client::chains_by_key`].
    public_api_chains: slab::Slab<PublicApiChain<TPlat, TChain>>,

    /// De-duplicated list of chains that are *actually* running.
    ///
    /// For each key, contains the services running for this chain plus the number of public API
    /// chains that correspond to it.
    ///
    /// Because we use a `SipHasher`, this hashmap isn't created in the `new` function (as this
    /// function is `const`) but lazily the first time it is needed.
    chains_by_key: Option<HashMap<ChainKey, RunningChain<TPlat>, util::SipHasherBuild>>,

    /// All chains share a single networking service created lazily the first time that it
    /// is used.
    network_service: Option<Arc<network_service::NetworkService<TPlat>>>,
}

struct PublicApiChain<TPlat: PlatformRef, TChain> {
    /// Opaque user data passed to [`Client::add_chain`].
    user_data: TChain,

    /// Index of the underlying chain found in [`Client::chains_by_key`].
    key: ChainKey,

    /// Identifier of the chain found in its chain spec. Equal to the return value of
    /// [`chain_spec::ChainSpec::id`]. Used in order to match parachains with relay chains.
    chain_spec_chain_id: String,

    /// Handle that sends requests to the JSON-RPC service that runs in the background.
    /// Destroying this handle also shuts down the service. `None` iff
    /// [`AddChainConfig::json_rpc`] was [`AddChainConfigJsonRpc::Disabled`] when adding the chain.
    json_rpc_frontend: Option<json_rpc_service::Frontend<TPlat>>,

    /// Notified when the [`PublicApiChain`] is destroyed, in order for the [`JsonRpcResponses`]
    /// to detect when the chain has been removed.
    public_api_chain_destroyed_event: event_listener::Event,
}

/// Identifies a chain, so that multiple identical chains are de-duplicated.
///
/// This struct serves as the key in a `HashMap<ChainKey, ChainServices>`. It must contain all the
/// values that are important to the logic of the fields that are contained in [`ChainServices`].
/// Failing to include a field in this struct could lead to two different chains using the same
/// [`ChainServices`], which has security consequences.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ChainKey {
    /// Hash of the genesis block of the chain.
    genesis_block_hash: [u8; 32],

    // 当前键不包含轻客户端检查点；引入该输入时必须同步扩展键，避免错误复用服务。
    // 链规范启用 forkBlocks 或 badBlocks 后也必须将对应字段纳入键。
    /// If the chain is a parachain, contains the relay chain and the "para ID" on this relay
    /// chain.
    relay_chain: Option<(Box<ChainKey>, u32)>,

    /// Networking fork id, found in the chain specification.
    fork_id: Option<String>,
}

struct RunningChain<TPlat: platform::PlatformRef> {
    /// Services that are dedicated to this chain. Wrapped within a `MaybeDone` because the
    /// initialization is performed asynchronously.
    services: ChainServices<TPlat>,

    /// Name of this chain in the logs. This is not necessarily the same as the identifier of the
    /// chain in its chain specification.
    log_name: String,

    /// Number of elements in [`Client::public_api_chains`] that reference this chain. If this
    /// number reaches `0`, the [`RunningChain`] should be destroyed.
    num_references: NonZero<u32>,
}

struct ChainServices<TPlat: platform::PlatformRef> {
    genesis_block_hash: [u8; 32],
    network_service: Arc<network_service::NetworkServiceChain<TPlat>>,
    sync_service: Arc<sync_service::SyncService<TPlat>>,
    runtime_service: Arc<runtime_service::RuntimeService<TPlat>>,
    transactions_service: Arc<transactions_service::TransactionsService<TPlat>>,
    recent_block_cache: Arc<async_lock::Mutex<RecentBlockCache>>,
    finalized_ancestry_cache: Arc<async_lock::Mutex<FinalizedAncestryAnchorCache>>,
}

impl<TPlat: platform::PlatformRef> Clone for ChainServices<TPlat> {
    fn clone(&self) -> Self {
        ChainServices {
            genesis_block_hash: self.genesis_block_hash,
            network_service: self.network_service.clone(),
            sync_service: self.sync_service.clone(),
            runtime_service: self.runtime_service.clone(),
            transactions_service: self.transactions_service.clone(),
            recent_block_cache: self.recent_block_cache.clone(),
            finalized_ancestry_cache: self.finalized_ancestry_cache.clone(),
        }
    }
}

/// Proof-derived finalized anchors have an independent trust domain from the mixed best cache.
/// 4,096 anchors at an initial 64-block stride cover 262,144 heights; when full, the cache
/// doubles its stride and deterministically compacts. Eviction only increases network work.
const FINALIZED_ANCESTRY_BASE_STRIDE: u64 = 64;
const FINALIZED_ANCESTRY_MAX_ANCHORS: usize = 4_096;
/// 至少容纳四个正式 120-block batch；当前 batch 在淘汰时始终受保护。
const FINALIZED_EXACT_RECENT_CAPACITY: usize = 512;

struct FinalizedAncestryAnchorCache {
    stride: u64,
    anchors: BTreeMap<u64, [u8; 32]>,
    exact_recent: BTreeMap<u64, [u8; 32]>,
    last_verified_upper: Option<(u64, [u8; 32])>,
}

impl FinalizedAncestryAnchorCache {
    fn new() -> Self {
        Self {
            stride: FINALIZED_ANCESTRY_BASE_STRIDE,
            anchors: BTreeMap::new(),
            exact_recent: BTreeMap::new(),
            last_verified_upper: None,
        }
    }

    fn observe_verified_upper(&mut self, number: u64, hash: [u8; 32]) -> Result<(), String> {
        if let Some((previous_number, previous_hash)) = self.last_verified_upper {
            if number < previous_number {
                self.invalidate();
                return Err("Verified finalized upper bound regressed".to_owned());
            }
            if number == previous_number && hash != previous_hash {
                self.invalidate();
                return Err(
                    "Verified finalized upper hash conflicted at the same height".to_owned(),
                );
            }
        }
        if self
            .anchors
            .get(&number)
            .is_some_and(|existing| *existing != hash)
            || self
                .exact_recent
                .get(&number)
                .is_some_and(|existing| *existing != hash)
        {
            self.invalidate();
            return Err(
                "Verified finalized upper conflicted with a proof-derived anchor".to_owned(),
            );
        }
        self.last_verified_upper = Some((number, hash));
        self.insert_proven_anchor(number, hash)
    }

    fn nearest_anchor_at_or_above(
        &self,
        number: u64,
        verified_upper_number: u64,
    ) -> Option<(u64, [u8; 32])> {
        self.anchors
            .range(number..=verified_upper_number)
            .next()
            .map(|(height, hash)| (*height, *hash))
    }

    fn exact_blocks(
        &self,
        start_number: u64,
        end_number: u64,
    ) -> Option<Vec<ChainFinalizedBlockSnapshot>> {
        let expected_len = end_number
            .checked_sub(start_number)?
            .checked_add(1)
            .and_then(|length| usize::try_from(length).ok())?;
        let blocks = self
            .exact_recent
            .range(start_number..=end_number)
            .map(|(number, hash)| ChainFinalizedBlockSnapshot {
                block_number: *number,
                block_hash: *hash,
            })
            .collect::<Vec<_>>();
        (blocks.len() == expected_len).then_some(blocks)
    }

    fn insert_proven_anchor(&mut self, number: u64, hash: [u8; 32]) -> Result<(), String> {
        if let Some(existing) = self.anchors.get(&number) {
            if *existing != hash {
                self.invalidate();
                return Err(
                    "Conflicting proof-derived finalized hash at the same height".to_owned(),
                );
            }
            return Ok(());
        }
        if number % self.stride != 0 {
            return Ok(());
        }
        self.anchors.insert(number, hash);
        self.compact();
        Ok(())
    }

    /// 一次 ancestry 全部验证成功后，原子登记 sparse path 与请求区间的 exact identities。
    fn commit_proven_batch(
        &mut self,
        staged_stride: u64,
        sparse_path: &[(u64, [u8; 32])],
        exact_blocks: &[ChainFinalizedBlockSnapshot],
    ) -> Result<(), String> {
        if exact_blocks.is_empty()
            || exact_blocks.len() > FINALIZED_EXACT_RECENT_CAPACITY
            || exact_blocks
                .windows(2)
                .any(|pair| pair[0].block_number.checked_add(1) != Some(pair[1].block_number))
        {
            self.invalidate();
            return Err(
                "Proof-derived exact finalized batch has an invalid length or order".to_owned(),
            );
        }

        let conflicts = sparse_path.iter().any(|(number, hash)| {
            self.anchors
                .get(number)
                .is_some_and(|existing| existing != hash)
                || self
                    .exact_recent
                    .get(number)
                    .is_some_and(|existing| existing != hash)
        }) || exact_blocks.iter().any(|block| {
            self.anchors
                .get(&block.block_number)
                .is_some_and(|existing| *existing != block.block_hash)
                || self
                    .exact_recent
                    .get(&block.block_number)
                    .is_some_and(|existing| *existing != block.block_hash)
        });
        if conflicts {
            self.invalidate();
            return Err("Conflicting proof-derived finalized hash at the same height".to_owned());
        }

        if staged_stride > self.stride {
            self.stride = staged_stride;
            let stride = self.stride;
            self.anchors
                .retain(|number, _| *number == 0 || *number % stride == 0);
        }
        for (number, hash) in sparse_path {
            if *number % self.stride == 0 {
                self.anchors.insert(*number, *hash);
            }
        }
        self.compact();

        for block in exact_blocks {
            self.exact_recent
                .insert(block.block_number, block.block_hash);
        }
        let protected_start = exact_blocks
            .first()
            .map(|block| block.block_number)
            .ok_or_else(|| "Proof-derived exact batch lost its start".to_owned())?;
        let protected_end = exact_blocks
            .last()
            .map(|block| block.block_number)
            .ok_or_else(|| "Proof-derived exact batch lost its end".to_owned())?;
        while self.exact_recent.len() > FINALIZED_EXACT_RECENT_CAPACITY {
            let eviction = self
                .exact_recent
                .keys()
                .copied()
                .find(|number| *number < protected_start || *number > protected_end)
                .ok_or_else(|| {
                    "Exact finalized cache cannot retain the current batch".to_owned()
                })?;
            self.exact_recent.remove(&eviction);
        }
        Ok(())
    }

    fn compact(&mut self) {
        while self.anchors.len() > FINALIZED_ANCESTRY_MAX_ANCHORS {
            self.stride = self.stride.checked_mul(2).unwrap_or(u64::MAX);
            let stride = self.stride;
            self.anchors
                .retain(|number, _| *number == 0 || *number % stride == 0);
        }
    }

    fn invalidate(&mut self) {
        self.stride = FINALIZED_ANCESTRY_BASE_STRIDE;
        self.anchors.clear();
        self.exact_recent.clear();
        self.last_verified_upper = None;
    }
}

const RECENT_BLOCK_CACHE_CAPACITY: usize = 128;
const RECENT_BLOCK_CACHE_SUBSCRIPTION_BUFFER: usize = 64;
const RECENT_BLOCK_CACHE_HASHER_SEED: [u8; 16] = *b"gmb-recent-blks!";

#[derive(Clone, Copy)]
struct RecentObservedBlock {
    number: u64,
    parent_hash: Option<[u8; 32]>,
}

struct RecentBlockCache {
    capacity: usize,
    canonical_chain: Vec<(u64, [u8; 32])>,
    observed_blocks: HashMap<[u8; 32], RecentObservedBlock, util::SipHasherBuild>,
    finalized: Option<(u64, [u8; 32])>,
    best: Option<(u64, [u8; 32])>,
}

impl RecentBlockCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            canonical_chain: Vec::with_capacity(capacity),
            observed_blocks: HashMap::with_capacity_and_hasher(
                capacity,
                util::SipHasherBuild::new(RECENT_BLOCK_CACHE_HASHER_SEED),
            ),
            finalized: None,
            best: None,
        }
    }

    fn block_hash(&self, block_number: u64) -> Option<[u8; 32]> {
        self.canonical_chain
            .iter()
            .find_map(|(number, hash)| (*number == block_number).then_some(*hash))
    }

    fn reset_from_subscription(
        &mut self,
        subscribe_all: &sync_service::SubscribeAll,
        block_number_bytes: usize,
    ) -> Result<(), String> {
        let finalized_hash = header::hash_from_scale_encoded_header(
            &subscribe_all.finalized_block_scale_encoded_header,
        );
        let finalized_number = header::decode(
            &subscribe_all.finalized_block_scale_encoded_header,
            block_number_bytes,
        )
        .map_err(|error| format!("Failed to decode finalized block header: {error}"))?
        .number;

        self.begin_subscription_reset(finalized_number, finalized_hash)?;
        self.best = Some((finalized_number, finalized_hash));
        self.observed_blocks.clear();
        self.observed_blocks.insert(
            finalized_hash,
            RecentObservedBlock {
                number: finalized_number,
                parent_hash: None,
            },
        );

        for block in &subscribe_all.non_finalized_blocks_ancestry_order {
            let decoded_header = header::decode(&block.scale_encoded_header, block_number_bytes)
                .map_err(|error| format!("Failed to decode subscribed block header: {error}"))?;
            let block_hash = header::hash_from_scale_encoded_header(&block.scale_encoded_header);
            self.observed_blocks.insert(
                block_hash,
                RecentObservedBlock {
                    number: decoded_header.number,
                    parent_hash: Some(block.parent_hash),
                },
            );
            if block.is_new_best {
                self.best = Some((decoded_header.number, block_hash));
            }
        }

        self.rebuild_canonical_chain();
        Ok(())
    }

    /// 在重建订阅视图前只保留旧 finalized 边界已经证明的历史。
    ///
    /// 旧 best 分支中高于旧 finalized 的条目仍可能被新订阅重组。若直接按
    /// `number < new_finalized` 继承，旧 A 分支会被拼到新 B finalized head 下面并被
    /// `chain_known_block_hash` 错误提升为 finalized canonical。旧 finalized 及以前的
    /// 条目已经由轻客户端 finality 证明，可以安全保留；中间缺口必须等待新视图提供
    /// 可验证祖先，当前无法证明时宁可返回 `None`。
    fn begin_subscription_reset(
        &mut self,
        finalized_number: u64,
        finalized_hash: [u8; 32],
    ) -> Result<(), String> {
        if let Some((previous_number, previous_hash)) = self.finalized {
            if finalized_number < previous_number {
                return Err("Finalized block regressed while rebuilding recent block cache".into());
            }
            if finalized_number == previous_number && finalized_hash != previous_hash {
                return Err(
                    "Finalized block hash changed at the same height while rebuilding recent block cache"
                        .into(),
                );
            }
            self.canonical_chain.retain(|(number, hash)| {
                *number < previous_number || (*number == previous_number && *hash == previous_hash)
            });
        } else {
            self.canonical_chain.clear();
        }
        self.finalized = Some((finalized_number, finalized_hash));
        Ok(())
    }

    /// 丢弃无法继续证明的整个按高度视图；调用方随后必须从新订阅重新建立。
    fn invalidate(&mut self) {
        self.canonical_chain.clear();
        self.observed_blocks.clear();
        self.finalized = None;
        self.best = None;
    }

    fn apply_notification(
        &mut self,
        notification: sync_service::Notification,
        block_number_bytes: usize,
    ) -> Result<(), String> {
        match notification {
            sync_service::Notification::Block(block) => {
                let decoded_header =
                    header::decode(&block.scale_encoded_header, block_number_bytes).map_err(
                        |error| format!("Failed to decode block notification header: {error}"),
                    )?;
                let block_hash =
                    header::hash_from_scale_encoded_header(&block.scale_encoded_header);
                self.observed_blocks.insert(
                    block_hash,
                    RecentObservedBlock {
                        number: decoded_header.number,
                        parent_hash: Some(block.parent_hash),
                    },
                );
                if block.is_new_best {
                    self.best = Some((decoded_header.number, block_hash));
                }
            }
            sync_service::Notification::BestBlockChanged { hash } => {
                if let Some(number) = self.number_for_hash(hash) {
                    self.best = Some((number, hash));
                }
            }
            sync_service::Notification::Finalized {
                hash,
                best_block_hash_if_changed,
                pruned_blocks,
            } => {
                for pruned_hash in pruned_blocks {
                    self.observed_blocks.remove(&pruned_hash);
                }

                if let Some(number) = self.number_for_hash(hash) {
                    self.finalized = Some((number, hash));
                    self.observed_blocks.insert(
                        hash,
                        RecentObservedBlock {
                            number,
                            parent_hash: None,
                        },
                    );
                }

                if let Some(best_hash) = best_block_hash_if_changed {
                    if let Some(number) = self.number_for_hash(best_hash) {
                        self.best = Some((number, best_hash));
                    }
                } else if self.best.map(|(_, best_hash)| best_hash) == Some(hash) {
                    self.best = self.finalized;
                }
            }
        }

        self.rebuild_canonical_chain();
        Ok(())
    }

    fn number_for_hash(&self, hash: [u8; 32]) -> Option<u64> {
        self.observed_blocks
            .get(&hash)
            .map(|block| block.number)
            .or_else(|| {
                self.canonical_chain
                    .iter()
                    .find_map(|(number, entry_hash)| (*entry_hash == hash).then_some(*number))
            })
            .or_else(|| {
                self.finalized
                    .and_then(|(number, finalized_hash)| (finalized_hash == hash).then_some(number))
            })
    }

    fn rebuild_canonical_chain(&mut self) {
        let Some((finalized_number, finalized_hash)) = self.finalized else {
            return;
        };

        let old_chain = core::mem::take(&mut self.canonical_chain);
        let mut rebuilt = Vec::with_capacity(self.capacity);

        if let Some((best_number, best_hash)) = self.best {
            let mut current_hash = best_hash;
            let mut current_number = best_number;

            loop {
                if !rebuilt.iter().any(|(number, _)| *number == current_number) {
                    rebuilt.push((current_number, current_hash));
                }

                if current_hash == finalized_hash {
                    break;
                }

                let Some(current_block) = self.observed_blocks.get(&current_hash) else {
                    break;
                };
                let Some(parent_hash) = current_block.parent_hash else {
                    break;
                };

                if parent_hash == finalized_hash {
                    current_hash = parent_hash;
                    current_number = finalized_number;
                    continue;
                }

                let Some(parent_block) = self.observed_blocks.get(&parent_hash) else {
                    break;
                };
                current_hash = parent_hash;
                current_number = parent_block.number;
            }
        }

        if !rebuilt
            .iter()
            .any(|(number, _)| *number == finalized_number)
        {
            rebuilt.push((finalized_number, finalized_hash));
        }

        for (number, hash) in old_chain {
            if number < finalized_number
                && !rebuilt
                    .iter()
                    .any(|(entry_number, _)| *entry_number == number)
            {
                rebuilt.push((number, hash));
            }
        }

        rebuilt.sort_by(|left, right| right.0.cmp(&left.0));
        if rebuilt.len() > self.capacity {
            rebuilt.truncate(self.capacity);
        }
        self.canonical_chain = rebuilt;

        self.prune_observed_blocks();
    }

    fn prune_observed_blocks(&mut self) {
        let min_number = self
            .best
            .map(|(number, _)| number.saturating_sub(self.capacity as u64 + 8))
            .unwrap_or(0);
        let finalized_hash = self.finalized.map(|(_, hash)| hash);
        let best_hash = self.best.map(|(_, hash)| hash);

        self.observed_blocks.retain(|hash, block| {
            block.number >= min_number || Some(*hash) == finalized_hash || Some(*hash) == best_hash
        });
    }
}

#[cfg(test)]
mod recent_block_cache_tests {
    use super::RecentBlockCache;

    #[test]
    fn subscription_reset_never_promotes_old_unfinalized_fork() {
        let finalized_90 = [0x90; 32];
        let old_99 = [0xa9; 32];
        let old_100 = [0xaa; 32];
        let new_100 = [0xbb; 32];
        let mut cache = RecentBlockCache::new(128);
        cache.finalized = Some((90, finalized_90));
        cache.canonical_chain = vec![
            (100, old_100),
            (99, old_99),
            (90, finalized_90),
            (89, [0x89; 32]),
        ];

        cache
            .begin_subscription_reset(100, new_100)
            .unwrap_or_else(|error| panic!("forward finalized reset must succeed: {error}"));
        cache.best = Some((100, new_100));
        cache.rebuild_canonical_chain();

        assert_eq!(cache.block_hash(100), Some(new_100));
        assert_eq!(cache.block_hash(99), None);
        assert_eq!(cache.block_hash(90), Some(finalized_90));
        assert_eq!(cache.block_hash(89), Some([0x89; 32]));
    }

    #[test]
    fn subscription_reset_rejects_finality_regression_and_same_height_conflict() {
        let mut cache = RecentBlockCache::new(128);
        cache.finalized = Some((90, [0x90; 32]));

        assert!(cache.begin_subscription_reset(89, [0x89; 32]).is_err());
        assert!(cache.begin_subscription_reset(90, [0xff; 32]).is_err());
        assert!(cache.begin_subscription_reset(90, [0x90; 32]).is_ok());
    }
}

/// Returns by [`Client::add_chain`] on success.
pub struct AddChainSuccess<TPlat: PlatformRef> {
    /// Newly-allocated identifier for the chain.
    pub chain_id: ChainId,

    /// Stream of JSON-RPC responses or notifications.
    ///
    /// Is always `Some` if [`AddChainConfig::json_rpc`] was [`AddChainConfigJsonRpc::Enabled`],
    /// and `None` if it was [`AddChainConfigJsonRpc::Disabled`]. In other words, you can unwrap
    /// this `Option` if you passed `Enabled`.
    pub json_rpc_responses: Option<JsonRpcResponses<TPlat>>,
}

/// Typed snapshot of the observable state of a chain.
pub struct ChainStatusSnapshot {
    /// Number of peers currently used for syncing.
    pub peer_count: u64,
    /// Whether the client is believed to still be catching up with the head.
    pub is_syncing: bool,
    /// 唯一业务可用性判定；上层不得再根据高度、历史状态或 UI 计时重新计算。
    pub is_usable: bool,
    /// Number of the current best block.
    pub best_block_number: u64,
    /// Hash of the current best block.
    pub best_block_hash: [u8; 32],
    /// Number of the current finalized block.
    pub finalized_block_number: u64,
    /// Hash of the current finalized block.
    pub finalized_block_hash: [u8; 32],
    /// 同步状态机当前阶段，直接来自 sync service。
    pub sync_phase: SyncPhase,
    /// 本次 addChain 真实采用的 finalized 起点来源。
    pub startup_finalized_source: Option<StartupFinalizedSource>,
    /// 本次 addChain 实际采用的 finalized 起点。
    pub startup_finalized_block_number: Option<u64>,
    /// 本次 addChain 实际采用的 finalized 起点 hash。
    pub startup_finalized_block_hash: Option<[u8; 32]>,
    /// 已连接 peer 公布的最高 GRANDPA finalized 高度。
    pub highest_peer_finalized_block_number: Option<u64>,
    /// 已经构建出完整 chain information 的可信 finalized 高度。
    pub current_verified_finalized_block_number: u64,
    /// `current_verified_finalized_block_number` 对应的 hash。
    pub current_verified_finalized_block_hash: [u8; 32],
    /// fragment proof 当前指向的 warp 目标高度；完成前不能作为可信 finalized。
    pub warp_target_finalized_block_number: Option<u64>,
    /// `warp_target_finalized_block_number` 对应的 hash；proof 尚未验证时为 `None`。
    pub warp_target_finalized_block_hash: Option<[u8; 32]>,
    pub warp_request_count: u64,
    pub active_warp_fragment_request_count: u64,
    pub active_warp_storage_request_count: u64,
    pub active_warp_call_proof_request_count: u64,
    pub warp_received_fragment_count: u64,
    pub warp_verified_fragment_count: u64,
    pub warp_rejected_fragment_count: u64,
    pub warp_last_failure: Option<WarpFailure>,
}

/// Proof-backed storage values together with the exact block snapshot selected
/// by the synchronization service.
///
/// The block identity is part of the result contract so callers never need to
/// infer it from a head sampled before or after this asynchronous operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainStorageValuesSnapshot {
    /// Number of the block whose state root verified `values`.
    pub block_number: u64,
    /// Hash of the block whose state root verified `values`.
    pub block_hash: [u8; 32],
    /// Values in the same order as the requested storage keys, including
    /// duplicate keys and explicit `None` entries.
    pub values: Vec<Option<Vec<u8>>>,
}

/// 同一次已固定 best runtime 调用得到的账户 nonce 与准确块身份。
///
/// `block_hash`、`block_number` 和 `nonce` 在一个 runtime subscription/pin 生命周期内
/// 产生；调用方不得用调用前后的 head 采样替代本快照，因为中间可能发生 A→B→A。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainAccountNonceSnapshot {
    /// 发起本次 runtime 调用的原始 AccountId 字节。
    pub account_id: Vec<u8>,
    /// 本次 runtime 调用实际固定的 best 块高度。
    pub block_number: u64,
    /// 本次 runtime 调用实际固定的 best 块 hash。
    pub block_hash: [u8; 32],
    /// `AccountNonceApi_account_nonce` 在该准确块返回的 nonce。
    pub nonce: u64,
}

/// 同一准确块的已验证Runtime版本与metadata；不重新采样当前头拼接结果。
pub struct ChainRuntimeContextSnapshot {
    pub block_hash: [u8; 32],
    pub block_number: u64,
    pub spec_version: u32,
    pub transaction_version: u32,
    pub metadata: Vec<u8>,
}

/// 由 verified finalized ancestry 证明的一个 canonical 块身份。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChainFinalizedBlockSnapshot {
    pub block_number: u64,
    pub block_hash: [u8; 32],
}

/// 从同一个 verified finalized 上界回溯得到的升序 canonical 块闭区间。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainFinalizedBlocksSnapshot {
    pub upper_block_number: u64,
    pub upper_block_hash: [u8; 32],
    pub blocks: Vec<ChainFinalizedBlockSnapshot>,
}

/// finalized ancestry 的强类型失败分类，供上层保持安全错误语义。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChainFinalizedAncestryError {
    InvalidArgument(String),
    AboveVerifiedUpper(String),
    Integrity(String),
    Unavailable(String),
}

impl fmt::Display for ChainFinalizedAncestryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument(message)
            | Self::AboveVerifiedUpper(message)
            | Self::Integrity(message)
            | Self::Unavailable(message) => formatter.write_str(message),
        }
    }
}

fn validated_finalized_ancestry_range_len(
    start_number: u64,
    end_number: u64,
    maximum_blocks: NonZero<u64>,
) -> Result<usize, ChainFinalizedAncestryError> {
    if start_number > end_number {
        return Err(ChainFinalizedAncestryError::InvalidArgument(
            "Finalized ancestry start is above end".to_owned(),
        ));
    }
    let length = end_number
        .checked_sub(start_number)
        .and_then(|distance| distance.checked_add(1))
        .ok_or_else(|| {
            ChainFinalizedAncestryError::InvalidArgument(
                "Finalized ancestry range length overflow".to_owned(),
            )
        })?;
    if length > maximum_blocks.get() {
        return Err(ChainFinalizedAncestryError::InvalidArgument(
            "Finalized ancestry range exceeds the caller's hard limit".to_owned(),
        ));
    }
    usize::try_from(length).map_err(|_| {
        ChainFinalizedAncestryError::InvalidArgument(
            "Finalized ancestry range exceeds platform limits".to_owned(),
        )
    })
}

/// 对网络返回的 header 逐步执行 hash/number/parent ancestry 验证。
///
/// 唯一信任根是同步状态机给出的 exact verified finalized 上界；best 通知、recent block
/// cache 和 peer 自报高度都不会进入本状态机。
struct FinalizedAncestryVerifier {
    upper_block_number: u64,
    upper_block_hash: [u8; 32],
    start_number: u64,
    end_number: u64,
    next_number: Option<u64>,
    next_hash: Option<[u8; 32]>,
    descending_blocks: Vec<ChainFinalizedBlockSnapshot>,
}

impl FinalizedAncestryVerifier {
    fn try_new(
        upper_block_number: u64,
        upper_block_hash: [u8; 32],
        start_number: u64,
        end_number: u64,
    ) -> Result<Self, String> {
        if start_number > end_number {
            return Err("Finalized ancestry start is above end".to_owned());
        }
        if end_number > upper_block_number {
            return Err("Finalized ancestry end is above verified upper bound".to_owned());
        }
        Ok(Self {
            upper_block_number,
            upper_block_hash,
            start_number,
            end_number,
            next_number: Some(upper_block_number),
            next_hash: Some(upper_block_hash),
            descending_blocks: Vec::new(),
        })
    }

    fn next_request(&self) -> Option<(u64, [u8; 32])> {
        self.next_number.zip(self.next_hash)
    }

    fn accept(
        &mut self,
        block_data: codec::BlockData,
        block_number_bytes: usize,
    ) -> Result<(), String> {
        let (expected_number, expected_hash) = self
            .next_request()
            .ok_or_else(|| "Finalized ancestry received an unexpected extra header".to_owned())?;
        if block_data.hash != expected_hash {
            return Err("Finalized ancestry response hash differs from requested hash".to_owned());
        }
        let encoded_header = block_data
            .header
            .ok_or_else(|| "Finalized ancestry response is missing its header".to_owned())?;
        if header::hash_from_scale_encoded_header(&encoded_header) != expected_hash {
            return Err("Finalized ancestry header hash differs from requested hash".to_owned());
        }
        let decoded = header::decode(&encoded_header, block_number_bytes)
            .map_err(|error| format!("Failed to decode finalized ancestry header: {error}"))?;
        if decoded.number != expected_number {
            return Err("Finalized ancestry header number differs from expected height".to_owned());
        }

        if expected_number <= self.end_number {
            self.descending_blocks.push(ChainFinalizedBlockSnapshot {
                block_number: expected_number,
                block_hash: expected_hash,
            });
        }

        if expected_number == self.start_number {
            self.next_number = None;
            self.next_hash = None;
        } else {
            let parent_number = expected_number.checked_sub(1).ok_or_else(|| {
                "Finalized ancestry reached genesis before requested start".to_owned()
            })?;
            self.next_number = Some(parent_number);
            self.next_hash = Some(*decoded.parent_hash);
        }
        Ok(())
    }

    fn finish(mut self) -> Result<ChainFinalizedBlocksSnapshot, String> {
        if self.next_request().is_some() {
            return Err("Finalized ancestry ended before the requested start height".to_owned());
        }
        self.descending_blocks.reverse();
        let expected_len_u64 = self
            .end_number
            .checked_sub(self.start_number)
            .and_then(|distance| distance.checked_add(1))
            .ok_or_else(|| "Finalized ancestry range length overflow".to_owned())?;
        let expected_len = usize::try_from(expected_len_u64)
            .map_err(|_| "Finalized ancestry range exceeds platform limits".to_owned())?;
        if self.descending_blocks.len() != expected_len
            || self
                .descending_blocks
                .iter()
                .enumerate()
                .any(|(index, block)| {
                    u64::try_from(index)
                        .ok()
                        .and_then(|offset| self.start_number.checked_add(offset))
                        != Some(block.block_number)
                })
        {
            return Err("Finalized ancestry result is incomplete or non-contiguous".to_owned());
        }
        Ok(ChainFinalizedBlocksSnapshot {
            upper_block_number: self.upper_block_number,
            upper_block_hash: self.upper_block_hash,
            blocks: self.descending_blocks,
        })
    }
}

#[cfg(test)]
mod finalized_ancestry_tests {
    use super::*;

    fn encode_header(parent_hash: [u8; 32], number: u64) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(100);
        encoded.extend_from_slice(&parent_hash);
        if number < 1 << 6 {
            encoded.push((number as u8) << 2);
        } else if number < 1 << 14 {
            encoded.extend_from_slice(&(((number as u16) << 2) | 0b01).to_le_bytes());
        } else {
            panic!("test header helper only supports heights below 2^14");
        }
        encoded.extend_from_slice(&[0x11; 32]);
        encoded.extend_from_slice(&[0x22; 32]);
        encoded.push(0);
        encoded
    }

    fn block_data(header: Vec<u8>) -> codec::BlockData {
        codec::BlockData {
            hash: header::hash_from_scale_encoded_header(&header),
            header: Some(header),
            body: None,
            justifications: None,
        }
    }

    fn chain(last: u64) -> Vec<codec::BlockData> {
        let mut blocks = Vec::new();
        let mut parent_hash = [0; 32];
        for number in 0..=last {
            let header = encode_header(parent_hash, number);
            let block = block_data(header);
            parent_hash = block.hash;
            blocks.push(block);
        }
        blocks
    }

    #[test]
    fn ancestry_walk_supports_more_than_recent_cache_capacity_and_orders_batch() {
        let blocks = chain(200);
        let upper = blocks[200].hash;
        let mut verifier = FinalizedAncestryVerifier::try_new(200, upper, 5, 124)
            .unwrap_or_else(|error| panic!("valid range: {error}"));
        for number in (5..=200).rev() {
            assert_eq!(
                verifier.next_request(),
                Some((number, blocks[number as usize].hash))
            );
            verifier
                .accept(blocks[number as usize].clone(), 4)
                .unwrap_or_else(|error| panic!("valid ancestry step: {error}"));
        }
        let snapshot = verifier
            .finish()
            .unwrap_or_else(|error| panic!("valid ancestry result: {error}"));
        assert_eq!(snapshot.upper_block_number, 200);
        assert_eq!(snapshot.upper_block_hash, upper);
        assert_eq!(snapshot.blocks.len(), 120);
        assert_eq!(
            snapshot.blocks.first().map(|block| block.block_number),
            Some(5)
        );
        assert_eq!(
            snapshot.blocks.last().map(|block| block.block_number),
            Some(124)
        );
    }

    #[test]
    fn public_range_gate_accepts_120_and_rejects_121_and_overflow() {
        let maximum = NonZero::<u64>::new(120).unwrap_or_else(|| panic!("120 is non-zero"));
        assert_eq!(
            validated_finalized_ancestry_range_len(1, 120, maximum).ok(),
            Some(120)
        );
        assert!(validated_finalized_ancestry_range_len(1, 121, maximum).is_err());
        assert!(validated_finalized_ancestry_range_len(0, u64::MAX, maximum).is_err());
    }

    #[test]
    fn ancestry_bounds_fail_before_any_header_is_accepted() {
        assert!(FinalizedAncestryVerifier::try_new(10, [1; 32], 8, 7).is_err());
        assert!(FinalizedAncestryVerifier::try_new(10, [1; 32], 8, 11).is_err());
    }

    #[test]
    fn missing_malformed_wrong_hash_and_wrong_number_fail_closed() {
        let blocks = chain(2);
        let upper = blocks[2].hash;

        let mut missing = FinalizedAncestryVerifier::try_new(2, upper, 2, 2)
            .unwrap_or_else(|error| panic!("valid verifier: {error}"));
        let mut no_header = blocks[2].clone();
        no_header.header = None;
        assert!(missing.accept(no_header, 4).is_err());

        let malformed_header = vec![0x01, 0x02];
        let malformed_data = block_data(malformed_header);
        let mut malformed = FinalizedAncestryVerifier::try_new(2, malformed_data.hash, 2, 2)
            .unwrap_or_else(|error| panic!("valid verifier: {error}"));
        assert!(malformed.accept(malformed_data, 4).is_err());

        let mut response_hash = FinalizedAncestryVerifier::try_new(2, upper, 2, 2)
            .unwrap_or_else(|error| panic!("valid verifier: {error}"));
        let mut wrong_response_hash = blocks[2].clone();
        wrong_response_hash.hash = [0xee; 32];
        assert!(response_hash.accept(wrong_response_hash, 4).is_err());

        let wrong_number_header = encode_header(blocks[1].hash, 1);
        let wrong_number_hash = header::hash_from_scale_encoded_header(&wrong_number_header);
        let mut wrong_number = FinalizedAncestryVerifier::try_new(2, wrong_number_hash, 2, 2)
            .unwrap_or_else(|error| panic!("valid verifier: {error}"));
        assert!(
            wrong_number
                .accept(block_data(wrong_number_header), 4)
                .is_err()
        );
    }

    #[test]
    fn fork_and_wrong_parent_cannot_escape_verified_anchor() {
        let canonical = chain(3);
        let mut fork_header = encode_header(canonical[1].hash, 2);
        fork_header[40] ^= 0x01;
        let fork = block_data(fork_header);

        let mut wrong_fork = FinalizedAncestryVerifier::try_new(2, canonical[2].hash, 2, 2)
            .unwrap_or_else(|error| panic!("valid verifier: {error}"));
        let mut fork_as_canonical = fork;
        fork_as_canonical.hash = canonical[2].hash;
        assert!(wrong_fork.accept(fork_as_canonical, 4).is_err());

        let wrong_parent_header = encode_header([0xaa; 32], 3);
        let wrong_parent_hash = header::hash_from_scale_encoded_header(&wrong_parent_header);
        let mut wrong_parent = FinalizedAncestryVerifier::try_new(3, wrong_parent_hash, 2, 2)
            .unwrap_or_else(|error| panic!("valid verifier: {error}"));
        wrong_parent
            .accept(block_data(wrong_parent_header), 4)
            .unwrap_or_else(|error| panic!("anchored upper header itself is valid: {error}"));
        assert_eq!(wrong_parent.next_request(), Some((2, [0xaa; 32])));
        assert!(wrong_parent.accept(canonical[2].clone(), 4).is_err());
    }

    #[test]
    fn sparse_anchor_makes_second_batch_avoid_rewalking_from_upper() {
        let blocks = chain(500);
        let mut cache = FinalizedAncestryAnchorCache::new();
        cache
            .observe_verified_upper(500, blocks[500].hash)
            .unwrap_or_else(|error| panic!("verified upper: {error}"));

        let mut first_request_count = 0_u64;
        for number in (0..=500).rev() {
            first_request_count += 1;
            cache
                .insert_proven_anchor(number, blocks[number as usize].hash)
                .unwrap_or_else(|error| panic!("proof-derived anchor: {error}"));
        }
        assert_eq!(first_request_count, 501);

        let (second_anchor, _) = cache
            .nearest_anchor_at_or_above(239, 500)
            .unwrap_or_else(|| panic!("second batch must find a sparse anchor"));
        let second_request_count = second_anchor - 120 + 1;
        assert_eq!(second_anchor, 256);
        assert_eq!(second_request_count, 137);
        assert!(second_request_count < 500 - 120 + 1);
    }

    #[test]
    fn exact_recent_serves_three_per_block_validations_without_more_headers() {
        let blocks = chain(200);
        let mut cache = FinalizedAncestryAnchorCache::new();
        cache
            .observe_verified_upper(200, blocks[200].hash)
            .unwrap_or_else(|error| panic!("verified upper: {error}"));
        let exact = (81..=200)
            .map(|number| ChainFinalizedBlockSnapshot {
                block_number: number,
                block_hash: blocks[number as usize].hash,
            })
            .collect::<Vec<_>>();
        let sparse = (0..=200)
            .filter(|number| number % FINALIZED_ANCESTRY_BASE_STRIDE == 0)
            .map(|number| (number, blocks[number as usize].hash))
            .collect::<Vec<_>>();
        cache
            .commit_proven_batch(FINALIZED_ANCESTRY_BASE_STRIDE, &sparse, &exact)
            .unwrap_or_else(|error| panic!("complete proof batch: {error}"));

        let header_request_count = 120_u64;
        for number in 81..=200 {
            for _operation in ["runtime", "body", "storage"] {
                let hit = cache
                    .exact_blocks(number, number)
                    .unwrap_or_else(|| panic!("every exact block must remain cached"));
                assert_eq!(hit.len(), 1);
                assert_eq!(hit[0].block_hash, blocks[number as usize].hash);
            }
        }
        assert_eq!(header_request_count, 120);
        assert_eq!(cache.exact_recent.len(), 120);
    }

    #[test]
    fn sparse_cache_is_bounded_and_conflict_invalidates_before_reuse() {
        let mut cache = FinalizedAncestryAnchorCache::new();
        for index in 0..=(FINALIZED_ANCESTRY_MAX_ANCHORS as u64 + 32) {
            let number = index * FINALIZED_ANCESTRY_BASE_STRIDE;
            cache
                .insert_proven_anchor(number, [index as u8; 32])
                .unwrap_or_else(|error| panic!("unique anchor: {error}"));
        }
        assert!(cache.anchors.len() <= FINALIZED_ANCESTRY_MAX_ANCHORS);
        assert!(cache.stride > FINALIZED_ANCESTRY_BASE_STRIDE);

        let conflicting_height = cache
            .anchors
            .keys()
            .next()
            .copied()
            .unwrap_or_else(|| panic!("compacted cache must retain an anchor"));
        let existing = cache.anchors[&conflicting_height];
        let mut conflicting = existing;
        conflicting[0] ^= 0xff;
        assert!(
            cache
                .insert_proven_anchor(conflicting_height, conflicting)
                .is_err()
        );
        assert!(cache.anchors.is_empty());
        assert!(cache.exact_recent.is_empty());
        assert!(cache.last_verified_upper.is_none());
    }

    #[test]
    fn verified_upper_regression_or_same_height_fork_invalidates_cache() {
        let mut cache = FinalizedAncestryAnchorCache::new();
        cache
            .observe_verified_upper(10, [0xaa; 32])
            .unwrap_or_else(|error| panic!("first upper: {error}"));
        assert!(cache.observe_verified_upper(10, [0xbb; 32]).is_err());
        assert!(cache.last_verified_upper.is_none());

        cache
            .observe_verified_upper(11, [0xcc; 32])
            .unwrap_or_else(|error| panic!("fresh upper after invalidation: {error}"));
        assert!(cache.observe_verified_upper(10, [0xaa; 32]).is_err());
        assert!(cache.last_verified_upper.is_none());
    }

    #[test]
    fn lock_linearized_resample_does_not_misread_legal_upper_progress_as_regression() {
        let mut cache = FinalizedAncestryAnchorCache::new();

        // 请求 A 在等待 cache 锁之前看到 #100；请求 B 先获得锁，并在线性化区间内
        // 看到、提交 #101。生产路径要求 A 取得锁后重新采样，所以它随后也观察 #101，
        // 不能把锁外的旧 #100 交给 cache。
        let stale_sample_before_lock = (100, [0x10; 32]);
        let request_b_sample_inside_lock = (101, [0x11; 32]);
        cache
            .observe_verified_upper(
                request_b_sample_inside_lock.0,
                request_b_sample_inside_lock.1,
            )
            .unwrap_or_else(|error| panic!("legal finalized advance: {error}"));

        let request_a_resample_inside_lock = request_b_sample_inside_lock;
        cache
            .observe_verified_upper(
                request_a_resample_inside_lock.0,
                request_a_resample_inside_lock.1,
            )
            .unwrap_or_else(|error| panic!("same linearized verified upper: {error}"));
        assert_eq!(
            cache.last_verified_upper,
            Some(request_b_sample_inside_lock)
        );
        assert_ne!(stale_sample_before_lock, request_a_resample_inside_lock);
    }

    #[test]
    fn lock_linearized_observation_still_rejects_real_regression_and_same_height_conflict() {
        let mut cache = FinalizedAncestryAnchorCache::new();
        cache
            .observe_verified_upper(101, [0x11; 32])
            .unwrap_or_else(|error| panic!("initial verified upper: {error}"));
        assert!(cache.observe_verified_upper(100, [0x10; 32]).is_err());
        assert!(cache.last_verified_upper.is_none());

        cache
            .observe_verified_upper(101, [0x11; 32])
            .unwrap_or_else(|error| panic!("upper after invalidation: {error}"));
        assert!(cache.observe_verified_upper(101, [0x12; 32]).is_err());
        assert!(cache.last_verified_upper.is_none());
    }
}

/// 统一 runtime 近头启发式与同步状态机阶段的完成语义。
///
/// runtime 已接近链头只说明目标 runtime 可用；只要 GRANDPA warp 尚未回到
/// `Regular`，上层仍必须继续轮询，不能提前保存 database 或开放业务读写。
fn chain_status_is_syncing(runtime_is_near_head: bool, sync_phase: SyncPhase) -> bool {
    !runtime_is_near_head || sync_phase != SyncPhase::Regular
}

fn chain_status_is_usable(peer_count: u64, is_syncing: bool, sync_phase: SyncPhase) -> bool {
    peer_count > 0 && !is_syncing && sync_phase == SyncPhase::Regular
}

#[cfg(test)]
mod chain_status_tests {
    use super::{SyncPhase, chain_status_is_syncing, chain_status_is_usable};

    #[test]
    fn warp_mode_remains_syncing_even_when_runtime_is_near_head() {
        assert!(chain_status_is_syncing(
            true,
            SyncPhase::WarpDownloadingFragments
        ));
        assert!(chain_status_is_syncing(
            true,
            SyncPhase::WarpBuildingChainInformation
        ));
        assert!(chain_status_is_syncing(false, SyncPhase::Regular));
        assert!(!chain_status_is_syncing(true, SyncPhase::Regular));
        assert!(!chain_status_is_usable(
            1,
            true,
            SyncPhase::WarpBuildingChainInformation
        ));
        assert!(!chain_status_is_usable(0, false, SyncPhase::Regular));
        assert!(chain_status_is_usable(1, false, SyncPhase::Regular));
    }
}

/// Typed snapshot of the runtime version of the current best block.
pub struct ChainRuntimeVersionSnapshot {
    pub spec_name: String,
    pub impl_name: String,
    pub authoring_version: u64,
    pub spec_version: u64,
    pub impl_version: u64,
    pub transaction_version: Option<u64>,
    pub state_version: Option<u64>,
    pub apis: Vec<(Vec<u8>, u32)>,
}

/// Stream of JSON-RPC responses or notifications.
///
/// See [`AddChainSuccess::json_rpc_responses`].
pub struct JsonRpcResponses<TPlat: PlatformRef> {
    /// Receiving side for responses.
    ///
    /// As long as this object is alive, the JSON-RPC service will continue running. In order
    /// to prevent that from happening, we destroy it as soon as the
    /// [`JsonRpcResponses::public_api_chain_destroyed`] is notified of the destruction of
    /// the sender.
    inner: Option<json_rpc_service::Frontend<TPlat>>,

    /// Notified when the [`PublicApiChain`] is destroyed.
    public_api_chain_destroyed: event_listener::EventListener,
}

impl<TPlat: PlatformRef> JsonRpcResponses<TPlat> {
    /// Returns the next response or notification, or `None` if the chain has been removed.
    pub async fn next(&mut self) -> Option<String> {
        if let Some(frontend) = self.inner.as_mut() {
            if let Some(response) = futures_lite::future::or(
                async { Some(frontend.next_json_rpc_response().await) },
                async {
                    (&mut self.public_api_chain_destroyed).await;
                    None
                },
            )
            .await
            {
                return Some(response);
            }
        }

        self.inner = None;
        None
    }
}

impl<TPlat: platform::PlatformRef, TChain> Client<TPlat, TChain> {
    /// Initializes the smoldot client.
    pub const fn new(platform: TPlat) -> Self {
        Client {
            platform,
            public_api_chains: slab::Slab::new(),
            chains_by_key: None,
            network_service: None,
        }
    }

    fn clone_chain_services(&self, chain_id: ChainId) -> Result<ChainServices<TPlat>, String> {
        let public_api_chain = self
            .public_api_chains
            .get(usize::from(chain_id))
            .ok_or_else(|| format!("Invalid chain id: {}", usize::from(chain_id)))?;
        let chains_by_key = self.chains_by_key.as_ref().ok_or_else(|| {
            format!(
                "Chain services not initialized for {}",
                usize::from(chain_id)
            )
        })?;
        let running_chain = chains_by_key
            .get(&public_api_chain.key)
            .ok_or_else(|| format!("Chain services missing for {}", usize::from(chain_id)))?;
        Ok(running_chain.services.clone())
    }

    /// Returns a typed snapshot of the chain status without going through the legacy JSON-RPC layer.
    pub fn chain_status_snapshot(
        &self,
        chain_id: ChainId,
    ) -> Result<
        Pin<Box<dyn core::future::Future<Output = Result<ChainStatusSnapshot, String>> + Send>>,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;
        let block_number_bytes = services.sync_service.block_number_bytes();

        Ok(Box::pin(async move {
            // 中文注释：直接从同步服务抓当前 finalized/best 视图，避免再经过 system_health。
            let subscribe_all = services.sync_service.subscribe_all(16, false).await;
            let finalized_block_hash = header::hash_from_scale_encoded_header(
                &subscribe_all.finalized_block_scale_encoded_header,
            );
            let finalized_block_number = header::decode(
                &subscribe_all.finalized_block_scale_encoded_header,
                block_number_bytes,
            )
            .map_err(|error| format!("Failed to decode finalized block header: {error}"))?
            .number;

            let (best_block_number, best_block_hash) = if let Some(best_non_finalized) =
                subscribe_all
                    .non_finalized_blocks_ancestry_order
                    .iter()
                    .find(|block| block.is_new_best)
            {
                let best_block_number =
                    header::decode(&best_non_finalized.scale_encoded_header, block_number_bytes)
                        .map_err(|error| format!("Failed to decode best block header: {error}"))?
                        .number;
                let best_block_hash = header::hash_from_scale_encoded_header(
                    &best_non_finalized.scale_encoded_header,
                );
                (best_block_number, best_block_hash)
            } else {
                (finalized_block_number, finalized_block_hash)
            };

            let peer_count = u64::try_from(services.sync_service.syncing_peers().await.len())
                .unwrap_or(u64::MAX);
            let runtime_is_near_head = services
                .runtime_service
                .is_near_head_of_chain_heuristic()
                .await;
            let sync_activity = services.sync_service.sync_activity_snapshot().await;
            let is_syncing = chain_status_is_syncing(runtime_is_near_head, sync_activity.phase);
            let is_usable = chain_status_is_usable(peer_count, is_syncing, sync_activity.phase);

            Ok(ChainStatusSnapshot {
                peer_count,
                is_syncing,
                is_usable,
                best_block_number,
                best_block_hash,
                finalized_block_number,
                finalized_block_hash,
                sync_phase: sync_activity.phase,
                startup_finalized_source: sync_activity.startup_finalized_source,
                startup_finalized_block_number: sync_activity.startup_finalized_block_number,
                startup_finalized_block_hash: sync_activity.startup_finalized_block_hash,
                highest_peer_finalized_block_number: sync_activity
                    .highest_peer_finalized_block_number,
                current_verified_finalized_block_number: sync_activity
                    .current_verified_finalized_block_number,
                current_verified_finalized_block_hash: sync_activity
                    .current_verified_finalized_block_hash,
                warp_target_finalized_block_number: sync_activity
                    .warp_target_finalized_block_number,
                warp_target_finalized_block_hash: sync_activity.warp_target_finalized_block_hash,
                warp_request_count: sync_activity.warp_request_count,
                active_warp_fragment_request_count: sync_activity
                    .active_warp_fragment_request_count,
                active_warp_storage_request_count: sync_activity.active_warp_storage_request_count,
                active_warp_call_proof_request_count: sync_activity
                    .active_warp_call_proof_request_count,
                warp_received_fragment_count: sync_activity.warp_received_fragment_count,
                warp_verified_fragment_count: sync_activity.warp_verified_fragment_count,
                warp_rejected_fragment_count: sync_activity.warp_rejected_fragment_count,
                warp_last_failure: sync_activity.warp_last_failure,
            })
        }))
    }

    /// 从同步状态机的 exact verified finalized 锚回溯并验证一个 canonical 高度闭区间。
    ///
    /// 每一步都按上一步 header 的 parent hash 请求下一条 header，并核对响应 hash、完整
    /// SCALE header hash 与期望高度。该过程不读取 best 通知或 mixed recent block cache，
    /// 因而 stale best、通知延迟和 A→B fork 不会改变 finalized 结论。
    pub fn chain_finalized_blocks_at(
        &self,
        chain_id: ChainId,
        start_number: u64,
        end_number: u64,
        maximum_blocks: NonZero<u64>,
    ) -> Result<
        Pin<
            Box<
                dyn core::future::Future<
                        Output = Result<ChainFinalizedBlocksSnapshot, ChainFinalizedAncestryError>,
                    > + Send,
            >,
        >,
        ChainFinalizedAncestryError,
    > {
        // 先做纯算术门禁；超大范围不能触发 service clone、网络请求或结果分配。
        let _expected_len =
            validated_finalized_ancestry_range_len(start_number, end_number, maximum_blocks)?;
        let services = self
            .clone_chain_services(chain_id)
            .map_err(ChainFinalizedAncestryError::Unavailable)?;
        let block_number_bytes = services.sync_service.block_number_bytes();

        Ok(Box::pin(async move {
            // 先取得独立 finalized proof cache 的串行化锁，再读取同步状态机的 verified
            // 字段。否则并发调用可能让较早采到 upper=100 的请求排在已提交 upper=101 的
            // 请求之后进入缓存，把合法推进误判成回退。该锁本来就覆盖整次 ancestry walk，
            // 因而把快照采样移入锁内不会扩大并发边界。
            let mut anchor_cache = services.finalized_ancestry_cache.lock().await;
            // 必须直接读取同步状态机的 verified 字段；surface finalized/best 通知可能仍旧。
            let activity = services.sync_service.sync_activity_snapshot().await;
            if end_number > activity.current_verified_finalized_block_number {
                return Err(ChainFinalizedAncestryError::AboveVerifiedUpper(
                    "Finalized ancestry end is above verified upper bound".to_owned(),
                ));
            }
            anchor_cache
                .observe_verified_upper(
                    activity.current_verified_finalized_block_number,
                    activity.current_verified_finalized_block_hash,
                )
                .map_err(ChainFinalizedAncestryError::Integrity)?;
            // exact recent 只能来自此前完整成功的 ancestry batch；命中仍已先完成 current
            // verified upper 的单调性/同高 hash 复核，因此它是性能索引而非第二安全真源。
            if let Some(blocks) = anchor_cache.exact_blocks(start_number, end_number) {
                return Ok(ChainFinalizedBlocksSnapshot {
                    upper_block_number: activity.current_verified_finalized_block_number,
                    upper_block_hash: activity.current_verified_finalized_block_hash,
                    blocks,
                });
            }
            // 只选此前从 verified ancestry 推导并保持无冲突的独立 sparse anchor。
            // 缓存淘汰时回退到当前 verified upper，仅影响请求数量，不改变验证步骤。
            let (proof_anchor_number, proof_anchor_hash) = anchor_cache
                .nearest_anchor_at_or_above(
                    end_number,
                    activity.current_verified_finalized_block_number,
                )
                .unwrap_or((
                    activity.current_verified_finalized_block_number,
                    activity.current_verified_finalized_block_hash,
                ));
            let mut verifier = FinalizedAncestryVerifier::try_new(
                proof_anchor_number,
                proof_anchor_hash,
                start_number,
                end_number,
            )
            .map_err(ChainFinalizedAncestryError::Integrity)?;
            let mut staged_stride = anchor_cache.stride;
            let mut staged_sparse_path = Vec::new();

            while let Some((expected_number, expected_hash)) = verifier.next_request() {
                let block_data = services
                    .sync_service
                    .clone()
                    .block_query_unknown_number(
                        expected_hash,
                        codec::BlocksRequestFields {
                            header: true,
                            body: false,
                            justifications: false,
                        },
                        3,
                        Duration::from_secs(12),
                        NonZero::<u32>::new(1).unwrap(),
                    )
                    .await
                    .map_err(|_| {
                        ChainFinalizedAncestryError::Unavailable(
                            "Failed to download a finalized ancestry header by exact hash"
                                .to_owned(),
                        )
                    })?;
                verifier
                    .accept(block_data, block_number_bytes)
                    .map_err(ChainFinalizedAncestryError::Integrity)?;
                if expected_number % staged_stride == 0 {
                    staged_sparse_path.push((expected_number, expected_hash));
                    if staged_sparse_path.len() > FINALIZED_ANCESTRY_MAX_ANCHORS {
                        staged_stride = staged_stride.checked_mul(2).unwrap_or(u64::MAX);
                        staged_sparse_path
                            .retain(|(number, _)| *number == 0 || *number % staged_stride == 0);
                    }
                }
            }

            let snapshot = verifier
                .finish()
                .map_err(ChainFinalizedAncestryError::Integrity)?;
            anchor_cache
                .commit_proven_batch(staged_stride, &staged_sparse_path, &snapshot.blocks)
                .map_err(ChainFinalizedAncestryError::Integrity)?;
            Ok(snapshot)
        }))
    }

    /// Returns a block hash if it is already present in the local sync view.
    pub fn chain_known_block_hash(
        &self,
        chain_id: ChainId,
        block_number: u64,
    ) -> Result<
        Pin<Box<dyn core::future::Future<Output = Result<Option<[u8; 32]>, String>> + Send>>,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;

        if block_number == 0 {
            let genesis_block_hash = services.genesis_block_hash;
            return Ok(Box::pin(async move { Ok(Some(genesis_block_hash)) }));
        }

        Ok(Box::pin(async move {
            if let Some(block_hash) = {
                let cache = services.recent_block_cache.lock().await;
                cache.block_hash(block_number)
            } {
                return Ok(Some(block_hash));
            }

            let block_number_bytes = services.sync_service.block_number_bytes();
            // 中文注释：缓存未命中时，再用一次当前同步视图兜住 finalized / non-finalized 头部区间。
            let subscribe_all = services.sync_service.subscribe_all(16, false).await;
            let finalized_block_hash = header::hash_from_scale_encoded_header(
                &subscribe_all.finalized_block_scale_encoded_header,
            );
            let finalized_block_number = header::decode(
                &subscribe_all.finalized_block_scale_encoded_header,
                block_number_bytes,
            )
            .map_err(|error| format!("Failed to decode finalized block header: {error}"))?
            .number;

            if block_number == finalized_block_number {
                return Ok(Some(finalized_block_hash));
            }

            for block in &subscribe_all.non_finalized_blocks_ancestry_order {
                let decoded_header =
                    header::decode(&block.scale_encoded_header, block_number_bytes)
                        .map_err(|error| format!("Failed to decode known block header: {error}"))?;
                if decoded_header.number == block_number {
                    let block_hash =
                        header::hash_from_scale_encoded_header(&block.scale_encoded_header);
                    return Ok(Some(block_hash));
                }
            }

            Ok(None)
        }))
    }

    /// Returns the SCALE-encoded extrinsics of the given block hash without going through legacy JSON-RPC.
    pub fn chain_block_extrinsics(
        &self,
        chain_id: ChainId,
        block_hash: [u8; 32],
    ) -> Result<
        Pin<Box<dyn core::future::Future<Output = Result<Vec<Vec<u8>>, String>> + Send>>,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;

        if block_hash == services.genesis_block_hash {
            return Ok(Box::pin(async move { Ok(Vec::new()) }));
        }

        Ok(Box::pin(async move {
            // 中文注释：直接按 block hash 向 peer 拉 body，优先避免再走 legacy `chain_getBlock`。
            let block_data = services
                .sync_service
                .clone()
                .block_query_unknown_number(
                    block_hash,
                    codec::BlocksRequestFields {
                        header: false,
                        body: true,
                        justifications: false,
                    },
                    3,
                    Duration::from_secs(12),
                    NonZero::<u32>::new(1).unwrap(),
                )
                .await
                .map_err(|_| "Failed to download block body from the network".to_string())?;

            block_data
                .body
                .ok_or_else(|| "Downloaded block is missing body".to_string())
        }))
    }

    /// Returns multiple storage values of the current best block without going through legacy JSON-RPC.
    ///
    /// This compatibility projection intentionally discards the observed block
    /// identity. Security-sensitive consumers should call
    /// [`Client::chain_storage_values_snapshot`] and verify that identity.
    pub fn chain_storage_values(
        &self,
        chain_id: ChainId,
        storage_keys: Vec<Vec<u8>>,
    ) -> Result<
        Pin<Box<dyn core::future::Future<Output = Result<Vec<Option<Vec<u8>>>, String>> + Send>>,
        String,
    > {
        if storage_keys.is_empty() {
            return Ok(Box::pin(async { Ok(Vec::new()) }));
        }
        let snapshot = self.chain_storage_values_snapshot(chain_id, storage_keys)?;
        Ok(Box::pin(async move {
            snapshot.await.map(|snapshot| snapshot.values)
        }))
    }

    /// Returns proof-backed storage values and the exact best block observed by
    /// the synchronization service for this operation.
    pub fn chain_storage_values_snapshot(
        &self,
        chain_id: ChainId,
        storage_keys: Vec<Vec<u8>>,
    ) -> Result<
        Pin<
            Box<
                dyn core::future::Future<Output = Result<ChainStorageValuesSnapshot, String>>
                    + Send,
            >,
        >,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;
        let block_number_bytes = services.sync_service.block_number_bytes();

        Ok(Box::pin(async move {
            let subscribe_all = services.sync_service.subscribe_all(16, false).await;
            let (block_number, block_hash, block_state_trie_root_hash) =
                if let Some(best_non_finalized) = subscribe_all
                    .non_finalized_blocks_ancestry_order
                    .iter()
                    .find(|block| block.is_new_best)
                {
                    let decoded_header = header::decode(
                        &best_non_finalized.scale_encoded_header,
                        block_number_bytes,
                    )
                    .map_err(|error| format!("Failed to decode best block header: {error}"))?;
                    (
                        decoded_header.number,
                        header::hash_from_scale_encoded_header(
                            &best_non_finalized.scale_encoded_header,
                        ),
                        *decoded_header.state_root,
                    )
                } else {
                    let decoded_header = header::decode(
                        &subscribe_all.finalized_block_scale_encoded_header,
                        block_number_bytes,
                    )
                    .map_err(|error| format!("Failed to decode finalized block header: {error}"))?;
                    (
                        decoded_header.number,
                        header::hash_from_scale_encoded_header(
                            &subscribe_all.finalized_block_scale_encoded_header,
                        ),
                        *decoded_header.state_root,
                    )
                };

            if storage_keys.is_empty() {
                return Ok(ChainStorageValuesSnapshot {
                    block_number,
                    block_hash,
                    values: Vec::new(),
                });
            }

            let mut values: Vec<Option<Option<Vec<u8>>>> =
                (0..storage_keys.len()).map(|_| None).collect();
            let mut query = services
                .sync_service
                .clone()
                .storage_query(
                    block_number,
                    block_hash,
                    block_state_trie_root_hash,
                    storage_keys
                        .iter()
                        .cloned()
                        .map(|key| sync_service::StorageRequestItem {
                            key,
                            ty: sync_service::StorageRequestItemTy::Value,
                        }),
                    3,
                    Duration::from_secs(20),
                    NonZero::<u32>::new(3).unwrap(),
                )
                .advance()
                .await;

            loop {
                match query {
                    sync_service::StorageQueryProgress::Finished => break,
                    sync_service::StorageQueryProgress::Progress {
                        request_index,
                        item: sync_service::StorageResultItem::Value { value, .. },
                        query: next,
                    } => {
                        values[request_index] = Some(value);
                        query = next.advance().await;
                    }
                    sync_service::StorageQueryProgress::Progress { .. } => unreachable!(),
                    sync_service::StorageQueryProgress::Error(error) => {
                        return Err(format!("Failed to download storage proof: {error}"));
                    }
                }
            }

            Ok(ChainStorageValuesSnapshot {
                block_number,
                block_hash,
                values: values.into_iter().map(|value| value.flatten()).collect(),
            })
        }))
    }

    /// Returns multiple storage values of the latest finalized block without going through legacy JSON-RPC.
    ///
    /// This compatibility projection intentionally discards the observed block
    /// identity. Security-sensitive consumers should call
    /// [`Client::chain_finalized_storage_values_snapshot`] and verify it.
    pub fn chain_finalized_storage_values(
        &self,
        chain_id: ChainId,
        storage_keys: Vec<Vec<u8>>,
    ) -> Result<
        Pin<Box<dyn core::future::Future<Output = Result<Vec<Option<Vec<u8>>>, String>> + Send>>,
        String,
    > {
        if storage_keys.is_empty() {
            return Ok(Box::pin(async { Ok(Vec::new()) }));
        }
        let snapshot = self.chain_finalized_storage_values_snapshot(chain_id, storage_keys)?;
        Ok(Box::pin(async move {
            snapshot.await.map(|snapshot| snapshot.values)
        }))
    }

    /// Returns proof-backed storage values and the exact finalized block
    /// observed by the synchronization service for this operation.
    pub fn chain_finalized_storage_values_snapshot(
        &self,
        chain_id: ChainId,
        storage_keys: Vec<Vec<u8>>,
    ) -> Result<
        Pin<
            Box<
                dyn core::future::Future<Output = Result<ChainStorageValuesSnapshot, String>>
                    + Send,
            >,
        >,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;
        let block_number_bytes = services.sync_service.block_number_bytes();

        Ok(Box::pin(async move {
            let subscribe_all = services.sync_service.subscribe_all(16, false).await;
            let decoded_header = header::decode(
                &subscribe_all.finalized_block_scale_encoded_header,
                block_number_bytes,
            )
            .map_err(|error| format!("Failed to decode finalized block header: {error}"))?;
            let block_number = decoded_header.number;
            let block_hash = header::hash_from_scale_encoded_header(
                &subscribe_all.finalized_block_scale_encoded_header,
            );
            let block_state_trie_root_hash = *decoded_header.state_root;

            if storage_keys.is_empty() {
                return Ok(ChainStorageValuesSnapshot {
                    block_number,
                    block_hash,
                    values: Vec::new(),
                });
            }

            // 中文注释：金额展示统一读 finalized 状态根，避免 best 头上短暂可见的余额
            // 和最终确认后的余额不一致；交易三段状态仍由上层监听 best/inBlock/finalized。
            let mut values: Vec<Option<Option<Vec<u8>>>> =
                (0..storage_keys.len()).map(|_| None).collect();
            let mut query = services
                .sync_service
                .clone()
                .storage_query(
                    block_number,
                    block_hash,
                    block_state_trie_root_hash,
                    storage_keys
                        .iter()
                        .cloned()
                        .map(|key| sync_service::StorageRequestItem {
                            key,
                            ty: sync_service::StorageRequestItemTy::Value,
                        }),
                    3,
                    Duration::from_secs(20),
                    NonZero::<u32>::new(3).unwrap(),
                )
                .advance()
                .await;

            loop {
                match query {
                    sync_service::StorageQueryProgress::Finished => break,
                    sync_service::StorageQueryProgress::Progress {
                        request_index,
                        item: sync_service::StorageResultItem::Value { value, .. },
                        query: next,
                    } => {
                        values[request_index] = Some(value);
                        query = next.advance().await;
                    }
                    sync_service::StorageQueryProgress::Progress { .. } => unreachable!(),
                    sync_service::StorageQueryProgress::Error(error) => {
                        return Err(format!(
                            "Failed to download finalized storage proof: {error}"
                        ));
                    }
                }
            }

            Ok(ChainStorageValuesSnapshot {
                block_number,
                block_hash,
                values: values.into_iter().map(|value| value.flatten()).collect(),
            })
        }))
    }

    /// Returns the runtime version of the current best block without going through legacy JSON-RPC.
    pub fn chain_runtime_version_snapshot(
        &self,
        chain_id: ChainId,
    ) -> Result<
        Pin<Box<dyn core::future::Future<Output = Result<ChainRuntimeVersionSnapshot, String>>>>,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;

        Ok(Box::pin(async move {
            let subscribe_all = services
                .runtime_service
                .subscribe_all(16, NonZero::<usize>::new(32).unwrap())
                .await;
            let best_non_finalized_hash = subscribe_all
                .non_finalized_blocks_ancestry_order
                .iter()
                .find(|block| block.is_new_best)
                .map(|block| header::hash_from_scale_encoded_header(&block.scale_encoded_header));
            let finalized_runtime = subscribe_all.finalized_block_runtime;
            let subscription = subscribe_all.new_blocks;

            let runtime_spec = if let Some(best_block_hash) = best_non_finalized_hash {
                let (pinned_runtime, _, _) = services
                    .runtime_service
                    .pin_pinned_block_runtime(subscription.id(), best_block_hash)
                    .await
                    .map_err(|error| format!("Failed to pin best block runtime: {error}"))?;
                let runtime_spec = services
                    .runtime_service
                    .pinned_runtime_specification(pinned_runtime)
                    .await
                    .map_err(|error| format!("Failed to inspect best block runtime: {error}"))?;
                subscription.unpin_block(best_block_hash).await;
                runtime_spec
            } else {
                finalized_runtime
                    .map_err(|error| format!("Failed to inspect finalized runtime: {error}"))?
            };

            Ok(convert_runtime_version_snapshot(&runtime_spec))
        }))
    }

    /// Returns the runtime metadata of the current best block without going through legacy JSON-RPC.
    pub fn chain_metadata(
        &self,
        chain_id: ChainId,
    ) -> Result<Pin<Box<dyn core::future::Future<Output = Result<Vec<u8>, String>>>>, String> {
        let services = self.clone_chain_services(chain_id)?;

        Ok(Box::pin(async move {
            let subscribe_all = services
                .runtime_service
                .subscribe_all(16, NonZero::<usize>::new(32).unwrap())
                .await;
            let finalized_header = subscribe_all.finalized_block_scale_encoded_header.clone();
            let best_non_finalized_hash = subscribe_all
                .non_finalized_blocks_ancestry_order
                .iter()
                .find(|block| block.is_new_best)
                .map(|block| header::hash_from_scale_encoded_header(&block.scale_encoded_header));
            let subscription = subscribe_all.new_blocks;

            let (pinned_runtime, block_hash, block_state_trie_root_hash, block_number, unpin_hash) =
                if let Some(best_block_hash) = best_non_finalized_hash {
                    let (pinned_runtime, block_state_trie_root_hash, block_number) = services
                        .runtime_service
                        .pin_pinned_block_runtime(subscription.id(), best_block_hash)
                        .await
                        .map_err(|error| format!("Failed to pin best block runtime: {error}"))?;
                    (
                        pinned_runtime,
                        best_block_hash,
                        block_state_trie_root_hash,
                        block_number,
                        Some(best_block_hash),
                    )
                } else {
                    let finalized_block_hash =
                        header::hash_from_scale_encoded_header(&finalized_header);
                    let (pinned_runtime, block_state_trie_root_hash, block_number) =
                        compile_runtime_for_block(
                            services.sync_service.clone(),
                            services.runtime_service.clone(),
                            finalized_block_hash,
                            &finalized_header,
                        )
                        .await?;
                    (
                        pinned_runtime,
                        finalized_block_hash,
                        block_state_trie_root_hash,
                        block_number,
                        None,
                    )
                };

            let metadata_result = services
                .runtime_service
                .runtime_call(
                    pinned_runtime,
                    block_hash,
                    block_number,
                    block_state_trie_root_hash,
                    "Metadata_metadata".to_owned(),
                    Some(("Metadata".to_owned(), 1..=2)),
                    Vec::new(),
                    3,
                    Duration::from_secs(5),
                    NonZero::<u32>::new(1).unwrap(),
                )
                .await
                .map_err(|error| format!("Failed to execute Metadata_metadata: {error}"));

            if let Some(best_block_hash) = unpin_hash {
                subscription.unpin_block(best_block_hash).await;
            }

            let metadata = metadata_result?;
            smoldot::json_rpc::methods::remove_metadata_length_prefix(&metadata.output)
                .map(|metadata| metadata.to_vec())
                .map_err(|error| format!("Failed to decode metadata. Error: {error}"))
        }))
    }

    /// 返回当前 best 块的账户 nonce；保留给现有 FFI 的兼容投影。
    ///
    /// 本入口刻意丢弃准确块身份。安全敏感调用方必须改用
    /// [`Client::chain_account_next_index_snapshot`]。
    pub fn chain_account_next_index(
        &self,
        chain_id: ChainId,
        account_id: Vec<u8>,
    ) -> Result<Pin<Box<dyn core::future::Future<Output = Result<u64, String>> + Send>>, String>
    {
        let snapshot = self.chain_account_next_index_snapshot(chain_id, account_id)?;
        Ok(Box::pin(async move {
            snapshot.await.map(|snapshot| snapshot.nonce)
        }))
    }

    /// 在调用方已验证的准确块上取得同一Runtime的版本和metadata。
    /// 当前订阅已经固定的最终根、非最终块直接复用Runtime；历史块必须按目标hash
    /// 验证header与代码存储证明。不会把另一次采样的当前头当成请求块。
    pub fn chain_runtime_context_at(
        &self,
        chain_id: ChainId,
        block_hash: [u8; 32],
        block_number: u64,
    ) -> Result<
        Pin<
            Box<
                dyn core::future::Future<Output = Result<ChainRuntimeContextSnapshot, String>>
                    + Send,
            >,
        >,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;
        let platform = self.platform.clone();
        Ok(Box::pin(async move {
            let span = RuntimeDiagnosticSpan::start("runtime_context_subscribe");
            let subscription = services
                .runtime_service
                .subscribe_all(16, NonZero::<usize>::new(32).unwrap())
                .await;
            span.finish(true);
            let subscription_id = subscription.new_blocks.id();
            let reported = header::hash_from_scale_encoded_header(
                &subscription.finalized_block_scale_encoded_header,
            ) == block_hash
                || subscription
                    .non_finalized_blocks_ancestry_order
                    .iter()
                    .any(|block| {
                        header::hash_from_scale_encoded_header(&block.scale_encoded_header)
                            == block_hash
                    });
            let (cleanup, cleanup_rx) = runtime_subscription_cleanup(
                platform,
                services.runtime_service.clone(),
                subscription,
                "runtime_context_cleanup",
            );
            let result = async {
                let span = RuntimeDiagnosticSpan::start("runtime_context_pin");
                let pinned = if reported {
                    // 已报告但pin失败意味着订阅失效；必须报错，不能改取另一个块。
                    services
                        .runtime_service
                        .pin_pinned_block_runtime(subscription_id, block_hash)
                        .await
                        .map_err(|_| "Runtime subscription is obsolete".to_owned())
                } else {
                    // 历史块不属于订阅固定集合；保留准确header与代码证明读取能力。
                    let span = RuntimeDiagnosticSpan::start("runtime_context_historical");
                    let result = async {
                        let block = services
                            .sync_service
                            .clone()
                            .block_query_unknown_number(
                                block_hash,
                                smoldot::network::codec::BlocksRequestFields {
                                    header: true,
                                    body: false,
                                    justifications: false,
                                },
                                3,
                                Duration::from_secs(5),
                                NonZero::<u32>::new(1).unwrap(),
                            )
                            .await
                            .map_err(|_| "Runtime block header unavailable".to_owned())?;
                        let encoded = block
                            .header
                            .ok_or_else(|| "Runtime block header missing".to_owned())?;
                        validate_runtime_header(
                            &encoded,
                            services.sync_service.block_number_bytes(),
                            block_hash,
                            block_number,
                        )?;
                        compile_runtime_for_block(
                            services.sync_service.clone(),
                            services.runtime_service.clone(),
                            block_hash,
                            &encoded,
                        )
                        .await
                    }
                    .await;
                    span.finish(result.is_ok());
                    result
                };
                span.finish(pinned.is_ok());
                let (runtime, state_root, number) = pinned?;
                if number != block_number {
                    return Err("Runtime block height mismatch".to_owned());
                }
                let span = RuntimeDiagnosticSpan::start("runtime_context_version");
                let version = services
                    .runtime_service
                    .pinned_runtime_specification(runtime.clone())
                    .await
                    .map_err(|_| "Runtime specification unavailable".to_owned());
                span.finish(version.is_ok());
                let version = version?;
                let version = version.decode();
                let transaction_version = version
                    .transaction_version
                    .ok_or_else(|| "Runtime transaction version missing".to_owned())?;
                let spec_version = version.spec_version;
                let span = RuntimeDiagnosticSpan::start("runtime_context_metadata");
                let metadata = services
                    .runtime_service
                    .runtime_call(
                        runtime,
                        block_hash,
                        number,
                        state_root,
                        "Metadata_metadata".to_owned(),
                        Some(("Metadata".to_owned(), 1..=2)),
                        Vec::new(),
                        3,
                        Duration::from_secs(5),
                        NonZero::<u32>::new(1).unwrap(),
                    )
                    .await
                    .map_err(|_| "Metadata proof execution failed".to_owned());
                span.finish(metadata.is_ok());
                let metadata = metadata?;
                let metadata =
                    smoldot::json_rpc::methods::remove_metadata_length_prefix(&metadata.output)
                        .map_err(|_| "Invalid metadata length prefix".to_owned())?
                        .to_vec();
                Ok(ChainRuntimeContextSnapshot {
                    block_hash,
                    block_number: number,
                    spec_version,
                    transaction_version,
                    metadata,
                })
            }
            .await;
            drop(cleanup);
            let _ = cleanup_rx.await;
            result
        }))
    }

    /// 不经过 legacy JSON-RPC，返回 nonce 与同次 runtime call 固定的准确 best 块身份。
    pub fn chain_account_next_index_snapshot(
        &self,
        chain_id: ChainId,
        account_id: Vec<u8>,
    ) -> Result<
        Pin<
            Box<
                dyn core::future::Future<Output = Result<ChainAccountNonceSnapshot, String>> + Send,
            >,
        >,
        String,
    > {
        let services = self.clone_chain_services(chain_id)?;
        let platform = self.platform.clone();

        Ok(Box::pin(async move {
            let subscribe_span = RuntimeDiagnosticSpan::start("nonce_subscribe");
            let subscribe_all = services
                .runtime_service
                .subscribe_all(16, NonZero::<usize>::new(32).unwrap())
                .await;
            subscribe_span.finish(true);
            let block_hash = nonce_block_hash(
                &subscribe_all.finalized_block_scale_encoded_header,
                &subscribe_all.non_finalized_blocks_ancestry_order,
            );
            let subscription_id = subscribe_all.new_blocks.id();
            let (cleanup, cleanup_rx) = runtime_subscription_cleanup(
                platform,
                services.runtime_service.clone(),
                subscribe_all,
                "nonce_cleanup",
            );

            // subscribe_all已经固定最终块与已报告的非最终块Runtime。两种best状态
            // 必须使用同一pin入口，不能再下载:code/:heappages后重新查编译缓存。
            let pin_span = RuntimeDiagnosticSpan::start("nonce_pin_runtime");
            let pinned = services
                .runtime_service
                .pin_pinned_block_runtime(subscription_id, block_hash)
                .await;
            pin_span.finish(pinned.is_ok());
            let (pinned_runtime, block_state_trie_root_hash, block_number) = match pinned {
                Ok(pinned) => pinned,
                Err(error) => {
                    drop(cleanup);
                    let _ = cleanup_rx.await;
                    return Err(format!("Failed to pin best block runtime: {error}"));
                }
            };

            // 保留调用账户用于结果身份绑定；传给 runtime 的字节来自同一份输入，不允许
            // provider 在返回后重新拼接另一账户。
            let requested_account_id = account_id.clone();
            let call_span = RuntimeDiagnosticSpan::start("nonce_runtime_call");
            let nonce_result = services
                .runtime_service
                .runtime_call(
                    pinned_runtime,
                    block_hash,
                    block_number,
                    block_state_trie_root_hash,
                    "AccountNonceApi_account_nonce".to_owned(),
                    Some(("AccountNonceApi".to_owned(), 1..=1)),
                    account_id,
                    3,
                    Duration::from_secs(5),
                    NonZero::<u32>::new(1).unwrap(),
                )
                .await
                .map_err(|error| {
                    format!("Failed to execute AccountNonceApi_account_nonce: {error}")
                });
            call_span.finish(nonce_result.is_ok());
            drop(cleanup);
            let _ = cleanup_rx.await;

            let nonce_result = nonce_result?;
            let decode_span = RuntimeDiagnosticSpan::start("nonce_decode");
            let nonce = decode_account_nonce(&nonce_result.output);
            decode_span.finish(nonce.is_ok());
            Ok(ChainAccountNonceSnapshot {
                account_id: requested_account_id,
                block_number,
                block_hash,
                nonce: nonce?,
            })
        }))
    }

    /// Adds a new chain to the list of chains smoldot tries to synchronize.
    ///
    /// Returns an error in case something is wrong with the configuration.
    pub fn add_chain(
        &mut self,
        config: AddChainConfig<'_, TChain, impl Iterator<Item = ChainId>>,
    ) -> Result<AddChainSuccess<TPlat>, AddChainError> {
        // `chains_by_key` is created lazily whenever needed.
        let chains_by_key = self.chains_by_key.get_or_insert_with(|| {
            HashMap::with_hasher(util::SipHasherBuild::new({
                let mut seed = [0; 16];
                self.platform.fill_random_bytes(&mut seed);
                seed
            }))
        });

        // Decode the chain specification.
        let chain_spec = match chain_spec::ChainSpec::from_json_bytes(config.specification) {
            Ok(cs) => cs,
            Err(err) => {
                return Err(AddChainError::ChainSpecParseError(err));
            }
        };

        // Build the genesis block, its hash, and information about the chain.
        let (
            genesis_chain_information,
            genesis_block_header,
            print_warning_genesis_root_chainspec,
            genesis_block_state_root,
        ) = {
            // 上游 smol-dot/smoldot#1017 完成前，读取创世哈希仍需构建完整链信息。
            // 当前调用方只消费链信息，运行时返回值由该接口在此处显式丢弃。
            let genesis_chain_information = chain_spec.to_chain_information().map(|(ci, _)| ci);

            match genesis_chain_information {
                Ok(genesis_chain_information) => {
                    let header = genesis_chain_information.as_ref().finalized_block_header;
                    let state_root = *header.state_root;
                    let scale_encoded =
                        header.scale_encoding_vec(usize::from(chain_spec.block_number_bytes()));
                    (
                        Some(genesis_chain_information),
                        scale_encoded,
                        chain_spec.light_sync_state().is_some()
                            || chain_spec.relay_chain().is_some(),
                        state_root,
                    )
                }
                Err(chain_spec::FromGenesisStorageError::UnknownStorageItems) => {
                    let state_root = *chain_spec.genesis_storage().into_trie_root_hash().unwrap();
                    let header = header::Header {
                        parent_hash: [0; 32],
                        number: 0,
                        state_root,
                        extrinsics_root: smoldot::trie::EMPTY_BLAKE2_TRIE_MERKLE_VALUE,
                        digest: header::DigestRef::empty().into(),
                    }
                    .scale_encoding_vec(usize::from(chain_spec.block_number_bytes()));
                    (None, header, false, state_root)
                }
                Err(err) => return Err(AddChainError::InvalidGenesisStorage(err)),
            }
        };
        let genesis_block_hash = header::hash_from_scale_encoded_header(&genesis_block_header);

        // Decode the database and make sure that it matches the chain by comparing the finalized
        // block header in it with the actual one.
        let (database, database_was_wrong_chain) = {
            let mut maybe_database = database::decode_database(
                config.database_content,
                chain_spec.block_number_bytes().into(),
            )
            .ok();
            let mut database_was_wrong = false;
            if maybe_database
                .as_ref()
                .map_or(false, |db| db.genesis_block_hash != genesis_block_hash)
            {
                maybe_database = None;
                database_was_wrong = true;
            }
            (maybe_database, database_was_wrong)
        };

        // Load the information about the chain. If a light sync state (also known as a checkpoint)
        // is present in the chain spec, it is possible to start syncing at the finalized block
        // it describes.
        // At the same time, we deconstruct the database into `known_nodes`
        // and `runtime_code_hint`.
        let (chain_information, used_database_chain_information, known_nodes, runtime_code_hint) = {
            let checkpoint = chain_spec
                .light_sync_state()
                .map(|s| s.to_chain_information());

            // 启动锚点诊断只记录结构化高度，不输出 database 正文，便于确认本机
            // finalized database 是否被成功解码以及与安装包 checkpoint 的优先级。
            log!(
                &self.platform,
                Debug,
                "smoldot",
                format!(
                    "Startup anchor candidates for {}. Checkpoint: {:?}. Database: {:?}",
                    chain_spec.id(),
                    checkpoint.as_ref().map(|checkpoint| checkpoint
                        .as_ref()
                        .map(|ci| ci.as_ref().finalized_block_header.number)),
                    database.as_ref().and_then(|database| database
                        .chain_information
                        .as_ref()
                        .map(|ci| ci.as_ref().finalized_block_header.number)),
                )
            );

            match (genesis_chain_information, checkpoint, database) {
                // Use the database if it contains a more recent block than the
                // chain spec checkpoint.
                (
                    _,
                    Some(Ok(checkpoint)),
                    Some(database::DatabaseContent {
                        chain_information: Some(db_ci),
                        known_nodes,
                        runtime_code_hint,
                        ..
                    }),
                ) if db_ci.as_ref().finalized_block_header.number
                    >= checkpoint.as_ref().finalized_block_header.number =>
                {
                    (Some(db_ci), true, known_nodes, runtime_code_hint)
                }

                // Otherwise, use the chain spec checkpoint.
                (
                    _,
                    Some(Ok(checkpoint)),
                    Some(database::DatabaseContent {
                        known_nodes,
                        runtime_code_hint,
                        ..
                    }),
                ) => (Some(checkpoint), false, known_nodes, runtime_code_hint),
                (_, Some(Ok(checkpoint)), None) => (Some(checkpoint), false, Vec::new(), None),

                // If neither the genesis chain information nor the checkpoint chain information
                // is available, we could in principle use the database, but for API reasons we
                // don't want users to be able to rely on just a database (as we reserve the right
                // to break the database at any point) and thus return an error.
                (
                    None,
                    None,
                    Some(database::DatabaseContent {
                        known_nodes,
                        runtime_code_hint,
                        ..
                    }),
                ) => (None, false, known_nodes, runtime_code_hint),
                (None, None, None) => (None, false, Vec::new(), None),

                // CitizenApp 的签名安装包固定内置创世 checkpoint。该 checkpoint 在
                // chain-spec 层以 `GenesisBlockCheckpoint` 表示，但本机 database 中
                // 更高的 chain information 仍必须成为真实同步起点；否则每次冷启动
                // 都会错误回到 `#0` 并重复 warp。
                (
                    Some(_),
                    None
                    | Some(Err(
                        chain_spec::CheckpointToChainInformationError::GenesisBlockCheckpoint,
                    )),
                    Some(database::DatabaseContent {
                        chain_information: Some(db_ci),
                        known_nodes,
                        runtime_code_hint,
                        ..
                    }),
                ) => (Some(db_ci), true, known_nodes, runtime_code_hint),

                // Use the genesis block if no checkpoint is available.
                (
                    Some(genesis_ci),
                    None
                    | Some(Err(
                        chain_spec::CheckpointToChainInformationError::GenesisBlockCheckpoint,
                    )),
                    Some(database::DatabaseContent {
                        known_nodes,
                        runtime_code_hint,
                        ..
                    }),
                ) => (Some(genesis_ci), false, known_nodes, runtime_code_hint),
                (
                    Some(genesis_ci),
                    None
                    | Some(Err(
                        chain_spec::CheckpointToChainInformationError::GenesisBlockCheckpoint,
                    )),
                    None,
                ) => (Some(genesis_ci), false, Vec::new(), None),

                // If the checkpoint format is invalid, we return an error no matter whether the
                // genesis chain information could be used.
                (_, Some(Err(err)), _) => {
                    return Err(AddChainError::InvalidCheckpoint(err));
                }
            }
        };

        // If the chain specification specifies a parachain, find the corresponding relay chain
        // in the list of potential relay chains passed by the user.
        // If no relay chain can be found, the chain creation fails. Exactly one matching relay
        // chain must be found. If there are multiple ones, the creation fails as well.
        let relay_chain_id = if let Some((relay_chain_id, para_id)) = chain_spec.relay_chain() {
            let chain = config
                .potential_relay_chains
                .filter(|c| {
                    self.public_api_chains
                        .get(c.0)
                        .map_or(false, |chain| chain.chain_spec_chain_id == relay_chain_id)
                })
                .exactly_one();

            match chain {
                Ok(c) => Some((c, para_id)),
                Err(mut iter) => {
                    // `iter` here is identical to the iterator above before `exactly_one` is
                    // called. This lets us know what failed.
                    return Err(if iter.next().is_none() {
                        AddChainError::NoRelayChainFound
                    } else {
                        debug_assert!(iter.next().is_some());
                        AddChainError::MultipleRelayChains
                    });
                }
            }
        } else {
            None
        };

        // Build the list of bootstrap nodes ahead of time.
        // Because the specification of the format of a multiaddress is a bit flexible, it is
        // not possible to firmly affirm that a multiaddress is invalid. For this reason, we
        // simply ignore unparsable bootnode addresses rather than returning an error.
        // A list of invalid bootstrap node addresses is kept in order to print a warning later
        // in case it is non-empty. This list is sanitized in order to be safely printable as part
        // of the logs.
        let (bootstrap_nodes, invalid_bootstrap_nodes_sanitized) = {
            let mut valid_list = Vec::with_capacity(chain_spec.boot_nodes().len());
            let mut invalid_list = Vec::with_capacity(0);
            for node in chain_spec.boot_nodes() {
                match node {
                    chain_spec::Bootnode::Parsed { multiaddr, peer_id } => {
                        if let Ok(multiaddr) = multiaddr.parse::<multiaddr::Multiaddr>() {
                            let peer_id = peer_id::PeerId::from_bytes(peer_id).unwrap();
                            valid_list.push((peer_id, vec![multiaddr]));
                        } else {
                            invalid_list.push(multiaddr)
                        }
                    }
                    chain_spec::Bootnode::UnrecognizedFormat(unparsed) => invalid_list.push(
                        unparsed
                            .chars()
                            .filter(|c| c.is_ascii())
                            .collect::<String>(),
                    ),
                }
            }
            (valid_list, invalid_list)
        };

        // All the checks are performed above. Adding the chain can't fail anymore at this point.

        // Grab this field from the chain specification for later, as the chain specification is
        // consumed below.
        let chain_spec_chain_id = chain_spec.id().to_owned();

        // The key generated here uniquely identifies this chain within smoldot. Multiple chains
        // having the same key will use the same services.
        //
        // This struct is extremely important from a security perspective. We want multiple
        // identical chains to be de-duplicated, but security issues would arise if two chains
        // were considered identical while they're in reality not identical.
        let new_chain_key = ChainKey {
            genesis_block_hash,
            relay_chain: relay_chain_id.map(|(ck, _)| {
                (
                    Box::new(self.public_api_chains.get(ck.0).unwrap().key.clone()),
                    chain_spec.relay_chain().unwrap().1,
                )
            }),
            fork_id: chain_spec.fork_id().map(|f| f.to_owned()),
        };

        // If the chain we are adding is a parachain, grab the services of the relay chain.
        //
        // This could in principle be done later on, but doing so raises borrow checker errors.
        let relay_chain: Option<(ChainServices<_>, u32, String)> =
            relay_chain_id.map(|(relay_chain, para_id)| {
                let relay_chain = &chains_by_key
                    .get(&self.public_api_chains.get(relay_chain.0).unwrap().key)
                    .unwrap();
                (
                    relay_chain.services.clone(),
                    para_id,
                    relay_chain.log_name.clone(),
                )
            });

        // Determinate the name under which the chain will be identified in the logs.
        // Because the chain spec is untrusted input, we must transform the `id` to remove all
        // weird characters.
        //
        // By default, this log name will be equal to chain's `id`. Since it is possible for
        // multiple different chains to have the same `id`, we need to look into the list of
        // existing chains and make sure that there's no conflict, in which case the log name
        // will have the suffix `-1`, or `-2`, or `-3`, and so on.
        //
        // This value is ignored if we enter the `Entry::Occupied` block below. Because the
        // calculation requires accessing the list of existing chains, this block can't be put in
        // the `Entry::Vacant` block below, even though it would make more sense for it to be
        // there.
        let log_name = {
            let base = chain_spec
                .id()
                .chars()
                .filter(|c| c.is_ascii_graphic())
                .collect::<String>();
            let mut suffix = None;

            loop {
                let attempt = if let Some(suffix) = suffix {
                    format!("{base}-{suffix}")
                } else {
                    base.clone()
                };

                if !chains_by_key.values().any(|c| *c.log_name == attempt) {
                    break attempt;
                }

                match &mut suffix {
                    Some(v) => *v += 1,
                    v @ None => *v = Some(1),
                }
            }
        };

        // Start the services of the chain to add, or grab the services if they already exist.
        let (services, log_name) = match chains_by_key.entry(new_chain_key.clone()) {
            Entry::Occupied(mut entry) => {
                // The chain to add always has a corresponding chain running. Simply grab the
                // existing services and existing log name.
                // The `log_name` created above is discarded in favour of the existing log name.
                entry.get_mut().num_references = entry.get().num_references.checked_add(1).unwrap();
                let entry = entry.into_mut();
                (&mut entry.services, &entry.log_name)
            }
            Entry::Vacant(entry) => {
                if let (None, None) = (&relay_chain, &chain_information) {
                    return Err(AddChainError::ChainSpecNeitherGenesisStorageNorCheckpoint);
                }

                // Start the services of the new chain.
                let services = {
                    // Version of the client when requested through the networking.
                    let network_identify_agent_version = format!(
                        "{} {}",
                        self.platform.client_name(),
                        self.platform.client_version()
                    );

                    let config = match (&relay_chain, &chain_information) {
                        (Some((relay_chain, para_id, _)), Some(chain_information)) => {
                            StartServicesChainTy::Parachain {
                                relay_chain,
                                finalized_block_header: chain_information
                                    .as_ref()
                                    .finalized_block_header
                                    .scale_encoding_vec(usize::from(
                                        chain_spec.block_number_bytes(),
                                    )),
                                para_id: *para_id,
                            }
                        }
                        (Some((relay_chain, para_id, _)), None) => {
                            StartServicesChainTy::Parachain {
                                relay_chain,
                                finalized_block_header: genesis_block_header.clone(),
                                para_id: *para_id,
                            }
                        }
                        (None, Some(chain_information)) => StartServicesChainTy::RelayChain {
                            chain_information,
                            startup_finalized_source: if used_database_chain_information {
                                sync_service::StartupFinalizedSource::LocalDatabase
                            } else {
                                sync_service::StartupFinalizedSource::BundledCheckpoint
                            },
                        },
                        (None, None) => {
                            // Checked above.
                            unreachable!()
                        }
                    };

                    start_services(
                        log_name.clone(),
                        &self.platform,
                        &mut self.network_service,
                        runtime_code_hint,
                        genesis_block_header,
                        usize::from(chain_spec.block_number_bytes()),
                        chain_spec.fork_id().map(|f| f.to_owned()),
                        config,
                        network_identify_agent_version,
                    )
                };

                // Note that the chain name is printed through the `Debug` trait (rather
                // than `Display`) because it is an untrusted user input.
                if let Some((_, para_id, relay_chain_log_name)) = relay_chain.as_ref() {
                    log!(
                        &self.platform,
                        Info,
                        "smoldot",
                        format!(
                            "Parachain initialization complete for {}. Name: {:?}. Genesis \
                            hash: {}. Relay chain: {} (id: {})",
                            log_name,
                            chain_spec.name(),
                            HashDisplay(&genesis_block_hash),
                            relay_chain_log_name,
                            para_id
                        )
                    );
                } else {
                    log!(
                        &self.platform,
                        Info,
                        "smoldot",
                        format!(
                            "Chain initialization complete for {}. Name: {:?}. Genesis \
                            hash: {}. {} starting at: {} (#{})",
                            log_name,
                            chain_spec.name(),
                            HashDisplay(&genesis_block_hash),
                            if used_database_chain_information {
                                "Database"
                            } else {
                                "Chain specification"
                            },
                            HashDisplay(
                                &chain_information
                                    .as_ref()
                                    .map(|ci| ci
                                        .as_ref()
                                        .finalized_block_header
                                        .hash(usize::from(chain_spec.block_number_bytes())))
                                    .unwrap_or(genesis_block_hash)
                            ),
                            chain_information
                                .as_ref()
                                .map(|ci| ci.as_ref().finalized_block_header.number)
                                .unwrap_or(0)
                        )
                    );
                }

                if print_warning_genesis_root_chainspec {
                    log!(
                        &self.platform,
                        Info,
                        "smoldot",
                        format!(
                            "Chain specification of {} contains a `genesis.raw` item. It is \
                            possible to significantly improve the initialization time by \
                            replacing the `\"raw\": ...` field with \
                            `\"stateRootHash\": \"0x{}\"`",
                            log_name,
                            hex::encode(genesis_block_state_root)
                        )
                    );
                }

                if chain_spec.protocol_id().is_some() {
                    log!(
                        &self.platform,
                        Warn,
                        "smoldot",
                        format!(
                            "Chain specification of {} contains a `protocolId` field. This \
                            field is deprecated and its value is no longer used. It can be \
                            safely removed from the JSON document.",
                            log_name
                        )
                    );
                }

                if chain_spec.telemetry_endpoints().count() != 0 {
                    log!(
                        &self.platform,
                        Warn,
                        "smoldot",
                        format!(
                            "Chain specification of {} contains a non-empty \
                            `telemetryEndpoints` field. Smoldot doesn't support telemetry \
                            endpoints and as such this field is unused.",
                            log_name
                        )
                    );
                }

                // 上游 paritytech/smoldot#2584 完成前保留 badBlocks 警告检查。
                if chain_spec.bad_blocks_hashes().count() != 0 {
                    log!(
                        &self.platform,
                        Warn,
                        "smoldot",
                        format!(
                            "Chain specification of {} contains a list of bad blocks. Bad \
                            blocks are not implemented in the light client. An appropriate \
                            way to silence this warning is to remove the bad blocks from the \
                            chain specification, which can safely be done:\n\
                            - For relay chains: if the chain specification contains a \
                            checkpoint and that the bad blocks have a block number inferior \
                            to this checkpoint.\n\
                            - For parachains: if the bad blocks have a block number inferior \
                            to the current parachain finalized block.",
                            log_name
                        )
                    );
                }

                if database_was_wrong_chain {
                    log!(
                        &self.platform,
                        Warn,
                        "smoldot",
                        format!(
                            "Ignore database of {} because its genesis hash didn't match the \
                            genesis hash of the chain.",
                            log_name
                        )
                    )
                }

                let entry = entry.insert(RunningChain {
                    services,
                    log_name,
                    num_references: NonZero::<u32>::new(1).unwrap(),
                });

                (&mut entry.services, &entry.log_name)
            }
        };

        if !invalid_bootstrap_nodes_sanitized.is_empty() {
            log!(
                &self.platform,
                Warn,
                "smoldot",
                format!(
                    "Failed to parse some of the bootnodes of {}. \
                    These bootnodes have been ignored. List: {}",
                    log_name,
                    invalid_bootstrap_nodes_sanitized.join(", ")
                )
            );
        }

        // Print a warning if the list of bootnodes is empty, as this is a common mistake.
        if bootstrap_nodes.is_empty() {
            // Note the usage of the word "likely", because another chain with the same key might
            // have been added earlier and contains bootnodes, or we might receive an incoming
            // substream on a connection normally used for a different chain.
            log!(
                &self.platform,
                Warn,
                "smoldot",
                format!(
                    "Newly-added chain {} has an empty list of bootnodes. Smoldot will \
                    likely fail to connect to its peer-to-peer network.",
                    log_name
                )
            );
        }

        // Apart from its services, each chain also has an entry in `public_api_chains`.
        let public_api_chains_entry = self.public_api_chains.vacant_entry();
        let new_chain_id = ChainId(public_api_chains_entry.key());

        // Multiple chains can share the same network service, but each specify different
        // bootstrap nodes and database nodes. In order to resolve this, each chain adds their own
        // bootnodes and database nodes to the network service after it has been initialized. This
        // is done by adding a short-lived task that waits for the chain initialization to finish
        // then adds the nodes.
        self.platform
            .spawn_task("network-service-add-initial-topology".into(), {
                let network_service = services.network_service.clone();
                async move {
                    network_service.discover(known_nodes, false).await;
                    network_service.discover(bootstrap_nodes, true).await;
                }
            });

        // JSON-RPC service initialization. This is done every time `add_chain` is called, even
        // if a similar chain already existed.
        let json_rpc_frontend = if let AddChainConfigJsonRpc::Enabled {
            max_pending_requests,
            max_subscriptions,
        } = config.json_rpc
        {
            let frontend = json_rpc_service::service(json_rpc_service::Config {
                platform: self.platform.clone(),
                // 当前同一条链下的多个 JSON-RPC 服务共用日志名，由调用上下文区分。
                log_name: log_name.clone(),
                max_pending_requests,
                max_subscriptions,
                sync_service: services.sync_service.clone(),
                network_service: services.network_service.clone(),
                transactions_service: services.transactions_service.clone(),
                runtime_service: services.runtime_service.clone(),
                chain_name: chain_spec.name().to_owned(),
                chain_ty: chain_spec.chain_type().to_owned(),
                chain_is_live: chain_spec.has_live_network(),
                chain_properties_json: chain_spec.properties().to_owned(),
                system_name: self.platform.client_name().into_owned(),
                system_version: self.platform.client_version().into_owned(),
                genesis_block_hash,
            });

            Some(frontend)
        } else {
            None
        };

        // Success!
        let public_api_chain_destroyed_event = event_listener::Event::new();
        let public_api_chain_destroyed = public_api_chain_destroyed_event.listen();
        public_api_chains_entry.insert(PublicApiChain {
            user_data: config.user_data,
            key: new_chain_key,
            chain_spec_chain_id,
            json_rpc_frontend: json_rpc_frontend.clone(),
            public_api_chain_destroyed_event,
        });
        Ok(AddChainSuccess {
            chain_id: new_chain_id,
            json_rpc_responses: json_rpc_frontend.map(|f| JsonRpcResponses {
                inner: Some(f),
                public_api_chain_destroyed,
            }),
        })
    }

    /// Removes the chain from smoldot. This instantaneously and silently cancels all on-going
    /// JSON-RPC requests and subscriptions.
    ///
    /// The provided [`ChainId`] is now considered dead. Be aware that this same [`ChainId`] might
    /// later be reused if [`Client::add_chain`] is called again.
    ///
    /// While from the API perspective it will look like the chain no longer exists, calling this
    /// function will not actually immediately disconnect from the given chain if it is still used
    /// as the relay chain of a parachain.
    ///
    /// If the [`JsonRpcResponses`] object that was returned when adding the chain is still alive,
    /// [`JsonRpcResponses::next`] will now return `None`.
    #[must_use]
    pub fn remove_chain(&mut self, id: ChainId) -> TChain {
        let removed_chain = self.public_api_chains.remove(id.0);

        removed_chain
            .public_api_chain_destroyed_event
            .notify(usize::MAX);

        // `chains_by_key` is created lazily when `add_chain` is called.
        // Since we're removing a chain that has been added with `add_chain`, it is guaranteed
        // that `chains_by_key` is set.
        let chains_by_key = self
            .chains_by_key
            .as_mut()
            .unwrap_or_else(|| unreachable!());

        let running_chain = chains_by_key.get_mut(&removed_chain.key).unwrap();
        if running_chain.num_references.get() == 1 {
            log!(
                &self.platform,
                Info,
                "smoldot",
                format!("Shutting down chain {}", running_chain.log_name)
            );
            chains_by_key.remove(&removed_chain.key);
        } else {
            running_chain.num_references =
                NonZero::<u32>::new(running_chain.num_references.get() - 1).unwrap();
        }

        self.public_api_chains.shrink_to_fit();

        removed_chain.user_data
    }

    /// Enqueues a JSON-RPC request towards the given chain.
    ///
    /// Since most JSON-RPC requests can only be answered asynchronously, the request is only
    /// queued and will be decoded and processed later.
    ///
    /// Returns an error if the number of requests that have been sent but whose answer hasn't been
    /// pulled with [`JsonRpcResponses::next`] is superior or equal to the value that was passed
    /// through [`AddChainConfigJsonRpc::Enabled::max_pending_requests`]. In that situation, the
    /// API user is encouraged to stop sending requests and start pulling answers with
    /// [`JsonRpcResponses::next`].
    ///
    /// Passing `u32::MAX` to [`AddChainConfigJsonRpc::Enabled::max_pending_requests`] is
    /// a good way to avoid errors here, but this should only be done if the JSON-RPC client is
    /// trusted.
    ///
    /// If the JSON-RPC request is not a valid JSON-RPC request, a JSON-RPC error response with
    /// an `id` equal to `null` is later generated, in accordance with the JSON-RPC specification.
    ///
    /// # Panic
    ///
    /// Panics if the [`ChainId`] is invalid, or if [`AddChainConfig::json_rpc`] was
    /// [`AddChainConfigJsonRpc::Disabled`] when adding the chain.
    ///
    pub fn json_rpc_request(
        &mut self,
        json_rpc_request: impl Into<String>,
        chain_id: ChainId,
    ) -> Result<(), HandleRpcError> {
        self.json_rpc_request_inner(json_rpc_request.into(), chain_id)
    }

    fn json_rpc_request_inner(
        &mut self,
        json_rpc_request: String,
        chain_id: ChainId,
    ) -> Result<(), HandleRpcError> {
        let json_rpc_sender = match self
            .public_api_chains
            .get_mut(chain_id.0)
            .unwrap()
            .json_rpc_frontend
        {
            Some(ref mut json_rpc_sender) => json_rpc_sender,
            _ => panic!(),
        };

        json_rpc_sender.queue_rpc_request(json_rpc_request)
    }
}

fn convert_runtime_version_snapshot(
    runtime_spec: &'_ smoldot::executor::CoreVersion,
) -> ChainRuntimeVersionSnapshot {
    let runtime_spec = runtime_spec.decode();
    ChainRuntimeVersionSnapshot {
        spec_name: runtime_spec.spec_name.to_owned(),
        impl_name: runtime_spec.impl_name.to_owned(),
        authoring_version: u64::from(runtime_spec.authoring_version),
        spec_version: u64::from(runtime_spec.spec_version),
        impl_version: u64::from(runtime_spec.impl_version),
        transaction_version: runtime_spec.transaction_version.map(u64::from),
        state_version: runtime_spec.state_version.map(u8::from).map(u64::from),
        apis: runtime_spec
            .apis
            .map(|api| (api.name_hash.to_vec(), api.version))
            .collect(),
    }
}

/// 同次订阅只有一个best；没有非最终best时，准确目标就是已固定的最终块。
fn nonce_block_hash(
    finalized_header: &[u8],
    blocks: &[runtime_service::BlockNotification],
) -> [u8; 32] {
    blocks.iter().find(|block| block.is_new_best).map_or_else(
        || header::hash_from_scale_encoded_header(finalized_header),
        |block| header::hash_from_scale_encoded_header(&block.scale_encoded_header),
    )
}

/// AccountNonceApi v1在本链返回SCALE u32；拒绝截断、空值和多余字节。
fn decode_account_nonce(output: &[u8]) -> Result<u64, String> {
    let bytes: [u8; 4] = output
        .try_into()
        .map_err(|_| "Failed to decode runtime output".to_string())?;
    Ok(u64::from(u32::from_le_bytes(bytes)))
}

/// 校验历史header自身hash和高度；状态根随后只从这份header解码。
fn validate_runtime_header(
    encoded: &[u8],
    number_bytes: usize,
    hash: [u8; 32],
    number: u64,
) -> Result<(), String> {
    if header::hash_from_scale_encoded_header(encoded) != hash {
        return Err("Runtime block header hash mismatch".to_owned());
    }
    let decoded = header::decode(encoded, number_bytes)
        .map_err(|_| "Invalid runtime block header".to_owned())?;
    if decoded.number != number {
        return Err("Runtime block header height mismatch".to_owned());
    }
    Ok(())
}

/// Runtime查询共用的引用释放；取消也独立排空本订阅已报告的引用。
fn runtime_subscription_cleanup<TPlat: platform::PlatformRef>(
    platform: TPlat,
    service: Arc<runtime_service::RuntimeService<TPlat>>,
    subscribe_all: runtime_service::SubscribeAll<TPlat>,
    stage: &'static str,
) -> (
    RuntimeCleanup<impl FnOnce()>,
    futures_channel::oneshot::Receiver<()>,
) {
    let mut hashes = vec![header::hash_from_scale_encoded_header(
        &subscribe_all.finalized_block_scale_encoded_header,
    )];
    hashes.extend(
        subscribe_all
            .non_finalized_blocks_ancestry_order
            .iter()
            .map(|block| header::hash_from_scale_encoded_header(&block.scale_encoded_header)),
    );
    let mut subscription = subscribe_all.new_blocks;
    let subscription_id = subscription.id();
    let (tx, rx) = futures_channel::oneshot::channel();
    let cleanup = RuntimeCleanup(Some(move || {
        platform.spawn_task("runtime-subscription-release".into(), async move {
            use futures_util::FutureExt as _;
            let span = RuntimeDiagnosticSpan::start(stage);
            while let Some(Some(notification)) = subscription.next().now_or_never() {
                if let runtime_service::Notification::Block(block) = notification {
                    hashes.push(header::hash_from_scale_encoded_header(
                        &block.scale_encoded_header,
                    ));
                }
            }
            drop(subscription);
            hashes.sort_unstable();
            hashes.dedup();
            for hash in hashes {
                service.unpin_block(subscription_id, hash).await;
            }
            span.finish(true);
            let _ = tx.send(());
        });
    }));
    (cleanup, rx)
}

/// 只拥有一次释放动作；正常完成、错误返回与Future取消共用同一析构路径。
struct RuntimeCleanup<F: FnOnce()>(Option<F>);

impl<F: FnOnce()> Drop for RuntimeCleanup<F> {
    fn drop(&mut self) {
        if let Some(cleanup) = self.0.take() {
            cleanup();
        }
    }
}

/// 定向诊断默认关闭，只接受源码固定阶段名与结果布尔值；不接收业务值或错误文本。
/// no_std构建完全移除系统环境、时钟及输出，仍使用完全相同的Runtime读取逻辑。
struct RuntimeDiagnosticSpan {
    #[cfg(feature = "std")]
    inner: Option<(&'static str, std::time::Instant)>,
}

impl RuntimeDiagnosticSpan {
    fn start(_stage: &'static str) -> Self {
        Self {
            #[cfg(feature = "std")]
            inner: (std::env::var_os("CITIZENSDK_TRANSACTION_DIAGNOSTICS").as_deref()
                == Some(std::ffi::OsStr::new("1")))
            .then(|| (_stage, std::time::Instant::now())),
        }
    }

    fn finish(mut self, success: bool) {
        self.record(if success { "success" } else { "failed" });
    }

    fn record(&mut self, _result: &'static str) {
        #[cfg(feature = "std")]
        if let Some((stage, started)) = self.inner.take() {
            let at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |value| value.as_millis());
            eprintln!(
                "CITIZENSDK_TX_DIAG at_ms={at_ms} stage={stage} elapsed_us={} result={_result}",
                started.elapsed().as_micros()
            );
        }
    }
}

impl Drop for RuntimeDiagnosticSpan {
    fn drop(&mut self) {
        self.record("cancelled");
    }
}

#[cfg(test)]
mod runtime_query_tests {
    use super::*;

    fn block(header: u8, best: bool) -> runtime_service::BlockNotification {
        runtime_service::BlockNotification {
            is_new_best: best,
            scale_encoded_header: vec![header],
            parent_hash: [0; 32],
            new_runtime: None,
        }
    }

    #[test]
    fn finalized_best_and_non_finalized_best_use_the_reported_identity() {
        let finalized = [1];
        let finalized_hash = header::hash_from_scale_encoded_header(&finalized);
        assert_eq!(nonce_block_hash(&finalized, &[]), finalized_hash);
        // 存在分叉不代表best在分叉上，必须继续选择最终根。
        assert_eq!(
            nonce_block_hash(&finalized, &[block(2, false)]),
            finalized_hash
        );
        let blocks = [block(2, false), block(3, true), block(4, false)];
        assert_eq!(
            nonce_block_hash(&finalized, &blocks),
            header::hash_from_scale_encoded_header(&[3])
        );
    }

    #[test]
    fn runtime_header_rejects_malformed_hash_and_height() {
        let mut encoded = vec![0; 32];
        encoded.push(10 << 2);
        encoded.extend_from_slice(&[0x11; 32]);
        encoded.extend_from_slice(&[0x22; 32]);
        encoded.push(0);
        let hash = header::hash_from_scale_encoded_header(&encoded);
        assert!(validate_runtime_header(&encoded, 4, hash, 10).is_ok());
        assert!(validate_runtime_header(&encoded, 4, [0; 32], 10).is_err());
        assert!(validate_runtime_header(&encoded, 4, hash, 11).is_err());
        let invalid = [0; 3];
        assert!(
            validate_runtime_header(
                &invalid,
                4,
                header::hash_from_scale_encoded_header(&invalid),
                0
            )
            .is_err()
        );
    }

    #[test]
    fn nonce_decode_accepts_u32_boundaries_and_rejects_malformed_output() {
        for value in [0, 17, u32::MAX] {
            assert_eq!(
                decode_account_nonce(&value.to_le_bytes()).ok(),
                Some(u64::from(value))
            );
        }
        for length in [0, 1, 3, 5, 8] {
            assert!(decode_account_nonce(&vec![0; length]).is_err());
        }
    }

    #[test]
    fn cancelling_pending_runtime_scope_releases_once() {
        use core::{
            future::Future as _,
            task::{Context, Poll},
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        let releases = Arc::new(AtomicUsize::new(0));
        let observed = releases.clone();
        let mut query = Box::pin(async move {
            let _cleanup = RuntimeCleanup(Some(move || {
                observed.fetch_add(1, Ordering::SeqCst);
            }));
            core::future::pending::<()>().await;
        });
        let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(matches!(query.as_mut().poll(&mut context), Poll::Pending));
        assert_eq!(releases.load(Ordering::SeqCst), 0);
        drop(query);
        assert_eq!(releases.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn completed_and_failed_runtime_scopes_release_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for success in [true, false] {
            let releases = AtomicUsize::new(0);
            let result = (|| -> Result<(), ()> {
                let cleanup = RuntimeCleanup(Some(|| {
                    releases.fetch_add(1, Ordering::SeqCst);
                }));
                if !success {
                    return Err(());
                }
                drop(cleanup);
                Ok(())
            })();
            assert_eq!(result.is_ok(), success);
            assert_eq!(releases.load(Ordering::SeqCst), 1);
        }
    }
}

async fn compile_runtime_for_block<TPlat: platform::PlatformRef>(
    sync_service: Arc<sync_service::SyncService<TPlat>>,
    runtime_service: Arc<runtime_service::RuntimeService<TPlat>>,
    block_hash: [u8; 32],
    scale_encoded_header: &[u8],
) -> Result<(runtime_service::PinnedRuntime, [u8; 32], u64), String> {
    let decoded_header = header::decode(scale_encoded_header, sync_service.block_number_bytes())
        .map_err(|error| format!("Failed to decode block header: {error}"))?;
    let block_state_trie_root_hash = *decoded_header.state_root;
    let block_number = decoded_header.number;

    let mut storage_code = None;
    let mut storage_heap_pages = None;
    let mut code_merkle_value = None;
    let mut code_closest_ancestor_excluding = None;

    let mut query = sync_service
        .clone()
        .storage_query(
            block_number,
            block_hash,
            block_state_trie_root_hash,
            [
                sync_service::StorageRequestItem {
                    key: b":code".to_vec(),
                    ty: sync_service::StorageRequestItemTy::ClosestDescendantMerkleValue,
                },
                sync_service::StorageRequestItem {
                    key: b":code".to_vec(),
                    ty: sync_service::StorageRequestItemTy::Value,
                },
                sync_service::StorageRequestItem {
                    key: b":heappages".to_vec(),
                    ty: sync_service::StorageRequestItemTy::Value,
                },
            ]
            .into_iter(),
            3,
            Duration::from_secs(20),
            NonZero::<u32>::new(3).unwrap(),
        )
        .advance()
        .await;

    loop {
        match query {
            sync_service::StorageQueryProgress::Finished => break,
            sync_service::StorageQueryProgress::Progress {
                request_index: 0,
                item:
                    sync_service::StorageResultItem::ClosestDescendantMerkleValue {
                        closest_descendant_merkle_value,
                        found_closest_ancestor_excluding,
                        ..
                    },
                query: next,
            } => {
                code_merkle_value = closest_descendant_merkle_value;
                code_closest_ancestor_excluding = found_closest_ancestor_excluding;
                query = next.advance().await;
            }
            sync_service::StorageQueryProgress::Progress {
                request_index: 1,
                item: sync_service::StorageResultItem::Value { value, .. },
                query: next,
            } => {
                storage_code = value;
                query = next.advance().await;
            }
            sync_service::StorageQueryProgress::Progress {
                request_index: 2,
                item: sync_service::StorageResultItem::Value { value, .. },
                query: next,
            } => {
                storage_heap_pages = value;
                query = next.advance().await;
            }
            sync_service::StorageQueryProgress::Progress { .. } => unreachable!(),
            sync_service::StorageQueryProgress::Error(error) => {
                return Err(format!("Failed to download runtime storage: {error}"));
            }
        }
    }

    let pinned_runtime = runtime_service
        .compile_and_pin_runtime(
            storage_code,
            storage_heap_pages,
            code_merkle_value,
            code_closest_ancestor_excluding,
        )
        .await
        .map_err(|error| format!("Failed to compile and pin runtime: {error}"))?;

    Ok((pinned_runtime, block_state_trie_root_hash, block_number))
}

impl<TPlat: platform::PlatformRef, TChain> ops::Index<ChainId> for Client<TPlat, TChain> {
    type Output = TChain;

    fn index(&self, index: ChainId) -> &Self::Output {
        &self.public_api_chains.get(index.0).unwrap().user_data
    }
}

impl<TPlat: platform::PlatformRef, TChain> ops::IndexMut<ChainId> for Client<TPlat, TChain> {
    fn index_mut(&mut self, index: ChainId) -> &mut Self::Output {
        &mut self.public_api_chains.get_mut(index.0).unwrap().user_data
    }
}

/// Error potentially returned by [`Client::add_chain`].
#[derive(Debug, derive_more::Display, derive_more::Error)]
pub enum AddChainError {
    /// Failed to decode the specification of the chain.
    #[display("Failed to decode chain specification: {_0}")]
    ChainSpecParseError(chain_spec::ParseError),
    /// The chain specification must contain either the storage of the genesis block, or a
    /// checkpoint. Neither was provided.
    #[display("Either a checkpoint or the genesis storage must be provided")]
    ChainSpecNeitherGenesisStorageNorCheckpoint,
    /// Checkpoint provided in the chain specification is invalid.
    #[display("Invalid checkpoint in chain specification: {_0}")]
    InvalidCheckpoint(chain_spec::CheckpointToChainInformationError),
    /// Failed to build the information about the chain from the genesis storage. This indicates
    /// invalid data in the genesis storage.
    #[display("Failed to build genesis chain information: {_0}")]
    InvalidGenesisStorage(chain_spec::FromGenesisStorageError),
    /// The list of potential relay chains doesn't contain any relay chain with the name indicated
    /// in the chain specification of the parachain.
    #[display("Couldn't find relevant relay chain")]
    NoRelayChainFound,
    /// The list of potential relay chains contains more than one relay chain with the name
    /// indicated in the chain specification of the parachain.
    #[display("Multiple relevant relay chains found")]
    MultipleRelayChains,
}

enum StartServicesChainTy<'a, TPlat: platform::PlatformRef> {
    RelayChain {
        chain_information: &'a chain::chain_information::ValidChainInformation,
        startup_finalized_source: sync_service::StartupFinalizedSource,
    },
    Parachain {
        relay_chain: &'a ChainServices<TPlat>,
        finalized_block_header: Vec<u8>,
        para_id: u32,
    },
}

/// Starts all the services of the client.
///
/// Returns some of the services that have been started. If these service get shut down, all the
/// other services will later shut down as well.
fn start_services<TPlat: platform::PlatformRef>(
    log_name: String,
    platform: &TPlat,
    network_service: &mut Option<Arc<network_service::NetworkService<TPlat>>>,
    runtime_code_hint: Option<database::DatabaseContentRuntimeCodeHint>,
    genesis_block_scale_encoded_header: Vec<u8>,
    block_number_bytes: usize,
    fork_id: Option<String>,
    config: StartServicesChainTy<'_, TPlat>,
    network_identify_agent_version: String,
) -> ChainServices<TPlat> {
    let genesis_block_hash =
        header::hash_from_scale_encoded_header(&genesis_block_scale_encoded_header);
    let network_service = network_service.get_or_insert_with(|| {
        network_service::NetworkService::new(network_service::Config {
            platform: platform.clone(),
            identify_agent_version: network_identify_agent_version,
            connections_open_pool_size: 44,
            connections_open_pool_restore_delay: Duration::from_millis(100),
            chains_capacity: 1,
        })
    });

    let network_service_chain = network_service.add_chain(network_service::ConfigChain {
        log_name: log_name.clone(),
        num_out_slots: 8,
        grandpa_protocol_finalized_block_height: if let StartServicesChainTy::RelayChain {
            chain_information,
            ..
        } = &config
        {
            if matches!(
                chain_information.as_ref().finality,
                chain::chain_information::ChainInformationFinalityRef::Grandpa { .. }
            ) {
                Some(chain_information.as_ref().finalized_block_header.number)
            } else {
                None
            }
        } else {
            // Parachains never use GrandPa.
            None
        },
        genesis_block_hash,
        best_block: match &config {
            StartServicesChainTy::RelayChain {
                chain_information, ..
            } => (
                chain_information.as_ref().finalized_block_header.number,
                chain_information
                    .as_ref()
                    .finalized_block_header
                    .hash(block_number_bytes),
            ),
            StartServicesChainTy::Parachain {
                finalized_block_header,
                ..
            } => {
                if let Ok(decoded) = header::decode(finalized_block_header, block_number_bytes) {
                    (
                        decoded.number,
                        header::hash_from_scale_encoded_header(finalized_block_header),
                    )
                } else {
                    (0, genesis_block_hash)
                }
            }
        },
        fork_id,
        block_number_bytes,
    });

    let (sync_service, runtime_service) = match config {
        StartServicesChainTy::Parachain {
            relay_chain,
            finalized_block_header,
            para_id,
            ..
        } => {
            // Chain is a parachain.

            // The sync service is leveraging the network service, downloads block headers,
            // and verifies them, to determine what are the best and finalized blocks of the
            // chain.
            let sync_service = Arc::new(sync_service::SyncService::new(sync_service::Config {
                platform: platform.clone(),
                log_name: log_name.clone(),
                block_number_bytes,
                network_service: network_service_chain.clone(),
                chain_type: sync_service::ConfigChainType::Parachain(
                    sync_service::ConfigParachain {
                        finalized_block_header,
                        para_id,
                        relay_chain_sync: relay_chain.runtime_service.clone(),
                    },
                ),
            }));

            // The runtime service follows the runtime of the best block of the chain,
            // and allows performing runtime calls.
            let runtime_service = Arc::new(runtime_service::RuntimeService::new(
                runtime_service::Config {
                    log_name: log_name.clone(),
                    platform: platform.clone(),
                    sync_service: sync_service.clone(),
                    network_service: network_service_chain.clone(),
                    genesis_block_scale_encoded_header,
                },
            ));

            (sync_service, runtime_service)
        }
        StartServicesChainTy::RelayChain {
            chain_information,
            startup_finalized_source,
        } => {
            // Chain is a relay chain.

            // The sync service is leveraging the network service, downloads block headers,
            // and verifies them, to determine what are the best and finalized blocks of the
            // chain.
            let sync_service = Arc::new(sync_service::SyncService::new(sync_service::Config {
                log_name: log_name.clone(),
                block_number_bytes,
                platform: platform.clone(),
                network_service: network_service_chain.clone(),
                chain_type: sync_service::ConfigChainType::RelayChain(
                    sync_service::ConfigRelayChain {
                        chain_information: chain_information.clone(),
                        startup_finalized_source,
                        runtime_code_hint: runtime_code_hint.map(|hint| {
                            sync_service::ConfigRelayChainRuntimeCodeHint {
                                storage_value: hint.code,
                                merkle_value: hint.code_merkle_value,
                                closest_ancestor_excluding: hint.closest_ancestor_excluding,
                            }
                        }),
                    },
                ),
            }));

            // The runtime service follows the runtime of the best block of the chain,
            // and allows performing runtime calls.
            let runtime_service = Arc::new(runtime_service::RuntimeService::new(
                runtime_service::Config {
                    log_name: log_name.clone(),
                    platform: platform.clone(),
                    sync_service: sync_service.clone(),
                    network_service: network_service_chain.clone(),
                    genesis_block_scale_encoded_header,
                },
            ));

            (sync_service, runtime_service)
        }
    };

    let recent_block_cache = Arc::new(async_lock::Mutex::new(RecentBlockCache::new(
        RECENT_BLOCK_CACHE_CAPACITY,
    )));
    let finalized_ancestry_cache =
        Arc::new(async_lock::Mutex::new(FinalizedAncestryAnchorCache::new()));
    spawn_recent_block_cache_task(
        platform,
        log_name.clone(),
        sync_service.clone(),
        recent_block_cache.clone(),
    );

    // The transactions service lets one send transactions to the peer-to-peer network and watch
    // them being included in the chain.
    // While this service is in principle not needed if it is known ahead of time that no
    // transaction will be submitted, the service itself is pretty low cost.
    let transactions_service = Arc::new(transactions_service::TransactionsService::new(
        transactions_service::Config {
            log_name,
            platform: platform.clone(),
            sync_service: sync_service.clone(),
            runtime_service: runtime_service.clone(),
            network_service: network_service_chain.clone(),
            max_pending_transactions: NonZero::<u32>::new(64).unwrap(),
            max_concurrent_downloads: NonZero::<u32>::new(3).unwrap(),
            max_concurrent_validations: NonZero::<u32>::new(2).unwrap(),
        },
    ));

    ChainServices {
        genesis_block_hash,
        network_service: network_service_chain,
        runtime_service,
        sync_service,
        transactions_service,
        recent_block_cache,
        finalized_ancestry_cache,
    }
}

fn spawn_recent_block_cache_task<TPlat: platform::PlatformRef>(
    platform: &TPlat,
    log_name: String,
    sync_service: Arc<sync_service::SyncService<TPlat>>,
    recent_block_cache: Arc<async_lock::Mutex<RecentBlockCache>>,
) {
    let task_name = format!("recent-block-cache-{log_name}");
    let block_number_bytes = sync_service.block_number_bytes();

    platform.spawn_task(task_name.into(), async move {
        loop {
            let subscribe_all = sync_service
                .subscribe_all(RECENT_BLOCK_CACHE_SUBSCRIPTION_BUFFER, false)
                .await;

            let reset_succeeded = {
                let mut cache = recent_block_cache.lock().await;
                if cache
                    .reset_from_subscription(&subscribe_all, block_number_bytes)
                    .is_ok()
                {
                    true
                } else {
                    // finality 回退、同高度冲突或畸形 header 都使旧视图失去可组合性。
                    // 清空后重新订阅，期间历史查询只会返回 `None`，不会把旧分支提升。
                    cache.invalidate();
                    false
                }
            };
            if !reset_succeeded {
                continue;
            }

            let new_blocks = subscribe_all.new_blocks;
            while let Ok(notification) = new_blocks.recv().await {
                let mut cache = recent_block_cache.lock().await;
                let _ = cache.apply_notification(notification, block_number_bytes);
            }
        }
    });
}
