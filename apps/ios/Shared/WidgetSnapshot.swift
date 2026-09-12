import Foundation

/// Shared JSON contract, compiled into both app and widget without app dependencies.
struct WidgetSnapshot: Codable, Equatable, Sendable {
    struct TopTask: Codable, Equatable, Sendable {
        var text: String
        var project: String
    }

    var memoryCount: Int? = nil
    var projectCount: Int? = nil
    var topTask: TopTask?
    var lastSyncedAt: Date?

    /// Everything the widget views actually render, minus `lastSyncedAt`.
    /// That stamp ticks forward on every live poll (~7s while the app is
    /// foregrounded), so it is neither a reason to reload the widget nor —
    /// see `WidgetSnapshotWriter` — a reason to rewrite the file more than
    /// about once a minute; the widget only reads the file on a content
    /// reload or its own 15-minute backstop anyway.
    struct Content: Codable, Equatable, Sendable {
        var memoryCount: Int?
        var projectCount: Int?
        var topTask: TopTask?
    }

    var content: Content {
        Content(memoryCount: memoryCount, projectCount: projectCount, topTask: topTask)
    }
}
