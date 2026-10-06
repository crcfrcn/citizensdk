import 'dart:convert';

import 'package:citizen_sdk/src/api/citizen_sdk_error.dart';
import 'package:citizen_sdk/src/api/citizen_qr.dart';
import 'package:citizen_sdk/src/models/citizen_signing.dart';
import 'package:citizen_sdk/src/api/citizen_sdk_events.dart';
import 'package:citizen_sdk/src/account_codec.dart';
import 'package:citizen_sdk/src/models/citizen_capability.dart';
import 'package:citizen_sdk/src/models/citizen_chain_state.dart';
import 'package:citizen_sdk/src/models/citizen_transaction.dart';
import 'package:citizen_sdk/src/models/citizen_wallet.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_flutter_codec.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('派生序号范围与冷目录编号独立，旧上界后的序号可选', () {
    const codec = CitizenSdkFlutterCodec();
    for (final indices in [
      [1, 1989, 1990, 19890604],
      [60000],
    ]) {
      expect(
        () => codec.encodeRequest(
          method: 'addWalletAccounts',
          sessionId: 's',
          requestSequence: 1,
          fields: ['synthetic', '', indices],
        ),
        returnsNormally,
      );
    }
    for (final indices in [
      [0],
      [-1],
      [19890605],
      [8, 19890605],
      [8, 8],
    ]) {
      expect(
        () => codec.encodeRequest(
          method: 'addWalletAccounts',
          sessionId: 's',
          requestSequence: 1,
          fields: ['synthetic', '', indices],
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    final id = _account(1);
    final state = codec.decodeWalletState([
      '1',
      null,
      [
        [
          'cold',
          19890605,
          null,
          id,
          citizenSs58FromAccountId(id),
          '冷账户',
          '1',
          true,
        ],
      ],
      1,
      false,
      19890605,
      <Object?>[],
    ]);
    expect(state.accounts.single.walletIndex, 19890605);
    final child = _account(2);
    List<Object?> profile(int index) => [
      0,
      'imported',
      '1',
      id,
      child,
      [
        [0, id, citizenSs58FromAccountId(id), '账户0', '1', false],
        [index, child, citizenSs58FromAccountId(child), '高序号', '1', true],
      ],
      '钱包',
    ];
    expect(
      codec.decodeWalletProfile(profile(19890604))!.accounts.last.index,
      19890604,
    );
    expect(
      () => codec.decodeWalletProfile(profile(19890605)),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  const codec = CitizenSdkFlutterCodec();

  test('钱包元数据请求严格绑定修订和u32索引，不携带签名或默认顺序', () {
    expect(
      codec.encodeRequest(
        method: 'setActiveWallet',
        sessionId: 's',
        requestSequence: 1,
        fields: ['18446744073709551615', 0xffffffff],
      ),
      [2, 's', 1, '18446744073709551615', 0xffffffff],
    );
    expect(
      codec.encodeRequest(
        method: 'renameWallet',
        sessionId: 's',
        requestSequence: 2,
        fields: ['1', 0, '独立钱包名'],
      ),
      [2, 's', 2, '1', 0, '独立钱包名'],
    );
    for (final fields in <List<Object?>>[
      ['01', 0],
      ['18446744073709551616', 0],
      ['1', -1],
      ['1', 0x100000000],
      ['1', 0, 'unexpected'],
    ]) {
      expect(
        () => codec.encodeRequest(
          method: 'setActiveWallet',
          sessionId: 's',
          requestSequence: 3,
          fields: fields,
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    for (final name in ['', '未修剪 ', '名' * 31, '坏\u0085名']) {
      expect(
        () => codec.encodeRequest(
          method: 'renameWallet',
          sessionId: 's',
          requestSequence: 4,
          fields: ['1', 0, name],
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
  });

  test('新profile和state只接受完整新元组，名称与选择分别保持', () {
    final id = _account(1);
    final address = citizenSs58FromAccountId(id);
    final profile = <Object?>[
      0,
      'created',
      '1',
      id,
      id,
      <Object?>[
        <Object?>[0, id, address, '账户名称', '1', true],
      ],
      '钱包名称',
    ];
    final state = <Object?>[
      '7',
      profile,
      <Object?>[
        <Object?>['hot', 0, 0, id, address, '账户名称', '1', true],
      ],
      1,
      false,
      0,
      <Object?>[],
    ];
    final decoded = codec.decodeWalletState(state);
    expect(decoded.hotProfile!.walletName, '钱包名称');
    expect(decoded.accounts.single.name, '账户名称');
    expect(decoded.activeWalletIndex, 0);
    expect(
      codec.decodeWalletState([
        ...state.take(5),
        null,
        <Object?>[],
      ]).activeWalletIndex,
      isNull,
    );
    expect(
      () => codec.decodeWalletProfile(profile.take(6).toList()),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeWalletState(state.take(5).toList()),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeWalletState([...state.take(5), 1, <Object?>[]]),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeWalletProfile([...profile.take(6), '']),
      throwsA(isA<CitizenSdkException>()),
    );
    final mismatched = <Object?>[...state];
    mismatched[2] = <Object?>[
      <Object?>['hot', 0, 0, id, address, '另一个名称', '1', true],
    ];
    expect(
      () => codec.decodeWalletState(mismatched),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('异常钱包不是空目录或可签名账户，原模式和可信清理目标严格投影', () {
    final id = _account(1);
    List<Object?> diagnostic() => [
      0,
      '原钱包',
      id,
      null,
      3,
      'hot',
      [
        [id, _account(2)],
        true,
      ],
    ];
    List<Object?> snapshot(Object? value) => [
      '7',
      null,
      <Object?>[],
      1,
      false,
      0,
      [value],
    ];
    final state = codec.decodeWalletState(snapshot(diagnostic()));
    expect(state.accounts, isEmpty);
    expect(state.defaultAccount, isNull);
    expect(state.activeWalletAccount, isNull);
    expect(state.initializationState, CitizenWalletInitializationState.ready);
    expect(state.diagnostics.single.signMode, CitizenWalletSignMode.hot);
    expect(state.diagnostics.single.ss58Address, isNull);
    expect(state.diagnostics.single.cleanupTargets!.accountIds, [
      id,
      _account(2),
    ]);
    expect(() => state.diagnostics.clear(), throwsUnsupportedError);
    expect(
      () => state.diagnostics.single.cleanupTargets!.accountIds.clear(),
      throwsUnsupportedError,
    );
    final unknown = diagnostic();
    unknown[5] = null;
    unknown[6] = null;
    expect(
      codec
          .decodeWalletState(snapshot(unknown))
          .diagnostics
          .single
          .cleanupTargets,
      isNull,
    );
    for (final change in <void Function(List<Object?>)>[
      (v) => v.removeLast(),
      (v) => v.add(1),
      (v) => v[4] = 0,
      (v) => v[4] = 4,
      (v) => v[5] = 'legacy',
      (v) => v[3] = 'a' * 129,
      (v) => v[6] = [[], false],
      (v) => v[6] = [
        [id, id],
        true,
      ],
      (v) => v[6] = [
        [_account(2), id],
        true,
      ],
      (v) => v[6] = [
        [id],
        1,
      ],
    ]) {
      final value = diagnostic();
      change(value);
      expect(
        () => codec.decodeWalletState(snapshot(value)),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    for (final method in [
      'repairHotWallet',
      'deleteDiagnosticWallet',
      'renameDiagnosticWallet',
    ]) {
      final fields = <Object?>[
        'inspection-owned',
        0,
        if (method == 'renameDiagnosticWallet') '名字',
      ];
      expect(
        codec
            .encodeRequest(
              method: method,
              sessionId: 's',
              requestSequence: 1,
              fields: fields,
            )
            .sublist(3),
        fields,
      );
      expect(
        () => codec.encodeRequest(
          method: method,
          sessionId: 's',
          requestSequence: 2,
          fields: [...fields, true],
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
  });

  test('非消费验签只传会话与响应，不接受宿主时间或transform', () {
    expect(
      codec.encodeRequest(
        method: 'qrValidateSignResponse',
        sessionId: 'sdk',
        requestSequence: 1,
        fields: ['request', '{}'],
      ),
      [2, 'sdk', 1, 'request', '{}'],
    );
    for (final fields in <List<Object?>>[
      [],
      ['request'],
      ['', '{}'],
      ['x' * 129, '{}'],
      ['request', '{}', 1],
    ]) {
      expect(
        () => codec.encodeRequest(
          method: 'qrValidateSignResponse',
          sessionId: 'sdk',
          requestSequence: 2,
          fields: fields,
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
  });

  test('编码输入只是规范字段，纯载荷编码不建立session或复制算法', () {
    final contact = CitizenQrContent.userContact(
      cidNumber: 'CID-7',
      accountId: _account(7),
    );
    expect(jsonDecode(contact.inputJson), {
      'kind': 3,
      'cid_number': 'CID-7',
      'account_id': _account(7),
    });
    expect(
      codec.encodeRequest(
        method: 'qrEncodeDocument',
        sessionId: 's',
        requestSequence: 1,
        fields: [contact.inputJson],
      ),
      [2, 's', 1, contact.inputJson],
    );
    final payload = CitizenSigningPayload.message(
      opTag: 16,
      scalePayload: Uint8List(0),
    );
    final fields = codec.encodeSigningPayload(payload);
    expect(fields[0], 2);
    expect(fields[1], 1);
    expect(jsonDecode(fields[2]! as String), {'op_tag': 16});
    expect(fields[3], isEmpty);
    expect(codec.decodeSigningPayload([2, Uint8List(32)], 1), hasLength(32));
    expect(
      () => codec.decodeSigningPayload([2, Uint8List(31)], 1),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeSigningPayload([1, Uint8List(32)], 1),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.encodeRequest(
        method: 'encodeSigningPayload',
        sessionId: 's',
        requestSequence: 1,
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('授权准备只读事实支持完整u64，拒绝无效原因和假成功字段', () {
    final value = <String, Object?>{
      'reason': 0,
      'genesis_hash': _account(7),
      'cid_number': 'CID',
      'current_account_id': null,
      'expected_binding_revision': '18446744073709551615',
      'expires_at': '100',
      'materialized_payload': '0x0102',
    };
    final result = codec.decodeQrAuthorization(jsonEncode(value));
    expect(
      result.expectedBindingRevision,
      BigInt.parse('18446744073709551615'),
    );
    expect(result.materializedPayload, [1, 2]);
    expect(() => result.materializedPayload![0] = 7, throwsUnsupportedError);
    // 每一个成功字段独立污染失败结果时都必须拒绝，不能依赖JSON字段顺序。
    for (final key in value.keys.where((key) => key != 'reason')) {
      final invalid = <String, Object?>{
        for (final field in value.keys) field: null,
      };
      invalid['reason'] = 2;
      invalid[key] = value[key] ?? '0x${'11' * 32}';
      expect(
        () => codec.decodeQrAuthorization(jsonEncode(invalid)),
        throwsA(isA<CitizenSdkException>()),
        reason: key,
      );
    }
    expect(
      () => codec.decodeQrAuthorization(jsonEncode({...value, 'reason': 4})),
      throwsA(isA<CitizenSdkException>()),
    );
    final rejected = codec.decodeQrAuthorization(
      jsonEncode({
        for (final key in value.keys) key: key == 'reason' ? 2 : null,
      }),
    );
    expect(rejected.reason, CitizenQrAuthorizationReason.invalidAccountId);
  });

  test('匿名请求不伪造账户，附加当前账户证明必须成对', () {
    final request = <String, Object?>{
      'kind': 1,
      'canonical_text': 'core-request',
      'scan_purpose_mask': 80,
      'request_id': '0123456789abcdef',
      'expires_at': 100,
      'action': 10,
      'signer_account_id': null,
      'review_payload': '0x01',
    };
    expect(codec.decodeQrDocument(jsonEncode(request)).signerAccountId, isNull);
    final response = <String, Object?>{
      'kind': 2,
      'canonical_text': 'core-response',
      'scan_purpose_mask': 8,
      'request_id': '0123456789abcdef',
      'expires_at': 100,
      'signer_account_id': _account(7),
      'signature': '0x${'08' * 64}',
      'current_account_id': _account(9),
      'current_account_signature': '0x${'0a' * 64}',
    };
    expect(
      codec.decodeQrDocument(jsonEncode(response)).currentAccountId,
      _account(9),
    );
    expect(
      () => codec.decodeQrDocument(
        jsonEncode({...response, 'current_account_signature': null}),
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('QR公开文档严格闭集，拒绝旧now tuple、外部签名拼装和非法结果', () {
    final json = <String, Object?>{
      'kind': 2,
      'canonical_text': 'response',
      'scan_purpose_mask': 8,
      'request_id': 'request-identifier',
      'expires_at': 1700000000,
      'signer_account_id': _account(1),
      'signature': '0x${'ab' * 64}',
      // k2两项附加证明固定在公开闭集中；没有证明时必须成对为null。
      'current_account_id': null,
      'current_account_signature': null,
    };
    final document = codec.decodeQrDocument(jsonEncode(json));
    expect(document.signature, hasLength(64));
    expect(() => document.signature![0] = 1, throwsUnsupportedError);
    expect(
      () => codec.decodeQrDocument(
        jsonEncode(<String, Object?>{...json, 'private_key': 'forbidden'}),
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeQrDocument(
        jsonEncode(<String, Object?>{...json, 'signature': '0x01'}),
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeQrDocument(jsonEncode(json), signed: true),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.encodeRequest(
        method: 'qrParse',
        sessionId: 's',
        requestSequence: 1,
        fields: <Object?>['request', 10],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(CitizenSdkFlutterCodec.methods, isNot(contains('qrSigningInput')));
    expect(
      CitizenSdkFlutterCodec.methods,
      isNot(contains('qrCreateSignResponse')),
    );
    expect(CitizenSdkFlutterCodec.methods, isNot(contains('qrEncodeImage')));
    expect(
      CitizenSdkFlutterCodec.methods,
      isNot(contains('qrEncodeUserTransfer')),
    );
    expect(
      () => codec.decodeQrDocument(
        jsonEncode(<String, Object?>{
          'kind': 4,
          'canonical_text': '{}',
          'request_id': 'request-identifier',
          'expires_at': 1700000000,
          'account_id': _account(1),
        }),
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('历史通知只含 sequence，拒绝额外 payload 与无效顺序号', () {
    final decoded = codec.decodeEvent(<Object?>[
      2,
      'session',
      7,
      'historyChanged',
      <Object?>[],
    ]);
    expect(decoded.event, isA<CitizenSdkHistoryChanged>());
    expect(decoded.event.sequence, 7);
    expect(
      () => codec.decodeEvent(<Object?>[
        2,
        'session',
        8,
        'historyChanged',
        <Object?>[1],
      ]),
      throwsA(isA<Object>()),
    );
    expect(
      () => codec.decodeEvent(<Object?>[
        2,
        'session',
        0,
        'historyChanged',
        <Object?>[],
      ]),
      throwsA(isA<Object>()),
    );
  });

  test('finalized 通知携带准确 finalized block，拒绝 best 冒充', () {
    final decoded = codec.decodeEvent(<Object?>[
      2,
      'session',
      9,
      'finalizedBlockChanged',
      <Object?>[
        <Object?>[_account(3), '77', 'finalized'],
      ],
    ]);
    final event = decoded.event as CitizenSdkFinalizedBlockChanged;
    expect(event.finalized.number, BigInt.from(77));
    expect(
      () => codec.decodeEvent(<Object?>[
        2,
        'session',
        10,
        'finalizedBlockChanged',
        <Object?>[
          <Object?>[_account(3), '77', 'best'],
        ],
      ]),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('五平台 Flutter 的固定方法使用固定长度 tuple 且没有 Map 兼容旁路', () {
    const expectedMethods = <String>{
      'open',
      'start',
      'stop',
      'close',
      'getCapabilities',
      'getFinalizedHead',
      'getSyncStatus',
      'getBestHead',
      'getFinalizedBlockAt',
      'resolveFinalizedBlock',
      'getBlockHeader',
      'getBlockBody',
      'getRuntimeContext',
      'getStorage',
      'getStorageBatch',
      'getStorageKeysPaged',
      'callRuntimeApi',
      'getSystemEvents',
      'exportState',
      'importState',
      'getGenesisHash',
      'getAccountBalance',
      'getAccountBalances',
      'getAccountNonce',
      'getFeeSnapshot',
      'getWalletState',
      'inspectWallets',
      'releaseWalletInspection',
      'repairHotWallet',
      'renameDiagnosticWallet',
      'deleteDiagnosticWallet',
      'validateWalletPassword',
      'validateWalletMnemonic',
      'walletWordSuggestions',
      'prepareWalletCreation',
      'copyRecoveryPhrase',
      'commitWalletCreation',
      'releasePreparedWallet',
      'openPrivateKey',
      'revealPrivateKey',
      'closePrivateKey',
      'cancelOperation',
      'respondCredential',
      'cancelCredential',
      'addNextWalletAccount',
      'signAndDeleteWallet',
      'importColdAccountCode',
      'importColdAccountId',
      'importColdAccountSs58',
      'reorderWalletAccountsWithoutDefaultChange',
      'setActiveWallet',
      'renameWallet',
      'renameAccount',
      'deleteAccount',
      'importWallet',
      'addWalletAccounts',
      'setActiveWalletAccount',
      'deleteWallet',
      'reconcileWalletCleanup',
      'signWalletPayload',
      'beginSigning',
      'consumeExternalSignature',
      'cancelSigning',
      'beginDefaultAccountChange',
      'consumeDefaultAccountChange',
      'verifySignature',
      'encodeSigningPayload',
      'qrEncodeDocument',
      'qrPrepareAccountAuthorization',
      'prepareTransaction',
      'cancelPreparedTransaction',
      'executePreparedTransaction',
      'consumePreparedTransactionQrResponse',
      'cancelPreparedTransactionExecution',
      'getTransactionHistory',
      'syncTransactionHistory',
      'qrParse',
      'qrCreateSignRequest',
      'qrValidateSignResponse',
      'qrConsumeSignResponse',
      'qrCancelSignRequest',
      'qrEncodeAccountId',
      'qrDecodeLuminance',
      'qrEncode',
      'reviewQrRequest',
      'releaseQrReview',
      'openQrCapture',
      'closeQrCapture',
      'pauseQrCapture',
      'resumeQrCapture',
      'setQrCaptureTorch',
      'qrDecodeImage',
      'signQrRequest',
    };
    expect(CitizenSdkFlutterCodec.methods, expectedMethods);
    expect(codec.encodeOpen(), <Object?>[2, CitizenSdkModules.full, false]);
    expect(codec.encodeOpen(CitizenSdkModules.signing), <Object?>[2, 2, false]);
    for (final invalid in <int>[0, -1, 0x100000000]) {
      expect(
        () => codec.encodeOpen(invalid),
        throwsA(isA<CitizenSdkException>()),
      );
    }

    final account = _account(1);
    final finalizedBlock = <Object?>[account, '1', 'finalized'];
    final requestFields = <String, List<Object?>>{
      for (final method in <String>[
        'start',
        'stop',
        'close',
        'getCapabilities',
        'getFinalizedHead',
        'getSyncStatus',
        'getBestHead',
        'exportState',
        'getGenesisHash',
        'getFeeSnapshot',
        'getWalletState',
        'inspectWallets',
        'deleteWallet',
        'signAndDeleteWallet',
        'reconcileWalletCleanup',
      ])
        method: const <Object?>[],
      'getFinalizedBlockAt': const <Object?>['1'],
      'resolveFinalizedBlock': <Object?>[account, '1'],
      'getBlockHeader': <Object?>[finalizedBlock],
      'getBlockBody': <Object?>[finalizedBlock],
      'getRuntimeContext': <Object?>[finalizedBlock],
      'getStorage': <Object?>[
        finalizedBlock,
        Uint8List.fromList(<int>[1]),
      ],
      'getStorageBatch': <Object?>[
        finalizedBlock,
        <Uint8List>[
          Uint8List.fromList(<int>[1]),
          Uint8List.fromList(<int>[2]),
        ],
      ],
      'getStorageKeysPaged': <Object?>[
        finalizedBlock,
        Uint8List.fromList(<int>[1]),
        null,
        1000,
      ],
      'callRuntimeApi': <Object?>[
        finalizedBlock,
        'CitizenApi_items',
        Uint8List(0),
      ],
      'getSystemEvents': <Object?>[finalizedBlock],
      'importState': <Object?>[
        1,
        finalizedBlock,
        Uint8List.fromList(<int>[1]),
      ],
      for (final method in <String>[
        'getAccountBalance',
        'getAccountNonce',
        'setActiveWalletAccount',
        'deleteAccount',
      ])
        method: <Object?>[account],
      'getAccountBalances': <Object?>[
        <String>[account, account],
      ],
      'validateWalletPassword': <Object?>[''],
      'validateWalletMnemonic': <Object?>['synthetic', 18],
      'walletWordSuggestions': <Object?>['aban'],
      'prepareWalletCreation': <Object?>[18, ''],
      'copyRecoveryPhrase': <Object?>['prepared-owned'],
      'commitWalletCreation': <Object?>['prepared-owned'],
      'releasePreparedWallet': <Object?>['prepared-owned'],
      'releaseWalletInspection': <Object?>['inspection-owned'],
      'repairHotWallet': <Object?>['inspection-owned', 0],
      'renameDiagnosticWallet': <Object?>['inspection-owned', 0, 'wallet'],
      'deleteDiagnosticWallet': <Object?>['inspection-owned', 0],
      'openPrivateKey': <Object?>[account],
      'revealPrivateKey': <Object?>['private-owned'],
      'closePrivateKey': <Object?>['private-owned'],
      'cancelOperation': <Object?>['1'],
      'respondCredential': <Object?>['1', Uint8List(12)],
      'cancelCredential': <Object?>['1'],
      'importWallet': <Object?>['synthetic', ''],
      'addWalletAccounts': <Object?>[
        'synthetic',
        '',
        <int>[1, 7],
      ],
      'addNextWalletAccount': <Object?>['synthetic', ''],
      'importColdAccountCode': <Object?>['{}', ''],
      'setActiveWallet': <Object?>['7', 1],
      'renameWallet': <Object?>['7', 1, 'wallet'],
      'qrEncodeDocument': <Object?>['{}'],
      'qrPrepareAccountAuthorization': <Object?>[10, Uint8List(1), account],
      'qrValidateSignResponse': <Object?>['signing-session', '{}'],
      'renameAccount': <Object?>[account, 'main'],
      'importColdAccountId': <Object?>[_account(2), 'cold'],
      'importColdAccountSs58': <Object?>[
        citizenSs58FromAccountId(_account(2)),
        'cold',
      ],
      'reorderWalletAccountsWithoutDefaultChange': <Object?>[
        '7',
        <String>[account, _account(2)],
      ],
      'signWalletPayload': <Object?>[
        account,
        Uint8List.fromList(<int>[1]),
      ],
      'beginSigning': <Object?>[
        account,
        Uint8List.fromList(<int>[1]),
        'raw',
        Uint8List(0),
        'none',
        0,
        120,
      ],
      'consumeExternalSignature': const <Object?>['signing-session', '{}'],
      'cancelSigning': const <Object?>['signing-session'],
      'beginDefaultAccountChange': <Object?>[
        '7',
        <String>[_account(2), account],
        120,
      ],
      'consumeDefaultAccountChange': const <Object?>['signing-session', '{}'],
      'prepareTransaction': <Object?>[
        account,
        Uint8List.fromList(<int>[1, 2, 3]),
      ],
      'cancelPreparedTransaction': const <Object?>[
        '0x01010101010101010101010101010101',
      ],
      'executePreparedTransaction': const <Object?>[
        '0x01010101010101010101010101010101',
      ],
      'consumePreparedTransactionQrResponse': const <Object?>[
        '0x02020202020202020202020202020202',
        'QR_V1',
      ],
      'cancelPreparedTransactionExecution': const <Object?>[
        '0x02020202020202020202020202020202',
      ],
      'getTransactionHistory': const <Object?>[null, 100],
      'syncTransactionHistory': const <Object?>[],
      'qrParse': <Object?>['{}'],
      'qrCreateSignRequest': <Object?>[
        0x0400,
        account,
        Uint8List.fromList(<int>[4, 0]),
        120,
      ],
      'qrConsumeSignResponse': <Object?>['{}'],
      'qrCancelSignRequest': <Object?>['abcdefghijklmnop'],
      'qrEncodeAccountId': <Object?>[account],
      'qrDecodeLuminance': <Object?>[
        Uint8List.fromList(<int>[0]),
        1,
        1,
        1,
      ],
      'qrEncode': <Object?>['{}', 4],
      'reviewQrRequest': <Object?>['{}'],
      'releaseQrReview': <Object?>['review-owned'],
      'signQrRequest': <Object?>['review-owned'],
      'openQrCapture': <Object?>[1],
      'closeQrCapture': <Object?>['capture-owned'],
      'pauseQrCapture': <Object?>['capture-owned'],
      'resumeQrCapture': <Object?>['capture-owned'],
      'setQrCaptureTorch': <Object?>['capture-owned', true],
      'qrDecodeImage': <Object?>[Uint8List(1), 1],
    };
    expect(<String>{
      'open',
      'verifySignature',
      'encodeSigningPayload',
      ...requestFields.keys,
    }, expectedMethods);
    expect(
      codec.encodeVerification(
        accountId: account,
        signature: Uint8List(64),
        payload: Uint8List(0),
      ),
      <Object?>[2, account, Uint8List(64), Uint8List(0)],
    );
    expect(
      () => codec.encodeRequest(
        method: 'verifySignature',
        sessionId: 's',
        requestSequence: 1,
        fields: <Object?>[account, Uint8List(64), Uint8List(0)],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(codec.decodeVerification(<Object?>[2, false]), isFalse);
    expect(codec.decodeVerification(<Object?>[2, true]), isTrue);
    for (final invalid in <Object?>[
      <Object?>[
        2,
        's',
        1,
        <Object?>[false],
      ],
      <Object?>[2, 0],
      <Object?>[1],
      <Object?>[2, false, null],
      <Object?>[0, false],
      <Object?>[1, false],
    ]) {
      expect(
        () => codec.decodeVerification(invalid),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    for (final entry in requestFields.entries) {
      expect(
        codec.encodeRequest(
          method: entry.key,
          sessionId: 'session-a',
          requestSequence: 7,
          fields: entry.value,
        ),
        <Object?>[2, 'session-a', 7, ...entry.value],
      );
      expect(
        () => codec.encodeRequest(
          method: entry.key,
          sessionId: 'session-a',
          requestSequence: 8,
          fields: <Object?>[...entry.value, 'forbidden-extra-position'],
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    expect(
      () => codec.decodeEvent(<String, Object?>{'protocolVersion': 2}),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeResponse(
        method: 'close',
        raw: <Object?>[2, 'session-a', 1, <String, Object?>{}],
        expectedSessionId: 'session-a',
        expectedRequestSequence: 1,
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('新增通用链与派生钥边界在 Dart tuple 前失败关闭', () {
    final finalized = <Object?>[_account(1), '1', 'finalized'];
    for (final limit in <int>[0, 1001]) {
      expect(
        () => codec.encodeRequest(
          method: 'getStorageKeysPaged',
          sessionId: 's',
          requestSequence: 1,
          fields: <Object?>[finalized, Uint8List(1), null, limit],
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    expect(
      () => codec.encodeRequest(
        method: 'callRuntimeApi',
        sessionId: 's',
        requestSequence: 1,
        fields: <Object?>[finalized, 'arbitrary-rpc', Uint8List(0)],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('通用交易准备摘要严格解码且取消只接受一次性标识', () {
    final source = _account(1);
    final prepared = codec.decodePreparedTransaction(<Object?>[
      '0x01010101010101010101010101010101',
      source,
      _account(2),
      <Object?>[_account(3), '8', 'best'],
      7,
      9,
      '11',
    ]);
    expect(prepared.sourceAccountId, citizenAccountIdBytes(source));
    expect(prepared.callDataHash, citizenAccountIdBytes(_account(2)));
    expect(prepared.bestBlock.finality, CitizenBlockFinality.best);
    expect(prepared.nonce, BigInt.from(11));
    expect(
      () => codec.decodePreparedTransaction(<Object?>[
        '0x01010101010101010101010101010101',
        source,
        _account(2),
        <Object?>[_account(3), '8', 'finalized'],
        7,
        9,
        '11',
      ]),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('通用交易执行严格解码QR_V1待签名与三种终态', () {
    final source = _account(1);
    final callHash = _account(2);
    final transactionHash = _account(3);
    const executionId = '0x02020202020202020202020202020202';
    final block = <Object?>[_account(4), '9', 'finalized'];
    final pending = codec.decodeTransactionExecution(<Object?>[
      1,
      executionId,
      source,
      callHash,
      null,
      '2000000000',
      'QR_V1',
      null,
      null,
      null,
    ]);
    expect(pending, isA<CitizenTransactionExternalSigningPending>());
    expect(
      (pending as CitizenTransactionExternalSigningPending).qrRequest,
      'QR_V1',
    );

    final success = codec.decodeTransactionExecution(<Object?>[
      2,
      executionId,
      source,
      callHash,
      transactionHash,
      null,
      null,
      <Object?>['success', block, 1, null, null, null],
      null,
      null,
    ]);
    expect(
      (success as CitizenTransactionExecutionCompleted).resolution,
      CitizenTransactionResolution.finalizedSuccess,
    );
    final failure = codec.decodeTransactionExecution(<Object?>[
      3,
      executionId,
      source,
      callHash,
      transactionHash,
      null,
      null,
      <Object?>['failed', block, 1, 3, 3, 4],
      null,
      null,
    ]);
    expect(
      (failure as CitizenTransactionExecutionCompleted).resolution,
      CitizenTransactionResolution.finalizedFailed,
    );
    final pool = codec.decodeTransactionExecution(<Object?>[
      4,
      executionId,
      source,
      callHash,
      transactionHash,
      null,
      null,
      null,
      'usurped',
      _account(5),
    ]);
    expect(
      (pool as CitizenTransactionExecutionCompleted).replacementHash,
      citizenAccountIdBytes(_account(5)),
    );

    for (final malformed in <List<Object?>>[
      <Object?>[
        1,
        executionId,
        source,
        callHash,
        transactionHash,
        '2000000000',
        'QR_V1',
        null,
        null,
        null,
      ],
      <Object?>[
        1,
        executionId,
        source,
        callHash,
        null,
        '2000000000',
        'x' * 2332,
        null,
        null,
        null,
      ],
      <Object?>[
        2,
        executionId,
        source,
        callHash,
        transactionHash,
        null,
        'QR_V1',
        <Object?>['success', block, 1, null, null, null],
        null,
        null,
      ],
      <Object?>[
        4,
        executionId,
        source,
        callHash,
        transactionHash,
        null,
        null,
        null,
        null,
        null,
      ],
    ]) {
      expect(
        () => codec.decodeTransactionExecution(malformed),
        throwsA(isA<CitizenSdkException>()),
      );
    }
  });

  test('统一钱包状态严格校验冷热投影、全局顺序与默认首项', () {
    final hot = _account(1);
    final cold = _account(2);
    final state = <Object?>[
      '9',
      <Object?>[
        0,
        'created',
        '1',
        hot,
        hot,
        <Object?>[
          <Object?>[0, hot, citizenSs58FromAccountId(hot), 'hot', '1', true],
        ],
        '独立钱包名',
      ],
      <Object?>[
        <Object?>[
          'hot',
          0,
          0,
          hot,
          citizenSs58FromAccountId(hot),
          'hot',
          '1',
          true,
        ],
        <Object?>[
          'cold',
          1,
          null,
          cold,
          citizenSs58FromAccountId(cold),
          'cold',
          '2',
          false,
        ],
      ],
      1,
      false,
      0,
      <Object?>[],
    ];
    final decoded = codec.decodeWalletState(state);
    expect(decoded.revision, BigInt.from(9));
    expect(decoded.defaultAccount?.accountId, hot);
    expect(decoded.accounts.last.signMode, CitizenWalletSignMode.cold);
    final invalidCold = List<Object?>.from(
      ((state[2]! as List<Object?>)[1]! as List<Object?>),
    );
    invalidCold[7] = true;
    expect(
      () => codec.decodeWalletState(<Object?>[
        state[0],
        state[1],
        <Object?>[(state[2]! as List<Object?>)[0], invalidCold],
        1,
        false,
        0,
        <Object?>[],
      ]),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('Dart请求字段错误稳定为invalidArgument而响应错误仍为decode', () {
    expect(
      () => codec.encodeRequest(
        method: 'getAccountBalance',
        sessionId: 'session-a',
        requestSequence: 1,
        fields: const <Object?>['bad-account'],
      ),
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.invalidArgument,
        ),
      ),
    );
    expect(
      () => codec.encodeRequest(
        method: 'unknown',
        sessionId: 'session-a',
        requestSequence: 1,
      ),
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.unsupported,
        ),
      ),
    );
    expect(
      () => codec.decodeResponse(
        method: 'getFinalizedHead',
        raw: const <Object?>[2, 'session-a', 1, <Object?>[]],
        expectedSessionId: 'session-a',
        expectedRequestSequence: 1,
      ),
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.decode,
        ),
      ),
    );
  });

  test('协议版本必须是精确整数且response、event、error均拒绝double', () {
    expect(
      () => codec.decodeResponse(
        method: 'close',
        raw: const <Object?>[
          2.0,
          'session-a',
          1,
          <Object?>['disposed'],
        ],
        expectedSessionId: 'session-a',
        expectedRequestSequence: 1,
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeEvent(const <Object?>[
        2.0,
        'session-a',
        1,
        'lifecycleChanged',
        <Object?>['running'],
      ]),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodePlatformException(
        PlatformException(
          code: 'citizensdk.cancelled',
          details: const <Object?>[
            2.0,
            'session-a',
            1,
            22,
            7,
            'close',
            'cancelled',
          ],
        ),
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('sessionId在请求、响应、事件和错误外壳统一为1..128个code unit', () {
    final exactUnicodeBoundary = List<String>.filled(64, '🛰️').join();
    // Each satellite is three UTF-16 code units (surrogate pair + VS16), so
    // use a two-code-unit scalar to exercise the exact shared boundary.
    final exactSurrogateBoundary = List<String>.filled(64, '🌍').join();
    expect(exactUnicodeBoundary.length, greaterThan(128));
    expect(exactSurrogateBoundary.length, 128);
    expect(
      codec.encodeRequest(
        method: 'close',
        sessionId: exactSurrogateBoundary,
        requestSequence: 1,
      ),
      <Object?>[2, exactSurrogateBoundary, 1],
    );
    expect(
      () => codec.encodeRequest(
        method: 'close',
        sessionId: exactUnicodeBoundary,
        requestSequence: 1,
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    final tooLong = List<String>.filled(
      CitizenSdkFlutterCodec.maximumSessionIdCodeUnits + 1,
      's',
    ).join();
    expect(
      () => codec.encodeRequest(
        method: 'close',
        sessionId: tooLong,
        requestSequence: 1,
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeResponse(
        method: 'close',
        raw: <Object?>[
          2,
          tooLong,
          1,
          const <Object?>['disposed'],
        ],
        expectedSessionId: null,
        expectedRequestSequence: 1,
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodeEvent(<Object?>[
        2,
        tooLong,
        1,
        'lifecycleChanged',
        const <Object?>['running'],
      ]),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.decodePlatformException(
        PlatformException(
          code: 'citizensdk.cancelled',
          details: <Object?>[2, tooLong, 1, 22, 7, 'close', 'cancelled'],
        ),
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('创世哈希和批量余额响应使用既有session外壳并拒绝非法公开值', () {
    final genesis = codec.decodeResponse(
      method: 'getGenesisHash',
      raw: <Object?>[
        2,
        's',
        1,
        <Object?>[_account(9)],
      ],
      expectedSessionId: 's',
      expectedRequestSequence: 1,
    );
    expect(genesis.value.single, _account(9));
    for (final invalid in <Object?>[
      'invalid',
      _account(9).toUpperCase(),
      null,
    ]) {
      expect(
        () => codec.decodeResponse(
          method: 'getGenesisHash',
          raw: <Object?>[
            2,
            's',
            1,
            <Object?>[invalid],
          ],
          expectedSessionId: 's',
          expectedRequestSequence: 1,
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    expect(codec.decodeBalances(<Object?>[]), isEmpty);
    final balance = <Object?>[_account(1), _block(9), '1', '0', '1'];
    expect(codec.decodeBalances(<Object?>[balance, balance]), hasLength(2));
    for (final invalid in <Object?>[
      <Object?>[
        balance,
        <Object?>[_account(1), _block(10), '1', '0', '1'],
      ],
      <Object?>[
        <Object?>[_account(1), _block(9), '1', '0', '2'],
      ],
      List<Object?>.filled(1991, balance),
    ]) {
      expect(
        () => codec.decodeBalances(invalid),
        throwsA(isA<CitizenSdkException>()),
      );
    }
  });

  test('响应严格校验 session、request sequence、长度和整数规范形式', () {
    final valid = <Object?>[
      2,
      'session-a',
      3,
      <Object?>[_block(9)],
    ];
    final decoded = codec.decodeResponse(
      method: 'getFinalizedHead',
      raw: valid,
      expectedSessionId: 'session-a',
      expectedRequestSequence: 3,
    );
    expect(codec.decodeBlock(decoded.value[0]).number, BigInt.from(9));

    for (final invalid in <Object?>[
      <Object?>[
        2,
        'other',
        3,
        <Object?>[_block(9)],
      ],
      <Object?>[
        2,
        'session-a',
        4,
        <Object?>[_block(9)],
      ],
      <Object?>[
        2,
        'session-a',
        3,
        <Object?>[_block(9)],
        null,
      ],
    ]) {
      expect(
        () => codec.decodeResponse(
          method: 'getFinalizedHead',
          raw: invalid,
          expectedSessionId: 'session-a',
          expectedRequestSequence: 3,
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    expect(
      () => codec.decodeResponse(
        method: 'getAccountBalance',
        raw: <Object?>[
          2,
          'session-a',
          3,
          <Object?>[
            <Object?>[_account(3), _block(9), '01', '0', '1'],
          ],
        ],
        expectedSessionId: 'session-a',
        expectedRequestSequence: 3,
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('事件与错误使用独立固定 tuple 并拒绝未知枚举', () {
    final lifecycle = codec.decodeEvent(<Object?>[
      2,
      'session-a',
      1,
      'lifecycleChanged',
      <Object?>['running'],
    ]);
    expect(lifecycle.sessionId, 'session-a');
    expect(lifecycle.eventSequence, 1);

    final history = codec.decodeEvent(<Object?>[
      2,
      'session-a',
      2,
      'historyChanged',
      const <Object?>[],
    ]);
    expect(history.event, isA<CitizenSdkHistoryChanged>());

    expect(
      () => codec.decodeEvent(<Object?>[
        2,
        'session-a',
        3,
        'transferProgress',
        const <Object?>[9, 'invalid', null, null, 0],
      ]),
      throwsA(isA<CitizenSdkException>()),
    );

    expect(
      () => codec.decodeEvent(<Object?>[
        2,
        'session-a',
        2,
        'unknown',
        const <Object?>[],
      ]),
      throwsA(isA<CitizenSdkException>()),
    );

    final exception = codec.decodePlatformException(
      PlatformException(
        code: 'citizensdk.authenticationCancelled',
        details: <Object?>[2, 'session-a', 8, 10, 3, 'beginSigning', '用户取消'],
      ),
    );
    expect(exception.code, CitizenSdkErrorCode.authenticationCancelled);
    expect(exception.stage, CitizenSdkFailureStage.authentication);
    expect(exception.method, 'beginSigning');
    expect(exception.requestSequence, 8);
  });

  test('进程级事件先按session路由，foreign坏payload被忽略而本session失败关闭', () {
    final foreign = <Object?>[
      2,
      'foreign-session',
      'bad-sequence',
      'unknown',
      <Object?>[
        <String, Object?>{'forbidden': true},
      ],
    ];
    expect(codec.decodeEventForSession(foreign, 'session-a'), isNull);
    expect(
      () => codec.decodeEventForSession(<Object?>[
        2,
        'session-a',
        1,
        'unknown',
        <Object?>[
          <String, Object?>{'forbidden': true},
        ],
      ], 'session-a'),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('公开 bytes 只接受 Uint8List，签名严格为 64 字节', () {
    expect(
      codec.encodeRequest(
        method: 'signWalletPayload',
        sessionId: 'session-a',
        requestSequence: 1,
        fields: <Object?>[_account(1), Uint8List(0)],
      ),
      <Object?>[2, 'session-a', 1, _account(1), Uint8List(0)],
    );
    final response = codec.decodeResponse(
      method: 'signWalletPayload',
      raw: <Object?>[
        2,
        'session-a',
        1,
        <Object?>[Uint8List(64)],
      ],
      expectedSessionId: 'session-a',
      expectedRequestSequence: 1,
    );
    expect(response.value.single, isA<Uint8List>());
    expect(
      () => codec.decodeResponse(
        method: 'signWalletPayload',
        raw: <Object?>[
          2,
          'session-a',
          2,
          <Object?>[List<int>.filled(64, 0)],
        ],
        expectedSessionId: 'session-a',
        expectedRequestSequence: 2,
      ),
      throwsA(isA<CitizenSdkException>()),
    );

    expect(
      () => codec.encodeRequest(
        method: 'signWalletPayload',
        sessionId: 'session-a',
        requestSequence: 3,
        fields: <Object?>[
          _account(1),
          Uint8List(CitizenSdkFlutterCodec.maximumSigningPayloadBytes + 1),
        ],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('history 在平台调用前拒绝超限分页', () {
    expect(
      () => codec.encodeRequest(
        method: 'getTransactionHistory',
        sessionId: 'session-a',
        requestSequence: 1,
        fields: const <Object?>[null, 101],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('add与分页标识在逐项转换前执行固定资源上限', () {
    expect(
      () => codec.encodeRequest(
        method: 'addWalletAccounts',
        sessionId: 'session-a',
        requestSequence: 1,
        fields: <Object?>[
          'synthetic',
          '',
          List<int>.filled(
            CitizenSdkFlutterCodec.maximumAdditionalWalletAccounts + 1,
            1,
            growable: false,
          ),
        ],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(
      () => codec.encodeRequest(
        method: 'getTransactionHistory',
        sessionId: 'session-a',
        requestSequence: 2,
        fields: const <Object?>['0xAB', 100],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('账户名只编码已修剪的 1..30 个 Unicode scalar', () {
    expect(
      codec.encodeRequest(
        method: 'renameAccount',
        sessionId: 'session-a',
        requestSequence: 1,
        fields: <Object?>[_account(1), '旅行钱包'],
      ),
      <Object?>[2, 'session-a', 1, _account(1), '旅行钱包'],
    );
    for (final name in <String>[
      ' 旅行钱包',
      '旅行钱包 ',
      '   ',
      for (var scalar = 0x1c; scalar <= 0x1f; scalar++)
        '钱包${String.fromCharCode(scalar)}',
      List<String>.filled(31, '旅').join(),
      List<String>.filled(129, 'a').join(),
    ]) {
      expect(
        () => codec.encodeRequest(
          method: 'renameAccount',
          sessionId: 'session-a',
          requestSequence: 1,
          fields: <Object?>[_account(1), name],
        ),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    expect(
      () => codec.encodeRequest(
        method: 'addWalletAccounts',
        sessionId: 'session-a',
        requestSequence: 1,
        fields: const <Object?>[
          'synthetic',
          '',
          <int>[0],
        ],
      ),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('finalized head与能力状态逐项重建Rust值对象不变量', () {
    expect(
      () => codec.decodeResponse(
        method: 'getFinalizedHead',
        raw: <Object?>[
          2,
          'session-a',
          1,
          <Object?>[
            <Object?>[_account(1), '1', 'best'],
          ],
        ],
        expectedSessionId: 'session-a',
        expectedRequestSequence: 1,
      ),
      throwsA(isA<CitizenSdkException>()),
    );

    final valid = _capabilities();
    expect(codec.decodeCapabilities(valid).statuses, hasLength(10));
    final invalid = _capabilities();
    final statuses = invalid[1]! as List<Object?>;
    statuses[0] = <Object?>[
      CitizenCapabilityName.chainRead.name,
      true,
      true,
      true,
      false,
      'none',
    ];
    expect(
      () => codec.decodeCapabilities(invalid),
      throwsA(isA<CitizenSdkException>()),
    );

    expect(
      () => codec.decodeFeeSnapshot(<Object?>[
        <Object?>[_account(1), '1', 'best'],
        1,
        '0',
        '0',
      ]),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('wallet profile拒绝与AccountId不一致的CitizenChain SS58地址', () {
    final account = _account(1);
    expect(
      () => codec.decodeWalletProfile(<Object?>[
        0,
        'created',
        '1',
        account,
        account,
        <Object?>[
          <Object?>[0, account, 'wrong-address', '账户0', '1', true],
        ],
        '钱包0',
      ]),
      throwsA(isA<CitizenSdkException>()),
    );
  });

  test('history严格校验execution记录、状态、游标和唯一键', () {
    expect(
      codec.decodeTransactionHistoryPage(_history()).records,
      hasLength(1),
    );

    final wrongCursor = _history();
    wrongCursor[2] = _executionId(2);
    expect(
      () => codec.decodeTransactionHistoryPage(wrongCursor),
      throwsA(isA<CitizenSdkException>()),
    );

    final invalidRecord = _history();
    final records = invalidRecord[1]! as List<Object?>;
    final record = records.single! as List<Object?>;
    record[4] = 'finalizedSuccess';
    expect(
      () => codec.decodeTransactionHistoryPage(invalidRecord),
      throwsA(isA<CitizenSdkException>()),
    );

    final invalidTime = _history();
    final timedRecord =
        (invalidTime[1]! as List<Object?>).single! as List<Object?>;
    timedRecord[9] = '0';
    expect(
      () => codec.decodeTransactionHistoryPage(invalidTime),
      throwsA(isA<CitizenSdkException>()),
    );

    final duplicate = _history();
    final duplicateRecords = duplicate[1]! as List<Object?>;
    duplicateRecords.add(List<Object?>.from(duplicateRecords.single! as List));
    duplicate[2] = null;
    expect(
      () => codec.decodeTransactionHistoryPage(duplicate),
      throwsA(isA<CitizenSdkException>()),
    );
  });
}

String _account(int byte) =>
    '0x${List<String>.filled(32, byte.toRadixString(16).padLeft(2, '0')).join()}';

List<Object?> _block(int number) => <Object?>[
  _account(number),
  '$number',
  'finalized',
];

List<Object?> _capabilities() => <Object?>[
  '1',
  <Object?>[
    for (final name in CitizenCapabilityName.values)
      <Object?>[name.name, true, true, true, true, 'none'],
  ],
];

List<Object?> _history() => <Object?>[
  '1',
  <Object?>[
    <Object?>[
      _executionId(1),
      _account(1),
      _account(2),
      _account(9),
      'pending',
      null,
      null,
      null,
      '1',
      '1',
      null,
    ],
  ],
  _executionId(1),
];

String _executionId(int byte) =>
    '0x${List<String>.filled(16, byte.toRadixString(16).padLeft(2, '0')).join()}';
