import 'dart:typed_data';
import 'dart:convert';


/// 公民身份上链确认(对齐 OP_SIGN_CITIZEN_IDENTITY)。
const int kOpSignCitizenIdentity = 0x10;

/// 匿名 CID 自助换绑：当前绑定账户对含创世、当前绑定、目标账户、绑定 revision 与
/// expires_at 的 `CidRebindAuthorization` 授权签名。
const int kOpSignCidRebind = 0x11;

/// 注册局代办首次占号：公民钱包对含创世、CID、目标账户、revision=0 与 expires_at
/// 的 `CidOccupyAuthorization` 授权签名。
const int kOpSignCidOccupy = 0x12;

/// 机构登记(对齐 OP_SIGN_INST)。
const int kOpSignInst = 0x13;

/// 机构/账户注销凭证(对齐 OP_SIGN_DEREGISTER)。
const int kOpSignDeregister = 0x14;

/// L3 支付(对齐 OP_SIGN_L3_PAY)。
const int kOpSignL3Pay = 0x15;

/// 链下批次结算(对齐 OP_SIGN_OFFCHAIN_BATCH)。
const int kOpSignOffchainBatch = 0x16;

/// L2 确认(对齐 OP_SIGN_L2_ACK)。
const int kOpSignL2Ack = 0x17;

/// 管理员激活(对齐 OP_SIGN_ACTIVATE_ADMIN)。
const int kOpSignActivateAdmin = 0x18;

/// 解密授权(对齐 OP_SIGN_DECRYPT)。
const int kOpSignDecrypt = 0x19;

/// 广场 BFF 登录挑战(对齐 OP_SIGN_SQUARE_LOGIN;链下 Worker 验签,设备子钥 ES256 签 digest)。
const int kOpSignSquareLogin = 0x1B;

/// 广场 BFF 设备子钥绑定(对齐 OP_SIGN_SQUARE_DEVICE_BIND；链下 Worker 验签，
/// 由当前 `account_id` 对应的 sr25519 账户密钥签名)。
const int kOpSignSquareDeviceBind = 0x1C;

/// 广场 BFF 账户敏感动作：注销/退订(对齐 OP_SIGN_SQUARE_ACTION；链下 Worker 验签，
/// 由当前 `account_id` 对应的 sr25519 账户密钥签名)。
const int kOpSignSquareAction = 0x1D;

/// 本机默认账户切换：由变化前的原默认账户签署完整目标账户顺序。
/// 只作本机动权校验，不包含 CID/绑定版本，也不提交链。
const int kOpSignSwitchDefaultAccount = 0x21;

/// 冷钱包账户数据用途钥加密交付：当前绑定账户签署精确 CID/绑定版本、用途、
/// 一次性会话公钥、nonce 与密文摘要。只作本机验签，不提交链。
const int kOpSignAccountDataKeyProvision = 0x22;

/// 钱包账户签名模式确认：本机私钥签署目标账户、`hot` 模式与一次性挑战。
/// 只用于钱包本机重标验证，不提交链。
const int kOpSignWalletMode = 0x23;

/// 产品正式发布授权；调用方按自己的授权业务选择，不按宿主产品分支。
const int kOpSignPublish = 0x24;

/// 注册局代办换绑：新钱包对完整 `CidRebindAuthorization` 的授权签名；载荷与自助
/// 换绑相同，签名域与自助换绑 0x11、首次占号 0x12 分离。
const int kOpSignCidAdminRebind = 0x1F;

// ── 二进制前缀域(0x18/0x19)──
//
// ACTIVATE_ADMIN / DECRYPT 不经 message 原语 做 blake2 hash:冷钱包对整段
// 原始可解析 payload 直接 sr25519 签名,node 按字节偏移解析。其 op_tag
// (kOpSignActivateAdmin/kOpSignDecrypt)仅作 payload **前 4 字节**
// GMB(3B) || op_tag(1B) 二进制前缀。单源对齐 primitives::sign::
// binary_domain_prefix / BINARY_PREFIX_LEN。金标布局见
// test/signer/fixtures/binary_prefix_domain_vectors.json。

/// 二进制前缀域统一前缀长度 = GMB(3B) + op_tag(1B) = 4(对齐 BINARY_PREFIX_LEN)。
const int kBinaryPrefixLen = 4;

/// 管理员激活/解密载荷中的机构 CID 固定槽长度。
/// 与 runtime `CID_NUMBER_MAX_BYTES`/`ACTIVATE_ADMIN_CID_LEN` 唯一对齐。
const int kAdminCidSlotLength = 32;

/// 管理员原始签名载荷中的固定字段长度。
const int kSignerPublicKeyLength = 32;
const int kAdminNonceLength = 16;

/// 签名域分隔符 GMB(3 字节 ASCII),单源对齐 core_const::GMB。
const List<int> kGmbSignDomain = [0x47, 0x4D, 0x42]; // "GMB"


/// 原有签名载荷原语的封闭输入；这里仅投影字段，不实现哈希或SCALE算法。
final class CitizenSigningPayload {
  CitizenSigningPayload._(this.kind, Map<String, Object?> fields, Uint8List bytes)
    : fieldsJson = jsonEncode(fields), payloadBytes = Uint8List.fromList(bytes).asUnmodifiableView();
  final int kind;
  final String fieldsJson;
  final Uint8List payloadBytes;

