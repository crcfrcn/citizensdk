import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/src/platform/citizen_sdk_platform.dart';
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

  test('链分页、Runtime API 与应用派生钥只投影固定通用合同', () async {
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
    final key = await sdk.wallet
        .deriveApplicationKey(
          accountId: '0x${'22' * 32}',
          salt: Uint8List(32),
          info: Uint8List.fromList(<int>[1]),
        )
        .result;
    final batch = await (sdk.wallet as CitizenSdkWalletBatch)
        .deriveApplicationKeys(
          accountId: '0x${'22' * 32}',
          salt: Uint8List(32),
          infos: <Uint8List>[
            Uint8List.fromList(<int>[1]),
            Uint8List.fromList(<int>[2]),
          ],
        )
        .result;
    expect(keys, hasLength(2));
    expect(runtime, <int>[7, 8]);
    expect(key, hasLength(32));
    expect(batch, hasLength(2));
    final prepared = await (sdk.wallet as CitizenSdkWalletBatch)
        .prepareApplicationKeys(
          accountId: '0x${'22' * 32}',
          salt: Uint8List(32),
          infos: [
            Uint8List.fromList([1]),
            Uint8List.fromList([2]),
          ],
          signingMessage: Uint8List(32),
        )
        .result;
    expect(prepared.keys, hasLength(2));
    expect(prepared.signature, hasLength(64));
    prepared.dispose();
    expect(
      prepared.keys.every((key) => key.every((byte) => byte == 0)),
      isTrue,
    );
    expect(batch.every((value) => value.length == 32), isTrue);
    await sdk.close();
  });
}

final String _qrAccount = '0x${'00' * 32}';

final class _FacadePlatform implements CitizenSdkPlatform {
  final StreamController<Object?> _events =
      StreamController<Object?>.broadcast();
  final List<List<Object?>> calls = <List<Object?>>[];

  @override
  Stream<Object?> get events => _events.stream;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    calls.add(<Object?>[method, arguments]);
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
      'deriveApplicationKey' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[Uint8List(32)],
      ],
      'prepareApplicationKeys' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          <Uint8List>[Uint8List(32), Uint8List(32)],
          Uint8List(64),
        ],
      ],
      'deriveApplicationKeys' => <Object?>[
        2,
        'session-1',
        arguments[2],
        <Object?>[
          <Uint8List>[Uint8List(32), Uint8List(32)],
        ],
      ],
      _ => throw StateError('未预期 method：$method'),
    };
  }

  Future<void> dispose() => _events.close();
}
