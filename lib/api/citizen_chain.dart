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
  Future<List<CitizenBlockRef>> getFinalizedBlockRange(
    BigInt start,
    BigInt end,
  ) => _request(
    (m, out) => _api.citizensdk_get_finalized_block_range(
      _handle,
      _u64(start),
      _u64(end),
      out,
    ),
    (m, result) {
      final count = m.alloc<Uint32>(4);
      _status(
        _api.citizensdk_result_get_block_range(result, 0, count, nullptr),
      );
      final expected = end - start + BigInt.one;
      if (BigInt.from(count.value) != expected) throw _failure(9);
      final block = m.struct<c.citizensdk_block_ref>(
        sizeOf<c.citizensdk_block_ref>(),
      );
      return List.unmodifiable(
        List.generate(count.value, (i) {
          _status(
            _api.citizensdk_result_get_block_range(result, i, count, block),
          );
          final value = _block(block.ref);
          if (value.finality != CitizenBlockFinality.finalized ||
              value.number != start + BigInt.from(i)) {
            throw _failure(9);
          }
          return value;
        }),
      );
    },
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

  /// 每个会话只有一个同步状态采样器；订阅者共享最近快照。
  Stream<CitizenChainSyncStatus> watchSyncStatus() => _sync.watch();

  Future<void> refreshSyncStatus() => _sync.refresh();

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
      if (p.ref.extrinsic_count > 16384 ||
          p.ref.total_bytes > 64 * 1024 * 1024) {
        throw _failure(9);
      }
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
  Future<CitizenEvmAccount> resolveEvmAddress(String address) =>
      resolveCitizenEvmAddress(
        address,
        getFinalizedHead,
        getRuntimeContext,
        getStorage,
      );

  Future<Uint8List> buildCall(
    String pallet,
    String method,
    Object args,
  ) async => (await getRuntimeContext(
    await getBestHead(),
  )).encodeCall(pallet, method, args);

  Future<Uint8List?> readStorage(
    CitizenBlockRef block,
    String pallet,
    String entry, [
    List<Object> keys = const [],
  ]) async {
    final runtime = await getRuntimeContext(block);
    return getStorage(block, runtime.storageKey(pallet, entry, keys));
  }

  Future<List<Uint8List?>> readStorageBatch(
    CitizenBlockRef block,
    String pallet,
    String entry,
    List<List<Object>> keys,
  ) async {
    if (keys.isEmpty) return const [];
    final runtime = await getRuntimeContext(block);
    return getStorageBatch(
      block,
      keys.map((key) => runtime.storageKey(pallet, entry, key)).toList(),
    );
  }

  Future<List<Uint8List>> readStorageKeys(
    CitizenBlockRef block,
    String pallet,
    String entry, {
    List<Object> keys = const [],
    Uint8List? startKey,
    required int limit,
  }) async {
    final runtime = await getRuntimeContext(block);
    return getStorageKeysPaged(
      block,
      runtime.storageKey(pallet, entry, keys),
      startKey: startKey,
      limit: limit,
    );
  }

  Future<int> getBlockTimestamp(CitizenBlockRef block) =>
      readCitizenBlockTimestamp(block, getStorage);

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

  /// 从 SDK 已验证块读取与解码 System.Events。
  Future<List<CitizenSystemEvent>> getFinalizedEvents(CitizenBlockRef block) =>
      readCitizenFinalizedEvents(
        block,
        readEvents: getSystemEvents,
        readRuntime: getRuntimeContext,
      );

  /// 发现指定账户在本块的转账和实扣。无相关交易时无需读取区块正文。
  Future<CitizenWalletBlockEvents> getWalletBlockEvents(
    CitizenBlockRef block,
    Iterable<String> accountIds,
  ) => readCitizenWalletEvents(
    block,
    accountIds,
    readEvents: getFinalizedEvents,
    readBody: getBlockBody,
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
  Future<CitizenAccountBalance> getAccountBalance(
    String accountId, {
    bool forceRefresh = true,
  }) async {
    _requireOpen();
    return balances.getAccountBalance(accountId, forceRefresh: forceRefresh);
  }

  Future<List<CitizenAccountBalance>> getAccountBalances(
    List<String> accountIds, {
    bool forceRefresh = true,
  }) async {
    _requireOpen();
    // 空批量仍核对原生模块与运行状态。
    if (accountIds.isEmpty) return _readAccountBalances(accountIds);
    return balances.getAccountBalances(accountIds, forceRefresh: forceRefresh);
  }

  Future<List<CitizenAccountBalance>> _readAccountBalances(
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
        accountId: _accountIdText(p.ref.account_id.bytes),
        bestBlock: _block(p.ref.best_block),
        nonce: _unsigned(p.ref.nonce),
      );
    },
  );

  /// 在同一份 best 块快照中估算指定金额的费用。省略金额时读取最低链上费。
  Future<CitizenFeeSnapshot> getFeeSnapshot({BigInt? amountFen}) => _request(
    (m, out) => _api.citizensdk_get_best_fee_snapshot(_handle, out),
    (m, r) {
      final p = m.struct<c.citizensdk_fee_snapshot_info>(
        sizeOf<c.citizensdk_fee_snapshot_info>(),
      );
      _status(_api.citizensdk_result_get_fee_snapshot(r, p));
      final fee = m.alloc<c.citizensdk_u128>(sizeOf<c.citizensdk_u128>());
      final minimum = m.alloc<c.citizensdk_u128>(sizeOf<c.citizensdk_u128>());
      _status(
        _api.citizensdk_result_estimate_fee(
          r,
          m.u128(amountFen ?? BigInt.zero),
          fee,
          minimum,
        ),
      );
      return CitizenFeeSnapshot(
        bestBlock: _block(p.ref.best_block),
        feeRateParts: p.ref.fee_rate_parts,
        minimumFeeFen: _u128(p.ref.minimum_fee_fen),
        existentialDepositFen: _u128(p.ref.existential_deposit_fen),
        voteFeeFen: _u128(p.ref.vote_fee_fen),
        feeFen: _u128(fee.ref),
        minimumSelfPayFen: _u128(minimum.ref),
      );
    },
  );
}

