part of '../citizen_sdk.dart';

final c.Bindings _api = c.Bindings.fromLookup(<T extends NativeType>(
  String name,
) {
  if (Platform.isIOS || Platform.isMacOS) {
    return DynamicLibrary.process().lookup<T>(name);
  }
  if (name.startsWith('citizensdk_qr_image_') ||
      name.startsWith('citizensdk_dart_')) {
    return DynamicLibrary.open(
      Platform.isAndroid
          ? 'libcitizensdk_jni.so'
          : Platform.isWindows
          ? 'citizensdk_host.dll'
          : 'libcitizensdk_host.so',
    ).lookup<T>(name);
  }
  return DynamicLibrary.open(
    Platform.isWindows ? 'citizensdk.dll' : 'libcitizensdk.so',
  ).lookup<T>(name);
});

// 一个实例直接拥有Core句柄、真实在途请求和资源，不保留Platform或Session对象。
final class CitizenSdk with WidgetsBindingObserver {
  CitizenSdk._(this._hostId, this._handle, this._credentialProvider);
  static const _methods = MethodChannel('citizen/sdk/core/v2');
  static const _nativeEvents = EventChannel('citizen/sdk/events/v2');
  static final _instances = <String, CitizenSdk>{};
  static final _early = <String, List<List<Object?>>>{};
  static StreamSubscription<Object?>? _nativeSubscription;
  static int _opening = 0;
  static CitizenSdkException? _channelError;

  final String _hostId;
  final int _handle;
  final Future<Uint8List?> Function(CitizenCredentialChallenge)?
  _credentialProvider;
  final _pending = <int, _Request>{};
  final _resources = <Future<void> Function()>{};
  final _uiWork = <Future<void>>{};
  final _preparedTransactions = <String, int>{};
  final _transferred = <int>{};
  final _credentials = <BigInt, _Credential>{};
  final _closedResources = <String>{};
  final _acknowledgedResources = <String>{};
  final _events = StreamController<CitizenSdkEvent>.broadcast(sync: true);
  ReceivePort? _port;
  bool _closed = false, _closing = false, _detached = false, _foreground = true;
  int _resourceSequence = 1, _eventSequence = 1;
  CitizenSdkException? _protocolError;
  Future<void>? _closeFuture;

  static void _checkAbi() {
    try {
      if (_api.citizensdk_abi_version() != c.CITIZENSDK_ABI_VERSION ||
          _api.citizensdk_dart_api_major() != NativeApi.majorVersion) {
        throw _failure(4);
      }
    } on ArgumentError {
      throw _failure(4, 'CitizenSDK原生库不可用');
    }
  }

