part of 'citizen_sdk.dart';

/// 由公民链 Core 公布的 SS58 前缀。
final int citizenSs58Prefix = _api.citizensdk_ss58_prefix();

/// 只接受 Core 定义的规范 AccountId 文本。
bool isCitizenAccountId(String value) => _withMemory((m) {
  final status = m.decodeAccountId(value, nullptr);
  if (status == c.CITIZENSDK_ERROR_INVALID_ARGUMENT) return false;
  _status(status);
  return true;
});

String citizenAccountIdFromBytes(List<int> bytes) => _withMemory(
  (m) => _encodeAccount(
    m,
    _accountBytes(m, bytes),
    _api.citizensdk_account_id_encode,
  ),
);

Uint8List citizenAccountIdBytes(String accountId) => _withMemory((m) {
  final out = _decodeAccountId(m, accountId);
  return Uint8List.fromList(out.cast<Uint8>().asTypedList(32));
});

String citizenSs58FromAccountId(String accountId) => _withMemory(
  (m) => _encodeAccount(
    m,
    _decodeAccountId(m, accountId),
    _api.citizensdk_ss58_encode,
  ),
);

String citizenSs58FromAccountIdBytes(List<int> bytes) => _withMemory(
  (m) =>
      _encodeAccount(m, _accountBytes(m, bytes), _api.citizensdk_ss58_encode),
);

Uint8List citizenAccountIdBytesFromSs58(String address) => _withMemory((m) {
  final out = m.alloc<c.citizensdk_account_id>(
    sizeOf<c.citizensdk_account_id>(),
  );
  final status = address.length > 64
      ? c.CITIZENSDK_ERROR_INVALID_ARGUMENT
      : _api.citizensdk_ss58_decode(m.view(address), out);
  if (status == c.CITIZENSDK_ERROR_INVALID_ARGUMENT) {
    throw const FormatException('地址不是规范的公民链 SS58 地址');
  }
  _status(status);
  return Uint8List.fromList(out.cast<Uint8>().asTypedList(32));
});

Pointer<c.citizensdk_account_id> _decodeAccountId(_Memory m, String accountId) {
  final out = m.alloc<c.citizensdk_account_id>(
    sizeOf<c.citizensdk_account_id>(),
  );
  final status = m.decodeAccountId(accountId, out);
  if (status == c.CITIZENSDK_ERROR_INVALID_ARGUMENT) {
    throw const FormatException('AccountId 必须是小写 0x 加 64 位十六进制');
  }
  _status(status);
  return out;
}

Pointer<c.citizensdk_account_id> _accountBytes(_Memory m, List<int> bytes) {
  if (bytes.length != 32 ||
      (bytes is! Uint8List && bytes.any((b) => b < 0 || b > 255))) {
    throw ArgumentError('AccountId 必须是 32 个有效字节');
  }
  return m.bytes(bytes).cast<c.citizensdk_account_id>();
}

String _accountIdText(Array<Uint8> value) => citizenAccountIdFromBytes(
  Uint8List.fromList([for (var i = 0; i < 32; i++) value[i]]),
);

// 两种输出都不超过 66 字节，一次调用即可取回文本。
String _encodeAccount(
  _Memory m,
  Pointer<c.citizensdk_account_id> account,
  int Function(
    Pointer<c.citizensdk_account_id>,
    Pointer<Uint8>,
    int,
    Pointer<Uint64>,
  )
  encode,
) {
  const capacity = 66;
  final out = m.alloc<Uint8>(capacity);
  final count = m.alloc<Uint64>(sizeOf<Uint64>());
  _status(encode(account, out, capacity, count));
  if (count.value <= 0 || count.value > capacity) throw _failure(9);
  return utf8.decode(out.asTypedList(count.value));
}
