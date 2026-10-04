import 'dart:async';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_platform.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _SdkPlatform platform;

  setUp(() {
    platform = _SdkPlatform();
    CitizenSdkPlatform.instance = platform;
  });

  tearDown(() async {
    CitizenSdkPlatform.instance = null;
    await platform.dispose();
  });

  test('CitizenSdk按open-start-capabilities-stop-close顺序投影Core', () async {
    final sdk = await CitizenSdk.open();
    await sdk.start();
    final capabilities = await sdk.getCapabilities();
    await sdk.stop();
    await sdk.close();

    expect(capabilities.statuses, hasLength(10));
    expect(capabilities[CitizenCapabilityName.chainRead].ready, isTrue);
    expect(sdk.lifecycle, CitizenSdkLifecycle.disposed);
    expect(platform.methods, <String>[
      'open',
      'start',
      'getCapabilities',
      'stop',
      'close',
    ]);
    expect(platform.sequences, <int>[1, 2, 3, 4]);
  });

  test('事件只接收当前session且event sequence独立连续', () async {
    final sdk = await CitizenSdk.open();
    final events = <CitizenSdkEvent>[];
    final subscription = sdk.events.listen(events.add);

    platform.emit(<Object?>[
      2,
      'another-session',
      1,
      'lifecycleChanged',
      <Object?>['running'],
    ]);
    platform.emit(<Object?>[
      2,
      'session-a',
      1,
      'lifecycleChanged',
      <Object?>['running'],
    ]);
    await Future<void>.delayed(Duration.zero);

    expect(events, hasLength(1));
    expect(sdk.lifecycle, CitizenSdkLifecycle.running);
    await subscription.cancel();
    await sdk.close();
  });

  test('公共 SDK 转发历史失效通知，不改变生命周期', () async {
    final sdk = await CitizenSdk.open();
    final events = <CitizenSdkEvent>[];
    final subscription = sdk.events.listen(events.add);
    final before = sdk.lifecycle;
    platform.emit(<Object?>[2, 'session-a', 1, 'historyChanged', <Object?>[]]);
    await Future<void>.delayed(Duration.zero);
    expect(events.single, isA<CitizenSdkHistoryChanged>());
    expect(sdk.lifecycle, before);
    await sdk.close();
    platform.emit(<Object?>[2, 'session-a', 2, 'historyChanged', <Object?>[]]);
    await Future<void>.delayed(Duration.zero);
    expect(events, hasLength(1));
    await subscription.cancel();
  });

  test('创世哈希无需start，批量余额保持顺序和重复项且空列表仍请求Core', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.chain);
    expect(await sdk.chain.getGenesisHash(), _account(9));
    expect(sdk.lifecycle, CitizenSdkLifecycle.created);
    for (final accounts in <List<String>>[
      <String>[],
      <String>[_account(2), _account(1), _account(2)],
      List<String>.filled(1990, _account(1)),
    ]) {
      final balances = await sdk.chain.getAccountBalances(accounts);
      expect(balances.map((value) => value.accountId), accounts);
      expect(() => balances.clear(), throwsUnsupportedError);
    }
    final calls = platform.methods.length;
    await expectLater(
      sdk.chain.getAccountBalances(List<String>.filled(1991, _account(1))),
      throwsA(isA<CitizenSdkException>()),
    );
    await expectLater(
      sdk.chain.getAccountBalances(<String>['invalid']),
      throwsA(isA<CitizenSdkException>()),
    );
    expect(platform.methods, hasLength(calls));
    expect(
      platform.methods.where((value) => value == 'getAccountBalances'),
      hasLength(3),
    );
    await sdk.close();
  });

  test('批量余额拒绝错位、缺项和跨块结果而不返回部分事实', () async {
    final sdk = await CitizenSdk.open();
    for (final failure in <int>[1, 2, 3]) {
      platform.batchFailure = failure;
      await expectLater(
        sdk.chain.getAccountBalances(<String>[
          _account(2),
          _account(1),
          _account(2),
        ]),
        throwsA(isA<CitizenSdkException>()),
      );
    }
    await sdk.close();
  });

  test('余额与nonce响应必须精确绑定请求账户', () async {
    platform.wrongAccountResponses = true;
    final sdk = await CitizenSdk.open();

    await expectLater(
      sdk.chain.getAccountBalance(_account(1)),
      throwsA(isA<CitizenSdkException>()),
    );
    await expectLater(
      sdk.chain.getAccountNonce(_account(1)),
      throwsA(isA<CitizenSdkException>()),
    );
    await sdk.close();
  });

  test('通用链门面投影同步、准确块、opaque存储与显式轻节点状态', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.chain);
    final finalized = CitizenBlockRef(
      hash: _account(9),
      number: BigInt.from(9),
      finality: CitizenBlockFinality.finalized,
    );
    final status = await sdk.chain.getSyncStatus();
    expect(status.peerCount, BigInt.from(2));
    expect(status.isUsable, isTrue);
    expect((await sdk.chain.getBestHead()).finality, CitizenBlockFinality.best);
    expect(
      (await sdk.chain.getFinalizedBlockAt(BigInt.from(9))).number,
      BigInt.from(9),
    );
    expect(
      (await sdk.chain.resolveFinalizedBlock(_account(9), BigInt.from(9))).hash,
      _account(9),
    );
    expect((await sdk.chain.getBlockHeader(finalized)).digest, <int>[0]);
    expect((await sdk.chain.getBlockBody(finalized)).extrinsics.single, <int>[
      1,
    ]);
    expect((await sdk.chain.getRuntimeContext(finalized)).specVersion, 7);
    expect(
      await sdk.chain.getStorage(finalized, Uint8List.fromList(<int>[1])),
      <int>[2],
    );
    expect(
      (await sdk.chain.getStorageBatch(finalized, <Uint8List>[
        Uint8List.fromList(<int>[1]),
        Uint8List.fromList(<int>[2]),
      ])).map((value) => value?.toList()),
      <List<int>?>[
        <int>[2],
        null,
      ],
    );
    expect(await sdk.chain.getSystemEvents(finalized), <int>[3]);
    final state = await sdk.chain.exportState();
    await sdk.chain.importState(state);
    expect(state.finalized.hash, finalized.hash);
    expect(
      platform.methods,
      containsAll(<String>[
        'getSyncStatus',
        'getBestHead',
        'getFinalizedBlockAt',
        'resolveFinalizedBlock',
        'getBlockHeader',
        'getBlockBody',
        'getRuntimeContext',
        'getStorage',
        'getStorageBatch',
        'getSystemEvents',
        'exportState',
        'importState',
      ]),
    );
    await sdk.close();
  });
}

