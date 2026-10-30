part of '../citizen_sdk.dart';

/// QR_V1已有动作数字常量；不携带UI标签，不决定业务资格或允许签名。
abstract final class CitizenQrActions {
  static const int login = 1;
  static const int citizenIdentity = 2;
  static const int citizenOccupy = 10;
  static const int citizenRebind = 11;
  static const int switchDefaultAccount = 12;
  static const int mlsDeviceBind = 13;
  static const int publish = 15;
  static const int onchinaAdmin = 3;
  static const int activateAdmin = 5;
  static const int decryptAdmin = 6;
  static const int runtimeUpgradeHash = 7;
  static const int squareAccountAction = 9;
  static const int transferWithRemark = 0x0400;
  static const int personalCreate = 0x0700;
  static const int personalClose = 0x0701;
  static const int personalAdminsChange = 0x1d00;
  static const int resolutionIssuance = 0x0800;
  static const int finalizeProposal = 0x0903;
  static const int retryPassedProposal = 0x0904;
  static const int cancelPassedProposal = 0x0905;
  static const int proposeRuntimeUpgrade = 0x0c00;
  static const int developerDirectUpgrade = 0x0c02;
  static const int resolutionDestroy = 0x0d00;
  static const int grandpaKeyChange = 0x0f00;
  static const int multisigTransfer = 0x1100;
  static const int safetyFundTransfer = 0x1101;
  static const int sweepToMain = 0x1102;
  static const int bindClearingBank = 0x131e;
  static const int depositClearingBank = 0x131f;
  static const int withdrawClearingBank = 0x1320;
  static const int switchClearingBank = 0x1321;
  static const int registerClearingBank = 0x1332;
  static const int updateClearingBankEndpoint = 0x1333;
  static const int unregisterClearingBank = 0x1334;
  static const int internalVote = 0x1400;
  static const int jointVote = 0x1500;
  static const int castReferendum = 0x1501;
  static const int castPopularVote = 0x1602;
  static const int castMutualVote = 0x1603;
  static const int legislationEnact = 0x1900;
  static const int legislationAmend = 0x1901;
  static const int legislationRepeal = 0x1902;
  static const int legislationRepresentativeVote = 0x1a01;
  static const int legislationReferendum = 0x1a02;
  static const int legislationExecutiveSign = 0x1a03;
  static const int legislationOverrideSign = 0x1a04;
  static const int legislationGuardVote = 0x1a05;

  static bool isChainAction(int action) => action >= 0x0100;
  static bool isSelfAccountDomainAction(int action) =>
      action == citizenOccupy || action == citizenRebind;
}

/// 用途允许集由SDK判定；冷导入只允许账户码，不改变其它入口既有用途。
enum CitizenQrScanPurpose {
  coldAccountImport(1),
  transferRecipient(2),
  contact(3),
  externalSignature(4),
  signingRequest(5),
  generalScan(7),
  accountTarget(8);

  const CitizenQrScanPurpose(this.value);
  final int value;
}

final class CitizenQrScanResult {
  const CitizenQrScanResult({required this.purpose, required this.document});
  final CitizenQrScanPurpose purpose;
  final CitizenQrDocument document;
  String get canonicalText => document.canonicalText;
  String? get accountId => document.accountId;
  String? get ss58Address =>
      accountId == null ? null : citizenSs58FromAccountId(accountId!);
}

/// 相机尺寸与朝向是采集事实；裁剪、遮罩、提示和按钮仍由各App绘制。
final class CitizenQrPreview {
  const CitizenQrPreview({
    required this.width,
    required this.height,
    required this.rotationDegrees,
  });
  final int width;
  final int height;
  final int rotationDegrees;
}

/// SDK创建的不可变审阅事实。只有SDK实现能把对应同实例资源提交给签名入口。

/// QR_V1码型仅1..5；宿主扫码用途与wire码型是两个独立闭集。
enum CitizenQrKind {
  signRequest(1),
  signResponse(2),
  userContact(3),
  userTransfer(4),
  accountId(5);

  const CitizenQrKind(this.value);
  final int value;
}

