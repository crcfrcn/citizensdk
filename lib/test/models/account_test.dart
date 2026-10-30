// 主包测试位于lib/test，测试依赖沿用pubspec的dev_dependencies，不进入运行依赖。
// ignore_for_file: depend_on_referenced_packages

import 'dart:convert';
import 'dart:io';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:ss58/ss58.dart' show Address;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('公开账户地址投影与原生派生共用同一冻结测试向量', () {
    final golden =
        jsonDecode(
              File(
                'core/tests/citizenchain-wallet-derivation-v1.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    for (final entry in golden['cases'] as List) {
      for (final account in (entry as Map)['accounts'] as List) {
        final map = account as Map;
        if (map['ss58'] != null) {
          expect(
            citizenSs58FromAccountId(map['account_id'] as String),
            map['ss58'],
          );
        }
      }
    }
  });

  test('地址直接编解码保留公民前缀、长度、校验和及规范重编码边界', () {
    final account = citizenAccountIdFromBytes(
      List<int>.generate(32, (index) => index),
    );
    final address = citizenSs58FromAccountId(account);
    expect(
      citizenPublicKeyFromSs58(address),
      orderedEquals(citizenAccountIdBytes(account)),
    );
    final otherPrefix = Address(
      prefix: 42,
      pubkey: citizenAccountIdBytes(account),
    ).encode();
    expect(() => citizenPublicKeyFromSs58(otherPrefix), throwsFormatException);
    final shortKey = Address(
      prefix: citizenSs58Prefix,
      pubkey: Uint8List.fromList([1]),
    ).encode();
    expect(() => citizenPublicKeyFromSs58(shortKey), throwsFormatException);
    final corrupt =
        address.substring(0, address.length - 1) +
        (address.endsWith('1') ? '2' : '1');
    expect(() => citizenPublicKeyFromSs58(corrupt), throwsA(isA<Exception>()));
    expect(
      () => citizenAccountIdFromBytes(List<int>.filled(31, 0)),
      throwsArgumentError,
    );
    expect(
      () => citizenAccountIdBytes(account.toUpperCase()),
      throwsFormatException,
    );
  });

  test('Hosted Package根入口公开稳定API与公开模型', () {
    expect(CitizenSdk.open, isA<Function>());
    expect(CitizenSdkModules.full, 63);
    expect(CitizenSdkModules.qr, 32);
    expect(isA<CitizenPreparedTransaction>(), isNotNull);
    expect(CitizenSdkErrorCode.values, hasLength(22));
    expect(CitizenCapabilityName.values, hasLength(10));
    expect(
      CitizenWalletSignature(accountId: _account(1), bytes: Uint8List(64)),
      isA<CitizenWalletSignature>(),
    );
  });
}

String _account(int byte) =>
    citizenAccountIdFromBytes(List<int>.filled(32, byte));
