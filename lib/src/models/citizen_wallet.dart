import 'dart:typed_data';

import 'citizen_account.dart';

enum CitizenWalletOrigin { created, imported }

/// 账户由本机热钱包签名，或由独立公民钱包通过二维码完成冷签名。
enum CitizenWalletSignMode { hot, cold }

/// 真实目录的初始化事实；读取失败用异常表达，不能冒充empty。
enum CitizenWalletInitializationState { empty, ready, recovering }

/// 异常原因是只读诊断，不构成第三种签名模式。
enum CitizenWalletDiagnosticReason {
  invalidSignMode,
  invalidIdentity,
  invalidStructure,
}

/// 来自Core同一精确目标校验的公开关联，不是执行权限，不含秘密引用。
final class CitizenWalletCleanupTargets {
  CitizenWalletCleanupTargets({
    required List<String> accountIds,
    required this.deleteWalletWideKey,
  }) : accountIds = List<String>.unmodifiable(accountIds);
  final List<String> accountIds;
  final bool deleteWalletWideKey;
}

final class CitizenWalletDiagnostic {
  const CitizenWalletDiagnostic({
    required this.walletIndex,
    required this.walletName,
    required this.accountId,
    required this.ss58Address,
    required this.diagnosticReason,
    required this.signMode,
    required this.cleanupTargets,
  });
  final int walletIndex;
  final String walletName;
  final String accountId;
  final String? ss58Address;
  final CitizenWalletDiagnosticReason diagnosticReason;
  final CitizenWalletSignMode? signMode;
  final CitizenWalletCleanupTargets? cleanupTargets;
}

/// 同实例真实快照资源；动作由Core复核原记录，不使用宿主回传字段作为修复依据。
abstract interface class CitizenWalletInspection {
  CitizenWalletState get state;
  CitizenSdkOperation<CitizenWalletState> repairHot(int walletIndex);
  CitizenSdkOperation<CitizenWalletState> rename({
    required int walletIndex,
    required String name,
  });
  CitizenSdkOperation<CitizenWalletState> delete(int walletIndex);
  Future<void> release();
}

/// Core唯一输入校验结果；枚举值与公开C合同一致，不包含界面文案。
enum CitizenWalletInputReason {
  valid,
  inputTooLong,
  wordCount,
  unknownWord,
  checksum,
  passwordFormat,
  mnemonicFormat,
  passwordLength,
  passwordNormalization,
}

final class CitizenWalletInputValidation {
  const CitizenWalletInputValidation({required this.reason, this.position});
  final CitizenWalletInputReason reason;

  /// 仅unknownWord有零起始位置，不回显对应秘密单词。
  final int? position;
  bool get isValid => reason == CitizenWalletInputReason.valid;
}

/// SDK绑定的序号输入转换；范围、重复与钱包归属仍只由实际Core追加操作判断。
final class CitizenWalletAccountIndices {
  const CitizenWalletAccountIndices._(this.indices, this.invalidToken);
  final List<int>? indices;
  final String? invalidToken;
  static CitizenWalletAccountIndices parse(String raw) {
    final tokens = raw
        .trim()
        .split(RegExp(r'\s+'))
        .where((token) => token.isNotEmpty);
    final indices = <int>[];
    for (final token in tokens) {
      final value = int.tryParse(token);
      if (value == null) return CitizenWalletAccountIndices._(null, token);
      indices.add(value);
    }
    return CitizenWalletAccountIndices._(List<int>.unmodifiable(indices), null);
  }
}

/// 已接纳调用的关联对象；取消只转发请求，不在宿主伪造底层终态。
final class CitizenSdkOperation<T> {
  CitizenSdkOperation({
    required this.operationId,
    required this.result,
    required Future<bool> Function() cancel,
  }) : _cancel = cancel;

  final String operationId;
  final Future<T> result;
  final Future<bool> Function() _cancel;
  Future<bool> cancel() => _cancel();
}

/// SDK拥有的创建准备资源；不含窗口，也不允许直接构造Core句柄。
abstract interface class CitizenSdkPreparedWallet {
  Future<CitizenSdkRecoveryPhrase> recoveryPhrase();
  CitizenSdkOperation<CitizenWalletProfile> commit();
  Future<void> release();
}

/// 原备份UI所需的受控UTF-8副本；显示关闭后释放，不写日志或明文持久存储。
abstract interface class CitizenSdkRecoveryPhrase {
  Uint8List get bytes;
  Future<void> release();
}

/// 显式私钥查看资源。reveal只表示数据交付，closed才表示真实认证和回调排空。
abstract interface class CitizenSdkPrivateKey {
  Future<Uint8List> reveal();
  Future<void> close();
  Future<void> get closed;
}

/// 平台请求实际凭据的功能事实；宿主决定输入UI，SDK继续负责实际密钥操作。
final class CitizenCredentialChallenge {
  const CitizenCredentialChallenge({
    required this.hostOperationId,
    required this.keyPurpose,
    required this.cancelled,
    this.accountId,
  });
  final BigInt hostOperationId;
  final String keyPurpose;
  final String? accountId;