/// 两项读取必须属于同一已验证 finalized 块。
Future<List<CitizenSystemEvent>> readCitizenFinalizedEvents(
  CitizenBlockRef block, {
  required Future<Uint8List?> Function(CitizenBlockRef) readEvents,
  required Future<CitizenRuntimeContext> Function(CitizenBlockRef) readRuntime,
}) async {
  if (block.finality != CitizenBlockFinality.finalized) {
    throw StateError('事件读取需要 finalized 块');
  }
  final bytes = await readEvents(block);
  if (bytes == null) return const [];
  final runtime = await readRuntime(block);
  _requireEventBlock(block, runtime.block);
  return runtime.decodeSystemEvents(bytes);
}

void _requireEventBlock(CitizenBlockRef block, CitizenBlockRef evidence) {
  if (evidence.finality != CitizenBlockFinality.finalized ||
      block.hash != evidence.hash ||
      block.number != evidence.number) {
    throw StateError('事件证据与 finalized 块不一致');
  }
}

/// 钱包事件发现只交付已验证事实，记录、游标和业务呈现由调用者负责。
Future<CitizenWalletBlockEvents> readCitizenWalletEvents(
  CitizenBlockRef block,
  Iterable<String> accountIds, {
  required Future<List<CitizenSystemEvent>> Function(CitizenBlockRef)
  readEvents,
  required Future<CitizenBlockBody> Function(CitizenBlockRef) readBody,
}) async {
  if (block.finality != CitizenBlockFinality.finalized) {
    throw StateError('钱包事件读取需要 finalized 块');
  }
  final accounts = accountIds
      .map((id) => citizenAccountIdFromBytes(citizenAccountIdBytes(id)))
      .toSet();
  final events = accounts.isEmpty
      ? const <CitizenSystemEvent>[]
      : await readEvents(block);
  final outcomes = <int, CitizenExecutionStatus>{};
  final transfers =
      <int, (CitizenSystemEvent, String, String, BigInt, String?)>{};
  final unmatched = <(int?, String, String, BigInt), List<int>>{};
  final fees = <(CitizenSystemEvent, String, BigInt)>[];
  for (final event in events) {
    final index = event.extrinsicIndex;
    switch ((event.pallet, event.name)) {
      case ('System', 'ExtrinsicSuccess' || 'ExtrinsicFailed'):
        if (index == null || outcomes.containsKey(index)) {
          throw const FormatException('System 执行终态缺少索引或存在重复');
        }
        outcomes[index] = event.name == 'ExtrinsicSuccess'
            ? CitizenExecutionStatus.success
            : CitizenExecutionStatus.failed;
      case ('OnchainTransaction', 'FeePaid'):
        final payer = citizenAccountIdFromBytes(event.fieldBytes('account_id'));
        if (!accounts.contains(payer)) continue;
        final amount = event.fieldUnsigned('fee');
        if (amount == BigInt.zero) {
          throw const FormatException('FeePaid 金额须大于零');
        }
        fees.add((event, payer, amount));
      case ('Balances', 'Transfer'):
      case ('OnchainTransaction', 'TransferWithRemark'):
        final plain = event.pallet == 'Balances';
        final from = citizenAccountIdFromBytes(
          event.fieldBytes(plain ? 'from' : 'from_account_id'),
        );
        final to = citizenAccountIdFromBytes(
          event.fieldBytes(plain ? 'to' : 'beneficiary_account_id'),
        );
        if (!accounts.contains(from) && !accounts.contains(to)) continue;
        final amount = event.fieldUnsigned('amount');
        if (amount == BigInt.zero) {
          throw const FormatException('本金转移金额须大于零');
        }
        final key = (index, from, to, amount);
        if (plain) {
          transfers[event.eventIndex] = (event, from, to, amount, null);
          (unmatched[key] ??= []).add(event.eventIndex);
        } else {
          final matches = unmatched[key];
          if (matches == null || matches.isEmpty) {
            throw const FormatException('备注事件缺少同一执行的前序本金事件');
          }
          final eventIndex = matches.removeLast();
          final principal = transfers[eventIndex]!.$1;
          final remark = event.fieldBytes('remark');
          transfers[eventIndex] = (
            principal,
            from,
            to,
            amount,
            remark.isEmpty ? null : utf8.decode(remark, allowMalformed: true),
          );
        }
    }
  }

  CitizenExecutionStatus? status(CitizenSystemEvent event) {
    final index = event.extrinsicIndex;
    if (index == null) return null;
    return outcomes[index] ??
        (throw const FormatException('钱包事件缺少同索引的 System 执行结果'));
  }

  final confirmed = transfers.values
      .where((transfer) => status(transfer.$1) != CitizenExecutionStatus.failed)
      .toList();
  final indices = <int>{
    for (final (event, _, _, _, _) in confirmed) ?event.extrinsicIndex,
    for (final (event, _, _) in fees) ?event.extrinsicIndex,
  };
  final hashes = <int, String>{};
  if (indices.isNotEmpty) {
    final body = await readBody(block);
    _requireEventBlock(block, body.block);
    for (final index in indices) {
      hashes[index] = body.transactionHashAt(index);
    }
  }
  return CitizenWalletBlockEvents(
    block: block,
    transfers: [
      for (final (event, from, to, amount, remark) in confirmed)
        (
          fromAccountId: from,
          toAccountId: to,
          amountFen: amount,
          remark: remark,
          eventIndex: event.eventIndex,
          extrinsicIndex: event.extrinsicIndex,
          transactionHash: hashes[event.extrinsicIndex],
        ),
    ],
    fees: [
      for (final (event, payer, amount) in fees)
        (
          accountId: payer,
          feeFen: amount,
          eventIndex: event.eventIndex,
          extrinsicIndex: event.extrinsicIndex,
          transactionHash: hashes[event.extrinsicIndex],
          status: status(event),
        ),
    ],
  );
}

