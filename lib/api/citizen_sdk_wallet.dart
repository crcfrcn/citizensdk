part of '../citizen_sdk.dart';

extension Wallet on CitizenSdk {
  CitizenSdkOperation<CitizenWalletState> getWalletState() => _operation(
    (m, out) => _api.citizensdk_get_wallet_state(_handle, out),
    _readWallet,
    diagnostic: 'getWalletState',
  );
  CitizenSdkOperation<CitizenWalletInspection> inspectWallets() => _operation(
    (m, out) => _api.citizensdk_get_wallet_state(_handle, out),
    (m, r) {
      final state = _readWallet(m, r), token = m.alloc<Uint64>(8);
      _status(_api.citizensdk_wallet_state_retain(_handle, r, token));
      return CitizenWalletInspection._(this, token.value, state);
    },
    diagnostic: 'inspectWallets',
  );
  Future<CitizenWalletInputValidation> validatePassword(
    String password,
  ) async => _input(password, 1, 0);
  Future<CitizenWalletInputValidation> validateMnemonic(
    String mnemonic,
    CitizenWalletWordCount count,
  ) async => _input(mnemonic, 2, count.value);
  CitizenWalletInputValidation _input(String value, int kind, int words) =>
      _withMemory((m) {
        final p = m.struct<c.citizensdk_wallet_input_validation_v1>(
          sizeOf<c.citizensdk_wallet_input_validation_v1>(),
        );
        _status(
          _api.citizensdk_validate_wallet_input(kind, m.view(value), words, p),
        );
        final reason = _enum(CitizenWalletInputReason.values, p.ref.reason),
            position = p.ref.position == 0xffffffff ? null : p.ref.position;
        if (position != null && reason != CitizenWalletInputReason.unknownWord)
          throw _failure(9);
        return CitizenWalletInputValidation(reason: reason, position: position);
      });
  Future<List<String>> wordSuggestions(String prefix) async => _withMemory((m) {
    final value = m.text(
      (b, cap, n) => _api.citizensdk_wallet_word_suggestions(
        m.view(prefix, 1024),
        b,
        cap,
        n,
      ),
      1024,
    );
    return value.isEmpty ? const [] : List.unmodifiable(value.split('\n'));
  });
  CitizenSdkOperation<CitizenSdkPreparedWallet> prepareWalletCreation({
    required CitizenWalletWordCount wordCount,
    String password = '',
  }) => _operation(
    (m, out) => _api.citizensdk_prepare_wallet_creation(
      _handle,
      wordCount.value,
      m.view(password, 1024),
      out,
    ),
    (m, r) {
      final p = m.struct<c.citizensdk_prepared_wallet_info>(
        sizeOf<c.citizensdk_prepared_wallet_info>(),
      );
      _status(_api.citizensdk_result_get_prepared_wallet(r, p));
      return CitizenSdkPreparedWallet._(this, p.ref.prepared_wallet);
    },
  );
  CitizenSdkOperation<CitizenWalletProfile> importWallet({
    required String mnemonic,
    String password = '',
  }) => _operation(
    (m, out) => _api.citizensdk_import_wallet(
      _handle,
      m.view(mnemonic, 1024),
      m.view(password, 1024),
      out,
    ),
    _requiredProfile,
  );
  CitizenSdkOperation<CitizenWalletProfile> addAccounts({
    required String mnemonic,
    String password = '',
    required List<int> indices,
  }) => _operation((m, out) {
    final values = m.alloc<Uint32>(indices.length * 4);
    for (var i = 0; i < indices.length; i++) {
      values[i] = _u32(indices[i]);
    }
    return _api.citizensdk_add_wallet_accounts(
      _handle,
      m.view(mnemonic, 1024),
      m.view(password, 1024),
      values,
      indices.length,
      out,
    );
  }, _requiredProfile);
  CitizenSdkOperation<CitizenWalletProfile> addNextAccount({
    required String mnemonic,
    String password = '',
  }) => _operation(
    (m, out) => _api.citizensdk_add_next_wallet_account(
      _handle,
      m.view(mnemonic, 1024),
      m.view(password, 1024),
      out,
    ),
    _requiredProfile,
  );
  CitizenSdkOperation<CitizenWalletState> importColdAccount({
    String? accountId,
    String? ss58Address,
    String name = '',
  }) {
    if ((accountId == null) == (ss58Address == null)) throw _failure(1);
    return _operation(
      (m, out) => accountId != null
          ? _api.citizensdk_import_cold_account_id(
              _handle,
              m.account(accountId),
              m.view(name, 120),
              out,
            )
          : _api.citizensdk_import_cold_account_ss58(
              _handle,
              m.view(ss58Address!, 128),
              m.view(name, 120),
              out,
            ),
      _readWallet,
    );
  }