  /// SDK撤销交付时完成；宿主应关闭自己的输入交互并终结提供者Future。
  final Future<void> cancelled;
}

/// SDK派生能力支持的BIP39词数；数值直接作为原生合同，不包含界面定义。
enum CitizenWalletWordCount {
  words12(12),
  words18(18),
  words24(24);

  const CitizenWalletWordCount(this.value);

  final int value;
}

/// 一只无根热钱包的公开资料；不包含 generation、secret owner 或任何秘密。
final class CitizenWalletProfile {
  CitizenWalletProfile({
    required this.walletIndex,
    required this.walletName,
    required this.masterAccountId,
    required this.origin,
    required this.createdAtMillis,
    required this.activeAccountId,
    required List<CitizenAccount> accounts,
  }) : accounts = List<CitizenAccount>.unmodifiable(accounts);

  final int walletIndex;

  /// 钱包级本机标签；与账户0的name独立。
  final String walletName;
  final String masterAccountId;
  final CitizenWalletOrigin origin;
  final BigInt createdAtMillis;
  final String activeAccountId;
  final List<CitizenAccount> accounts;

  CitizenAccount? accountById(String accountId) {
    for (final account in accounts) {
      if (account.accountId == accountId) return account;
    }
    return null;
  }

  /// 仅供原副标题显示；不能把此提示当作提交编号，真正分配由Core操作门完成。
  int? get nextAccountIndex {
    if (accounts.isEmpty) return null;
    final maximum = accounts
        .map((account) => account.index)
        .reduce((a, b) => a > b ? a : b);
    return maximum >= 1989 ? null : maximum + 1;
  }
}

/// 统一钱包目录中的一个公开账户，不包含秘密引用或设备密钥状态。
final class CitizenWalletStateAccount {
  CitizenWalletStateAccount({
    required this.signMode,
    required this.walletIndex,
    required this.accountIndex,
    required this.accountId,
    required this.ss58Address,
    required this.name,
    required this.createdAtMillis,
    required this.isDefault,
  });

  final CitizenWalletSignMode signMode;
  final int walletIndex;
  final int? accountIndex;
  final String accountId;
  final String ss58Address;
  final String name;
  final BigInt createdAtMillis;
  final bool isDefault;
}

/// 热钱包和仅公钥冷账户的一次稳定、全局有序公开快照。
final class CitizenWalletState {
  CitizenWalletState({
    required this.revision,
    this.activeWalletIndex,
    required this.hotProfile,
    required List<CitizenWalletStateAccount> accounts,
    required this.initializationState,
    required this.cleanupPending,
    List<CitizenWalletDiagnostic> diagnostics = const [],
  }) : accounts = List<CitizenWalletStateAccount>.unmodifiable(accounts),
       diagnostics = List<CitizenWalletDiagnostic>.unmodifiable(diagnostics);

  final BigInt revision;

  /// 当前付款钱包，不代表全局默认账户或热钱包内部activeAccountId。
  final int? activeWalletIndex;
  final CitizenWalletProfile? hotProfile;
  final List<CitizenWalletStateAccount> accounts;
  final CitizenWalletInitializationState initializationState;
  final bool cleanupPending;
  final List<CitizenWalletDiagnostic> diagnostics;

  /// 只连接同一快照内的付款钱包与其账户；热钱包使用钱包锚点而非热当前账户。
  CitizenWalletStateAccount? get activeWalletAccount {
    final index = activeWalletIndex;
    if (index == null) return null;
    for (final account in accounts) {
      if (account.walletIndex == index &&
          (account.signMode == CitizenWalletSignMode.cold ||
              account.accountId == hotProfile?.masterAccountId)) {
        return account;
      }
    }
    return null;
  }

  /// 默认账户只能从全局顺序第一项读取；第 1.2 步不提供无授权写入口。
  CitizenWalletStateAccount? get defaultAccount =>
      accounts.isEmpty ? null : accounts.first;
}

/// sr25519 的公开签名结果；消息及私钥生命周期不进入该模型。
final class CitizenWalletSignature {
  CitizenWalletSignature({required this.accountId, required Uint8List bytes})
    : bytes = Uint8List.fromList(bytes) {
    if (this.bytes.length != 64) {
      throw ArgumentError.value(this.bytes.length, 'bytes', '必须是 64 字节');
    }
  }

  final String accountId;
  final Uint8List bytes;
}

/// 一次授权操作的应用材料；使用结束后立即清零钥及签名副本。
final class CitizenApplicationKeyPreparation {
  const CitizenApplicationKeyPreparation({required this.keys, this.signature});
  final List<Uint8List> keys;
  final Uint8List? signature;
  void dispose() {
    for (final key in keys) {
      key.fillRange(0, key.length, 0);
    }
    final value = signature;
    if (value != null) value.fillRange(0, value.length, 0);
  }
}
