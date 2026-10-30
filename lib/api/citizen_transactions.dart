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
              _preparedTransactions.containsKey(id))
            throw _failure(9);
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
          if (v.prepared_transaction != 0)
            _api.citizensdk_prepared_transaction_release(
              _handle,
              v.prepared_transaction,
            );
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
      _readTransaction,
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
          if (value is! CitizenTransactionExecutionCompleted) throw _failure(9);
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
      en.value > 4096)
    throw _failure(9);
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
    if (!_boolean(v.has_block) || !_boolean(v.has_extrinsic_index))
      throw _failure(9);
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
      !_boolean(v.has_extrinsic_index))
    throw _failure(9);
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
        sourceAccountId: _hex(v.source_account_id.bytes, 32),
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
