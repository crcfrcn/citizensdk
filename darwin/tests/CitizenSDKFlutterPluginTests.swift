#if os(iOS)
import Flutter
#elseif os(macOS)
import FlutterMacOS
#endif
import Foundation
import XCTest
@testable import CitizenSDKFlutter

/// Mirrors Flutter's generated macOS registrant shape. A top-level Swift 5
/// function is nonisolated without using the Swift 6.1-only declaration
/// spelling. Its body is the compile-time regression gate: an actor-isolated
/// `register(with:)` cannot be called from this synchronous context.
private func citizenSDKGeneratedRegistrantCompileProbe(
    _ registrar: FlutterPluginRegistrar
) {
    CitizenSdkPlugin.register(with: registrar)
}

@MainActor
final class CitizenSDKFlutterPluginTests: XCTestCase {
    func testReplyCompletesOnceBeforeReentrantCallback() {
        var values: [String] = []
        var reply: CitizenSdkFlutterReply?
        reply = CitizenSdkFlutterReply { value in
            values.append(value as? String ?? "invalid")
            reply?.complete("reentrant")
        }
        reply?.complete("first")
        reply?.complete("duplicate")
        XCTAssertEqual(values, ["first"])
        reply = nil
    }

    // Flutter的同步调用和卸载从非隔离协议入口进入，不能改成异步或依赖隔离遵循降级。
    func testGeneratedCallbackProbesKeepSynchronousFunctionShape() {
        withExtendedLifetime(citizenSDKGeneratedCallbackCompileProbe) {
            XCTAssertTrue(Thread.isMainThread)
        }
    }

    func testDetachedEpochInvalidationRejectsListenerBeforeActorCleanup() async {
        let binding = CitizenSdkFlutterBinding()
        // 模拟非主线程销毁先撤销事件资格；尚未进行主线程通道收尾时也必须拒绝监听。
        await Task.detached { binding.invalidateEventEpochForDetach() }.value
        let failure = binding.sessions.onListen(withArguments: [2]) { _ in
            XCTFail("销毁后的事件不得交付")
        }
        XCTAssertEqual(failure?.code, "citizensdk.unavailable")
        XCTAssertTrue(binding.beginDetach())
        XCTAssertFalse(binding.beginDetach())
    }

    func testGeneratedRegistrantProbeKeepsSynchronousFunctionShape() {
        // Assigning the generated-code-shaped probe to this exact function
        // type prevents an accidental async or actor-isolated public register
        // contract from compiling, without invoking a fabricated registrar.
        let probe: (FlutterPluginRegistrar) -> Void = citizenSDKGeneratedRegistrantCompileProbe
        withExtendedLifetime(probe) {
            XCTAssertTrue(Thread.isMainThread)
        }
    }
}

private func citizenSDKGeneratedCallbackCompileProbe(
    _ plugin: CitizenSdkPlugin,
    _ call: FlutterMethodCall,
    _ result: @escaping FlutterResult,
    _ registrar: FlutterPluginRegistrar
) {
    plugin.handle(call, result: result)
    plugin.detachFromEngine(for: registrar)
}