/// Rust 已严格解析的统一公开二维码结构，不是可提交的授权凭证。
///
/// 不同 kind 只含所属字段：签名请求含 action/reviewPayload，响应含 signature，
/// 账户码只含 accountId。
/// 业务只读取这些公开字段，不自行解析 QR_V1 短键或构造待签字节。
final class CitizenQrDocument {
  CitizenQrDocument({
    required this.kind,
    required this.canonicalText,
    this.requestId,
    this.expiresAt,
    this.action,
    this.signerAccountId,
    Uint8List? reviewPayload,
    Uint8List? signature,
    this.accountId,
    this.signRequest,
    required this.scanPurposeMask,
    this.cidNumber,
    this.amount,
    this.symbol,
    this.memo,
    this.bankCidNumber,
    this.currentAccountId,
    Uint8List? currentAccountSignature,
  }) : reviewPayload = reviewPayload == null
           ? null
           : Uint8List.fromList(reviewPayload).asUnmodifiableView(),
       signature = signature == null
           ? null
           : Uint8List.fromList(signature).asUnmodifiableView(),
       currentAccountSignature = currentAccountSignature == null
           ? null
           : Uint8List.fromList(currentAccountSignature).asUnmodifiableView();
  // 当前账户附加证明只作协议事实，不因解析成功就认为其已授权。

  final CitizenQrKind kind;
  final String canonicalText;
  final String? requestId;
  final int? expiresAt;
  final int? action;
  final String? signerAccountId;
  final Uint8List? reviewPayload;
  final Uint8List? signature;
  final String? accountId;

  /// Core返回的只读用途事实；App不得自行拼表或更改导入允许集。
  final int scanPurposeMask;
  final String? cidNumber;
  final String? amount;
  final String? symbol;
  final String? memo;
  final String? bankCidNumber;
  final String? currentAccountId;
  final Uint8List? currentAccountSignature;

  /// 安全签名结果中的原请求规范文本；普通 parse 文档不含此字段。
  final String? signRequest;
}

/// ZXing-C++ 生成的 8 位灰度 QR Code Model 2 图像。
final class CitizenQrImage {
  CitizenQrImage({
    required this.width,
    required this.height,
    required Uint8List luminance,
  }) : luminance = Uint8List.fromList(luminance).asUnmodifiableView();

  final int width;
  final int height;
  final Uint8List luminance;
}

/// 宿主确认同一SDK审阅资源并完成实际设备认证后的扫码签名结果。
/// QR 图像和 canonicalText 由同一响应组成，没有私钥、待签字节或内部句柄。
final class CitizenQrSigned {
  CitizenQrSigned({
    required this.canonicalText,
    required this.qrImage,
    required this.requestId,
    required this.signerAccountId,
    required Uint8List signature,
    required this.signRequest,
  }) : signature = Uint8List.fromList(signature).asUnmodifiableView();

  final String canonicalText;
  final CitizenQrImage qrImage;
  final String requestId;
  final String signerAccountId;
  final Uint8List signature;
  final String signRequest;
}

/// 规范字段输入，不是wire JSON；唯一wire编码与校验仍在Rust。
final class CitizenQrContent {
  CitizenQrContent._(Map<String, Object?> fields)
    : inputJson = jsonEncode(fields);
  final String inputJson;

