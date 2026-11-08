// 主包测试位于lib/test，测试依赖沿用pubspec的dev_dependencies，不进入运行依赖。
// ignore_for_file: depend_on_referenced_packages

import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('Hosted Package根入口公开稳定API与公开模型', () {
    expect(CitizenSdk.open, isA<Function>());
    expect(CitizenSdkModules.full, 63);
    expect(CitizenSdkModules.qr, 32);
    expect(isA<CitizenPreparedTransaction>(), isNotNull);
    expect(CitizenSdkErrorCode.values, hasLength(22));
    expect(CitizenCapabilityName.values, hasLength(10));
    expect(
      CitizenWalletSignature(accountId: '0x${'01' * 32}', bytes: Uint8List(64)),
      isA<CitizenWalletSignature>(),
    );
  });
}
