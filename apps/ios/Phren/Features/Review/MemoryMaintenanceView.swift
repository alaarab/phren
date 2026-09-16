import PhrenKit
import SwiftUI

/// An optional project overview, not an inbox of required human decisions.
struct MemoryMaintenanceView: View {
    @Environment(AppModel.self) private var model

    private var groups: [MaintenanceProject] {
        Dictionary(grouping: model.mergedReviewQueue) { "\($0.storeId)/\($0.entry.project)" }
            .values.compactMap { entries in
                entries.first.map { MaintenanceProject(storeID: $0.storeId, project: $0.entry.project, entries: entries) }
            }.sorted { ($0.project, $0.storeID) < ($1.project, $1.storeID) }
    }

    var body: some View {
        PhrenList {
                Section {
                    Text("Your agents capture and use memory as you work. You can leave routine maintenance to an agent, or inspect a project here.")
                        .foregroundStyle(.secondary)
                    Text("These entries can include candidates, stale memories, and conflicts. They are not approvals required for every agent action.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("By project") {
                    ForEach(groups) { group in
                        NavigationLink {
                            ReviewView(storeID: group.storeID, project: group.project)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(group.project).font(.headline)
                                Text(group.storeID).font(.caption).foregroundStyle(.secondary)
                                Text(group.summary).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityIdentifier("maintenance-project:\(group.storeID):\(group.project)")
                    }
                    if groups.isEmpty { Text("No maintenance entries in these stores.").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Memory maintenance")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.pullToRefresh() }
            .phrenScreen()
    }
}

private struct MaintenanceProject: Identifiable {
    let storeID: String
    let project: String
    let entries: [StoreQueueEntry]
    var id: String { "\(storeID)/\(project)" }
    var summary: String {
        QueueItem.Section.allCases.compactMap { section in
            let count = entries.filter { $0.entry.item.section == section }.count
            return count == 0 ? nil : "\(count) \(section == .review ? "candidates" : section.rawValue.lowercased())"
        }.joined(separator: " · ")
    }
}