  factory CitizenQrContent.signRequest({
    String? requestId,
    String requestIdPrefix = '',
    required BigInt expiresAt,
    required int action,
    String? signerAccountId,
    required Uint8List reviewPayload,
  }) => CitizenQrContent._({
    'kind': 1,
    'request_id': requestId,
    'request_id_prefix': requestIdPrefix,
    'expires_at': expiresAt.toString(),
    'action': action,
    'signer_account_id': signerAccountId,
    'review_payload': _contentHex(reviewPayload),
  });
  factory CitizenQrContent.signResponse({
    required String requestId,
    required BigInt expiresAt,
    required String signerAccountId,
    required Uint8List signature,
    String? currentAccountId,
    Uint8List? currentAccountSignature,
  }) => CitizenQrContent._({
    'kind': 2,
    'request_id': requestId,
    'expires_at': expiresAt.toString(),
    'signer_account_id': signerAccountId,
    'signature': _contentHex(signature),
    'current_account_id': currentAccountId,
    'current_account_signature': currentAccountSignature == null
        ? null
        : _contentHex(currentAccountSignature),
  });
  factory CitizenQrContent.userContact({
    required String cidNumber,
    required String accountId,
  }) => CitizenQrContent._({
    'kind': 3,
    'cid_number': cidNumber,
    'account_id': accountId,
  });
  factory CitizenQrContent.userTransfer({
    required String requestId,
    required BigInt expiresAt,
    required String accountId,
    required String amount,
    required String symbol,
    String memo = '',
    required String bankCidNumber,
  }) => CitizenQrContent._({
    'kind': 4,
    'request_id': requestId,
    'expires_at': expiresAt.toString(),
    'account_id': accountId,
    'amount': amount,
    'symbol': symbol,
    'memo': memo,
    'bank_cid_number': bankCidNumber,
  });
}

/// 十六进制只是C ABI规范字段的字节投影，不构造QR短键或计算签名。
String _contentHex(Uint8List bytes) =>
    '0x${bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';

enum CitizenQrAuthorizationReason {
  valid,
  invalidTemplate,
  invalidAccountId,
  sameAccount,
}

final class CitizenQrAuthorization {
  CitizenQrAuthorization({
    required this.reason,
    this.genesisHash,
    this.cidNumber,
    this.currentAccountId,
    this.expectedBindingRevision,
    this.expiresAt,
    Uint8List? materializedPayload,
  }) : materializedPayload = materializedPayload == null
           ? null
           : Uint8List.fromList(materializedPayload).asUnmodifiableView();
  final CitizenQrAuthorizationReason reason;
  final String? genesisHash;
  final String? cidNumber;
  final String? currentAccountId;
  final BigInt? expectedBindingRevision;
  final BigInt? expiresAt;
  final Uint8List? materializedPayload;
  bool get isValid => reason == CitizenQrAuthorizationReason.valid;
}

/// 唯一 QR_V1 协议、扫码会话及 ZXing-C++ 图像模块。
///
/// QR-only 不创建钱包、金库或轻节点；所有过期判断由 Core 系统时钟完成。
/// 安全扫码签名使用signing的审阅资源；SDK核验事实和授权，用户确认UI归App。

// QR文本由Core解释；图像只调用同一ZXing接口，系统采集只调用真实资源通道。
extension Qr on CitizenSdk {
  Future<CitizenQrDocument> parseQr(String text) async {
    _requireOpen();
    return _withMemory(
      (m) => _document(
        m.text(
          (b, cap, n) => _api.citizensdk_qr_parse(
            _handle,
            m.view(text, 2331),
            0,
            b,
            cap,
            n,
          ),
        ),
      ),
    );
  }

  Future<CitizenQrScanResult> parseForPurpose(
    String text,
    CitizenQrScanPurpose purpose,
  ) async {
    _requireOpen();
    return _withMemory(
      (m) => CitizenQrScanResult(
        purpose: purpose,
        document: _document(
          m.text(
            (b, cap, n) => _api.citizensdk_qr_parse(
              _handle,
              m.view(text, 2331),
              purpose.value,
              b,
              cap,
              n,
            ),
          ),
        ),
      ),
    );
  }

  Future<CitizenQrDocument> encodeDocument(CitizenQrContent content) async {
    _requireOpen();
    return _withMemory(
      (m) => _document(
        m.text(
          (b, cap, n) => _api.citizensdk_qr_encode_document(
            _handle,
            m.view(content.inputJson, 65536),
            b,
            cap,
            n,
          ),
        ),
      ),
    );
  }

  Future<String> encodeAccountId(String accountId) async {
    _requireOpen();
    return _withMemory(
      (m) => m.text(
        (b, cap, n) => _api.citizensdk_qr_encode_account_id(
          _handle,
          m.account(accountId),
          b,
          cap,
          n,
        ),
        2331,
      ),
    );
  }

