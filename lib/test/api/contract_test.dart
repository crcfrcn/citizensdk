// ignore_for_file: depend_on_referenced_packages
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('主库只公开同一Sdk，旧包装实现和旧包根已删除', () {
    for (final name in [
      'ffi',
      'types',
      'store',
      'qr',
      'sign',
      'net',
      'test',
      'tests',
    ]) {
      expect(Directory(name).existsSync(), isFalse, reason: name);
    }
    for (final name in [
      'lib/platform/ffi.dart',
      'lib/platform/result.dart',
      'lib/platform/citizen_sdk_platform.dart',
      'lib/platform/citizen_sdk_flutter_sessions.dart',
      'lib/platform/citizen_sdk_flutter_codec.dart',
      'include/citizen_sdk.hpp',
      'darwin/src/CitizenSDKNative.swift',
      'android/src/CitizenSdkNative.kt',
    ]) {
      expect(File(name).existsSync(), isFalse, reason: name);
    }
    final library = File('lib/citizen_sdk.dart').readAsStringSync();
    expect(library, contains("part 'api/citizen_sdk.dart'"));
    final sources = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where(
          (f) => f.path.endsWith('.dart') && !f.path.startsWith('lib/test/'),
        )
        .map((f) => f.readAsStringSync())
        .join();
    for (final name in [
      'CitizenSdkPlatform',
      'CitizenSdkFlutterSessions',
      'CitizenSdkFlutterCodec',
      'FfiCitizenSdkPlatform',
      'CitizenChain {',
      'CitizenSdkWallet {',
    ]) {
      expect(sources.contains(name), isFalse, reason: name);
    }
  });
  test('第一方源码目录不超过三级，四个主测试分组保留', () {
    const excluded = {
      '.git',
      'target',
      'build',
      '.dart_tool',
      '.gradle',
      'node_modules',
      'Pods',
      'smoldot',
      '.DS_Store',
    };
    void visit(Directory at, int level) {
      final children = at.listSync(followLinks: false).where((entry) {
        final name = entry.uri.pathSegments.where((v) => v.isNotEmpty).last;
        return !excluded.contains(name);
      }).toList();
      expect(children.length, greaterThanOrEqualTo(2), reason: at.path);
      for (final entry in children) {
        final name = entry.uri.pathSegments.where((v) => v.isNotEmpty).last;
        if (excluded.contains(name)) continue;
        if (entry is Directory) {
          expect(level + 1, lessThanOrEqualTo(3), reason: entry.path);
          visit(entry, level + 1);
        }
      }
    }

    visit(Directory('.'), 0);
    for (final name in ['api', 'models', 'platform', 'consumers']) {
      expect(Directory('lib/test/$name').existsSync(), isTrue);
    }
  });
}
