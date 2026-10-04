import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import '../models/citizen_capability.dart';
import '../models/citizen_chain_state.dart';
import '../models/citizen_signing.dart';
import '../models/citizen_transaction.dart';
import '../models/citizen_wallet.dart';
import '../account_codec.dart';
import '../platform/citizen_sdk_flutter_codec.dart';
import '../platform/citizen_sdk_flutter_sessions.dart';
import '../platform/citizen_sdk_platform.dart';
import '../platform/flutter_citizen_sdk_platform.dart';
import 'citizen_chain.dart';
import 'citizen_qr.dart';
import 'citizen_sdk_error.dart';
import 'citizen_sdk_events.dart';
import 'citizen_transactions.dart';
import 'citizen_sdk_wallet.dart';

/// CitizenSDK 的唯一 Dart/Flutter 公共门面。
final class CitizenSdk {
  CitizenSdk._(this._session, CitizenSdkFlutterCodec codec)
    : chain = _CitizenChain(_session, codec),
      wallet = _CitizenSdkWallet(_session, codec),
      signing = _CitizenSigning(_session, codec),
      qr = _CitizenQr(_session),
      transactions = _CitizenTransactions(_session, codec),
      history = _CitizenHistory(_session, codec);

  /// 打开当前受支持平台的 CitizenSDK session，但不隐式启动轻节点。
  ///
  /// Flutter 产品投影覆盖 Android、iOS、macOS、Linux 与 Windows；Linux 的两种
  /// 机器目标共用官方 linux 注册。全部使用相同的公开 API、固定
  /// tuple 方法和事件合同；同版原生插件缺失时失败关闭，不注入替代实现。
  /// Windows 宿主在构建时声明 CITIZENSDK_APPLICATION_ID；此入口不接收路径或秘密。
  static Future<CitizenSdk> open({
    int modules = CitizenSdkModules.full,
    Future<Uint8List?> Function(CitizenCredentialChallenge challenge)?
    credentialProvider,
  }) async {
    final codec = const CitizenSdkFlutterCodec();
    final platform = CitizenSdkPlatform.instance ?? _defaultPlatform();
    final session = await CitizenSdkFlutterSession.open(
      platform: platform,
      codec: codec,
      modules: modules,
      credentialProvider: credentialProvider,
    );
    return CitizenSdk._(session, codec);
  }

  static final CitizenSdkPlatform _defaultFlutterPlatform =
      FlutterCitizenSdkPlatform();

  static CitizenSdkPlatform _defaultPlatform() {
    if (!kIsWeb &&
        (defaultTargetPlatform == TargetPlatform.android ||
            defaultTargetPlatform == TargetPlatform.iOS ||
            defaultTargetPlatform == TargetPlatform.macOS ||
            defaultTargetPlatform == TargetPlatform.linux ||
            defaultTargetPlatform == TargetPlatform.windows)) {
      return _defaultFlutterPlatform;
    }
    throw const CitizenSdkException(
      code: CitizenSdkErrorCode.unsupported,
      message: 'CitizenSDK Flutter binding 当前仅支持 Android、iOS、macOS、LinuxARM、LinuxAMD 与 Windows',
    );
  }

  final CitizenSdkFlutterSession _session;

  /// 已验证的公民链读取能力。
  final CitizenChain chain;

  /// 设备本地热钱包和账户管理，不包含公开签名门面。
  final CitizenSdkWallet wallet;

  /// 独立签名能力；私钥只经设备安全金库受控使用。纯验签使用 [CitizenSigning.verify]。
  final CitizenSigning signing;

  /// QR_V1 协议、扫码签名会话和五端统一 ZXing-C++ 图像能力。
  final CitizenQr qr;

  /// 公民链交易构造、提交与观察能力。
  final CitizenTransactions transactions;

  /// 可独立于本地钱包使用的已确认交易历史能力。
  final CitizenHistory history;

  /// 当前 session 的类型化生命周期与请求事件。
  Stream<CitizenSdkEvent> get events => _session.events;

  /// 当前 session 生命周期快照。
  CitizenSdkLifecycle get lifecycle => _session.lifecycle;

  /// 启动当前 session 的公民链轻节点。
  Future<void> start() async {
    final value = await _session.invoke('start');
    final lifecycle = const CitizenSdkFlutterCodec().decodeLifecycle(value[0]);
    if (lifecycle != CitizenSdkLifecycle.running) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.decode,
        message: 'CitizenSDK start 未进入 running',
      );
    }
  }

  /// 在完成 checkpoint 后有序停止当前 session 的轻节点。
  Future<void> stop() async {
    final value = await _session.invoke('stop');
    final lifecycle = const CitizenSdkFlutterCodec().decodeLifecycle(value[0]);
    if (lifecycle != CitizenSdkLifecycle.stopped) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.decode,
        message: 'CitizenSDK stop 未进入 stopped',
      );
    }
  }

  /// 返回当前宿主事实对应的能力快照。
  Future<CitizenCapabilitySnapshot> getCapabilities() =>
      chain.getCapabilities();

  /// 关闭已停止的 session；只有原生侧完成结果释放和 destroy 后才完成。
  ///
  /// 若 session 正在运行，调用方必须先等待 [stop] 成功，不能用 [close]
  /// 绕过 checkpoint 与有序停止。
  Future<void> close() => _session.close();
}

final class _CitizenChain implements CitizenChain {
  const _CitizenChain(this._session, this._codec);

  final CitizenSdkFlutterSession _session;
  final CitizenSdkFlutterCodec _codec;

  @override
  Future<CitizenCapabilitySnapshot> getCapabilities() async {
    final value = await _session.invoke('getCapabilities');
    return _codec.decodeCapabilities(value[0]);
  }

  @override
  Future<String> getGenesisHash() async {
    final value = await _session.invoke('getGenesisHash');
    return value[0]! as String;
  }

  @override
  Future<CitizenBlockRef> getFinalizedHead() async {
    final value = await _session.invoke('getFinalizedHead');
    return _codec.decodeBlock(value[0]);
  }

  @override
  Future<CitizenChainSyncStatus> getSyncStatus() async {
    final value = await _session.invoke('getSyncStatus');
    return _codec.decodeSyncStatus(value[0]);
  }

  @override
  Future<CitizenBlockRef> getBestHead() async {
    final value = await _session.invoke('getBestHead');
    return _codec.decodeBlock(value[0]);
  }

