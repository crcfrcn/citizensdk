part of '../citizen_sdk.dart';

/// 与 CitizenSDK C ABI 2 一一对应的稳定错误分类。
enum CitizenSdkErrorCode {
  invalidArgument,
  invalidHandle,
  invalidState,
  unsupported,
  unavailable,
  notReady,
  notFound,
  conflict,
  integrity,
  authenticationCancelled,
  authenticationRequired,
  keyInvalidated,
  permissionDenied,
  storage,
  network,
  decode,
  timeout,
  busy,
  queueFull,
  internal,
  panic,
  cancelled,
}

/// 与错误类别正交的通用失败阶段；数值由 C ABI 冻结，不能承载 App 业务语义。
enum CitizenSdkFailureStage {
  admission,
  validation,
  authentication,
  persistence,
  provider,
  verification,
  cancellation,
  teardown,
}

/// 原生 Core、宿主服务或严格 channel 解码返回的稳定异常。
final class CitizenSdkException implements Exception {
  const CitizenSdkException({
    required this.code,
    CitizenSdkFailureStage? stage,
    required this.message,
    this.method,
    this.sessionId,
    this.requestSequence,
  }) : _stage = stage;

  final CitizenSdkErrorCode code;
  final CitizenSdkFailureStage? _stage;
  CitizenSdkFailureStage get stage =>
      _stage ??
      switch (code) {
        CitizenSdkErrorCode.invalidArgument ||
        CitizenSdkErrorCode.decode => CitizenSdkFailureStage.validation,
        CitizenSdkErrorCode.authenticationCancelled ||
        CitizenSdkErrorCode.authenticationRequired ||
        CitizenSdkErrorCode.keyInvalidated ||
        CitizenSdkErrorCode.permissionDenied =>
          CitizenSdkFailureStage.authentication,
        CitizenSdkErrorCode.storage => CitizenSdkFailureStage.persistence,
        CitizenSdkErrorCode.unavailable ||
        CitizenSdkErrorCode.network ||
        CitizenSdkErrorCode.timeout => CitizenSdkFailureStage.provider,
        CitizenSdkErrorCode.integrity => CitizenSdkFailureStage.verification,
        CitizenSdkErrorCode.cancelled => CitizenSdkFailureStage.cancellation,
        CitizenSdkErrorCode.internal ||
        CitizenSdkErrorCode.panic => CitizenSdkFailureStage.teardown,
        _ => CitizenSdkFailureStage.admission,
      };
  final String message;

  /// 失败跨公开调用边界后，必须属于现行通道方法闭集；边界前可为空。
  final String? method;
  final String? sessionId;
  final int? requestSequence;

  @override
  String toString() =>
      'CitizenSdkException(${code.name}/${stage.name}${method == null ? '' : '@$method'}): $message';
}

/// SDK安全诊断只携带闭集事实；不接受异常原文、账户或秘密。
final class CitizenSdkDiagnostic {
  const CitizenSdkDiagnostic._(
    this.method,
    this.phase,
    this.code,
    this.stage,
    this.point,
    this.elapsedMillis,
  );
  final String method;
  final String phase;
  final int code;
  final int stage;
  final String point;
  final int elapsedMillis;
  static const methods = {
    'open',
    'start',
    'stop',
    'getSyncStatus',
    'getWalletState',
    'inspectWallets',
    'releaseWalletInspection',
    'cancelOperation',
  };
  static const points = {
    'NONE',
    'ADMISSION',
    'LOCAL_READ',
    'RESULT_READY',
    'RESTORE',
    'BEGIN',
    'PUBLISH_BEGIN',
    'PROVIDER_START',
    'REFRESH',
    'COMPLETE',
    'SERVICES',
    'PUBLISH_COMPLETE',
  };
  factory CitizenSdkDiagnostic.decode(Object? input) {
    if (input is! List<Object?> ||
        input.length != 6 ||
        !methods.contains(input[0]) ||
        !{'ADMISSION', 'BEGIN', 'DECODE', 'COMPLETE'}.contains(input[1]) ||
        input[2] is! int ||
        (input[2] as int) < 0 ||
        (input[2] as int) > 22 ||
        input[3] is! int ||
        (input[3] as int) < 0 ||
        (input[3] as int) > 8 ||
        !points.contains(input[4]) ||
        input[5] is! int ||
        (input[5] as int) < 0 ||
        (input[5] as int) > 86400000) {
      throw const CitizenSdkException(
        code: CitizenSdkErrorCode.decode,
        message: 'SDK安全诊断结构无效',
      );
    }
    return CitizenSdkDiagnostic._(
      input[0] as String,
      input[1] as String,
      input[2] as int,
      input[3] as int,
      input[4] as String,
      input[5] as int,
    );
  }
  @override
  String toString() =>
      'method=$method phase=$phase code=$code stage=$stage point=$point elapsed_ms=$elapsedMillis';
}