  CitizenSdkOperation<CitizenWalletState> importColdAccountCode({
    required String code,
    String name = '',
  }) => _operation((m, out) {
    final document = _document(
      m.text(
        (b, cap, n) => _api.citizensdk_qr_parse(
          _handle,
          m.view(code, 2331),
          CitizenQrScanPurpose.coldAccountImport.value,
          b,
          cap,
          n,
        ),
      ),
    );
    if (document.accountId == null) throw _failure(9);
    return _api.citizensdk_import_cold_account_id(
      _handle,
      m.account(document.accountId!),
      m.view(name, 120),
      out,
    );
  }, _readWallet);
  CitizenSdkOperation<CitizenWalletProfile> setActiveAccount(
    String accountId,
  ) => _operation(
    (m, out) => _api.citizensdk_set_active_wallet_account(
      _handle,
      m.account(accountId),
      out,
    ),
    _requiredProfile,
  );
  CitizenSdkOperation<CitizenWalletState> setActiveWallet({
    required BigInt expectedRevision,
    required int walletIndex,
  }) => _operation(
    (m, out) => _api.citizensdk_set_active_wallet(
      _handle,
      _u64(expectedRevision),
      _u32(walletIndex),
      out,
    ),
    _readWallet,
  );
  CitizenSdkOperation<CitizenWalletState> renameWallet({
    required BigInt expectedRevision,
    required int walletIndex,
    required String name,
  }) => _operation(
    (m, out) => _api.citizensdk_rename_wallet(
      _handle,
      _u64(expectedRevision),
      _u32(walletIndex),
      m.view(name, 120),
      out,
    ),
    _readWallet,
  );
  CitizenSdkOperation<CitizenWalletState> renameAccount({
    required String accountId,
    required String name,
  }) => _operation(
    (m, out) => _api.citizensdk_rename_account(
      _handle,
      m.account(accountId),
      m.view(name, 120),
      out,
    ),
    _readWallet,
  );
  CitizenSdkOperation<CitizenWalletState> deleteAccount(String accountId) =>
      _operation(
        (m, out) =>
            _api.citizensdk_delete_account(_handle, m.account(accountId), out),
        _readWallet,
      );
  CitizenSdkOperation<void> deleteWallet() => _operation(
    (m, out) => _api.citizensdk_delete_wallet(_handle, out),
    (m, r) {},
  );
  CitizenSdkOperation<void> signAndDeleteWallet() => _operation(
    (m, out) => _api.citizensdk_sign_and_delete_wallet(_handle, out),
    (m, r) {},
  );
  CitizenSdkOperation<void> reconcileCleanup() => _operation(
    (m, out) => _api.citizensdk_reconcile_wallet_cleanup(_handle, out),
    (m, r) {},
  );
  CitizenSdkOperation<CitizenWalletState> reorderAccountsWithoutDefaultChange({
    required BigInt expectedRevision,
    required List<String> accountIds,
  }) => _operation(
    (m, out) => _api.citizensdk_reorder_wallet_accounts_without_default_change(
      _handle,
      _u64(expectedRevision),
      m.accounts(accountIds, 256),
      accountIds.length,
      out,
    ),
    _readWallet,
  );
  CitizenSdkOperation<CitizenDefaultAccountChangeOutcome>
  beginDefaultAccountChange({
    required BigInt expectedRevision,
    required List<String> accountIds,
    int ttlSeconds = 90,
  }) => _operation(
    (m, out) => _api.citizensdk_begin_default_account_change(
      _handle,
      _u64(expectedRevision),
      m.accounts(accountIds, 256),
      accountIds.length,
      ttlSeconds,
      out,
    ),
    _readDefaultChange,
  );
  CitizenSdkOperation<CitizenDefaultAccountChangeCompleted>
  consumeDefaultAccountChange({
    required String sessionId,
    required String response,
  }) => _operation(
    (m, out) => _api.citizensdk_consume_default_account_change(
      _handle,
      m.view(sessionId, 128),
      m.view(response, 2331),
      out,
    ),
    (m, r) {
      final value = _readDefaultChange(m, r);
      if (value is! CitizenDefaultAccountChangeCompleted) throw _failure(9);
      return value;
    },
  );
  CitizenSdkOperation<CitizenWalletSignature> sign({
    required String accountId,
    required Uint8List payload,
  }) => _operation(
    (m, out) => _api.citizensdk_sign_wallet_payload(
      _handle,
      m.account(accountId),
      m.view(payload),
      out,
    ),
    (m, r) {
      final signature = m.alloc<Uint8>(64);
      _status(_api.citizensdk_result_get_signature(r, signature));
      return CitizenWalletSignature(
        accountId: accountId,
        bytes: signature.asTypedList(64),
      );
    },
  );
  CitizenSdkOperation<CitizenSigningOutcome> beginSigning(
    CitizenSigningIntent intent,
  ) => _operation(
    (m, out) => _api.citizensdk_begin_signing(
      _handle,
      m.account(intent.accountId),
      m.view(intent.payload),
      intent.transform.kind.index + 1,
      m.view(intent.transform.domain, 32),
      intent.externalSignerTransport == null ? 0 : 1,
      _u16(intent.opaqueAction),
      intent.ttlSeconds,
      out,
    ),
    _readSigning,
  );
  CitizenSdkOperation<CitizenSigningCompleted> consumeExternalSignature({
    required String sessionId,
    required String response,
  }) => _operation(
    (m, out) => _api.citizensdk_consume_external_signature(
      _handle,
      m.view(sessionId, 128),
      m.view(response, 2331),
      out,
    ),
    (m, r) {
      final value = _readSigning(m, r);
      if (value is! CitizenSigningCompleted) throw _failure(9);
      return value;
    },
  );
  Future<bool> cancelSigning(String sessionId) async {
    _requireOpen();
    return _withMemory((m) {
      final out = m.alloc<Uint8>(1);
      _status(
        _api.citizensdk_cancel_signing_session(
          _handle,
          m.view(sessionId, 128),
          out,
        ),
      );
      return _boolean(out.value);
    });
  }
}