  Future<CitizenQrAuthorization> prepareAccountAuthorization({
    required int action,
    required Uint8List payload,
    required String accountId,
  }) async {
    _requireOpen();
    return _withMemory((m) {
      final json = _json(
        m.text(
          (b, cap, n) => _api.citizensdk_qr_prepare_account_authorization(
            _handle,
            _u32(action),
            m.view(payload, 1920),
            m.view(accountId, 1024),
            b,
            cap,
            n,
          ),
        ),
      );
      final reason = _enum(
        CitizenQrAuthorizationReason.values,
        _jsonInt(json['reason']),
      );
      return CitizenQrAuthorization(
        reason: reason,
        genesisHash: json['genesis_hash'] as String?,
        cidNumber: json['cid_number'] as String?,
        currentAccountId: json['current_account_id'] as String?,
        expectedBindingRevision: json['expected_binding_revision'] == null
            ? null
            : _jsonUnsigned(json['expected_binding_revision']),
        expiresAt: json['expires_at'] == null
            ? null
            : _jsonUnsigned(json['expires_at']),
        materializedPayload: json['materialized_payload'] == null
            ? null
            : _hexBytes(json['materialized_payload']! as String, 1920),
      );
    });
  }

  Future<String> createSignRequest({
    required int action,
    required String signerAccountId,
    required Uint8List reviewPayload,
    int ttlSeconds = 120,
  }) async {
    _requireOpen();
    return _withMemory(
      (m) => m.text(
        (b, cap, n) => _api.citizensdk_qr_create_sign_request(
          _handle,
          _u16(action),
          m.account(signerAccountId),
          m.view(reviewPayload, 1920),
          ttlSeconds,
          b,
          cap,
          n,
        ),
        2331,
      ),
    );
  }

  Future<void> validateSignResponse({
    required String sessionId,
    required String response,
  }) async {
    _requireOpen();
    _withMemory(
      (m) => _status(
        _api.citizensdk_qr_validate_sign_response(
          _handle,
          m.view(sessionId, 128),
          m.view(response, 2331),
        ),
      ),
    );
  }

  Future<Uint8List> consumeSignResponse(String response) async {
    _requireOpen();
    return _withMemory((m) {
      final out = m.alloc<Uint8>(64);
      _status(
        _api.citizensdk_qr_consume_sign_response(
          _handle,
          m.view(response, 2331),
          out,
        ),
      );
      return Uint8List.fromList(out.asTypedList(64)).asUnmodifiableView();
    });
  }

  Future<bool> cancelSignRequest(String requestId) async {
    _requireOpen();
    return _withMemory((m) {
      final out = m.alloc<Uint8>(1);
      _status(
        _api.citizensdk_qr_cancel_sign_request(
          _handle,
          m.view(requestId, 128),
          out,
        ),
      );
      return _boolean(out.value);
    });
  }

  Future<CitizenQrImage> encodeQr(String text, {int scale = 4}) async {
    _requireOpen();
    return _withMemory((m) => _encodeQr(m, text, scale));
  }

  Future<CitizenQrScanResult> decodeLuminance({
    required Uint8List data,
    required int width,
    required int height,
    required int rowStride,
    required CitizenQrScanPurpose purpose,
  }) async {
    _requireOpen();
    return _withMemory((m) {
      final pixels = m.view(data, 16 * 1024 * 1024),
          count = m.alloc<Size>(sizeOf<Size>());
      final code = _api.citizensdk_qr_image_decode_luminance(
        pixels.data,
        pixels.len,
        _u32(width),
        _u32(height),
        _u32(rowStride),
        nullptr,
        0,
        count,
      );
      if (code != 6) {
        _imageStatus(code);
        throw _failure(9);
      }
      if (count.value < 1 || count.value > 2331) throw _failure(9);
      final size = count.value, out = m.alloc<Uint8>(size);
      _imageStatus(
        _api.citizensdk_qr_image_decode_luminance(
          pixels.data,
          pixels.len,
          width,
          height,
          rowStride,
          out,
          size,
          count,
        ),
      );
      if (count.value != size) throw _failure(9);
      final raw = utf8.decode(out.asTypedList(size));
      final document = _document(
        m.text(
          (b, cap, n) => _api.citizensdk_qr_parse(
            _handle,
            m.view(raw, 2331),
            purpose.value,
            b,
            cap,
            n,
          ),
        ),
      );
      return CitizenQrScanResult(purpose: purpose, document: document);
    });
  }

