import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/platform/citizen_sdk_platform.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _FacadePlatform platform;

  setUp(() {
    platform = _FacadePlatform();
    CitizenSdkPlatform.instance = platform;
  });

  tearDown(() async {
    CitizenSdkPlatform.instance = null;
    await platform.dispose();
  });

  test('根入口只装配最终公开 CitizenSdk、链、钱包、交易和公开模型', () async {
    final sdk = await CitizenSdk.open();

    expect(sdk.chain, isA<CitizenChain>());
    expect(sdk.wallet, isA<CitizenSdkWallet>());
    expect(sdk.signing, isA<CitizenSigning>());
    expect(sdk.transactions, isA<CitizenTransactions>());
    expect(sdk.history, isA<CitizenHistory>());
    expect(sdk.lifecycle, CitizenSdkLifecycle.created);

    await sdk.close();
    expect(sdk.lifecycle, CitizenSdkLifecycle.disposed);
    expect(platform.calls, <List<Object?>>[
      <Object?>[
        'open',
        <Object?>[2, CitizenSdkModules.full, false],
      ],
      <Object?>[
        'close',
        <Object?>[2, 'session-1', 1],
      ],
    ]);
  });

  test('存储分页发送与回包关联使用接纳时的前缀和游标快照', () async {
    final sdk = await CitizenSdk.open();
    final block = CitizenBlockRef(
      hash: '0x${'11' * 32}',
      number: BigInt.from(7),
      finality: CitizenBlockFinality.finalized,
    );
    final prefix = Uint8List.fromList([1]);
    final start = Uint8List.fromList([1, 0]);
    final barrier = Completer<void>();
    platform.chainBarrier = barrier.future;
    final result = sdk.chain.getStorageKeysPaged(
      block,
      prefix,
      startKey: start,
      limit: 2,
    );
    prefix[0] = 9;
    start.fillRange(0, start.length, 9);
    barrier.complete();
    final keys = await result;
    expect(keys, [
      [1, 1],
      [1, 2],
    ]);
    final fields =
        platform.calls.singleWhere(
              (call) => call[0] == 'getStorageKeysPaged',
            )[1]
            as List;
    expect(fields[4], [1]);
    expect(fields[5], [1, 0]);
    expect(() => keys.first[0] = 0, throwsUnsupportedError);
    await sdk.close();
  });

  test('调用方改为伪造回包的前缀不能放宽原请求，Runtime参数不受外部修改影响', () async {
    final sdk = await CitizenSdk.open();
    final block = CitizenBlockRef(
      hash: '0x${'11' * 32}',
      number: BigInt.from(7),
      finality: CitizenBlockFinality.finalized,
    );
    final prefix = Uint8List.fromList([1]);
    final barrier = Completer<void>();
    platform.chainBarrier = barrier.future;
    platform.storageKeys = [
      Uint8List.fromList([2, 1]),
    ];
    final keys = sdk.chain.getStorageKeysPaged(block, prefix);
    prefix[0] = 2;
    barrier.complete();
    await expectLater(
      keys,
      throwsA(
        isA<CitizenSdkException>().having(
          (error) => error.code,
          'code',
          CitizenSdkErrorCode.integrity,
        ),
      ),
    );
    final args = Uint8List.fromList([3, 4]);
    final runtime = sdk.chain.callRuntimeApi(block, 'CitizenApi_items', args);
    args.fillRange(0, args.length, 9);
    expect(await runtime, [7, 8]);
    final fields =
        platform.calls.singleWhere((call) => call[0] == 'callRuntimeApi')[1]
            as List;
    expect(fields[5], [3, 4]);
    await sdk.close();
  });

  test('QR 门面只转发固定 tuple 并重建公开类型', () async {
    final sdk = await CitizenSdk.open(modules: CitizenSdkModules.qr);

    final document = await sdk.qr.parse('QR_V1');
    final image = await sdk.qr.encode('QR_V1', scale: 3);

    expect(document.kind, CitizenQrKind.accountId);
    expect(document.canonicalText, 'QR_V1');
    expect(image.width, 2);
    expect(image.height, 2);
    expect(image.luminance, Uint8List.fromList(<int>[0, 255, 255, 0]));

    await sdk.close();
    expect(platform.calls, <List<Object?>>[
      <Object?>[
        'open',
        <Object?>[2, CitizenSdkModules.qr, false],
      ],
      <Object?>[
        'qrParse',
        <Object?>[2, 'session-1', 1, 'QR_V1'],
      ],
      <Object?>[
        'qrEncode',
        <Object?>[2, 'session-1', 2, 'QR_V1', 3],
      ],
      <Object?>[
        'close',
        <Object?>[2, 'session-1', 3],
      ],
    ]);
  });
  test('审阅与签名同一资源，响应图像由SDK返回并显式释放', () async {
    final sdk = await CitizenSdk.open();
    final scanned = await sdk.qr.parse('QR_V1');
    expect(scanned.accountId, _qrAccount);
    final review = await sdk.signing.reviewQrRequest('request').result;
    final result = await sdk.signing.signQrRequest(review).result;
    expect(result.requestId, 'request-identifier');
    expect(result.signRequest, 'request');
    expect(result.canonicalText, 'response');
    expect(result.signerAccountId, _qrAccount);
    expect(result.signature, hasLength(64));
    expect(result.qrImage.luminance, hasLength(4));
    expect(() => result.signature[0] = 1, throwsUnsupportedError);
    final signature = await sdk.qr.consumeSignResponse(result.canonicalText);
    expect(signature, hasLength(64));
    expect(() => signature[0] = 1, throwsUnsupportedError);
    expect(
      platform.calls.where((call) => call[0] == 'signQrRequest').single[1],
      <Object?>[2, 'session-1', 3, 'review-owned'],
    );
    expect(platform.calls.where((call) => call[0] == 'qrEncode'), isEmpty);
    await review.release();
    expect(
      platform.calls.where((call) => call[0] == 'releaseQrReview').single[1],
      <Object?>[2, 'session-1', 5, 'review-owned'],
    );
    await sdk.close();
  });

  test('链分页与Runtime API只投影固定通用合同', () async {
    final sdk = await CitizenSdk.open();
    final block = CitizenBlockRef(
      hash: '0x${'11' * 32}',
      number: BigInt.from(7),
      finality: CitizenBlockFinality.finalized,
    );
    final keys = await sdk.chain.getStorageKeysPaged(
      block,
      Uint8List.fromList(<int>[1]),
      limit: 2,
    );
    final runtime = await sdk.chain.callRuntimeApi(
      block,
      'CitizenApi_items',
      Uint8List(0),
    );
    expect(keys, hasLength(2));
    expect(runtime, <int>[7, 8]);
    await sdk.close();
  });
}

