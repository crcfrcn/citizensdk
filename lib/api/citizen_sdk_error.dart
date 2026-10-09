/// 与 CitizenSDK C ABI v1 一一对应的稳定错误分类。
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
  CitizenSdkFailureStage get stage => _stage ?? switch (code) {
    CitizenSdkErrorCode.invalidArgument || CitizenSdkErrorCode.decode =>
      CitizenSdkFailureStage.validation,
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
    CitizenSdkErrorCode.internal || CitizenSdkErrorCode.panic =>
      CitizenSdkFailureStage.teardown,
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
