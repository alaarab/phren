import Foundation

/// Reads the snapshot the app last wrote to `group.com.phren.ios`. Returns
/// `nil` before the app has ever run (first install) — callers must render
/// a sensible empty state, never crash or blank out, in that case.
enum WidgetDataStore {
    static let appGroupID = "group.com.phren.ios"
    private static let filename = "widget-snapshot.json"

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    static func load() -> WidgetSnapshot? {
        guard
            let url = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
                .appendingPathComponent(filename),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }
}
