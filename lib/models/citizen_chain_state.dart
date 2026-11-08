part of '../citizen_sdk.dart';

/// CitizenSDK 实例的稳定生命周期。
enum CitizenSdkLifecycle {
  created,
  importingState,
  starting,
  running,
  startFailed,
  stopped,
  disposed,
}

enum CitizenBlockFinality { best, finalized }

/// 已由 Core 验证的块引用。
final class CitizenBlockRef {
  const CitizenBlockRef({
    required this.hash,
    required this.number,
    required this.finality,
  });

  final String hash;
  final BigInt number;
  final CitizenBlockFinality finality;
}

/// 同一个轻节点快照中的同步、可用性和链头事实。
final class CitizenChainSyncStatus {
  const CitizenChainSyncStatus({
    required this.peerCount,
    required this.isSyncing,
    required this.isUsable,
    required this.best,
    required this.finalized,
  });

  final BigInt peerCount;
  final bool isSyncing;
  final bool isUsable;
  final CitizenBlockRef best;
  final CitizenBlockRef finalized;
}

/// 一个准确块的已验证 Header；digest 是完整 SCALE Digest，不承载应用业务语义。
final class CitizenBlockHeader {
  CitizenBlockHeader({
    required this.block,
    required this.parentHash,
    required this.stateRoot,
    required this.extrinsicsRoot,
    required Uint8List digest,
  }) : digest = Uint8List.fromList(digest).asUnmodifiableView();

  final CitizenBlockRef block;
  final String parentHash;
  final String stateRoot;
  final String extrinsicsRoot;
  final Uint8List digest;
}

/// 一个准确块中保持顺序的 opaque SCALE extrinsic 字节。
final class CitizenBlockBody {
  CitizenBlockBody({required this.block, required List<Uint8List> extrinsics})
    : extrinsics = List<Uint8List>.unmodifiable(
        extrinsics.map(
          (value) => Uint8List.fromList(value).asUnmodifiableView(),
        ),
      );

  final CitizenBlockRef block;
  final List<Uint8List> extrinsics;

  /// 仅使用本块已验证正文中该索引的完整 SCALE extrinsic。
  String transactionHashAt(int index) {
    if (index < 0 || index >= extrinsics.length) {
      throw const FormatException('事件交易索引超出已验证区块正文');
    }
    return _withMemory((m) {
      final hash = m.alloc<Uint8>(32);
      _status(_api.citizensdk_hash_extrinsic(
        m.view(extrinsics[index], 64 * 1024 * 1024),
        hash,
      ));
      return _payloadHex(hash.asTypedList(32));
    });
  }
}

/// 一个已解码的 System.Events 记录。空 extrinsicIndex 表示区块级阶段。
final class CitizenSystemEvent {
  const CitizenSystemEvent({
    required this.eventIndex,
    required this.extrinsicIndex,
    required this.pallet,
    required this.name,
    required this.fields,
  });

  final int eventIndex;
  final int? extrinsicIndex;
  final String pallet;
  final String name;

  /// 按 metadata 保留字段名和容器。SCALE 整数采用十进制字符串。
  final Object? fields;

  Object? _field(String name) {
    final values = fields;
    if (values is! Map<String, Object?> || !values.containsKey(name)) {
      throw FormatException('$pallet.${this.name} 缺少命名字段 $name');
    }
    return values[name];
  }

  /// 按透明包装读取 metadata 字节序列，拒绝超出 u8 的字段。
  Uint8List fieldBytes(String name) {
    var value = _field(name);
    while (value is List<Object?> &&
        value.length == 1 &&
        value.single is List<Object?>) {
      value = value.single;
    }
    if (value is! List<Object?>) throw FormatException('$name 不是字节序列');
    return Uint8List.fromList([
      for (final item in value) _eventByte(item, name),
    ]);
  }

  BigInt fieldUnsigned(String name) {
    var value = _field(name);
    while (value is List<Object?> && value.length == 1) {
      value = value.single;
    }
    final number = value is String ? BigInt.tryParse(value) : null;
    if (number == null || number.isNegative || number.bitLength > 128) {
      throw FormatException('$name 不是 u128');
    }
    return number;
  }

  static int _eventByte(Object? value, String name) {
    final number = value is String ? int.tryParse(value) : null;
    if (number == null || number < 0 || number > 255) {
      throw FormatException('$name 含非 u8 字段');
    }
    return number;
  }
}

/// 同一准确块上的 Runtime 版本与完整 SCALE metadata。
final class CitizenRuntimeContext {
  CitizenRuntimeContext({
    required this.block,
    required this.specVersion,
    required this.transactionVersion,
    required Uint8List metadata,
  }) : metadata = Uint8List.fromList(metadata).asUnmodifiableView();

  final CitizenBlockRef block;
  final int specVersion;
  final int transactionVersion;
  final Uint8List metadata;

  /// 从本块 metadata 读取无符号整数常量。缺失或类型不符时失败。
  BigInt unsignedConstant(String pallet, String name) => BigInt.parse(
    utf8.decode(
      _chainCodec({
        'op': 'unsigned_constant',
        'pallet': pallet,
        'name': name,
      }, metadata),
    ),
  );

