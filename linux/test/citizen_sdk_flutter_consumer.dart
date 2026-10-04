import 'dart:async';
import 'dart:io';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:flutter/widgets.dart';

const _timeout = Duration(seconds: 60);

void _require(bool condition) {
  // Release 不运行 Dart assert，所有验收条件必须保持真实分支。
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
  _require(Platform.isLinux);
  final stateRoot = Platform.environment['XDG_DATA_HOME'] ?? '';
  _require(stateRoot.isNotEmpty && stateRoot.startsWith('/'));
  _require(
    await FileSystemEntity.type(stateRoot, followLinks: false) ==
        FileSystemEntityType.directory,
  );
  _require(((await Directory(stateRoot).stat()).mode & 0x1ff) == 0x1c0);
  CitizenSdk? sdk;
  StreamSubscription<CitizenSdkEvent>? subscription;
  try {
    // 仅使用根公开入口；Linux 必须经正式默认平台和自动注册的插件打开，
    // 不允许用内部 transport 注入掩盖包注册或安装投影缺失。
    sdk = await CitizenSdk.open().timeout(_timeout);
    final opened = sdk;
    _require(opened.lifecycle == CitizenSdkLifecycle.created);
    // 创世身份可在 start 前直接读取；空批量查询不能绕过 Core 的生命周期门。
    final genesisHash = await opened.chain.getGenesisHash().timeout(_timeout);
    _require(RegExp(r'^0x[0-9a-f]{64}$').hasMatch(genesisHash));
    await _expectError(
      () => opened.chain.getAccountBalances(const <String>[]),
      CitizenSdkErrorCode.notReady,
    );
    final lifecycleEvents = <CitizenSdkLifecycle>[];
    final capabilityEvents = <CitizenCapabilitySnapshot>[];
    var eventSequence = 0;
    var eventFailed = false;
    subscription = opened.events.listen(
      (event) {
        if (event.sequence <= eventSequence) eventFailed = true;
        eventSequence = event.sequence;
        switch (event) {
          case CitizenSdkHistoryChanged():
            // 本夹具不触发历史写入；出现该事件说明原生路由隔离错误。
            eventFailed = true;
          case CitizenSdkLifecycleChanged():
            lifecycleEvents.add(event.lifecycle);
          case CitizenSdkCapabilitiesChanged():
            capabilityEvents.add(event.snapshot);
          case CitizenSdkFinalizedBlockChanged():
            if (event.finalized.finality != CitizenBlockFinality.finalized) {
              eventFailed = true;
            }
        }
      },
      onError: (Object _, StackTrace __) {
        eventFailed = true;
      },
    );

    final initial = await opened.getCapabilities().timeout(_timeout);
    _capabilities(initial);
    _require(!initial[CitizenCapabilityName.chainRead].ready);
    await _expectError(
      opened.chain.getFinalizedHead,
      CitizenSdkErrorCode.notReady,
    );
    // 只读新数据空间的公开 profile，不显示、创建、导入或签名任何账户。
    _require(await opened.wallet.getProfile().timeout(_timeout) == null);
    await opened.start().timeout(_timeout);
    _require(opened.lifecycle == CitizenSdkLifecycle.running);
    await _until(() => lifecycleEvents.contains(CitizenSdkLifecycle.running));
    final running = await opened.getCapabilities().timeout(_timeout);
    _capabilities(running);
    // running 不等于已同步；不把链就绪、TPM 或用户认证硬编码为成功。
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
    await subscription.cancel();
    // close 期间仍可能收到通道错误；订阅彻底退出后再检查，不能提前判通过。
    _require(!eventFailed);
    subscription = null;
    sdk = null;

    // 关闭前一个实例后复用真实 plugin，新实例仍必须从 created 开始。
    sdk = await CitizenSdk.open().timeout(_timeout);
    _require(sdk.lifecycle == CitizenSdkLifecycle.created);
    _capabilities(await sdk.getCapabilities().timeout(_timeout));
    await sdk.close().timeout(_timeout);
    _require(sdk.lifecycle == CitizenSdkLifecycle.disposed);
    sdk = null;
  } finally {
    await subscription?.cancel();
    final remaining = sdk;
    if (remaining != null) {
      try {
        if (remaining.lifecycle == CitizenSdkLifecycle.running) {
          await remaining.stop().timeout(_timeout);
        }
        await remaining.close().timeout(_timeout);
      } on Object {
        // 原验收错误仍决定非零退出；绝不把收尾失败改写为成功。
      }
    }
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 标准 runner 必须真正创建 GTK/Flutter view；不是无 engine 的 Dart 单测。
  runApp(
    const Directionality(
      textDirection: TextDirection.ltr,
      child: SizedBox.expand(),
    ),
  );
  final watchdog = Timer(const Duration(seconds: 180), () {
    exit(1);
  });
  try {
    await WidgetsBinding.instance.endOfFrame.timeout(_timeout);
    await _verify();
    stdout.writeln('CitizenSDK Flutter consumer passed');
    await stdout.flush();
    watchdog.cancel();
    exit(0);
  } on Object {
    // 无秘密日志；调用器同时要求非零/零退出与精确成功标记，缺标记即失败。
    stderr.writeln('CitizenSDK Flutter consumer failed');
    await stderr.flush();
    watchdog.cancel();
    exit(1);
  }
}
