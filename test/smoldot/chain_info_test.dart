// ignore_for_file: avoid_print -- 活链来源测试保留诊断输出，便于定位网络状态。

import 'dart:io';

import 'package:citizen_sdk/src/smoldot/smoldot.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('LightClientStatusSnapshot codec', () {
    Map<String, dynamic> snapshotJson(String syncPhase) => {
      'peerCount': 5,
      'isSyncing': syncPhase != 'regular',
      'isUsable': syncPhase == 'regular',
      'syncPhase': syncPhase,
      'bestBlockNumber': 50000,
      'bestBlockHash': '0x${List.filled(32, '11').join()}',
      'finalizedBlockNumber': 49998,
      'finalizedBlockHash': '0x${List.filled(32, '22').join()}',
      'startupFinalizedSource': 'bundledCheckpoint',
      'startupFinalizedBlockNumber': 0,
      'startupFinalizedBlockHash': '0x${List.filled(32, '00').join()}',
      'highestPeerFinalizedBlockNumber': 49998,
      'currentVerifiedFinalizedBlockNumber': syncPhase == 'regular' ? 49998 : 0,
      'currentVerifiedFinalizedBlockHash':
          '0x${List.filled(32, syncPhase == 'regular' ? '22' : '00').join()}',
      if (syncPhase != 'regular') 'warpTargetFinalizedBlockNumber': 49998,
      if (syncPhase != 'regular')
        'warpTargetFinalizedBlockHash': '0x${List.filled(32, '22').join()}',
      'warpRequestCount': 1,
      'activeWarpFragmentRequestCount': syncPhase == 'warpDownloadingFragments'
          ? 1
          : 0,
      'activeWarpStorageRequestCount': syncPhase == 'warpDownloadingTargetState'
          ? 1
          : 0,
      'activeWarpCallProofRequestCount': 0,
      'warpReceivedFragmentCount': 2,
      'warpVerifiedFragmentCount': 1,
      'warpRejectedFragmentCount': 1,
      'warpLastFailure': 'nonMinimalProof',
    };

    test('解析 regular 与全部真实 warp 阶段并保留计数', () {
      for (final entry in {
        'regular': LightClientSyncPhase.regular,
        'warpDownloadingFragments':
            LightClientSyncPhase.warpDownloadingFragments,
        'warpVerifyingFragments': LightClientSyncPhase.warpVerifyingFragments,
        'warpDownloadingTargetState':
            LightClientSyncPhase.warpDownloadingTargetState,
        'warpBuildingRuntime': LightClientSyncPhase.warpBuildingRuntime,
        'warpBuildingChainInformation':
            LightClientSyncPhase.warpBuildingChainInformation,
      }.entries) {
        final snapshot = LightClientStatusSnapshot.fromJson(
          snapshotJson(entry.key),
        );
        expect(snapshot.syncPhase, entry.value);
        expect(snapshot.startupFinalizedBlockNumber, 0);
        expect(snapshot.highestPeerFinalizedBlockNumber, 49998);
        expect(
          snapshot.currentVerifiedFinalizedBlockNumber,
          entry.key == 'regular' ? 49998 : 0,
        );
        expect(
          snapshot.warpTargetFinalizedBlockNumber,
          entry.key == 'regular' ? isNull : 49998,
        );
        expect(snapshot.warpRequestCount, 1);
        expect(snapshot.warpReceivedFragmentCount, 2);
        expect(snapshot.warpVerifiedFragmentCount, 1);
        expect(snapshot.warpRejectedFragmentCount, 1);
        expect(
          snapshot.warpLastFailure,
          LightClientWarpFailure.nonMinimalProof,
        );
        expect(snapshot.toJson()['syncPhase'], entry.key);
      }
    });

    test('未知启动来源或 warp 失败类型必须拒绝', () {
      final invalidSource = snapshotJson('regular')
        ..['startupFinalizedSource'] = 'legacy';
      expect(
        () => LightClientStatusSnapshot.fromJson(invalidSource),
        throwsFormatException,
      );

      final invalidFailure = snapshotJson('regular')
        ..['warpLastFailure'] = 'unknown';
      expect(
        () => LightClientStatusSnapshot.fromJson(invalidFailure),
        throwsFormatException,
      );
    });

    test('未知同步阶段不得伪装成 regular 或已完成', () {
      expect(
        () => LightClientStatusSnapshot.fromJson(snapshotJson('unknown')),
        throwsFormatException,
      );
    });

    test('runtime 已近头但仍处于 warp 时不得映射为 synced', () {
      final contradictory = snapshotJson('warpVerifyingFragments')
        ..['isSyncing'] = false
        ..['isUsable'] = false;
      final warp = LightClientStatusSnapshot.fromJson(contradictory);
      expect(warp.isUsable, isFalse);
      expect(warp.chainStatus, ChainStatus.syncing);

      final regularJson = snapshotJson('regular')
        ..['isSyncing'] = false
        ..['isUsable'] = true;
      final regular = LightClientStatusSnapshot.fromJson(regularJson);
      expect(regular.isUsable, isTrue);
      expect(regular.chainStatus, ChainStatus.synced);
    });

    test('FFI 可用性与原生阶段冲突时必须拒绝', () {
      final forgedUsable = snapshotJson('warpBuildingRuntime')
        ..['isSyncing'] = false
        ..['isUsable'] = true;
      expect(
        () => LightClientStatusSnapshot.fromJson(forgedUsable),
        throwsFormatException,
      );

      final staleWarpTarget = snapshotJson('regular')
        ..['warpTargetFinalizedBlockNumber'] = 49998
        ..['warpTargetFinalizedBlockHash'] =
            '0x${List.filled(32, '22').join()}';
      expect(
        () => LightClientStatusSnapshot.fromJson(staleWarpTarget),
        throwsFormatException,
      );
    });
  });

  group('Chain Info Tests', () {
    late SmoldotClient client;
    late Chain chain;

    setUpAll(() async {
      client = SmoldotClient(config: SmoldotConfig(maxLogLevel: 3));
      await client.initialize();

      // Load Westend chain spec
      final westendSpecFile = File('test/smoldot/fixtures/westend.json');
      expect(
        westendSpecFile.existsSync(),
        isTrue,
        reason:
            'Westend chain spec not found. Run: curl -o test/smoldot/fixtures/westend.json https://raw.githubusercontent.com/smol-dot/smoldot/main/demo-chain-specs/westend.json',
      );

      final westendSpec = await westendSpecFile.readAsString();
      chain = await client.addChain(AddChainConfig(chainSpec: westendSpec));
    });

    tearDownAll(() async {
      if (client.isInitialized) {
        await client.dispose();
      }
    });

    test('should get chain info', () async {
      final info = await chain.getInfo();

      expect(info, isNotNull);
      expect(info.chainId, equals(chain.chainId));
      expect(info.name, equals('Westend'));
      expect(info.status, isA<ChainStatus>());
      expect(info.peerCount, greaterThanOrEqualTo(0));
      expect(info.bestBlockNumber, isNotNull);
      expect(info.bestBlockHash, isNotNull);

      print('Chain Info:');
      print('  Name: ${info.name}');
      print('  Status: ${info.status}');
      print('  Peers: ${info.peerCount}');
      print('  Block: ${info.bestBlockNumber}');
      print('  Hash: ${info.bestBlockHash}');
    });

    test('should get best block number', () async {
      final blockNumber = await chain.getBestBlockNumber();

      expect(blockNumber, isNotNull);
      expect(blockNumber!, greaterThan(0));
      print('Best block number: $blockNumber');
    });

    test('should get best block hash', () async {
      final blockHash = await chain.getBestBlockHash();

      expect(blockHash, isNotNull);
      expect(blockHash!, startsWith('0x'));
      expect(blockHash.length, equals(66)); // 0x + 64 hex characters
      print('Best block hash: $blockHash');
    });

    test('should get peer count', () async {
      final peerCount = await chain.getPeerCount();

      expect(peerCount, greaterThanOrEqualTo(0));
      print('Peer count: $peerCount');
    });

    test('should get chain status', () async {
      final status = await chain.getStatus();

      expect(status, isA<ChainStatus>());
      print('Chain status: $status');
    });

    test('should handle multiple concurrent chain info requests', () async {
      final futures = [
        chain.getBestBlockNumber(),
        chain.getBestBlockHash(),
        chain.getPeerCount(),
        chain.getStatus(),
      ];

      final results = await Future.wait(futures);

      expect(results[0], isNotNull); // block number
      expect(results[1], isNotNull); // block hash
      expect(results[2], greaterThanOrEqualTo(0)); // peer count
      expect(results[3], isA<ChainStatus>()); // status

      print('Concurrent requests completed successfully');
    });
  });
}