  Future<List<CitizenQrScanResult>> decodeImage(
    Uint8List encodedImage,
    CitizenQrScanPurpose purpose,
  ) async {
    _requireOpen();
    final value = await _resource('qrDecodeImage', [
      encodedImage,
      purpose.value,
    ]);
    if (value.length != 1 || value[0] is! List<Object?>) throw _failure(9);
    return List.unmodifiable(
      (value[0]! as List<Object?>).map(
        (raw) => CitizenQrScanResult(
          purpose: purpose,
          document: _document(raw! as String),
        ),
      ),
    );
  }

  Future<CitizenQrCapture> openQrCapture(CitizenQrScanPurpose purpose) {
    _requireOpen();
    return _ownUi(() async {
      final value = await _resource('openQrCapture', [purpose.value]);
      if (value.length != 5 || value[0] is! String || value[1] is! int) {
        throw _failure(9);
      }
      final capture = CitizenQrCapture._(
        this,
        value[0]! as String,
        value[1]! as int,
        _preview(value.sublist(2)),
        purpose,
      );
      try {
        await capture.resume();
        return capture;
      } on Object {
        await capture.close();
        rethrow;
      }
    });
  }

  Future<CitizenSdkPrivateKey> openPrivateKey(String accountId) {
    _requireOpen();
    return _ownUi(() async {
      final value = await _resource('openPrivateKey', [accountId]);
      if (value.length != 1 || value[0] is! String) throw _failure(9);
      return CitizenSdkPrivateKey._(this, value[0]! as String);
    });
  }

  CitizenSdkOperation<CitizenQrReview> reviewQrRequest(String signRequest) =>
      _operation(
        (m, out) => _api.citizensdk_review_qr_sign_request(
          _handle,
          m.view(signRequest, 2331),
          out,
        ),
        (m, result) {
          final json = _json(
            m.text(
              (b, cap, n) => _api.citizensdk_result_copy_qr(result, b, cap, n),
            ),
          );
          final document = _documentMap(json);
          if (document.kind != CitizenQrKind.signRequest ||
              document.signerAccountId == null ||
              document.requestId == null ||
              document.expiresAt == null) {
            throw _failure(9);
          }
          final review = CitizenQrReview._(
            this,
            result,
            document,
            _jsonString(json['pallet_name'], 256),
            _jsonString(json['call_name'], 256),
            _jsonString(json['call_arguments'], 65536),
          );
          _transferred.add(result);
          _remember(review.release);
          return review;
        },
      );
  CitizenSdkOperation<CitizenQrSigned> signQrRequest(CitizenQrReview review) {
    if (!identical(review._sdk, this) ||
        review._released ||
        review._submitted) {
      throw _failure(1);
    }
    final operation = _operation(
      (m, out) => _api.citizensdk_sign_qr_request(_handle, review._result, out),
      (m, result) {
        final document = _document(
          m.text(
            (b, cap, n) => _api.citizensdk_result_copy_qr(result, b, cap, n),
          ),
        );
        if (document.kind != CitizenQrKind.signResponse ||
            document.requestId == null ||
            document.signerAccountId == null ||
            document.signature == null ||
            document.signRequest == null) {
          throw _failure(9);
        }
        return CitizenQrSigned(
          canonicalText: document.canonicalText,
          qrImage: _encodeQr(m, document.canonicalText, 4),
          requestId: document.requestId!,
          signerAccountId: document.signerAccountId!,
          signature: document.signature!,
          signRequest: document.signRequest!,
        );
      },
    );
    review._submitted = true;
    return operation;
  }
}

Map<String, Object?> _json(String text) {
  try {
    final value = jsonDecode(text);
    if (value is! Map<String, Object?>) throw _failure(9);
    return value;
  } on FormatException {
    throw _failure(9);
  }
}