  @override
  Future<CitizenBlockRef> getFinalizedBlockAt(BigInt number) async {
    final value = await _session.invoke(
      'getFinalizedBlockAt',
      fields: <Object?>[number.toString()],
    );
    return _codec.decodeBlock(value[0]);
  }

  @override
  Future<CitizenBlockRef> resolveFinalizedBlock(
    String hash,
    BigInt number,
  ) async {
    final value = await _session.invoke(
      'resolveFinalizedBlock',
      fields: <Object?>[hash, number.toString()],
    );
    return _codec.decodeBlock(value[0]);
  }

  @override
  Future<CitizenBlockHeader> getBlockHeader(CitizenBlockRef block) async {
    final value = await _session.invoke(
      'getBlockHeader',
      fields: <Object?>[_codec.encodeBlock(block)],
    );
    return _codec.decodeBlockHeader(value[0]);
  }

  @override
  Future<CitizenBlockBody> getBlockBody(CitizenBlockRef block) async {
    final value = await _session.invoke(
      'getBlockBody',
      fields: <Object?>[_codec.encodeBlock(block)],
    );
    return _codec.decodeBlockBody(value[0]);
  }

  @override
  Future<CitizenRuntimeContext> getRuntimeContext(CitizenBlockRef block) async {
    final value = await _session.invoke(
      'getRuntimeContext',
      fields: <Object?>[_codec.encodeBlock(block)],
    );
    return _codec.decodeRuntimeContext(value[0]);
  }

  @override
  Future<Uint8List?> getStorage(CitizenBlockRef block, Uint8List key) async {
    final value = await _session.invoke(
      'getStorage',
      fields: <Object?>[_codec.encodeBlock(block), Uint8List.fromList(key)],
    );
    return _codec.decodeStorage(value[0]);
  }

  @override
  Future<List<Uint8List?>> getStorageBatch(
    CitizenBlockRef block,
    List<Uint8List> keys,
  ) async {
    final value = await _session.invoke(
      'getStorageBatch',
      fields: <Object?>[
        _codec.encodeBlock(block),
        keys.map(Uint8List.fromList).toList(growable: false),
      ],
    );
    return _codec.decodeStorageBatch(value[0]);
  }

  @override
  Future<List<Uint8List>> getStorageKeysPaged(
    CitizenBlockRef finalizedBlock,
    Uint8List prefix, {
    Uint8List? startKey,
    int limit = 1000,
  }) async {
    final value = await _session.invoke(
      'getStorageKeysPaged',
      fields: <Object?>[
        _codec.encodeBlock(finalizedBlock),
        Uint8List.fromList(prefix),
        startKey == null ? null : Uint8List.fromList(startKey),
        limit,
      ],
    );
    final keys = (value[0]! as List<Object?>)
        .map(
          (item) => Uint8List.fromList(item! as Uint8List).asUnmodifiableView(),
        )
        .toList(growable: false);
    if (keys.length > limit) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.integrity,
        message: 'storage keys page 返回数量超过请求 limit',
      );
    }
    for (var index = 0; index < keys.length; index += 1) {
      final key = keys[index];
      if (!_startsWithBytes(key, prefix) ||
          (startKey != null && _compareBytes(key, startKey) <= 0) ||
          (index > 0 && _compareBytes(keys[index - 1], key) >= 0)) {
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.integrity,
          message: 'storage keys page 与请求前缀、游标或顺序不一致',
        );
      }
    }
    return List<Uint8List>.unmodifiable(keys);
  }

  @override
  Future<Uint8List> callRuntimeApi(
    CitizenBlockRef block,
    String method,
    Uint8List arguments,
  ) async {
    final value = await _session.invoke(
      'callRuntimeApi',
      fields: <Object?>[
        _codec.encodeBlock(block),
        method,
        Uint8List.fromList(arguments),
      ],
    );
    return Uint8List.fromList(value[0]! as Uint8List).asUnmodifiableView();
  }

  @override
  Future<Uint8List?> getSystemEvents(CitizenBlockRef finalizedBlock) async {
    final value = await _session.invoke(
      'getSystemEvents',
      fields: <Object?>[_codec.encodeBlock(finalizedBlock)],
    );
    return _codec.decodeStorage(value[0]);
  }

  @override
  Future<CitizenChainState> exportState() async {
    final value = await _session.invoke('exportState');
    return _codec.decodeChainState(value[0]);
  }

  @override
  Future<void> importState(CitizenChainState state) async {
    await _session.invoke(
      'importState',
      fields: <Object?>[
        state.formatVersion,
        _codec.encodeBlock(state.finalized),
        Uint8List.fromList(state.database),
      ],
    );
  }

  @override
  Future<CitizenAccountBalance> getAccountBalance(String accountId) async {
    final value = await _session.invoke(
      'getAccountBalance',
      fields: <Object?>[accountId],
    );
    final balance = _codec.decodeBalance(value[0]);
    if (balance.accountId != accountId) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.decode,
        message: '余额响应账户与请求账户不一致',
      );
    }
    return balance;
  }

  @override
  Future<List<CitizenAccountBalance>> getAccountBalances(
    List<String> accountIds,
  ) async {
    _requireCount(
      accountIds.length,
      minimum: 0,
      maximum: CitizenSdkFlutterCodec.maximumBalanceAccounts,
      label: '批量余额 accountIds',
    );
    // 固定 await 前的请求顺序；不能让调用方后续变更列表改变响应关联依据。
    final requested = List<String>.unmodifiable(accountIds);
    final value = await _session.invoke(
      'getAccountBalances',
      fields: <Object?>[requested],
    );
    final balances = _codec.decodeBalances(value[0]);
    if (balances.length != requested.length) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.decode,
        message: '批量余额响应数量与请求不一致',
      );
    }
    for (var index = 0; index < requested.length; index += 1) {
      if (balances[index].accountId != requested[index]) {
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.decode,
          message: '批量余额响应账户未保持请求顺序或重复项',
        );
      }
    }
    return balances;
  }

  @override
  Future<CitizenAccountNonce> getAccountNonce(String accountId) async {
    final value = await _session.invoke(
      'getAccountNonce',
      fields: <Object?>[accountId],
    );
    final nonce = _codec.decodeNonce(value[0]);
    if (nonce.accountId != accountId) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.decode,
        message: 'nonce 响应账户与请求账户不一致',
      );
    }
    return nonce;
  }

  @override
  Future<CitizenFeeSnapshot> getFeeSnapshot() async {
    final value = await _session.invoke('getFeeSnapshot');
    return _codec.decodeFeeSnapshot(value[0]);
  }
}

