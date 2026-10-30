// 主包测试位于lib/test，测试依赖沿用pubspec的dev_dependencies，不进入运行依赖。
// ignore_for_file: depend_on_referenced_packages

import 'dart:io';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/platform/citizen_sdk_flutter_codec.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('六模块公开接口与方法集合保持一致', () {
    expect(
      <int>{
        CitizenSdkModules.wallet,
        CitizenSdkModules.signing,
        CitizenSdkModules.chain,
        CitizenSdkModules.transactions,
        CitizenSdkModules.history,
        CitizenSdkModules.qr,
      },
      <int>{1, 2, 4, 8, 16, 32},
    );
    expect(CitizenSdkModules.full, 63);
    expect(CitizenCapabilityName.values, hasLength(10));
    expect(CitizenSdkErrorCode.values, hasLength(22));
    // Dart接口包含94项公开方法；资源通道集合由各平台单独约束。
    expect(CitizenSdkFlutterCodec.methods, hasLength(94));

    final facade = File('lib/api/citizen_sdk.dart').readAsStringSync();
    for (final declaration in <String>[
      'final CitizenChain chain;',
      'final CitizenSdkWallet wallet;',
      'final CitizenSigning signing;',
      'final CitizenQr qr;',
      'final CitizenTransactions transactions;',
      'final CitizenHistory history;',
    ]) {
      expect(facade, contains(declaration), reason: declaration);
    }
    expect(facade, isNot(contains('test/')));
  });

  test('public byte and collection models retain defensive ownership', () {
    final source = Uint8List.fromList(List<int>.filled(32, 1));
    final callHash = Uint8List.fromList(List<int>.filled(32, 2));
    final prepared = CitizenPreparedTransaction(
      preparationId: 'preparation',
      sourceAccountId: source,
      callDataHash: callHash,
      bestBlock: CitizenBlockRef(
        hash: '0x${'03' * 32}',
        number: BigInt.one,
        finality: CitizenBlockFinality.best,
      ),
      runtimeSpecNumber: 1,
      transactionFormatNumber: 1,
      nonce: BigInt.zero,
    );
    final payload = Uint8List.fromList(<int>[4, 5, 6]);
    final intent = CitizenSigningIntent(
      accountId: '0x${'01' * 32}',
      payload: payload,
      transform: CitizenSigningTransform.raw(),
    );
    final records = <CitizenTransactionHistoryRecord>[];
    final page = CitizenTransactionHistoryPage(
      revision: BigInt.zero,
      records: records,
      nextBeforeExecutionId: null,
    );

    source[0] = 9;
    callHash[0] = 9;
    payload[0] = 9;
    records.add(_historyRecord());
    expect(prepared.sourceAccountId[0], 1);
    expect(prepared.callDataHash[0], 2);
    expect(intent.payload, <int>[4, 5, 6]);
    expect(page.records, isEmpty);
    expect(() => prepared.sourceAccountId[0] = 7, throwsUnsupportedError);
    expect(() => intent.payload[0] = 7, throwsUnsupportedError);
  });

  test('input ceilings and the sole QR transport remain frozen', () {
    expect(CitizenSdkFlutterCodec.maximumSigningPayloadBytes, 16 * 1024 * 1024);
    expect(CitizenSdkFlutterCodec.maximumStorageKeyBytes, 4 * 1024);
    expect(CitizenSdkFlutterCodec.maximumStorageBatchKeys, 1024);
    expect(CitizenSdkFlutterCodec.maximumStorageBatchKeyBytes, 1024 * 1024);
    expect(CitizenSdkFlutterCodec.maximumTransactionCallDataBytes, 1024 * 1024);
    expect(CitizenSdkFlutterCodec.maximumExportedStateBytes, 256 * 1024);
    expect(CitizenSdkFlutterCodec.maximumQrTextBytes, 2331);
    expect(
      CitizenExternalSignerTransport.values,
      <CitizenExternalSignerTransport>[CitizenExternalSignerTransport.qrV1],
    );

    // 主包测试归lib/test；运行实现的扫描不包含测试和消费者夹具自身。
    final production = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where(
          (file) =>
              file.path.endsWith('.dart') &&
              !file.uri.pathSegments.contains('test'),
        )
        .map((file) => file.readAsStringSync())
        .join('\n');
    expect(production, isNot(contains(['QR', '_V', '2'].join())));
  });

  test('consumer-specific fixtures remain outside production SDK sources', () {
    final consumers = <String>[
      'lib/test/consumers/reference_consumer.dart',
      'lib/test/consumers/citizenapp_fixture.dart',
      'lib/test/consumers/third_party_fixture.dart',
    ].map((path) => File(path).readAsStringSync()).toList(growable: false);
    expect(consumers.toSet(), hasLength(3));

    final production =
        <File>[...Directory('lib').listSync(recursive: true).whereType<File>()]
            .where(
              (file) =>
                  file.path.endsWith('.dart') &&
                  !file.uri.pathSegments.contains('test'),
            );
    for (final file in production) {
      final source = file.readAsStringSync();
      expect(source, isNot(contains('citizenapp_fixture')), reason: file.path);
      expect(source, isNot(contains('third_party_fixture')), reason: file.path);
      expect(source, isNot(contains('reference_consumer')), reason: file.path);
    }
  });
}

CitizenTransactionHistoryRecord _historyRecord() =>
    CitizenTransactionHistoryRecord(
      executionId: '01' * 16,
      sourceAccountId: '01' * 32,
      callDataHash: '02' * 32,
      transactionHash: '03' * 32,
      status: CitizenTransactionHistoryStatus.pending,
      block: null,
      execution: null,
      replacementHash: null,
      createdAtMillis: BigInt.one,
      updatedAtMillis: BigInt.one,
      poolRejectionReason: null,
    );
