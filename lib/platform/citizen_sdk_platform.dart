/// CitizenSDK Flutter transport boundary.
///
/// SDK内部用固定List投影公开模型；正式实现由Dart FFI直接调用同一Rust C ABI。
/// 平台通道只保留系统资源与UI，业务行为归Rust；此接口不从包根导出。
abstract interface class CitizenSdkPlatform {
  /// 仅供 binding 合同测试或后续平台投影替换；受支持平台的正式 Flutter 默认值由公开 client 安装。
  static CitizenSdkPlatform? instance;

  Future<Object?> invoke(String method, List<Object?> arguments);

  Stream<Object?> get events;
}
