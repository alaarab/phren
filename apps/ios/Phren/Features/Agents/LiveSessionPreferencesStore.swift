import Foundation
import Observation
import PhrenKit
import SwiftUI

/// The one reader of `sessions.live.preferences.v1` for views that render
/// often: saved computers, directory links and pins, decoded once per change
/// of the stored bytes instead of once per property access in `body`.
///
/// It reads and writes the same key in the same defaults the rest of the app
/// uses (`AppRuntime.defaults`), so the widget, intents and every remaining
/// `@AppStorage` reader keep working and see its writes; a write made by one of
/// those readers arrives here through `UserDefaults.didChangeNotification`.
/// `preferences` is nil when the stored document cannot be read, the same
/// meaning as a failed `LiveSessionPreferences.read`.
///
/// Views reach it through `@Environment(\.liveSessionPreferences)`, whose
/// default is `shared`, so a view in a sheet or a separate root never finds it
/// missing.
///
/// Every view reads and writes the key through this store, so a render never
/// decodes it. Code that runs on an event rather than in `body` (intents, the
/// widget bridge, notification and approval handlers, UI test fixtures and
/// PhrenApp's push registration) still reads defaults directly when it runs.
@Observable @MainActor
final class LiveSessionPreferencesStore {
    static let key = "sessions.live.preferences.v1"
    static let shared = LiveSessionPreferencesStore(defaults: AppRuntime.defaults)

    /// The stored bytes, exactly as in defaults.
    private(set) var data: Data
    /// The decoded document; nil when the stored bytes are unreadable.
    private(set) var preferences: LiveSessionPreferences?
    /// The decode error for unreadable bytes, for screens that say so.
    private(set) var readError: String?

    var hosts: [LiveHost] { preferences?.hosts ?? [] }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let decode: (Data) throws -> LiveSessionPreferences
    @ObservationIgnored private var observer: NSObjectProtocol?

    init(defaults: UserDefaults,
         decode: @escaping (Data) throws -> LiveSessionPreferences = LiveSessionPreferences.read) {
        self.defaults = defaults
        self.decode = decode
        let stored = defaults.data(forKey: Self.key) ?? Data()
        let decoded = Self.decoded(stored, with: decode)
        data = stored
        preferences = decoded.0
        readError = decoded.1
        observer = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification, object: defaults, queue: nil
        ) { [weak self] _ in
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.reload() }
            } else {
                Task { @MainActor in self?.reload() }
            }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    /// Picks up a write made elsewhere. Unchanged bytes decode nothing.
    func reload() {
        apply(defaults.data(forKey: Self.key) ?? Data())
    }

    /// Writes new bytes through to defaults and decodes them once.
    func write(_ newData: Data) {
        apply(newData)
        defaults.set(newData, forKey: Self.key)
    }

    /// Applies one of `LiveSessionPreferences`'s editing functions to the
    /// current bytes and writes the result through. A throw leaves both the
    /// stored and the decoded document unchanged.
    func update(_ transform: (Data) throws -> Data) throws {
        write(try transform(data))
    }

    /// A binding over the raw bytes, for controls that take `Binding<Data>`.
    var binding: Binding<Data> {
        Binding(get: { self.data }, set: { self.write($0) })
    }

    private func apply(_ newData: Data) {
        guard newData != data else { return }
        let decoded = Self.decoded(newData, with: decode)
        data = newData
        preferences = decoded.0
        readError = decoded.1
    }

    private static func decoded(_ data: Data, with decode: (Data) throws -> LiveSessionPreferences)
        -> (LiveSessionPreferences?, String?) {
        do { return (try decode(data), nil) } catch { return (nil, error.localizedDescription) }
    }
}

private struct LiveSessionPreferencesKey: EnvironmentKey {
    // SwiftUI reads the environment on the main thread.
    static var defaultValue: LiveSessionPreferencesStore { MainActor.assumeIsolated { .shared } }
}

extension EnvironmentValues {
    var liveSessionPreferences: LiveSessionPreferencesStore {
        get { self[LiveSessionPreferencesKey.self] }
        set { self[LiveSessionPreferencesKey.self] = newValue }
    }
}
