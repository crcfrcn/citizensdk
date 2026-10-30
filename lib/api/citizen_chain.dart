part of '../citizen_sdk.dart';

// 每个公开方法直接接纳同一Core函数，结果直接构造公开模型。
extension Chain on CitizenSdk {
  Future<CitizenCapabilitySnapshot> getCapabilities() async {
    _requireOpen();
    return _withMemory((m) => _readCapabilities(this, m));
  }

  Future<String> getGenesisHash() async {
    _requireOpen();
    return _withMemory((m) {
      final value = m.alloc<Uint8>(32);
      _status(_api.citizensdk_get_genesis_hash(_handle, value));
      return citizenAccountIdFromBytes(value.asTypedList(32));
    });
  }

  Future<CitizenBlockRef> getFinalizedHead() => _request(
    (m, out) => _api.citizensdk_get_finalized_head(_handle, out),
    _readBlock,
  );
  Future<CitizenBlockRef> getBestHead() => _request(
    (m, out) => _api.citizensdk_get_best_head(_handle, out),
    _readBlock,
  );
  Future<CitizenBlockRef> getFinalizedBlockAt(BigInt number) => _request(
    (m, out) =>
        _api.citizensdk_get_finalized_block_at(_handle, _u64(number), out),
    _readBlock,
  );
  Future<CitizenBlockRef> resolveFinalizedBlock(String hash, BigInt number) =>
      _request(
        (m, out) => _api.citizensdk_resolve_finalized_block(
          _handle,
          m.bytes(_unhex(hash, 32)),
          _u64(number),
          out,
        ),
        _readBlock,
      );
  Future<CitizenChainSyncStatus> getSyncStatus() => _request(
    (m, out) => _api.citizensdk_get_sync_status(_handle, out),
    (m, r) {
      final p = m.struct<c.citizensdk_chain_sync_status_info>(
        sizeOf<c.citizensdk_chain_sync_status_info>(),
      );
      _status(_api.citizensdk_result_get_sync_status(r, p));
      final v = p.ref;
      return CitizenChainSyncStatus(
        peerCount: _unsigned(v.peer_count),
        isSyncing: _boolean(v.is_syncing),
        isUsable: _boolean(v.is_usable),
        best: _block(v.best),
        finalized: _block(v.finalized),
      );
    },
    diagnostic: 'getSyncStatus',
  );
  Future<CitizenBlockHeader> getBlockHeader(CitizenBlockRef block) => _request(
    (m, out) =>
        _api.citizensdk_get_block_header_at(_handle, m.block(block), out),
    (m, r) {
      final p = m.struct<c.citizensdk_block_header_info>(
        sizeOf<c.citizensdk_block_header_info>(),
      );
      final digest = m.borrow(
        (b, cap, n) => _api.citizensdk_result_get_block_header(r, p, b, cap, n),
        1024 * 1024,
      );
      final v = p.ref;
      return CitizenBlockHeader(
        block: _block(v.block),
        parentHash: _hex(v.parent_hash, 32),
        stateRoot: _hex(v.state_root, 32),
        extrinsicsRoot: _hex(v.extrinsics_root, 32),
        digest: digest,
      );
    },
  );
  Future<CitizenBlockBody> getBlockBody(CitizenBlockRef block) => _request(
    (m, out) => _api.citizensdk_get_block_body_at(_handle, m.block(block), out),
    (m, r) {
      final p = m.struct<c.citizensdk_block_body_info>(
        sizeOf<c.citizensdk_block_body_info>(),
      );
      _status(_api.citizensdk_result_get_block_body_info(r, p));
      if (p.ref.extrinsic_count > 16384 || p.ref.total_bytes > 64 * 1024 * 1024)
        throw _failure(9);
      var remaining = p.ref.total_bytes;
      final values = List<Uint8List>.generate(p.ref.extrinsic_count, (i) {
        final value = m.borrow(
          (b, cap, n) =>
              _api.citizensdk_result_copy_block_body_extrinsic(r, i, b, cap, n),
          remaining,
        );
        remaining -= value.length;
        return value;
      });
      if (remaining != 0) throw _failure(9);
      return CitizenBlockBody(block: _block(p.ref.block), extrinsics: values);
    },
  );
  Future<CitizenRuntimeContext> getRuntimeContext(CitizenBlockRef block) =>
      _request(
        (m, out) => _api.citizensdk_get_runtime_context_at(
          _handle,
          m.block(block),
          out,
        ),
        (m, r) {
          final p = m.struct<c.citizensdk_runtime_context_info>(
            sizeOf<c.citizensdk_runtime_context_info>(),
          );
          final metadata = m.borrow(
            (b, cap, n) =>
                _api.citizensdk_result_get_runtime_context(r, p, b, cap, n),
          );
          return CitizenRuntimeContext(
            block: _block(p.ref.block),
            specVersion: p.ref.spec_version,
            transactionVersion: p.ref.transaction_version,
            metadata: metadata,
          );
        },
      );
  Future<Uint8List?> getStorage(CitizenBlockRef block, Uint8List key) =>
      _request(
        (m, out) => _api.citizensdk_get_storage_at(
          _handle,
          m.block(block),
          m.view(key, 4096),
          out,
        ),
        _readStorage,
      );
  Future<List<Uint8List?>> getStorageBatch(
    CitizenBlockRef block,
    List<Uint8List> keys,
  ) {
    final count = keys.length;
    return _request(
      (m, out) {
        if (count > 1024) throw _failure(1);
        final values = m.alloc<c.citizensdk_bytes_view>(
          count * sizeOf<c.citizensdk_bytes_view>(),
        );
        for (var i = 0; i < count; i++) {
          values[i] = m.view(keys[i], 4096);
        }
        return _api.citizensdk_get_storage_batch_at(
          _handle,
          m.block(block),
          values,
          count,
          out,
        );
      },
      (m, r) {
        final values = _readBatch(m, r);
        if (values.length != count) throw _failure(9);
        return values;
      },
    );
  }

