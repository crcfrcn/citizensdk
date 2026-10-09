import 'package:meta/meta.dart';

/// Configuration options for initializing the smoldot client
@immutable
class SmoldotConfig {
  /// Maximum log level to output (0=off, 1=error, 2=warn, 3=info, 4=debug, 5=trace)
  final int maxLogLevel;

  const SmoldotConfig({this.maxLogLevel = 3});

  Map<String, dynamic> toJson() => {'maxLogLevel': maxLogLevel};
}

/// Configuration for adding a chain to the smoldot client
@immutable
class AddChainConfig {
  /// Chain specification in JSON format
  final String chainSpec;

  /// Optional database content to restore chain state
  final String? databaseContent;

  /// Potential relay chains this chain can connect to (chain handles)
  final List<int>? potentialRelayChains;

  /// Disable JSON-RPC for this chain
  final bool disableJsonRpc;

  const AddChainConfig({
    required this.chainSpec,
    this.databaseContent,
    this.potentialRelayChains,
    this.disableJsonRpc = false,
  });

  Map<String, dynamic> toJson() => {
    'chainSpec': chainSpec,
    if (databaseContent != null) 'databaseContent': databaseContent,
    if (potentialRelayChains != null && potentialRelayChains!.isNotEmpty)
      'potentialRelayChains': potentialRelayChains,
    'disableJsonRpc': disableJsonRpc,
  };
}

/// Result of a JSON-RPC request
@immutable
class JsonRpcResponse {
  /// Request ID
  final String id;

  /// Result value if successful
  final dynamic result;

  /// Error information if failed
  final JsonRpcError? error;

  const JsonRpcResponse({required this.id, this.result, this.error});

  bool get isError => error != null;
  bool get isSuccess => error == null;

  factory JsonRpcResponse.fromJson(Map<String, dynamic> json) {
    return JsonRpcResponse(
      id: json['id']?.toString() ?? '',
      result: json['result'],
      error: json['error'] != null
          ? JsonRpcError.fromJson(json['error'] as Map<String, dynamic>)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    if (result != null) 'result': result,
    if (error != null) 'error': error!.toJson(),
  };
}

/// JSON-RPC error information
@immutable
class JsonRpcError {
  /// Error code
  final int code;

  /// Error message
  final String message;

  /// Additional error data
  final dynamic data;

  const JsonRpcError({required this.code, required this.message, this.data});

  factory JsonRpcError.fromJson(Map<String, dynamic> json) {
    return JsonRpcError(
      code: json['code'] as int? ?? 0,
      message: json['message'] as String? ?? '',
      data: json['data'],
    );
  }

  Map<String, dynamic> toJson() => {
    'code': code,
    'message': message,
    if (data != null) 'data': data,
  };

  @override
  String toString() => 'JsonRpcError(code: $code, message: $message)';
}

/// Chain status information
enum ChainStatus {
  /// Chain is syncing
  syncing,

  /// Chain is synced
  synced,

  /// Chain has encountered an error
  error,
}

/// Chain information
@immutable
class ChainInfo {
  /// Chain ID (handle from Rust)
  final int chainId;

  /// Chain name
  final String name;

  /// Chain status
  final ChainStatus status;

  /// Number of peers connected
  final int peerCount;

  /// Current best block number
  final int? bestBlockNumber;

  /// Current best block hash
  final String? bestBlockHash;

  const ChainInfo({
    required this.chainId,
    required this.name,
    required this.status,
    this.peerCount = 0,
    this.bestBlockNumber,
    this.bestBlockHash,
  });

  Map<String, dynamic> toJson() => {
    'chainId': chainId,
    'name': name,
    'status': status.name,
    'peerCount': peerCount,
    if (bestBlockNumber != null) 'bestBlockNumber': bestBlockNumber,
    if (bestBlockHash != null) 'bestBlockHash': bestBlockHash,
  };
}

/// 轻节点同步状态机真实阶段。
enum LightClientSyncPhase {
  regular('regular'),
  warpDownloadingFragments('warpDownloadingFragments'),
  warpVerifyingFragments('warpVerifyingFragments'),
  warpDownloadingTargetState('warpDownloadingTargetState'),
  warpBuildingRuntime('warpBuildingRuntime'),
  warpBuildingChainInformation('warpBuildingChainInformation');

  const LightClientSyncPhase(this.wireValue);

  final String wireValue;

