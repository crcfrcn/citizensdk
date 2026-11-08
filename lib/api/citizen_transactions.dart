part of '../citizen_sdk.dart';

extension Transactions on CitizenSdk {
  Future<CitizenPreparedTransaction> prepareTransaction(
    Uint8List sourceAccountId,
    Uint8List callData,
  ) {
    if (sourceAccountId.length != 32) throw _failure(1);
    final expected = Uint8List.fromList(sourceAccountId);
    return _request(
      (m, out) => _api.citizensdk_prepare_transaction(
        _handle,
        m.account(citizenAccountIdFromBytes(expected)),
        m.view(callData, 1024 * 1024),
        out,
      ),
      (m, r) {
        final p = m.struct<c.citizensdk_prepared_transaction_info>(
          sizeOf<c.citizensdk_prepared_transaction_info>(),
        );
        _status(_api.citizensdk_result_get_prepared_transaction(r, p));
        final v = p.ref;
        final id = _hex(v.preparation_id, 16);
        try {
          final source = _array(v.source_account_id.bytes, 32);
          if (!_bytesEqual(source, expected) ||
              v.prepared_transaction == 0 ||
              _preparedTransactions.containsKey(id)) {
            throw _failure(9);
          }
          final value = CitizenPreparedTransaction(
            preparationId: id,
            sourceAccountId: source,
            callDataHash: _array(v.call_data_hash, 32),
            bestBlock: _block(v.best_block),
            runtimeSpecNumber: v.runtime_spec_number,
            transactionFormatNumber: v.transaction_format_number,
            nonce: _unsigned(v.nonce),
          );
          _preparedTransactions[id] = v.prepared_transaction;
          return value;
        } on Object {
          if (v.prepared_transaction != 0) {
            _api.citizensdk_prepared_transaction_release(
              _handle,
              v.prepared_transaction,
            );
          }
          rethrow;
        }
      },
    );
  }

  Future<void> cancelPreparedTransaction(String preparationId) async {
    _requireOpen();
    final token = _preparedTransactions[preparationId];
    if (token == null) throw _failure(7);
    _status(_api.citizensdk_prepared_transaction_release(_handle, token));
    _preparedTransactions.remove(preparationId);
  }

  Future<CitizenTransactionExecution> executePreparedTransaction(
    String preparationId,
  ) {
    final token = _preparedTransactions[preparationId];
    if (token == null) throw _failure(7);
    final operation = _operation(
      (m, out) =>
          _api.citizensdk_execute_prepared_transaction(_handle, token, out),
      (m, result) {
        final value = _readTransaction(m, result);
        if (value.executionId != preparationId) throw _failure(9);
        return value;
      },
    );
    _preparedTransactions.remove(preparationId);
    return operation.result;
  }

  Future<CitizenTransactionExecutionCompleted>
  consumePreparedTransactionQrResponse(String executionId, String response) =>
      _request(
        (m, out) => _api.citizensdk_transaction_execution_consume_qr_response(
          _handle,
          m.executionId(executionId),
          m.view(response, 2331),
          out,
        ),
        (m, r) {
          final value = _readTransaction(m, r);
          if (value is! CitizenTransactionExecutionCompleted ||
              value.executionId != executionId) {
            throw _failure(9);
          }
          return value;
        },
      );
  Future<void> cancelPreparedTransactionExecution(String executionId) async {
    _requireOpen();
    _withMemory(
      (m) => _status(
        _api.citizensdk_transaction_execution_cancel(
          _handle,
          m.executionId(executionId),
        ),
      ),
    );
  }

  /// 查询与本次 SDK 准备绑定的持久记录，核对来源账户及调用摘要。
  Future<CitizenTransactionHistoryRecord?> getPreparedTransactionRecord(
    CitizenPreparedTransaction prepared,
  ) => _findPreparedTransactionRecord(prepared, getTransactionHistory);

  /// 先订阅再读取已有状态，后续回读 SDK 原历史。终态从同一持久记录交付。
  Stream<CitizenTransactionHistoryRecord> watchPreparedTransaction(
    CitizenPreparedTransaction prepared,
  ) => watchCitizenPreparedTransaction(
    prepared: prepared,
    events: events,
    getHistory: getTransactionHistory,
  );

  Future<CitizenTransactionHistoryPage> getTransactionHistory({
    String? beforeExecutionId,
    int limit = 100,
  }) => _request(
    (m, out) => _api.citizensdk_get_transaction_history(
      _handle,
      beforeExecutionId == null ? nullptr : m.executionId(beforeExecutionId),
      _u32(limit),
      out,
    ),
    _readHistory,
  );
  Future<CitizenTransactionHistoryPage> syncTransactionHistory() => _request(
    (m, out) => _api.citizensdk_sync_transaction_history(_handle, out),
    _readHistory,
  );
}

