import 'dart:async';
import 'dart:typed_data';
import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/src/account_codec.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_flutter_codec.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_platform.dart';
import 'package:flutter_test/flutter_test.dart';

/// 使用真实Dart门面与严格通道夹具；合成数据不冒充Core密码学、设备认证或真实钱包。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _WalletPlatform platform;
  CitizenSdk? opened;
  Future<CitizenSdk> open({int modules = CitizenSdkModules.full}) async {
    final sdk = await CitizenSdk.open(modules: modules);
    opened = sdk;
    return sdk;
  }
  setUp(() { opened = null; platform = _WalletPlatform(); CitizenSdkPlatform.instance = platform; });
  tearDown(() async {
    await opened?.close();
    CitizenSdkPlatform.instance = null;
    await platform.dispose();
  });

  test('钱包检查资源只接真实引用、准确索引，释放幂等且SDK关闭回收', () async {
    final id = _account(1);
    final state = <Object?>['1', null, <Object?>[], 1, false, 0,
      <Object?>[<Object?>[0, '异常', id, null, 3, 'hot', <Object?>[<Object?>[id], true]]]];
    platform.handlers['inspectWallets'] = (_) => ['inspection-1', state];
    platform.handlers['releaseWalletInspection'] = (_) => [];
    platform.handlers['repairHotWallet'] = (_) => [_state()];
    platform.handlers['renameDiagnosticWallet'] = (_) => [state];
    platform.handlers['deleteDiagnosticWallet'] = (_) => [<Object?>['2', null, <Object?>[], 0, false, null, <Object?>[]]];
    final sdk = await open();
    final inspection = await sdk.wallet.inspect().result;
    expect(inspection.state.diagnostics.single.walletName, '异常');
    expect(() => inspection.delete(99), throwsA(isA<CitizenSdkException>()));
    await inspection.rename(walletIndex: 0, name: '新名字').result;
    expect(platform.arguments['renameDiagnosticWallet']!.sublist(3), ['inspection-1', 0, '新名字']);
    await inspection.repairHot(0).result;
    await inspection.delete(0).result;
    await inspection.release(); await inspection.release();
    expect(platform.calls.where((m) => m == 'releaseWalletInspection'), hasLength(1));
    expect(() => inspection.repairHot(0), throwsA(isA<CitizenSdkException>()));
    await sdk.wallet.inspect().result;
    await sdk.close();
    expect(platform.calls.where((m) => m == 'releaseWalletInspection'), hasLength(2));
  });

  test('检查资源释放失败保留所有权可重试，不使SDK关闭跳过结果', () async {
    final state = <Object?>['1', null, <Object?>[], 1, false, 0,
      <Object?>[<Object?>[0, '异常', _account(1), null, 3, null, null]]];
    platform.handlers['inspectWallets'] = (_) => ['inspection-1', state];
    var attempts = 0;
    platform.handlers['releaseWalletInspection'] = (_) {
      if (++attempts == 1) throw const CitizenSdkException(code: CitizenSdkErrorCode.busy, message: '合成忙碌');
      return [];
    };
    final inspection = await (await open()).wallet.inspect().result;
    await expectLater(inspection.release(), throwsA(isA<CitizenSdkException>()));
    await inspection.release();
    expect(attempts, 2);
  });

  test('准备、备份副本、真实提交、释放分离且SDK无窗口', () async {
    platform.handlers['prepareWalletCreation'] = (_) => ['prepared-1'];
    final raw = Uint8List.fromList([115, 121, 110, 116, 104, 101, 116, 105, 99]);
    platform.handlers['copyRecoveryPhrase'] = (_) => [raw];
    platform.handlers['commitWalletCreation'] = (_) => [_profile('created', 1)];
    platform.handlers['releasePreparedWallet'] = (_) => [];
    final sdk = await open();
    final prepared = await sdk.wallet.prepareCreation(wordCount: CitizenWalletWordCount.words18).result;
    final recovery = await prepared.recoveryPhrase();
    final visible = recovery.bytes;
    expect(visible, [115, 121, 110, 116, 104, 101, 116, 105, 99]);
    expect(raw, everyElement(0));
    expect(() => visible[0] = 1, throwsUnsupportedError);
    expect(recovery.toString(), isNot(contains('synthetic')));
    expect((await prepared.commit().result).walletName, '钱包0');
    expect(platform.arguments['prepareWalletCreation']!.sublist(3), [18, '']);
    expect(() => prepared.commit(), throwsA(isA<CitizenSdkException>()));
    await recovery.release();
    expect(visible, everyElement(0));
    expect(() => recovery.bytes, throwsA(isA<CitizenSdkException>()));
    await prepared.release();
    await prepared.release();
    expect(platform.calls.where((method) => method == 'releasePreparedWallet'), hasLength(1));
  });

  test('未提交关闭只归还准备资源，不删除钱包或伪造创建', () async {
    platform.handlers['prepareWalletCreation'] = (_) => ['prepared-1'];
    platform.handlers['releasePreparedWallet'] = (_) => [];
    final sdk = await open();
    final prepared = await sdk.wallet.prepareCreation(wordCount: CitizenWalletWordCount.words12).result;
    await sdk.close();
    expect(platform.calls, contains('releasePreparedWallet'));
    expect(platform.calls, isNot(contains('commitWalletCreation')));
    expect(platform.calls, isNot(contains('deleteWallet')));
    expect(() => prepared.commit(), throwsA(isA<CitizenSdkException>()));
  });

  test('导入和指定追加保留原输入，下一个编号不由Dart推算', () async {
    platform.handlers['importWallet'] = (_) => [_profile('imported', 1)];
    platform.handlers['addWalletAccounts'] = (_) => [_profile('imported', 3)];
    platform.handlers['addNextWalletAccount'] = (_) => [_profile('imported', 4)];
    final sdk = await open();
    expect((await sdk.wallet.importWallet(mnemonic: 'synthetic input', password: 'example').result).origin, CitizenWalletOrigin.imported);
    expect((await sdk.wallet.addAccounts(mnemonic: 'synthetic input', password: 'example', indices: [1, 2]).result).accounts, hasLength(3));
    expect((await sdk.wallet.addNextAccount(mnemonic: 'synthetic input').result).accounts, hasLength(4));
    expect(platform.arguments['importWallet']!.sublist(3), ['synthetic input', 'example']);
    expect(platform.arguments['addWalletAccounts']!.sublist(3), ['synthetic input', 'example', [1, 2]]);
    expect(platform.arguments['addNextWalletAccount']!.sublist(3), ['synthetic input', '']);
  });

  test('12/18/24词准确值，旧UI方法及额外文案槽均拒绝', () {
    const codec = CitizenSdkFlutterCodec();
    expect(CitizenWalletWordCount.values.map((value) => value.value), [12, 18, 24]);
    for (final count in [0, 11, 15, 21, 25]) {
      expect(() => codec.encodeRequest(method: 'prepareWalletCreation', sessionId: 's',
        requestSequence: 1, fields: [count, '']), throwsA(isA<CitizenSdkException>()));
    }
    for (final method in ['createWallet', 'initializeWallet', 'importColdAccountWithUi', 'viewAccountPrivateKey', 'qrScan']) {
      expect(CitizenSdkFlutterCodec.methods, isNot(contains(method)));
      expect(() => codec.encodeRequest(method: method, sessionId: 's', requestSequence: 1),
        throwsA(isA<CitizenSdkException>()));
    }
    expect(() => codec.encodeRequest(method: 'prepareWalletCreation', sessionId: 's',
      requestSequence: 1, fields: [18, '', '界面文案']), throwsA(isA<CitizenSdkException>()));
  });

  test('输入原因和候选来自SDK，过长输入不进入平台', () async {
    platform.handlers['validateWalletPassword'] = (_) => [7, null];
    platform.handlers['validateWalletMnemonic'] = (_) => [3, 2];
    platform.handlers['walletWordSuggestions'] = (_) => [['word']];
    final sdk = await open();
    expect((await sdk.wallet.validatePassword('abc')).reason, CitizenWalletInputReason.passwordLength);
    final mnemonic = await sdk.wallet.validateMnemonic('synthetic', CitizenWalletWordCount.words18);
    expect(mnemonic.reason, CitizenWalletInputReason.unknownWord);
    expect(mnemonic.position, 2);
    expect(await sdk.wallet.wordSuggestions('wor'), ['word']);
    final count = platform.calls.length;
    expect((await sdk.wallet.validatePassword('a' * 1025)).reason, CitizenWalletInputReason.inputTooLong);
    expect(platform.calls.length, count);
  });

  test('取消接纳不完成操作，真实终态后不再发送取消', () async {
    final pending = Completer<List<Object?>>();
    platform.handlers['importWallet'] = (_) => pending.future;
    platform.handlers['cancelOperation'] = (_) => [true];
    final sdk = await open();
    final operation = sdk.wallet.importWallet(mnemonic: 'synthetic');
    var settled = false;
    final done = operation.result.then((_) => settled = true);
    expect(await operation.cancel(), isTrue);
    expect(platform.arguments['cancelOperation']!.last, operation.operationId);
    expect(settled, isFalse);
    pending.complete([_profile('imported', 1)]);
    await done;
    expect(await operation.cancel(), isFalse);
    expect(platform.calls.where((method) => method == 'cancelOperation'), hasLength(1));
  });

  test('私钥交付不等于关闭，关闭清零副本并等待真实回包', () async {
    final closeGate = Completer<List<Object?>>();
    final raw = Uint8List.fromList(List.filled(32, 7));
    platform.handlers['openPrivateKey'] = (_) => ['private-1'];
    platform.handlers['revealPrivateKey'] = (_) => [raw];
    platform.handlers['closePrivateKey'] = (_) => closeGate.future;
    final sdk = await open();
    final resource = await sdk.wallet.openPrivateKey(_account(1));
    final visible = await resource.reveal();
    expect(visible, everyElement(7));
    expect(raw, everyElement(0));
    expect(() => visible[0] = 2, throwsUnsupportedError);
    await expectLater(resource.reveal(), throwsA(isA<CitizenSdkException>()));
    var closed = false;
    final terminal = resource.closed.then((_) => closed = true);
    final closing = resource.close();
    expect(visible, everyElement(0));
    expect(closed, isFalse);
    closeGate.complete([]);
    await closing;
    await terminal;
    expect(closed, isTrue);
    await resource.close();
    expect(platform.calls.where((method) => method == 'closePrivateKey'), hasLength(1));
  });

  test('关闭后迟到私钥不展示，排空后平台字节也被擦除', () async {
    final reveal = Completer<List<Object?>>();
    platform.handlers['openPrivateKey'] = (_) => ['private-2'];
    platform.handlers['revealPrivateKey'] = (_) => reveal.future;
    platform.handlers['closePrivateKey'] = (_) => [];
    final sdk = await open();
    final resource = await sdk.wallet.openPrivateKey(_account(1));
    final rejected = expectLater(resource.reveal(), throwsA(isA<CitizenSdkException>().having(
      (error) => error.code, 'code', CitizenSdkErrorCode.cancelled)));
    final closing = resource.close();
    final bytes = Uint8List.fromList(List.filled(32, 8));
    reveal.complete([bytes]);
    await rejected;
    await closing;
    await resource.closed;
    expect(bytes, everyElement(0));
  });

  test('查看失败不妨碍真实排空，关闭失败可重试', () async {
    platform.handlers['openPrivateKey'] = (_) => ['private-3'];
    platform.handlers['revealPrivateKey'] = (_) => throw const CitizenSdkException(
      code: CitizenSdkErrorCode.cancelled, message: '合成认证取消');
    var closes = 0;
    platform.handlers['closePrivateKey'] = (_) {
      if (++closes == 1) throw const CitizenSdkException(code: CitizenSdkErrorCode.busy, message: '合成未排空');
      return [];
    };
    final sdk = await open();
    final resource = await sdk.wallet.openPrivateKey(_account(1));
    await expectLater(resource.reveal(), throwsA(isA<CitizenSdkException>().having(
      (error) => error.code, 'code', CitizenSdkErrorCode.cancelled)));
    await expectLater(resource.close(), throwsA(isA<CitizenSdkException>().having(
      (error) => error.code, 'code', CitizenSdkErrorCode.busy)));
    await resource.close();
    await resource.closed;
    expect(closes, 2);
  });

  test('纯验签不open不订阅事件，true和false准确返回', () async {
    for (final valid in [false, true]) {
      platform.verifyResult = valid;
      expect(await CitizenSigning.verify(accountId: _account(1), signature: Uint8List(64), payload: Uint8List(0)), valid);
    }
    expect(platform.eventReads, 0);
    expect(platform.calls, ['verifySignature', 'verifySignature']);
    await expectLater(CitizenSigning.verify(accountId: _account(1), signature: Uint8List(63), payload: Uint8List(0)),
      throwsA(isA<CitizenSdkException>()));
    expect(platform.calls, hasLength(2));
  });

  test('普通签名只交公开消息副本，结束擦除副本不改调用方', () async {
    Uint8List? borrowed;
    platform.handlers['signWalletPayload'] = (fields) { borrowed = fields[1]! as Uint8List; return [Uint8List(64)]; };
    final sdk = await open(modules: CitizenSdkModules.signing);
    final source = Uint8List.fromList([1, 2, 3]);
    expect((await sdk.signing.sign(accountId: _account(1), payload: source).result).bytes, hasLength(64));
    expect(source, [1, 2, 3]);
    expect(borrowed, everyElement(0));
    expect(platform.calls, isNot(contains('openPrivateKey')));
    expect(platform.arguments['open'], [2, CitizenSdkModules.signing, false]);
  });

  test('冷热目录、独立钱包名、付款选择和账户名精确接线', () async {
    platform.handlers['getWalletState'] = (_) => [_state()];
    platform.handlers['importColdAccountId'] = (_) => [_state(includeCold: true)];
    platform.handlers['setActiveWallet'] = (_) => [_state(includeCold: true, selected: 1)];
    platform.handlers['renameWallet'] = (_) => [_state(includeCold: true, walletName: '独立名称')];
    platform.handlers['renameAccount'] = (_) => [_state(includeCold: true, coldName: '冷账户名')];
    platform.handlers['deleteAccount'] = (_) => [_state()];
    platform.handlers['reorderWalletAccountsWithoutDefaultChange'] = (_) => [_state(includeCold: true)];
    final sdk = await open();
    expect((await sdk.wallet.getState().result).defaultAccount!.accountId, _account(1));
    await sdk.wallet.importColdAccount(accountId: _account(2), name: ' 冷钱包 ').result;
    expect(platform.arguments['importColdAccountId']!.sublist(3), [_account(2), '冷钱包']);
    final selected = await sdk.wallet.setActiveWallet(expectedRevision: BigInt.one, walletIndex: 1).result;
    expect(selected.activeWalletAccount!.accountId, _account(2));
    expect(selected.defaultAccount!.accountId, _account(1));
    final renamed = await sdk.wallet.renameWallet(expectedRevision: BigInt.one, walletIndex: 0, name: ' 独立名称 ').result;
    expect(renamed.hotProfile!.walletName, '独立名称');
    expect(renamed.accounts.first.name, '账户0');
    expect((await sdk.wallet.renameAccount(accountId: _account(2), name: ' 冷账户名 ').result).accounts.last.name, '冷账户名');
    expect(platform.arguments['renameWallet']!.sublist(3), ['1', 0, '独立名称']);
    await sdk.wallet.reorderAccountsWithoutDefaultChange(expectedRevision: BigInt.one, accountIds: [_account(1), _account(2)]).result;
    expect((await sdk.wallet.deleteAccount(_account(2)).result).accounts, hasLength(1));
  });

  test('输入越界在接纳与序号分配前拒绝，读失败不当空钱包', () async {
    final sdk = await open();
    expect(() => sdk.wallet.addAccounts(mnemonic: 'synthetic', indices: List.filled(1991, 1)), throwsA(isA<CitizenSdkException>()));
    expect(() => sdk.wallet.renameWallet(expectedRevision: BigInt.one, walletIndex: 0, name: '名' * 31), throwsA(isA<CitizenSdkException>()));
    expect(() => sdk.wallet.setActiveWallet(expectedRevision: BigInt.from(-1), walletIndex: 0), throwsA(isA<CitizenSdkException>()));
    expect(() => sdk.wallet.importColdAccount(accountId: _account(2), ss58Address: 'also-set'), throwsA(isA<CitizenSdkException>()));
    expect(platform.calls, ['open']);
    platform.handlers['getWalletState'] = (_) => throw const CitizenSdkException(code: CitizenSdkErrorCode.storage, message: '合成读取失败');
    await expectLater(sdk.wallet.getState().result, throwsA(isA<CitizenSdkException>()));
    expect(platform.arguments['getWalletState']![2], 1);
  });

  test('普通清除与签名并删除分开，空终态不接受旧null profile', () async {
    platform.handlers['deleteWallet'] = (_) => [];
    platform.handlers['signAndDeleteWallet'] = (_) => [];
    final sdk = await open();
    await sdk.wallet.delete().result;
    await sdk.wallet.signAndDelete().result;
    expect(platform.arguments['deleteWallet']!.sublist(3), isEmpty);
    platform.handlers['deleteWallet'] = (_) => [null];
    await expectLater(sdk.wallet.delete().result, throwsA(isA<CitizenSdkException>()));
  });
}