CitizenWalletProfile _requiredProfile(_Memory m, int result) =>
    _readProfile(m, result) ?? (throw _failure(9));
CitizenWalletProfile? _readProfile(_Memory m, int result) {
  final p = m.struct<c.citizensdk_wallet_profile_info>(
    sizeOf<c.citizensdk_wallet_profile_info>(),
  );
  _status(_api.citizensdk_result_get_wallet_profile(result, p));
  final v = p.ref;
  if (!_boolean(v.present)) return null;
  if (v.account_count > 19890605) throw _failure(9);
  final accounts = List<CitizenAccount>.generate(v.account_count, (i) {
    final q = m.struct<c.citizensdk_wallet_account_info>(
          sizeOf<c.citizensdk_wallet_account_info>(),
        ),
        a = m.alloc<Uint64>(8),
        n = m.alloc<Uint64>(8);
    _status(
      _api.citizensdk_result_get_wallet_account(
        result,
        i,
        q,
        nullptr,
        0,
        a,
        nullptr,
        0,
        n,
      ),
    );
    if (a.value < 0 || a.value > 128 || n.value < 0 || n.value > 120)
      throw _failure(9);
    final address = m.alloc<Uint8>(a.value), name = m.alloc<Uint8>(n.value);
    _status(
      _api.citizensdk_result_get_wallet_account(
        result,
        i,
        q,
        address,
        a.value,
        a,
        name,
        n.value,
        n,
      ),
    );
    final account = q.ref;
    return CitizenAccount(
      index: account.index,
      accountId: _hex(account.account_id.bytes, 32),
      ss58Address: utf8.decode(address.asTypedList(a.value)),
      name: utf8.decode(name.asTypedList(n.value)),
      createdAtMillis: _unsigned(account.created_at_millis),
      isActive: _boolean(account.is_active),
    );
  });
  return CitizenWalletProfile(
    walletIndex: v.wallet_index,
    walletName: m.text(
      (b, cap, n) =>
          _api.citizensdk_wallet_profile_copy_name(result, b, cap, n),
      120,
    ),
    masterAccountId: _hex(v.master_account_id.bytes, 32),
    origin: _enum(CitizenWalletOrigin.values, v.origin, 1),
    createdAtMillis: _unsigned(v.created_at_millis),
    activeAccountId: _hex(v.active_account_id.bytes, 32),
    accounts: accounts,
  );
}

