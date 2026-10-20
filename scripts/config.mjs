// 本产品配置需求的公开入口；只登记名称、类型和规则，不保存配置值。
export const manifest=Object.freeze({
  "schema": 1,
  "product_id": "citizensdk",
  "configuration": {
    "id": "citizensdk",
    "kind": "sdk",
    "title": "公民SDK配置",
    "items": []
  }
});
export function describeConfiguration(){return JSON.parse(JSON.stringify(manifest));}

// SDK是唯一公开平台；其它名称仅为包内真实宿主编译目标。
import {readFileSync} from 'node:fs';
export const repository='crcfrcn/citizensdk';
export const tools=Object.freeze({node:'25.2.1',rust:'1.97.1',flutter:'3.47.2',ndk:'28.2.13676358',gradle:'9.1.0',cmake:'3.31.6'});
export function sdkName(version){if(typeof version!=='string'||version.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version))throw Error('SDK版本无效');return '公民SDK·SDK·v'+version;}
export function nextVersion(runs){const latest=[...runs].filter(run=>run.status==='completed'&&run.conclusion==='success').sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at)||b.id-a.id)[0];if(!latest){const version=/^version: (\S+)$/mu.exec(readFileSync(new URL('../pubspec.yaml',import.meta.url),'utf8'))?.[1];sdkName(version);return version;}const prefix='公民SDK·SDK·v',version=latest.display_title?.startsWith(prefix)?latest.display_title.slice(prefix.length):'';sdkName(version);const parts=version.split('.');parts[2]=String(BigInt(parts[2])+1n);const next=parts.join('.');sdkName(next);return next;}
export function retainedRuns(rows){const keep=new Set(),states=new Set();for(const run of [...rows].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at)||b.id-a.id)){if(run.status!=='completed'){keep.add(run.id);continue;}const state=run.conclusion==='success'?'success':'failed';if(!states.has(state)){states.add(state);keep.add(run.id);}}return keep;}

