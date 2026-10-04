import 'dart:typed_data';
import 'package:citizen_sdk/src/platform/citizen_sdk_flutter_codec.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const codec = CitizenSdkFlutterCodec();

  test('仅显式输入携带助记词/密码，准备资源不含UI文案', () {
    expect(codec.encodeRequest(method: 'prepareWalletCreation', sessionId: 's', requestSequence: 1,
      fields: [18, 'synthetic']), [2, 's', 1, 18, 'synthetic']);
    expect(codec.encodeRequest(method: 'importWallet', sessionId: 's', requestSequence: 2,
      fields: ['synthetic words', '']), [2, 's', 2, 'synthetic words', '']);
    expect(codec.encodeRequest(method: 'addWalletAccounts', sessionId: 's', requestSequence: 3,
      fields: ['synthetic words', '', [1, 2]]), [2, 's', 3, 'synthetic words', '', [1, 2]]);
    for (final fields in <List<Object?>>[['a' * 1025, ''], ['synthetic', '', 'extra']]) {
      expect(() => codec.encodeRequest(method: 'importWallet', sessionId: 's', requestSequence: 4,
        fields: fields), throwsException);
    }
    for (final removed in ['createWallet', 'initializeWallet', 'importColdAccountWithUi', 'viewAccountPrivateKey']) {
      expect(() => codec.encodeRequest(method: removed, sessionId: 's', requestSequence: 5), throwsException);
    }
  });

  test('打开仅传账户，显式查看只收准确32字节，不向普通方法放秘密槽', () {
    expect(codec.encodeRequest(method: 'openPrivateKey', sessionId: 's', requestSequence: 1,
      fields: [_account(1)]), [2, 's', 1, _account(1)]);
    for (final fields in <List<Object?>>[[], ['account'], [_account(1), Uint8List(32)]]) {
      expect(() => codec.encodeRequest(method: 'openPrivateKey', sessionId: 's', requestSequence: 1,
        fields: fields), throwsException);
    }
    expect(codec.decodeResponse(method: 'openPrivateKey', raw: [2, 's', 1, ['opaque-id']],
      expectedSessionId: 's', expectedRequestSequence: 1).value, ['opaque-id']);
    for (final length in [0, 31, 33, 1024]) {
      expect(() => codec.decodeResponse(method: 'revealPrivateKey', raw: [2, 's', 2, [Uint8List(length)]],
        expectedSessionId: 's', expectedRequestSequence: 2), throwsException);
    }
    expect(codec.decodeResponse(method: 'revealPrivateKey', raw: [2, 's', 2, [Uint8List(32)]],
      expectedSessionId: 's', expectedRequestSequence: 2).value.single, hasLength(32));
    for (final value in <List<Object?>>[[Uint8List(32)], [null], [1]]) {
      expect(() => codec.decodeResponse(method: 'closePrivateKey', raw: [2, 's', 3, value],
        expectedSessionId: 's', expectedRequestSequence: 3), throwsException);
    }
  });

  test('备份显示副本有界，不接受空或超限载荷以及额外槽', () {
    for (final value in <List<Object?>>[[Uint8List(0)], [Uint8List(1025)], [Uint8List(12), 'extra']]) {
      expect(() => codec.decodeResponse(method: 'copyRecoveryPhrase', raw: [2, 's', 1, value],
        expectedSessionId: 's', expectedRequestSequence: 1), throwsException);
    }
    expect(codec.decodeResponse(method: 'copyRecoveryPhrase', raw: [2, 's', 1, [Uint8List(1024)]],
      expectedSessionId: 's', expectedRequestSequence: 1).value.single, hasLength(1024));
  });

  test('普通sign只传公开账户与消息，响应仅64字节签名', () {
    final payload = Uint8List.fromList([1, 2, 3]);
    final request = codec.encodeRequest(method: 'signWalletPayload', sessionId: 's', requestSequence: 1,
      fields: [_account(1), payload]);
    expect(request, [2, 's', 1, _account(1), payload]);
    expect(codec.decodeResponse(method: 'signWalletPayload', raw: [2, 's', 1, [Uint8List(64)]],
      expectedSessionId: 's', expectedRequestSequence: 1).value, hasLength(1));
    expect(() => codec.decodeResponse(method: 'signWalletPayload', raw: [2, 's', 1, [Uint8List(32)]],
      expectedSessionId: 's', expectedRequestSequence: 1), throwsException);
  });

  test('Map和裸句柄不能借事件形成秘密旁路', () {
    for (final map in <Map<String, Object?>>[
      {'mnemonic': 'synthetic'}, {'password': 'synthetic'}, {'nativeHandle': 1},
      {'resultHandle': 1}, {'signedExtrinsic': Uint8List(1)},
    ]) {
      expect(() => codec.decodeEvent([2, 's', 1, 'lifecycleChanged', [map]]), throwsException);
    }
    expect(() => codec.decodeResponse(method: 'openPrivateKey', raw: [2, 's', 1, [1]],
      expectedSessionId: 's', expectedRequestSequence: 1), throwsException);
  });
}
String _account(int byte) => '0x' + List.filled(32, byte.toRadixString(16).padLeft(2, '0')).join();
