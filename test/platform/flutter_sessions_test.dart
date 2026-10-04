import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/widgets.dart';
import 'package:citizen_sdk/src/api/citizen_sdk.dart';
import 'package:citizen_sdk/src/models/citizen_wallet.dart';

import 'package:citizen_sdk/src/api/citizen_sdk_error.dart';
import 'package:citizen_sdk/src/api/citizen_sdk_events.dart';
import 'package:citizen_sdk/src/models/citizen_chain_state.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_flutter_sessions.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_platform.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('公开open接收非UI凭据提供者，完整u64与用途保留且不重放秘密', () async {
    final platform = _CredentialPlatform();
    final previous = CitizenSdkPlatform.instance;
    CitizenSdkPlatform.instance = platform;
    final data = Uint8List.fromList(List<int>.filled(12, 0x61));
    CitizenCredentialChallenge? received;
    final sdk = await CitizenSdk.open(credentialProvider: (challenge) async {
      received = challenge;
      return data;
    });
    addTearDown(() async {
      await sdk.close();
      CitizenSdkPlatform.instance = previous;
      await platform.dispose();
    });
    final events = <CitizenSdkEvent>[];
    final subscription = sdk.events.listen(events.add);
    addTearDown(subscription.cancel);
    final id = BigInt.parse('18446744073709551615');
    platform.request('credentials-1', id);
    await platform.responded.future;
    await Future<void>.delayed(Duration.zero);
    expect(received!.hostOperationId, id);
    expect(received!.keyPurpose, 'unlock');
    expect(platform.providerFlags, [true]);
    expect(platform.responses.single.bytes, List<int>.filled(12, 0x61));
    expect(data, everyElement(0));
    expect(events, isEmpty);
  });

  test('缺提供者取消真实挑战，不默认认证成功', () async {
    final platform = _CredentialPlatform();
    final session = await CitizenSdkFlutterSession.open(platform: platform);
    addTearDown(() async { await session.close(); await platform.dispose(); });
    // 替身同步回送取消事件；SDK必须先退出request事件派发再调用平台，避免流重入。
    platform.request('credentials-1', BigInt.from(31));
    expect(platform.cancelIds, isEmpty);
    await platform.cancelled.future.timeout(const Duration(seconds: 1));
    expect(platform.providerFlags, [false]);
    expect(platform.responses, isEmpty);
    expect(platform.cancelIds, ['credentials-1:31']);
  });

  test('原生取消后拒绝迟到凭据并擦除返回副本', () async {
    final platform = _CredentialPlatform();
    final result = Completer<Uint8List?>();
    final challenge = Completer<CitizenCredentialChallenge>();
    final session = await CitizenSdkFlutterSession.open(platform: platform,
      credentialProvider: (value) { challenge.complete(value); return result.future; });
    addTearDown(() async {
      if (!result.isCompleted) result.complete(null);
      await session.close(); await platform.dispose();
    });
    platform.request('credentials-1', BigInt.from(32));
    final pending = await challenge.future;
    platform.cancel('credentials-1', BigInt.from(32));
    await pending.cancelled;
    final bytes = Uint8List.fromList(List<int>.filled(12, 0x62));
    result.complete(bytes);
    await platform.cancelled.future;
    await Future<void>.delayed(Duration.zero);
    expect(bytes, everyElement(0));
    expect(platform.responses, isEmpty);
  });

  test('关闭等待提供者真实终态，不能把取消通知当作排空', () async {
    final platform = _CredentialPlatform();
    final result = Completer<Uint8List?>();
    final challenge = Completer<CitizenCredentialChallenge>();
    final session = await CitizenSdkFlutterSession.open(platform: platform,
      credentialProvider: (value) { challenge.complete(value); return result.future; });
    addTearDown(() async {
      if (!result.isCompleted) result.complete(null);
      await session.close(); await platform.dispose();
    });
    platform.request('credentials-1', BigInt.from(33));
    final pending = await challenge.future;
    var completed = false;
    final close = session.close().then((_) { completed = true; });
    await pending.cancelled;
    await platform.cancelled.future;
    expect(completed, isFalse);
    expect(platform.methods, isNot(contains('close')));
    final bytes = Uint8List.fromList(List<int>.filled(12, 0x63));
    result.complete(bytes);
    await close;
    expect(completed, isTrue);
    expect(bytes, everyElement(0));
    expect(platform.responses, isEmpty);
  });

  test('同操作号在不同session隔离，提供者异常不泄漏输入文案', () async {
    final platform = _CredentialPlatform();
    var firstCalls = 0, secondCalls = 0;
    final first = await CitizenSdkFlutterSession.open(platform: platform,
      credentialProvider: (_) async { firstCalls++; throw StateError('synthetic private input'); });
    final second = await CitizenSdkFlutterSession.open(platform: platform,
      credentialProvider: (_) async { secondCalls++; return Uint8List(12); });
    addTearDown(() async { await first.close(); await second.close(); await platform.dispose(); });
    platform.request('credentials-1', BigInt.from(34));
    await platform.responded.future;
    expect(firstCalls, 1); expect(secondCalls, 0);
    expect(platform.responses.single.session, 'credentials-1');
    expect(platform.responses.single.bytes, isNull);
  });

  test('后台撤销凭据交付，回前台不恢复旧挑战', () async {
    final platform = _CredentialPlatform();
    final result = Completer<Uint8List?>();
    final challenge = Completer<CitizenCredentialChallenge>();
    final binding = TestWidgetsFlutterBinding.ensureInitialized();
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    final session = await CitizenSdkFlutterSession.open(platform: platform,
      credentialProvider: (value) { challenge.complete(value); return result.future; });
    addTearDown(() async {
      if (!result.isCompleted) result.complete(null);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await session.close(); await platform.dispose();
    });
    platform.request('credentials-1', BigInt.from(35));
    final pending = await challenge.future;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await pending.cancelled;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    result.complete(Uint8List(12));
    await platform.cancelled.future;
    await Future<void>.delayed(Duration.zero);
    expect(platform.responses, isEmpty);
  });

  test('历史通知按 session 隔离，关闭后不接收迟到通知', () async {
    final platform = _SessionPlatform();
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);
    final events = <CitizenSdkEvent>[];
    final subscription = session.events.listen(events.add);
    platform.emit(<Object?>[2, 'foreign', 1, 'historyChanged', <Object?>[]]);
    platform.emit(<Object?>[2, 'session-a', 1, 'historyChanged', <Object?>[]]);
    await Future<void>.delayed(Duration.zero);
    expect(events.single, isA<CitizenSdkHistoryChanged>());
    await session.close();
    platform.emit(<Object?>[2, 'session-a', 2, 'historyChanged', <Object?>[]]);
    await Future<void>.delayed(Duration.zero);
    expect(events, hasLength(1));
    await subscription.cancel();
  });
  test('Flutter open后按session浅路由事件，其他session的坏payload不会毒化本session', () async {
    final platform = _SessionPlatform();
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);
    final events = <CitizenSdkEvent>[];
    final subscription = session.events.listen(events.add);

    for (var index = 0; index < 100; index++) {
      platform.emit(<Object?>[
        2,
        'foreign-session',
        'malformed-sequence-is-ignored-after-routing',
        'unknown',
        <Object?>[
          <String, Object?>{'forbidden': true},
        ],
      ]);
    }
    platform.emit(<Object?>[
      2,
      'session-a',
      1,
      'lifecycleChanged',
      <Object?>['running'],
    ]);
    await Future<void>.delayed(Duration.zero);

    expect(events, hasLength(1));
    expect(
      (events.single as CitizenSdkLifecycleChanged).lifecycle,
      CitizenSdkLifecycle.running,
    );
    await subscription.cancel();
    await session.close();
  });

  test('open value损坏时仍使用响应外壳sessionId关闭原生实例', () async {
    final platform = _SessionPlatform(invalidOpenValue: true);
    addTearDown(platform.dispose);

    await expectLater(
      CitizenSdkFlutterSession.open(platform: platform),
      throwsA(isA<CitizenSdkException>()),
    );

    expect(platform.requestSequences, <int>[1]);
    expect(platform.methods, contains('close'));
  });

  test('原生错误必须精确关联当前session和request sequence', () async {
    final platform = _SessionPlatform(mismatchedHeadError: true);
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);

    await expectLater(
      session.invoke('getFinalizedHead'),
      throwsA(
        isA<CitizenSdkException>()
            .having((error) => error.code, 'code', CitizenSdkErrorCode.decode)
            .having((error) => error.sessionId, 'sessionId', 'session-a')
            .having((error) => error.requestSequence, 'sequence', 1),
      ),
    );
    await session.close();
  });

  test('暂停的公共事件监听不能阻塞已经disposed的close', () async {
    final platform = _SessionPlatform();
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);
    final subscription = session.events.listen((_) {});
    subscription.pause();

    await session.close().timeout(const Duration(seconds: 1));

    await subscription.cancel();
  });

  test('第二个session的open窗口事件由进程路由器缓存且不产生序号缺口', () async {
    final platform = _MultiSessionPlatform();
    addTearDown(platform.dispose);
    final first = await CitizenSdkFlutterSession.open(platform: platform);
    final secondFuture = CitizenSdkFlutterSession.open(platform: platform);
    final second = await secondFuture;
    final secondEvents = <CitizenSdkEvent>[];
    final subscription = second.events.listen(secondEvents.add);

    // 第二次 native open 在返回 envelope 前发出了 session-b 的 sequence 1。
    // register 时必须从按 session 隔离的进程缓冲中精确交付。
    expect(second.lifecycle, CitizenSdkLifecycle.running);
    platform.emit(<Object?>[
      2,
      'session-b',
      2,
      'lifecycleChanged',
      <Object?>['stopped'],
    ]);
    await Future<void>.delayed(Duration.zero);
    expect(secondEvents, hasLength(1));
    expect(second.lifecycle, CitizenSdkLifecycle.stopped);

    await subscription.cancel();
    await second.close();
    await first.close();
  });

  test('进程路由器显式拒绝第65个并发open', () async {
    final platform = _ConcurrentOpenPlatform();
    addTearDown(platform.dispose);

    final opens = <Future<CitizenSdkFlutterSession>>[
      for (var index = 0; index < 64; index++)
        CitizenSdkFlutterSession.open(platform: platform),
    ];
    await Future<void>.delayed(Duration.zero);
    await expectLater(
      CitizenSdkFlutterSession.open(platform: platform),
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.queueFull,
        ),
      ),
    );

    platform.releaseOpens();
    final sessions = await Future.wait(opens);
    await Future.wait(sessions.map((session) => session.close()));
  });

  test('open窗口未知session饱和时fail-closed而不静默驱逐基线', () async {
    final platform = _PendingOverflowPlatform();
    addTearDown(platform.dispose);

    await expectLater(
      CitizenSdkFlutterSession.open(platform: platform),
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.queueFull,
        ),
      ),
    );
    expect(platform.closedSessions, <String>['session-real']);
  });

  test('普通请求可并发、sequence单调且close后拒绝新请求', () async {
    final gate = Completer<void>();
    final platform = _SessionPlatform(firstHeadGate: gate);
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);

    final first = session.invoke('getFinalizedHead');
    await Future<void>.delayed(Duration.zero);
    final second = session.invoke('getFinalizedHead');
    await Future<void>.delayed(Duration.zero);
    expect(platform.requestSequences, <int>[1, 2]);
    gate.complete();
    await Future.wait(<Future<List<Object?>>>[first, second]);
    await session.close();

    expect(platform.requestSequences, <int>[1, 2, 3]);
    await expectLater(
      session.invoke('getFinalizedHead'),
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.invalidState,
        ),
      ),
    );
  });

  test('Dart侧拒绝的非法请求不消耗原生request sequence', () async {
    final platform = _SessionPlatform();
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);

    await expectLater(
      session.invoke('getTransactionHistory', fields: <Object?>[null, 0]),
      throwsA(isA<CitizenSdkException>()),
    );
    await session.invoke('getFinalizedHead');
    await session.close();

    expect(platform.requestSequences, <int>[1, 2]);
  });

  test('start/stop等待既有请求并独占后续接纳', () async {
    final gate = Completer<void>();
    final platform = _SessionPlatform(firstHeadGate: gate);
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);

    final read = session.invoke('getFinalizedHead');
    await Future<void>.delayed(Duration.zero);
    final start = session.invoke('start');
    await Future<void>.delayed(Duration.zero);
    await expectLater(
      session.invoke('getFinalizedHead'),
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.busy,
        ),
      ),
    );
    expect(platform.requestSequences, <int>[1]);

    gate.complete();
    await read;
    await start;
    expect(platform.requestSequences, <int>[1, 2]);
    await session.close();
  });

  test('事件缺号或跨协议失败关闭后续请求', () async {
    final platform = _SessionPlatform();
    addTearDown(platform.dispose);
    final session = await CitizenSdkFlutterSession.open(platform: platform);
    final errors = <Object>[];
    final subscription = session.events.listen(
      (_) {},
      onError: (Object error) => errors.add(error),
    );

    platform.emit(<Object?>[
      2,
      'session-a',
      2,
      'lifecycleChanged',
      <Object?>['running'],
    ]);
    await Future<void>.delayed(Duration.zero);

    expect(errors.single, isA<CitizenSdkException>());
    await expectLater(
      session.invoke('getFinalizedHead'),
      throwsA(isA<CitizenSdkException>()),
    );
    await subscription.cancel();
  });
}

