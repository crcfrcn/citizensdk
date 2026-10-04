import 'dart:async';
import 'dart:io';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:flutter/foundation.dart' show FlutterError, kReleaseMode;
import 'package:flutter/widgets.dart';

const _timeout = Duration(seconds: 60);

void _require(bool condition) {
  // Release 不执行 assert；每项验收必须是不能被移除的真实条件分支。
  if (!condition) throw StateError('CitizenSDK consumer contract failed');
}

void _capabilities(CitizenCapabilitySnapshot snapshot) {
  _require(snapshot.statuses.length == CitizenCapabilityName.values.length);
  _require(
    snapshot.statuses.map((status) => status.name).toSet().length ==
        CitizenCapabilityName.values.length,
  );
  for (final status in snapshot.statuses) {
    _require(
      !status.ready ||
          (status.supported &&
              status.available &&
              status.enabled &&
              status.reason == CitizenCapabilityReason.none),
    );
    _require(status.ready || status.reason != CitizenCapabilityReason.none);
  }
}

Future<void> _expectError(
  Future<Object?> Function() operation,
  CitizenSdkErrorCode expected,
) async {
  try {
    await operation().timeout(_timeout);
  } on CitizenSdkException catch (error) {
    _require(error.code == expected);
    return;
  }
  throw StateError('CitizenSDK consumer expected a typed failure');
}

Future<void> _until(bool Function() condition) async {
  final deadline = Stopwatch()..start();
  while (!condition()) {
    _require(deadline.elapsed < const Duration(seconds: 15));
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

Future<void> _verify() async {
  _require(Platform.isMacOS && kReleaseMode);
  CitizenSdk? sdk;
  StreamSubscription<CitizenSdkEvent>? subscription;
  try {
    // 沿用现有公开消费者的生命周期合同，仅由真实 macOS 宿主装配 Flutter 插件。
    // 宿主必须先完成 Foundation 实际路径预检和系统 sandbox 隔离，才调用本入口；
    // Dart 不传入状态路径，也不接触、清理用户的既有 SDK 数据。
    sdk = await CitizenSdk.open().timeout(_timeout);
    final opened = sdk;
    _require(opened.lifecycle == CitizenSdkLifecycle.created);
    final lifecycleEvents = <CitizenSdkLifecycle>[];
    final capabilityEvents = <CitizenCapabilitySnapshot>[];
    var eventSequence = 0;
    var eventFailed = false;
    var eventsDone = false;
    subscription = opened.events.listen(
      (event) {
        if (event.sequence <= eventSequence) eventFailed = true;
        eventSequence = event.sequence;
        switch (event) {
          case CitizenSdkLifecycleChanged():
            lifecycleEvents.add(event.lifecycle);
          case CitizenSdkCapabilitiesChanged():
            capabilityEvents.add(event.snapshot);
          case CitizenSdkFinalizedBlockChanged():
            if (event.finalized.finality != CitizenBlockFinality.finalized) {
              eventFailed = true;
            }
          case CitizenSdkHistoryChanged():
          // 历史变化是只读通知；本消费者不读取或修改历史数据。
        }
      },
      onError: (Object _, StackTrace __) {
        eventFailed = true;
      },
      onDone: () {
        eventsDone = true;
      },
    );

    final initial = await opened.getCapabilities().timeout(_timeout);
    _capabilities(initial);
    _require(!initial[CitizenCapabilityName.chainRead].ready);
    await _expectError(
      opened.chain.getFinalizedHead,
      CitizenSdkErrorCode.notReady,
    );
    // 只查询隔离命名空间的公开资料；不创建/导入钱包，不签名、不触发秘密 UI。
    _require(await opened.wallet.getProfile().timeout(_timeout) == null);
    await opened.start().timeout(_timeout);
    _require(opened.lifecycle == CitizenSdkLifecycle.running);
    await _until(() => lifecycleEvents.contains(CitizenSdkLifecycle.running));
    _capabilities(await opened.getCapabilities().timeout(_timeout));
    // running 不等于链已同步，更不代表硬件金库或用户认证可用；以能力事实为准。
    await opened.stop().timeout(_timeout);
    _require(opened.lifecycle == CitizenSdkLifecycle.stopped);
    await _until(() => lifecycleEvents.contains(CitizenSdkLifecycle.stopped));
    final stopped = await opened.getCapabilities().timeout(_timeout);
    _capabilities(stopped);
    _require(!stopped[CitizenCapabilityName.chainRead].ready);
    await _until(() => capabilityEvents.isNotEmpty);
    for (final snapshot in capabilityEvents) {
      _capabilities(snapshot);
    }
    _require(!eventFailed && eventSequence > 0);
    await opened.close().timeout(_timeout);
    _require(opened.lifecycle == CitizenSdkLifecycle.disposed);
    await opened.close().timeout(_timeout);
    await _expectError(
      opened.getCapabilities,
      CitizenSdkErrorCode.invalidState,
    );
    await _until(() => eventsDone);
    await subscription.cancel().timeout(_timeout);
    // 订阅完全结束后再检查迟到错误，不能仅在 close 前判定事件通过。
    _require(!eventFailed);
    subscription = null;
    sdk = null;

    // 同一个真实插件中重新打开必须得到新 created 实例，不继承已关闭状态。
    sdk = await CitizenSdk.open().timeout(_timeout);
    _require(sdk.lifecycle == CitizenSdkLifecycle.created);
    final reopened = await sdk.getCapabilities().timeout(_timeout);
    _capabilities(reopened);
    _require(!reopened[CitizenCapabilityName.chainRead].ready);
    _require(await sdk.wallet.getProfile().timeout(_timeout) == null);
    await _expectError(
      sdk.chain.getFinalizedHead,
      CitizenSdkErrorCode.notReady,
    );
    await sdk.close().timeout(_timeout);
    _require(sdk.lifecycle == CitizenSdkLifecycle.disposed);
    sdk = null;
  } finally {
    await subscription?.cancel().timeout(_timeout);
    final remaining = sdk;
    if (remaining != null) {
      try {
        if (remaining.lifecycle == CitizenSdkLifecycle.running) {
          await remaining.stop().timeout(_timeout);
        }
        await remaining.close().timeout(_timeout);
      } on Object {
        // 原验收错误仍决定失败；收尾失败不能伪造成功，整体 watchdog 保持生效。
      }
    }
  }
}

Future<void> main() async {
  final watchdog = Timer(const Duration(seconds: 180), () {
    exit(1);
  });
  try {
    final binding = WidgetsFlutterBinding.ensureInitialized();
    // 正式 macOS runner 必须拥有真实 Flutter view；不是无 engine 的 Dart 单测。
    // 框架或 isolate 未处理异常也必须非零退出，不能被后续成功字样掩盖。
    FlutterError.onError = (_) {
      exit(1);
    };
    binding.platformDispatcher.onError = (_, __) {
      exit(1);
    };
    runApp(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: SizedBox.expand(),
      ),
    );
    await binding.endOfFrame.timeout(_timeout);
    await _verify();
    stdout.writeln('CitizenSDK Flutter consumer passed');
    await stdout.flush();
    watchdog.cancel();
    exit(0);
  } on Object {
    stderr.writeln('CitizenSDK Flutter consumer failed');
    await stderr.flush();
    watchdog.cancel();
    exit(1);
  }
}
