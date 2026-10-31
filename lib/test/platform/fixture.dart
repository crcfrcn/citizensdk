// ignore_for_file: depend_on_referenced_packages
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:citizen_sdk/platform/bind.dart' as c;
import 'package:ffi/ffi.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// App和SDK测试复用同一真实Core/SQLite/ZXing会话；仅模拟系统资源边界。
/// 原生测试库由本轮正式构建提供，禁止回退到旧协议或业务结果处理器。
class CitizenSdkTestFixture {
  static final path = Platform.environment['CITIZENSDK_TEST_LIBRARY'];
  late final library = DynamicLibrary.open(path!);
  late final api = c.Bindings(DynamicLibrary.open(path!));
  late final open = library
      .lookupFunction<Uint64 Function(Uint32), int Function(int)>(
        'citizensdk_test_open',
      );
  late final close = library
      .lookupFunction<Int32 Function(Uint64), int Function(int)>(
        'citizensdk_test_close',
      );
  late final vault = library
      .lookupFunction<Int32 Function(Uint64, Int32), int Function(int, int)>(
        'citizensdk_test_vault',
      );
  late final vaultPending = library
      .lookupFunction<Int32 Function(Uint64), int Function(int)>(
        'citizensdk_test_vault_pending',
      );
  late final vaultComplete = library
      .lookupFunction<Int32 Function(Uint64, Int32), int Function(int, int)>(
        'citizensdk_test_vault_complete',
      );
  static const method = MethodChannel('citizen/sdk/core/v2'),
      events = MethodChannel('citizen/sdk/events/v2');
  final handles = <String, int>{};
  var calls = <String>[];
  var malformed = false;
  var physicalUi = false, earlyCameraClose = false, rejectDiagnostic = false;
  Completer<Uint8List>? revealBytes;
  Completer<void>? cameraDrain;
  Completer<void>? cameraOpen;
  CitizenSdkErrorCode? cameraError;
  final nativeResources = <String>{};
  final _eventSequences = <String, int>{};
  void emit(String kind, List<Object?> payload, {String? hostId}) {
    final id = hostId ?? handles.keys.single;
    final sequence = (_eventSequences[id] ?? 0) + 1;
    _eventSequences[id] = sequence;
    ServicesBinding.instance.channelBuffers.push(
      'citizen/sdk/events/v2',
      const StandardMethodCodec().encodeSuccessEnvelope([
        2,
        id,
        sequence,
        kind,
        payload,
      ]),
      (_) {},
    );
  }

  /// 有限相机输入直接使用公开生成绑定调用真实Core；转发Core自己的JSON，不复制协议投影。
  void scanText(String text, CitizenQrScanPurpose purpose, {String? hostId}) {
    final id = hostId ?? handles.keys.single;
    if (!nativeResources.contains('$id:camera')) {
      throw StateError('没有本会话的活动相机资源');
    }
    final source = utf8.encode(text);
    final bytes = calloc<Uint8>(source.isEmpty ? 1 : source.length);
    final view = calloc<c.citizensdk_bytes_view>(), count = calloc<Uint64>();
    Pointer<Uint8> output = nullptr;
    var outputSize = 0;
    try {
      bytes.asTypedList(source.length).setAll(0, source);
      view.ref.data = bytes;
      view.ref.len = source.length;
      var code = api.citizensdk_qr_parse(
        handles[id]!,
        view.ref,
        purpose.value,
        nullptr,
        0,
        count,
      );
      if (code != 0) throw StateError('Core拒绝摄像输入：$code');
      if (count.value <= 0 || count.value > 65536) {
        throw StateError('Core摄像结果长度不合法');
      }
      final size = count.value;
      outputSize = size;
      output = calloc<Uint8>(size);
      code = api.citizensdk_qr_parse(
        handles[id]!,
        view.ref,
        purpose.value,
        output,
        size,
        count,
      );
      if (code != 0 || count.value != size) {
        throw StateError('Core摄像结果读取失败：$code');
      }
      emit('qrCaptureResult', [
        'camera',
        purpose.value,
        utf8.decode(output.asTypedList(size)),
      ], hostId: id);
    } finally {
      bytes.asTypedList(source.length).fillRange(0, source.length, 0);
      if (output != nullptr) {
        output.asTypedList(outputSize).fillRange(0, outputSize, 0);
        calloc.free(output);
      }
      calloc.free(count);
      calloc.free(view);
      calloc.free(bytes);
    }
  }