  static LightClientSyncPhase fromWireValue(Object? value) {
    return switch (value) {
      'regular' => LightClientSyncPhase.regular,
      'warpDownloadingFragments' =>
        LightClientSyncPhase.warpDownloadingFragments,
      'warpVerifyingFragments' => LightClientSyncPhase.warpVerifyingFragments,
      'warpDownloadingTargetState' =>
        LightClientSyncPhase.warpDownloadingTargetState,
      'warpBuildingRuntime' => LightClientSyncPhase.warpBuildingRuntime,
      'warpBuildingChainInformation' =>
        LightClientSyncPhase.warpBuildingChainInformation,
      _ => throw FormatException('未知轻节点同步阶段: $value'),
    };
  }
}

/// 本次同步状态机采用的可信 finalized 起点来源。
enum LightClientStartupFinalizedSource {
  bundledCheckpoint('bundledCheckpoint'),
  localDatabase('localDatabase');

  const LightClientStartupFinalizedSource(this.wireValue);

  final String wireValue;

  static LightClientStartupFinalizedSource? fromWireValue(Object? value) {
    return switch (value) {
      null => null,
      'bundledCheckpoint' =>
        LightClientStartupFinalizedSource.bundledCheckpoint,
      'localDatabase' => LightClientStartupFinalizedSource.localDatabase,
      _ => throw FormatException('未知轻节点启动锚点来源: $value'),
    };
  }
}

/// warp 最近一次稳定失败分类；仅用于诊断，不参与链真相判断。
enum LightClientWarpFailure {
  emptyProof('emptyProof'),
  invalidHeader('invalidHeader'),
  invalidJustification('invalidJustification'),
  blockNumberNotIncrementing('blockNumberNotIncrementing'),
  targetHashMismatch('targetHashMismatch'),
  justificationVerifyFailed('justificationVerifyFailed'),
  nonMinimalProof('nonMinimalProof'),
  warpRequestFailed('warpRequestFailed'),
  storageProofRequestFailed('storageProofRequestFailed'),
  callProofRequestFailed('callProofRequestFailed'),
  runtimeBuildFailed('runtimeBuildFailed'),
  chainInformationBuildFailed('chainInformationBuildFailed');

  const LightClientWarpFailure(this.wireValue);

  final String wireValue;

  static LightClientWarpFailure? fromWireValue(Object? value) {
    if (value == null) return null;
    return LightClientWarpFailure.values.firstWhere(
      (failure) => failure.wireValue == value,
      orElse: () => throw FormatException('未知 warp 失败类型: $value'),
    );
  }
}

/// 中文注释：轻节点状态快照，字段直接来自 Rust 同步状态机。
@immutable
class LightClientStatusSnapshot {
  final int peerCount;
  final bool isSyncing;

  /// 该值由 Rust 根据 peer、runtime 与原生同步阶段统一计算，Dart 不得重新推导。
  final bool isUsable;
  final LightClientSyncPhase syncPhase;
  final int? bestBlockNumber;
  final String? bestBlockHash;
  final int? finalizedBlockNumber;
  final String? finalizedBlockHash;
  final LightClientStartupFinalizedSource? startupFinalizedSource;
  final int? startupFinalizedBlockNumber;
  final String? startupFinalizedBlockHash;
  final int? highestPeerFinalizedBlockNumber;
  final int currentVerifiedFinalizedBlockNumber;
  final String currentVerifiedFinalizedBlockHash;
  final int? warpTargetFinalizedBlockNumber;
  final String? warpTargetFinalizedBlockHash;
  final int warpRequestCount;
  final int activeWarpFragmentRequestCount;
  final int activeWarpStorageRequestCount;
  final int activeWarpCallProofRequestCount;
  final int warpReceivedFragmentCount;
  final int warpVerifiedFragmentCount;
  final int warpRejectedFragmentCount;
  final LightClientWarpFailure? warpLastFailure;

  const LightClientStatusSnapshot({
    required this.peerCount,
    required this.isSyncing,
    required this.isUsable,
    required this.syncPhase,
    required this.currentVerifiedFinalizedBlockNumber,
    required this.currentVerifiedFinalizedBlockHash,
    required this.warpRequestCount,
    required this.activeWarpFragmentRequestCount,
    required this.activeWarpStorageRequestCount,
    required this.activeWarpCallProofRequestCount,
    required this.warpReceivedFragmentCount,
    required this.warpVerifiedFragmentCount,
    required this.warpRejectedFragmentCount,
    this.bestBlockNumber,
    this.bestBlockHash,
    this.finalizedBlockNumber,
    this.finalizedBlockHash,
    this.startupFinalizedSource,
    this.startupFinalizedBlockNumber,
    this.startupFinalizedBlockHash,
    this.highestPeerFinalizedBlockNumber,
    this.warpTargetFinalizedBlockNumber,
    this.warpTargetFinalizedBlockHash,
    this.warpLastFailure,
  });

  bool get hasPeers => peerCount > 0;

  bool get isWarping => syncPhase != LightClientSyncPhase.regular;