  static Future<CitizenSdk> open({
    int modules = CitizenSdkModules.full,
    Future<Uint8List?> Function(CitizenCredentialChallenge challenge)?
    credentialProvider,
  }) async {
    if (Platform.isFuchsia ||
        Platform.isLinux && Abi.current() != Abi.linuxArm64) {
      throw _failure(4);
    }
    if (_channelError != null) throw _channelError!;
    _nativeSubscription ??= _nativeEvents
        .receiveBroadcastStream(const [2])
        .listen(
          _route,
          onError: (Object error, StackTrace stack) {
            final failure = error is CitizenSdkException
                ? error
                : _failure(9, '系统资源事件通道失败');
            _channelError ??= failure;
            for (final sdk in List<CitizenSdk>.of(_instances.values)) {
              sdk._failEvents(failure, stack);
            }
          },
        );
    _opening++;
    String? id;
    CitizenSdk? sdk;
    try {
      final raw = await _rawResource('open', [
        2,
        modules,
        credentialProvider != null,
      ]);
      if (raw is! List<Object?> ||
          raw.length != 4 ||
          raw[0] != 2 ||
          raw[1] is! String ||
          raw[2] != 0) {
        throw _failure(9);
      }
      id = raw[1]! as String;
      if (id.isEmpty || id.length > 128 || _instances.containsKey(id)) {
        throw _failure(9);
      }
      final value = raw[3];
      if (value is! List<Object?> || value.length != 3 || value[2] is! String) {
        throw _failure(9);
      }
      final handle = _nativeId(value[2]! as String);
      if (handle == 0) throw _failure(9);
      _checkAbi();
      sdk = CitizenSdk._(id, handle, credentialProvider);
      sdk._attach();
      _instances[id] = sdk;
      if (credentialProvider != null) {
        sdk._foreground =
            WidgetsBinding.instance.lifecycleState == null ||
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
        WidgetsBinding.instance.addObserver(sdk);
      }
      for (final event in _early.remove(id) ?? <List<Object?>>[]) {
        sdk._nativeEvent(event);
      }
      if (sdk._protocolError != null) throw sdk._protocolError!;
      return sdk;
    } on Object {
      if (sdk != null) {
        sdk._closing = true;
        try {
          await sdk._cancelCredentials();
        } on Object {
          /* 保留最先错误。 */
        }
        _instances.remove(sdk._hostId);
        WidgetsBinding.instance.removeObserver(sdk);
        if (sdk._port != null) {
          _api.citizensdk_detach(sdk._handle);
          sdk._port!.close();
        }
      }
      if (id != null) {
        try {
          await _rawResource('close', [2, id, 1]);
        } on Object {
          /* 原生所有者继续负责收尾。 */
        }
      }
      rethrow;
    } finally {
      _opening--;
      if (_opening == 0) {
        _early.removeWhere((id, _) => !_instances.containsKey(id));
      }
    }
  }

  static Future<Object?> _rawResource(
    String method,
    List<Object?> arguments,
  ) async {
    try {
      return await _methods.invokeMethod<Object?>(method, arguments);
    } on MissingPluginException {
      throw _failure(4, 'CitizenSDK系统资源未注册');
    } on PlatformException catch (error) {
      final data = error.details;
      if (data is! List<Object?> ||
          data.length != 7 ||
          data[0] != 2 ||
          data[3] is! int ||
          data[4] is! int ||
          data[5] != method) {
        throw _failure(9);
      }
      final code = data[3]! as int, stage = data[4]! as int;
      if (code < 1 ||
          code > 22 ||
          stage < 1 ||
          stage > 8 ||
          error.code !=
              'citizensdk.${CitizenSdkErrorCode.values[code - 1].name}') {
        throw _failure(9);
      }
      throw CitizenSdkException(
        code: CitizenSdkErrorCode.values[code - 1],
        stage: CitizenSdkFailureStage.values[stage - 1],
        message: data[6] is String
            ? data[6]! as String
            : CitizenSdkErrorCode.values[code - 1].name,
        method: method,
        sessionId: data[1] as String?,
        requestSequence: data[2] as int?,
      );
    }
  }

  Future<List<Object?>> _resource(String method, List<Object?> fields) async {
    if (_closed) throw _failure(3);
    final sequence = _resourceSequence++;
    final raw = await _rawResource(method, [2, _hostId, sequence, ...fields]);
    if (raw is! List<Object?> ||
        raw.length != 4 ||
        raw[0] != 2 ||
        raw[1] != _hostId ||
        raw[2] != sequence ||
        raw[3] is! List<Object?>) {
      throw _failure(9);
    }
    final value = raw[3]! as List<Object?>;
    if (const {
          'closePrivateKey',
          'closeQrCapture',
          'pauseQrCapture',
          'resumeQrCapture',
          'setQrCaptureTorch',
          'respondCredential',
          'cancelCredential',
        }.contains(method) &&
        value.isNotEmpty) {
      throw _failure(9);
    }
    if (method == 'close' && (value.length != 1 || value[0] != 'disposed')) {
      throw _failure(9);
    }
    return value;
  }