final class _CitizenSdkWallet
    implements CitizenSdkWallet, CitizenSdkWalletBatch {
  const _CitizenSdkWallet(this._session, this._codec);
  final CitizenSdkFlutterSession _session;
  final CitizenSdkFlutterCodec _codec;

  CitizenSdkOperation<CitizenWalletState> _state(
    String method,
    List<Object?> fields,
  ) => _session.operation(
    method,
    fields: fields,
    decode: (value) => _codec.decodeWalletState(value[0]),
  );
  CitizenSdkOperation<CitizenWalletProfile> _profile(
    String method,
    List<Object?> fields,
  ) => _session.operation(
    method,
    fields: fields,
    decode: (value) {
      final profile = _codec.decodeWalletProfile(value[0]);
      if (profile == null)
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.decode,
          message: '钱包操作没有返回已提交的公开profile',
        );
      return profile;
    },
  );

  @override
  CitizenSdkOperation<CitizenWalletState> getState() =>
      _state('getWalletState', const []);
  @override
  CitizenSdkOperation<CitizenWalletInspection> inspect() => _session.operation(
    'inspectWallets',
    decode: (value) => _CitizenWalletInspection(
      _session,
      _codec,
      _resourceId(value[0]),
      _codec.decodeWalletState(value[1]),
    ),
  );
  @override
  Future<CitizenWalletInputValidation> validatePassword(String password) async {
    if (!_codec.walletInputWithinLimit(password))
      return const CitizenWalletInputValidation(
        reason: CitizenWalletInputReason.inputTooLong,
      );
    return _codec.decodeWalletInputValidation(
      await _session.invoke('validateWalletPassword', fields: [password]),
    );
  }

  @override
  Future<CitizenWalletInputValidation> validateMnemonic(
    String mnemonic,
    CitizenWalletWordCount wordCount,
  ) async {
    if (!_codec.walletInputWithinLimit(mnemonic))
      return const CitizenWalletInputValidation(
        reason: CitizenWalletInputReason.inputTooLong,
      );
    return _codec.decodeWalletInputValidation(
      await _session.invoke(
        'validateWalletMnemonic',
        fields: [mnemonic, wordCount.value],
      ),
    );
  }

  @override
  Future<List<String>> wordSuggestions(String prefix) async {
    final value = await _session.invoke(
      'walletWordSuggestions',
      fields: [prefix],
    );
    return List<String>.unmodifiable(
      (value[0]! as List<Object?>).cast<String>(),
    );
  }

  @override
  CitizenSdkOperation<CitizenSdkPreparedWallet> prepareCreation({
    required CitizenWalletWordCount wordCount,
    String password = '',
  }) => _session.operation(
    'prepareWalletCreation',
    fields: [wordCount.value, password],
    decode: (value) =>
        _CitizenSdkPreparedWallet(_session, _codec, _resourceId(value[0])),
  );

  @override
  CitizenSdkOperation<CitizenWalletProfile> importWallet({
    required String mnemonic,
    String password = '',
  }) => _profile('importWallet', [mnemonic, password]);
  @override
  CitizenSdkOperation<CitizenWalletProfile> addAccounts({
    required String mnemonic,
    String password = '',
    required List<int> indices,
  }) => _profile('addWalletAccounts', [
    mnemonic,
    password,
    List<int>.unmodifiable(indices),
  ]);
  @override
  CitizenSdkOperation<CitizenWalletProfile> addNextAccount({
    required String mnemonic,
    String password = '',
  }) => _profile('addNextWalletAccount', [mnemonic, password]);

  @override
  CitizenSdkOperation<CitizenWalletState> importColdAccount({
    String? accountId,
    String? ss58Address,
    String name = '',
  }) {
    if ((accountId == null) == (ss58Address == null))
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: 'accountId与ss58Address必须且只能提供一个',
      );
    return _state(
      accountId == null ? 'importColdAccountSs58' : 'importColdAccountId',
      [accountId ?? ss58Address!, name.trim()],
    );
  }

  @override
  CitizenSdkOperation<CitizenWalletState> importColdAccountCode({
    required String code,
    String name = '',
  }) => _state('importColdAccountCode', [code, name.trim()]);
  @override
  Future<CitizenSdkPrivateKey> openPrivateKey(String accountId) async {
    final value = await _session.invoke('openPrivateKey', fields: [accountId]);
    return _CitizenSdkPrivateKey(_session, _resourceId(value[0]));
  }

  @override
  CitizenSdkOperation<CitizenWalletProfile> setActiveAccount(
    String accountId,
  ) => _profile('setActiveWalletAccount', [accountId]);
  @override
  CitizenSdkOperation<CitizenWalletState> setActiveWallet({
    required BigInt expectedRevision,
    required int walletIndex,
  }) => _state('setActiveWallet', [expectedRevision.toString(), walletIndex]);
  @override
  CitizenSdkOperation<CitizenWalletState> renameWallet({
    required BigInt expectedRevision,
    required int walletIndex,
    required String name,
  }) => _state('renameWallet', [
    expectedRevision.toString(),
    walletIndex,
    name.trim(),
  ]);
  @override
  CitizenSdkOperation<CitizenWalletState> renameAccount({
    required String accountId,
    required String name,
  }) => _state('renameAccount', [accountId, name.trim()]);
  @override
  CitizenSdkOperation<CitizenWalletState> deleteAccount(String accountId) =>
      _state('deleteAccount', [accountId]);
  @override
  CitizenSdkOperation<void> delete() =>
      _session.operation('deleteWallet', decode: (_) {});
  @override
  CitizenSdkOperation<void> signAndDelete() =>
      _session.operation('signAndDeleteWallet', decode: (_) {});
  @override
  CitizenSdkOperation<CitizenWalletProfile?> reconcileCleanup() =>
      _session.operation(
        'reconcileWalletCleanup',
        decode: (value) => _codec.decodeWalletProfile(value[0]),
      );

  @override
  CitizenSdkOperation<CitizenWalletState> reorderAccountsWithoutDefaultChange({
    required BigInt expectedRevision,
    required List<String> accountIds,
  }) => _state('reorderWalletAccountsWithoutDefaultChange', [
    expectedRevision.toString(),
    List<String>.unmodifiable(accountIds),
  ]);
  @override
  CitizenSdkOperation<CitizenDefaultAccountChangeOutcome>
  beginDefaultAccountChange({
    required BigInt expectedRevision,
    required List<String> accountIds,
    int ttlSeconds = 90,
  }) => _session.operation(
    'beginDefaultAccountChange',
    fields: [
      expectedRevision.toString(),
      List<String>.unmodifiable(accountIds),
      ttlSeconds,
    ],
    decode: (value) => _codec.decodeDefaultAccountChangeOutcome(value[0]),
  );
  @override
  CitizenSdkOperation<CitizenDefaultAccountChangeCompleted>
  consumeDefaultAccountChange({
    required String sessionId,
    required String response,
  }) => _session.operation(
    'consumeDefaultAccountChange',
    fields: [sessionId, response],
    decode: (value) {
      final result = _codec.decodeDefaultAccountChangeOutcome(value[0]);
      if (result is! CitizenDefaultAccountChangeCompleted)
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.decode,
          message: '默认账户签名消费没有返回完成事实',
        );
      return result;
    },
  );
  @override
  CitizenSdkOperation<Uint8List> deriveApplicationKey({
    required String accountId,
    required Uint8List salt,
    required Uint8List info,
  }) => _session.operation(
    'deriveApplicationKey',
    fields: [accountId, Uint8List.fromList(salt), Uint8List.fromList(info)],
    decode: (value) {
      final raw = value[0]! as Uint8List;
      try {
        if (raw.length != 32)
          throw const CitizenSdkException(
            code: CitizenSdkErrorCode.decode,
            message: '应用派生钥必须是32字节',
          );
        return Uint8List.fromList(raw);
      } finally {
        raw.fillRange(0, raw.length, 0);
      }
    },
  );
  @override
  CitizenSdkOperation<CitizenApplicationKeyPreparation> prepareApplicationKeys({
    required String accountId,
    required Uint8List salt,
    required List<Uint8List> infos,
    Uint8List? signingMessage,
  }) => _session.operation(
    'prepareApplicationKeys',
    fields: [
      accountId,
      Uint8List.fromList(salt),
      infos.map(Uint8List.fromList).toList(growable: false),
      signingMessage == null
          ? Uint8List(0)
          : Uint8List.fromList(signingMessage),
    ],
    decode: (value) {
      final raw = value[0] as List;
      final signature = value[1] as Uint8List;
      final keys = <Uint8List>[];
      try {
        if (raw.length != infos.length ||
            signature.length != (signingMessage == null ? 0 : 64)) {
          throw const CitizenSdkException(
            code: CitizenSdkErrorCode.decode,
            message: '应用材料准备结果与请求不一致',
          );
        }
        for (final item in raw) {
          keys.add(Uint8List.fromList(item as Uint8List));
        }
        return CitizenApplicationKeyPreparation(
          keys: keys,
          signature: signature.isEmpty ? null : Uint8List.fromList(signature),
        );
      } catch (_) {
        for (final key in keys) {
          key.fillRange(0, key.length, 0);
        }
        rethrow;
      } finally {
        for (final item in raw) {
          if (item is Uint8List) item.fillRange(0, item.length, 0);
        }
        signature.fillRange(0, signature.length, 0);
      }
    },
  );
  @override
  CitizenSdkOperation<List<Uint8List>> deriveApplicationKeys({
    required String accountId,
    required Uint8List salt,
    required List<Uint8List> infos,
  }) => _session.operation(
    'deriveApplicationKeys',
    fields: [
      accountId,
      Uint8List.fromList(salt),
      infos.map(Uint8List.fromList).toList(growable: false),
    ],
    decode: (value) {
      final raw = value[0];
      if (raw is! List || raw.length != infos.length) {
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.decode,
          message: '应用派生钥批次结果数量无效',
        );
      }
      return raw
          .map((item) {
            if (item is! Uint8List || item.length != 32) {
              throw const CitizenSdkException(
                code: CitizenSdkErrorCode.decode,
                message: '应用派生钥批次条目无效',
              );
            }
            final copy = Uint8List.fromList(item);
            item.fillRange(0, item.length, 0);
            return copy;
          })
          .toList(growable: false);
    },
  );
}