String _jsonString(Object? value, int maximum) {
  if (value is! String || utf8.encode(value).length > maximum) {
    throw _failure(9);
  }
  return value;
}

int _jsonInt(Object? value) {
  if (value is! int || value < 0) throw _failure(9);
  return value;
}

BigInt _jsonUnsigned(Object? value) {
  final text = value is int ? value.toString() : value;
  if (text is! String || !RegExp(r'^(0|[1-9][0-9]{0,19})$').hasMatch(text)) {
    throw _failure(9);
  }
  final number = BigInt.parse(text);
  if (number.bitLength > 64) throw _failure(9);
  return number;
}

CitizenQrDocument _document(String text) => _documentMap(_json(text));
CitizenQrDocument _documentMap(Map<String, Object?> value) {
  String? string(String key, int maximum) =>
      value[key] == null ? null : _jsonString(value[key], maximum);
  Uint8List? bytes(String key, int maximum) => value[key] == null
      ? null
      : _hexBytes(_jsonString(value[key], maximum * 2 + 2), maximum);
  final kind = CitizenQrKind.values.firstWhere(
    (v) => v.value == _jsonInt(value['kind']),
    orElse: () => throw _failure(9),
  );
  final mask = _jsonInt(value['scan_purpose_mask']);
  if (mask > 255) throw _failure(9);
  final expiry = value['expires_at'] == null
      ? null
      : _jsonUnsigned(value['expires_at']);
  if (expiry != null && expiry > BigInt.from(0x7fffffffffffffff)) {
    throw _failure(9);
  }
  final result = CitizenQrDocument(
    kind: kind,
    canonicalText: _jsonString(value['canonical_text'], 2331),
    requestId: string('request_id', 128),
    expiresAt: expiry?.toInt(),
    action: value['action'] == null ? null : _jsonInt(value['action']),
    signerAccountId: string('signer_account_id', 66),
    reviewPayload: bytes('review_payload', 1920),
    signature: bytes('signature', 64),
    accountId: string('account_id', 66),
    signRequest: string('sign_request', 2331),
    scanPurposeMask: mask,
    cidNumber: string('cid_number', 256),
    amount: string('amount', 2331),
    symbol: string('symbol', 2331),
    memo: string('memo', 2331),
    bankCidNumber: string('bank_cid_number', 256),
    currentAccountId: string('current_account_id', 66),
    currentAccountSignature: bytes('current_account_signature', 64),
  );
  if (result.canonicalText.isEmpty) throw _failure(9);
  for (final account in [
    result.accountId,
    result.signerAccountId,
    result.currentAccountId,
  ]) {
    if (account != null) _unhex(account, 32);
  }
  switch (kind) {
    case CitizenQrKind.signRequest:
      if (result.requestId == null ||
          result.expiresAt == null ||
          result.action == null ||
          result.reviewPayload == null) {
        throw _failure(9);
      }
    case CitizenQrKind.signResponse:
      if (result.requestId == null ||
          result.expiresAt == null ||
          result.signerAccountId == null ||
          result.signature?.length != 64) {
        throw _failure(9);
      }
    case CitizenQrKind.userContact:
      if (result.accountId == null || result.cidNumber == null) {
        throw _failure(9);
      }
    case CitizenQrKind.userTransfer:
      if (result.accountId == null ||
          result.requestId == null ||
          result.expiresAt == null ||
          result.amount == null ||
          result.symbol == null ||
          result.bankCidNumber == null) {
        throw _failure(9);
      }
    case CitizenQrKind.accountId:
      if (result.accountId == null) throw _failure(9);
  }
  return result;
}

CitizenQrPreview _preview(List<Object?> fields) {
  if (fields.length != 3 || fields.any((v) => v is! int)) throw _failure(9);
  final width = fields[0]! as int,
      height = fields[1]! as int,
      rotation = fields[2]! as int;
  if (width < 1 ||
      width > 4096 ||
      height < 1 ||
      height > 4096 ||
      ![0, 90, 180, 270].contains(rotation)) {
    throw _failure(9);
  }
  return CitizenQrPreview(
    width: width,
    height: height,
    rotationDegrees: rotation,
  );
}

