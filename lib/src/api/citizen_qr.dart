import 'dart:typed_data';
import 'dart:convert';
import '../account_codec.dart';
import 'citizen_sdk_error.dart';

/// QR_V1已有动作数字常量；不携带UI标签，不决定业务资格或允许签名。
abstract final class CitizenQrActions {
  static const int login = 1;
  static const int citizenIdentity = 2;
  static const int citizenOccupy = 10;
  static const int citizenRebind = 11;
  static const int switchDefaultAccount = 12;
  static const int squareDeviceBind = 13;
  static const int accountDataKeyProvision = 14;
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
  coldAccountImport(1), transferRecipient(2), contact(3), externalSignature(4), signingRequest(5), accountDataKey(6), generalScan(7), accountTarget(8);
  const CitizenQrScanPurpose(this.value);
  final int value;
}

final class CitizenQrScanResult {
  const CitizenQrScanResult({required this.purpose, required this.document});
  final CitizenQrScanPurpose purpose;
  final CitizenQrDocument document;
  String get canonicalText => document.canonicalText;
  String? get accountId => document.accountId;
  String? get ss58Address => accountId == null ? null : citizenSs58FromAccountId(accountId!);
}

/// 相机尺寸与朝向是采集事实；裁剪、遮罩、提示和按钮仍由各App绘制。
final class CitizenQrPreview {
  const CitizenQrPreview({required this.width, required this.height, required this.rotationDegrees});
  final int width;
  final int height;
  final int rotationDegrees;
}

abstract interface class CitizenQrCapture {
  int get textureId;
  CitizenQrPreview get preview;
  Stream<CitizenQrPreview> get previewChanges;
  Stream<CitizenQrScanResult> get results;
  Stream<CitizenSdkException> get errors;
  Future<void> setTorch(bool enabled);
  Future<void> pause();
  Future<void> resume();
  Future<void> close();
}

/// SDK创建的不可变审阅事实。只有SDK实现能把对应同实例资源提交给签名入口。
abstract interface class CitizenQrReview {
  CitizenQrDocument get document;
  String get requestId;
  String get signerAccountId;
  int get expiresAt;
  String get palletName;
  String get callName;
  String get callArguments;
  Future<void> release();
}

/// 原QR_V1码型不变；宿主扫码用途与wire码型是两个独立闭集。
enum CitizenQrKind {
  signRequest(1),
  signResponse(2),
  userContact(3),
  userTransfer(4),
  accountId(5),
  accountDataKeyResponse(6);

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
    Uint8List? keyExchangePublicKey,
    Uint8List? encryptionNonce,
    Uint8List? ciphertext,
  }) : reviewPayload = reviewPayload == null
           ? null
           : Uint8List.fromList(reviewPayload).asUnmodifiableView(),
       signature = signature == null
           ? null
           : Uint8List.fromList(signature).asUnmodifiableView(),
       keyExchangePublicKey = keyExchangePublicKey == null ? null : Uint8List.fromList(keyExchangePublicKey).asUnmodifiableView(),
       encryptionNonce = encryptionNonce == null ? null : Uint8List.fromList(encryptionNonce).asUnmodifiableView(),
       ciphertext = ciphertext == null ? null : Uint8List.fromList(ciphertext).asUnmodifiableView(),
       currentAccountSignature = currentAccountSignature == null ? null : Uint8List.fromList(currentAccountSignature).asUnmodifiableView();
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
  final Uint8List? keyExchangePublicKey;
  final Uint8List? encryptionNonce;
  final Uint8List? ciphertext;
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
  CitizenQrContent._(Map<String, Object?> fields) : inputJson = jsonEncode(fields);
  final String inputJson;

  factory CitizenQrContent.signRequest({String? requestId, String requestIdPrefix = '',
    required BigInt expiresAt, required int action, String? signerAccountId,
    required Uint8List reviewPayload}) => CitizenQrContent._({
      'kind': 1, 'request_id': requestId, 'request_id_prefix': requestIdPrefix,
      'expires_at': expiresAt.toString(), 'action': action, 'signer_account_id': signerAccountId,
      'review_payload': _contentHex(reviewPayload),
    });
  factory CitizenQrContent.signResponse({required String requestId, required BigInt expiresAt,
    required String signerAccountId, required Uint8List signature,
    String? currentAccountId, Uint8List? currentAccountSignature}) => CitizenQrContent._({
      'kind': 2, 'request_id': requestId, 'expires_at': expiresAt.toString(),
      'signer_account_id': signerAccountId, 'signature': _contentHex(signature),
      'current_account_id': currentAccountId,
      'current_account_signature': currentAccountSignature == null ? null : _contentHex(currentAccountSignature),
    });
  factory CitizenQrContent.userContact({required String cidNumber, required String accountId}) =>
    CitizenQrContent._({'kind': 3, 'cid_number': cidNumber, 'account_id': accountId});
  factory CitizenQrContent.userTransfer({required String requestId, required BigInt expiresAt,
    required String accountId, required String amount, required String symbol,
    String memo = '', required String bankCidNumber}) => CitizenQrContent._({
      'kind': 4, 'request_id': requestId, 'expires_at': expiresAt.toString(), 'account_id': accountId,
      'amount': amount, 'symbol': symbol, 'memo': memo, 'bank_cid_number': bankCidNumber,
    });
  factory CitizenQrContent.accountDataKeyResponse({required String requestId,
    required BigInt expiresAt, required String signerAccountId, required Uint8List signature,
    required Uint8List keyExchangePublicKey, required Uint8List encryptionNonce,
    required Uint8List ciphertext}) => CitizenQrContent._({
      'kind': 6, 'request_id': requestId, 'expires_at': expiresAt.toString(),
      'signer_account_id': signerAccountId, 'signature': _contentHex(signature),
      'key_exchange_public_key': _contentHex(keyExchangePublicKey),
      'encryption_nonce': _contentHex(encryptionNonce), 'ciphertext': _contentHex(ciphertext),
    });
}

