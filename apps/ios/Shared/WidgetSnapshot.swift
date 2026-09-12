import Foundation

/// Shared JSON contract, compiled into both app and widget without app dependencies.
struct WidgetSnapshot: Codable, Equatable, Sendable {
    struct StoreCount: Codable, Equatable, Sendable, Identifiable {
        var id: String { storeName }
        var storeName: String
        var count: Int
    }

    struct TopTask: Codable, Equatable, Sendable {
        var text: String
        var project: String
    }

    var memoryCount: Int? = nil
    var projectCount: Int? = nil
    var totalReviewCount: Int
    var storeBreakdown: [StoreCount]
    var topTask: TopTask?
    var lastSyncedAt: Date?

    /// The subset that matters for deciding whether the widget's on-screen
    /// content actually needs to change. `lastSyncedAt` ticks forward on
    /// almost every live poll — `SyncEngine.setStatus` calls `notify()` (and
    /// hence `AppModel.refresh()`) on every status mutation, not just
    /// content changes, so it moves roughly every ~7s while the app is
    /// foregrounded. Comparing full snapshot bytes including it would make
    /// change-detection a no-op and spam `WidgetCenter.reloadAllTimelines()`
    /// well past its daily budget.
    struct Content: Codable, Equatable, Sendable {
        var memoryCount: Int?
        var projectCount: Int?
        var topTask: TopTask?
    }

    var content: Content {
        Content(memoryCount: memoryCount, projectCount: projectCount, topTask: topTask)
    }
}