  static void _route(Object? raw) {
    if (raw is! List<Object?> ||
        raw.length != 5 ||
        raw[0] != 2 ||
        raw[1] is! String ||
        raw[3] is! String ||
        raw[4] is! List<Object?>) {
      final error = _failure(9, '系统资源事件损坏');
      for (final sdk in List<CitizenSdk>.of(_instances.values)) {
        sdk._failEvents(error, StackTrace.current);
      }
      return;
    }
    final id = raw[1]! as String, sdk = _instances[id];
    if (sdk != null) {
      sdk._nativeEvent(raw);
      return;
    }
    if (_opening == 0) return;
    if (_early.length >= 32 && !_early.containsKey(id)) {
      _channelError ??= _failure(19);
      return;
    }
    final pending = _early.putIfAbsent(id, () => []);
    if (pending.length >= 64) {
      _channelError ??= _failure(19);
      return;
    }
    pending.add(raw);
  }

  void _attach() {
    _port = ReceivePort();
    _port!.listen((Object? raw) {
      if (raw is! List<Object?> ||
          raw.length != 5 ||
          raw.any((v) => v is! int)) {
        _failEvents(_failure(9), StackTrace.current);
        return;
      }
      final values = raw.cast<int>();
      final kind = values[0], request = values[2], result = values[3];
      if (kind == 0) {
        _detached = true;
        _port!.close();
        for (final pending in _pending.values.toList()) {
          pending.fail(_failure(22, 'Core接收端已卸载'));
        }
        _pending.clear();
        return;
      }
      if (kind == 1) {
        final pending = _pending.remove(request);
        if (pending == null) {
          _releaseResult(result);
          return;
        }
        try {
          pending.deliver(result);
        } finally {
          if (!_transferred.remove(result)) _releaseResult(result);
        }
        return;
      }
      try {
        if (_closing || _closed) return;
        final sequence = _eventSequence++;
        switch (kind) {
          case 3:
            _events.add(
              CitizenSdkCapabilitiesChanged(
                sequence: sequence,
                snapshot: _withMemory((m) => _readCapabilities(this, m)),
              ),
            );
          case 4:
            _events.add(
              CitizenSdkLifecycleChanged(
                sequence: sequence,
                lifecycle: lifecycle,
              ),
            );
          case 5:
            _events.add(CitizenSdkHistoryChanged(sequence: sequence));
          case 6:
            _events.add(
              CitizenSdkFinalizedBlockChanged(
                sequence: sequence,
                finalized: _withMemory((m) => _readBlock(m, result)),
              ),
            );
          case 7:
            _events.add(CitizenSdkWalletChanged(sequence: sequence));
        }
      } on Object catch (error, stack) {
        _failEvents(error is CitizenSdkException ? error : _failure(9), stack);
      } finally {
        if (result != 0) _releaseResult(result);
      }
    });
    _status(
      _api.citizensdk_attach(
        _handle,
        _api.addresses.citizensdk_dart_emit,
        NativeApi.postCObject.cast(),
        _port!.sendPort.nativePort,
      ),
    );
  }

  void _releaseResult(int result) {
    if (result == 0) return;
    final code = _api.citizensdk_result_release(result);
    if (code != 0 && !(code == 2 && _detached)) throw _failure(code);
  }

  void _inspect(_Memory m, int result) {
    final info = m.struct<c.citizensdk_result_info>(
      sizeOf<c.citizensdk_result_info>(),
    );
    _status(_api.citizensdk_result_get_info(result, info));
    if (info.ref.error_code == 0) return;
    final stage = m.alloc<Uint32>(4);
    _status(_api.citizensdk_result_get_failure_stage(result, stage));
    final message = m.text(
      (out, capacity, count) => _api.citizensdk_result_copy_error_message(
        result,
        out,
        capacity,
        count,
      ),
      4096,
    );
    throw _failure(info.ref.error_code, message, stage.value);
  }

  void _requireOpen() {
    if (_closed || _closing || _detached) throw _failure(3);
    if (_protocolError != null) throw _protocolError!;
  }

