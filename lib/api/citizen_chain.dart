import 'dart:typed_data';

import '../models/citizen_capability.dart';
import '../models/citizen_chain_state.dart';

/// 经过 CitizenSDK Core 验证的类型化公民链读取接口。
///
/// 这里没有任意 RPC 入口，应用不能绕过 finalized/runtime 安全语义。
abstract interface class CitizenChain {
  Future<CitizenCapabilitySnapshot> getCapabilities();

  /// 返回 Core 固定链身份的创世哈希；chain 必须启用，但无需启动或同步。
  Future<String> getGenesisHash();

  Future<CitizenBlockRef> getFinalizedHead();

  Future<CitizenChainSyncStatus> getSyncStatus();

  Future<CitizenBlockRef> getBestHead();

  Future<CitizenBlockRef> getFinalizedBlockAt(BigInt number);

  Future<CitizenBlockRef> resolveFinalizedBlock(String hash, BigInt number);

  Future<CitizenBlockHeader> getBlockHeader(CitizenBlockRef block);

  Future<CitizenBlockBody> getBlockBody(CitizenBlockRef block);

  Future<CitizenRuntimeContext> getRuntimeContext(CitizenBlockRef block);

  Future<Uint8List?> getStorage(CitizenBlockRef block, Uint8List key);

  Future<List<Uint8List?>> getStorageBatch(
    CitizenBlockRef block,
    List<Uint8List> keys,
  );

  /// 返回一个准确 finalized 块上的有界 opaque storage key 页面。
  Future<List<Uint8List>> getStorageKeysPaged(
    CitizenBlockRef finalizedBlock,
    Uint8List prefix, {
    Uint8List? startKey,
    int limit = 1000,
  });

  /// 在一个准确 verified block 上执行 opaque Runtime API。
  Future<Uint8List> callRuntimeApi(
    CitizenBlockRef block,
    String method,
    Uint8List arguments,
  );

  Future<Uint8List?> getSystemEvents(CitizenBlockRef finalizedBlock);

  Future<CitizenChainState> exportState();

  Future<void> importState(CitizenChainState state);

  Future<CitizenAccountBalance> getAccountBalance(String accountId);

  /// 从同一已验证 finalized 块读取 0..1990 个账户，保持顺序与重复项。
  /// 空输入仍经过 Core 的模块/生命周期校验，不触发账户存储读取。
  Future<List<CitizenAccountBalance>> getAccountBalances(
    List<String> accountIds,
  );

  Future<CitizenAccountNonce> getAccountNonce(String accountId);

  Future<CitizenFeeSnapshot> getFeeSnapshot();
}
