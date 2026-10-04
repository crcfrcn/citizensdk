import 'package:flutter/services.dart';

import '../api/citizen_sdk_error.dart';
import 'citizen_sdk_flutter_codec.dart';
import 'citizen_sdk_platform.dart';

/// CitizenSDK 官方 binding 共用的唯一 Flutter transport。
///
/// Android、iOS、macOS、Linux 与 Windows 使用相同的固定
/// MethodChannel tuple 方法和 EventChannel 事件合同。Linux/Windows 实际平台验证
/// 由统一 CI/Release 执行；注册不等于已运行。transport 不携带平台分支、
/// Map或Core裸句柄。仅明确输入/备份/显式查看及派生钥操作传输受控敏感数据，
/// 不提供窗口或文案，同版原生插件缺失时返回unsupported。
final class FlutterCitizenSdkPlatform implements CitizenSdkPlatform {
  FlutterCitizenSdkPlatform({
    MethodChannel? methodChannel,
    EventChannel? eventChannel,
    CitizenSdkFlutterCodec codec = const CitizenSdkFlutterCodec(),
  }) : _methodChannel =
           methodChannel ?? const MethodChannel('citizen/sdk/core/v2'),
       _eventChannel =
           eventChannel ?? const EventChannel('citizen/sdk/events/v2'),
       _codec = codec;

  static const String methodChannelName = 'citizen/sdk/core/v2';
  static const String eventChannelName = 'citizen/sdk/events/v2';

  final MethodChannel _methodChannel;
  final EventChannel _eventChannel;
  final CitizenSdkFlutterCodec _codec;

  late final Stream<Object?> _events = _eventChannel.receiveBroadcastStream(
    const <Object?>[CitizenSdkFlutterCodec.protocolVersion],
  ).cast<Object?>();

  @override
  Stream<Object?> get events => _events;

  @override
  Future<Object?> invoke(String method, List<Object?> arguments) async {
    try {
      return await _methodChannel.invokeMethod<Object?>(method, arguments);
    } on PlatformException catch (error) {
      throw _codec.decodePlatformException(error, expectedMethod: method);
    } on MissingPluginException catch (error) {
      throw CitizenSdkException(
        code: CitizenSdkErrorCode.unsupported,
        stage: CitizenSdkFailureStage.admission,
        method: method,
        message: error.message ?? 'CitizenSDK Flutter binding 未安装',
      );
    }
  }
}
