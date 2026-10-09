import 'dart:convert';
import 'dart:async';
import 'dart:ffi';
import 'package:ffi/ffi.dart';
import 'bindings.dart';
import 'types.dart';
import 'json_rpc.dart';

// ──── 原生 capability 异步回调管理器 ────

/// 全局回调注册表（NativeCallable.listener 回调在全局上下文执行）。
final Map<int, Completer<String>> _capabilityCallbackRegistry = {};
int _capabilityCallbackNextId = 0;

/// 原生回调入口：Rust 异步操作完成后通过 DartCallback 调用此函数。
void _capabilityCallback(int callbackId, int result, Pointer<Utf8> error) {
  final completer = _capabilityCallbackRegistry.remove(callbackId);
  if (completer == null) return;

  if (error != nullptr) {
    final errorMsg = error.toDartString();
    completer.completeError(
      SmoldotException('Native capability error: $errorMsg'),
    );
  } else {
    final responsePtr = Pointer<Utf8>.fromAddress(result);
    final responseStr = responsePtr.toDartString();
    completer.complete(responseStr);
  }
}

/// 原生 capability 异步调度器。
///
/// 复用 CitizenSDK 内嵌 smoldot 绑定已有的 NativeCallable.listener + Completer 模式，
/// 为所有 typed capability API 提供不阻塞 Dart 主线程的异步 FFI 调用。
class NativeCapabilityHandler {
  late final NativeCallable<DartCallbackNative> _nativeCallable;
  late final Pointer<NativeFunction<DartCallbackNative>> _nativeCallback;

  NativeCapabilityHandler() {
    _nativeCallable = NativeCallable<DartCallbackNative>.listener(
      _capabilityCallback,
    );
    _nativeCallback = _nativeCallable.nativeFunction;
  }

  /// 发起异步 FFI 调用，返回 Future<String>。
  ///
  /// [invoke] 回调接收 callbackId 和 callback 指针，负责调用对应的
  /// bindings.*Async 方法。Rust 侧完成后通过 DartCallback 回调结果。
  Future<String> call(
    void Function(
      int callbackId,
      Pointer<NativeFunction<DartCallbackNative>> callback,
    )
    invoke,
  ) {
    final id = _capabilityCallbackNextId++;
    final completer = Completer<String>();
    _capabilityCallbackRegistry[id] = completer;
    try {
      invoke(id, _nativeCallback);
    } catch (e) {
      _capabilityCallbackRegistry.remove(id);
      completer.completeError(e);
    }
    return completer.future;
  }

  void dispose() {
    _nativeCallable.close();
  }
}

// ──── Chain ────

/// Represents a blockchain chain managed by smoldot
///
/// A [Chain] instance provides methods for interacting with a specific
/// blockchain through JSON-RPC calls and subscriptions.
class Chain {
  /// Chain identifier (handle from Rust)
  final int chainId;

  /// Parent client instance (kept as reference)
  final Object client;

  /// FFI bindings
  final SmoldotBindings bindings;

  /// Native client handle (u64 from Rust)
  final int clientHandle;

  /// JSON-RPC handler for this chain
  late final JsonRpcHandler _jsonRpc;

  /// 异步原生 capability 调度器
  late final NativeCapabilityHandler _capability;

  /// Whether the chain has been disposed
  bool _isDisposed = false;

  /// Creates a new Chain instance
  ///
  /// This is typically called internally by [SmoldotClient.addChain].
  Chain({
    required this.chainId,
    required this.client,
    required this.bindings,
    required this.clientHandle,
  }) {
    _jsonRpc = JsonRpcHandler(
      chainId: chainId,
      bindings: bindings,
      clientHandle: clientHandle,
    );
    _capability = NativeCapabilityHandler();
  }

  /// Whether this chain has been disposed
  bool get isDisposed => _isDisposed;

  /// Send a JSON-RPC request to the chain
  ///
  /// [method] is the RPC method name (e.g., 'system_chain').
  /// [params] is a list of parameters for the method.
  ///
  /// Returns a [Future] that completes with the response.
  /// Throws [JsonRpcException] if the request fails.
  ///
  /// Example:
  /// ```dart
  /// final response = await chain.request('system_chain', []);
  /// print(response.result);
  /// ```
  Future<JsonRpcResponse> request(String method, List<dynamic> params) async {
    _ensureNotDisposed();
    return _jsonRpc.request(method, params);
  }

  /// Subscribe to JSON-RPC notifications
  ///
  /// [method] is the subscription method name (e.g., 'chain_subscribeNewHeads').
  /// [params] is a list of parameters for the subscription.
  ///
  /// Returns a [Stream] of responses.
  /// The stream will emit [JsonRpcException] if errors occur.
  ///
  /// Example:
  /// ```dart
  /// final subscription = await chain.subscribe('chain_subscribeNewHeads', []);
  /// await for (final response in subscription) {
  ///   print('New block: ${response.result}');
  /// }
  /// ```
  Stream<JsonRpcResponse> subscribe(String method, List<dynamic> params) {
    _ensureNotDisposed();
    return _jsonRpc.subscribe(method, params);
  }