  CitizenSdkOperation<T> _operation<T>(
    int Function(_Memory, Pointer<Uint64>) accept,
    T Function(_Memory, int) read, {
    String? diagnostic,
  }) {
    final complete = Completer<T>();
    final memory = _Memory();
    final elapsed = Stopwatch()..start();
    unawaited(_diagnose(diagnostic, 'ADMISSION', elapsed, point: 'ADMISSION'));
    int id;
    try {
      _requireOpen();
      if (_pending.length >= 64) throw _failure(19);
      final out = memory.alloc<Uint64>(8);
      Object? thrown;
      final job = NativeCallable<Int32 Function(Pointer<Void>)>.isolateLocal((
        Pointer<Void> _,
      ) {
        try {
          return accept(memory, out);
        } on Object catch (error) {
          thrown = error;
          return 1;
        }
      }, exceptionalReturn: 20);
      int code;
      try {
        code = _api.citizensdk_invoke(_handle, job.nativeFunction, nullptr);
      } finally {
        job.close();
      }
      if (thrown != null) throw thrown!;
      _status(code);
      id = out.value;
      if (id == 0 || _pending.containsKey(id)) throw _failure(9);
      unawaited(_diagnose(diagnostic, 'BEGIN', elapsed));
      final finished = complete.future.then<void>(
        (_) {},
        onError: (Object _, StackTrace _) {},
      );
      _pending[id] = _Request(
        (result) {
          try {
            final value = _withMemory((m) {
              _inspect(m, result);
              return read(m, result);
            });
            unawaited(
              _diagnose(
                diagnostic,
                'COMPLETE',
                elapsed,
                point:
                    diagnostic == 'getWalletState' ||
                        diagnostic == 'inspectWallets'
                    ? 'RESULT_READY'
                    : 'NONE',
              ),
            );
            complete.complete(value);
          } on Object catch (error, stack) {
            unawaited(_diagnose(diagnostic, 'COMPLETE', elapsed, error: error));
            complete.completeError(error, stack);
          }
        },
        (error) {
          unawaited(_diagnose(diagnostic, 'COMPLETE', elapsed, error: error));
          if (!complete.isCompleted) complete.completeError(error);
        },
        finished,
      );
    } on Object catch (error) {
      unawaited(_diagnose(diagnostic, 'COMPLETE', elapsed, error: error));
      rethrow;
    } finally {
      memory.dispose();
    }
    var settled = false;
    final result = complete.future.whenComplete(() {
      settled = true;
    });
    return CitizenSdkOperation<T>(
      operationId: _unsigned(id).toString(),
      result: result,
      cancel: () async {
        if (settled || _closed || _detached) return false;
        final elapsed = Stopwatch()..start();
        unawaited(_diagnose('cancelOperation', 'BEGIN', elapsed));
        final code = _api.citizensdk_cancel_request(_handle, id);
        unawaited(
          _diagnose(
            'cancelOperation',
            'COMPLETE',
            elapsed,
            error: code == 0 ? null : _failure(code),
          ),
        );
        if (code == 4 || code == 7) return false;
        _status(code);
        return true;
      },
    );
  }

  Future<T> _request<T>(
    int Function(_Memory, Pointer<Uint64>) accept,
    T Function(_Memory, int) read, {
    String? diagnostic,
  }) async => _operation(accept, read, diagnostic: diagnostic).result;

  // 只把闭集事实交给既有系统诊断资源；不派发业务，不记录参数、标识或异常正文。
  Future<void> _diagnose(
    String? method,
    String phase,
    Stopwatch elapsed, {
    Object? error,
    String point = 'NONE',
  }) async {
    if (method == null) return;
    final failure = error == null
        ? null
        : error is CitizenSdkException
        ? error
        : _failure(20);
    if (failure != null) {
      for (final known in CitizenSdkDiagnostic.points) {
        if (known != 'NONE' && failure.message.endsWith(' at $known')) {
          point = known;
          break;
        }
      }
    }
    try {
      await _rawResource('diagnose', [
        2,
        _hostId,
        [
          method,
          phase,
          failure == null ? 0 : failure.code.index + 1,
          failure == null ? 0 : failure.stage.index + 1,
          point,
          elapsed.elapsedMilliseconds.clamp(0, 86400000),
        ],
      ]);
    } on Object {
      // 诊断持久化失败不改变原操作和真实资源终态。
    }
  }