/// 资源标识只关联本session的SDK对象，不向应用公开或接受Core裸指针。
String _resourceId(Object? raw) {
  if (raw is! String ||
      raw.isEmpty ||
      raw.length > 128 ||
      !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(raw)) {
    throw const CitizenSdkException(
      code: CitizenSdkErrorCode.decode,
      message: 'SDK资源标识无效',
    );
  }
  return raw;
}

final class _CitizenSdkPreparedWallet implements CitizenSdkPreparedWallet {
  _CitizenSdkPreparedWallet(this._session, this._codec, this._id) {
    _session.registerResource(release);
  }
  final CitizenSdkFlutterSession _session;
  final CitizenSdkFlutterCodec _codec;
  final String _id;
  bool _closing = false;
  bool _released = false;
  bool _committed = false;
  bool _committing = false;
  Future<CitizenWalletProfile>? _commitResult;
  Future<void>? _releaseFuture;

  void _requireOpen() {
    if (_closing || _released || _committed || _committing)
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidState,
        message: '创建准备资源已提交、正在使用或关闭',
      );
  }

  @override
  Future<CitizenSdkRecoveryPhrase> recoveryPhrase() async {
    _requireOpen();
    final value = await _session.invoke('copyRecoveryPhrase', fields: [_id]);
    final raw = value[0]! as Uint8List;
    try {
      _requireOpen();
      return _CitizenSdkRecoveryPhrase(_session, Uint8List.fromList(raw));
    } finally {
      raw.fillRange(0, raw.length, 0);
    }
  }

  @override
  CitizenSdkOperation<CitizenWalletProfile> commit() {
    _requireOpen();
    final operation = _session.operation<CitizenWalletProfile>(
      'commitWalletCreation',
      fields: [_id],
      decode: (value) {
        final profile = _codec.decodeWalletProfile(value[0]);
        if (profile == null)
          throw const CitizenSdkException(
            code: CitizenSdkErrorCode.decode,
            message: '创建提交未返回profile',
          );
        return profile;
      },
    );
    _committing = true;
    Future<CitizenWalletProfile> settle() async {
      try {
        final profile = await operation.result;
        _committed = true;
        return profile;
      } finally {
        // 原生准备对象决定是否已经接纳/消费；失败重试不能越过其单次提交守卫。
        _committing = false;
      }
    }

    final result = settle();
    _commitResult = result;
    return CitizenSdkOperation(
      operationId: operation.operationId,
      result: result,
      cancel: operation.cancel,
    );
  }

  @override
  Future<void> release() {
    if (_released) return Future<void>.value();
    return _releaseFuture ??= _release();
  }

  Future<void> _release() async {
    _closing = true;
    try {
      try {
        await _commitResult;
      } on Object {
        /* 仍须向原生归还未消费资源。 */
      }
      // 原生仍持有资源登记：提交成功或接纳后失败都必须归还，不能只清Dart对象。
      await _session.invoke('releasePreparedWallet', fields: [_id]);
      _released = true;
      _session.unregisterResource(release);
    } on Object {
      _releaseFuture = null;
      rethrow;
    }
  }
}