// 原仓平面存储到Cargo要求路径的唯一映射；文件内容及原锁保持不变。
export const nativePaths=Object.freeze({
 "native/smoldot/lib/src/chain/chain_information_build.rs": "native/smoldot/lib/src/chain/chain_information/build.rs",
 "native/smoldot/lib/src/database/finalized_serialize_defs.rs": "native/smoldot/lib/src/database/finalized_serialize/defs.rs",
 "native/smoldot/lib/src/executor/trie_root_calculator_tests.rs": "native/smoldot/lib/src/executor/trie_root_calculator/tests.rs",
 "native/smoldot/lib/src/identity_ss58.rs": "native/smoldot/lib/src/identity/ss58.rs",
 "native/smoldot/lib/src/libp2p/connection/single_stream_handshake_tests.rs": "native/smoldot/lib/src/libp2p/connection/single_stream_handshake/tests.rs",
 "native/smoldot/lib/src/network/kademlia_kbuckets.rs": "native/smoldot/lib/src/network/kademlia/kbuckets.rs",
 "native/smoldot/lib/src/transactions/light_pool_tests.rs": "native/smoldot/lib/src/transactions/light_pool/tests.rs",
 "native/smoldot/lib/src/transactions/pool_tests.rs": "native/smoldot/lib/src/transactions/pool/tests.rs",
 "native/smoldot/lib/src/trie/branch_search_tests.rs": "native/smoldot/lib/src/trie/branch_search/tests.rs",
 "native/smoldot/lib/src/trie/trie_structure_tests.rs": "native/smoldot/lib/src/trie/trie_structure/tests.rs",
 "native/smoldot/light-base/src/json_rpc_service_background.rs": "native/smoldot/light-base/src/json_rpc_service/background.rs",
 "native/smoldot/light-base/src/network_service_tasks.rs": "native/smoldot/light-base/src/network_service/tasks.rs",
 "native/engine/source/transaction_outcome.rs": "native/engine/src/transaction_outcome.rs",
 "native/engine/source/wallet_input_tests.rs": "native/engine/src/wallet_input_tests.rs",
 "native/engine/source/wallet_service_tests.rs": "native/engine/src/wallet_service_tests.rs",
 "native/engine/source/runtime_context.rs": "native/engine/src/runtime_context.rs",
 "native/engine/source/error.rs": "native/engine/src/error.rs",
 "native/engine/source/finalized_history_runtime.rs": "native/engine/src/finalized_history_runtime.rs",
 "native/engine/source/wallet_input.rs": "native/engine/src/wallet_input.rs",
 "native/engine/source/metadata.rs": "native/engine/src/metadata.rs",
 "native/engine/source/chain_monitor.rs": "native/engine/src/chain_monitor.rs",
 "native/engine/source/lib.rs": "native/engine/src/lib.rs",
 "native/engine/source/account_state.rs": "native/engine/src/account_state.rs",
 "native/engine/source/wallet_service.rs": "native/engine/src/wallet_service.rs",
 "native/engine/source/transaction_execution.rs": "native/engine/src/transaction_execution.rs",
 "native/engine/source/transaction_prepare.rs": "native/engine/src/transaction_prepare.rs",
 "native/engine/source/qr_review.rs": "native/engine/src/qr_review.rs",
 "native/engine/source/wallet_derivation.rs": "native/engine/src/wallet_derivation.rs",
 "native/engine/source/transaction_history.rs": "native/engine/src/transaction_history.rs",
 "native/engine/source/system_events.rs": "native/engine/src/system_events.rs",
 "native/engine/source/wallet_derivation_tests.rs": "native/engine/src/wallet_derivation_tests.rs",
 "native/engine/source/qr_review_tests.rs": "native/engine/src/qr_review_tests.rs",
 "native/engine/source/capabilities.rs": "native/engine/src/capabilities.rs",
 "native/engine/source/engine.rs": "native/engine/src/engine.rs",
 "native/engine/source/state_import.rs": "native/engine/src/state_import.rs",
 "native/ffi/source/host_codec_tests.rs": "native/ffi/src/host_codec_tests.rs",
 "native/ffi/source/qr_abi.rs": "native/ffi/src/qr_abi.rs",
 "native/ffi/source/runtime.rs": "native/ffi/src/runtime.rs",
 "native/ffi/source/chain_monitor_tests.rs": "native/ffi/src/chain_monitor_tests.rs",
 "native/ffi/source/transaction_abi.rs": "native/ffi/src/transaction_abi.rs",
 "native/ffi/source/events.rs": "native/ffi/src/events.rs",
 "native/ffi/source/host_codec.rs": "native/ffi/src/host_codec.rs",
 "native/ffi/source/error.rs": "native/ffi/src/error.rs",
 "native/ffi/source/wallet_abi_tests.rs": "native/ffi/src/wallet_abi_tests.rs",
 "native/ffi/source/chain_monitor.rs": "native/ffi/src/chain_monitor.rs",
 "native/ffi/source/wallet_abi.rs": "native/ffi/src/wallet_abi.rs",
 "native/ffi/source/lib.rs": "native/ffi/src/lib.rs",
 "native/ffi/source/host_providers.rs": "native/ffi/src/host_providers.rs",
 "native/ffi/source/ownership.rs": "native/ffi/src/ownership.rs",
 "native/ffi/source/handles.rs": "native/ffi/src/handles.rs",
 "native/ffi/source/composition_tests.rs": "native/ffi/src/composition_tests.rs",
 "native/ffi/source/composition.rs": "native/ffi/src/composition.rs",
 "native/ffi/source/requests.rs": "native/ffi/src/requests.rs",
 "native/ffi/source/assets.rs": "native/ffi/src/assets.rs",
 "native/ffi/source/abi.rs": "native/ffi/src/abi.rs",
 "native/ffi/source/capabilities.rs": "native/ffi/src/capabilities.rs",
 "native/qr/source/session.rs": "native/qr/src/session.rs",
 "native/qr/source/lib.rs": "native/qr/src/lib.rs",
 "native/qr/source/codec.rs": "native/qr/src/codec.rs",
 "native/contracts/source/transaction.rs": "native/contracts/src/transaction.rs",
 "native/contracts/source/chain.rs": "native/contracts/src/chain.rs",
 "native/contracts/source/error.rs": "native/contracts/src/error.rs",
 "native/contracts/source/lib.rs": "native/contracts/src/lib.rs",
 "native/contracts/source/signing.rs": "native/contracts/src/signing.rs",
 "native/contracts/source/wallet.rs": "native/contracts/src/wallet.rs",
 "native/contracts/source/account.rs": "native/contracts/src/account.rs",
 "native/contracts/source/transaction_prepare.rs": "native/contracts/src/transaction_prepare.rs",
 "native/contracts/source/chain_signer.rs": "native/contracts/src/chain_signer.rs",
 "native/contracts/source/secret_vault.rs": "native/contracts/src/secret_vault.rs",
 "native/contracts/source/transaction_build.rs": "native/contracts/src/transaction_build.rs",
 "native/contracts/source/capability.rs": "native/contracts/src/capability.rs",
 "native/contracts/source/store_wallet_profile.rs": "native/contracts/src/store/wallet_profile.rs",
 "native/contracts/source/store_encrypted_secret_blob.rs": "native/contracts/src/store/encrypted_secret_blob.rs",
 "native/contracts/source/store_chain_database.rs": "native/contracts/src/store/chain_database.rs",
 "native/contracts/source/store.rs": "native/contracts/src/store/mod.rs",
 "native/contracts/source/store_runtime_cache.rs": "native/contracts/src/store/runtime_cache.rs",
 "native/contracts/source/store_transaction_history.rs": "native/contracts/src/store/transaction_history.rs",
 "native/provider/source/client.rs": "native/provider/src/client.rs",
 "native/provider/source/legacy.rs": "native/provider/src/legacy.rs",
 "native/provider/source/account_nonce.rs": "native/provider/src/account_nonce.rs",
 "native/provider/source/lib.rs": "native/provider/src/lib.rs",
 "native/provider/source/bootstrap.rs": "native/provider/src/bootstrap.rs",
 "native/provider/source/bootstrap_tests.rs": "native/provider/src/bootstrap_tests.rs",
 "native/provider/source/verified_chain_client.rs": "native/provider/src/verified_chain_client.rs",
 "native/provider/tests/source_manifest_contract.rs": "native/smoldot/light-base/tests/source_manifest_contract.rs",
 "native/provider/tests/capability_boundary.rs": "native/smoldot/light-base/tests/capability_boundary.rs",
 "native/provider/tests/light_client_boundary.rs": "native/smoldot/lib/tests/light_client_boundary.rs",
 "native/provider/tests/network_sync_source_manifest.rs": "native/smoldot/lib/tests/network_sync_source_manifest.rs",
 "native/provider/tests/state_runtime_source_manifest.rs": "native/smoldot/lib/tests/state_runtime_source_manifest.rs",
 "native/provider/tests/consensus_source_manifest.rs": "native/smoldot/lib/tests/consensus_source_manifest.rs",
 "native/provider/tests/network_sync_boundary.rs": "native/smoldot/lib/tests/network_sync_boundary.rs",
 "native/provider/tests/state_runtime_boundary.rs": "native/smoldot/lib/tests/state_runtime_boundary.rs",
 "native/signer/source/sr25519.rs": "native/signer/src/sr25519.rs",
 "native/signer/source/lib.rs": "native/signer/src/lib.rs",
 "native/signer/source/chain_signer.rs": "native/signer/src/chain_signer.rs"
});

// C/C++宿主依赖沿用原来源版本，由工作流使用官方构建命令准备。
export const nativeSources=Object.freeze({
"sqlite":{"version": "3.53.4", "url": "https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip", "archive_root": "sqlite-amalgamation-3530400"},
"openssl":{"version": "3.5.8", "url": "https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz", "archive_root": "openssl-3.5.8"},
"tpm2-tss":{"version": "4.2.0", "url": "https://github.com/tpm2-software/tpm2-tss/releases/download/4.2.0/tpm2-tss-4.2.0.tar.gz", "archive_root": "tpm2-tss-4.2.0"},
"zxing":{"version": "3.1.1", "url": "https://github.com/zxing-cpp/zxing-cpp/releases/download/v3.1.1/zxing-cpp-3.1.1.tar.gz", "archive_root": "zxing-cpp-3.1.1"}
});
