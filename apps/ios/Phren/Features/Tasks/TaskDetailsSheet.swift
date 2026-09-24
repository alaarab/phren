import SwiftUI
import PhrenKit

/// Reading a long task never opens a text editor or changes its state.
struct TaskDetailsSheet: View {
    @Environment(AppModel.self) private var model
    @State private var editing = false
    @State private var launchingAgent = false
    let row: TaskListRow
    var onMoved: ((TaskListRow, PhrenTask.Section) -> Void)? = nil

    private var currentRow: TaskListRow {
        let task = model.snapshot(for: row.storeId).tasks[row.project]?.allItems.first {
            if let stableID = row.task.stableId { return $0.stableId == stableID }
            return $0.id == row.task.id
        }
        return TaskListRow(storeId: row.storeId, storeName: row.storeName,
                           project: row.project, task: task ?? row.task)
    }

    var body: some View {
        let row = currentRow
        PhrenList {
                if !row.task.checked {
                    Section {
                        Button {
                            launchingAgent = true
                        } label: {
                            PhrenRow(icon: "sparkles", title: "Start an agent on this task")
                        }
                        .buttonStyle(.plain)
                        .phrenIdentifier("task-start-agent")
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } header: {
                        Text("Agent")
                    } footer: {
                        Text("Choose a computer and harness. Phren sends this task to the new agent and marks backlog work active after delivery succeeds.")
                    }
                }
                Section {
                    Text(.init(TasksFile.stripPinnedTag(TasksFile.stripPriorityTag(row.task.line))))
                        .textSelection(.enabled)
                }
                if let context = row.task.context {
                    Section("Context") { Text(.init(context)).textSelection(.enabled) }
                }
                Section {
                    LabeledContent("Project", value: row.project)
                    LabeledContent("Store", value: row.storeId)
                    LabeledContent("Status", value: row.task.section == .queue ? "Backlog" : row.task.section.rawValue)
                    LabeledContent("Created", value: TaskBrowsing.creationDate(row.task.createdAt).map {
                        $0.formatted(date: .long, time: .shortened)
                    } ?? "Date unknown")
                    if let priority = row.task.priority { LabeledContent("Priority", value: priority.rawValue) }
                }
            }
            .navigationTitle("Task details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.canWrite(storeId: row.storeId, project: row.project) {
                    ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
                }
            }
            .phrenScreen()
            .sheet(isPresented: $editing) { TaskEditSheet(row: row, onMoved: onMoved) }
            .sheet(isPresented: $launchingAgent) {
                LaunchSessionView(storeID: row.storeId, project: row.project,
                                  taskRequest: TaskAgentRequest(row: row), onTaskMoved: onMoved)
            }
    }
}
