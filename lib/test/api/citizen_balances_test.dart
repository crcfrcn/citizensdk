import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

String id(int n) => '0x' + n.toRadixString(16).padLeft(64, '0');
CitizenBlockRef block(int n) => CitizenBlockRef(
  hash: id(n),
  number: BigInt.from(n),
  finality: CitizenBlockFinality.finalized,
);
CitizenAccountBalance value(String account, int height, [int amount = 100]) =>
    CitizenAccountBalance(
      accountId: account,
      block: block(height),
      freeFen: BigInt.from(amount),
      reservedFen: BigInt.zero,
      totalFen: BigInt.from(amount),
    );
Future<void> settle() async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  DynamicLibrary.open(Platform.environment['CITIZENSDK_TEST_LIBRARY']!);

  test(
    'overlapping subscribers share one batch and release stops reads',
    () async {
      var head = 104;
      final calls = <List<String>>[];
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          calls.add(ids);
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      final a = store.watch([id(1), id(2)]);
      final b = store.watch([id(2), id(3)]);
      await settle();
      expect(calls, hasLength(1));
      expect(calls.single.toSet(), {id(1), id(2), id(3)});
      a();
      b();
      head = 105;
      store.finalized(block(head));
      await settle();
      expect(calls, hasLength(1));
    },
  );

  test(
    'a cached balance at 102 is refreshed at 105 without transaction history',
    () async {
      var writes = 0;
      var raw = jsonEncode({
        'chain': {
          'block_hash': id(102),
          'block_number': '102',
          'free_fen': '0',
          'reserved_fen': '0',
        },
      });
      final store = CitizenBalances(
        getFinalizedHead: () async => block(105),
        getAccountBalances: (ids) async => [
          for (final a in ids) value(a, 105, 1000000),
        ],
        storage: (
          read: (_) async => raw,
          write: (_, update) async {
            writes++;
            raw = update(raw)!;
          },
        ),
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      expect(store.accountState(id(1)).value!.freeFen, BigInt.from(1000000));
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(105));
      expect(writes, 1);
    },
  );

  test(
    'inflight reads skip intermediate heads and catch the latest one',
    () async {
      var head = 103;
      final gate = Completer<void>();
      final calls = <int>[];
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          final anchor = head;
          calls.add(anchor);
          if (calls.length == 1) await gate.future;
          return [for (final a in ids) value(a, anchor, anchor)];
        },
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      head = 104;
      store.finalized(block(head));
      head = 105;
      store.finalized(block(head));
      gate.complete();
      await settle();
      expect(calls, [103, 105]);
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(105));
    },
  );

  test(
    'unchanged amounts advance the proof without disk writes or notifications',
    () async {
      var head = 1, writes = 0, notifications = 0;
      String? raw;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async => [
          for (final a in ids) value(a, head),
        ],
        storage: (
          read: (_) async => raw,
          write: (_, update) async {
            writes++;
            raw = update(raw);
          },
        ),
      );
      addTearDown(store.close);
      final state = store.accountState(id(1));
      state.addListener(() {
        notifications++;
      });
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      expect(writes, 1);
      expect(notifications, 1);
      head = 2;
      store.finalized(block(head));
      await settle();
      expect(writes, 1);
      expect(notifications, 1);
      expect(state.value!.block.number, BigInt.two);
    },
  );

  test(
    'background and hidden watches stop scheduling; resume checks the latest head',
    () async {
      var head = 1, calls = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          calls++;
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      store.setForeground(false);
      head = 5;
      store.finalized(block(head));
      await settle();
      expect(calls, 1);
      store.setForeground(true);
      await settle();
      expect(calls, 2);
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(5));
    },
  );

  test(
    'removal drains inflight reads and prevents a late cache write',
    () async {
      final gate = Completer<void>();
      var writes = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(1),
        getAccountBalances: (ids) async {
          await gate.future;
          return [for (final a in ids) value(a, 1)];
        },
        storage: (
          read: (_) async => null,
          write: (_, update) async {
            if (update(null) != null) writes++;
          },
        ),
      );
      addTearDown(store.close);
      final read = store.getAccountBalance(id(1));
      final failure = expectLater(read, throwsStateError);
      await settle();
      final removing = store.remove([id(1)]);
      gate.complete();
      await removing;
      await failure;
      expect(writes, 0);
      expect(await store.read(id(1)), isNull);
    },
  );

  test(
    'prechecks verify the latest head and share a same-block proof',
    () async {
      var head = 1, calls = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          calls++;
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      await store.getAccountBalance(id(1), forceRefresh: true);
      await store.getAccountBalance(id(1), forceRefresh: true);
      expect(calls, 1);
      head = 2;
      expect(
        (await store.getAccountBalance(id(1), forceRefresh: true)).block.number,
        BigInt.two,
      );
      expect(calls, 2);
    },
  );

  test(
    'a failed refresh keeps the previous amount and records the error',
    () async {
      var head = 1;
      var fail = false;
      final store = CitizenBalances(
        getFinalizedHead: () async => block(head),
        getAccountBalances: (ids) async {
          if (fail) throw StateError('read failed');
          return [for (final a in ids) value(a, head)];
        },
      );
      addTearDown(store.close);
      final release = store.watch([id(1)]);
      addTearDown(release);
      await settle();
      fail = true;
      head = 2;
      store.finalized(block(head));
      await settle();
      expect(store.accountState(id(1)).value!.freeFen, BigInt.from(100));
      expect(store.accountState(id(1)).hasError, isTrue);
    },
  );
  test('closing drains inflight work without accepting a late write', () async {
    final gate = Completer<void>();
    var writes = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async => block(1),
      getAccountBalances: (ids) async {
        await gate.future;
        return [for (final a in ids) value(a, 1)];
      },
      storage: (
        read: (_) async => null,
        write: (_, update) async {
          if (update(null) != null) writes++;
        },
      ),
    );
    final read = store.getAccountBalance(id(1));
    final failure = expectLater(read, throwsStateError);
    await settle();
    final closing = store.close();
    gate.complete();
    await closing;
    await failure;
    expect(writes, 0);
    await expectLater(store.getAccountBalance(id(1)), throwsStateError);
  });

  test('a cancelled watch does not initiate a head or balance read', () async {
    var heads = 0, reads = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async {
        heads++;
        return block(1);
      },
      getAccountBalances: (ids) async {
        reads++;
        return [for (final a in ids) value(a, 1)];
      },
    );
    addTearDown(store.close);
    store.watch([id(1)])();
    await settle();
    expect(heads, 0);
    expect(reads, 0);
  });

  test(
    'a recovered head check clears failure while reusing the same-block proof',
    () async {
      var fail = false, reads = 0;
      final store = CitizenBalances(
        getFinalizedHead: () async {
          if (fail) throw StateError('head unavailable');
          return block(1);
        },
        getAccountBalances: (ids) async {
          reads++;
          return [for (final a in ids) value(a, 1)];
        },
      );
      addTearDown(store.close);
      await store.getAccountBalance(id(1), forceRefresh: true);
      fail = true;
      await expectLater(
        store.getAccountBalance(id(1), forceRefresh: true),
        throwsStateError,
      );
      expect(store.accountState(id(1)).hasError, isTrue);
      fail = false;
      await store.getAccountBalance(id(1), forceRefresh: true);
      expect(store.accountState(id(1)).hasError, isFalse);
      expect(reads, 1);
    },
  );

  test('an old watch release cannot cancel a new account generation', () async {
    var head = 1, reads = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async => block(head),
      getAccountBalances: (ids) async {
        reads++;
        return [for (final a in ids) value(a, head)];
      },
    );
    addTearDown(store.close);
    final old = store.watch([id(1)]);
    await settle();
    await store.remove([id(1)]);
    head = 2;
    store.finalized(block(head));
    final fresh = store.watch([id(1)]);
    addTearDown(fresh);
    await settle();
    old();
    head = 3;
    store.finalized(block(head));
    await settle();
    expect(reads, 3);
    expect(store.accountState(id(1)).value!.block.number, BigInt.from(3));
  });

  test(
    'a disk snapshot ahead of the verified head cannot authorize a precheck',
    () async {
      var reads = 0;
      final raw = jsonEncode({
        'chain': {
          'block_hash': id(105),
          'block_number': '105',
          'free_fen': '100',
          'reserved_fen': '0',
        },
      });
      final store = CitizenBalances(
        getFinalizedHead: () async => block(104),
        getAccountBalances: (ids) async {
          reads++;
          return [for (final a in ids) value(a, 104)];
        },
        storage: (
          read: (_) async => raw,
          write: (_, update) async {
            update(raw);
          },
        ),
      );
      addTearDown(store.close);
      await expectLater(
        store.getAccountBalance(id(1), forceRefresh: true),
        throwsStateError,
      );
      expect(reads, 1);
      expect(store.accountState(id(1)).value!.block.number, BigInt.from(105));
      expect(store.accountState(id(1)).hasError, isTrue);
    },
  );

  test('a newer proof returned by Core advances the scheduler head', () async {
    var reads = 0;
    final store = CitizenBalances(
      getFinalizedHead: () async => block(103),
      getAccountBalances: (ids) async {
        reads++;
        return [for (final a in ids) value(a, 105)];
      },
    );
    addTearDown(store.close);
    expect(
      (await store.getAccountBalance(id(1))).block.number,
      BigInt.from(105),
    );
    await store.getAccountBalance(id(1));
    expect(reads, 1);
  });
}