/// 统一 EVM 地址校验、精确 metadata 键和无映射规则。
Future<CitizenEvmAccount> resolveCitizenEvmAddress(
  String address,
  Future<CitizenBlockRef> Function() readHead,
  Future<CitizenRuntimeContext> Function(CitizenBlockRef) readRuntime,
  Future<Uint8List?> Function(CitizenBlockRef, Uint8List) readStorage,
) async {
  final Uint8List bytes;
  try {
    bytes = _chainCodec({'op': 'evm_address', 'address': address.trim()});
  } on CitizenSdkException catch (error) {
    if (error.code != CitizenSdkErrorCode.invalidArgument) rethrow;
    throw const FormatException('以太坊地址格式或大小写校验和无效');
  }
  final block = await readHead();
  if (block.finality != CitizenBlockFinality.finalized) {
    throw StateError('收款地址解析必须使用最终确认区块');
  }
  final runtime = await readRuntime(block);
  if (runtime.block.finality != block.finality ||
      runtime.block.hash != block.hash ||
      runtime.block.number != block.number) {
    throw StateError('收款地址元数据区块不一致');
  }
  final Uint8List key;
  try {
    key = _chainCodec({'op': 'evm_key', 'address': bytes}, runtime.metadata);
  } on CitizenSdkException catch (error) {
    if (error.code == CitizenSdkErrorCode.invalidArgument) {
      throw StateError('Runtime 以太坊账户映射存储格式不受支持');
    }
    throw const FormatException('以太坊账户映射 metadata 无效');
  }
  final mapped = await readStorage(block, key);
  if (mapped != null && mapped.length != 32) {
    throw const FormatException('链上以太坊账户映射必须为32字节');
  }
  final account =
      mapped ?? Uint8List.fromList([...bytes, ...List.filled(12, 0xee)]);
  return (
    accountId: citizenAccountIdFromBytes(account),
    ss58Address: citizenSs58FromAccountIdBytes(account),
    block: block,
  );
}

