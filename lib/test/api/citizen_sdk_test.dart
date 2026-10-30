// 主包测试使用声明的dev_dependencies。
// ignore_for_file: depend_on_referenced_packages
import 'dart:async';
import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('请求取消保留真实终态，不把取消接纳当完成', () async {
    final complete = Completer<int>();
    var finished = false, cancelled = 0;
    final operation = CitizenSdkOperation(
      operationId: '73',
      result: complete.future,
      cancel: () async {
        cancelled++;
        return true;
      },
    );
    unawaited(
      operation.result.then((_) {
        finished = true;
      }),
    );
    expect(await operation.cancel(), isTrue);
    expect(cancelled, 1);
    expect(finished, isFalse);
    expect(operation.operationId, '73');
    complete.complete(19);
    expect(await operation.result, 19);
  });
  test('拒绝取消不覆盖真实错误对象', () async {
    final failure = CitizenSdkException(
      code: CitizenSdkErrorCode.integrity,
      message: 'fixed',
      stage: CitizenSdkFailureStage.verification,
    );
    final complete = Completer<void>();
    final operation = CitizenSdkOperation(
      operationId: '74',
      result: complete.future,
      cancel: () async => false,
    );
    final settled = expectLater(operation.result, throwsA(same(failure)));
    expect(await operation.cancel(), isFalse);
    complete.completeError(failure);
    await settled;
  });
}