  Future<List<Uint8List>> getStorageKeysPaged(
    CitizenBlockRef block,
    Uint8List prefix, {
    Uint8List? startKey,
    int limit = 1000,
  }) => _request(
    (m, out) => _api.citizensdk_get_storage_keys_paged(
      _handle,
      m.block(block),
      m.view(prefix, 4096),
      startKey == null ? 0 : 1,
      m.view(startKey ?? Uint8List(0), 4096),
      _u32(limit),
      out,
    ),
    (m, r) => List.unmodifiable(
      _readBatch(m, r).map((v) => v ?? (throw _failure(9))),
    ),
  );
  Future<Uint8List> callRuntimeApi(
    CitizenBlockRef block,
    String method,
    Uint8List arguments,
  ) => _request(
    (m, out) => _api.citizensdk_call_runtime_api(
      _handle,
      m.block(block),
      m.view(method, 128),
      m.view(arguments, 1024 * 1024),
      out,
    ),
    (m, r) => _readStorage(m, r) ?? (throw _failure(9)),
  );
  Future<Uint8List?> getSystemEvents(CitizenBlockRef block) => _request(
    (m, out) =>
        _api.citizensdk_get_system_events_at(_handle, m.block(block), out),
    _readStorage,
  );
  Future<CitizenChainState> exportState() =>
      _request((m, out) => _api.citizensdk_export_state(_handle, out), (m, r) {
        final p = m.struct<c.citizensdk_exported_state_info>(
          sizeOf<c.citizensdk_exported_state_info>(),
        );
        final bytes = m.borrow(
          (b, cap, n) =>
              _api.citizensdk_result_get_exported_state(r, p, b, cap, n),
          256 * 1024,
        );
        return CitizenChainState(
          formatVersion: p.ref.format_version,
          finalized: _block(p.ref.finalized),
          database: bytes,
        );
      });
  Future<void> importState(CitizenChainState state) => _request(
    (m, out) => _api.citizensdk_import_state(
      _handle,
      m.block(state.finalized),
      _u32(state.formatVersion),
      m.view(state.database, 256 * 1024),
      out,
    ),
    (m, r) {
      _readBlock(m, r);
    },
  );
  Future<CitizenAccountBalance> getAccountBalance(String accountId) => _request(
    (m, out) => _api.citizensdk_get_finalized_account_balance(
      _handle,
      m.account(accountId),
      out,
    ),
    (m, r) {
      final p = m.struct<c.citizensdk_account_balance_info>(
        sizeOf<c.citizensdk_account_balance_info>(),
      );
      _status(_api.citizensdk_result_get_account_balance(r, p));
      return _balance(p.ref);
    },
  );
  Future<List<CitizenAccountBalance>> getAccountBalances(
    List<String> accountIds,
  ) {
    final ids = List<String>.of(accountIds, growable: false);
    return _request(
      (m, out) => _api.citizensdk_get_finalized_account_balances(
        _handle,
        m.accounts(ids, 1990),
        ids.length,
        out,
      ),
      (m, r) {
        final count = m.alloc<Uint32>(4);
        _status(_api.citizensdk_result_get_account_balance_count(r, count));
        if (count.value != ids.length) throw _failure(9);
        return List.unmodifiable(
          List.generate(count.value, (i) {
            final p = m.struct<c.citizensdk_account_balance_info>(
              sizeOf<c.citizensdk_account_balance_info>(),
            );
            _status(_api.citizensdk_result_get_account_balance_at(r, i, p));
            final value = _balance(p.ref);
            if (value.accountId != ids[i]) throw _failure(9);
            return value;
          }),
        );
      },
    );
  }

