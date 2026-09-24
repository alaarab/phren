import Foundation
import PhrenKit

enum TaskSort: String, CaseIterable {
    case manual = "Task order"
    case newest = "Newest first"
    case oldest = "Oldest first"
    case priority = "Priority"
}

enum TaskAge: String, CaseIterable {
    case all = "Any age"
    case week = "Past 7 days"
    case month = "Past 30 days"
    case older = "30+ days old"
    case unknown = "Date unknown"

    func includes(_ date: Date?, now: Date) -> Bool {
        if self == .all { return true }
        if self == .unknown { return date == nil }
        guard let date else { return false }
        let days = Calendar.current.dateComponents([.day], from: date, to: now).day ?? 0
        switch self {
        case .week: return date <= now && days < 7
        case .month: return date <= now && days < 30
        case .older: return days >= 30
        default: return false
        }
    }
}

enum TaskBrowsing {
    static func creationDate(_ value: String?) -> Date? { ISO8601Dates.parse(value) }

    static func rows(_ rows: [TaskListRow], query: String, priority: PhrenTask.Priority?, age: TaskAge,
                     sort: TaskSort, now: Date = .now) -> [TaskListRow] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Parse once per task, not on each comparison during sorting.
        return rows.map { (row: $0, date: creationDate($0.task.createdAt)) }.filter {
            (priority == nil || $0.row.task.priority == priority) && age.includes($0.date, now: now)
                && (query.isEmpty || [$0.row.task.line, $0.row.task.context ?? "", $0.row.project, $0.row.task.stableId ?? ""]
                    .contains { $0.localizedCaseInsensitiveContains(query) })
        }.sorted { left, right in
            if sort == .newest || sort == .oldest {
                switch (left.date, right.date) {
                case let (a?, b?) where a != b: return sort == .newest ? a > b : a < b
                case (.some, .none): return true
                case (.none, .some): return false
                default: break
                }
            }
            if sort == .priority {
                let a = priorityRank(left.row.task.priority), b = priorityRank(right.row.task.priority)
                if a != b { return a < b }
            }
            if sort == .manual && (left.row.task.pinned ?? false) != (right.row.task.pinned ?? false) {
                return left.row.task.pinned ?? false
            }
            if left.row.task.rank != right.row.task.rank {
                return (left.row.task.rank ?? .max) < (right.row.task.rank ?? .max)
            }
            return left.row.id < right.row.id
        }.map(\.row)
    }

    private static func priorityRank(_ priority: PhrenTask.Priority?) -> Int {
        switch priority { case .high: return 0; case .medium: return 1; case .low: return 2; case nil: return 3 }
    }
}

/// Moves existing tasks using stable IDs, retaining dates, text, and priority.
enum TaskMove: String, CaseIterable {
    case active = "Move to Active"
    case backlog = "Backlog"
    case done = "Done"

    var section: PhrenTask.Section {
        switch self { case .active: return .active; case .backlog: return .queue; case .done: return .done }
    }

    var symbol: String {
        switch self { case .active: return "arrow.right"; case .backlog: return "tray"; case .done: return "checkmark" }
    }

    var id: String {
        switch self { case .active: return "move-active"; case .backlog: return "backlog"; case .done: return "done" }
    }

    func operation(for row: TaskListRow) -> PendingOp {
        let match = row.task.stableId ?? row.task.line
        if self == .done { return .completeTask(project: row.project, match: match) }
        return .updateTask(project: row.project, match: match, text: nil, priority: nil, section: section.rawValue)
    }
}

/// A successful move that took rows out of the list's current status filter.
struct TaskMoveNotice: Identifiable {
    let id = UUID()
    let destination: TaskStatus
    let projects: Set<String>
    let message: String

    init?(rows: [TaskListRow], to section: PhrenTask.Section, from status: TaskStatus) {
        let moved = rows.filter { $0.task.section != section }
        guard !moved.isEmpty, !status.sections.contains(section) else { return nil }
        destination = TaskStatus(section)
        projects = Set(moved.map(\.project))
        message = moved.count == 1 ? "Moved to \(destination.title)"
            : "\(moved.count) tasks moved to \(destination.title)"
    }
}
