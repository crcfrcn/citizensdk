import 'dart:convert';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';

/// SDK内的第三方合成预订夹具，与真实产品和用户数据无关。
final class TravelBookingDraft {
  TravelBookingDraft({
    required this.bookingId,
    required this.routeCode,
    required this.seatCount,
  }) {
    _requireShortText(bookingId, 'bookingId');
    _requireShortText(routeCode, 'routeCode');
    if (seatCount < 1 || seatCount > 255) {
      throw ArgumentError.value(seatCount, 'seatCount', 'must be 1..255');
    }
  }

  final String bookingId;
  final String routeCode;
  final int seatCount;
}

/// 测试不同字节结构复用同一公开端口，不定义生产App与SDK的业务归属。
final class ThirdPartyTravelFixture {
  const ThirdPartyTravelFixture({
    required this.chain,
    required this.transactions,
    required this.history,
  });

  final CitizenChain chain;
  final CitizenTransactions transactions;
  final CitizenHistory history;

  Future<CitizenPreparedTransaction> prepareBooking({
    required Uint8List sourceAccountId,
    required TravelBookingDraft booking,
  }) => transactions.prepareTransaction(
    Uint8List.fromList(sourceAccountId),
    encodeBookingRuntimeCall(booking),
  );

  Future<Uint8List?> readBooking({
    required CitizenBlockRef finalizedBlock,
    required String bookingId,
  }) => chain.getStorage(finalizedBlock, bookingStorageKey(bookingId));

  Future<CitizenTransactionHistoryPage> refreshSdkExecutionFacts() =>
      history.syncTransactionHistory();

  static Uint8List encodeBookingRuntimeCall(TravelBookingDraft booking) {
    final bookingId = utf8.encode(booking.bookingId);
    final route = utf8.encode(booking.routeCode);
    return Uint8List.fromList(<int>[
      73,
      7,
      bookingId.length << 2,
      ...bookingId,
      route.length << 2,
      ...route,
      booking.seatCount,
    ]);
  }

  static Uint8List bookingStorageKey(String bookingId) {
    _requireShortText(bookingId, 'bookingId');
    return Uint8List.fromList(<int>[
      ...utf8.encode('TravelBooking/reservation/'),
      ...utf8.encode(bookingId),
    ]);
  }
}

void _requireShortText(String value, String name) {
  final length = utf8.encode(value).length;
  if (length < 1 || length > 63) {
    throw ArgumentError.value(length, name, 'must contain 1..63 UTF-8 bytes');
  }
}
