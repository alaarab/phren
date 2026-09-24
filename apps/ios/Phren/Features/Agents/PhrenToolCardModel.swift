import PhrenKit

/// Presentation state and conservative links into the phone's synced store.
struct PhrenToolCardModel {
    var isExpanded = false
    var bodyLineLimit: Int? { isExpanded ? nil : 4 }
    mutating func toggle() { isExpanded.toggle() }

    enum Destination: Identifiable, Hashable {
        case task(TaskListRow)
        case finding(store: String, project: String, Finding)
        case search(PhrenToolPresentation)

        var id: String {
            switch self {
            case .task(let row): return row.id
            case .finding(let store, let project, let finding): return "\(store)/\(project)/\(finding.stableId ?? finding.id)"
            case .search: return "search"
            }
        }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
        var label: String {
            switch self {
            case .task: return "Open task"
            case .finding: return "Open finding dossier"
            case .search: return "Open search results"
            }
        }
    }

    static func destination(_ presentation: PhrenToolPresentation, sourceStore: String?,
                            snapshots: [String: LocalStore.Snapshot]) -> Destination? {
        guard let target = presentation.target else { return nil }
        if target.kind == .search {
            return presentation.fullOutput == nil ? nil : .search(presentation)
        }
        // An explicit store must match exactly. Never substitute the first
        // attached store or a same-named project from a different store.
        guard let store = target.store ?? sourceStore, let snapshot = snapshots[store],
              let project = target.project else { return nil }
        let text = target.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        func identifier(_ value: String?) -> String? {
            value?.replacingOccurrences(of: "bid:", with: "").replacingOccurrences(of: "fid:", with: "")
        }
        if target.kind == .task {
            let matches = (snapshot.tasks[project]?.allItems ?? []).filter { task in
                if let id = identifier(target.stableID) { return task.stableId == id }
                if let text, let stable = task.stableId, identifier(text) == stable { return true }
                guard let text, !text.isEmpty else { return false }
                return TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(task.line)) == text
            }
            guard matches.count == 1, let task = matches.first else { return nil }
            return .task(TaskListRow(storeId: store, storeName: store, project: project, task: task))
        }
        let matches = (snapshot.findings[project] ?? []).filter { finding in
            if let id = identifier(target.stableID) { return finding.stableId == id }
            guard let text, !text.isEmpty else { return false }
            return finding.text == text || (presentation.tag.map { "[\($0)] \(text)" } == finding.text)
        }
        guard matches.count == 1, let finding = matches.first else { return nil }
        return .finding(store: store, project: project, finding)
    }
}