  /// Unsubscribe from a JSON-RPC subscription
  ///
  /// [subscriptionId] is the ID returned by the subscribe method.
  Future<void> unsubscribe(String subscriptionId) async {
    _ensureNotDisposed();
    await _jsonRpc.unsubscribe(subscriptionId);
  }

  /// Get information about this chain
  Future<ChainInfo> getInfo() async {
    _ensureNotDisposed();

    final chainName = await request('system_chain', []);
    final snapshot = await getStatusSnapshot();

    return ChainInfo(
      chainId: chainId,
      name: chainName.result as String,
      status: snapshot.chainStatus,
      peerCount: snapshot.peerCount,
      bestBlockNumber: snapshot.bestBlockNumber,
      bestBlockHash: snapshot.bestBlockHash,
    );
  }

  /// Get the current best block number
  Future<int?> getBestBlockNumber() async {
    _ensureNotDisposed();
    final snapshot = await getStatusSnapshot();
    return snapshot.bestBlockNumber;
  }

  /// Get the current best block hash
  Future<String?> getBestBlockHash() async {
    _ensureNotDisposed();
    final snapshot = await getStatusSnapshot();
    return snapshot.bestBlockHash;
  }

  /// Get the number of connected peers
  Future<int> getPeerCount() async {
    _ensureNotDisposed();
    final snapshot = await getStatusSnapshot();
    return snapshot.peerCount;
  }

  /// Get the chain status
  Future<ChainStatus> getStatus() async {
    _ensureNotDisposed();
    final snapshot = await getStatusSnapshot();
    return snapshot.chainStatus;
  }

  /// 中文注释：把轻节点可观察状态收口成结构化对象，避免业务层继续直接拼裸 RPC。
  Future<LightClientStatusSnapshot> getStatusSnapshot() async {
    _ensureNotDisposed();
    final json = await _capability.call((callbackId, callback) {
      bindings.getStatusSnapshotAsync(
        chainHandle: chainId,
        callbackId: callbackId,
        callback: callback,
      );
    });
    return LightClientStatusSnapshot.fromJson(
      jsonDecode(json) as Map<String, dynamic>,
    );
  }

  /// 原生读取运行时版本。
  Future<Map<String, dynamic>> getRuntimeVersionJson() async {
    _ensureNotDisposed();
    final json = await _capability.call((callbackId, callback) {
      bindings.getRuntimeVersionAsync(
        chainHandle: chainId,
        callbackId: callbackId,
        callback: callback,
      );
    });
    return jsonDecode(json) as Map<String, dynamic>;
  }

  /// 原生读取 metadata hex。
  Future<String> getMetadataHex() async {
    _ensureNotDisposed();
    return _capability.call((callbackId, callback) {
      bindings.getMetadataAsync(
        chainHandle: chainId,
        callbackId: callbackId,
        callback: callback,
      );
    });
  }

  /// 原生读取账户下一个可用 nonce。
  Future<int> getAccountNextIndex(String accountIdHex) async {
    _ensureNotDisposed();
    final result = await _capability.call((callbackId, callback) {
      bindings.getAccountNextIndexAsync(
        chainHandle: chainId,
        accountIdHex: accountIdHex,
        callbackId: callbackId,
        callback: callback,
      );
    });
    return int.parse(result);
  }

  /// 原生读取指定块高的 block hash。
  Future<String> getBlockHash(int blockNumber) async {
    _ensureNotDisposed();
    return _capability.call((callbackId, callback) {
      bindings.getBlockHashAsync(
        chainHandle: chainId,
        blockNumber: blockNumber.toString(),
        callbackId: callbackId,
        callback: callback,
      );
    });
  }

  /// 原生读取指定区块的 extrinsics 列表。
  Future<List<String>> getBlockExtrinsics(String blockHashHex) async {
    _ensureNotDisposed();
    final responseJson = await _capability.call((callbackId, callback) {
      bindings.getBlockExtrinsicsAsync(
        chainHandle: chainId,
        blockHashHex: blockHashHex,
        callbackId: callbackId,
        callback: callback,
      );
    });
    final response = jsonDecode(responseJson) as List<dynamic>;
    return response.cast<String>();
  }

  /// 原生提交已编码 extrinsic。
  Future<String> submitExtrinsicHex(String extrinsicHex) async {
    _ensureNotDisposed();
    return _capability.call((callbackId, callback) {
      bindings.submitExtrinsicAsync(
        chainHandle: chainId,
        extrinsicHex: extrinsicHex,
        callbackId: callbackId,
        callback: callback,
      );
    });
  }

