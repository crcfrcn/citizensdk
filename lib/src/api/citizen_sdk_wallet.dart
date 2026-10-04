import 'dart:typed_data';

import '../models/citizen_signing.dart';
import '../models/citizen_wallet.dart';

/// 通用无UI钱包能力；界面、文字和导航由宿主拥有，所有规则与真实状态由SDK提供。
abstract interface class CitizenSdkWallet {
  CitizenSdkOperation<CitizenWalletState> getState();
  CitizenSdkOperation<CitizenWalletInspection> inspect();
  Future<CitizenWalletInputValidation> validatePassword(String password);
  Future<CitizenWalletInputValidation> validateMnemonic(
    String mnemonic,
    CitizenWalletWordCount wordCount,
  );
  Future<List<String>> wordSuggestions(String prefix);
  CitizenSdkOperation<CitizenSdkPreparedWallet> prepareCreation({
    required CitizenWalletWordCount wordCount,
    String password = '',
  });
  CitizenSdkOperation<CitizenWalletProfile> importWallet({
    required String mnemonic,
    String password = '',
  });
  CitizenSdkOperation<CitizenWalletProfile> addAccounts({
    required String mnemonic,
    String password = '',
    required List<int> indices,
  });
  CitizenSdkOperation<CitizenWalletProfile> addNextAccount({
    required String mnemonic,
    String password = '',
  });

  /// 手填输入只选一种身份格式；扫码导入由importColdAccountCode严格限定账户码。
  CitizenSdkOperation<CitizenWalletState> importColdAccount({
    String? accountId,
    String? ss58Address,
    String name = '',
  });
  CitizenSdkOperation<CitizenWalletState> importColdAccountCode({
    required String code,
    String name = '',
  });
  Future<CitizenSdkPrivateKey> openPrivateKey(String accountId);
  CitizenSdkOperation<CitizenWalletProfile> setActiveAccount(String accountId);

  /// 只选择付款钱包；必须基于最新目录修订，不触发签名或默认账户重排。
  CitizenSdkOperation<CitizenWalletState> setActiveWallet({
    required BigInt expectedRevision,
    required int walletIndex,
  });
  CitizenSdkOperation<CitizenWalletState> renameWallet({
    required BigInt expectedRevision,
    required int walletIndex,
    required String name,
  });
  CitizenSdkOperation<CitizenWalletState> renameAccount({
    required String accountId,
    required String name,
  });
  CitizenSdkOperation<CitizenWalletState> deleteAccount(String accountId);

  /// 保持原擦除语义，不附加签名或界面；普通“签名并删除”必须使用signAndDelete。
  CitizenSdkOperation<void> delete();
  CitizenSdkOperation<void> signAndDelete();
  CitizenSdkOperation<CitizenWalletProfile?> reconcileCleanup();

  CitizenSdkOperation<CitizenWalletState> reorderAccountsWithoutDefaultChange({
    required BigInt expectedRevision,
    required List<String> accountIds,
  });
  CitizenSdkOperation<CitizenDefaultAccountChangeOutcome>
  beginDefaultAccountChange({
    required BigInt expectedRevision,
    required List<String> accountIds,
    int ttlSeconds = 90,
  });
  CitizenSdkOperation<CitizenDefaultAccountChangeCompleted>
  consumeDefaultAccountChange({
    required String sessionId,
    required String response,
  });
  CitizenSdkOperation<Uint8List> deriveApplicationKey({
    required String accountId,
    required Uint8List salt,
    required Uint8List info,
  });
}

/// 可选的通用热账户批量 HKDF 能力；一次金库认证，逐项保持单钥派生结果。
/// 独立接口使现有只实现普通钱包合同的消费侧测试替身继续有效。
abstract interface class CitizenSdkWalletBatch {
  /// 参数在认证前固定；派生与可选32字节原始证明只打开一次金库。
  CitizenSdkOperation<CitizenApplicationKeyPreparation> prepareApplicationKeys({
    required String accountId,
    required Uint8List salt,
    required List<Uint8List> infos,
    Uint8List? signingMessage,
  });

  CitizenSdkOperation<List<Uint8List>> deriveApplicationKeys({
    required String accountId,
    required Uint8List salt,
    required List<Uint8List> infos,
  });
}
