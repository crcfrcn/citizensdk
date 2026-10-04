import 'dart:async';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';

const String testAccountId =
    '0x0000000000000000000000000000000000000000000000000000000000000000';

final CitizenBlockRef testFinalizedBlock = CitizenBlockRef(
  hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  number: BigInt.one,
  finality: CitizenBlockFinality.finalized,
);

/// 合成公开端口夹具：未配置调用失败；不运行真实钱包、链或设备认证。
abstract class StrictPublicPort {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnsupportedError(
    'unexpected public SDK call: ${invocation.memberName}',
  );
}

final class RecordingChain extends StrictPublicPort implements CitizenChain {
  final List<Uint8List> storageKeys = <Uint8List>[];

  @override
  Future<CitizenBlockRef> getFinalizedHead() async => testFinalizedBlock;

  @override
  Future<Uint8List?> getStorage(CitizenBlockRef block, Uint8List key) async {
    if (block.hash != testFinalizedBlock.hash) {
      throw StateError('consumer used an unverified block');
    }
    storageKeys.add(Uint8List.fromList(key));
    return Uint8List.fromList(<int>[9, 8, 7]);
  }
}

int _operationSequence = 0;
CitizenSdkOperation<T> recordedOperation<T>(FutureOr<T> Function() action) => CitizenSdkOperation(
  operationId: (++_operationSequence).toString(), result: Future<T>.sync(action), cancel: () async => false,
);

final class RecordingReview implements CitizenQrReview {
  RecordingReview(this.document);
  @override final CitizenQrDocument document;
  bool released = false;
  @override String get requestId => document.requestId!;
  @override String get signerAccountId => document.signerAccountId!;
  @override int get expiresAt => document.expiresAt!;
  @override String get palletName => 'synthetic';
  @override String get callName => 'test';
  @override String get callArguments => '{}';
  @override Future<void> release() async { released = true; }
}

final class RecordingWallet extends StrictPublicPort implements CitizenSdkWallet {
  @override
  CitizenSdkOperation<CitizenWalletState> getState() => recordedOperation(() => CitizenWalletState(
    revision: BigInt.from(3),
    hotProfile: null,
    accounts: const <CitizenWalletStateAccount>[],
    initializationState: CitizenWalletInitializationState.empty, cleanupPending: false,
  ));
}

final class RecordingSigning extends StrictPublicPort
    implements CitizenSigning {
  RecordingSigning({this.mismatchedBinding = false});

  final bool mismatchedBinding;
  final List<CitizenSigningIntent> intents = <CitizenSigningIntent>[];

  @override
  CitizenSdkOperation<CitizenSigningOutcome> begin(CitizenSigningIntent intent) => recordedOperation(() {
    intents.add(intent);
    return CitizenSigningCompleted(
      accountId: intent.accountId,
      payloadHash: '0x${'11' * 32}',
      signature: Uint8List(64),
    );
  });

  final reviews = <RecordingReview>[];
  int signCalls = 0;
  @override
  CitizenSdkOperation<CitizenQrReview> reviewQrRequest(String request) => recordedOperation(() async {
    final review = RecordingReview(await RecordingQr().parse(request));
    reviews.add(review);
    return review;
  });

  @override
  CitizenSdkOperation<CitizenQrSigned> signQrRequest(CitizenQrReview review) => recordedOperation(() {
    if (review is! RecordingReview || review.released || !reviews.contains(review)) throw StateError('review is not owned');
    signCalls++;
    return CitizenQrSigned(
        canonicalText: 'QR_V1 response',
        qrImage: CitizenQrImage(
          width: 2,
          height: 2,
          luminance: Uint8List.fromList(<int>[0, 255, 255, 0]),
        ),
        requestId: mismatchedBinding ? 'other-request' : 'request-00000001',
        signerAccountId: testAccountId,
        signature: Uint8List(64),
        signRequest: review.document.canonicalText,
      );
  });
}

final class RecordingQr extends StrictPublicPort implements CitizenQr {
  RecordingQr({this.mismatchedResponseSignature = false});

  final bool mismatchedResponseSignature;
  final List<Uint8List> reviewPayloads = <Uint8List>[];

  @override
  Future<String> createSignRequest({
    required int action,
    required String signerAccountId,
    required Uint8List reviewPayload,
    int ttlSeconds = 120,
  }) async {
    reviewPayloads.add(Uint8List.fromList(reviewPayload));
    return 'QR_V1 request';
  }

  @override
  Future<CitizenQrDocument> parse(String text) async {
    if (text == 'QR_V1 request') {
      return CitizenQrDocument(
        kind: CitizenQrKind.signRequest,
        scanPurposeMask: 1 << (CitizenQrScanPurpose.signingRequest.value - 1),
        canonicalText: text,
        requestId: 'request-00000001',
        expiresAt: 4102444800,
        action: 0x0400,
        signerAccountId: testAccountId,
        reviewPayload: Uint8List.fromList(<int>[1, 2, 3]),
      );
    }
    if (text == 'QR_V1 response') {
      final signature = Uint8List(64);
      if (mismatchedResponseSignature) signature[0] = 1;
      return CitizenQrDocument(
        kind: CitizenQrKind.signResponse,
        scanPurposeMask: 1 << (CitizenQrScanPurpose.externalSignature.value - 1),
        canonicalText: text,
        requestId: 'request-00000001',
        expiresAt: 4102444800,
        signerAccountId: testAccountId,
        signature: signature,
      );
    }
    throw const FormatException('unsupported QR_V1 fixture');
  }
}

final class RecordedTransactionCall {
  RecordedTransactionCall(Uint8List sourceAccountId, Uint8List callData)
    : sourceAccountId = Uint8List.fromList(
        sourceAccountId,
      ).asUnmodifiableView(),
      callData = Uint8List.fromList(callData).asUnmodifiableView();

  final Uint8List sourceAccountId;
  final Uint8List callData;
}

final class RecordingTransactions extends StrictPublicPort
    implements CitizenTransactions {
  final List<RecordedTransactionCall> calls = <RecordedTransactionCall>[];

  @override
  Future<CitizenPreparedTransaction> prepareTransaction(
    Uint8List sourceAccountId,
    Uint8List callData,
  ) async {
    calls.add(RecordedTransactionCall(sourceAccountId, callData));
    final ordinal = calls.length;
    return CitizenPreparedTransaction(
      preparationId: 'preparation-$ordinal',
      sourceAccountId: sourceAccountId,
      callDataHash: Uint8List.fromList(
        List<int>.generate(
          32,
          (index) => (callData[index % callData.length] + index) & 0xff,
        ),
      ),
      bestBlock: testFinalizedBlock,
      runtimeSpecNumber: 1,
      transactionFormatNumber: 1,
      nonce: BigInt.from(ordinal),
    );
  }
}

final class RecordingHistory extends StrictPublicPort
    implements CitizenHistory {
  var readCount = 0;
  var syncCount = 0;

  @override
  Future<CitizenTransactionHistoryPage> getTransactionHistory({
    String? beforeExecutionId,
    int limit = 100,
  }) async {
    readCount += 1;
    return _page();
  }

  @override
  Future<CitizenTransactionHistoryPage> syncTransactionHistory() async {
    syncCount += 1;
    return _page();
  }

  CitizenTransactionHistoryPage _page() => CitizenTransactionHistoryPage(
    revision: BigInt.from(readCount + syncCount),
    records: const <CitizenTransactionHistoryRecord>[],
    nextBeforeExecutionId: null,
  );
}