CitizenWalletState _readWallet(_Memory m, int result) {
  final p = m.struct<c.citizensdk_wallet_state_info>(
    sizeOf<c.citizensdk_wallet_state_info>(),
  );
  _status(_api.citizensdk_result_get_wallet_state(result, p));
  if (p.ref.account_count > 19892595) throw _failure(9);
  final accounts = List<CitizenWalletStateAccount>.generate(
    p.ref.account_count,
    (i) {
      final q = m.struct<c.citizensdk_wallet_state_account_info>(
            sizeOf<c.citizensdk_wallet_state_account_info>(),
          ),
          a = m.alloc<Uint64>(8),
          n = m.alloc<Uint64>(8);
      _status(
        _api.citizensdk_result_get_wallet_state_account(
          result,
          i,
          q,
          nullptr,
          0,
          a,
          nullptr,
          0,
          n,
        ),
      );
      if (a.value < 0 || a.value > 128 || n.value < 0 || n.value > 120)
        throw _failure(9);
      final address = m.alloc<Uint8>(a.value), name = m.alloc<Uint8>(n.value);
      _status(
        _api.citizensdk_result_get_wallet_state_account(
          result,
          i,
          q,
          address,
          a.value,
          a,
          name,
          n.value,
          n,
        ),
      );
      final v = q.ref;
      return CitizenWalletStateAccount(
        signMode: _enum(CitizenWalletSignMode.values, v.sign_mode, 1),
        walletIndex: v.wallet_index,
        accountIndex: _boolean(v.has_account_index) ? v.account_index : null,
        accountId: _hex(v.account_id.bytes, 32),
        ss58Address: utf8.decode(address.asTypedList(a.value)),
        name: utf8.decode(name.asTypedList(n.value)),
        createdAtMillis: _unsigned(v.created_at_millis),
        isDefault: _boolean(v.is_default),
      );
    },
  );
  final initialized = m.alloc<Uint32>(4),
      cleanup = m.alloc<Uint8>(1),
      selected = m.alloc<Uint32>(4),
      present = m.alloc<Uint8>(1),
      count = m.alloc<Uint32>(4);
  _status(
    _api.citizensdk_wallet_state_get_initialization(
      result,
      initialized,
      cleanup,
    ),
  );
  _status(
    _api.citizensdk_wallet_state_get_active_wallet(result, present, selected),
  );
  _status(_api.citizensdk_wallet_state_get_diagnostic_count(result, count));
  if (count.value > 1991) throw _failure(9);
  final diagnostics = List<CitizenWalletDiagnostic>.generate(count.value, (i) {
    final q = m.struct<c.citizensdk_wallet_diagnostic_info_v1>(
      sizeOf<c.citizensdk_wallet_diagnostic_info_v1>(),
    );
    _status(_api.citizensdk_wallet_state_get_diagnostic_at(result, i, q));
    final v = q.ref;
    if (v.cleanup_account_count > 1991) throw _failure(9);
    CitizenWalletCleanupTargets? targets;
    if (v.cleanup_account_count != 0) {
      targets = CitizenWalletCleanupTargets(
        accountIds: List.generate(v.cleanup_account_count, (j) {
          final account = m.alloc<c.citizensdk_account_id>(32);
          _status(
            _api.citizensdk_wallet_state_get_diagnostic_cleanup_account(
              result,
              i,
              j,
              account,
            ),
          );
          return _hex(account.ref.bytes, 32);
        }),
        deleteWalletWideKey: _boolean(v.delete_wallet_wide_key),
      );
    } else if (v.delete_wallet_wide_key != 0) {
      throw _failure(9);
    }
    return CitizenWalletDiagnostic(
      walletIndex: v.wallet_index,
      walletName: m.text(
        (b, cap, n) => _api.citizensdk_wallet_state_copy_diagnostic_text(
          result,
          i,
          1,
          b,
          cap,
          n,
        ),
        120,
      ),
      accountId: _hex(v.account_id.bytes, 32),
      ss58Address: _boolean(v.has_ss58_address)
          ? m.text(
              (b, cap, n) => _api.citizensdk_wallet_state_copy_diagnostic_text(
                result,
                i,
                2,
                b,
                cap,
                n,
              ),
              128,
            )
          : null,
      diagnosticReason: _enum(
        CitizenWalletDiagnosticReason.values,
        v.diagnostic_reason,
        1,
      ),
      signMode: v.sign_mode == 0
          ? null
          : _enum(CitizenWalletSignMode.values, v.sign_mode, 1),
      cleanupTargets: targets,
    );
  });
  return CitizenWalletState(
    revision: _unsigned(p.ref.revision),
    activeWalletIndex: _boolean(present.value) ? selected.value : null,
    hotProfile: _readProfile(m, result),
    accounts: accounts,
    initializationState: _enum(
      CitizenWalletInitializationState.values,
      initialized.value,
    ),
    cleanupPending: _boolean(cleanup.value),
    diagnostics: diagnostics,
  );
}