/// 固定链协议的 Timestamp.Now，严格使用调用方交付的同一块。
Future<int> readCitizenBlockTimestamp(
  CitizenBlockRef block,
  Future<Uint8List?> Function(CitizenBlockRef, Uint8List) read,
) async {
  if (block.finality != CitizenBlockFinality.finalized) {
    throw const FormatException('链时间需要 finalized 块');
  }
  return decodeCitizenTimestamp(
    await read(block, CitizenScale.storagePrefix('Timestamp', 'Now')),
  );
}

int decodeCitizenTimestamp(Uint8List? value) {
  if (value == null || value.length != 8) {
    throw const FormatException('已验证区块缺少准确 Timestamp.Now');
  }
  final number = CitizenScale.readUnsigned(value, 0, 8);
  if (number <= BigInt.zero || !number.isValidInt) {
    throw const FormatException('链时间超出整数范围');
  }
  return number.toInt();
}

/// 找到已验证范围内第一个不早于时间锚的高度；未达到时返回末高度加一。
Future<int> firstCitizenBlockAtOrAfter(
  CitizenBlockRef head,
  BigInt timestamp,
  Future<CitizenBlockRef> Function(BigInt) blockAt,
  Future<int> Function(CitizenBlockRef) timeAt, {
  bool Function()? active,
}) async {
  if (head.finality != CitizenBlockFinality.finalized ||
      !head.number.isValidInt ||
      timestamp <= BigInt.zero ||
      !timestamp.isValidInt) {
    throw StateError('查找区块的高度或时间锚无效');
  }
  var low = 1, high = head.number.toInt() + 1;
  while (low < high) {
    if (active?.call() == false) throw StateError('区块查找已取消');
    final middle = low + ((high - low) ~/ 2);
    final block = await blockAt(BigInt.from(middle));
    if (block.finality != CitizenBlockFinality.finalized ||
        block.number != BigInt.from(middle)) {
      throw StateError('区块与 finalized 请求高度不一致');
    }
    if (BigInt.from(await timeAt(block)) < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
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
      accountId: _accountIdText(value.account_id.bytes),
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

/// 钱包各入口共享同一加载和展示状态；失败保留成功值，未知值始终为 null。
/// 测试可注入读取器，生产状态只由下方余额所有者按账户和来源创建。
final class CitizenBalanceState<T> extends ChangeNotifier {
  CitizenBalanceState(this._loader);

  final Future<T> Function(bool forceRefresh) _loader;
  T? _value;
  Object? _error;
  Future<void>? _loading;
  T? get value => _value;
  bool get hasError => _error != null;
  Object? get error => _error;
  bool get isLoading => _loading != null;

  /// 委托 SDK 核对最新区块；同一状态合并在途操作，保留可显示金额。
  Future<void> load({bool forceRefresh = false}) {
    final running = _loading;
    if (running != null) return running;
    final completed = Completer<void>();
    _loading = completed.future;
    _error = null;
    // 读取可能在首帧绑定时开始；通知延后，避免组件构建期间反向 setState。
    unawaited(
      Future<void>.microtask(() async {
        notifyListeners();
        try {
          _accept(await _loader(forceRefresh));
        } catch (error) {
          _error = error;
        } finally {
          _loading = null;
          notifyListeners();
          completed.complete();
        }
      }),
    );
    return completed.future;
  }

  void _accept(T value) {
    final previous = _value;
    final changed =
        _error != null ||
        (previous is CitizenAccountBalance && value is CitizenAccountBalance
            ? !CitizenBalances._sameAmount(previous, value)
            : previous != value);
    _value = value;
    _error = null;
    if (changed) notifyListeners();
  }

  void _fail(Object error) {
    _error = error;
    notifyListeners();
  }

  void _clear() {
    _value = null;
    _error = null;
    notifyListeners();
  }
}

/// 原始快照宿主 I/O；update 必须在同一事务中完成读取、转换和写入。
typedef CitizenBalanceStorage = ({
  Future<String?> Function(String accountId) read,
  Future<void> Function(String accountId, String? Function(String?) update)
  write,
});

/// 每个 SDK 会话的一份余额快照；展示缓存不授予交易权限。
final class CitizenBalances {
  CitizenBalances({
    required Future<List<CitizenAccountBalance>> Function(
      List<String> accountIds,
    )
    getAccountBalances,
    Future<CitizenBlockRef> Function()? getFinalizedHead,
    CitizenBalanceStorage? storage,
  }) : _getAccountBalances = getAccountBalances,
       _getFinalizedHead = getFinalizedHead,
       _storage = storage;

  final CitizenBalanceStorage? _storage;
  final Future<List<CitizenAccountBalance>> Function(List<String>)
  _getAccountBalances;
  final Future<CitizenBlockRef> Function()? _getFinalizedHead;
  final _inflight = <String, Future<CitizenAccountBalance>>{};
  final _queued = <String, Completer<CitizenAccountBalance>>{};
  final _accountStates = <String, CitizenBalanceState<CitizenAccountBalance>>{};
  final _localReads = <String, Future<CitizenAccountBalance?>>{};
  final _removing = <String>{};
  final _epochs = <String, int>{};
  final _watched = <String, int>{};
  CitizenBlockRef? _head;
  Future<CitizenBlockRef>? _headFlight;
  Future<void>? _draining, _observing;
  bool _checkHead = false;
  bool _scheduled = false, _foreground = true, _closed = false, _dirty = false;

  CitizenBalanceState<CitizenAccountBalance> accountState(String accountId) {
    _requireAccountId(accountId);
    return _accountStates.putIfAbsent(
      accountId,
      () => CitizenBalanceState(
        (force) => getAccountBalance(accountId, forceRefresh: force),
      ),
    );
  }

  /// 页面可见时登记；最后一个引用释放后停止该账户的自动读取。
  VoidCallback watch(Iterable<String> accountIds) {
    if (_closed) throw StateError('余额服务已关闭');
    final ids = accountIds.toSet();
    for (final id in ids) {
      _requireAccountId(id);
      if (_removing.contains(id)) throw StateError('余额正在清理');
    }
    for (final id in ids) {
      _watched.update(id, (n) => n + 1, ifAbsent: () => 1);
    }
    _requestObserved();
    final epochs = {for (final id in ids) id: _epochs[id]};
    var released = false;
    return () {
      if (released) return;
      released = true;
      for (final id in ids) {
        if (epochs[id] != _epochs[id]) continue;
        final count = _watched[id];
        if (count == null) continue;
        if (count == 1) {
          _watched.remove(id);
        } else {
          _watched[id] = count - 1;
        }
      }
    };
  }

  void finalized(CitizenBlockRef block) {
    if (_closed) return;
    if (block.finality != CitizenBlockFinality.finalized) {
      throw StateError('余额需要 finalized 区块');
    }
    final old = _head;
    if (old != null && block.number < old.number) return;
    if (old != null && block.number == old.number) {
      if (old.hash != block.hash) throw StateError('同高度 finalized 证明冲突');
      return;
    }
    _head = block;
    _requestObserved();
  }

  void setForeground(bool value) {
    if (_closed) return;
    _foreground = value;
    if (value) _requestObserved(checkHead: true);
  }

  void _requestObserved({bool checkHead = false}) {
    if (_closed || !_foreground || _watched.isEmpty) return;
    _dirty = true;
    _checkHead = _checkHead || checkHead;
    if (_observing != null) return;
    _observing =
        Future<void>.microtask(() async {
          while (_dirty && !_closed && _foreground && _watched.isNotEmpty) {
            _dirty = false;
            final refreshHead = _checkHead;
            _checkHead = false;
            try {
              await _load(
                _watched.keys.toList(),
                automatic: true,
                forceRefresh: refreshHead,
              );
            } on Object {
              /* 下一最终块、重新显示或手动重试再读，不增加轮询。 */
            }
          }
        }).whenComplete(() {
          _observing = null;
        });
  }

  Future<void> restore(Iterable<String> accountIds) async {
    await Future.wait(accountIds.toSet().map(read));
  }

  Future<void> remove(Iterable<String> accountIds) async {
    for (final id in accountIds.toSet()) {
      if (!_removing.add(id)) throw StateError('余额正在清理');
      _epochs.update(id, (value) => value + 1, ifAbsent: () => 1);
      _watched.remove(id);
      try {
        final state = _accountStates[id];
        await Future.wait(
          <Future<Object?>>[
            ?_inflight[id],
            ?_localReads[id],
            ?state?._loading,
          ].map((value) async {
            try {
              await value;
            } on Object {
              // 原读请求自行交付失败；清理仍等待结束后继续移除。
            }
          }),
        );
        await _storage?.write(id, (_) => null);
        _accountStates.remove(id);
        state?._clear();
      } finally {
        _removing.remove(id);
      }
    }
  }

  Future<void> _latest(bool refresh) async {
    final loader = _getFinalizedHead;
    if (loader == null || (!refresh && _head != null)) return;
    final flight = _headFlight ??= loader();
    try {
      finalized(await flight);
    } finally {
      if (identical(_headFlight, flight)) _headFlight = null;
    }
  }

  bool _current(CitizenAccountBalance? value) {
    if (value == null) return false;
    final head = _head;
    if (head == null) return _getFinalizedHead == null;
    return value.block.number == head.number && value.block.hash == head.hash;
  }

  Future<CitizenAccountBalance> getAccountBalance(
    String accountId, {
    bool forceRefresh = false,
  }) async => (await getAccountBalances([
    accountId,
  ], forceRefresh: forceRefresh)).single;

  /// 订阅、预检、单账户和批量查询共用同一队列。
  Future<List<CitizenAccountBalance>> getAccountBalances(
    List<String> accountIds, {
    bool forceRefresh = false,
  }) => _load(accountIds, forceRefresh: forceRefresh);

  Future<List<CitizenAccountBalance>> _load(
    List<String> accountIds, {
    bool forceRefresh = false,
    bool automatic = false,
  }) async {
    if (_closed) throw StateError('余额服务已关闭');
    final ids = accountIds.toSet().toList();
    for (final id in ids) {
      _requireAccountId(id);
      if (_removing.contains(id)) throw StateError('余额正在清理');
    }
    if (ids.isEmpty) return const [];
    final epochs = {for (final id in ids) id: _epochs[id]};
    try {
      await restore(ids);
      if (automatic) {
        if (!_foreground) return const [];
        ids.removeWhere((id) => !_watched.containsKey(id));
        if (ids.isEmpty) return const [];
      }
      await _latest(forceRefresh);
    } catch (error) {
      for (final id in ids) {
        if (!_closed && !_removing.contains(id) && epochs[id] == _epochs[id]) {
          accountState(id)._fail(error);
        }
      }
      rethrow;
    }
    final results = <String, CitizenAccountBalance>{};
    while (true) {
      if (automatic) {
        if (!_foreground) return const [];
        ids.removeWhere((id) => !_watched.containsKey(id));
        if (ids.isEmpty) return const [];
      }
      final futures = <Future<CitizenAccountBalance>>[];
      for (var i = 0; i < ids.length; i++) {
        final id = ids[i];
        if (_closed || _removing.contains(id) || epochs[id] != _epochs[id]) {
          throw StateError('余额读取已失效');
        }
        final value = accountState(id).value;
        if (_current(value) && !(forceRefresh && _getFinalizedHead == null)) {
          accountState(id)._accept(value!);
          results[id] = value;
        } else {
          futures.add(_queue(id));
        }
      }
      if (futures.isEmpty) break;
      for (final value in await Future.wait(futures)) {
        results[value.accountId] = value;
      }
      forceRefresh = false;
      if (_head == null || ids.every((id) => _current(results[id]))) break;
    }
    return [for (final id in (automatic ? ids : accountIds)) results[id]!];
  }

  Future<CitizenAccountBalance> _queue(String id) {
    final running = _inflight[id];
    if (running != null) return running;
    final pending = Completer<CitizenAccountBalance>();
    _queued[id] = pending;
    _inflight[id] = pending.future;
    if (_draining == null) _scheduleDrain();
    return pending.future;
  }

  void _scheduleDrain() {
    if (_scheduled) return;
    _scheduled = true;
    scheduleMicrotask(() {
      _scheduled = false;
      _draining = _drain().whenComplete(() {
        _draining = null;
        if (_queued.isNotEmpty) _scheduleDrain();
      });
    });
  }

  Future<void> _drain() async {
    while (_queued.isNotEmpty) {
      final ids = _queued.keys.take(1990).toList();
      final pending = {for (final id in ids) id: _queued.remove(id)!};
      final epochs = {for (final id in ids) id: _epochs[id]};
      final target = _head;
      try {
        if (_closed) throw StateError('余额服务已关闭');
        final values = await _getAccountBalances(ids);
        if (values.length != ids.length) throw StateError('余额响应数量不一致');
        for (var i = 0; i < ids.length; i++) {
          _validate(values[i], ids[i]);
          if (values[i].block.hash != values.first.block.hash ||
              values[i].block.number != values.first.block.number ||
              target != null && values[i].block.number < target.number) {
            throw StateError('余额没有绑定同一最新最终区块');
          }
        }
        finalized(values.first.block);
        for (var i = 0; i < ids.length; i++) {
          final id = ids[i];
          if (_closed || _removing.contains(id) || epochs[id] != _epochs[id]) {
            throw StateError('余额读取已失效');
          }
          final value = await _put(values[i]);
          if (_closed || _removing.contains(id) || epochs[id] != _epochs[id]) {
            throw StateError('余额读取已失效');
          }
          accountState(id)._accept(value);
          pending[id]!.complete(value);
        }
      } catch (error, stack) {
        for (final id in ids) {
          if (!_closed &&
              !_removing.contains(id) &&
              epochs[id] == _epochs[id]) {
            accountState(id)._fail(error);
          }
          if (!pending[id]!.isCompleted) {
            pending[id]!.completeError(error, stack);
          }
        }
      } finally {
        for (final id in ids) {
          // 仅移除已结束任务的引用，不启动或再次等待这个Future。
          final _ = _inflight.remove(id);
        }
      }
    }
  }

  Future<void> close() async {
    _closed = true;
    _watched.clear();
    await _draining;
    if (_queued.isNotEmpty) await _drain();
    await Future.wait(
      _localReads.values.toList().map((f) async {
        try {
          await f;
        } on Object {
          // 原调用方保留读取失败；关闭只负责等待全部已发请求结束。
        }
      }),
    );
  }

  static bool _sameAmount(CitizenAccountBalance? a, CitizenAccountBalance b) =>
      a != null && a.freeFen == b.freeFen && a.reservedFen == b.reservedFen;

  Future<CitizenAccountBalance?> read(String accountId) async {
    _requireAccountId(accountId);
    if (_closed || _removing.contains(accountId)) throw StateError('余额读取已失效');
    final epoch = _epochs[accountId];
    final current = accountState(accountId).value;
    if (current != null) return current;
    final running = _localReads[accountId];
    if (running != null) return running;
    final reading = _readStored(accountId);
    _localReads[accountId] = reading;
    try {
      final value = await reading;
      if (_closed ||
          _removing.contains(accountId) ||
          epoch != _epochs[accountId]) {
        throw StateError('余额读取已失效');
      }
      // 在途数据库旧读不能覆盖已经刷新完成的内存值。
      final state = accountState(accountId);
      if (state.value == null && value != null) state._accept(value);
      return state.value;
    } finally {
      final _ = _localReads.remove(accountId);
    }
  }

  Future<CitizenAccountBalance?> _readStored(String accountId) async =>
      _decodeChain(
        _decodeRecord(await _storage?.read(accountId))['chain'],
        accountId,
      );

  Future<CitizenAccountBalance> _put(CitizenAccountBalance value) async {
    final id = value.accountId;
    final current = accountState(id).value;
    if (current != null) _requireCurrent(value, current);
    if (_sameAmount(current, value)) return value;
    await _storage?.write(id, (raw) {
      final record = _decodeRecord(raw);
      final previous = _decodeChain(record['chain'], id);
      if (previous != null) _requireCurrent(value, previous);
      record['chain'] = {
        'block_hash': value.block.hash,
        'block_number': value.block.number.toString(),
        'free_fen': value.freeFen.toString(),
        'reserved_fen': value.reservedFen.toString(),
      };
      return jsonEncode(record);
    });
    return value;
  }

  static void _requireCurrent(
    CitizenAccountBalance value,
    CitizenAccountBalance previous,
  ) {
    if (value.block.number < previous.block.number) {
      throw StateError('已验证余额早于现有快照');
    }
    if (value.block.number == previous.block.number &&
        value.block.hash != previous.block.hash) {
      throw StateError('同高度 finalized 余额证明冲突');
    }
  }

  static Map<String, dynamic> _decodeRecord(String? raw) {
    if (raw == null) return {};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return {};
      return {if (decoded['chain'] is Map) 'chain': decoded['chain']};
    } on FormatException {
      return {};
    }
  }

  static CitizenAccountBalance? _decodeChain(Object? raw, String accountId) {
    const fields = {'block_hash', 'block_number', 'free_fen', 'reserved_fen'};
    if (raw is! Map ||
        raw.length != fields.length ||
        !raw.keys.every(fields.contains)) {
      return null;
    }
    try {
      final free = BigInt.parse(raw['free_fen'] as String);
      final reserved = BigInt.parse(raw['reserved_fen'] as String);
      final value = CitizenAccountBalance(
        accountId: accountId,
        block: CitizenBlockRef(
          hash: raw['block_hash'] as String,
          number: BigInt.parse(raw['block_number'] as String),
          finality: CitizenBlockFinality.finalized,
        ),
        freeFen: free,
        reservedFen: reserved,
        totalFen: free + reserved,
      );
      _validate(value, accountId);
      return value;
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    } on StateError {
      return null;
    }
  }

  static void _validate(CitizenAccountBalance value, String accountId) {
    if (value.accountId != accountId ||
        value.block.finality != CitizenBlockFinality.finalized ||
        !RegExp(r'^0x[0-9a-f]{64}$').hasMatch(value.block.hash) ||
        value.block.number < BigInt.zero ||
        value.freeFen < BigInt.zero ||
        value.reservedFen < BigInt.zero ||
        value.totalFen > _maxFen ||
        value.totalFen != value.freeFen + value.reservedFen) {
      throw StateError('账户余额证明或整数分数据不一致');
    }
  }

  static void _requireAccountId(String accountId) {
    if (!isCitizenAccountId(accountId)) {
      throw const FormatException('account_id 必须为小写十六进制账户');
    }
  }
}

final class _ChainSync {
  _ChainSync(this._read);

  final Future<CitizenChainSyncStatus> Function() _read;
  final _listeners = <MultiStreamController<CitizenChainSyncStatus>>{};
  CitizenChainSyncStatus? _value;
  Future<void>? _pending;
  Timer? _timer;
  bool _closed = false;

  Stream<CitizenChainSyncStatus> watch() =>
      Stream<CitizenChainSyncStatus>.multi((out) {
        if (_closed) {
          unawaited(out.close());
          return;
        }
        final value = _value;
        if (value != null) out.add(value);
        _listeners.add(out);
        out.onCancel = () {
          _listeners.remove(out);
          if (_listeners.isEmpty) _timer?.cancel();
        };
        unawaited(refresh());
      });

  Future<void> refresh() {
    if (_closed || _listeners.isEmpty) return Future.value();
    return _pending ??= _sample();
  }

  Future<void> _sample() async {
    _timer?.cancel();
    try {
      final value = await _read();
      _value = value;
      for (final out in _listeners.toList()) {
        out.add(value);
      }
    } on Object catch (error, stack) {
      for (final out in _listeners.toList()) {
        out.addError(error, stack);
      }
    } finally {
      _pending = null;
      if (!_closed && _listeners.isNotEmpty) {
        _timer = Timer(const Duration(seconds: 6), () => unawaited(refresh()));
      }
    }
  }

  void close() {
    _closed = true;
    _timer?.cancel();
    for (final out in _listeners.toList()) {
      unawaited(out.close());
    }
    _listeners.clear();
  }
}