  void _remember(Future<void> Function() close) {
    _resources.add(close);
    if (_closing || _closed) throw _failure(22);
  }

  void _forget(Future<void> Function() close) => _resources.remove(close);
  bool _resourceClosed(String id) => _closedResources.contains(id);
  void _acknowledge(String id) {
    if (!_closedResources.remove(id)) _acknowledgedResources.add(id);
  }

  void _markClosed(String id) {
    if (!_acknowledgedResources.remove(id)) _closedResources.add(id);
  }

  void _failEvents(CitizenSdkException error, StackTrace stack) {
    _protocolError ??= error;
    if (!_events.isClosed) _events.addError(error, stack);
    unawaited(_cancelCredentials().catchError((Object _) {}));
  }

  Stream<CitizenSdkEvent> get events => _events.stream;
  CitizenSdkLifecycle get lifecycle => _closed
      ? CitizenSdkLifecycle.disposed
      : _withMemory((m) {
          final out = m.alloc<Uint32>(4);
          _status(_api.citizensdk_get_lifecycle(_handle, out));
          return _enum(CitizenSdkLifecycle.values, out.value, 1);
        });
  Future<void> start() => _request(
    (m, out) => _api.citizensdk_start(_handle, out),
    (m, r) {},
    diagnostic: 'start',
  );
  Future<void> stop() => _request(
    (m, out) => _api.citizensdk_stop(_handle, out),
    (m, r) {},
    diagnostic: 'stop',
  );
  Future<List<CitizenSdkDiagnostic>> readDiagnostics() async {
    final value = await _resource('readDiagnostics', const []);
    if (value.length != 1 ||
        value[0] is! List<Object?> ||
        (value[0]! as List<Object?>).length > 128) {
      throw _failure(9);
    }
    return List.unmodifiable(
      (value[0]! as List<Object?>).map(CitizenSdkDiagnostic.decode),
    );
  }

  Future<T> _ownUi<T>(Future<T> Function() work) {
    final result = work();
    final settled = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    _uiWork.add(settled);
    unawaited(settled.whenComplete(() => _uiWork.remove(settled)));
    return result;
  }

  Future<void> _closeResources() async {
    while (_resources.isNotEmpty) {
      Object? first;
      StackTrace? trace;
      for (final close in _resources.toList()) {
        try {
          await close();
        } on Object catch (error, stack) {
          first ??= error;
          trace ??= stack;
        }
      }
      if (first != null) Error.throwWithStackTrace(first, trace!);
    }
  }

  static Future<bool> verify({
    required String accountId,
    required Uint8List signature,
    required Uint8List payload,
  }) async {
    _checkAbi();
    return _withMemory((m) {
      final out = m.alloc<Uint8>(1);
      _status(
        _api.citizensdk_verify_signature(
          m.account(accountId),
          m.view(signature, 64),
          m.view(payload),
          out,
        ),
      );
      return _boolean(out.value);
    });
  }

  static Future<Uint8List> encodePayload(CitizenSigningPayload payload) async {
    _checkAbi();
    return _withMemory(
      (m) => m
          .copy(
            (b, cap, n) => _api.citizensdk_encode_signing_payload(
              payload.kind,
              m.view(payload.fieldsJson, 4096),
              m.view(payload.payloadBytes),
              b,
              cap,
              n,
            ),
            16 * 1024 * 1024,
          )
          .asUnmodifiableView(),
    );
  }

  Future<void> close() {
    if (_closed) return Future.value();
    return _closeFuture ??= _close();
  }

