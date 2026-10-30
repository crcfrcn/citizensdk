// ignore_for_file: depend_on_referenced_packages
import 'dart:ffi';
import 'package:citizen_sdk/platform/bind.dart' as c;
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('生成声明遵守当前真实64位C资源布局', () {
    expect(c.CITIZENSDK_ABI_VERSION, 2);
    expect(sizeOf<c.citizensdk_store_v1>(), 64);
    expect(sizeOf<c.citizensdk_stores_v1>(), 32);
    expect(sizeOf<c.citizensdk_host_secret_vault_v1>(), 80);
    expect(sizeOf<c.citizensdk_block_ref>(), 56);
  });
}