/// 热签已经交付终态。冷签的页面交互由调用者提供，执行资源在取消或异常时统一回收。
Future<CitizenTransactionExecutionCompleted?> completeCitizenTransaction(
  CitizenTransactionExecution started, {
  required Future<String?> Function(CitizenTransactionExternalSigningPending)
  requestResponse,
  required Future<CitizenTransactionExecutionCompleted> Function(String, String)
  consumeResponse,
  required Future<void> Function(String) cancelExecution,
}) async {
  if (started is CitizenTransactionExecutionCompleted) return started;
  final pending = started as CitizenTransactionExternalSigningPending;
  Future<void> release() async {
    try {
      await cancelExecution(pending.executionId);
    } on CitizenSdkException catch (error) {
      // 已消费或 SDK 关闭时，原会话已经释放。
      if (error.code != CitizenSdkErrorCode.invalidHandle &&
          error.code != CitizenSdkErrorCode.invalidState) {
        rethrow;
      }
    }
  }

  try {
    final response = await requestResponse(pending);
    if (response != null) {
      return await consumeResponse(pending.executionId, response);
    }
  } catch (error, stack) {
    try {
      await release();
    } catch (_) {
      // 回收失败不能覆盖扫码或消费的原始错误。
    }
    Error.throwWithStackTrace(error, stack);
  }
  await release();
  return null;
}

typedef CitizenHistoryReader = Future<CitizenTransactionHistoryPage> Function({
  String? beforeExecutionId,
  int limit,
});

Future<CitizenTransactionHistoryRecord?> _findPreparedTransactionRecord(
  CitizenPreparedTransaction prepared,
  CitizenHistoryReader read,
) async {
  final account = citizenAccountIdFromBytes(prepared.sourceAccountId);
  final callHash = _payloadHex(prepared.callDataHash);
  final cursors = <String>{};
  String? cursor;
  do {
    final page = await read(beforeExecutionId: cursor, limit: 100);
    for (final record in page.records) {
      if (record.executionId != prepared.preparationId) continue;
      if (record.sourceAccountId != account ||
          record.callDataHash != callHash) {
        throw _failure(9, '本次准备与历史记录的账户或调用摘要不一致');
      }
      return record;
    }
    cursor = page.nextBeforeExecutionId;
    if (cursor != null && !cursors.add(cursor)) {
      throw _failure(9, '交易历史分页游标重复');
    }
  } while (cursor != null);
  return null;
}

/// 原 history 失效通知加一次初始读取。只向上游交付同一准备的实际状态变化。
Stream<CitizenTransactionHistoryRecord> watchCitizenPreparedTransaction({
  required CitizenPreparedTransaction prepared,
  required Stream<CitizenSdkEvent> events,
  required CitizenHistoryReader getHistory,
}) {
  StreamSubscription<CitizenSdkEvent>? subscription;
  late final StreamController<CitizenTransactionHistoryRecord> output;
  var reading = false;
  var requested = false;
  CitizenTransactionHistoryRecord? previous;
  Future<void> read() async {
    if (output.isClosed) return;
    requested = true;
    if (reading) return;
    reading = true;
    try {
      while (requested && !output.isClosed && output.hasListener) {
        requested = false;
        final record = await _findPreparedTransactionRecord(
          prepared,
          getHistory,
        );
        if (output.isClosed || !output.hasListener) return;
        if (record == null ||
            (record.status == previous?.status &&
                record.block?.hash == previous?.block?.hash &&
                record.updatedAtMillis == previous?.updatedAtMillis)) {
          continue;
        }
        previous = record;
        output.add(record);
        switch (record.status) {
          case CitizenTransactionHistoryStatus.poolRejected:
          case CitizenTransactionHistoryStatus.finalizedSuccess:
          case CitizenTransactionHistoryStatus.finalizedFailed:
            unawaited(output.close());
            return;
          case CitizenTransactionHistoryStatus.pending:
          case CitizenTransactionHistoryStatus.inBlock:
            break;
        }
      }
    } catch (error, stack) {
      if (!output.isClosed && output.hasListener) output.addError(error, stack);
    } finally {
      reading = false;
    }
  }

  output = StreamController<CitizenTransactionHistoryRecord>(
    onListen: () {
      subscription = events.listen(
        (event) {
          if (event is CitizenSdkHistoryChanged) unawaited(read());
        },
        onError: output.addError,
        onDone: () => unawaited(output.close()),
      );
      unawaited(read());
    },
    onCancel: () => subscription?.cancel(),
  );
  return output.stream;
}

