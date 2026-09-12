import Foundation

/// Shared launch configuration for app preferences and simulator fixtures.
/// Device and Release builds always use the normal preferences domain.
enum AppRuntime {
    static var isUITesting: Bool {
        #if DEBUG && targetEnvironment(simulator)
        return ProcessInfo.processInfo.arguments.contains("--ui-testing")
        #else
        return false
        #endif
    }

    static let defaults: UserDefaults = isUITesting
        ? UserDefaults(suiteName: "phren.ui-tests")! : .standard
}