  final diagnosticRows = <List<Object?>>[];
  void install() {
    if (path == null ||
        !(Platform.isWindows
            ? RegExp(r'^[A-Za-z]:[\\/]').hasMatch(path!)
            : path!.startsWith('/'))) {
      throw StateError('需要本轮正式Core/SQLite/ZXing夹具绝对路径');
    }

    calls = [];
    malformed = false;
    physicalUi = false;
    earlyCameraClose = false;
    rejectDiagnostic = false;
    revealBytes = null;
    cameraDrain = null;
    cameraOpen = null;
    cameraError = null;
    nativeResources.clear();
    diagnosticRows.clear();
    _eventSequences.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(events, (call) async => null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(method, (call) async {
          calls.add(call.method);
          final args = call.arguments! as List<Object?>;
          if (call.method == 'open') {
            final handle = open(args[1]! as int);
            if (handle == 0) throw StateError('真实Core创建失败');
            final id = 'sdk-$handle';
            handles[id] = handle;
            return [
              2,
              id,
              0,
              malformed
                  ? <Object?>['created', 1]
                  : <Object?>[
                      'created',
                      1,
                      BigInt.from(handle).toUnsigned(64).toString(),
                    ],
            ];
          }
          if (call.method == 'close') {
            final id = args[1]! as String, handle = handles[id]!;
            expect(nativeResources.where((r) => r.startsWith('$id:')), isEmpty);
            expect(
              api.citizensdk_accept_request_sequence(handle, args[2]! as int),
              0,
            );
            var status = 18;
            for (var i = 0; i < 200 && status == 18; i++) {
              status = close(handle);
              if (status == 18) {
                await Future<void>.delayed(const Duration(milliseconds: 5));
              }
            }
            expect(status, 0);
            handles.remove(id);
            return [
              2,
              id,
              args[2],
              ['disposed'],
            ];
          }
          if (call.method == 'diagnose') {
            if (rejectDiagnostic) {
              throw StateError('finite diagnostic IO failure');
            }
            final row = List<Object?>.of(args[2]! as List<Object?>);
            CitizenSdkDiagnostic.decode(row);
            diagnosticRows.add(row);
            if (diagnosticRows.length > 128) diagnosticRows.removeAt(0);
            return [2, args[1], 0, <Object?>[]];
          }
          if (call.method == 'readDiagnostics') {
            expect(
              api.citizensdk_accept_request_sequence(
                handles[args[1]]!,
                args[2]! as int,
              ),
              0,
            );
            return [
              2,
              args[1],
              args[2],
              [List<List<Object?>>.of(diagnosticRows)],
            ];
          }
          // 只模拟物理显示/相机确认与排空；不提供钱包、签名、链或QR业务结果。
          if (physicalUi) {
            expect(
              api.citizensdk_accept_request_sequence(
                handles[args[1]]!,
                args[2]! as int,
              ),
              0,
            );
            List<Object?> value;
            switch (call.method) {
              case 'openPrivateKey':
                nativeResources.add('${args[1]}:private');
                value = ['private'];
              case 'revealPrivateKey':
                revealBytes = Completer<Uint8List>();
                value = [await revealBytes!.future];
              case 'closePrivateKey':
                if (revealBytes != null) await revealBytes!.future;
                nativeResources.remove('${args[1]}:private');
                value = [];
              case 'openQrCapture':
                final error = cameraError;
                if (error != null) {
                  throw PlatformException(
                    code: 'citizensdk.${error.name}',
                    details: [
                      2,
                      args[1],
                      args[2],
                      error.index + 1,
                      CitizenSdkFailureStage.admission.index + 1,
                      call.method,
                      'finite physical camera failure',
                    ],
                  );
                }
                nativeResources.add('${args[1]}:camera');
                await cameraOpen?.future;
                if (earlyCameraClose) {
                  emit('qrCaptureClosed', [
                    'camera',
                  ], hostId: args[1]! as String);
                  await Future<void>.delayed(Duration.zero);
                }
                value = ['camera', 4, 320, 240, 0];
              case 'closeQrCapture':
                await cameraDrain?.future;
                nativeResources.remove('${args[1]}:camera');
                value = [];
              case 'resumeQrCapture':
              case 'pauseQrCapture':
              case 'setQrCaptureTorch':
                value = [];
              default:
                throw StateError('non-resource UI call');
            }
            return [2, args[1], args[2], value];
          }
          throw StateError('业务调用进入了系统资源通道：${call.method}');
        });
  }

  Future<void> dispose() async {
    expect(handles, isEmpty);
    expect(nativeResources, isEmpty);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(method, null);

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(events, null);
  }
}