/// 十六进制只是C ABI规范字段的字节投影，不构造QR短键或计算签名。
String _contentHex(Uint8List bytes) =>
    '0x${bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';

enum CitizenQrAuthorizationReason { valid, invalidTemplate, invalidAccountId, sameAccount }

final class CitizenQrAuthorization {
  CitizenQrAuthorization({required this.reason, this.genesisHash, this.cidNumber,
    this.currentAccountId, this.expectedBindingRevision, this.expiresAt, Uint8List? materializedPayload})
      : materializedPayload = materializedPayload == null
          ? null : Uint8List.fromList(materializedPayload).asUnmodifiableView();
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
abstract interface class CitizenQr {
  Future<CitizenQrDocument> encodeDocument(CitizenQrContent content);
  Future<CitizenQrAuthorization> prepareAccountAuthorization({required int action,
    required Uint8List payload, required String accountId});
  Future<CitizenQrCapture> openCapture(CitizenQrScanPurpose purpose);
  Future<List<CitizenQrScanResult>> decodeImage(Uint8List encodedImage, CitizenQrScanPurpose purpose);

  Future<CitizenQrDocument> parse(String text);
  Future<CitizenQrScanResult> parseForPurpose(String text, CitizenQrScanPurpose purpose);

  Future<String> createSignRequest({
    required int action,
    required String signerAccountId,
    required Uint8List reviewPayload,
    int ttlSeconds = 120,
  });

  /// 只在请求绑定验签、过期和单次消费全部通过后返回准确 64 字节签名。
  Future<Uint8List> consumeSignResponse(String signResponse);

  /// 同实例只验签、不消费；原页面据此留页重扫，最终提交仍走原消费入口。
  Future<void> validateSignResponse({required String sessionId, required String response});

  Future<bool> cancelSignRequest(String requestId);
  Future<String> encodeAccountId(String accountId);

  /// 既有图片输入同样返回 Rust 文档，不暴露未经解析的扫描文本。
  Future<CitizenQrScanResult> decodeLuminance({
    required Uint8List data,
    required int width,
    required int height,
    required int rowStride,
    required CitizenQrScanPurpose purpose,
  });

  Future<CitizenQrImage> encode(String text, {int scale = 4});
}