final String _qrAccount = '0x${'00' * 32}';

final class _FacadePlatform implements CitizenSdkPlatform {
  final StreamController<Object?> _events =
      StreamController<Object?>.broadcast();
  final List<List<Object?>> calls = <List<Object?>>[];
  Future<void>? chainBarrier;
  List<Uint8List>? storageKeys;

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    calls.add(<Object?>[method, arguments]);
    if (method == 'getStorageKeysPaged' || method == 'callRuntimeApi') {
      await chainBarrier;
    }
    return switch (method) {
      'open' => <Object?>[
        2,
        'session-1',
        0,
        <Object?>['created', 1],
      ],
      'close' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>['disposed'],
      ],
      'qrParse' || 'qrDecodeLuminance' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          jsonEncode(<String, Object?>{
            'kind': 5,
            'scan_purpose_mask': 195,
            'canonical_text': 'QR_V1',
            'account_id': _qrAccount,
          }),
        ],
      ],
      'reviewQrRequest' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          'review-owned',
          jsonEncode(<String, Object?>{
            'kind': 1,
            'scan_purpose_mask': 16,
            'canonical_text': 'request',
            'request_id': 'request-identifier',
            'expires_at': 1700000000,
            'action': 1,
            'signer_account_id': _qrAccount,
            'review_payload': '0x01',
            'pallet_name': 'Synthetic',
            'call_name': 'call',
            'call_arguments': '{}',
            'genesis_hash': _qrAccount,
            'spec_version': 1,
            'transaction_version': 1,
            'era': 'immortal',
            'nonce': '0',
            'tip': '0',
            'block_hash': _qrAccount,
          }),
        ],
      ],
      'releaseQrReview' => <Object?>[2, 'session-1', arguments[2], <Object?>[]],
      'signQrRequest' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          jsonEncode(<String, Object?>{
            'kind': 2,
            'scan_purpose_mask': 8,
            'canonical_text': 'response',
            'sign_request': 'request',
            'request_id': 'request-identifier',
            'expires_at': 1700000000,
            'signer_account_id': _qrAccount,
            'signature': '0x${'00' * 64}',
            'current_account_id': null,
            'current_account_signature': null,
          }),
          2,
          2,
          Uint8List.fromList(<int>[0, 255, 255, 0]),
        ],
      ],
      'qrConsumeSignResponse' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[Uint8List(64)],
      ],
      'qrEncode' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          2,
          2,
          Uint8List.fromList(<int>[0, 255, 255, 0]),
        ],
      ],
      'getStorageKeysPaged' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          storageKeys ??
              <Uint8List>[
                Uint8List.fromList(<int>[1, 1]),
                Uint8List.fromList(<int>[1, 2]),
              ],
        ],
      ],
      'callRuntimeApi' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          Uint8List.fromList(<int>[7, 8]),
        ],
      ],
      _ => throw StateError('未预期 method：$method'),
    };
  }

  Future<void> dispose() => _events.close();
}
