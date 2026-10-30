// ignore_for_file: depend_on_referenced_packages
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/platform/bind.dart' as c;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final path = Platform.environment['CITIZENSDK_TEST_LIBRARY'];
  if (path == null) throw StateError('需要本轮正式Core/SQLite/ZXing夹具');
  final library = DynamicLibrary.open(path),
      api = c.Bindings(DynamicLibrary.open(path));
  final open = library
      .lookupFunction<Uint64 Function(Uint32), int Function(int)>(
        'citizensdk_test_open',
      );
  final close = library
      .lookupFunction<Int32 Function(Uint64), int Function(int)>(
        'citizensdk_test_close',
      );
  final vault = library
      .lookupFunction<Int32 Function(Uint64, Int32), int Function(int, int)>(
        'citizensdk_test_vault',
      );
  final vaultPending = library
      .lookupFunction<Int32 Function(Uint64), int Function(int)>(
        'citizensdk_test_vault_pending',
      );
  final vaultComplete = library
      .lookupFunction<Int32 Function(Uint64, Int32), int Function(int, int)>(
        'citizensdk_test_vault_complete',
      );
  const method = MethodChannel('citizen/sdk/core/v2'),
      events = MethodChannel('citizen/sdk/events/v2');
  final handles = <String, int>{};
  var calls = <String>[], malformed = false;
  var physicalUi = false, earlyCameraClose = false, rejectDiagnostic = false;
  Completer<Uint8List>? revealBytes;
  Completer<void>? cameraDrain;
  final nativeResources = <String>{};
  void emit(String kind, List<Object?> payload) {
    ServicesBinding.instance.channelBuffers.push(
      'citizen/sdk/events/v2',
      const StandardMethodCodec().encodeSuccessEnvelope([
        2,
        handles.keys.single,
        1,
        kind,
        payload,
      ]),
      (_) {},
    );
  }

  final diagnosticRows = <List<Object?>>[];
  setUp(() {
    calls = [];
    malformed = false;
    physicalUi = false;
    earlyCameraClose = false;
    rejectDiagnostic = false;
    revealBytes = null;
    cameraDrain = null;
    nativeResources.clear();
    diagnosticRows.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(events, (call) async => null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(method, (call) async {
          calls.add(call.method);
          final args = call.arguments! as List<Object?>;
          if (call.method == 'open') {
            final handle = open(args[1]! as int);
            if (handle == 0) throw StateError('真实Core创建失败');
            final id = 'sdk-$handle';
            handles[id] = handle;
            return [
              2,
              id,
              0,
              malformed
                  ? <Object?>['created', 1]
                  : <Object?>[
                      'created',
                      1,
                      BigInt.from(handle).toUnsigned(64).toString(),
                    ],
            ];
          }
          if (call.method == 'close') {
            expect(nativeResources, isEmpty);
            final id = args[1]! as String, handle = handles[id]!;
            expect(
              api.citizensdk_accept_request_sequence(handle, args[2]! as int),
              0,
            );
            var status = 18;
            for (var i = 0; i < 200 && status == 18; i++) {
              status = close(handle);
              if (status == 18)
                await Future<void>.delayed(const Duration(milliseconds: 5));
            }
            expect(status, 0);
            handles.remove(id);
            return [
              2,
              id,
              args[2],
              ['disposed'],
            ];
          }
          if (call.method == 'diagnose') {
            if (rejectDiagnostic)
              throw StateError('finite diagnostic IO failure');
            final row = List<Object?>.of(args[2]! as List<Object?>);
            CitizenSdkDiagnostic.decode(row);
            diagnosticRows.add(row);
            if (diagnosticRows.length > 128) diagnosticRows.removeAt(0);
            return [2, args[1], 0, <Object?>[]];
          }
          if (call.method == 'readDiagnostics') {
            expect(
              api.citizensdk_accept_request_sequence(
                handles[args[1]]!,
                args[2]! as int,
              ),
              0,
            );
            return [
              2,
              args[1],
              args[2],
              [List<List<Object?>>.of(diagnosticRows)],
            ];
          }
          // 只模拟物理显示/相机确认与排空；不提供钱包、签名、链或QR业务结果。
          if (physicalUi) {
            expect(
              api.citizensdk_accept_request_sequence(
                handles[args[1]]!,
                args[2]! as int,
              ),
              0,
            );
            List<Object?> value;
            switch (call.method) {
              case 'openPrivateKey':
                nativeResources.add('private');
                value = ['private'];
              case 'revealPrivateKey':
                revealBytes = Completer<Uint8List>();
                value = [await revealBytes!.future];
              case 'closePrivateKey':
                if (revealBytes != null) await revealBytes!.future;
                nativeResources.remove('private');
                value = [];
              case 'openQrCapture':
                nativeResources.add('camera');
                if (earlyCameraClose) {
                  emit('qrCaptureClosed', ['camera']);
                  await Future<void>.delayed(Duration.zero);
                }
                value = ['camera', 4, 320, 240, 0];
              case 'closeQrCapture':
                await cameraDrain?.future;
                nativeResources.remove('camera');
                value = [];
              case 'resumeQrCapture':
              case 'pauseQrCapture':
              case 'setQrCaptureTorch':
                value = [];
              default:
                throw StateError('non-resource UI call');
            }
            return [2, args[1], args[2], value];
          }
          throw StateError('业务调用进入了系统资源通道：${call.method}');
        });
  });
  tearDown(() async {
    expect(handles, isEmpty);
    expect(nativeResources, isEmpty);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(method, null);
  });
  Future<CitizenSdk> wallet() =>
      CitizenSdk.open(modules: CitizenSdkModules.wallet | CitizenSdkModules.qr);
  Future<CitizenSdk> hot(int mode) async {
    final sdk = await CitizenSdk.open(
      modules:
          CitizenSdkModules.wallet |
          CitizenSdkModules.signing |
          CitizenSdkModules.qr,
    );
    expect(vault(handles.values.single, mode), 0);
    return sdk;
  }

  Future<void> finishPhysical(CitizenSdk sdk, int handle) async {
    if (vaultPending(handle) != 0) expect(vaultComplete(handle, 22), 0);
    await sdk.close().timeout(const Duration(seconds: 5));
  }

  String account(int b) => citizenAccountIdFromBytes(List<int>.filled(32, b));
  test('唯一生成声明与实际Core一致，旧构造不导出', () {
    expect(api.citizensdk_abi_version(), c.CITIZENSDK_ABI_VERSION);
    for (final name in [
      'citizensdk_create_with_modules',
      'citizensdk_create_with_store',
      'citizensdk_create_with_host',
      'citizensdk_set_secret_presence_provider',
    ]) {
      expect(() => library.lookup<Void>(name), throwsArgumentError);
    }
  });
  test('只打开QR真实Core，无钱包/链资源', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    try {
      expect(await sdk.lifecycle, CitizenSdkLifecycle.created);
      final snapshot = await sdk.getCapabilities();
      expect(snapshot.statuses, hasLength(10));
      final wire = await sdk.encodeAccountId(account(1));
      expect((await sdk.parseQr(wire)).accountId, account(1));
    } finally {
      await sdk.close();
    }
    expect(calls.where((method) => method != 'diagnose'), ['open', 'close']);
  });
  test('扫码用途由Core同一次解析拒绝不匹配输入', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    try {
      final text = await sdk.encodeAccountId(account(2));
      expect(
        (await sdk.parseForPurpose(
          text,
          CitizenQrScanPurpose.coldAccountImport,
        )).document.accountId,
        account(2),
      );
      await expectLater(
        sdk.parseForPurpose(text, CitizenQrScanPurpose.externalSignature),
        throwsA(isA<CitizenSdkException>()),
      );
    } finally {
      await sdk.close();
    }
  });
  test('钱包真实SQLite读写，余额/链方法不走系统通道', () async {
    final sdk = await wallet();
    try {
      expect((await sdk.getWalletState().result).accounts, isEmpty);
      final state = await sdk
          .importColdAccount(accountId: account(3), name: '本轮临时账户')
          .result;
      expect(state.accounts.single.accountId, account(3));
      expect(
        (await sdk.getWalletState().result).accounts.single.name,
        '本轮临时账户',
      );
      await expectLater(
        sdk.getFinalizedHead(),
        throwsA(
          isA<CitizenSdkException>().having(
            (e) => e.code,
            'Core原类别',
            CitizenSdkErrorCode.unsupported,
          ),
        ),
      );
    } finally {
      await sdk.close();
    }
    expect(calls.where((method) => method != 'diagnose'), ['open', 'close']);
  });
  test('未选钱包模块真实拒绝，不构造空钱包', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    try {
      await expectLater(
        sdk.getWalletState().result,
        throwsA(isA<CitizenSdkException>()),
      );
    } finally {
      await sdk.close();
    }
  });
  test('规范地址导入与字节身份共用同一Core目录', () async {
    final sdk = await wallet();
    try {
      final id = account(4);
      final address = citizenSs58FromAccountId(id);
      await sdk.importColdAccount(ss58Address: address).result;
      expect((await sdk.getWalletState().result).accounts.single.accountId, id);
    } finally {
      await sdk.close();
    }
  });
  test('有效扫码代码直接导入实际冷目录', () async {
    final sdk = await wallet();
    try {
      final wire = await sdk.encodeAccountId(account(5));
      expect(
        (await sdk.importColdAccountCode(code: wire).result)
            .accounts
            .single
            .accountId,
        account(5),
      );
    } finally {
      await sdk.close();
    }
  });
  test('真实检查快照归还后失效，父关闭可重复', () async {
    final sdk = await wallet();
    final inspection = await sdk.inspectWallets().result;
    expect(inspection.state.accounts, isEmpty);
    await inspection.release();
    expect(() => inspection.delete(0), throwsA(isA<CitizenSdkException>()));
    await sdk.close();
    await sdk.close();
    expect(calls.where((method) => method != 'diagnose'), ['open', 'close']);
  });
  test('多个真实实例互不共享SQLite目录', () async {
    final a = await wallet(), b = await wallet();
    try {
      await a.importColdAccount(accountId: account(6)).result;
      expect((await a.getWalletState().result).accounts, hasLength(1));
      expect((await b.getWalletState().result).accounts, isEmpty);
    } finally {
      await a.close();
      await b.close();
    }
  });
  test('真实异步错误保留类别/阶段，失败后仍可读', () async {
    final sdk = await wallet();
    try {
      await expectLater(
        sdk
            .renameWallet(
              expectedRevision: BigInt.one,
              walletIndex: 99,
              name: 'missing',
            )
            .result,
        throwsA(isA<CitizenSdkException>()),
      );
      expect((await sdk.getWalletState().result).accounts, isEmpty);
    } finally {
      await sdk.close();
    }
  });
  test('无硬件金库的本轮夹具不能伪造本地签名就绪', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.signing);
    try {
      final caps = await sdk.getCapabilities();
      expect(
        caps.statuses
            .firstWhere((s) => s.name == CitizenCapabilityName.localSigning)
            .ready,
        isFalse,
      );
    } finally {
      await sdk.close();
    }
  });
  test('公开验签只调用真实密码学，不创建资源', () async {
    final vectors =
        jsonDecode(
              File(
                'core/tests/citizenchain-wallet-derivation-v1.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    final cases = vectors['cases'] as List;
    final first = cases.first as Map;
    final rows = first['accounts'] as List;
    final id = (rows.first as Map)['account_id'] as String;
    final signature = Uint8List(64)..[63] = 128;
    expect(
      await CitizenSdk.verify(
        accountId: id,
        signature: signature,
        payload: Uint8List.fromList([1]),
      ),
      isFalse,
    );
    expect(calls, isEmpty);
  });
  test('接纳取消只请求Core，终态实际返回一次', () async {
    final sdk = await wallet();
    try {
      final op = sdk.getWalletState();
      expect(BigInt.parse(op.operationId) > BigInt.zero, isTrue);
      expect(await op.cancel(), isA<bool>());
      try {
        await op.result;
      } on CitizenSdkException catch (e) {
        expect(e.code, CitizenSdkErrorCode.cancelled);
      }
    } finally {
      await sdk.close();
    }
  });
  test('父关闭先排空实际在途读取', () async {
    final sdk = await wallet();
    final reads = List.generate(
      16,
      (_) => sdk.getWalletState().result.then<void>(
        (_) {},
        onError: (Object e, StackTrace s) {},
      ),
    );
    await sdk.close();
    await Future.wait(reads);
  });
  test('格式错误的资源open回包归还已经创建的Core', () async {
    malformed = true;
    await expectLater(wallet(), throwsA(isA<CitizenSdkException>()));
    expect(handles, isEmpty);
    expect(calls.where((method) => method != 'diagnose'), ['open', 'close']);
  });
  test('关闭后不再接纳真实Core调用', () async {
    final sdk = await wallet();
    await sdk.close();
    expect(() => sdk.getWalletState(), throwsA(isA<CitizenSdkException>()));
    await expectLater(
      sdk.getCapabilities(),
      throwsA(isA<CitizenSdkException>()),
    );
  });
  test('真实热准备提交成功后释放幂等，恢复词副本清零且父关闭完成', () async {
    final sdk = await hot(1), handle = handles.values.single;
    try {
      final prepared = await sdk
          .prepareWalletCreation(wordCount: CitizenWalletWordCount.words12)
          .result;
      final phrase = await prepared.recoveryPhrase(), borrowed = phrase.bytes;
      expect(borrowed.isNotEmpty, isTrue);
      await prepared.commit().result;
      expect((await sdk.getWalletState().result).hotProfile != null, isTrue);
      await phrase.release();
      expect(borrowed.every((b) => b == 0), isTrue);
      await prepared.release();
      await prepared.release();
    } finally {
      await finishPhysical(sdk, handle);
    }
  });
  test('真实提交作业失败后释放不覆盖原金库错误，父关闭不遗留准备', () async {
    final sdk = await hot(2), handle = handles.values.single;
    try {
      final prepared = await sdk
          .prepareWalletCreation(wordCount: CitizenWalletWordCount.words12)
          .result;
      await expectLater(
        prepared.commit().result,
        throwsA(
          isA<CitizenSdkException>().having(
            (e) => e.code,
            'code',
            CitizenSdkErrorCode.unavailable,
          ),
        ),
      );
      await prepared.release();
    } finally {
      await finishPhysical(sdk, handle);
    }
  });
  test('父关闭先请求取消，再等待不可取消提交的真实成功终态', () async {
    final sdk = await hot(3), handle = handles.values.single;
    try {
      final prepared = await sdk
          .prepareWalletCreation(wordCount: CitizenWalletWordCount.words12)
          .result;
      final operation = prepared.commit();
      final terminal = operation.result.then<Object?>(
        (v) => v,
        onError: (Object e) => e,
      );
      final until = DateTime.now().add(const Duration(seconds: 5));
      while (vaultPending(handle) == 0 && DateTime.now().isBefore(until)) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(vaultPending(handle), 1);
      final closing = sdk.close().then<Object?>(
        (_) => null,
        onError: (Object error) => error,
      );
      await Future<void>.delayed(Duration.zero);
      // Core将此写操作明确标为不可取消；诊断核对实际取消尝试，不能篡改成功终态。
      expect(
        diagnosticRows.any(
          (row) =>
              row[0] == 'cancelOperation' &&
              row[1] == 'COMPLETE' &&
              row[2] == 4,
        ),
        isTrue,
      );
      expect(vaultComplete(handle, 0), 0);
      expect(
        await terminal.timeout(const Duration(seconds: 5)),
        isA<CitizenWalletProfile>(),
      );
      expect(await closing.timeout(const Duration(seconds: 5)), isNull);
    } finally {
      await finishPhysical(sdk, handle);
    }
  });
  test('本地读取诊断由真实操作上报，失败类别保留且不含账户和异常正文', () async {
    final sdk = await wallet();
    try {
      await sdk.getWalletState().result;
      final rows = await sdk.readDiagnostics();
      expect(
        rows.any(
          (r) =>
              r.method == 'getWalletState' &&
              r.phase == 'COMPLETE' &&
              r.code == 0 &&
              r.point == 'RESULT_READY',
        ),
        isTrue,
      );
      final serialized = rows.map((r) => r.toString()).join();
      expect(serialized.contains(account(1)), isFalse);
      expect(serialized.contains('failed'), isFalse);
      expect(await sdk.readDiagnostics(), hasLength(rows.length));
    } finally {
      await sdk.close();
    }
  });
  test('输入过长由Core返回结构化原因，诊断IO失败不改变实际目录读取', () async {
    final sdk = await wallet();
    try {
      expect(
        (await sdk.validatePassword('x' * 1025)).reason,
        CitizenWalletInputReason.inputTooLong,
      );
      rejectDiagnostic = true;
      expect((await sdk.getWalletState().result).accounts, isEmpty);
    } finally {
      await sdk.close();
    }
  });
  test('真实模块拒绝进入闭集诊断，保留Core异步终态且不写正文', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    try {
      await expectLater(
        sdk.getWalletState().result,
        throwsA(isA<CitizenSdkException>()),
      );
      final rows = await sdk.readDiagnostics();
      expect(
        rows.any(
          (r) =>
              r.method == 'getWalletState' &&
              r.phase == 'COMPLETE' &&
              r.code == 4,
        ),
        isTrue,
      );
    } finally {
      await sdk.close();
    }
  });
  test('Dart取钥资源在迟到显示时拒绝交付，并等待物理关闭确认', () async {
    final sdk = await wallet();
    physicalUi = true;
    try {
      final key = await sdk.openPrivateKey(account(8));
      final reveal = key.reveal().then<Object?>(
        (value) => value,
        onError: (Object error) => error,
      );
      await Future<void>.delayed(Duration.zero);
      expect(revealBytes, isNotNull);
      var closed = false;
      final closing = key.close().then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);
      revealBytes!.complete(Uint8List(32));
      expect(
        await reveal,
        isA<CitizenSdkException>().having(
          (e) => e.code,
          'code',
          CitizenSdkErrorCode.cancelled,
        ),
      );
      await closing;
      await key.closed;
    } finally {
      if (revealBytes != null && !revealBytes!.isCompleted)
        revealBytes!.complete(Uint8List(32));
      await sdk.close();
    }
  });
  test('Dart拥有的显式显示副本在关闭时清零，重复关闭不重复归还', () async {
    final sdk = await wallet();
    physicalUi = true;
    try {
      final key = await sdk.openPrivateKey(account(9));
      final revealing = key.reveal();
      await Future<void>.delayed(Duration.zero);
      revealBytes!.complete(Uint8List.fromList(List<int>.filled(32, 0x55)));
      final borrowed = await revealing;
      expect(borrowed.every((b) => b == 0x55), isTrue);
      await key.close();
      expect(borrowed.every((b) => b == 0), isTrue);
      await key.close();
    } finally {
      if (revealBytes != null && !revealBytes!.isCompleted)
        revealBytes!.complete(Uint8List(32));
      await sdk.close();
    }
  });
  test('Dart相机关闭等待物理纹理排空，暂停订阅不阻塞归还', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    physicalUi = true;
    try {
      final capture = await sdk.openQrCapture(CitizenQrScanPurpose.generalScan);
      final preview = Completer<CitizenQrPreview>();
      final subscription = capture.previewChanges.listen(
        (value) => preview.complete(value),
      );
      emit('qrCapturePreview', ['camera', 240, 320, 90]);
      expect((await preview.future).rotationDegrees, 90);
      subscription.pause();
      cameraDrain = Completer<void>();
      var closed = false;
      final closing = capture.close().then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);
      cameraDrain!.complete();
      await closing;
      await subscription.cancel();
    } finally {
      if (cameraDrain != null && !cameraDrain!.isCompleted)
        cameraDrain!.complete();
      await sdk.close();
    }
  });
  test('物理相机关闭早于open回包时仍归还真实资源', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    physicalUi = true;
    earlyCameraClose = true;
    try {
      await expectLater(
        sdk.openQrCapture(CitizenQrScanPurpose.generalScan),
        throwsA(isA<CitizenSdkException>()),
      );
      expect(nativeResources, isEmpty);
    } finally {
      await sdk.close();
    }
  });
}
