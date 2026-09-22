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

/// One project's slice of the visible section: the rows to draw under the
/// header, and the unfiltered open counts its chips show.
struct TaskSectionGroup: Identifiable {
    let project: String
    /// A store that carries this project, for its name colour. Merged groups
    /// pick the alphabetically first store so the colour is stable.
    let storeId: String
    let rows: [TaskListRow]
    let activeCount: Int
    let queueCount: Int
    var openCount: Int { activeCount + queueCount }
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

    /// Active or Queue item counts per project for the current scope, without
    /// building rows: `groups` only needs the numbers for ordering and chips.
    private func openCounts(in section: PhrenTask.Section,
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

    /// Visible rows grouped per project, each with that project's own Active
    /// and Queue counts, busiest open work first and ties by name. Counts
    /// ignore the search and filters, so a header still reports how much open
    /// work the project really carries. `storeIdByProject` comes from the
    /// store list, never from the filtered rows, so a project's colour
    /// cannot flip when a search drops one store's rows.
    func groups(visible: [TaskListRow], scope: TaskListView.Scope, model: AppModel) -> [TaskSectionGroup] {
        let storeIdByProject = Dictionary(grouping: model.mergedTaskDocs, by: { $0.doc.project })
            .mapValues { docs in docs.map(\.storeId).sorted().first ?? "" }
        return Self.groups(visible: visible,
                           activeCounts: openCounts(in: .active, scope: scope, model: model),
                           queueCounts: openCounts(in: .queue, scope: scope, model: model),
                           storeIdByProject: storeIdByProject)
    }

    /// Pure grouping over prepared rows: order by open count (Active plus
    /// Queue), tie-break by name, colour store from the store list.
    nonisolated static func groups(visible: [TaskListRow],
                                   activeCounts: [String: Int],
                                   queueCounts: [String: Int],
                                   storeIdByProject: [String: String]) -> [TaskSectionGroup] {
        Dictionary(grouping: visible, by: \.project).map { project, rows in
            TaskSectionGroup(project: project,
                             storeId: storeIdByProject[project] ?? rows.map(\.storeId).sorted().first ?? "",
                             rows: rows,
                             activeCount: activeCounts[project] ?? 0,
                             queueCount: queueCounts[project] ?? 0)
        }
        .sorted { left, right in
            left.openCount != right.openCount ? left.openCount > right.openCount : left.project < right.project
        }
    }
}
