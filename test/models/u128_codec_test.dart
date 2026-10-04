import 'package:citizen_sdk/src/platform/citizen_sdk_flutter_codec.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const codec = CitizenSdkFlutterCodec();

  test('u128最大值以十进制tuple精确恢复', () {
    final maximum = (BigInt.one << 128) - BigInt.one;
    final balance = codec.decodeBalance(<Object?>[
      _account(1),
      <Object?>[_account(2), '99', 'finalized'],
      maximum.toString(),
      '0',
      maximum.toString(),
    ]);
    expect(balance.freeFen, maximum);
    expect(balance.totalFen, maximum);
  });

  test('拒绝负数、前导零和平台int替代十进制合同', () {
    for (final invalid in <Object?>[
      '-1',
      '01',
      1,
      1.0,
      (BigInt.one << 128).toString(),
    ]) {
      expect(
        () => codec.decodeBalance(<Object?>[
          _account(1),
          <Object?>[_account(2), '99', 'finalized'],
          invalid,
          '0',
          '1',
        ]),
        throwsException,
      );
    }
  });
}

String _account(int byte) =>
    '0x${List<String>.filled(32, byte.toRadixString(16).padLeft(2, '0')).join()}';