final class _CitizenSdkRecoveryPhrase implements CitizenSdkRecoveryPhrase {
  _CitizenSdkRecoveryPhrase(this._session, this._bytes) {
    try {
      _session.registerResource(release);
    } on Object {
      _bytes.fillRange(0, _bytes.length, 0);
      rethrow;
    }
  }
  final CitizenSdkFlutterSession _session;
  final Uint8List _bytes;
  bool _released = false;
  @override
  Uint8List get bytes {
    if (_released)
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidState,
        message: '备份显示资源已释放',
      );
    return _bytes.asUnmodifiableView();
  }

  @override
  Future<void> release() async {
    if (_released) return;
    _released = true;
    _bytes.fillRange(0, _bytes.length, 0);
    _session.unregisterResource(release);
  }

  @override
  String toString() => 'CitizenSdkRecoveryPhrase(redacted)';
}

final class _CitizenSdkPrivateKey implements CitizenSdkPrivateKey {
  _CitizenSdkPrivateKey(this._session, this._id) {
    _session.registerResource(close);
    _events = _session.events.listen((event) {
      if (event is CitizenSdkPrivateKeyClosed && event.resourceId == _id) {
        _closeRequested = true;
        _bytes?.fillRange(0, _bytes!.length, 0);
        unawaited(
          close().catchError((Object _) {
            /* 调用方仍可重试close，秘密已经清零。 */
          }),
        );
      }
    });
    if (_session.hasResourceClosed(_id)) {
      _closeRequested = true;
      unawaited(
        close().catchError((Object _) {
          /* 原生关闭早于资源接管。 */
        }),
      );
    }
  }
  final CitizenSdkFlutterSession _session;
  final String _id;
  final Completer<void> _closed = Completer<void>();
  Future<Uint8List>? _revealing;
  Future<void>? _closing;
  Uint8List? _bytes;
  bool _closeRequested = false;
  late final StreamSubscription<CitizenSdkEvent> _events;
  @override
  Future<void> get closed => _closed.future;
  @override
  Future<Uint8List> reveal() {
    if (_closeRequested || _revealing != null)
      return Future<Uint8List>.error(
        const CitizenSdkException(
          code: CitizenSdkErrorCode.invalidState,
          message: '私钥资源只允许一次显式查看',
        ),
      );
    return _revealing = _reveal();
  }

  Future<Uint8List> _reveal() async {
    final value = await _session.invoke('revealPrivateKey', fields: [_id]);
    final raw = value[0]! as Uint8List;
    try {
      if (_closeRequested)
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.cancelled,
          message: '私钥显示已取消',
        );
      if (raw.length != 32)
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.decode,
          message: '私钥显示结果长度无效',
        );
      _bytes = Uint8List.fromList(raw);
      return _bytes!.asUnmodifiableView();
    } finally {
      raw.fillRange(0, raw.length, 0);
    }
  }

  @override
  Future<void> close() {
    if (_closed.isCompleted) return _closed.future;
    return _closing ??= _close();
  }

  Future<void> _close() async {
    _closeRequested = true;
    _bytes?.fillRange(0, _bytes!.length, 0);
    try {
      await _session.invoke('closePrivateKey', fields: [_id]);
      try {
        await _revealing;
      } on Object {
        /* 已请求关闭，不再显示迟到结果。 */
      }
      _bytes?.fillRange(0, _bytes!.length, 0);
      _session.unregisterResource(close);
      _session.acknowledgeResourceClosed(_id);
      await _events.cancel();
      _closed.complete();
    } on Object {
      _closing = null;
      rethrow;
    }
  }

  @override
  String toString() => 'CitizenSdkPrivateKey(redacted)';
}

/// 独立密码学控制面：验签无需金库，签名只引用 SDK 安全建立的账户秘密。
abstract interface class CitizenSigning {
  /// 无实例的有界编码，原语只在Core执行，不在Dart复制哈希/SCALE实现。
  static Future<Uint8List> encodePayload(CitizenSigningPayload payload) async {
    const codec = CitizenSdkFlutterCodec();
    final arguments = codec.encodeSigningPayload(payload);
    final platform =
        CitizenSdkPlatform.instance ?? CitizenSdk._defaultPlatform();
    return codec.decodeSigningPayload(
      await platform.invoke('encodeSigningPayload', arguments),
      payload.kind,
    );
  }

  /// Core审阅返回事实资源，App以原UI确认后提交同一资源；不返回裸句柄或待签秘密。
  CitizenSdkOperation<CitizenQrReview> reviewQrRequest(String signRequest);
  CitizenSdkOperation<CitizenQrSigned> signQrRequest(CitizenQrReview review);

  CitizenSdkOperation<CitizenWalletSignature> sign({
    required String accountId,
    required Uint8List payload,
  });

  /// Routes a generic opaque intent using the account's persisted hot/cold mode.
  CitizenSdkOperation<CitizenSigningOutcome> begin(CitizenSigningIntent intent);

  /// Verifies and consumes exactly one instance-local external signing response.
  CitizenSdkOperation<CitizenSigningCompleted> consumeExternalSignature({
    required String sessionId,
    required String response,
  });

  Future<bool> cancel(String sessionId);

  /// 无状态纯验签，无需 open、模块实例、事件订阅、链数据库或设备金库。
  ///
  /// 仅编码公开输入，密码学验证由五端共同使用的 Rust 实现完成。
  static Future<bool> verify({
    required String accountId,
    required Uint8List signature,
    required Uint8List payload,
  }) async {
    const codec = CitizenSdkFlutterCodec();
    final arguments = codec.encodeVerification(
      accountId: accountId,
      signature: signature,
      payload: payload,
    );
    final platform =
        CitizenSdkPlatform.instance ?? CitizenSdk._defaultPlatform();
    return codec.decodeVerification(
      await platform.invoke('verifySignature', arguments),
    );
  }
}

