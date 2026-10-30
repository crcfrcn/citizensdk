part of '../citizen_sdk.dart';

// 只管理本次C调用的真实分配。同步借用结束后清零并释放，不保留传输模型。
final class _Memory {
  final List<(Pointer<Uint8>, int)> _owned = [];
  Pointer<T> alloc<T extends NativeType>(int size) {
    if (size < 0 || size > 64 * 1024 * 1024) throw _failure(1);
    final count = size == 0 ? 1 : size;
    final bytes = calloc<Uint8>(count);
    _owned.add((bytes, count));
    return bytes.cast<T>();
  }

  Pointer<T> struct<T extends Struct>(int size) {
    final value = alloc<T>(size);
    value.cast<Uint32>()[0] = size;
    value.cast<Uint32>()[1] = c.CITIZENSDK_ABI_VERSION;
    return value;
  }

  Pointer<Uint8> bytes(List<int> value) {
    final out = alloc<Uint8>(value.length);
    out.asTypedList(value.length).setAll(0, value);
    return out;
  }

  c.citizensdk_bytes_view view(Object value, [int maximum = 16 * 1024 * 1024]) {
    final data = value is String
        ? Uint8List.fromList(utf8.encode(value))
        : value as Uint8List;
    try {
      if (data.length > maximum) throw _failure(1);
      final out = alloc<c.citizensdk_bytes_view>(
        sizeOf<c.citizensdk_bytes_view>(),
      );
      out.ref.data = bytes(data);
      out.ref.len = data.length;
      return out.ref;
    } finally {
      if (value is String) data.fillRange(0, data.length, 0);
    }
  }

  Pointer<c.citizensdk_account_id> account(String value) {
    final data = _unhex(value, 32);
    final out = alloc<c.citizensdk_account_id>(32);
    for (var i = 0; i < 32; i++) {
      out.ref.bytes[i] = data[i];
    }
    return out;
  }

  Pointer<c.citizensdk_account_id> accounts(List<String> values, int maximum) {
    if (values.length > maximum) throw _failure(1);
    final out = alloc<c.citizensdk_account_id>(32 * values.length);
    for (var i = 0; i < values.length; i++) {
      final data = _unhex(values[i], 32);
      for (var j = 0; j < 32; j++) {
        out[i].bytes[j] = data[j];
      }
    }
    return out;
  }

  Pointer<c.citizensdk_block_ref> block(CitizenBlockRef value) {
    final out = struct<c.citizensdk_block_ref>(
      sizeOf<c.citizensdk_block_ref>(),
    );
    final hash = _unhex(value.hash, 32);
    for (var i = 0; i < 32; i++) {
      out.ref.hash[i] = hash[i];
    }
    out.ref.number = _u64(value.number);
    out.ref.finality = value.finality.index + 1;
    return out;
  }

  Pointer<c.citizensdk_transaction_execution_id> executionId(String value) =>
      bytes(_unhex(value, 16)).cast<c.citizensdk_transaction_execution_id>();
  Uint8List borrow(
    int Function(Pointer<Uint8>, int, Pointer<Uint64>) call, [
    int maximum = 64 * 1024 * 1024,
  ]) {
    final count = alloc<Uint64>(8);
    _status(call(nullptr, 0, count));
    final size = count.value;
    if (size < 0 || size > maximum) throw _failure(9);
    final out = alloc<Uint8>(size);
    _status(call(out, size, count));
    if (count.value != size) throw _failure(9);
    return out.asTypedList(size);
  }

  Uint8List copy(
    int Function(Pointer<Uint8>, int, Pointer<Uint64>) call, [
    int maximum = 64 * 1024 * 1024,
  ]) => Uint8List.fromList(borrow(call, maximum));
  String text(
    int Function(Pointer<Uint8>, int, Pointer<Uint64>) call, [
    int maximum = 65536,
  ]) => utf8.decode(copy(call, maximum), allowMalformed: false);
  void dispose() {
    for (final (bytes, size) in _owned.reversed) {
      bytes.asTypedList(size).fillRange(0, size, 0);
      calloc.free(bytes);
    }
    _owned.clear();
  }
}

CitizenSdkException _failure(
  int code, [
  String message = 'CitizenSDK调用失败',
  int? stage,
]) => CitizenSdkException(
  code: code >= 1 && code <= CitizenSdkErrorCode.values.length
      ? CitizenSdkErrorCode.values[code - 1]
      : CitizenSdkErrorCode.internal,
  stage:
      stage != null &&
          stage >= 1 &&
          stage <= CitizenSdkFailureStage.values.length
      ? CitizenSdkFailureStage.values[stage - 1]
      : null,
  message: message,
);
void _status(int code) {
  if (code != 0) throw _failure(code);
}

T _withMemory<T>(T Function(_Memory) body) {
  final memory = _Memory();
  try {
    return body(memory);
  } finally {
    memory.dispose();
  }
}

BigInt _unsigned(int value) => BigInt.from(value).toUnsigned(64);
int _u64(BigInt value) {
  if (value.isNegative || value.bitLength > 64) throw _failure(1);
  return value.toSigned(64).toInt();
}

int _nativeId(String value) {
  if (!RegExp(r'^(0|[1-9][0-9]{0,19})$').hasMatch(value)) throw _failure(9);
  return _u64(BigInt.parse(value));
}

bool _boolean(int value) {
  if (value != 0 && value != 1) throw _failure(9);
  return value == 1;
}

Uint8List _unhex(String value, int length) {
  if (value.length != length * 2 + 2 ||
      !RegExp(r'^0x[0-9a-f]+$').hasMatch(value))
    throw _failure(1);
  return Uint8List.fromList(
    List.generate(
      length,
      (i) => int.parse(value.substring(2 + i * 2, 4 + i * 2), radix: 16),
    ),
  );
}

Uint8List _hexBytes(String value, int maximum) {
  if (!value.startsWith('0x') ||
      value.length.isOdd ||
      (value.length - 2) ~/ 2 > maximum ||
      !RegExp(r'^0x[0-9a-f]*$').hasMatch(value))
    throw _failure(9);
  return value.length == 2
      ? Uint8List(0)
      : _unhex(value, (value.length - 2) ~/ 2);
}

String _hex(Array<Uint8> value, int length) =>
    '0x${List.generate(length, (i) => value[i].toRadixString(16).padLeft(2, '0')).join()}';
Uint8List _array(Array<Uint8> value, int length) =>
    Uint8List.fromList(List.generate(length, (i) => value[i]));
BigInt _u128(c.citizensdk_u128 value) =>
    (_unsigned(value.high) << 64) | _unsigned(value.low);
E _enum<E>(List<E> values, int value, [int first = 0]) {
  final index = value - first;
  if (index < 0 || index >= values.length) throw _failure(9);
  return values[index];
}

int _u32(int value) {
  if (value < 0 || value > 0xffffffff) throw _failure(1);
  return value;
}

int _u16(int value) {
  if (value < 0 || value > 0xffff) throw _failure(1);
  return value;
}