  /// 业务统一使用的链状态；warp 阶段即使 runtime 已近头也仍属于 syncing。
  ChainStatus get chainStatus =>
      isUsable ? ChainStatus.synced : ChainStatus.syncing;

  Map<String, dynamic> toJson() => {
    'peerCount': peerCount,
    'isSyncing': isSyncing,
    'isUsable': isUsable,
    'syncPhase': syncPhase.wireValue,
    if (bestBlockNumber != null) 'bestBlockNumber': bestBlockNumber,
    if (bestBlockHash != null) 'bestBlockHash': bestBlockHash,
    if (finalizedBlockNumber != null)
      'finalizedBlockNumber': finalizedBlockNumber,
    if (finalizedBlockHash != null) 'finalizedBlockHash': finalizedBlockHash,
    if (startupFinalizedSource != null)
      'startupFinalizedSource': startupFinalizedSource!.wireValue,
    if (startupFinalizedBlockNumber != null)
      'startupFinalizedBlockNumber': startupFinalizedBlockNumber,
    if (startupFinalizedBlockHash != null)
      'startupFinalizedBlockHash': startupFinalizedBlockHash,
    if (highestPeerFinalizedBlockNumber != null)
      'highestPeerFinalizedBlockNumber': highestPeerFinalizedBlockNumber,
    'currentVerifiedFinalizedBlockNumber': currentVerifiedFinalizedBlockNumber,
    'currentVerifiedFinalizedBlockHash': currentVerifiedFinalizedBlockHash,
    if (warpTargetFinalizedBlockNumber != null)
      'warpTargetFinalizedBlockNumber': warpTargetFinalizedBlockNumber,
    if (warpTargetFinalizedBlockHash != null)
      'warpTargetFinalizedBlockHash': warpTargetFinalizedBlockHash,
    'warpRequestCount': warpRequestCount,
    'activeWarpFragmentRequestCount': activeWarpFragmentRequestCount,
    'activeWarpStorageRequestCount': activeWarpStorageRequestCount,
    'activeWarpCallProofRequestCount': activeWarpCallProofRequestCount,
    'warpReceivedFragmentCount': warpReceivedFragmentCount,
    'warpVerifiedFragmentCount': warpVerifiedFragmentCount,
    'warpRejectedFragmentCount': warpRejectedFragmentCount,
    if (warpLastFailure != null) 'warpLastFailure': warpLastFailure!.wireValue,
  };

  factory LightClientStatusSnapshot.fromJson(Map<String, dynamic> json) {
    final snapshot = LightClientStatusSnapshot(
      peerCount: json['peerCount'] as int,
      isSyncing: json['isSyncing'] as bool,
      isUsable: json['isUsable'] as bool,
      syncPhase: LightClientSyncPhase.fromWireValue(json['syncPhase']),
      bestBlockNumber: json['bestBlockNumber'] as int?,
      bestBlockHash: json['bestBlockHash'] as String?,
      finalizedBlockNumber: json['finalizedBlockNumber'] as int?,
      finalizedBlockHash: json['finalizedBlockHash'] as String?,
      startupFinalizedSource: LightClientStartupFinalizedSource.fromWireValue(
        json['startupFinalizedSource'],
      ),
      startupFinalizedBlockNumber: json['startupFinalizedBlockNumber'] as int?,
      startupFinalizedBlockHash: json['startupFinalizedBlockHash'] as String?,
      highestPeerFinalizedBlockNumber:
          json['highestPeerFinalizedBlockNumber'] as int?,
      currentVerifiedFinalizedBlockNumber:
          json['currentVerifiedFinalizedBlockNumber'] as int,
      currentVerifiedFinalizedBlockHash:
          json['currentVerifiedFinalizedBlockHash'] as String,
      warpTargetFinalizedBlockNumber:
          json['warpTargetFinalizedBlockNumber'] as int?,
      warpTargetFinalizedBlockHash:
          json['warpTargetFinalizedBlockHash'] as String?,
      warpRequestCount: json['warpRequestCount'] as int,
      activeWarpFragmentRequestCount:
          json['activeWarpFragmentRequestCount'] as int,
      activeWarpStorageRequestCount:
          json['activeWarpStorageRequestCount'] as int,
      activeWarpCallProofRequestCount:
          json['activeWarpCallProofRequestCount'] as int,
      warpReceivedFragmentCount: json['warpReceivedFragmentCount'] as int,
      warpVerifiedFragmentCount: json['warpVerifiedFragmentCount'] as int,
      warpRejectedFragmentCount: json['warpRejectedFragmentCount'] as int,
      warpLastFailure: LightClientWarpFailure.fromWireValue(
        json['warpLastFailure'],
      ),
    );
    final expectedUsable =
        snapshot.hasPeers &&
        !snapshot.isSyncing &&
        snapshot.syncPhase == LightClientSyncPhase.regular;
    if (snapshot.isUsable != expectedUsable) {
      throw FormatException(
        '原生轻节点可用性与同步阶段冲突: '
        'usable=${snapshot.isUsable}, phase=${snapshot.syncPhase.wireValue}',
      );
    }
    if (snapshot.currentVerifiedFinalizedBlockNumber < 0 ||
        snapshot.currentVerifiedFinalizedBlockHash.isEmpty ||
        snapshot.warpRequestCount < 0 ||
        snapshot.activeWarpFragmentRequestCount < 0 ||
        snapshot.activeWarpStorageRequestCount < 0 ||
        snapshot.activeWarpCallProofRequestCount < 0) {
      throw const FormatException('轻节点状态快照包含非法负数或空 verified finalized hash');
    }
    if (snapshot.isWarping) {
      if (snapshot.warpTargetFinalizedBlockNumber == null) {
        throw const FormatException('warp 阶段缺少目标 finalized 高度');
      }
    } else if (snapshot.warpTargetFinalizedBlockNumber != null ||
        snapshot.warpTargetFinalizedBlockHash != null) {
      throw const FormatException('regular 阶段不得残留 warp 目标');
    }
    return snapshot;
  }
}

/// 中文注释：`System.Account` 的原生读取结果，后续钱包余额迁移直接基于该结构。
@immutable
class SystemAccountSnapshot {
  final String storageKey;
  final bool exists;
  final String? valueHex;
  final int? nonce;
  final BigInt? freeFen;