final class _SessionPlatform implements CitizenSdkPlatform {
  _SessionPlatform({
    this.firstHeadGate,
    this.invalidOpenValue = false,
    this.mismatchedHeadError = false,
  });

  final Completer<void>? firstHeadGate;
  final bool invalidOpenValue;
  final bool mismatchedHeadError;
  final StreamController<Object?> _events =
      StreamController<Object?>.broadcast();
  final List<int> requestSequences = <int>[];
  final List<String> methods = <String>[];
  int _headCalls = 0;

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    if (method == 'open') {
      return <Object?>[
        2,
        'session-a',
        0,
        invalidOpenValue
            ? <Object?>['created', 'not-an-event-sequence']
            : <Object?>['created', 1],
      ];
    }
    final sequence = arguments[2]! as int;
    requestSequences.add(sequence);
    methods.add(method);
    if (method == 'getFinalizedHead') {
      _headCalls += 1;
      if (_headCalls == 1 && firstHeadGate != null) {
        await firstHeadGate!.future;
      }
      if (mismatchedHeadError) {
        throw CitizenSdkException(
          code: CitizenSdkErrorCode.network,
          stage: CitizenSdkFailureStage.provider,
          method: method,
          message: 'wrong correlation',
          sessionId: 'foreign-session',
          requestSequence: sequence,
        );
      }
    }
    return switch (method) {
      'getFinalizedHead' => <Object?>[
        2,
        'session-a',
        sequence,
        <Object?>[
          <Object?>[_account(1), '1', 'finalized'],
        ],
      ],
      'start' => <Object?>[
        2,
        'session-a',
        sequence,
        <Object?>['running'],
      ],
      'close' => <Object?>[
        2,
        'session-a',
        sequence,
        <Object?>['disposed'],
      ],
      _ => throw StateError('未预期 method：$method'),
    };
  }

  void emit(Object? event) => _events.add(event);

  Future<void> dispose() => _events.close();
}