CitizenTransactionExecution _readTransaction(_Memory m, int result) {
  final p = m.struct<c.citizensdk_transaction_execution_info>(
        sizeOf<c.citizensdk_transaction_execution_info>(),
      ),
      session = m.alloc<Uint8>(128),
      request = m.alloc<Uint8>(2331),
      reason = m.alloc<Uint8>(4096),
      sn = m.alloc<Uint64>(8),
      rn = m.alloc<Uint64>(8),
      en = m.alloc<Uint64>(8);
  _status(
    _api.citizensdk_result_get_transaction_execution(
      result,
      p,
      session,
      128,
      sn,
      request,
      2331,
      rn,
      reason,
      4096,
      en,
    ),
  );
  final v = p.ref;
  if (sn.value < 0 ||
      sn.value > 128 ||
      rn.value < 0 ||
      rn.value > 2331 ||
      en.value < 0 ||
      en.value > 4096) {
    throw _failure(9);
  }
  final id = _hex(v.execution_id, 16),
      source = _array(v.source_account_id.bytes, 32),
      hash = _array(v.call_data_hash, 32);
  if (v.status == 1) {
    final expiry = _unsigned(v.expires_at) * BigInt.from(1000);
    if (expiry > BigInt.from(8640000000000000)) throw _failure(9);
    return CitizenTransactionExternalSigningPending(
      executionId: id,
      sourceAccountId: source,
      callDataHash: hash,
      qrRequest: utf8.decode(request.asTypedList(rn.value)),
      expiresAt: DateTime.fromMillisecondsSinceEpoch(
        expiry.toInt(),
        isUtc: true,
      ),
    );
  }
  if (v.status < 2 || v.status > 4) throw _failure(9);
  CitizenExecution? execution;
  if (v.status == 2 || v.status == 3) {
    if (!_boolean(v.has_block) || !_boolean(v.has_extrinsic_index)) {
      throw _failure(9);
    }
    execution = CitizenExecution(
      status: v.status == 2
          ? CitizenExecutionStatus.success
          : CitizenExecutionStatus.failed,
      block: _block(v.block),
      extrinsicIndex: v.extrinsic_index,
      dispatchVariant: _boolean(v.has_dispatch_failure)
          ? v.dispatch_variant
          : null,
      palletIndex: _boolean(v.has_module_failure) ? v.pallet_index : null,
      errorIndex: _boolean(v.has_module_failure) ? v.error_index : null,
    );
  }
  return CitizenTransactionExecutionCompleted(
    executionId: id,
    sourceAccountId: source,
    callDataHash: hash,
    transactionHash: _array(v.transaction_hash, 32),
    resolution: CitizenTransactionResolution.values[v.status - 2],
    execution: execution,
    poolRejectionReason: en.value == 0
        ? null
        : utf8.decode(reason.asTypedList(en.value)),
    replacementHash: _boolean(v.has_replacement_hash)
        ? _array(v.replacement_hash, 32)
        : null,
  );
}

CitizenExecution _execution(c.citizensdk_execution_info v) {
  if (v.status < 1 ||
      v.status > 2 ||
      !_boolean(v.has_block) ||
      !_boolean(v.has_extrinsic_index)) {
    throw _failure(9);
  }
  return CitizenExecution(
    status: _enum(CitizenExecutionStatus.values, v.status, 1),
    block: _block(v.block),
    extrinsicIndex: v.extrinsic_index,
    dispatchVariant: v.status == 2 ? v.reason_or_dispatch_variant : null,
    palletIndex: _boolean(v.has_module) ? v.pallet_index : null,
    errorIndex: _boolean(v.has_module) ? v.error_index : null,
  );
}