final class _CitizenSigning implements CitizenSigning {
  const _CitizenSigning(this._session, this._codec);
  final CitizenSdkFlutterSession _session;
  final CitizenSdkFlutterCodec _codec;

  @override
  CitizenSdkOperation<CitizenQrReview> reviewQrRequest(String signRequest) =>
      _session.operation(
        'reviewQrRequest',
        fields: [signRequest],
        decode: (value) {
          final facts = _codec.decodeQrReview(value[1]);
          return _CitizenQrReview(
            _session,
            _resourceId(value[0]),
            facts.document,
            facts.palletName,
            facts.callName,
            facts.callArguments,
          );
        },
      );

  @override
  CitizenSdkOperation<CitizenQrSigned> signQrRequest(CitizenQrReview review) {
    if (review is! _CitizenQrReview ||
        !identical(review._session, _session) ||
        review._released ||
        review._signing) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: '审阅资源无效、已使用或不属于本实例',
      );
    }
    final operation = _session.operation<CitizenQrSigned>(
      'signQrRequest',
      fields: [review._id],
      decode: (value) {
        final document = _codec.decodeQrDocument(value[0], signed: true);
        return CitizenQrSigned(
          canonicalText: document.canonicalText,
          qrImage: CitizenQrImage(
            width: value[1]! as int,
            height: value[2]! as int,
            luminance: value[3]! as Uint8List,
          ),
          requestId: document.requestId!,
          signerAccountId: document.signerAccountId!,
          signature: document.signature!,
          signRequest: document.signRequest!,
        );
      },
    );
    // 单次提交由原生/Core所有权守卫最终裁决；Dart只阻止同对象并发调用。
    review._signing = true;
    return CitizenSdkOperation(
      operationId: operation.operationId,
      result: operation.result.whenComplete(() {
        review._signing = false;
      }),
      cancel: operation.cancel,
    );
  }

  @override
  CitizenSdkOperation<CitizenWalletSignature> sign({
    required String accountId,
    required Uint8List payload,
  }) {
    if (payload.length > CitizenSdkFlutterCodec.maximumSigningPayloadBytes) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: '签名payload超过16MiB',
      );
    }
    final copy = Uint8List.fromList(payload);
    try {
      final operation = _session.operation<CitizenWalletSignature>(
        'signWalletPayload',
        fields: [accountId, copy],
        decode: (value) =>
            _codec.decodeSignature(accountId: accountId, raw: value[0]),
      );
      return CitizenSdkOperation(
        operationId: operation.operationId,
        result: operation.result.whenComplete(() {
          copy.fillRange(0, copy.length, 0);
        }),
        cancel: operation.cancel,
      );
    } on Object {
      copy.fillRange(0, copy.length, 0);
      rethrow;
    }
  }

  @override
  CitizenSdkOperation<CitizenSigningOutcome> begin(
    CitizenSigningIntent intent,
  ) => _session.operation(
    'beginSigning',
    fields: [
      intent.accountId,
      Uint8List.fromList(intent.payload),
      intent.transform.kind.name,
      Uint8List.fromList(intent.transform.domain),
      intent.externalSignerTransport?.name ?? 'none',
      intent.opaqueAction,
      intent.ttlSeconds,
    ],
    decode: (value) => _codec.decodeSigningOutcome(value[0]),
  );

  @override
  CitizenSdkOperation<CitizenSigningCompleted> consumeExternalSignature({
    required String sessionId,
    required String response,
  }) => _session.operation(
    'consumeExternalSignature',
    fields: [sessionId, response],
    decode: (value) {
      final outcome = _codec.decodeSigningOutcome(value[0]);
      if (outcome is! CitizenSigningCompleted) {
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.decode,
          message: '外部签名未返回完成结果',
        );
      }
      return outcome;
    },
  );

  @override
  Future<bool> cancel(String sessionId) async =>
      (await _session.invoke('cancelSigning', fields: [sessionId]))[0]! as bool;
}

final class _CitizenWalletInspection implements CitizenWalletInspection {
  _CitizenWalletInspection(this._session, this._codec, this._id, this.state) {
    _session.registerResource(release);
  }
  final CitizenSdkFlutterSession _session;
  final CitizenSdkFlutterCodec _codec;
  final String _id;
  @override
  final CitizenWalletState state;
  bool _released = false;
  Future<void>? _releasing;

  CitizenSdkOperation<CitizenWalletState> _change(
    String method,
    int index, [
    String? name,
  ]) {
    if (_released || _releasing != null)
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidState,
        message: '钱包检查资源正在释放或已释放',
      );
    if (!state.diagnostics.any((record) => record.walletIndex == index))
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.notFound,
        message: '检查快照中没有该异常钱包',
      );
    // 只交不透明资源号和目标索引；原记录、修订与授权由Core保有并重新核实。
    return _session.operation(
      method,
      fields: [_id, index, if (name != null) name.trim()],
      decode: (value) => _codec.decodeWalletState(value[0]),
    );
  }

  @override
  CitizenSdkOperation<CitizenWalletState> repairHot(int walletIndex) =>
      _change('repairHotWallet', walletIndex);
  @override
  CitizenSdkOperation<CitizenWalletState> rename({
    required int walletIndex,
    required String name,
  }) => _change('renameDiagnosticWallet', walletIndex, name);
  @override
  CitizenSdkOperation<CitizenWalletState> delete(int walletIndex) =>
      _change('deleteDiagnosticWallet', walletIndex);
  @override
  Future<void> release() {
    if (_released) return Future<void>.value();
    return _releasing ??= _release();
  }

  Future<void> _release() async {
    try {
      await _session.invoke('releaseWalletInspection', fields: [_id]);
      _released = true;
      _session.unregisterResource(release);
    } on Object {
      _releasing = null;
      rethrow;
    }
  }
}

final class _CitizenQrReview implements CitizenQrReview {
  _CitizenQrReview(
    this._session,
    this._id,
    this.document,
    this.palletName,
    this.callName,
    this.callArguments,
  ) {
    _session.registerResource(release);
  }
  final CitizenSdkFlutterSession _session;
  final String _id;
  @override
  final CitizenQrDocument document;
  @override
  final String palletName;
  @override
  final String callName;
  @override
  final String callArguments;
  @override
  String get requestId => document.requestId!;
  @override
  String get signerAccountId => document.signerAccountId!;
  @override
  int get expiresAt => document.expiresAt!;
  bool _released = false;
  bool _signing = false;
  Future<void>? _releasing;
  @override
  Future<void> release() {
    if (_released) return Future<void>.value();
    return _releasing ??= _release();
  }

