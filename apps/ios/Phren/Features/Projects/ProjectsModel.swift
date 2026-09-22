import Foundation
import Observation
import PhrenKit

/// The Projects tab's derived list: the filter line's text and the projects
/// it keeps, with their count and the writable targets the capture sheet
/// offers. Recomputed only when the store revisions, the store filter or the
/// search text change, so the grid never filters while drawing.
@Observable @MainActor
final class ProjectsModel {
    /// One store's identity and revision, so a sync that changes a project's
    /// counts invalidates the list even when the project set is unchanged.
    struct StoreRevision: Equatable {
        let id: String
        let revision: UUID
        let name: String
    }
    /// Everything the derived list depends on, as one value.
    struct Key: Equatable {
        let stores: [StoreRevision]
        let storeFilter: String?
        let filter: String
        let writable: [String]
    }

    var filter = ""
    private(set) var projects: [StoreProject] = []
    private(set) var voiceCaptureTargets: [VoiceCaptureTarget] = []
    private(set) var count = 0
    /// False until the first derivation, so the view never flashes an empty
    /// state for a store that has simply not been read yet.
    private(set) var ready = false
    /// Whether the whole store is empty (as opposed to just the filter),
    /// which is the difference between "Add your first project" and
    /// "No matching projects".
    private(set) var storeIsEmpty = true

    @ObservationIgnored private var key: Key?
    @ObservationIgnored private(set) var computationCount = 0

    func update(key: Key, merged: [StoreProject], writable: [StoreProject]) {
        guard key != self.key else { return }
        self.key = key
        computationCount += 1
        ready = true
        storeIsEmpty = merged.isEmpty
        let query = key.filter
        projects = query.isEmpty ? merged : merged.filter { $0.project.name.localizedCaseInsensitiveContains(query) }
        count = projects.count
        voiceCaptureTargets = writable.map {
            VoiceCaptureTarget(storeId: $0.storeId, storeName: $0.storeName, project: $0.project.name)
        }
    }
}