CitizenSigningOutcome _readSigning(_Memory m, int result) {
  final p = m.struct<c.citizensdk_signing_outcome_info>(
        sizeOf<c.citizensdk_signing_outcome_info>(),
      ),
      signature = m.alloc<Uint8>(64),
      session = m.alloc<Uint8>(128),
      request = m.alloc<Uint8>(2331),
      sn = m.alloc<Uint64>(8),
      rn = m.alloc<Uint64>(8),
      bn = m.alloc<Uint64>(8);
  _status(
    _api.citizensdk_result_get_signing_outcome(
      result,
      p,
      signature,
      64,
      bn,
      session,
      128,
      sn,
      request,
      2331,
      rn,
    ),
  );
  final v = p.ref;
  if (bn.value < 0 ||
      bn.value > 64 ||
      sn.value < 0 ||
      sn.value > 128 ||
      rn.value < 0 ||
      rn.value > 2331)
    throw _failure(9);
  if (v.status == 1) {
    if (bn.value != 64) throw _failure(9);
    return CitizenSigningCompleted(
      accountId: _hex(v.account_id.bytes, 32),
      payloadHash: _hex(v.payload_hash, 32),
      signature: signature.asTypedList(64),
    );
  }
  if (v.status != 2 || v.transport != 1) throw _failure(9);
  return CitizenExternalSigningPending(
    accountId: _hex(v.account_id.bytes, 32),
    payloadHash: _hex(v.payload_hash, 32),
    transport: CitizenExternalSignerTransport.qrV1,
    expiresAt: _unsigned(v.expires_at),
    sessionId: utf8.decode(session.asTypedList(sn.value)),
    transportRequest: utf8.decode(request.asTypedList(rn.value)),
  );
}

CitizenDefaultAccountChangeOutcome _readDefaultChange(_Memory m, int result) {
  final p = m.struct<c.citizensdk_default_account_change_info>(
        sizeOf<c.citizensdk_default_account_change_info>(),
      ),
      session = m.alloc<Uint8>(128),
      request = m.alloc<Uint8>(2331),
      sn = m.alloc<Uint64>(8),
      rn = m.alloc<Uint64>(8);
  _status(
    _api.citizensdk_result_get_default_account_change(
      result,
      p,
      session,
      128,
      sn,
      request,
      2331,
      rn,
    ),
  );
  final v = p.ref;
  if (sn.value < 0 || sn.value > 128 || rn.value < 0 || rn.value > 2331)
    throw _failure(9);
  if (v.status == 1)
    return CitizenDefaultAccountChangeCompleted(
      currentDefaultAccountId: _hex(v.current_default_account_id.bytes, 32),
      payloadHash: _hex(v.payload_hash, 32),
      committedRevision: _unsigned(v.committed_revision),
    );
  if (v.status != 2 || v.transport != 1) throw _failure(9);
  return CitizenDefaultAccountChangePending(
    currentDefaultAccountId: _hex(v.current_default_account_id.bytes, 32),
    payloadHash: _hex(v.payload_hash, 32),
    transport: CitizenExternalSignerTransport.qrV1,
    expiresAt: _unsigned(v.expires_at),
    sessionId: utf8.decode(session.asTypedList(sn.value)),
    transportRequest: utf8.decode(request.asTypedList(rn.value)),
  );
}

// 这些对象真实拥有Core资源；不存在另一层资源编号表或可替换实现。
final class CitizenSdkPreparedWallet {
  CitizenSdkPreparedWallet._(this._sdk, this._token) {
    _sdk._remember(release);
  }
  final CitizenSdk _sdk;
  final int _token;
  bool _released = false, _submitted = false;
  Future<void>? _releaseFuture;
  Future<CitizenWalletProfile>? _commitFuture;
  void _require() {
    if (_released || _submitted || _releaseFuture != null) throw _failure(3);
  }