void _imageStatus(int code) {
  if (code != 0) {
    throw _failure(switch (code) {
      1 || 2 => 1,
      3 => 7,
      4 => 8,
      5 => 16,
      _ => 20,
    });
  }
}

CitizenQrImage _encodeQr(_Memory m, String text, int scale) {
  final width = m.alloc<Uint32>(4),
      height = m.alloc<Uint32>(4),
      count = m.alloc<Size>(sizeOf<Size>()),
      value = m.view(text, 2331);
  final code = _api.citizensdk_qr_image_encode_text(
    value.data,
    value.len,
    _u32(scale),
    nullptr,
    0,
    width,
    height,
    count,
  );
  if (code != 6) {
    _imageStatus(code);
    throw _failure(9);
  }
  if (count.value < 1 ||
      count.value > 16 * 1024 * 1024 ||
      width.value * height.value != count.value) {
    throw _failure(9);
  }
  final size = count.value,
      w = width.value,
      h = height.value,
      out = m.alloc<Uint8>(size);
  _imageStatus(
    _api.citizensdk_qr_image_encode_text(
      value.data,
      value.len,
      scale,
      out,
      size,
      width,
      height,
      count,
    ),
  );
  if (count.value != size || width.value != w || height.value != h) {
    throw _failure(9);
  }
  return CitizenQrImage(width: w, height: h, luminance: out.asTypedList(size));
}

final class CitizenQrReview {
  CitizenQrReview._(
    this._sdk,
    this._result,
    this.document,
    this.palletName,
    this.callName,
    this.callArguments,
  );
  final CitizenSdk _sdk;
  final int _result;
  bool _released = false, _submitted = false;
  final CitizenQrDocument document;
  final String palletName;
  final String callName;
  final String callArguments;
  String get requestId => document.requestId!;
  String get signerAccountId => document.signerAccountId!;
  int get expiresAt => document.expiresAt!;
  Future<void> release() async {
    if (_released) return;
    if (!_sdk._closed && !_sdk._detached) {
      _status(_api.citizensdk_result_release(_result));
    }
    _released = true;
    _sdk._forget(release);
  }
}

final class CitizenQrCapture {
  CitizenQrCapture._(
    this._sdk,
    this._id,
    this.textureId,
    this._preview,
    this._purpose,
  ) {
    _events = _sdk.events.listen((event) {
      if (event is! CitizenSdkQrCaptureEvent ||
          event.resourceId != _id ||
          _closed) {
        return;
      }
      if (event.preview != null) {
        _preview = event.preview!;
        _previews.add(_preview);
      }
      if (event.result != null && !_closingRequested) {
        if (event.result!.purpose != _purpose) {
          _errors.add(
            const CitizenSdkException(
              code: CitizenSdkErrorCode.integrity,
              message: '采集用途与资源不一致',
            ),
          );
          unawaited(close());
        } else {
          _results.add(event.result!);
        }
      }
      if (event.error != null) _errors.add(event.error!);
      if (event.closed) {
        unawaited(
          close().catchError((Object error) {
            if (!_closed && error is CitizenSdkException) _errors.add(error);
          }),
        );
      }
    });
    _sdk._remember(close);
    if (_sdk._resourceClosed(_id)) unawaited(close());
  }
  final CitizenSdk _sdk;
  final String _id;
  final CitizenQrScanPurpose _purpose;
  final int textureId;
  CitizenQrPreview _preview;
  CitizenQrPreview get preview => _preview;
  final _results = StreamController<CitizenQrScanResult>.broadcast();
  final _errors = StreamController<CitizenSdkException>.broadcast();
  final _previews = StreamController<CitizenQrPreview>.broadcast();
  late final StreamSubscription<CitizenSdkEvent> _events;
  bool _closed = false;
  bool _closingRequested = false;
  Future<void>? _closing;
  Stream<CitizenQrScanResult> get results => _results.stream;
  Stream<CitizenSdkException> get errors => _errors.stream;
  Stream<CitizenQrPreview> get previewChanges => _previews.stream;
  Future<void> setTorch(bool enabled) async {
    await _sdk._resource('setQrCaptureTorch', [_id, enabled]);
  }

