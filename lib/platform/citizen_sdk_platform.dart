/// CitizenSDK Flutter transport boundary.
///
/// Implementations transport only fixed-position List tuples. Core, wallet, signing and transaction
/// behavior remains native; this interface is intentionally not exported from the package root.
abstract interface class CitizenSdkPlatform {
  /// 仅供 binding 合同测试或后续平台投影替换；受支持平台的正式 Flutter 默认值由公开 client 安装。
  static CitizenSdkPlatform? instance;

  Future<Object?> invoke(String method, List<Object?> arguments);

  Stream<Object?> get events;
}