  const SystemAccountSnapshot({
    required this.storageKey,
    required this.exists,
    this.valueHex,
    this.nonce,
    this.freeFen,
  });

  double? get freeYuan => freeFen == null ? null : freeFen!.toDouble() / 100.0;

  Map<String, dynamic> toJson() => {
    'storageKey': storageKey,
    'exists': exists,
    if (valueHex != null) 'valueHex': valueHex,
    if (nonce != null) 'nonce': nonce,
    if (freeFen != null) 'freeFen': freeFen.toString(),
  };

  factory SystemAccountSnapshot.fromJson(Map<String, dynamic> json) {
    return SystemAccountSnapshot(
      storageKey: json['storageKey'] as String? ?? '',
      exists: json['exists'] as bool? ?? false,
      valueHex: json['valueHex'] as String?,
      nonce: json['nonce'] as int?,
      freeFen: json['freeFen'] == null
          ? null
          : BigInt.parse(json['freeFen'].toString()),
    );
  }
}

/// Log level enumeration
enum LogLevel {
  /// No logs
  off(0),

  /// Error logs only
  error(1),

  /// Warning and error logs
  warn(2),

  /// Info, warning and error logs
  info(3),

  /// Debug and all lower level logs
  debug(4),

  /// All logs including trace
  trace(5);

  const LogLevel(this.value);
  final int value;
}

/// Log message from smoldot
@immutable
class LogMessage {
  /// Log level
  final LogLevel level;

  /// Log message
  final String message;

  /// Target component
  final String target;

  /// Timestamp
  final DateTime timestamp;

  const LogMessage({
    required this.level,
    required this.message,
    required this.target,
    required this.timestamp,
  });

  factory LogMessage.fromJson(Map<String, dynamic> json) {
    return LogMessage(
      level: LogLevel.values[json['level'] as int],
      message: json['message'] as String,
      target: json['target'] as String,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  @override
  String toString() => '[$level] $target: $message';
}

/// Exception thrown when smoldot operations fail
class SmoldotException implements Exception {
  final String message;
  final String? details;
  final StackTrace? stackTrace;

  SmoldotException(this.message, {this.details, this.stackTrace});

  @override
  String toString() {
    final buffer = StringBuffer('SmoldotException: $message');
    if (details != null) {
      buffer.write('\nDetails: $details');
    }
    return buffer.toString();
  }
}

/// Exception thrown when FFI operations fail
class SmoldotFfiException extends SmoldotException {
  SmoldotFfiException(super.message, {super.details, super.stackTrace});
}

/// Exception thrown when chain operations fail
class ChainException extends SmoldotException {
  final int chainId;

  ChainException(
    this.chainId,
    super.message, {
    super.details,
    super.stackTrace,
  });

  @override
  String toString() => 'ChainException[$chainId]: $message';
}

/// Exception thrown when JSON-RPC operations fail
class JsonRpcException extends SmoldotException {
  final JsonRpcError? error;

  JsonRpcException(
    super.message, {
    this.error,
    super.details,
    super.stackTrace,
  });

  @override
  String toString() {
    if (error != null) {
      return 'JsonRpcException: ${error.toString()}';
    }
    return 'JsonRpcException: $message';
  }
}
