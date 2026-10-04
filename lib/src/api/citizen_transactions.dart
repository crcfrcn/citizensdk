import 'dart:typed_data';

import '../models/citizen_transaction.dart';

/// CitizenSDK 通用交易接口；调用方负责业务 RuntimeCall 的编码和语义。
///
/// 交易构造、sr25519 签名、pending-before-broadcast、提交、监听和 Runtime 终态核验全部由
/// Rust Core 完成；Dart 不接收已签名 extrinsic。
abstract interface class CitizenTransactions {
  /// Binds one application-encoded opaque RuntimeCall to exact chain state without signing it.
  Future<CitizenPreparedTransaction> prepareTransaction(
    Uint8List sourceAccountId,
    Uint8List callData,
  );

  /// Explicitly invalidates one live preparation owned by this SDK session.
  Future<void> cancelPreparedTransaction(String preparationId);

  Future<CitizenTransactionExecution> executePreparedTransaction(
    String preparationId,
  );

  Future<CitizenTransactionExecutionCompleted>
  consumePreparedTransactionQrResponse(String executionId, String response);

  Future<void> cancelPreparedTransactionExecution(String executionId);
}

/// SDK 自身已提交通用交易的本地恢复历史；不扫描账户业务流水。
abstract interface class CitizenHistory {
  Future<CitizenTransactionHistoryPage> getTransactionHistory({
    String? beforeExecutionId,
    int limit = 100,
  });

  Future<CitizenTransactionHistoryPage> syncTransactionHistory();
}