  Future<CitizenSdkRecoveryPhrase> recoveryPhrase() async {
    _require();
    final bytes = _withMemory(
      (m) => m.copy(
        (b, cap, n) => _api.citizensdk_prepared_wallet_copy_mnemonic(
          _sdk._handle,
          _token,
          b,
          cap,
          n,
        ),
        1024,
      ),
    );
    try {
      _require();
      return CitizenSdkRecoveryPhrase._(_sdk, bytes);
    } on Object {
      bytes.fillRange(0, bytes.length, 0);
      rethrow;
    }
  }

  CitizenSdkOperation<CitizenWalletProfile> commit() {
    _require();
    final operation = _sdk._operation(
      (m, out) =>
          _api.citizensdk_commit_wallet_creation(_sdk._handle, _token, out),
      _requiredProfile,
    );
    _submitted = true;
    _commitFuture = operation.result;
    return operation;
  }

  Future<void> release() {
    if (_released) return Future.value();
    return _releaseFuture ??= _release();
  }

  Future<void> _release() async {
    try {
      try {
        await _commitFuture;
      } on Object {
        /* 实际请求已终结后仍归还资源。 */
      }
      if (!_sdk._closed) {
        final code = _api.citizensdk_prepared_wallet_release(
          _sdk._handle,
          _token,
        );
        // 提交作业已消费时句柄不再存在；接纳前取消可能归还原准备，仍须实际释放。
        if (!(_submitted && code == c.CITIZENSDK_ERROR_INVALID_HANDLE)) {
          _status(code);
        }
      }
      _released = true;
      _sdk._forget(release);
    } on Object {
      _releaseFuture = null;
      rethrow;
    }
  }
}

final class CitizenSdkRecoveryPhrase {
  CitizenSdkRecoveryPhrase._(this._sdk, this._bytes) {
    _sdk._remember(release);
  }
  final CitizenSdk _sdk;
  final Uint8List _bytes;
  bool _released = false;
  Uint8List get bytes {
    if (_released) throw _failure(3);
    return _bytes.asUnmodifiableView();
  }

  Future<void> release() async {
    if (_released) return;
    _bytes.fillRange(0, _bytes.length, 0);
    _released = true;
    _sdk._forget(release);
  }

  @override
  String toString() => 'CitizenSdkRecoveryPhrase(redacted)';
}

final class CitizenWalletInspection {
  CitizenWalletInspection._(this._sdk, this._result, this.state) {
    _sdk._remember(release);
  }
  final CitizenSdk _sdk;
  final int _result;
  final CitizenWalletState state;
  bool _released = false;
  void _require() {
    if (_released) throw _failure(3);
  }

  CitizenSdkOperation<CitizenWalletState> repairHot(int walletIndex) {
    _require();
    return _sdk._operation(
      (m, out) => _api.citizensdk_repair_hot_wallet(
        _sdk._handle,
        _result,
        _u32(walletIndex),
        out,
      ),
      _readWallet,
    );
  }

  CitizenSdkOperation<CitizenWalletState> rename({
    required int walletIndex,
    required String name,
  }) {
    _require();
    return _sdk._operation(
      (m, out) => _api.citizensdk_rename_diagnostic_wallet(
        _sdk._handle,
        _result,
        _u32(walletIndex),
        m.view(name, 120),
        out,
      ),
      _readWallet,
    );
  }

  CitizenSdkOperation<CitizenWalletState> delete(int walletIndex) {
    _require();
    return _sdk._operation(
      (m, out) => _api.citizensdk_delete_diagnostic_wallet(
        _sdk._handle,
        _result,
        _u32(walletIndex),
        out,
      ),
      _readWallet,
    );
  }

  Future<void> release() async {
    if (_released) return;
    final elapsed = Stopwatch()..start();
    try {
      if (!_sdk._closed && !_sdk._detached)
        _status(_api.citizensdk_result_release(_result));
      _released = true;
      _sdk._forget(release);
      unawaited(_sdk._diagnose('releaseWalletInspection', 'COMPLETE', elapsed));
    } on Object catch (error) {
      unawaited(
        _sdk._diagnose(
          'releaseWalletInspection',
          'COMPLETE',
          elapsed,
          error: error,
        ),
      );
      rethrow;
    }
  }
}
