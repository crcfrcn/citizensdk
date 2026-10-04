// ignore_for_file: avoid_print -- 活链来源测试保留诊断输出，便于定位网络状态。

import 'dart:io';

import 'package:citizen_sdk/src/smoldot/smoldot.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SmoldotClient Basic Tests', () {
    late SmoldotClient client;

    setUp(() {
      client = SmoldotClient(config: SmoldotConfig(maxLogLevel: 3));
    });

    tearDown(() async {
      if (client.isInitialized) {
        await client.dispose();
      }
    });

    test('should initialize client', () async {
      await client.initialize();
      expect(client.isInitialized, isTrue);
    });

    test('should fail to initialize twice', () async {
      await client.initialize();
      expect(() => client.initialize(), throwsA(isA<SmoldotException>()));
    });

    test('should create and add chain with Westend spec', () async {
      await client.initialize();

      // Load real Westend chain spec from fixtures
      final westendSpecFile = File('test/smoldot/fixtures/westend.json');
      expect(
        westendSpecFile.existsSync(),
        isTrue,
        reason:
            'Westend chain spec not found. Run: curl -o test/smoldot/fixtures/westend.json https://raw.githubusercontent.com/smol-dot/smoldot/main/demo-chain-specs/westend.json',
      );

      final westendSpec = await westendSpecFile.readAsString();

      // This should work with the callback-based FFI and real chain spec
      final chain = await client.addChain(
        AddChainConfig(chainSpec: westendSpec),
      );

      expect(chain, isNotNull);
      expect(chain.chainId, greaterThan(0));
      print('✓ Chain created with ID: ${chain.chainId}');
      print('✓ Successfully loaded Westend chain spec');
    });
  });
}
