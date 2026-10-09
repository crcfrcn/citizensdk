/// 实例启用的模块位集合；依赖关系由同一 Rust 核心校验。
///
/// 钱包管理和签名分别选择。组合只改变装配，不改变算法或安全金库要求。
abstract final class CitizenSdkModules {
  static const int wallet = 1;
  static const int signing = 2;
  static const int chain = 4;
  static const int transactions = 8;
  static const int history = 16;
  static const int qr = 32;
  static const int full =
      wallet | signing | chain | transactions | history | qr;
}

/// CitizenSDK Core 可以组合的固定能力。
enum CitizenCapabilityName {
  chainRead,
  transactionBuild,
  transactionSubmit,
  transactionVerify,
  walletProfile,
  localSigning,
  hardwareVault,
  userAuthentication,
  history,
  backgroundSync,
}

/// 能力当前不可用或未就绪的稳定原因。
enum CitizenCapabilityReason {
  none,
  buildUnsupported,
  deviceUnavailable,
  hostDisabled,
  engineNotRunning,
  dependencyNotReady,
  userAuthenticationRequired,
  vaultLocked,
  chainStarting,
  chainUnsynced,
  storageUnavailable,
}

/// 一项能力的四层事实：构建支持、设备可用、宿主启用和当前就绪。
final class CitizenCapabilityStatus {
  const CitizenCapabilityStatus({
    required this.name,
    required this.supported,
    required this.available,
    required this.enabled,
    required this.ready,
    required this.reason,
  });

  final CitizenCapabilityName name;
  final bool supported;
  final bool available;
  final bool enabled;
  final bool ready;
  final CitizenCapabilityReason reason;
}

/// 同一 Engine 修订下的十项完整能力快照。
final class CitizenCapabilitySnapshot {
  CitizenCapabilitySnapshot({
    required this.revision,
    required List<CitizenCapabilityStatus> statuses,
  }) : statuses = List<CitizenCapabilityStatus>.unmodifiable(statuses) {
    if (this.statuses.length != CitizenCapabilityName.values.length) {
      throw ArgumentError.value(
        this.statuses.length,
        'statuses',
        '必须包含全部 ${CitizenCapabilityName.values.length} 项能力',
      );
    }
    if (this.statuses.map((status) => status.name).toSet().length !=
        CitizenCapabilityName.values.length) {
      throw ArgumentError('statuses 包含重复或缺失的能力');
    }
  }

  final BigInt revision;
  final List<CitizenCapabilityStatus> statuses;

  CitizenCapabilityStatus operator [](CitizenCapabilityName name) =>
      statuses.singleWhere((status) => status.name == name);
}
