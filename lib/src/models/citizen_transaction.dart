import 'dart:typed_data';

import 'citizen_chain_state.dart';

enum CitizenTransactionResolution {
  finalizedSuccess,
  finalizedFailed,
  poolRejected,
}

/// One SDK-owned, non-persistent transaction preparation safe to show to an application.
///
/// The opaque native handle, signer message and extrinsic template deliberately do not cross the
/// Flutter boundary. Byte fields are copied so callers cannot mutate the facts bound by Core.
final class CitizenPreparedTransaction {
  CitizenPreparedTransaction({
    required this.preparationId,
    required Uint8List sourceAccountId,
    required Uint8List callDataHash,
    required this.bestBlock,
    required this.runtimeSpecNumber,
    required this.transactionFormatNumber,
    required this.nonce,
  }) : sourceAccountId = Uint8List.fromList(
         sourceAccountId,
       ).asUnmodifiableView(),
       callDataHash = Uint8List.fromList(callDataHash).asUnmodifiableView();

  final String preparationId;
  final Uint8List sourceAccountId;
  final Uint8List callDataHash;
  final CitizenBlockRef bestBlock;
  final int runtimeSpecNumber;
  final int transactionFormatNumber;
  final BigInt nonce;
}

/// Safe result of consuming one prepared opaque transaction.
sealed class CitizenTransactionExecution {
  CitizenTransactionExecution({
    required this.executionId,
    required Uint8List sourceAccountId,
    required Uint8List callDataHash,
  }) : sourceAccountId = sourceAccountId.asUnmodifiableView(),
       callDataHash = callDataHash.asUnmodifiableView();

  final String executionId;
  final Uint8List sourceAccountId;
  final Uint8List callDataHash;
}

final class CitizenTransactionExternalSigningPending
    extends CitizenTransactionExecution {
  CitizenTransactionExternalSigningPending({
    required super.executionId,
    required Uint8List sourceAccountId,
    required Uint8List callDataHash,
    required this.qrRequest,
    required this.expiresAt,
  }) : super(
         sourceAccountId: Uint8List.fromList(sourceAccountId),
         callDataHash: Uint8List.fromList(callDataHash),
       );

  final String qrRequest;
  final DateTime expiresAt;
}

final class CitizenTransactionExecutionCompleted
    extends CitizenTransactionExecution {
  CitizenTransactionExecutionCompleted({
    required super.executionId,
    required Uint8List sourceAccountId,
    required Uint8List callDataHash,
    required Uint8List transactionHash,
    required this.resolution,
    required this.execution,
    required this.poolRejectionReason,
    required Uint8List? replacementHash,
  }) : transactionHash = Uint8List.fromList(
         transactionHash,
       ).asUnmodifiableView(),
       replacementHash = replacementHash == null
           ? null
           : Uint8List.fromList(replacementHash).asUnmodifiableView(),
       super(
         sourceAccountId: Uint8List.fromList(sourceAccountId),
         callDataHash: Uint8List.fromList(callDataHash),
       );

  final Uint8List transactionHash;
  final CitizenTransactionResolution resolution;
  final CitizenExecution? execution;
  final String? poolRejectionReason;
  final Uint8List? replacementHash;
}

enum CitizenExecutionStatus { success, failed }

/// finalized 块中与确切 extrinsic index 对应的 Runtime 执行结论。
final class CitizenExecution {
  const CitizenExecution({
    required this.status,
    required this.block,
    required this.extrinsicIndex,
    required this.dispatchVariant,
    required this.palletIndex,
    required this.errorIndex,
  });

  final CitizenExecutionStatus status;
  final CitizenBlockRef block;
  final int extrinsicIndex;
  final int? dispatchVariant;
  final int? palletIndex;
  final int? errorIndex;
}

/// Durable status of a product-independent transaction submitted by CitizenSDK.
enum CitizenTransactionHistoryStatus {
  pending,
  inBlock,
  poolRejected,
  finalizedSuccess,
  finalizedFailed,
}

/// Public whitelist projection of one SDK-submitted opaque RuntimeCall.
///
/// Application meanings such as destination, amount, remark, direction and
/// pallet/event names remain owned by the integrating application.
final class CitizenTransactionHistoryRecord {
  const CitizenTransactionHistoryRecord({
    required this.executionId,
    required this.sourceAccountId,
    required this.callDataHash,
    required this.transactionHash,
    required this.status,
    required this.block,
    required this.execution,
    required this.replacementHash,
    required this.createdAtMillis,
    required this.updatedAtMillis,
    required this.poolRejectionReason,
  });

  final String executionId;
  final String sourceAccountId;
  final String callDataHash;
  final String transactionHash;
  final CitizenTransactionHistoryStatus status;
  final CitizenBlockRef? block;
  final CitizenExecution? execution;
  final String? replacementHash;
  final BigInt createdAtMillis;
  final BigInt updatedAtMillis;
  final String? poolRejectionReason;
}

/// Deterministic newest-first page from CitizenSDK's local execution store.
final class CitizenTransactionHistoryPage {
  CitizenTransactionHistoryPage({
    required this.revision,
    required List<CitizenTransactionHistoryRecord> records,
    required this.nextBeforeExecutionId,
  }) : records = List<CitizenTransactionHistoryRecord>.unmodifiable(records);

  final BigInt revision;
  final List<CitizenTransactionHistoryRecord> records;
  final String? nextBeforeExecutionId;
}
