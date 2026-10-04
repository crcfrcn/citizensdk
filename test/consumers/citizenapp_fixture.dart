import 'dart:convert';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';

/// SDK测试所有者的合成转账夹具，不代表生产App保留编解码或业务规则。
final class CitizenAppTransferDraft {
  CitizenAppTransferDraft({
    required Uint8List destination,
    required this.amountFen,
    required this.remark,
  }) : destination = Uint8List.fromList(destination).asUnmodifiableView() {
    if (this.destination.length != 32) {
      throw ArgumentError.value(
        this.destination.length,
        'destination',
        'must contain 32 bytes',
      );
    }
    if (amountFen <= BigInt.zero || amountFen >= (BigInt.one << 128)) {
      throw ArgumentError.value(
        amountFen,
        'amountFen',
        'must fit positive u128',
      );
    }
    final remarkBytes = utf8.encode(remark);
    if (remarkBytes.length > 63) {
      throw ArgumentError.value(
        remarkBytes.length,
        'remark',
        'must contain at most 63 UTF-8 bytes in this fixture',
      );
    }
  }

  final Uint8List destination;
  final BigInt amountFen;
  final String remark;
}

/// 仅验证合成字段往返，不是生产链事件模型或App解码实现。
final class CitizenAppTransferEvent {
  CitizenAppTransferEvent({
    required Uint8List destination,
    required this.amountFen,
    required this.remark,
  }) : destination = Uint8List.fromList(destination).asUnmodifiableView();

  final Uint8List destination;
  final BigInt amountFen;
  final String remark;
}

/// SDK测试夹具通过公开端口传入不同的不透明字节，不连接真实产品。
final class CitizenAppFixture {
  const CitizenAppFixture({
    required this.chain,
    required this.transactions,
    required this.history,
  });

  final CitizenChain chain;
  final CitizenTransactions transactions;
  final CitizenHistory history;

  Future<CitizenPreparedTransaction> prepareTransfer({
    required Uint8List sourceAccountId,
    required CitizenAppTransferDraft draft,
  }) => transactions.prepareTransaction(
    Uint8List.fromList(sourceAccountId),
    encodeTransferRuntimeCall(draft),
  );

  Future<Uint8List?> readTransferIndex({
    required CitizenBlockRef finalizedBlock,
    required Uint8List accountId,
  }) => chain.getStorage(finalizedBlock, transferStorageKey(accountId));

  Future<CitizenTransactionHistoryPage> readSdkExecutionFacts() =>
      history.getTransactionHistory();

  /// 测试专用合成RuntimeCall，不承诺真实链pallet/call布局或生产职责。
  static Uint8List encodeTransferRuntimeCall(CitizenAppTransferDraft draft) {
    final remark = utf8.encode(draft.remark);
    return Uint8List.fromList(<int>[
      41,
      0,
      ...draft.destination,
      ..._encodeUnsigned128(draft.amountFen),
      remark.length << 2,
      ...remark,
    ]);
  }

  /// 合成storage键仅验证公开读取参数和块锚点接线。
  static Uint8List transferStorageKey(Uint8List accountId) {
    if (accountId.length != 32) {
      throw ArgumentError.value(
        accountId.length,
        'accountId',
        'must be 32 bytes',
      );
    }
    return Uint8List.fromList(<int>[
      ...utf8.encode('CitizenApp/transfer-index/'),
      ...accountId,
    ]);
  }

  /// 合成事件解码只验证测试字段往返，不作为生产App保留解码逻辑的依据。
  static CitizenAppTransferEvent decodeTransferEvent(Uint8List bytes) {
    const fixedLength = 32 + 16 + 1;
    if (bytes.length < fixedLength) {
      throw const FormatException('transfer event is truncated');
    }
    final destination = Uint8List.sublistView(bytes, 0, 32);
    final amount = _decodeUnsigned128(bytes, 32);
    final compactLength = bytes[48];
    if ((compactLength & 3) != 0) {
      throw const FormatException(
        'fixture accepts only single-byte SCALE length',
      );
    }
    final remarkLength = compactLength >> 2;
    if (bytes.length != fixedLength + remarkLength) {
      throw const FormatException('transfer event length is inconsistent');
    }
    return CitizenAppTransferEvent(
      destination: destination,
      amountFen: amount,
      remark: utf8.decode(bytes.sublist(49)),
    );
  }
}

List<int> _encodeUnsigned128(BigInt value) {
  var remaining = value;
  return List<int>.generate(16, (_) {
    final byte = (remaining & BigInt.from(0xff)).toInt();
    remaining >>= 8;
    return byte;
  }, growable: false);
}

BigInt _decodeUnsigned128(Uint8List bytes, int offset) {
  var value = BigInt.zero;
  for (var index = 15; index >= 0; index -= 1) {
    value = (value << 8) | BigInt.from(bytes[offset + index]);
  }
  return value;
}