  Uint8List storageKey(String pallet, String entry, [List<Object> keys = const []]) =>
      _chainCodec({'op': 'storage', 'pallet': pallet, 'entry': entry,
        'keys': keys.map(_scaleField).toList()}, metadata);

  Object? decodeStorage(String pallet, String entry, Uint8List value) => jsonDecode(
    utf8.decode(_chainCodec({'op': 'decode_storage', 'pallet': pallet,
      'entry': entry, 'value': value}, metadata)),
  );

  /// 纯解码使用此 context 的 metadata，链上来源由 getFinalizedEvents 核验。
  List<CitizenSystemEvent> decodeSystemEvents(Uint8List bytes) => _withMemory((
    m,
  ) {
    final context = m.view(metadata, 8 * 1024 * 1024);
    final input = m.view(bytes, 16 * 1024 * 1024);
    final decoded = jsonDecode(
      m.text(
        (out, capacity, count) => _api.citizensdk_decode_system_events(
          context, input, out, capacity, count,
        ),
        64 * 1024 * 1024,
      ),
      reviver: (_, Object? value) => switch (value) {
        final List<Object?> values => List<Object?>.unmodifiable(values),
        final Map<String, Object?> values => Map<String, Object?>.unmodifiable(values),
        _ => value,
      },
    ) as List<Object?>;
    return List.unmodifiable(decoded.map((raw) {
      final event = raw as Map<String, Object?>;
      return CitizenSystemEvent(
        eventIndex: event['event_index'] as int,
        extrinsicIndex: event['extrinsic_index'] as int?,
        pallet: event['pallet'] as String,
        name: event['name'] as String,
        fields: event['fields'],
      );
    }));
  });

  Uint8List encodeCall(String pallet, String method, Object args) =>
      _chainCodec({'op': 'call', 'pallet': pallet, 'method': method,
        'args': _scaleField(args)}, metadata);
}


/// 已验证的 EVM 地址映射及其准确 finalized 块。
typedef CitizenEvmAccount = ({String accountId, String ss58Address, CitizenBlockRef block});

/// 可显式导入/导出的 smoldot finalized database；不是旧 App 钱包迁移格式。
final class CitizenChainState {
  CitizenChainState({
    required this.formatVersion,
    required this.finalized,
    required Uint8List database,
  }) : database = Uint8List.fromList(database).asUnmodifiableView();

  final int formatVersion;
  final CitizenBlockRef finalized;
  final Uint8List database;
}

/// finalized 块上的账户余额，单位均为整数分。
final class CitizenAccountBalance {
  const CitizenAccountBalance({
    required this.accountId,
    required this.block,
    required this.freeFen,
    required this.reservedFen,
    required this.totalFen,
  });

  final String accountId;
  final CitizenBlockRef block;
  final BigInt freeFen;
  final BigInt reservedFen;
  final BigInt totalFen;
}

/// best 块 Runtime 的精确账户 nonce；它不是交易池 nonce 租约。
final class CitizenAccountNonce {
  const CitizenAccountNonce({
    required this.accountId,
    required this.bestBlock,
    required this.nonce,
  });

  final String accountId;
  final CitizenBlockRef bestBlock;
  final BigInt nonce;
}

/// 同一 best 块读取的链上费率、最低费用和存续金额。
final class CitizenFeeSnapshot {
  const CitizenFeeSnapshot({
    required this.bestBlock,
    required this.feeRateParts,
    required this.minimumFeeFen,
    required this.existentialDepositFen,
    required this.voteFeeFen,
    required this.feeFen,
    required this.minimumSelfPayFen,
  });

  final CitizenBlockRef bestBlock;
  final int feeRateParts;
  final BigInt minimumFeeFen;
  final BigInt existentialDepositFen;
  final BigInt voteFeeFen;
  final BigInt feeFen;
  final BigInt minimumSelfPayFen;
}

final _fenScale = BigInt.from(100);
final _maxFen = (BigInt.one << 128) - BigInt.one;
final _amountPattern = RegExp(
  r'^(-?)(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{0,2}))?$',
);
final _thousands = RegExp(r'\B(?=(\d{3})+(?!\d))');

/// 解析公民链金额文本，精确返回分。无效格式、超精度和溢出返回空。
BigInt? parseFen(String text) {
  final match = _amountPattern.firstMatch(text.trim());
  if (match == null) return null;
  final whole = match.group(2)!.replaceAll(',', '');
  final fraction = match.group(3) ?? '';
  if (whole.isEmpty && fraction.isEmpty) return null;
  final fen = BigInt.parse('$whole${fraction.padRight(2, '0')}');
  if (fen > _maxFen) return null;
  return match.group(1)!.isEmpty ? fen : -fen;
}

/// 按整数分展示公民链金额。单位由调用方附加。
String formatFen(BigInt fen, {bool group = true, bool trimZeros = false}) {
  final value = fen.abs();
  final whole = (value ~/ _fenScale).toString();
  final digits = group ? _groupAmount(whole) : whole;
  final fraction = (value % _fenScale).toString().padLeft(2, '0');
  final suffix = trimZeros
      ? fraction.replaceFirst(RegExp(r'0+$'), '')
      : fraction;
  final sign = fen.isNegative ? '-' : '';
  return suffix.isEmpty ? '$sign$digits' : '$sign$digits.$suffix';
}

