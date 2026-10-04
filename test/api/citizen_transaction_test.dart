import 'dart:async';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_platform.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _TransactionPlatform platform;

  setUp(() {
    platform = _TransactionPlatform();
    CitizenSdkPlatform.instance = platform;
  });

  tearDown(() async {
    CitizenSdkPlatform.instance = null;
    await platform.dispose();
  });

  test('通用交易准备只传source与opaque callData并显式取消', () async {
    final sdk = await CitizenSdk.open();
    final source = Uint8List.fromList(List<int>.filled(32, 1));
    final callData = Uint8List.fromList(<int>[4, 0, 1]);
    final prepared = await sdk.transactions.prepareTransaction(
      source,
      callData,
    );

    expect(prepared.preparationId, _executionId(1));
    expect(prepared.sourceAccountId, source);
    expect(prepared.bestBlock.finality, CitizenBlockFinality.best);
    expect(prepared.runtimeSpecNumber, 7);
    expect(prepared.transactionFormatNumber, 9);
    expect(prepared.nonce, BigInt.from(11));
    expect(platform.lastArguments, <Object?>[
      2,
      'session-a',
      1,
      _account(1),
      callData,
    ]);

    await sdk.transactions.cancelPreparedTransaction(prepared.preparationId);
    expect(platform.lastArguments, <Object?>[
      2,
      'session-a',
      2,
      prepared.preparationId,
    ]);
    await sdk.close();
  });

  test('通用交易准备由SDK执行并复用唯一QR_V1冷签名通道', () async {
    final sdk = await CitizenSdk.open();
    final prepared = await sdk.transactions.prepareTransaction(
      Uint8List.fromList(List<int>.filled(32, 1)),
      Uint8List.fromList(<int>[4, 0, 1]),
    );
    final started = await sdk.transactions.executePreparedTransaction(
      prepared.preparationId,
    );
    expect(started, isA<CitizenTransactionExternalSigningPending>());
    final pending = started as CitizenTransactionExternalSigningPending;
    expect(pending.qrRequest, 'QR_V1');

    final completed = await sdk.transactions
        .consumePreparedTransactionQrResponse(pending.executionId, 'QR_V1');
    expect(completed.resolution, CitizenTransactionResolution.finalizedSuccess);
    expect(completed.execution?.status, CitizenExecutionStatus.success);
    expect(platform.lastArguments, <Object?>[
      2,
      'session-a',
      3,
      pending.executionId,
      'QR_V1',
    ]);
    await sdk.close();
  });

  test('通用交易冷执行只用executionId显式取消', () async {
    final sdk = await CitizenSdk.open();
    await sdk.transactions.cancelPreparedTransactionExecution(_executionId(2));
    expect(platform.lastArguments, <Object?>[
      2,
      'session-a',
      1,
      _executionId(2),
    ]);
    await sdk.close();
  });

  test('交易历史只读SDK自身提交的通用execution事实', () async {
    final sdk = await CitizenSdk.open();
    final first = await sdk.history.getTransactionHistory(limit: 2);
    final synced = await sdk.history.syncTransactionHistory();

    expect(first.revision, BigInt.one);
    expect(synced.revision, BigInt.from(2));
    expect(first.records.single.executionId, _executionId(2));
    expect(
      first.records.single.status,
      CitizenTransactionHistoryStatus.pending,
    );
    expect(first.nextBeforeExecutionId, isNull);
    expect(platform.historyMethods, <String>[
      'getTransactionHistory',
      'syncTransactionHistory',
    ]);
    expect(platform.historyArguments.first, <Object?>[
      2,
      'session-a',
      1,
      null,
      2,
    ]);
    expect(platform.historyArguments.last, <Object?>[2, 'session-a', 2]);
    await sdk.close();
  });

  test('通用历史在进入平台前拒绝非法分页参数', () async {
    final sdk = await CitizenSdk.open();
    final invalid = isA<CitizenSdkException>().having(
      (error) => error.code,
      'code',
      CitizenSdkErrorCode.invalidArgument,
    );

    await expectLater(
      sdk.history.getTransactionHistory(limit: 0),
      throwsA(invalid),
    );
    await expectLater(
      sdk.history.getTransactionHistory(limit: 101),
      throwsA(invalid),
    );
    await expectLater(
      sdk.history.getTransactionHistory(beforeExecutionId: '0xAB'),
      throwsA(invalid),
    );
    expect(platform.historyMethods, isEmpty);
    await sdk.close();
  });
}

final class _TransactionPlatform implements CitizenSdkPlatform {
  final StreamController<Object?> _events =
      StreamController<Object?>.broadcast();
  final List<String> historyMethods = <String>[];
  final List<List<Object?>> historyArguments = <List<Object?>>[];
  List<Object?>? lastArguments;

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    if (method == 'open') {
      return <Object?>[
        2,
        'session-a',
        0,
        <Object?>['created', 1],
      ];
    }
    final sequence = arguments[2]! as int;
    if (<String>{
      'prepareTransaction',
      'cancelPreparedTransaction',
      'executePreparedTransaction',
      'consumePreparedTransactionQrResponse',
      'cancelPreparedTransactionExecution',
    }.contains(method)) {
      lastArguments = arguments;
    }
    if (method == 'getTransactionHistory' ||
        method == 'syncTransactionHistory') {
      historyMethods.add(method);
      historyArguments.add(List<Object?>.from(arguments));
    }
    final value = switch (method) {
      'prepareTransaction' => <Object?>[_prepared()],
      'cancelPreparedTransaction' => <Object?>[null],
      'executePreparedTransaction' => <Object?>[_pendingExecution()],
      'consumePreparedTransactionQrResponse' => <Object?>[
        _completedExecution(),
      ],
      'cancelPreparedTransactionExecution' => <Object?>[null],
      'getTransactionHistory' => <Object?>[_history('1')],
      'syncTransactionHistory' => <Object?>[_history('2')],
      'close' => <Object?>['disposed'],
      _ => throw StateError('未预期 method：$method'),
    };
    return <Object?>[2, 'session-a', sequence, value];
  }

  Future<void> dispose() => _events.close();
}

List<Object?> _prepared() => <Object?>[
  _executionId(1),
  _account(1),
  _account(2),
  <Object?>[_account(3), '8', 'best'],
  7,
  9,
  '11',
];

List<Object?> _pendingExecution() => <Object?>[
  1,
  _executionId(2),
  _account(1),
  _account(2),
  null,
  '2000000000',
  'QR_V1',
  null,
  null,
  null,
];

List<Object?> _completedExecution() => <Object?>[
  2,
  _executionId(2),
  _account(1),
  _account(2),
  _account(9),
  null,
  null,
  <Object?>['success', _block(), 2, null, null, null],
  null,
  null,
];

List<Object?> _history(String revision) => <Object?>[
  revision,
  <Object?>[
    <Object?>[
      _executionId(2),
      _account(1),
      _account(2),
      _account(9),
      'pending',
      null,
      null,
      null,
      '10',
      '10',
      null,
    ],
  ],
  null,
];

List<Object?> _block() => <Object?>[_account(3), '8', 'finalized'];

String _executionId(int byte) =>
    '0x${List<String>.filled(16, byte.toRadixString(16).padLeft(2, '0')).join()}';

String _account(int byte) =>
    '0x${List<String>.filled(32, byte.toRadixString(16).padLeft(2, '0')).join()}';