final class _WalletPlatform implements CitizenSdkPlatform {
  final handlers = <String, FutureOr<List<Object?>> Function(List<Object?>)>{};
  final calls = <String>[];
  final arguments = <String, List<Object?>>{};
  final _events = StreamController<Object?>.broadcast();
  int eventReads = 0;
  int nextSequence = 1;
  bool verifyResult = false;
  @override Stream<Object?> get events { eventReads++; return _events.stream; }
  @override Future<Object?> invoke(String method, List<Object?> values) async {
    calls.add(method); arguments[method] = values;
    expect(values.first, 2);
    if (method == 'verifySignature') return [2, verifyResult];
    if (method == 'open') return [2, 'session-a', 0, ['created', 1]];
    expect(values[1], 'session-a'); expect(values[2], nextSequence++);
    final sequence = values[2]! as int;
    if (method == 'close') return [2, 'session-a', sequence, ['disposed']];
    final handler = handlers[method];
    if (handler == null) throw StateError('未配置方法：$method');
    try {
      return [2, 'session-a', sequence, await handler(values.sublist(3))];
    } on CitizenSdkException catch (error) {
      // 测试错误同样模拟平台精确关联，不绕过生产错误校验。
      throw CitizenSdkException(code: error.code, stage: error.stage, message: error.message,
        method: method, sessionId: 'session-a', requestSequence: sequence);
    }
  }
  Future<void> dispose() => _events.close();
}

List<Object?> _profile(String origin, int count, {String walletName = '钱包0'}) => [
  0, origin, '1', _account(1), _account(1),
  [for (var index = 0; index < count; index++)
    [index, _account(index + 1), citizenSs58FromAccountId(_account(index + 1)), '账户$index', (index + 1).toString(), index == 0]],
  walletName,
];
List<Object?> _state({bool includeCold = false, int selected = 0, String walletName = '钱包0', String coldName = '冷钱包'}) => [
  '1', _profile('created', 1, walletName: walletName),
  [
    ['hot', 0, 0, _account(1), citizenSs58FromAccountId(_account(1)), '账户0', '1', true],
    if (includeCold) ['cold', 1, null, _account(2), citizenSs58FromAccountId(_account(2)), coldName, '2', false],
  ],
  1, false, selected, <Object?>[],
];
String _account(int byte) => '0x' + List.filled(32, byte.toRadixString(16).padLeft(2, '0')).join();
