import PhrenKit
import SwiftUI

/// Folded project names for the Tasks tab, stored as one newline-joined
/// AppStorage string so a fold survives leaving the tab and relaunching.
enum TasksCollapse {
    static let storageKey = "tasks.collapsed.v1"

    static func decode(_ raw: String) -> Set<String> {
        Set(raw.split(separator: "\n", omittingEmptySubsequences: true).map(String.init))
    }

    static func encode(_ projects: Set<String>) -> String {
        projects.sorted().joined(separator: "\n")
    }
}

/// The Tasks tab's status filter: which sections the list shows. Open
/// (Active plus Queue) is the default; the choice is remembered in
/// AppStorage (`tasks.status`).
enum TaskStatus: String, CaseIterable {
    case open = "open"
    case active = "active"
    case backlog = "backlog"
    case done = "done"
    case all = "all"

    var title: String {
        switch self {
        case .open: return "Open"
        case .active: return "Active"
        case .backlog: return "Backlog"
        case .done: return "Done"
        case .all: return "All"
        }
    }

    /// The sections this filter draws, in row order.
    var sections: [PhrenTask.Section] {
        switch self {
        case .open: return [.active, .queue]
        case .active: return [.active]
        case .backlog: return [.queue]
        case .done: return [.done]
        case .all: return [.active, .queue, .done]
        }
    }

    /// One project's total under this filter: only the sections it draws,
    /// so section order follows the chosen status.
    func count(active: Int, queue: Int, done: Int) -> Int {
        switch self {
        case .open: return active + queue
        case .active: return active
        case .backlog: return queue
        case .done: return done
        case .all: return active + queue + done
        }
    }

    /// The empty-list heading when the filter itself matches nothing.
    var emptyListTitle: String {
        switch self {
        case .open: return "No open tasks"
        case .active: return "No active tasks"
        case .backlog: return "No backlog tasks"
        case .done: return "No completed tasks"
        case .all: return "No tasks"
        }
    }

    /// The status a bulk move lands on, so the list follows the moved rows.
    init(_ section: PhrenTask.Section) {
        switch section {
        case .active: self = .active
        case .queue: self = .backlog
        case .done: self = .done
        }
    }
}

/// One project's slice of the visible list: the rows to draw under the
/// header, and the per-section counts its chips show.
struct TaskSectionGroup: Identifiable {
    let project: String
    /// A store that carries this project, for its name colour. Merged groups
    /// pick the alphabetically first store so the colour is stable.
    let storeId: String
    let rows: [TaskListRow]
    let activeCount: Int
    let queueCount: Int
    let doneCount: Int
    var id: String { project }
}

/// The Tasks tab's browsing state: filters, selection, and the rows and
/// groups they produce. Presentation routes and the AppStorage-backed
/// section, sort and fold keys stay in `TaskListView`.
@Observable @MainActor
final class TasksModel {
    var selectedProject: String?
    var query = ""
    var showSearch = false
    var isSelecting = false
    var selectedIDs: Set<String> = []
    var isMoving = false
    var priority: PhrenTask.Priority?
    var age: TaskAge = .all

    /// Rows for one status section, before the person's search and filters.
    func rawRows(in section: PhrenTask.Section, scope: TaskListView.Scope, model: AppModel) -> [TaskListRow] {
        var result: [TaskListRow] = []
        if case .project(let scopeStore, let scopeProject) = scope {
            // Project scope reads the store's snapshot directly: the global
            // store filter must not blank out a project-detail tab.
            if let doc = model.snapshot(for: scopeStore).tasks[scopeProject] {
                for task in doc.items(in: section) {
                    result.append(TaskListRow(storeId: scopeStore, storeName: model.storeName(for: scopeStore),
                                              project: scopeProject, task: task))
                }
            }
        } else {
            for (storeId, storeName, doc) in model.mergedTaskDocs {
                if let selectedProject, doc.project != selectedProject { continue }
                for task in doc.items(in: section) {
                    result.append(TaskListRow(storeId: storeId, storeName: storeName,
                                              project: doc.project, task: task))
                }
            }
        }
        return result
    }