  Future<void> _close() async {
    _closing = true;
    try {
      // 先请求取消，再等待提交资源释放；释放会等待真实终态，不能挡住取消本身。
      for (final id in _pending.keys.toList()) {
        final elapsed = Stopwatch()..start();
        final code = _api.citizensdk_cancel_request(_handle, id);
        unawaited(
          _diagnose(
            'cancelOperation',
            'COMPLETE',
            elapsed,
            error: code == 0 ? null : _failure(code),
          ),
        );
        if (code != 0 && code != 4 && code != 7) throw _failure(code);
      }
      await _cancelCredentials();
      await _closeResources();
      while (_pending.isNotEmpty) {
        await Future.wait(_pending.values.map((p) => p.finished));
      }
      await _closeResources();
      for (final token in _preparedTransactions.values.toList()) {
        _status(_api.citizensdk_prepared_transaction_release(_handle, token));
      }
      _preparedTransactions.clear();
      if (!_detached) {
        _status(_api.citizensdk_detach(_handle));
        _detached = true;
      }
      await _resource('close', const []);
      _closed = true;
      while (_uiWork.isNotEmpty) {
        await Future.wait(_uiWork.toList());
      }
      await _closeResources();
      _port?.close();
      _instances.remove(_hostId);
      WidgetsBinding.instance.removeObserver(this);
      _closedResources.clear();
      _acknowledgedResources.clear();
      unawaited(_events.close().catchError((Object _) {}));
    } on Object {
      _closeFuture = null;
      rethrow;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) unawaited(_cancelCredentials().catchError((Object _) {}));
  }

