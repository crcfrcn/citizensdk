// ignore_for_file: avoid_print -- FFI 来源测试保留句柄和版本诊断输出。

import 'package:citizen_sdk/src/smoldot/bindings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('FFI Basic Tests', () {
    late SmoldotBindings bindings;

    setUp(() {
      bindings = SmoldotBindings();
    });

    test('should load library and get version', () {
      final version = bindings.getVersion();
      print('Smoldot FFI version: $version');
      expect(version, isNotEmpty);
      expect(
        version,
        equals('1.0.0'),
      ); // 与 CitizenApp 实际构建的 citizenapp/smoldot/ffi/Cargo.toml 一致。
    });

    test('should initialize client with config', () {
      final configJson =
          '{"maxLogLevel":3,"systemName":"Test","systemVersion":"1.0.0"}';

      expect(() {
        final handle = bindings.initClient(configJson);
        print('Client initialized with handle: $handle');
        expect(handle, greaterThan(0));

        // Clean up
        bindings.destroyClient(handle);
      }, returnsNormally);
    });
  });
}