  factory CitizenSigningPayload.message({required int opTag, required Uint8List scalePayload}) =>
    CitizenSigningPayload._(1, {'op_tag': opTag}, scalePayload);
  factory CitizenSigningPayload.binaryPrefix(int opTag) =>
    CitizenSigningPayload._(2, {'op_tag': opTag}, Uint8List(0));
  factory CitizenSigningPayload.activateAdmin({required String cidNumber, required Uint8List institutionCode,
    required int kind, required Uint8List signerPublicKey, required BigInt timestamp, required Uint8List nonce}) =>
    CitizenSigningPayload._(3, {'cid_number': cidNumber, 'institution_code': _payloadHex(institutionCode),
      'kind': kind, 'signer_public_key': _payloadHex(signerPublicKey),
      'timestamp': timestamp.toString(), 'nonce': _payloadHex(nonce)}, Uint8List(0));
  factory CitizenSigningPayload.decryptAdmin({required String cidNumber,
    required Uint8List signerPublicKey, required BigInt timestamp, required Uint8List nonce}) =>
    CitizenSigningPayload._(4, {'cid_number': cidNumber, 'signer_public_key': _payloadHex(signerPublicKey),
      'timestamp': timestamp.toString(), 'nonce': _payloadHex(nonce)}, Uint8List(0));
  factory CitizenSigningPayload.scaleString(String value) =>
    CitizenSigningPayload._(5, const {}, Uint8List.fromList(utf8.encode(value)));
  factory CitizenSigningPayload.u64Le(BigInt value) =>
    CitizenSigningPayload._(6, {'value': value.toString()}, Uint8List(0));
}

String _payloadHex(Uint8List bytes) =>
    '0x${bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';

/// Product-independent transform applied by CitizenSDK before sr25519 signing.
enum CitizenSigningTransformKind { raw, substrateSigningPayload, blake2Domain }

/// A bounded transform descriptor. Domain bytes are opaque protocol data and never interpreted as
/// an application action by CitizenSDK.
final class CitizenSigningTransform {
  CitizenSigningTransform.raw()
    : kind = CitizenSigningTransformKind.raw,
      domain = Uint8List(0).asUnmodifiableView();

  CitizenSigningTransform.substrateSigningPayload()
    : kind = CitizenSigningTransformKind.substrateSigningPayload,
      domain = Uint8List(0).asUnmodifiableView();

  CitizenSigningTransform.blake2Domain(Uint8List domain)
    : kind = CitizenSigningTransformKind.blake2Domain,
      domain = Uint8List.fromList(domain).asUnmodifiableView() {
    if (this.domain.isEmpty || this.domain.length > 32) {
      throw ArgumentError.value(this.domain.length, 'domain', '必须包含 1..32 字节');
    }
  }

  final CitizenSigningTransformKind kind;
  final Uint8List domain;
}

enum CitizenExternalSignerTransport { qrV1 }

/// Opaque signing request supplied by any consumer application.
final class CitizenSigningIntent {
  CitizenSigningIntent({
    required this.accountId,
    required Uint8List payload,
    required this.transform,
    this.externalSignerTransport,
    this.opaqueAction = 0,
    this.ttlSeconds = 120,
  }) : payload = Uint8List.fromList(payload).asUnmodifiableView();

  final String accountId;
  final Uint8List payload;
  final CitizenSigningTransform transform;
  final CitizenExternalSignerTransport? externalSignerTransport;

  /// QR_V1 transport metadata owned by the calling application. Core never allowlists or decodes it.
  final int opaqueAction;
  final int ttlSeconds;
}

sealed class CitizenSigningOutcome {
  const CitizenSigningOutcome({
    required this.accountId,
    required this.payloadHash,
  });

  final String accountId;
  final String payloadHash;
}

final class CitizenSigningCompleted extends CitizenSigningOutcome {
  CitizenSigningCompleted({
    required super.accountId,
    required super.payloadHash,
    required Uint8List signature,
  }) : signature = Uint8List.fromList(signature).asUnmodifiableView() {
    if (this.signature.length != 64) {
      throw ArgumentError.value(
        this.signature.length,
        'signature',
        '必须是 64 字节',
      );
    }
  }

  final Uint8List signature;
}

final class CitizenExternalSigningPending extends CitizenSigningOutcome {
  const CitizenExternalSigningPending({
    required super.accountId,
    required super.payloadHash,
    required this.transport,
    required this.expiresAt,
    required this.sessionId,
    required this.transportRequest,
  });

  final CitizenExternalSignerTransport transport;
  final BigInt expiresAt;
  final String sessionId;
  final String transportRequest;
}

sealed class CitizenDefaultAccountChangeOutcome {
  const CitizenDefaultAccountChangeOutcome({
    required this.currentDefaultAccountId,
    required this.payloadHash,
  });

  final String currentDefaultAccountId;
  final String payloadHash;
}

final class CitizenDefaultAccountChangeCompleted
    extends CitizenDefaultAccountChangeOutcome {
  const CitizenDefaultAccountChangeCompleted({
    required super.currentDefaultAccountId,
    required super.payloadHash,
    required this.committedRevision,
  });

  final BigInt committedRevision;
}

final class CitizenDefaultAccountChangePending
    extends CitizenDefaultAccountChangeOutcome {
  const CitizenDefaultAccountChangePending({
    required super.currentDefaultAccountId,
    required super.payloadHash,
    required this.transport,
    required this.expiresAt,
    required this.sessionId,
    required this.transportRequest,
  });

  final CitizenExternalSignerTransport transport;
  final BigInt expiresAt;
  final String sessionId;
  final String transportRequest;
}
