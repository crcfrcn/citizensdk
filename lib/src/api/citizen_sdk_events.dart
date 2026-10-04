import '../models/citizen_capability.dart';
import '../models/citizen_chain_state.dart';
import 'citizen_qr.dart';
import 'citizen_sdk_error.dart';

sealed class CitizenSdkEvent {
  const CitizenSdkEvent({required this.sequence});

  final int sequence;
}

/// 绑定内部消费的非秘密认证挑战；不向CitizenSdk.events公共流重放。
final class CitizenSdkCredentialRequest extends CitizenSdkEvent {
  const CitizenSdkCredentialRequest({required super.sequence,
    required this.hostOperationId, required this.keyPurpose, this.accountId});
  final BigInt hostOperationId;
  final String keyPurpose;
  final String? accountId;
}

/// 实际Host已撤销此挑战；不包含输入、认证结果或设备秘密。
final class CitizenSdkCredentialCancelled extends CitizenSdkEvent {
  const CitizenSdkCredentialCancelled({required super.sequence, required this.hostOperationId});
  final BigInt hostOperationId;
}

/// 历史已变化；通过现有历史查询读取最新快照，不携带账户秘密或借用能力版本。
final class CitizenSdkHistoryChanged extends CitizenSdkEvent {
  const CitizenSdkHistoryChanged({required super.sequence});
}

/// 钱包可能发生持久变化；接收者回读SDK目录，不能从通知推断写入成功。
final class CitizenSdkWalletChanged extends CitizenSdkEvent {
  const CitizenSdkWalletChanged({required super.sequence});
}

/// 仅按实例内资源路由；不承载UI定义，不复用Core的钱包失效事件编号。
final class CitizenSdkQrCaptureEvent extends CitizenSdkEvent {
  const CitizenSdkQrCaptureEvent({required super.sequence, required this.resourceId,
    this.result, this.error, this.preview, this.closed = false});
  final String resourceId;
  final CitizenQrScanResult? result;
  final CitizenSdkException? error;
  final CitizenQrPreview? preview;
  final bool closed;
}

/// 私钥真实请求已排空；资源所有者立即清屏/清零，不携带私钥或认证结果。
final class CitizenSdkPrivateKeyClosed extends CitizenSdkEvent {
  const CitizenSdkPrivateKeyClosed({required super.sequence, required this.resourceId});
  final String resourceId;
}

/// 同一 SDK 轻节点已经验证的新 finalized block。
final class CitizenSdkFinalizedBlockChanged extends CitizenSdkEvent {
  const CitizenSdkFinalizedBlockChanged({
    required super.sequence,
    required this.finalized,
  });

  final CitizenBlockRef finalized;
}

final class CitizenSdkLifecycleChanged extends CitizenSdkEvent {
  const CitizenSdkLifecycleChanged({
    required super.sequence,
    required this.lifecycle,
  });

  final CitizenSdkLifecycle lifecycle;
}

final class CitizenSdkCapabilitiesChanged extends CitizenSdkEvent {
  const CitizenSdkCapabilitiesChanged({
    required super.sequence,
    required this.snapshot,
  });

  final CitizenCapabilitySnapshot snapshot;
}