CitizenTransactionHistoryPage _readHistory(_Memory m, int result) {
  final p = m.struct<c.citizensdk_transaction_history_page_info>(
    sizeOf<c.citizensdk_transaction_history_page_info>(),
  );
  _status(_api.citizensdk_result_get_transaction_history_page(result, p));
  if (p.ref.record_count > 100) throw _failure(9);
  final records = List<CitizenTransactionHistoryRecord>.generate(
    p.ref.record_count,
    (i) {
      final q = m.struct<c.citizensdk_transaction_history_record_info>(
            sizeOf<c.citizensdk_transaction_history_record_info>(),
          ),
          reason = m.alloc<Uint8>(4096),
          count = m.alloc<Uint64>(8);
      _status(
        _api.citizensdk_result_get_transaction_history_record(
          result,
          i,
          q,
          reason,
          4096,
          count,
        ),
      );
      if (count.value < 0 || count.value > 4096) throw _failure(9);
      final v = q.ref;
      return CitizenTransactionHistoryRecord(
        executionId: _hex(v.execution_id.bytes, 16),
        sourceAccountId: _accountIdText(v.source_account_id.bytes),
        callDataHash: _hex(v.call_data_hash, 32),
        transactionHash: _hex(v.transaction_hash, 32),
        status: _enum(CitizenTransactionHistoryStatus.values, v.status, 1),
        block: _boolean(v.has_block) ? _block(v.block) : null,
        execution: _boolean(v.has_execution) ? _execution(v.execution) : null,
        replacementHash: _boolean(v.has_replacement_hash)
            ? _hex(v.replacement_hash, 32)
            : null,
        createdAtMillis: _unsigned(v.created_at_millis),
        updatedAtMillis: _unsigned(v.updated_at_millis),
        poolRejectionReason: count.value == 0
            ? null
            : utf8.decode(reason.asTypedList(count.value)),
      );
    },
  );
  return CitizenTransactionHistoryPage(
    revision: _unsigned(p.ref.revision),
    records: records,
    nextBeforeExecutionId: _boolean(p.ref.has_next_before_execution_id)
        ? _hex(p.ref.next_before_execution_id.bytes, 16)
        : null,
  );
}

bool _bytesEqual(Uint8List left, Uint8List right) {
  if (left.length != right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) {
    difference |= left[i] ^ right[i];
  }
  return difference == 0;
}

/// 将整枚代币的金额按给定精度精确换算为最小单位。
BigInt scaleTokenUnits(BigInt amount, int decimals) {
  if (amount.isNegative) throw ArgumentError('代币金额不能为负');
  RangeError.checkValueInInterval(decimals, 0, 255, 'decimals');
  return amount * BigInt.from(10).pow(decimals);
}

final _evmAddress = RegExp(r'^0x[0-9a-f]{40}$');
final _evmWord = RegExp(r'^0x[0-9a-f]{64}$');
final _evmQuantity = RegExp(r'^0x(?:0|[1-9a-f][0-9a-f]*)$');
final _evmAddressTopic = RegExp(r'^0x0{24}[0-9a-f]{40}$');
final _maxEvmQuantity = BigInt.from(9007199254740991);

/// 编码 ERC-20 transfer 的选择器与两个 ABI 字，随后原样附加调用方字节。
String encodeErc20Transfer(
  String recipient,
  BigInt amount, {
  Uint8List? suffix,
}) {
  final address = recipient.trim().toLowerCase();
  if (!_evmAddress.hasMatch(address)) {
    throw ArgumentError('收款地址不是合法 EVM 地址');
  }
  if (amount.isNegative || amount.bitLength > 256) {
    throw ArgumentError('金额超出 uint256 范围');
  }
  final toWord = address.substring(2).padLeft(64, '0');
  final amountWord = amount.toRadixString(16).padLeft(64, '0');
  final extra = suffix
      ?.map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '0xa9059cbb$toWord$amountWord${extra ?? ''}';
}

/// ERC-20 回执的已核验链上事实，时间均为 Unix 毫秒。
typedef Erc20TransferReceipt = ({
  String sender,
  String blockHash,
  int blockNumber,
  int blockAt,
  int logIndex,
  int checkedAt,
});

