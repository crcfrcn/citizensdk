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
  // 余额依赖真实账户编解码，统一在本阶段注册一次。
  _balances();
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
  test('真实事件向量严格解码并复用原始交易哈希', () async {
    Uint8List fixtureBytes(String name) {
      final hex = File('core/tests/$name').readAsStringSync().trim();
      return Uint8List.fromList([
        for (var i = 2; i < hex.length; i += 2)
          int.parse(hex.substring(i, i + 2), radix: 16),
      ]);
    }

    final block = CitizenBlockRef(
      hash: '0x${'05' * 32}',
      number: BigInt.one,
      finality: CitizenBlockFinality.finalized,
    );
    final runtime = CitizenRuntimeContext(
      block: block,
      specVersion: 100,
      transactionVersion: 12,
      metadata: fixtureBytes('citizenchain-runtime-v14-metadata.hex'),
    );
    final bytes = fixtureBytes('citizenchain-runtime-system-events.hex');
    final events = await readCitizenFinalizedEvents(
      block,
      readEvents: (_) async => bytes,
      readRuntime: (_) async => runtime,
    );
    expect(
      events.any(
        (e) =>
            e.pallet == 'System' &&
            e.name == 'ExtrinsicSuccess' &&
            e.extrinsicIndex == 0,
      ),
      isTrue,
    );
    expect(
      events.any(
        (e) =>
            e.pallet == 'System' &&
            e.name == 'ExtrinsicFailed' &&
            e.extrinsicIndex == 1,
      ),
      isTrue,
    );
    expect(
      () => runtime.decodeSystemEvents(Uint8List.fromList([...bytes, 0])),
      throwsA(isA<CitizenSdkException>()),
    );
    final extrinsic = Uint8List.fromList([12, 132, 1, 2]);
    final body = CitizenBlockBody(block: block, extrinsics: [extrinsic]);
    final digest = CitizenScale.blake2b256(
      extrinsic,
    ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
    expect(body.transactionHashAt(0), '0x$digest');
    expect(() => body.transactionHashAt(1), throwsFormatException);
  });

  test('钱包事实保留同一失败执行的每条实际扣费', () async {
    final block = CitizenBlockRef(
      hash: '0x${'06' * 32}',
      number: BigInt.one,
      finality: CitizenBlockFinality.finalized,
    );
    final from = account(1);
    final to = account(2);
    List<String> bytes(int byte) => List<String>.filled(32, '$byte');
    CitizenSystemEvent event(
      int eventIndex,
      String pallet,
      String name,
      Object? fields,
    ) => CitizenSystemEvent(
      eventIndex: eventIndex,
      extrinsicIndex: 0,
      pallet: pallet,
      name: name,
      fields: fields,
    );
    final events = [
      event(0, 'Balances', 'Transfer', {
        'from': bytes(1),
        'to': bytes(2),
        'amount': '9007199254740993',
      }),
      event(1, 'OnchainTransaction', 'FeePaid', {
        'account_id': bytes(1),
        'fee': '10',
      }),
      event(2, 'OnchainTransaction', 'FeePaid', {
        'account_id': bytes(2),
        'fee': '20',
      }),
      event(3, 'System', 'ExtrinsicFailed', null),
    ];
    final body = CitizenBlockBody(
      block: block,
      extrinsics: [
        Uint8List.fromList([12, 132, 1, 2]),
      ],
    );
    final facts = await readCitizenWalletEvents(
      block,
      [from, to],
      readEvents: (_) async => events,
      readBody: (_) async => body,
    );
    expect(facts.transfers, isEmpty);
    expect(
      facts.fees.map((fee) => (fee.accountId, fee.feeFen, fee.eventIndex)),
      [(from, BigInt.from(10), 1), (to, BigInt.from(20), 2)],
    );
    expect(
      facts.fees.map((fee) => fee.status),
      everyElement(CitizenExecutionStatus.failed),
    );
    expect(
      facts.fees.map((fee) => fee.transactionHash),
      everyElement(body.transactionHashAt(0)),
    );
  });

  test('原生 AccountId 和 SS58 共用冻结钱包向量', () {
    final golden =
        jsonDecode(
              File(
                'core/tests/citizenchain-wallet-derivation-v1.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    for (final entry in golden['cases'] as List<dynamic>) {
      final accounts =
          (entry as Map<String, dynamic>)['accounts'] as List<dynamic>;
      for (final value in accounts) {
        final row = value as Map<String, dynamic>;
        final address = row['ss58'] as String?;
        if (address == null) continue;
        final id = row['account_id'] as String;
        final bytes = citizenAccountIdBytesFromSs58(address);
        expect(citizenAccountIdFromBytes(bytes), id);
        expect(citizenAccountIdBytes(id), orderedEquals(bytes));
        expect(citizenSs58FromAccountIdBytes(bytes), address);
        expect(citizenSs58FromAccountId(id), address);
        expect(isCitizenAccountId(id), isTrue);
      }
    }
  });
  test('账户文本、字节与 SS58 的无效输入均由正式入口拒绝', () {
    final id = account(0xab);
    for (final invalid in [
      id.toUpperCase(),
      id.substring(2),
      '$id\n',
      '0x${'g' * 64}',
    ]) {
      expect(isCitizenAccountId(invalid), isFalse);
      expect(() => citizenAccountIdBytes(invalid), throwsFormatException);
    }
    for (final invalid in [
      List<int>.filled(31, 0),
      List<int>.filled(32, -1),
      List<int>.filled(32, 256),
    ]) {
      expect(() => citizenAccountIdFromBytes(invalid), throwsArgumentError);
      expect(() => citizenSs58FromAccountIdBytes(invalid), throwsArgumentError);
    }
    final address = citizenSs58FromAccountId(id);
    final corrupt =
        address.substring(0, address.length - 1) +
        (address.endsWith('1') ? '2' : '1');
    for (final invalid in [
      '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      '2',
      corrupt,
    ]) {
      expect(
        () => citizenAccountIdBytesFromSs58(invalid),
        throwsFormatException,
      );
    }
  });
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
          .importColdAccount(account(3), name: '本轮临时账户')
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
  test('手填 AccountId 与 SS58 使用同一冷账户目录', () async {
    final sdk = await wallet();
    try {
      final id = account(4);
      final address = citizenSs58FromAccountId(id);
      final byId = await sdk.importColdAccount(id).result;
      expect(byId.accounts.single.accountId, id);
      expect(byId.accounts.single.ss58Address, address);
      await expectLater(
        sdk.importColdAccount(address).result,
        throwsA(
          isA<CitizenSdkException>().having(
            (error) => error.code,
            '重复账户',
            CitizenSdkErrorCode.conflict,
          ),
        ),
      );
      final corrupt =
          '${address.substring(0, address.length - 1)}'
          '${address.endsWith('1') ? '2' : '1'}';
      for (final invalid in [
        '',
        '0x12',
        '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
        corrupt,
      ]) {
        await expectLater(
          Future.sync(() => sdk.importColdAccount(invalid).result),
          throwsA(
            isA<CitizenSdkException>().having(
              (error) => error.code,
              '非法账户输入',
              CitizenSdkErrorCode.invalidArgument,
            ),
          ),
        );
      }
      final afterRejections = await sdk.getWalletState().result;
      expect(afterRejections.revision, byId.revision);
      expect(afterRejections.accounts.single.accountId, id);

      final otherId = account(7);
      final otherAddress = citizenSs58FromAccountId(otherId);
      final byAddress = await sdk.importColdAccount(otherAddress).result;
      expect(byAddress.accounts.map((entry) => entry.accountId), [id, otherId]);
      expect(byAddress.accounts.last.ss58Address, otherAddress);
      expect(byAddress.revision, byId.revision + BigInt.one);
    } finally {
      await sdk.close();
    }
  });
  test('SDK Compact 在边界用最短编码，并拒绝冗余编码', () {
    expect(CitizenScale.compact(63), [0xfc]);
    expect(CitizenScale.compact(64), [0x01, 0x01]);
    expect(CitizenScale.readCompact(Uint8List.fromList([0, 1, 1]), 1), (64, 2));
    expect(
      () => CitizenScale.readCompact(Uint8List.fromList([0xfd, 0]), 0),
      throwsFormatException,
    );
  });
  test('同轮目录和诊断检查共享一个读取，取消单方不影响另一方', () async {
    final sdk = await wallet();
    try {
      await sdk.importColdAccount(account(7)).result;
      final read = sdk.getWalletState(), inspect = sdk.inspectWallets();
      expect(read.operationId, inspect.operationId);
      expect(await read.cancel(), isFalse);
      final inspection = await inspect.result;
      expect(identical(await read.result, inspection.state), isTrue);
      await inspection.release();
      final removed = await sdk.deleteAccount(account(7)).result;
      expect(removed.removedAccountIds, [account(7)]);
      expect(removed.cleanupPending, isFalse);
      expect((await sdk.getWalletState().result).removedAccountIds, isEmpty);
      await sdk.importColdAccount(account(8)).result;
      await sdk.importColdAccount(account(9)).result;
      final wipe = await sdk.deleteWallet().result;
      expect(wipe.removedAccountIds, [account(8), account(9)]);
      expect(wipe.accounts, isEmpty);
      expect((await sdk.deleteWallet().result).removedAccountIds, isEmpty);
    } finally {
      await sdk.close();
    }
  });

  test('钱包会话的空余额批量仍走 Core 运行门', () async {
    final sdk = await wallet();
    try {
      await expectLater(
        sdk.getAccountBalances(const []),
        throwsA(
          isA<CitizenSdkException>().having(
            (error) => error.code,
            'code',
            CitizenSdkErrorCode.notReady,
          ),
        ),
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
      await a.importColdAccount(account(6)).result;
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
      final state = await sdk.getWalletState().result;
      expect(state.hotProfile, isNotNull);
      expect(phrase.isClosed, isFalse);
      await sdk
          .renameWallet(
            expectedRevision: state.revision,
            walletIndex: 0,
            name: '备份撤销测试',
          )
          .result;
      await phrase.closed.timeout(const Duration(seconds: 4));
      expect(() => phrase.bytes, throwsA(isA<CitizenSdkException>()));
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

/// 共享余额批读、取消、前后台及持久化回归；原生库由同一FFI入口交付。
void _balances() {
  String id(int n) => '0x${n.toRadixString(16).padLeft(64, '0')}';
  CitizenBlockRef block(int n) => CitizenBlockRef(
    hash: id(n),
    number: BigInt.from(n),
    finality: CitizenBlockFinality.finalized,
  );
  CitizenAccountBalance value(String account, int height, [int amount = 100]) =>
      CitizenAccountBalance(
        accountId: account,
        block: block(height),
        freeFen: BigInt.from(amount),
        reservedFen: BigInt.zero,
        totalFen: BigInt.from(amount),
      );
  Future<void> settle() async {
    for (var i = 0; i < 12; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  test(
    'overlapping subscribers share one batch and release stops reads',
    () async {
      var head = 104;
      final calls = <List<String>>[];
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          calls.add(ids);
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      final a = store.watch([id(1), id(2)]);
      final b = store.watch([id(2), id(3)]);
      await settle();
      expect(calls, hasLength(1));
      expect(calls.single.toSet(), {id(1), id(2), id(3)});
      a();
      b();
      head = 105;
      store.finalized(block(head));
      await settle();
      expect(calls, hasLength(1));
    },
  );

  test(
    'a cached balance at 102 is refreshed at 105 without transaction history',
    () async {
      var writes = 0;
      var raw = jsonEncode({
        'chain': {
          'block_hash': id(102),
          'block_number': '102',
          'free_fen': '0',
          'reserved_fen': '0',
        },
      });
      final store = CitizenBalances(
        getFinalizedHead: () async => block(105),
        getAccountBalances: (ids) async => [
          for (final a in ids) value(a, 105, 1000000),
        ],
        storage: (
          read: (_) async => raw,
          write: (_, update) async {
            writes++;
            raw = update(raw)!;
          },
        ),
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      expect(store.accountState(id(1)).value!.freeFen, BigInt.from(1000000));
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(105));
      expect(writes, 1);
    },
  );

  test(
    'inflight reads skip intermediate heads and catch the latest one',
    () async {
      var head = 103;
      final gate = Completer<void>();
      final calls = <int>[];
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          final anchor = head;
          calls.add(anchor);
          if (calls.length == 1) await gate.future;
          return [for (final a in ids) value(a, anchor, anchor)];
        },
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      head = 104;
      store.finalized(block(head));
      head = 105;
      store.finalized(block(head));
      gate.complete();
      await settle();
      expect(calls, [103, 105]);
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(105));
    },
  );

  test(
    'unchanged amounts advance the proof without disk writes or notifications',
    () async {
      var head = 1, writes = 0, notifications = 0;
      String? raw;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async => [
          for (final a in ids) value(a, head),
        ],
        storage: (
          read: (_) async => raw,
          write: (_, update) async {
            writes++;
            raw = update(raw);
          },
        ),
      );
      addTearDown(store.close);
      final state = store.accountState(id(1));
      state.addListener(() {
        notifications++;
      });
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      expect(writes, 1);
      expect(notifications, 1);
      head = 2;
      store.finalized(block(head));
      await settle();
      expect(writes, 1);
      expect(notifications, 1);
      expect(state.value!.block.number, BigInt.two);
    },
  );

  test(
    'background and hidden watches stop scheduling; resume checks the latest head',
    () async {
      var head = 1, calls = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          calls++;
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      store.setForeground(false);
      head = 5;
      store.finalized(block(head));
      await settle();
      expect(calls, 1);
      store.setForeground(true);
      await settle();
      expect(calls, 2);
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(5));
    },
  );

  test(
    'removal drains inflight reads and prevents a late cache write',
    () async {
      final gate = Completer<void>();
      var writes = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(1),
        getAccountBalances: (ids) async {
          await gate.future;
          return [for (final a in ids) value(a, 1)];
        },
        storage: (
          read: (_) async => null,
          write: (_, update) async {
            if (update(null) != null) writes++;
          },
        ),
      );
      addTearDown(store.close);
      final read = store.getAccountBalance(id(1));
      final failure = expectLater(read, throwsStateError);
      await settle();
      final removing = store.remove([id(1)]);
      gate.complete();
      await removing;
      await failure;
      expect(writes, 0);
      expect(await store.read(id(1)), isNull);
    },
  );

  test(
    'prechecks verify the latest head and share a same-block proof',
    () async {
      var head = 1, calls = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          calls++;
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      await store.getAccountBalance(id(1), forceRefresh: true);
      await store.getAccountBalance(id(1), forceRefresh: true);
      expect(calls, 1);
      head = 2;
      expect(
        (await store.getAccountBalance(id(1), forceRefresh: true)).block.number,
        BigInt.two,
      );
      expect(calls, 2);
    },
  );

  test(
    'a failed refresh keeps the previous amount and records the error',
    () async {
      var head = 1;
      var fail = false;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          if (fail) throw StateError('read failed');
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      fail = true;
      head = 2;
      store.finalized(block(head));
      await settle();
      expect(store.accountState(id(1)).value!.freeFen, BigInt.from(100));
      expect(store.accountState(id(1)).hasError, isTrue);
    },
  );
  test('closing drains inflight work without accepting a late write', () async {
    final gate = Completer<void>();
    var writes = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async => block(1),
      getAccountBalances: (ids) async {
        await gate.future;
        return [for (final a in ids) value(a, 1)];
      },
      storage: (
        read: (_) async => null,
        write: (_, update) async {
          if (update(null) != null) writes++;
        },
      ),
    );
    final read = store.getAccountBalance(id(1));
    final failure = expectLater(read, throwsStateError);
    await settle();
    final closing = store.close();
    gate.complete();
    await closing;
    await failure;
    expect(writes, 0);
    await expectLater(store.getAccountBalance(id(1)), throwsStateError);
  });

  test('a cancelled watch does not initiate a head or balance read', () async {
    var heads = 0, reads = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async {
        heads++;
        return block(1);
      },
      getAccountBalances: (ids) async {
        reads++;
        return [for (final a in ids) value(a, 1)];
      },
    );
    addTearDown(store.close);
    store.watch([id(1)])();
    await settle();
    expect(heads, 0);
    expect(reads, 0);
  });

  test(
    'a recovered head check clears failure while reusing the same-block proof',
    () async {
      var fail = false, reads = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async {
          if (fail) throw StateError('head unavailable');
          return block(1);
        },
        getAccountBalances: (ids) async {
          reads++;
          return [for (final a in ids) value(a, 1)];
        },
      );
      addTearDown(store.close);
      await store.getAccountBalance(id(1), forceRefresh: true);
      fail = true;
      await expectLater(
        store.getAccountBalance(id(1), forceRefresh: true),
        throwsStateError,
      );
      expect(store.accountState(id(1)).hasError, isTrue);
      fail = false;
      await store.getAccountBalance(id(1), forceRefresh: true);
      expect(store.accountState(id(1)).hasError, isFalse);
      expect(reads, 1);
    },
  );

  test('an old watch release cannot cancel a new account generation', () async {
    var head = 1, reads = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async => block(head),
      getAccountBalances: (ids) async {
        reads++;
        return [for (final a in ids) value(a, head)];
      },
    );
    addTearDown(store.close);
    final old = store.watch([id(1)]);
    await settle();
    await store.remove([id(1)]);
    head = 2;
    store.finalized(block(head));
    final fresh = store.watch([id(1)]);
    addTearDown(fresh);
    await settle();
    old();
    head = 3;
    store.finalized(block(head));
    await settle();
    expect(reads, 3);
    expect(store.accountState(id(1)).value!.block.number, BigInt.from(3));
  });

  test(
    'a disk snapshot ahead of the verified head cannot authorize a precheck',
    () async {
      var reads = 0;
      final raw = jsonEncode({
        'chain': {
          'block_hash': id(105),
          'block_number': '105',
          'free_fen': '100',
          'reserved_fen': '0',
        },
      });
      final store = CitizenBalances(
        getFinalizedHead: () async => block(104),
        getAccountBalances: (ids) async {
          reads++;
          return [for (final a in ids) value(a, 104)];
        },
        storage: (
          read: (_) async => raw,
          write: (_, update) async {
            update(raw);
          },
        ),
      );
      addTearDown(store.close);
      await expectLater(
        store.getAccountBalance(id(1), forceRefresh: true),
        throwsStateError,
      );
      expect(reads, 1);
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(105));
      expect(store.accountState(id(1)).hasError, isTrue);
    },
  );

  test('a newer proof returned by Core advances the scheduler head', () async {
    var reads = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async => block(103),
      getAccountBalances: (ids) async {
        reads++;
        return [for (final a in ids) value(a, 105)];
      },
    );
    addTearDown(store.close);
    expect(
      (await store.getAccountBalance(id(1))).block.number,
      BigInt.from(105),
    );
    await store.getAccountBalance(id(1));
    expect(reads, 1);
  });
}
