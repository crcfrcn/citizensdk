import 'dart:typed_data';

/// CitizenSDK 实例的稳定生命周期。
enum CitizenSdkLifecycle {
  created,
  importingState,
  starting,
  running,
  startFailed,
  stopped,
  disposed,
}

enum CitizenBlockFinality { best, finalized }

/// 已由 Core 验证的块引用。
final class CitizenBlockRef {
  const CitizenBlockRef({
    required this.hash,
    required this.number,
    required this.finality,
  });

  final String hash;
  final BigInt number;
  final CitizenBlockFinality finality;
}

/// 同一个轻节点快照中的同步、可用性和链头事实。
final class CitizenChainSyncStatus {
  const CitizenChainSyncStatus({
    required this.peerCount,
    required this.isSyncing,
    required this.isUsable,
    required this.best,
    required this.finalized,
  });

  final BigInt peerCount;
  final bool isSyncing;
  final bool isUsable;
  final CitizenBlockRef best;
  final CitizenBlockRef finalized;
}

/// 一个准确块的已验证 Header；digest 是完整 SCALE Digest，不承载应用业务语义。
final class CitizenBlockHeader {
  CitizenBlockHeader({
    required this.block,
    required this.parentHash,
    required this.stateRoot,
    required this.extrinsicsRoot,
    required Uint8List digest,
  }) : digest = Uint8List.fromList(digest).asUnmodifiableView();

  final CitizenBlockRef block;
  final String parentHash;
  final String stateRoot;
  final String extrinsicsRoot;
  final Uint8List digest;
}

/// 一个准确块中保持顺序的 opaque SCALE extrinsic 字节。
final class CitizenBlockBody {
  CitizenBlockBody({required this.block, required List<Uint8List> extrinsics})
    : extrinsics = List<Uint8List>.unmodifiable(
        extrinsics.map(
          (value) => Uint8List.fromList(value).asUnmodifiableView(),
        ),
      );

  final CitizenBlockRef block;
  final List<Uint8List> extrinsics;
}

/// 同一准确块上的 Runtime 版本与完整 SCALE metadata。
final class CitizenRuntimeContext {
  CitizenRuntimeContext({
    required this.block,
    required this.specVersion,
    required this.transactionVersion,
    required Uint8List metadata,
  }) : metadata = Uint8List.fromList(metadata).asUnmodifiableView();

  final CitizenBlockRef block;
  final int specVersion;
  final int transactionVersion;
  final Uint8List metadata;
}

/// 可显式导入/导出的 smoldot finalized database；不是旧 App 钱包迁移格式。
final class CitizenChainState {
  CitizenChainState({
    required this.formatVersion,
    required this.finalized,
    required Uint8List database,
  }) : database = Uint8List.fromList(database).asUnmodifiableView();

  final int formatVersion;
  final CitizenBlockRef finalized;
  final Uint8List database;
}

/// finalized 块上的账户余额，单位均为整数分。
final class CitizenAccountBalance {
  const CitizenAccountBalance({
    required this.accountId,
    required this.block,
    required this.freeFen,
    required this.reservedFen,
    required this.totalFen,
  });

  final String accountId;
  final CitizenBlockRef block;
  final BigInt freeFen;
  final BigInt reservedFen;
  final BigInt totalFen;
}

/// best 块 Runtime 的精确账户 nonce；它不是交易池 nonce 租约。
final class CitizenAccountNonce {
  const CitizenAccountNonce({
    required this.accountId,
    required this.bestBlock,
    required this.nonce,
  });

  final String accountId;
  final CitizenBlockRef bestBlock;
  final BigInt nonce;
}

/// 同一 best 块读取的链上费率、最低费用和存续金额。
final class CitizenFeeSnapshot {
  const CitizenFeeSnapshot({
    required this.bestBlock,
    required this.feeRateParts,
    required this.minimumFeeFen,
    required this.existentialDepositFen,
  });

  final CitizenBlockRef bestBlock;
  final int feeRateParts;
  final BigInt minimumFeeFen;
  final BigInt existentialDepositFen;
}
