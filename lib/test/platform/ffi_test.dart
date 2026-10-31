// ignore_for_file: depend_on_referenced_packages
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/platform/bind.dart' as c;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final fixture = CitizenSdkTestFixture();
  setUp(fixture.install);
  tearDown(fixture.dispose);
  Future<CitizenSdk> wallet() =>
      CitizenSdk.open(modules: CitizenSdkModules.wallet | CitizenSdkModules.qr);
  Future<CitizenSdk> hot(int mode) async {
    final sdk = await CitizenSdk.open(
      modules:
          CitizenSdkModules.wallet |
          CitizenSdkModules.signing |
          CitizenSdkModules.qr,
    );
    expect(fixture.vault(fixture.handles.values.single, mode), 0);
    return sdk;
  }

  Future<void> finishPhysical(CitizenSdk sdk, int handle) async {
    if (fixture.vaultPending(handle) != 0) {
      expect(fixture.vaultComplete(handle, 22), 0);
    }
    await sdk.close().timeout(const Duration(seconds: 5));
  }

  String account(int b) => citizenAccountIdFromBytes(List<int>.filled(32, b));
  test('唯一生成声明与实际Core一致，旧构造不导出', () {
    expect(fixture.api.citizensdk_abi_version(), c.CITIZENSDK_ABI_VERSION);
    for (final name in [
      'citizensdk_create_with_modules',
      'citizensdk_create_with_store',
      'citizensdk_create_with_host',
      'citizensdk_set_secret_presence_provider',
    ]) {
      expect(() => fixture.library.lookup<Void>(name), throwsArgumentError);
    }
  });
  test('夹具会话关闭不等待或清理其它会话的相机资源', () async {
    fixture.physicalUi = true;
    final peer = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    final owner = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    final capture = await owner.openQrCapture(
      CitizenQrScanPurpose.coldAccountImport,
    );
    try {
      await peer.close();
      expect(fixture.nativeResources, isNotEmpty);
      final next = capture.results.first;
      final wire = await owner.encodeAccountId(account(3));
      fixture.scanText(wire, CitizenQrScanPurpose.coldAccountImport);
      expect((await next).accountId, account(3));
    } finally {
      await capture.close();
      await owner.close();
      if (peer.lifecycle != CitizenSdkLifecycle.disposed) await peer.close();
    }
  });
  test('有限相机夹具连续帧只交付真实Core文档，拒绝用途不符和坏输入', () async {
    fixture.physicalUi = true;
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    final capture = await sdk.openQrCapture(
      CitizenQrScanPurpose.coldAccountImport,
    );
    final frames = StreamIterator(capture.results);
    try {
      for (final b in [1, 2]) {
        final wire = await sdk.encodeAccountId(account(b));
        final next = frames.moveNext();
        fixture.scanText(wire, CitizenQrScanPurpose.coldAccountImport);
        expect(await next, isTrue);
        expect(frames.current.accountId, account(b));
        expect(frames.current.canonicalText, wire);
        expect(
          () => fixture.scanText(wire, CitizenQrScanPurpose.externalSignature),
          throwsStateError,
        );
      }
      expect(
        () => fixture.scanText(
          'not a QR document',
          CitizenQrScanPurpose.coldAccountImport,
        ),
        throwsStateError,
      );
    } finally {
      await frames.cancel();
      await capture.close();
      await sdk.close();
    }
  });
  test('只打开QR真实Core，无钱包/链资源', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    try {
      expect(sdk.lifecycle, CitizenSdkLifecycle.created);
      final snapshot = await sdk.getCapabilities();
      expect(snapshot.statuses, hasLength(10));
      final wire = await sdk.encodeAccountId(account(1));
      expect((await sdk.parseQr(wire)).accountId, account(1));
    } finally {
      await sdk.close();
    }
    expect(fixture.calls.where((method) => method != 'diagnose'), [
      'open',
      'close',
    ]);
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
    expect(fixture.calls.where((method) => method != 'diagnose'), [
      'open',
      'close',
    ]);
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
    expect(fixture.calls.where((method) => method != 'diagnose'), [
      'open',
      'close',
    ]);
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
    expect(fixture.calls, isEmpty);
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
    fixture.malformed = true;
    await expectLater(wallet(), throwsA(isA<CitizenSdkException>()));
    expect(fixture.handles, isEmpty);
    expect(fixture.calls.where((method) => method != 'diagnose'), [
      'open',
      'close',
    ]);
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
    final sdk = await hot(1), handle = fixture.handles.values.single;
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
    final sdk = await hot(2), handle = fixture.handles.values.single;
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
    final sdk = await hot(3), handle = fixture.handles.values.single;
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
      while (fixture.vaultPending(handle) == 0 &&
          DateTime.now().isBefore(until)) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(fixture.vaultPending(handle), 1);
      final closing = sdk.close().then<Object?>(
        (_) => null,
        onError: (Object error) => error,
      );
      await Future<void>.delayed(Duration.zero);
      // Core将此写操作明确标为不可取消；诊断核对实际取消尝试，不能篡改成功终态。
      expect(
        fixture.diagnosticRows.any(
          (row) =>
              row[0] == 'cancelOperation' &&
              row[1] == 'COMPLETE' &&
              row[2] == 4,
        ),
        isTrue,
      );
      expect(fixture.vaultComplete(handle, 0), 0);
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
      fixture.rejectDiagnostic = true;
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
    fixture.physicalUi = true;
    try {
      final key = await sdk.openPrivateKey(account(8));
      final reveal = key.reveal().then<Object?>(
        (value) => value,
        onError: (Object error) => error,
      );
      await Future<void>.delayed(Duration.zero);
      expect(fixture.revealBytes, isNotNull);
      var closed = false;
      final closing = key.close().then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);
      fixture.revealBytes!.complete(Uint8List(32));
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
      if (fixture.revealBytes != null && !fixture.revealBytes!.isCompleted) {
        fixture.revealBytes!.complete(Uint8List(32));
      }
      await sdk.close();
    }
  });
  test('Dart拥有的显式显示副本在关闭时清零，重复关闭不重复归还', () async {
    final sdk = await wallet();
    fixture.physicalUi = true;
    try {
      final key = await sdk.openPrivateKey(account(9));
      final revealing = key.reveal();
      await Future<void>.delayed(Duration.zero);
      fixture.revealBytes!.complete(
        Uint8List.fromList(List<int>.filled(32, 0x55)),
      );
      final borrowed = await revealing;
      expect(borrowed.every((b) => b == 0x55), isTrue);
      await key.close();
      expect(borrowed.every((b) => b == 0), isTrue);
      await key.close();
    } finally {
      if (fixture.revealBytes != null && !fixture.revealBytes!.isCompleted) {
        fixture.revealBytes!.complete(Uint8List(32));
      }
      await sdk.close();
    }
  });
  test('Dart相机关闭等待物理纹理排空，暂停订阅不阻塞归还', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    fixture.physicalUi = true;
    try {
      final capture = await sdk.openQrCapture(CitizenQrScanPurpose.generalScan);
      final preview = Completer<CitizenQrPreview>();
      final subscription = capture.previewChanges.listen(
        (value) => preview.complete(value),
      );
      fixture.emit('qrCapturePreview', ['camera', 240, 320, 90]);
      expect((await preview.future).rotationDegrees, 90);
      subscription.pause();
      fixture.cameraDrain = Completer<void>();
      var closed = false;
      final closing = capture.close().then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);
      fixture.cameraDrain!.complete();
      await closing;
      await subscription.cancel();
    } finally {
      if (fixture.cameraDrain != null && !fixture.cameraDrain!.isCompleted) {
        fixture.cameraDrain!.complete();
      }
      await sdk.close();
    }
  });
  test('物理相机关闭早于open回包时仍归还真实资源', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);
    fixture.physicalUi = true;
    fixture.earlyCameraClose = true;
    try {
      await expectLater(
        sdk.openQrCapture(CitizenQrScanPurpose.generalScan),
        throwsA(isA<CitizenSdkException>()),
      );
      expect(fixture.nativeResources, isEmpty);
    } finally {
      await sdk.close();
    }
  });
}