/// 单轮核验同一 EVM 网络的交易、最终区块和唯一匹配的 Transfer 日志。
/// 调用方交付 RPC、可选尾部字节和时间下限。成功一轮共六次请求。
Future<Erc20TransferReceipt> verifyErc20Transfer(
  Future<Object?> Function(String, List<Object?>) rpc, {
  required int chainId,
  required String txid,
  required String token,
  required String recipient,
  required BigInt amount,
  String? sender,
  Uint8List? suffix,
  int? minBlockAt,
  int? now,
}) async {
  bool validSender(String value) =>
      _evmAddress.hasMatch(value) && value != '0x${'0' * 40}';

  if (!_evmWord.hasMatch(txid) ||
      !_evmAddress.hasMatch(token) ||
      !_evmAddress.hasMatch(recipient) ||
      sender != null && !validSender(sender)) {
    throw const FormatException('EVM 交易定位无效');
  }
  final input = encodeErc20Transfer(recipient, amount, suffix: suffix);

  int quantity(Object? value) {
    if (value is! String || !_evmQuantity.hasMatch(value)) {
      throw const FormatException('EVM 数量无效');
    }
    final number = BigInt.parse(value.substring(2), radix: 16);
    if (number > _maxEvmQuantity) {
      throw const FormatException('EVM 数量溢出');
    }
    return number.toInt();
  }

  Map<String, Object?> object(Object? value) {
    if (value is! Map<String, Object?>) {
      throw const FormatException('EVM 节点未提供完整回执');
    }
    return value;
  }

  String hash(Object? value) {
    if (value is! String || !_evmWord.hasMatch(value)) {
      throw const FormatException('EVM 哈希无效');
    }
    return value;
  }

  if (quantity(await rpc('eth_chainId', [])) != chainId) {
    throw const FormatException('EVM 网络不一致');
  }
  final receipt = object(await rpc('eth_getTransactionReceipt', [txid]));
  if (hash(receipt['transactionHash']) != txid ||
      quantity(receipt['status']) != 1) {
    throw const FormatException('EVM 交易尚未执行成功');
  }
  final transaction = object(await rpc('eth_getTransactionByHash', [txid]));
  final actualSender = transaction['from'];
  if (hash(transaction['hash']) != txid ||
      actualSender is! String ||
      !validSender(actualSender) ||
      sender != null && actualSender != sender ||
      transaction['to'] != token ||
      quantity(transaction['value']) != 0 ||
      transaction['input'] != input ||
      transaction['blockHash'] != receipt['blockHash'] ||
      transaction['blockNumber'] != receipt['blockNumber'] ||
      transaction['transactionIndex'] != receipt['transactionIndex']) {
    throw const FormatException('ERC-20 交易内容或区块定位不一致');
  }
  final number = quantity(receipt['blockNumber']),
      blockHash = hash(receipt['blockHash']),
      index = quantity(receipt['transactionIndex']);
  final tag = '0x${number.toRadixString(16)}';
  final block = object(await rpc('eth_getBlockByNumber', [tag, false]));
  final transactions = block['transactions'];
  if (hash(block['hash']) != blockHash ||
      quantity(block['number']) != number ||
      transactions is! List<Object?> ||
      transactions.length > 10000 ||
      index >= transactions.length ||
      transactions[index] != txid ||
      transactions.where((value) => value == txid).length != 1) {
    throw const FormatException('EVM 交易区块归属不一致');
  }
  final head = object(await rpc('eth_getBlockByNumber', ['finalized', false]));
  hash(head['hash']);
  if (quantity(head['number']) < number) {
    throw const FormatException('EVM 交易尚未最终确认');
  }
  final checked = now ?? DateTime.now().millisecondsSinceEpoch;
  final at = quantity(block['timestamp']) * 1000;
  if ((minBlockAt != null && at < minBlockAt) || at > checked) {
    throw const FormatException('EVM 区块时间超出核验范围');
  }
  final logs = receipt['logs'];
  if (logs is! List<Object?> || logs.length > 1024) {
    throw const FormatException('EVM 回执日志不完整');
  }
  const transfer =
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  String address(Object? topic) {
    if (topic is! String || !_evmAddressTopic.hasMatch(topic)) {
      throw const FormatException('EVM 日志地址无效');
    }
    return '0x${topic.substring(26)}';
  }

  int? logIndex;
  for (final raw in logs) {
    final log = object(raw);
    if (log['address'] != token) continue;
    final topics = log['topics'];
    if (topics is! List<Object?> || topics.isEmpty || topics.first != transfer) {
      continue;
    }
    if (topics.length != 3 || log['removed'] != false) {
      throw const FormatException('ERC-20 日志不可信');
    }
    if (address(topics[1]) != actualSender || address(topics[2]) != recipient) {
      continue;
    }
    final data = log['data'];
    if (data is! String ||
        !_evmWord.hasMatch(data) ||
        BigInt.parse(data.substring(2), radix: 16) != amount) {
      throw const FormatException('ERC-20 日志金额不一致');
    }
    if (log['transactionHash'] != txid ||
        log['blockHash'] != blockHash ||
        quantity(log['blockNumber']) != number ||
        quantity(log['transactionIndex']) != index ||
        logIndex != null) {
      throw const FormatException('ERC-20 日志不唯一或定位不一致');
    }
    logIndex = quantity(log['logIndex']);
  }
  if (logIndex == null) throw const FormatException('缺少匹配的 ERC-20 日志');
  final again = object(await rpc('eth_getBlockByNumber', [tag, false]));
  if (hash(again['hash']) != blockHash || quantity(again['number']) != number) {
    throw const FormatException('EVM 区块发生变化');
  }
  return (
    sender: actualSender,
    blockHash: blockHash,
    blockNumber: number,
    blockAt: at,
    logIndex: logIndex,
    checkedAt: checked,
  );
}