final class _MultiSessionPlatform implements CitizenSdkPlatform {
  final StreamController<Object?> _events =
      StreamController<Object?>.broadcast();
  var _openCount = 0;

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    if (method == 'open') {
      _openCount += 1;
      final sessionId = _openCount == 1 ? 'session-a' : 'session-b';
      if (_openCount == 2) {
        emit(<Object?>[
          2,
          sessionId,
          1,
          'lifecycleChanged',
          <Object?>['running'],
        ]);
        await Future<void>.delayed(Duration.zero);
      }
      return <Object?>[
        2,
        sessionId,
        0,
        <Object?>['created', 1],
      ];
    }
    final sessionId = arguments[1]! as String;
    final sequence = arguments[2]! as int;
    if (method == 'close') {
      return <Object?>[
        2,
        sessionId,
        sequence,
        <Object?>['disposed'],
      ];
    }
    throw StateError('未预期 method：$method');
  }

  void emit(Object? event) => _events.add(event);

  Future<void> dispose() => _events.close();
}

final class _ConcurrentOpenPlatform implements CitizenSdkPlatform {
  final StreamController<Object?> _events =
      StreamController<Object?>.broadcast();
  final Completer<void> _openGate = Completer<void>();
  var _nextSession = 0;

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    if (method == 'open') {
      final sessionId = 'session-${++_nextSession}';
      await _openGate.future;
      return <Object?>[
        2,
        sessionId,
        0,
        <Object?>['created', 1],
      ];
    }
    if (method == 'close') {
      return <Object?>[
        2,
        arguments[1],
        arguments[2],
        <Object?>['disposed'],
      ];
    }
    throw StateError('未预期 method：$method');
  }

  void releaseOpens() => _openGate.complete();

  Future<void> dispose() => _events.close();
}

