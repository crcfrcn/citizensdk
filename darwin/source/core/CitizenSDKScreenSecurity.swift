import Foundation
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// 只报告系统前后台/录屏事实，不创建遮罩、窗口、文本或约束；原UI保护层属于宿主。
@MainActor
internal final class CitizenSDKScreenSecurity {
    enum Change: Sendable { case inactive, background, capture }
    private var tokens: [NSObjectProtocol] = []

    var allowsDelivery: Bool {
        #if os(iOS)
        return UIApplication.shared.applicationState == .active && !UIScreen.main.isCaptured
        #elseif os(macOS)
        return NSApplication.shared.isActive
        #else
        return false
        #endif
    }

    init(changed: @escaping @MainActor @Sendable (Change) -> Void) {
        func observe(_ name: Notification.Name, _ value: Change) {
            tokens.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in changed(value) }
            })
        }
        #if os(iOS)
        observe(UIApplication.willResignActiveNotification, .inactive)
        observe(UIApplication.didEnterBackgroundNotification, .background)
        observe(UIApplication.protectedDataWillBecomeUnavailableNotification, .background)
        observe(UIScreen.capturedDidChangeNotification, .capture)
        #elseif os(macOS)
        observe(NSApplication.didResignActiveNotification, .inactive)
        #endif
    }

    func finish() {
        tokens.forEach(NotificationCenter.default.removeObserver)
        tokens.removeAll()
    }
}
