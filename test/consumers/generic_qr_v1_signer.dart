import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';

/// 仅用SDK公开无UI能力的消费者夹具；确认交互由调用者提供，不依赖外部产品源码。
final class GenericQrV1Signer {
  const GenericQrV1Signer({required this.qr, required this.signing, required this.confirm});

  final CitizenQr qr;
  final CitizenSigning signing;
  final Future<bool> Function(CitizenQrReview review) confirm;

  Future<GenericQrV1SignerResponse> respond(String canonicalRequest) async {
    final request = await qr.parse(canonicalRequest);
    if (request.kind != CitizenQrKind.signRequest ||
        request.requestId == null ||
        request.signerAccountId == null) {
      throw const FormatException('input is not a complete QR_V1 sign request');
    }

    final review = await signing.reviewQrRequest(request.canonicalText).result;
    try {
      if (!await confirm(review)) throw const CitizenSdkException(
        code: CitizenSdkErrorCode.cancelled, message: '调用方取消确认');
      final signed = await signing.signQrRequest(review).result;
      if (signed.signRequest != request.canonicalText ||
          signed.requestId != request.requestId ||
          signed.signerAccountId != request.signerAccountId ||
          signed.signature.length != 64) {
        throw const FormatException('signer output is not bound to its request');
      }

      final response = await qr.parse(signed.canonicalText);
      if (response.kind != CitizenQrKind.signResponse ||
          response.requestId != request.requestId ||
          response.signerAccountId != request.signerAccountId ||
          response.signature == null ||
          !_sameBytes(response.signature!, signed.signature)) {
        throw const FormatException(
          'QR_V1 response does not match signer output',
        );
      }

      return GenericQrV1SignerResponse(
        canonicalResponse: response.canonicalText,
        requestId: request.requestId!,
        signerAccountId: request.signerAccountId!,
        signature: response.signature!,
        image: signed.qrImage,
      );
    } finally {
      await review.release();
    }
  }
}

final class GenericQrV1SignerResponse {
  GenericQrV1SignerResponse({
    required this.canonicalResponse,
    required this.requestId,
    required this.signerAccountId,
    required Uint8List signature,
    required this.image,
  }) : signature = Uint8List.fromList(signature).asUnmodifiableView();

  final String canonicalResponse;
  final String requestId;
  final String signerAccountId;
  final Uint8List signature;
  final CitizenQrImage image;
}

bool _sameBytes(Uint8List left, Uint8List right) {
  if (left.length != right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}