/// 对金额输入的整数部分分组，保留编辑中的小数点和尾零。
String? groupAmountInput(String text) {
  final match = _amountPattern.firstMatch(text.replaceAll(',', ''));
  if (match == null || match.group(1)!.isNotEmpty) return null;
  final whole = _groupAmount(match.group(2)!);
  final fraction = match.group(3);
  return fraction == null ? whole : '$whole.$fraction';
}

String _groupAmount(String digits) =>
    digits.replaceAllMapped(_thousands, (_) => ',');

/// 按清算协议使用收款方基点费率计算费用，乘积遵循 u128 检查。
BigInt clearingFeeFen(BigInt amountFen, int rateBp, int minFeeFen) {
  if (amountFen <= BigInt.zero ||
      rateBp <= 0 ||
      rateBp > 0xffffffff ||
      minFeeFen <= 0) {
    throw ArgumentError('清算金额、费率或最低费无效');
  }
  final numerator = amountFen * BigInt.from(rateBp);
  if (numerator > _maxFen) throw ArgumentError('清算费用计算超出 u128');
  final rounded = (numerator + BigInt.from(5000)) ~/ BigInt.from(10000);
  final minimum = BigInt.from(minFeeFen);
  return rounded < minimum ? minimum : rounded;
}


typedef CitizenScaleEncoded = ({Uint8List scale});
typedef CitizenScaleVariant = ({String variant, List<Object> fields});

Map<String, Object> _scaleField(Object value) {
  final (kind, data) = switch (value) {
    Uint8List() => ('bytes', value),
    (scale: final Uint8List bytes) => ('encoded', bytes),
    BigInt() || int() => ('integer', value.toString()),
    bool() => ('bool', value),
    String() => ('text', value),
    (variant: final String name, fields: final List<Object> fields) =>
      ('variant', [name, fields.map(_scaleField).toList()]),
    List<Object>() => ('sequence', value.map(_scaleField).toList()),
    _ => throw ArgumentError('不支持的 SCALE 值'),
  };
  return {'kind': kind, 'value': data};
}

/// 不含业务字段的 SCALE 原语，交易和存储共享同一实现。
abstract final class CitizenScale {
  static Uint8List twox128(String value) => _chainCodec({'op': 'twox128', 'value': value});
  static Uint8List blake2b128(List<int> value) => _chainCodec({'op': 'blake2b128', 'value': value});
  static Uint8List blake2b256(List<int> value) => _chainCodec({'op': 'blake2b256', 'value': value});

  static Uint8List compact(Object value) {
    if (value is! int && value is! BigInt) throw ArgumentError('需要 SCALE 整数');
    return _chainCodec({'op': 'compact', 'value': value.toString()});
  }

  static (int, int) readCompact(Uint8List input, int offset) {
    if (offset < 0 || offset >= input.length) throw const FormatException('Compact 缺少输入');
    final end = offset + 17 < input.length ? offset + 17 : input.length;
    try {
      final value = jsonDecode(utf8.decode(_chainCodec({
        'op': 'read_compact', 'value': Uint8List.sublistView(input, offset, end),
      }))) as List;
      final number = BigInt.parse(value.first as String);
      if (!number.isValidInt) throw const FormatException('Compact 超出整数范围');
      return (number.toInt(), value.last as int);
    } on CitizenSdkException {
      throw const FormatException('Compact SCALE 无效');
    }
  }

  static Uint8List unsigned(BigInt value, int width) {
    if (width <= 0 || width > 16 || value.isNegative || value.bitLength > width * 8) {
      throw ArgumentError('SCALE 无符号整数超出范围');
    }
    return Uint8List.fromList(List.generate(width, (i) => (value >> (8 * i)).toUnsigned(8).toInt()));
  }

  static BigInt readUnsigned(Uint8List input, int offset, int width) {
    if (offset < 0 || width <= 0 || width > 16 || width > input.length - offset) {
      throw const FormatException('SCALE 无符号整数长度无效');
    }
    var value = BigInt.zero;
    for (var i = width - 1; i >= 0; i--) {
      value = (value << 8) | BigInt.from(input[offset + i]);
    }
    return value;
  }

  static Uint8List storagePrefix(String pallet, String entry) =>
      Uint8List.fromList([...twox128(pallet), ...twox128(entry)]);
}


/// 宿主按业务顺序交付字段；字节和固定宽度规则归 SDK。
final class CitizenScaleWriter {
  final _bytes = BytesBuilder(copy: false);
  void write(List<int> bytes) => _bytes.add(bytes);
  void pushByte(int value) {
    if (value < 0 || value > 255) throw ArgumentError('SCALE 字节超出范围');
    _bytes.addByte(value);
  }
  Uint8List toBytes() => _bytes.toBytes();
  CitizenScaleEncoded get fields => (scale: toBytes());
}

typedef CitizenCallBuilder = Future<Uint8List> Function(String pallet, String method, Object fields);