  Future<void> _release() async {
    try {
      await _session.invoke('releaseQrReview', fields: [_id]);
      _released = true;
      _session.unregisterResource(release);
    } on Object {
      _releasing = null;
      rethrow;
    }
  }
}

final class _CitizenQr implements CitizenQr {
  @override
  Future<CitizenQrDocument> encodeDocument(CitizenQrContent content) async {
    final value = await _session.invoke(
      'qrEncodeDocument',
      fields: [content.inputJson],
    );
    return const CitizenSdkFlutterCodec().decodeQrDocument(value[0]);
  }

  @override
  Future<CitizenQrAuthorization> prepareAccountAuthorization({
    required int action,
    required Uint8List payload,
    required String accountId,
  }) async {
    final value = await _session.invoke(
      'qrPrepareAccountAuthorization',
      fields: [action, payload, accountId],
    );
    return const CitizenSdkFlutterCodec().decodeQrAuthorization(value[0]);
  }

  const _CitizenQr(this._session);

  final CitizenSdkFlutterSession _session;

  @override
  Future<CitizenQrScanResult> parseForPurpose(
    String text,
    CitizenQrScanPurpose purpose,
  ) async {
    final document = await parse(text);
    // 只投影Core给出的允许集，不在Dart另写kind→用途表。
    if (document.scanPurposeMask & (1 << (purpose.value - 1)) == 0) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: '二维码不属于当前扫码用途',
      );
    }
    return CitizenQrScanResult(purpose: purpose, document: document);
  }

  @override
  Future<CitizenQrCapture> openCapture(CitizenQrScanPurpose purpose) async {
    final value = await _session.invoke(
      'openQrCapture',
      fields: [purpose.value],
    );
    final capture = _CitizenQrCapture(
      _session,
      _resourceId(value[0]),
      value[1]! as int,
      const CitizenSdkFlutterCodec().decodeQrPreview(value.sublist(2)),
      purpose,
    );
    try {
      await capture.resume();
      return capture;
    } on Object {
      await capture.close();
      rethrow;
    }
  }

  @override
  Future<List<CitizenQrScanResult>> decodeImage(
    Uint8List encodedImage,
    CitizenQrScanPurpose purpose,
  ) async {
    final value = await _session.invoke(
      'qrDecodeImage',
      fields: [Uint8List.fromList(encodedImage), purpose.value],
    );
    return List<CitizenQrScanResult>.unmodifiable(
      (value[0]! as List<Object?>).map((raw) {
        final document = const CitizenSdkFlutterCodec().decodeQrDocument(raw);
        if (document.scanPurposeMask & (1 << (purpose.value - 1)) == 0) {
          throw const CitizenSdkException(
            code: CitizenSdkErrorCode.invalidArgument,
            message: '图片二维码不属于当前用途',
          );
        }
        return CitizenQrScanResult(purpose: purpose, document: document);
      }),
    );
  }

  @override
  Future<CitizenQrDocument> parse(String text) async {
    final value = await _session.invoke('qrParse', fields: <Object?>[text]);
    return const CitizenSdkFlutterCodec().decodeQrDocument(value[0]);
  }

  @override
  Future<String> createSignRequest({
    required int action,
    required String signerAccountId,
    required Uint8List reviewPayload,
    int ttlSeconds = 120,
  }) async =>
      (await _session.invoke(
            'qrCreateSignRequest',
            fields: <Object?>[
              action,
              signerAccountId,
              Uint8List.fromList(reviewPayload),
              ttlSeconds,
            ],
          ))[0]!
          as String;

  @override
  Future<void> validateSignResponse({
    required String sessionId,
    required String response,
  }) async {
    await _session.invoke(
      'qrValidateSignResponse',
      fields: [sessionId, response],
    );
  }

  @override
  Future<Uint8List> consumeSignResponse(String signResponse) async {
    final value = await _session.invoke(
      'qrConsumeSignResponse',
      fields: <Object?>[signResponse],
    );
    return Uint8List.fromList(value[0]! as Uint8List).asUnmodifiableView();
  }

  @override
  Future<bool> cancelSignRequest(String requestId) async =>
      (await _session.invoke(
            'qrCancelSignRequest',
            fields: <Object?>[requestId],
          ))[0]!
          as bool;

  @override
  Future<String> encodeAccountId(String accountId) async =>
      (await _session.invoke(
            'qrEncodeAccountId',
            fields: <Object?>[accountId],
          ))[0]!
          as String;

  @override
  Future<CitizenQrScanResult> decodeLuminance({
    required Uint8List data,
    required int width,
    required int height,
    required int rowStride,
    required CitizenQrScanPurpose purpose,
  }) async {
    final value = await _session.invoke(
      'qrDecodeLuminance',
      fields: <Object?>[Uint8List.fromList(data), width, height, rowStride],
    );
    final document = const CitizenSdkFlutterCodec().decodeQrDocument(value[0]);
    if (document.scanPurposeMask & (1 << (purpose.value - 1)) == 0) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: '二维码不属于当前用途',
      );
    }
    return CitizenQrScanResult(purpose: purpose, document: document);
  }

  @override
  Future<CitizenQrImage> encode(String text, {int scale = 4}) async {
    final value = await _session.invoke(
      'qrEncode',
      fields: <Object?>[text, scale],
    );
    return CitizenQrImage(
      width: value[0]! as int,
      height: value[1]! as int,
      luminance: value[2]! as Uint8List,
    );
  }
}

