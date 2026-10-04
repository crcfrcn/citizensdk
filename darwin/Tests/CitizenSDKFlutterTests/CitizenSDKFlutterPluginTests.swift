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
