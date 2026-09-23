import SwiftUI
import PhrenKit

struct TaskRow: View, Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.showProject == rhs.showProject && lhs.showStore == rhs.showStore
            && lhs.canWrite == rhs.canWrite && lhs.selection == rhs.selection
    }

    let row: TaskListRow
    let showProject: Bool
    let showStore: Bool
    let canWrite: Bool
    var selection: Bool? = nil
    let onRead: () -> Void
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onToggle) {
                Image(systemName: glyphName)
                    .foregroundStyle(glyphColor)
                    .font(.title3)
            }
            .buttonStyle(.plain)
            .disabled(!canWrite)
            .accessibilityLabel(selection.map { $0 ? "Deselect task" : "Select task" } ?? (row.task.checked ? "Reopen task" : "Complete task"))
            .accessibilityIdentifier("task-select:\(row.id)")

            Button(action: onRead) {
              VStack(alignment: .leading, spacing: 5) {
                Text(.init(displayLine))
                    .font(.callout)
                    .strikethrough(row.task.checked)
                    .foregroundStyle(isDone ? PhrenTheme.textMuted : PhrenTheme.text)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 6) {
                    if showProject {
                        TagChip(text: row.project, role: .project)
                    }
                    if showStore {
                        TagChip(text: row.storeId, role: .store)
                    }
                    if let priority = row.task.priority {
                        TagChip(text: priority.rawValue, color: priority.color)
                    }
                    if row.task.pinned == true {
                        Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange)
                    }
                    if let issue = row.task.githubIssue {
                        Text("#\(issue)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(PhrenTheme.textMuted)
              }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task-detail:\(row.id)")
        }
        .padding(.vertical, 2)
    }

    private var isDone: Bool { row.task.section == .done }

    /// A done row keeps an outline check, muted; selection mode still fills
    /// the mark when this row is one of the chosen ones.
    private var glyphName: String {
        if let selection { return selection ? "checkmark.circle.fill" : "circle" }
        return isDone ? "checkmark.circle" : "circle"
    }

    private var glyphColor: Color {
        selection != nil ? PhrenTheme.accent : PhrenTheme.textMuted
    }

    /// Done rows caption their done date (last activity, falling back to the
    /// creation date); open rows keep the creation caption.
    private var caption: String {
        if isDone {
            let doneDate = TaskBrowsing.creationDate(row.task.lastActivity)
                ?? TaskBrowsing.creationDate(row.task.createdAt)
            return doneDate.map { "Done " + $0.formatted(date: .abbreviated, time: .omitted) } ?? "Date unknown"
        }
        return TaskBrowsing.creationDate(row.task.createdAt).map {
            "Created " + $0.formatted(date: .abbreviated, time: .omitted)
        } ?? "Date unknown"
    }

    private var displayLine: String {
        TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line))
    }
}

extension PhrenTask.Priority {
    var color: Color {
        switch self {
        case .high: return PhrenTheme.red
        case .medium: return PhrenTheme.amber
        case .low: return PhrenTheme.textDim
        }
    }
}