  Future<void> pause() async {
    await _sdk._resource('pauseQrCapture', [_id]);
  }

  Future<void> resume() async {
    if (_closingRequested) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.cancelled,
        message: '采集资源已关闭',
      );
    }
    await _sdk._resource('resumeQrCapture', [_id]);
  }

  Future<void> close() {
    if (_closed) return Future<void>.value();
    _closingRequested = true;
    return _closing ??= _close();
  }

  Future<void> _close() async {
    try {
      if (!_sdk._closed) await _sdk._resource('closeQrCapture', [_id]);
      _closed = true;
      _sdk._forget(close);
      _sdk._acknowledge(_id);
      await _events.cancel();
      // 暂停的宿主Stream订阅不能阻塞已真实排空的相机/纹理释放。
      unawaited(_results.close());
      unawaited(_errors.close());
      unawaited(_previews.close());
    } on Object {
      _closing = null;
      rethrow;
    }
  }
}

final class CitizenSdkPrivateKey {
  CitizenSdkPrivateKey._(this._sdk, this._id) {
    _events = _sdk.events.listen((event) {
      if (event is CitizenSdkPrivateKeyClosed && event.resourceId == _id) {
        _closeRequested = true;
        _bytes?.fillRange(0, _bytes!.length, 0);
        unawaited(
          close().catchError((Object _) {
            /* 调用方仍可重试close，秘密已经清零。 */
          }),
        );
      }
    });
    _sdk._remember(close);
    if (_sdk._resourceClosed(_id)) {
      _closeRequested = true;
      unawaited(
        close().catchError((Object _) {
          /* 原生关闭早于资源接管。 */
        }),
      );
    }
  }
  final CitizenSdk _sdk;
  final String _id;
  final Completer<void> _closed = Completer<void>();
  Future<Uint8List>? _revealing;
  Future<void>? _closing;
  Uint8List? _bytes;
  bool _closeRequested = false;
  late final StreamSubscription<CitizenSdkEvent> _events;
  Future<void> get closed => _closed.future;
  Future<Uint8List> reveal() {
    if (_closeRequested || _revealing != null) {
      return Future<Uint8List>.error(
        const CitizenSdkException(
          code: CitizenSdkErrorCode.invalidState,
          message: '私钥资源只允许一次显式查看',
        ),
      );
    }
    return _revealing = _reveal();
  }

  Future<Uint8List> _reveal() async {
    final value = await _sdk._resource('revealPrivateKey', [_id]);
    if (value.length != 1 || value[0] is! Uint8List) throw _failure(9);
    final raw = value[0]! as Uint8List;
    try {
      if (_closeRequested) {
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.cancelled,
          message: '私钥显示已取消',
        );
      }
      if (raw.length != 32) {
        throw const CitizenSdkException(
          code: CitizenSdkErrorCode.decode,
          message: '私钥显示结果长度无效',
        );
      }
      _bytes = Uint8List.fromList(raw);
      return _bytes!.asUnmodifiableView();
    } finally {
      raw.fillRange(0, raw.length, 0);
    }
  }

  Future<void> close() {
    if (_closed.isCompleted) return _closed.future;
    return _closing ??= _close();
  }

  Future<void> _close() async {
    _closeRequested = true;
    _bytes?.fillRange(0, _bytes!.length, 0);
    try {
      if (!_sdk._closed) await _sdk._resource('closePrivateKey', [_id]);
      try {
        await _revealing;
      } on Object {
        /* 已请求关闭，不再显示迟到结果。 */
      }
      _bytes?.fillRange(0, _bytes!.length, 0);
      _sdk._forget(close);
      _sdk._acknowledge(_id);
      await _events.cancel();
      _closed.complete();
    } on Object {
      _closing = null;
      rethrow;
    }
  }

  @override
  String toString() => 'CitizenSdkPrivateKey(redacted)';
}