    /// The same rows through the active search, priority, age and sort.
    func rows(in section: PhrenTask.Section, sort: TaskSort, scope: TaskListView.Scope, model: AppModel) -> [TaskListRow] {
        TaskBrowsing.rows(rawRows(in: section, scope: scope, model: model),
                          query: query, priority: priority, age: age, sort: sort)
    }

    /// The rows one status filter shows: its sections flattened (Open is
    /// Active plus Queue, All is everything), then the same search, filters
    /// and sort.
    func rows(for status: TaskStatus, sort: TaskSort, scope: TaskListView.Scope, model: AppModel) -> [TaskListRow] {
        TaskBrowsing.rows(status.sections.flatMap { rawRows(in: $0, scope: scope, model: model) },
                          query: query, priority: priority, age: age, sort: sort)
    }

    /// Item counts per project for one section of the current scope, without
    /// building rows: `groups` only needs the numbers for ordering and chips.
    private func sectionCounts(in section: PhrenTask.Section,
                               scope: TaskListView.Scope, model: AppModel) -> [String: Int] {
        var counts: [String: Int] = [:]
        if case .project(let scopeStore, let scopeProject) = scope {
            if let doc = model.snapshot(for: scopeStore).tasks[scopeProject] {
                let count = doc.items(in: section).count
                if count > 0 { counts[scopeProject] = count }
            }
        } else {
            for (_, _, doc) in model.mergedTaskDocs {
                if let selectedProject, doc.project != selectedProject { continue }
                let count = doc.items(in: section).count
                if count > 0 { counts[doc.project, default: 0] += count }
            }
        }
        return counts
    }

    /// Visible rows grouped per project, each with that project's own
    /// Active, Queue and Done counts, ordered by the chosen status's total
    /// with ties by name. Counts ignore the search and filters, so a header
    /// still reports how much work the project really carries.
    /// `storeIdByProject` comes from the store list, never from the filtered
    /// rows, so a project's colour cannot flip when a search drops one
    /// store's rows.
    func groups(visible: [TaskListRow], scope: TaskListView.Scope, model: AppModel,
                status: TaskStatus) -> [TaskSectionGroup] {
        let storeIdByProject = Dictionary(grouping: model.mergedTaskDocs, by: { $0.doc.project })
            .mapValues { docs in docs.map(\.storeId).sorted().first ?? "" }
        return Self.groups(visible: visible,
                           activeCounts: sectionCounts(in: .active, scope: scope, model: model),
                           queueCounts: sectionCounts(in: .queue, scope: scope, model: model),
                           storeIdByProject: storeIdByProject,
                           doneCounts: sectionCounts(in: .done, scope: scope, model: model),
                           status: status)
    }

    /// Pure grouping over prepared rows: order by the chosen status's count
    /// (open under Open, queue under Backlog, and so on), tie-break by name,
    /// colour store from the store list.
    nonisolated static func groups(visible: [TaskListRow],
                                   activeCounts: [String: Int],
                                   queueCounts: [String: Int],
                                   storeIdByProject: [String: String],
                                   doneCounts: [String: Int] = [:],
                                   status: TaskStatus = .open) -> [TaskSectionGroup] {
        Dictionary(grouping: visible, by: \.project).map { project, rows in
            TaskSectionGroup(project: project,
                             storeId: storeIdByProject[project] ?? rows.map(\.storeId).sorted().first ?? "",
                             rows: rows,
                             activeCount: activeCounts[project] ?? 0,
                             queueCount: queueCounts[project] ?? 0,
                             doneCount: doneCounts[project] ?? 0)
        }
        .sorted { left, right in
            let leftCount = status.count(active: left.activeCount, queue: left.queueCount, done: left.doneCount)
            let rightCount = status.count(active: right.activeCount, queue: right.queueCount, done: right.doneCount)
            return leftCount != rightCount ? leftCount > rightCount : left.project < right.project
        }
    }
}