final class _PendingOverflowPlatform implements CitizenSdkPlatform {
  final StreamController<Object?> _events = StreamController<Object?>.broadcast(
    sync: true,
  );
  final List<String> closedSessions = <String>[];

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    if (method == 'open') {
      for (var index = 0; index < 65; index++) {
        _events.add(<Object?>[
          2,
          'foreign-$index',
          1,
          'lifecycleChanged',
          <Object?>['running'],
        ]);
      }
      return <Object?>[
        2,
        'session-real',
        0,
        <Object?>['created', 1],
      ];
    }
    if (method == 'close') {
      closedSessions.add(arguments[1]! as String);
      return <Object?>[
        2,
        arguments[1],
        arguments[2],
        <Object?>['disposed'],
      ];
    }
    throw StateError('未预期 method：$method');
  }

  Future<void> dispose() => _events.close();
}

String _account(int byte) =>
    '0x${List<String>.filled(32, byte.toRadixString(16).padLeft(2, '0')).join()}';


final class _CredentialPlatform implements CitizenSdkPlatform {
  final _events = StreamController<Object?>.broadcast(sync: true);
  final List<bool> providerFlags = [];
  final List<String> methods = [], cancelIds = [];
  final List<({String session, Uint8List? bytes})> responses = [];
  final responded = Completer<void>(), cancelled = Completer<void>();
  final Map<String, int> _sequence = {}, _eventsSequence = {};
  @override
  Stream<Object?> get events => _events.stream;
  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    expect(arguments[0], 2);
    if (method == 'open') {
      expect(arguments, hasLength(3));
      providerFlags.add(arguments[2]! as bool);
      final id = 'credentials-${providerFlags.length}';
      _sequence[id] = 1; _eventsSequence[id] = 1;
      return [2, id, 0, ['created', 1]];
    }
    final id = arguments[1]! as String, sequence = arguments[2]! as int;
    expect(sequence, _sequence[id]);
    _sequence[id] = sequence + 1;
    methods.add(method);
    if (method == 'respondCredential') {
      expect(arguments, hasLength(5));
      final data = arguments[4] as Uint8List?;
      responses.add((session: id, bytes: data == null ? null : Uint8List.fromList(data)));
      if (!responded.isCompleted) responded.complete();
      return [2, id, sequence, <Object?>[]];
    }
    if (method == 'cancelCredential') {
      expect(arguments, hasLength(4));
      cancelIds.add('$id:${arguments[3]}');
      cancel(id, BigInt.parse(arguments[3]! as String));
      if (!cancelled.isCompleted) cancelled.complete();
      return [2, id, sequence, <Object?>[]];
    }
    if (method == 'close') return [2, id, sequence, ['disposed']];
    throw StateError('未登记测试方法：$method');
  }
  void request(String id, BigInt operation) => _emit(id, 'credentialRequest', [operation.toString(), 'unlock', null]);
  void cancel(String id, BigInt operation) => _emit(id, 'credentialCancelled', [operation.toString()]);
  void _emit(String id, String type, List<Object?> payload) {
    final sequence = _eventsSequence[id]!;
    _eventsSequence[id] = sequence + 1;
    _events.add([2, id, sequence, type, payload]);
  }
  Future<void> dispose() => _events.close();
}
