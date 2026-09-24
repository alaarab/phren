import SwiftUI
import PhrenKit

struct TaskEditSheet: View {
    let row: TaskListRow
    var onMoved: ((TaskListRow, PhrenTask.Section) -> Void)?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var priority: PhrenTask.Priority?
    @State private var section: PhrenTask.Section
    @State private var pinned: Bool
    @State private var showingSection = false

    init(row: TaskListRow, onMoved: ((TaskListRow, PhrenTask.Section) -> Void)? = nil) {
        self.row = row
        self.onMoved = onMoved
        _text = State(initialValue: TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line)))
        _priority = State(initialValue: row.task.priority)
        _section = State(initialValue: row.task.section)
        _pinned = State(initialValue: row.task.pinned ?? false)
    }

    var body: some View {
        NavigationStack {
            PhrenForm {
                PhrenTextField("Task", text: $text, axis: .vertical, surface: .bare)
                    .lineLimit(2...6)
                PhrenSwitch("Pinned", isOn: $pinned)
                PhrenStepSlider(options: priorityOptions, selection: $priority, identifier: "task-priority")
                PhrenSingleSelect(options: sectionOptions, selection: $section,
                                  placeholder: "Section", identifier: "task-section",
                                  isPresented: $showingSection)
            }
            .navigationTitle("Edit task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        // TasksFile.update recomputes `pinned` from the text
                        // it's given, so the tag has to be re-appended here;
                        // otherwise saving silently unpins the task.
                        var newText = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if pinned {
                            newText += " [pinned]"
                        }
                        let newPriority = priority
                        let newSection = section != row.task.section ? section : nil
                        Task {
                            do {
                                try await model.enqueue(.updateTask(
                                    project: row.project,
                                    match: row.task.stableId ?? row.task.line,
                                    text: newText,
                                    priority: newPriority?.rawValue,
                                    section: newSection?.rawValue
                                ), in: row.storeId)
                                model.lastActionError = nil
                                await model.refresh()
                                if let newSection { onMoved?(row, newSection) }
                            } catch {
                                model.lastActionError = error.localizedDescription
                            }
                        }
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .phrenSingleSelectSheet(isPresented: $showingSection, title: "Section", options: sectionOptions,
                                selection: $section, rowPrefix: "task-section")
    }

    private var priorityOptions: [PhrenOption<PhrenTask.Priority?>] {
        [PhrenOption(id: "none", value: PhrenTask.Priority?.none, title: "none")]
            + PhrenTask.Priority.allCases.map {
                PhrenOption(id: $0.rawValue, value: PhrenTask.Priority?.some($0), title: $0.rawValue)
            }
    }
    private var sectionOptions: [PhrenOption<PhrenTask.Section>] {
        PhrenTask.Section.allCases.map {
            PhrenOption(id: $0.rawValue.lowercased(), value: $0,
                        title: $0 == .queue ? "Backlog" : $0.rawValue)
        }
    }
}