  /// 原生读取 `System.Account`。
  Future<SystemAccountSnapshot> getSystemAccount(String accountIdHex) async {
    _ensureNotDisposed();
    final json = await _capability.call((callbackId, callback) {
      bindings.getSystemAccountAsync(
        chainHandle: chainId,
        accountIdHex: accountIdHex,
        callbackId: callbackId,
        callback: callback,
      );
    });
    return SystemAccountSnapshot.fromJson(
      jsonDecode(json) as Map<String, dynamic>,
    );
  }

  /// 原生读取 finalized 块上的 `System.Account`。
  Future<SystemAccountSnapshot> getFinalizedSystemAccount(
    String accountIdHex,
  ) async {
    _ensureNotDisposed();
    final json = await _capability.call((callbackId, callback) {
      bindings.getFinalizedSystemAccountAsync(
        chainHandle: chainId,
        accountIdHex: accountIdHex,
        callbackId: callbackId,
        callback: callback,
      );
    });
    return SystemAccountSnapshot.fromJson(
      jsonDecode(json) as Map<String, dynamic>,
    );
  }

  /// 原生读取单个 storage value。
  Future<String?> getStorageValueHex(String storageKeyHex) async {
    _ensureNotDisposed();
    final responseJson = await _capability.call((callbackId, callback) {
      bindings.getStorageValueAsync(
        chainHandle: chainId,
        storageKeyHex: storageKeyHex,
        callbackId: callbackId,
        callback: callback,
      );
    });
    final response = jsonDecode(responseJson) as Map<String, dynamic>;
    if (response['exists'] != true) {
      return null;
    }
    return response['valueHex'] as String?;
  }

  /// 原生读取 finalized 块上的单个 storage value。
  Future<String?> getFinalizedStorageValueHex(String storageKeyHex) async {
    _ensureNotDisposed();
    final responseJson = await _capability.call((callbackId, callback) {
      bindings.getFinalizedStorageValueAsync(
        chainHandle: chainId,
        storageKeyHex: storageKeyHex,
        callbackId: callbackId,
        callback: callback,
      );
    });
    final response = jsonDecode(responseJson) as Map<String, dynamic>;
    if (response['exists'] != true) {
      return null;
    }
    return response['valueHex'] as String?;
  }

  /// 原生批量读取多个 storage value。
  Future<Map<String, String?>> getStorageValuesHex(
    List<String> storageKeys,
  ) async {
    _ensureNotDisposed();
    final responseJson = await _capability.call((callbackId, callback) {
      bindings.getStorageValuesAsync(
        chainHandle: chainId,
        storageKeysJson: jsonEncode(storageKeys),
        callbackId: callbackId,
        callback: callback,
      );
    });
    final response = jsonDecode(responseJson) as Map<String, dynamic>;
    return response.map(
      (key, value) => MapEntry(key, value == null ? null : value as String),
    );
  }

  /// 原生批量读取 finalized 块上的多个 storage value。
  Future<Map<String, String?>> getFinalizedStorageValuesHex(
    List<String> storageKeys,
  ) async {
    _ensureNotDisposed();
    final responseJson = await _capability.call((callbackId, callback) {
      bindings.getFinalizedStorageValuesAsync(
        chainHandle: chainId,
        storageKeysJson: jsonEncode(storageKeys),
        callbackId: callbackId,
        callback: callback,
      );
    });
    final response = jsonDecode(responseJson) as Map<String, dynamic>;
    return response.map(
      (key, value) => MapEntry(key, value == null ? null : value as String),
    );
  }

  /// Wait until the chain is synced
  Future<void> waitUntilSynced({
    Duration timeout = const Duration(minutes: 5),
    Duration pollInterval = const Duration(seconds: 1),
  }) async {
    _ensureNotDisposed();

    final stopwatch = Stopwatch()..start();

    while (stopwatch.elapsed < timeout) {
      final snapshot = await getStatusSnapshot();

      // runtime near-head 不等于 GRANDPA warp 已结束；只有完整可用快照才能放行。
      if (snapshot.isUsable) {
        return;
      }

      await Future<void>.delayed(pollInterval);
    }

    throw TimeoutException(
      'Chain did not sync within ${timeout.inSeconds} seconds',
      timeout,
    );
  }

  /// Get the database content for this chain
  /// Note: This is not yet implemented in smoldot FFI
  Future<String?> getDatabaseContent() async {
    _ensureNotDisposed();
    // This would require additional FFI support from smoldot
    // For now, return null
    return null;
  }

  /// Dispose of this chain and free resources
  Future<void> dispose() async {
    if (_isDisposed) {
      return;
    }

    _jsonRpc.dispose();
    _capability.dispose();
    _isDisposed = true;
  }

  /// Ensure the chain is not disposed
  void _ensureNotDisposed() {
    if (_isDisposed) {
      throw SmoldotException('Chain $chainId has been disposed');
    }
  }

  @override
  String toString() => 'Chain(chainId: $chainId, isDisposed: $_isDisposed)';
}
