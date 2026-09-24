import Foundation

/// A device-local bookmark. Store identity is always the full owner/repo;
/// graph IDs alone are only unique within that store.
public struct GraphSavedView: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    public var storeID: String
    public var project: String?
    public var filter: GraphPayload.ContentFilter
    public var nodeID: String?
    public var steps: Int

    public init(name: String, storeID: String, project: String?,
                filter: GraphPayload.ContentFilter, nodeID: String?, steps: Int = 1) {
        self.id = UUID()
        self.name = name
        self.storeID = storeID
        self.project = project
        self.filter = filter
        self.nodeID = nodeID
        self.steps = min(2, max(1, steps))
    }
}