final class _SdkPlatform implements CitizenSdkPlatform {
  final StreamController<Object?> _events =
      StreamController<Object?>.broadcast();
  final List<String> methods = <String>[];
  final List<int> sequences = <int>[];
  bool wrongAccountResponses = false;
  int batchFailure = 0;

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    methods.add(method);
    if (method == 'open') {
      return <Object?>[
        2,
        'session-a',
        0,
        <Object?>['created', 1],
      ];
    }
    final sequence = arguments[2]! as int;
    sequences.add(sequence);
    if (method == 'getAccountBalances') {
      final accounts = (arguments[3]! as List).cast<String>();
      final balances = <Object?>[
        for (var index = 0; index < accounts.length; index += 1)
          <Object?>[
            batchFailure == 1 ? _account(3) : accounts[index],
            _block(batchFailure == 3 && index > 0 ? 10 : 9, 'finalized'),
            '1',
            '0',
            '1',
          ],
      ];
      if (batchFailure == 2 && balances.isNotEmpty) balances.removeLast();
      return <Object?>[
        2,
        'session-a',
        sequence,
        <Object?>[balances],
      ];
    }
    final value = switch (method) {
      'start' => <Object?>['running'],
      'stop' => <Object?>['stopped'],
      'close' => <Object?>['disposed'],
      'getCapabilities' => <Object?>[_capabilitySnapshot()],
      'getGenesisHash' => <Object?>[_account(9)],
      'getSyncStatus' => <Object?>[
        <Object?>['2', true, true, _block(10, 'best'), _block(9, 'finalized')],
      ],
      'getBestHead' => <Object?>[_block(10, 'best')],
      'getFinalizedBlockAt' => <Object?>[_block(9, 'finalized')],
      'resolveFinalizedBlock' => <Object?>[_block(9, 'finalized')],
      'getBlockHeader' => <Object?>[
        <Object?>[
          _block(9, 'finalized'),
          _account(8),
          _account(7),
          _account(6),
          Uint8List.fromList(<int>[0]),
        ],
      ],
      'getBlockBody' => <Object?>[
        <Object?>[
          _block(9, 'finalized'),
          <Uint8List>[
            Uint8List.fromList(<int>[1]),
          ],
        ],
      ],
      'getRuntimeContext' => <Object?>[
        <Object?>[
          _block(9, 'finalized'),
          7,
          8,
          Uint8List.fromList(<int>[1]),
        ],
      ],
      'getStorage' => <Object?>[
        Uint8List.fromList(<int>[2]),
      ],
      'getStorageBatch' => <Object?>[
        <Object?>[
          Uint8List.fromList(<int>[2]),
          null,
        ],
      ],
      'getSystemEvents' => <Object?>[
        Uint8List.fromList(<int>[3]),
      ],
      'exportState' => <Object?>[
        <Object?>[
          1,
          _block(9, 'finalized'),
          Uint8List.fromList(<int>[4]),
        ],
      ],
      'importState' => <Object?>[],
      'getAccountBalance' => <Object?>[
        <Object?>[
          _account(wrongAccountResponses ? 2 : 1),
          _block(9, 'finalized'),
          '1',
          '0',
          '1',
        ],
      ],
      'getAccountNonce' => <Object?>[
        <Object?>[
          _account(wrongAccountResponses ? 2 : 1),
          _block(9, 'best'),
          '1',
        ],
      ],
      _ => throw StateError('未预期 method：$method'),
    };
    return <Object?>[2, 'session-a', sequence, value];
  }

  void emit(Object? event) => _events.add(event);

  Future<void> dispose() => _events.close();
}

List<Object?> _capabilitySnapshot() => <Object?>[
  '1',
  CitizenCapabilityName.values
      .map<List<Object?>>(
        (name) => <Object?>[name.name, true, true, true, true, 'none'],
      )
      .toList(growable: false),
];

String _account(int byte) =>
    '0x${List<String>.filled(32, byte.toRadixString(16).padLeft(2, '0')).join()}';

List<Object?> _block(int number, String finality) => <Object?>[
  _account(number),
  '$number',
  finality,
];