  Future<CitizenAccountNonce> getAccountNonce(String accountId) => _request(
    (m, out) =>
        _api.citizensdk_get_account_nonce(_handle, m.account(accountId), out),
    (m, r) {
      final p = m.struct<c.citizensdk_account_nonce_info>(
        sizeOf<c.citizensdk_account_nonce_info>(),
      );
      _status(_api.citizensdk_result_get_account_nonce(r, p));
      return CitizenAccountNonce(
        accountId: _hex(p.ref.account_id.bytes, 32),
        bestBlock: _block(p.ref.best_block),
        nonce: _unsigned(p.ref.nonce),
      );
    },
  );
  Future<CitizenFeeSnapshot> getFeeSnapshot() => _request(
    (m, out) => _api.citizensdk_get_best_fee_snapshot(_handle, out),
    (m, r) {
      final p = m.struct<c.citizensdk_fee_snapshot_info>(
        sizeOf<c.citizensdk_fee_snapshot_info>(),
      );
      _status(_api.citizensdk_result_get_fee_snapshot(r, p));
      return CitizenFeeSnapshot(
        bestBlock: _block(p.ref.best_block),
        feeRateParts: p.ref.fee_rate_parts,
        minimumFeeFen: _u128(p.ref.minimum_fee_fen),
        existentialDepositFen: _u128(p.ref.existential_deposit_fen),
      );
    },
  );
}

CitizenBlockRef _block(c.citizensdk_block_ref value) => CitizenBlockRef(
  hash: _hex(value.hash, 32),
  number: _unsigned(value.number),
  finality: _enum(CitizenBlockFinality.values, value.finality, 1),
);
CitizenBlockRef _readBlock(_Memory m, int result) {
  final out = m.struct<c.citizensdk_block_ref>(
    sizeOf<c.citizensdk_block_ref>(),
  );
  _status(_api.citizensdk_result_get_block_ref(result, out));
  return _block(out.ref);
}

CitizenAccountBalance _balance(c.citizensdk_account_balance_info value) =>
    CitizenAccountBalance(
      accountId: _hex(value.account_id.bytes, 32),
      block: _block(value.block),
      freeFen: _u128(value.free_fen),
      reservedFen: _u128(value.reserved_fen),
      totalFen: _u128(value.total_fen),
    );
Uint8List? _readStorage(_Memory m, int result) {
  final present = m.alloc<Uint8>(1);
  final bytes = m.copy(
    (b, cap, n) =>
        _api.citizensdk_result_copy_storage(result, present, b, cap, n),
  );
  if (!_boolean(present.value)) {
    if (bytes.isNotEmpty) throw _failure(9);
    return null;
  }
  return bytes.asUnmodifiableView();
}

List<Uint8List?> _readBatch(_Memory m, int result) {
  final count = m.alloc<Uint32>(4);
  _status(_api.citizensdk_result_get_storage_batch_count(result, count));
  if (count.value > 1024) throw _failure(9);
  return List.unmodifiable(
    List.generate(count.value, (i) {
      final present = m.alloc<Uint8>(1);
      final bytes = m.copy(
        (b, cap, n) => _api.citizensdk_result_copy_storage_batch_item(
          result,
          i,
          present,
          b,
          cap,
          n,
        ),
      );
      if (!_boolean(present.value)) {
        if (bytes.isNotEmpty) throw _failure(9);
        return null;
      }
      return bytes.asUnmodifiableView();
    }),
  );
}

CitizenCapabilitySnapshot _readCapabilities(CitizenSdk sdk, _Memory m) {
  final p = m.struct<c.citizensdk_capability_snapshot>(
    sizeOf<c.citizensdk_capability_snapshot>(),
  );
  _status(_api.citizensdk_get_capabilities(sdk._handle, p));
  if (p.ref.count != CitizenCapabilityName.values.length) throw _failure(9);
  return CitizenCapabilitySnapshot(
    revision: _unsigned(p.ref.revision),
    statuses: List.generate(p.ref.count, (i) {
      final v = p.ref.statuses[i];
      return CitizenCapabilityStatus(
        name: _enum(CitizenCapabilityName.values, v.name, 1),
        supported: _boolean(v.supported),
        available: _boolean(v.available),
        enabled: _boolean(v.enabled),
        ready: _boolean(v.ready),
        reason: _enum(CitizenCapabilityReason.values, v.reason),
      );
    }),
  );
}