  void _receiveCredential(CitizenSdkCredentialRequest event) {
    if (_credentials.containsKey(event.hostOperationId) ||
        _credentials.length >= 64) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.conflict,
        message: '凭据挑战重复或超过并发上限',
      );
    }
    final pending = _Credential(event.hostOperationId);
    _credentials[event.hostOperationId] = pending;
    // 先退出当前事件派发再调用宿主/取消通道，避免同步平台回调重入同一广播流。
    // 立即登记真实完成Future，关闭仍须等待提供者返回及秘密副本finally清零。
    pending.finished = Future<void>.microtask(
      () => _provideCredential(event, pending),
    );
    unawaited(pending.finished.catchError((Object _) {}));
  }

  Future<void> _provideCredential(
    CitizenSdkCredentialRequest event,
    _Credential pending,
  ) async {
    Uint8List? supplied;
    Uint8List? owned;
    try {
      if (_closing ||
          _closed ||
          !_foreground ||
          _protocolError != null ||
          _credentialProvider == null) {
        await _cancelCredential(pending);
        return;
      }
      try {
        supplied = await _credentialProvider(
          CitizenCredentialChallenge(
            hostOperationId: event.hostOperationId,
            keyPurpose: event.keyPurpose,
            accountId: event.accountId,
            cancelled: pending.cancelled.future,
          ),
        );
      } on Object {
        // 宿主异常可能含输入，既不记录、也不作为SDK异常文案或事件转发。
        supplied = null;
      }
      if (pending.revoked ||
          _closing ||
          _closed ||
          !_foreground ||
          _protocolError != null) {
        await _cancelCredential(pending);
        return;
      }
      if (supplied != null && supplied.length > 1024) {
        await _cancelCredential(pending);
        return;
      }
      owned = supplied == null ? null : Uint8List.fromList(supplied);
      // 必须等方法通道完成编码和回包再擦除，不能在返回给codec之前清零。
      await _resource('respondCredential', <Object?>[
        pending.id.toString(),
        owned,
      ]);
    } finally {
      owned?.fillRange(0, owned.length, 0);
      // 只能保证SDK自己的副本；不承诺擦除宿主的只读视图或任意额外副本。
      try {
        supplied?.fillRange(0, supplied.length, 0);
      } on UnsupportedError {
        /* 宿主只读副本。 */
      }
      if (identical(_credentials[pending.id], pending)) {
        _credentials.remove(pending.id);
      }
    }
  }

  Future<void> _cancelCredential(_Credential pending) async {
    pending.revoke();
    if (_closed) return;
    try {
      await _resource('cancelCredential', <Object?>[pending.id.toString()]);
    } on CitizenSdkException catch (error) {
      // 精确请求已终结时的取消无副作用；其他失败不能伪装成原生排空成功。
      if (error.code != CitizenSdkErrorCode.invalidState &&
          error.code != CitizenSdkErrorCode.notFound) {
        rethrow;
      }
    }
  }

  Future<void> _cancelCredentials() async {
    final pending = List<_Credential>.of(_credentials.values);
    for (final request in pending) {
      request.revoke();
    }
    for (final request in pending) {
      await _cancelCredential(request);
    }
    // 取消通知不代替提供者实际返回；关闭等待秘密副本的finally真正完成。
    for (final request in pending) {
      try {
        await request.finished;
      } on Object {
        /* 原始操作通过自己的结果报告失败。 */
      }
    }
  }

  void _nativeEvent(List<Object?> raw) {
    try {
      final kind = raw[3]! as String,
          payload = raw[4]! as List<Object?>,
          sequence = _eventSequence++;
      switch (kind) {
        case 'credentialRequest':
          if (payload.length != 3 ||
              payload[0] is! String ||
              payload[1] is! String ||
              payload[2] != null && payload[2] is! String) {
            throw _failure(9);
          }
          _receiveCredential(
            CitizenSdkCredentialRequest(
              sequence: sequence,
              hostOperationId: BigInt.parse(payload[0]! as String),
              keyPurpose: payload[1]! as String,
              accountId: payload[2] as String?,
            ),
          );
        case 'credentialCancelled':
          if (payload.length != 1 || payload[0] is! String) throw _failure(9);
          _credentials[BigInt.parse(payload[0]! as String)]?.revoke();
        case 'privateKeyClosed':
          if (payload.length != 1 || payload[0] is! String) throw _failure(9);
          final id = payload[0]! as String;
          _markClosed(id);
          _events.add(
            CitizenSdkPrivateKeyClosed(sequence: sequence, resourceId: id),
          );
        case 'qrCaptureClosed':
          if (payload.length != 1 || payload[0] is! String) throw _failure(9);
          final id = payload[0]! as String;
          _markClosed(id);
          _events.add(
            CitizenSdkQrCaptureEvent(
              sequence: sequence,
              resourceId: id,
              closed: true,
            ),
          );
        case 'qrCapturePreview':
          if (payload.length != 4 || payload[0] is! String) throw _failure(9);
          _events.add(
            CitizenSdkQrCaptureEvent(
              sequence: sequence,
              resourceId: payload[0]! as String,
              preview: _preview(payload.sublist(1)),
            ),
          );
        case 'qrCaptureResult':
          if (payload.length != 3 ||
              payload[0] is! String ||
              payload[1] is! int ||
              payload[2] is! String) {
            throw _failure(9);
          }
          final purpose = CitizenQrScanPurpose.values.firstWhere(
            (p) => p.value == payload[1],
          );
          _events.add(
            CitizenSdkQrCaptureEvent(
              sequence: sequence,
              resourceId: payload[0]! as String,
              result: CitizenQrScanResult(
                purpose: purpose,
                document: _document(payload[2]! as String),
              ),
            ),
          );
        case 'qrCaptureError':
          if (payload.length != 4 ||
              payload[0] is! String ||
              payload[1] is! int ||
              payload[3] is! int) {
            throw _failure(9);
          }
          _events.add(
            CitizenSdkQrCaptureEvent(
              sequence: sequence,
              resourceId: payload[0]! as String,
              error: _failure(payload[1]! as int, '采集失败', payload[3]! as int),
            ),
          );
      }
    } on Object catch (error, stack) {
      _failEvents(error is CitizenSdkException ? error : _failure(9), stack);
    }
  }
}

final class _Request {
  _Request(this.deliver, this.fail, this.finished);
  final void Function(int) deliver;
  final void Function(Object) fail;
  final Future<void> finished;
}

final class _Credential {
  _Credential(this.id);
  final BigInt id;
  final Completer<void> cancelled = Completer<void>();
  Future<void> finished = Future<void>.value();
  bool revoked = false;
  void revoke() {
    if (revoked) return;
    revoked = true;
    cancelled.complete();
  }
}