final class _CitizenQrCapture implements CitizenQrCapture {
  _CitizenQrCapture(
    this._session,
    this._id,
    this.textureId,
    this._preview,
    this._purpose,
  ) {
    _session.registerResource(close);
    _events = _session.events.listen((event) {
      if (event is! CitizenSdkQrCaptureEvent ||
          event.resourceId != _id ||
          _closed)
        return;
      if (event.preview != null) {
        _preview = event.preview!;
        _previews.add(_preview);
      }
      if (event.result != null && !_closingRequested) {
        if (event.result!.purpose != _purpose) {
          _errors.add(
            const CitizenSdkException(
              code: CitizenSdkErrorCode.integrity,
              message: '采集用途与资源不一致',
            ),
          );
          unawaited(close());
        } else {
          _results.add(event.result!);
        }
      }
      if (event.error != null) _errors.add(event.error!);
      if (event.closed) {
        unawaited(
          close().catchError((Object error) {
            if (!_closed && error is CitizenSdkException) _errors.add(error);
          }),
        );
      }
    });
    if (_session.hasResourceClosed(_id)) unawaited(close());
  }
  final CitizenSdkFlutterSession _session;
  final String _id;
  final CitizenQrScanPurpose _purpose;
  @override
  final int textureId;
  CitizenQrPreview _preview;
  @override
  CitizenQrPreview get preview => _preview;
  final _results = StreamController<CitizenQrScanResult>.broadcast();
  final _errors = StreamController<CitizenSdkException>.broadcast();
  final _previews = StreamController<CitizenQrPreview>.broadcast();
  late final StreamSubscription<CitizenSdkEvent> _events;
  bool _closed = false;
  bool _closingRequested = false;
  Future<void>? _closing;
  @override
  Stream<CitizenQrScanResult> get results => _results.stream;
  @override
  Stream<CitizenSdkException> get errors => _errors.stream;
  @override
  Stream<CitizenQrPreview> get previewChanges => _previews.stream;
  @override
  Future<void> setTorch(bool enabled) async {
    await _session.invoke('setQrCaptureTorch', fields: [_id, enabled]);
  }

  @override
  Future<void> pause() async {
    await _session.invoke('pauseQrCapture', fields: [_id]);
  }

  @override
  Future<void> resume() async {
    if (_closingRequested)
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.cancelled,
        message: '采集资源已关闭',
      );
    await _session.invoke('resumeQrCapture', fields: [_id]);
  }

  @override
  Future<void> close() {
    if (_closed) return Future<void>.value();
    _closingRequested = true;
    return _closing ??= _close();
  }

  Future<void> _close() async {
    try {
      await _session.invoke('closeQrCapture', fields: [_id]);
      _closed = true;
      _session.unregisterResource(close);
      _session.acknowledgeResourceClosed(_id);
      await _events.cancel();
      // 暂停的宿主Stream订阅不能阻塞已真实排空的相机/纹理释放。
      unawaited(_results.close());
      unawaited(_errors.close());
      unawaited(_previews.close());
    } on Object {
      _closing = null;
      rethrow;
    }
  }
}

final class _CitizenTransactions implements CitizenTransactions {
  const _CitizenTransactions(this._session, this._codec);

  final CitizenSdkFlutterSession _session;
  final CitizenSdkFlutterCodec _codec;

  @override
  Future<CitizenPreparedTransaction> prepareTransaction(
    Uint8List sourceAccountId,
    Uint8List callData,
  ) async {
    if (sourceAccountId.length != 32) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: 'sourceAccountId 必须是 32 字节',
      );
    }
    if (callData.isEmpty ||
        callData.length >
            CitizenSdkFlutterCodec.maximumTransactionCallDataBytes) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: 'callData 必须包含 1..1 MiB 字节',
      );
    }
    final source = Uint8List.fromList(sourceAccountId);
    final call = Uint8List.fromList(callData);
    final value = await _session.invoke(
      'prepareTransaction',
      fields: <Object?>[citizenAccountIdFromBytes(source), call],
    );
    final prepared = _codec.decodePreparedTransaction(value[0]);
    if (!_bytesEqual(prepared.sourceAccountId, source)) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.integrity,
        message: 'transaction preparation source 与请求不一致',
      );
    }
    return prepared;
  }

  @override
  Future<void> cancelPreparedTransaction(String preparationId) async {
    await _session.invoke(
      'cancelPreparedTransaction',
      fields: <Object?>[preparationId],
    );
  }

  @override
  Future<CitizenTransactionExecution> executePreparedTransaction(
    String preparationId,
  ) async {
    final value = await _session.invoke(
      'executePreparedTransaction',
      fields: <Object?>[preparationId],
    );
    return _codec.decodeTransactionExecution(value[0]);
  }

  @override
  Future<CitizenTransactionExecutionCompleted>
  consumePreparedTransactionQrResponse(
    String executionId,
    String response,
  ) async {
    final value = await _session.invoke(
      'consumePreparedTransactionQrResponse',
      fields: <Object?>[executionId, response],
    );
    final completed = _codec.decodeTransactionExecution(value[0]);
    if (completed is! CitizenTransactionExecutionCompleted) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.integrity,
        message: 'QR_V1 response 未返回 transaction terminal',
      );
    }
    return completed;
  }

  @override
  Future<void> cancelPreparedTransactionExecution(String executionId) async {
    await _session.invoke(
      'cancelPreparedTransactionExecution',
      fields: <Object?>[executionId],
    );
  }
}

bool _bytesEqual(Uint8List left, Uint8List right) {
  if (left.length != right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

bool _startsWithBytes(Uint8List value, Uint8List prefix) {
  if (value.length < prefix.length) return false;
  for (var index = 0; index < prefix.length; index += 1) {
    if (value[index] != prefix[index]) return false;
  }
  return true;
}

int _compareBytes(Uint8List left, Uint8List right) {
  final shared = left.length < right.length ? left.length : right.length;
  for (var index = 0; index < shared; index += 1) {
    final difference = left[index] - right[index];
    if (difference != 0) return difference;
  }
  return left.length - right.length;
}

final class _CitizenHistory implements CitizenHistory {
  const _CitizenHistory(this._session, this._codec);

  final CitizenSdkFlutterSession _session;
  final CitizenSdkFlutterCodec _codec;

  @override
  Future<CitizenTransactionHistoryPage> getTransactionHistory({
    String? beforeExecutionId,
    int limit = 100,
  }) async {
    if (limit < 1 || limit > 100) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.invalidArgument,
        message: '交易历史 limit 必须在 1..100 范围内',
      );
    }
    final value = await _session.invoke(
      'getTransactionHistory',
      fields: <Object?>[beforeExecutionId, limit],
    );
    return _codec.decodeTransactionHistoryPage(value[0]);
  }

  @override
  Future<CitizenTransactionHistoryPage> syncTransactionHistory() async {
    final value = await _session.invoke('syncTransactionHistory');
    return _codec.decodeTransactionHistoryPage(value[0]);
  }
}

void _requireCount(
  int count, {
  required int minimum,
  required int maximum,
  required String label,
}) {
  if (count < minimum || count > maximum) {
    throw CitizenSdkException(
      code: CitizenSdkErrorCode.invalidArgument,
      message: '$label 必须包含 $minimum..$maximum 项',
    );
  }
}
