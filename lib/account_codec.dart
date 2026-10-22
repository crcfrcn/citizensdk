import 'dart:typed_data';

import 'package:ss58/ss58.dart' show Address;

/// 公民链 SS58 格式，逐字节对齐 citizenchain runtime。
const int citizenSs58Prefix = 2027;

final RegExp _accountIdPattern = RegExp(r'^0x[0-9a-f]{64}$');

bool isCitizenAccountId(String value) => _accountIdPattern.hasMatch(value);

String citizenAccountIdFromBytes(List<int> bytes) {
  if (bytes.length != 32) {
    throw ArgumentError.value(
      bytes.length,
      'bytes.length',
      'AccountId 必须是 32 字节',
    );
  }
  return '0x${bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';
}

Uint8List citizenAccountIdBytes(String accountId) {
  if (!isCitizenAccountId(accountId)) {
    throw const FormatException('AccountId 必须是小写 0x 加 64 位十六进制');
  }
  final hex = accountId.substring(2);
  return Uint8List.fromList(<int>[
    for (var offset = 0; offset < hex.length; offset += 2)
      int.parse(hex.substring(offset, offset + 2), radix: 16),
  ]);
}

// 直接使用同版上游SS58实现，规范地址与原冻结向量保持一致。
String citizenSs58FromAccountId(String accountId) => Address(
  prefix: citizenSs58Prefix,
  pubkey: citizenAccountIdBytes(accountId),
).encode();

Uint8List citizenPublicKeyFromSs58(String address) {
  final decoded = Uint8List.fromList(Address.decode(address).pubkey);
  if (decoded.length != 32 ||
      Address(prefix: citizenSs58Prefix, pubkey: decoded).encode() != address) {
    throw const FormatException('地址不是规范的公民链 SS58 地址');
  }
  return decoded;
}
