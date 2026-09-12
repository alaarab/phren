import Foundation

public struct SessionProject: Hashable, Sendable {
    public let storeID: String
    public let name: String
    public init(storeID: String, name: String) { self.storeID = storeID; self.name = name }
}

public struct SessionProjectMatch: Equatable, Sendable {
    public let project: SessionProject
    public let directory: String
    public let automatic: Bool
}

extension LiveSessionPreferences {
    /// Explicit directory choices win, including unavailable projects. Otherwise
    /// use the deepest directory component naming exactly one attached project.
    /// A label or agent conversation ID is never evidence of project identity.
    public func projectMatch(hostID: UUID, cwd: String?, projects: [SessionProject]) -> SessionProjectMatch? {
        guard hosts.contains(where: { $0.id == hostID }),
              let cwd, let directory = try? Self.normalizedDirectory(cwd) else { return nil }
        if let saved = mapping(hostID: hostID, cwd: directory) {
            return SessionProjectMatch(project: SessionProject(storeID: saved.storeID, name: saved.project),
                                       directory: saved.directory, automatic: false)
        }
        var parts = directory.split(separator: "/").map(String.init)
        while !parts.isEmpty {
            let matches = Set(projects.filter { $0.name != "global" && $0.name.caseInsensitiveCompare(parts.last!) == .orderedSame })
            if !matches.isEmpty {
                guard matches.count == 1, let project = matches.first else { return nil }
                return SessionProjectMatch(project: project, directory: "/" + parts.joined(separator: "/"), automatic: true)
            }
            parts.removeLast()
        }
        return nil
    }
}

/// The tab selected on a known computer. Its destination comes from the hook's
/// workspace and (when needed) tab IDs, never the agent `sessionId` or label.
public struct LiveAgentSession: Equatable, Identifiable, Sendable {
    public struct ID: Codable, Hashable, Sendable {
        public let hostID: UUID
        public let workspace: String
        public let tab: String
        public var muxID: String = "herdr:default"

        public init(hostID: UUID, workspace: String, tab: String, muxID: String = "herdr:default") {
            self.hostID = hostID; self.workspace = workspace; self.tab = tab; self.muxID = muxID
        }
    }
    public let host: LiveHost
    public let workspaceID: String
    public let workspaceName: String
    public let workspaceTabCount: Int?
    public let tab: LiveWorkspaces.Tab
    public var id: ID { ID(hostID: host.id, workspace: workspaceID, tab: tab.id, muxID: host.muxID) }

    public func matches(_ query: String, projectName: String? = nil) -> Bool {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        let text = [host.name, host.address, host.herdrSession ?? "default", workspaceName,
                    tab.displayTitle, tab.label, tab.agent ?? "", tab.cwd ?? "", projectName ?? ""].joined(separator: " ")
        return terms.allSatisfy { text.localizedCaseInsensitiveContains($0) }
    }

    public init(host: LiveHost, workspaceID: String, workspaceName: String, tab: LiveWorkspaces.Tab,
                workspaceTabCount: Int? = nil) {
        self.host = host; self.workspaceID = workspaceID; self.workspaceName = workspaceName; self.tab = tab
        self.workspaceTabCount = workspaceTabCount
    }


}

extension LiveWorkspaces {
    public func sessions(on host: LiveHost) -> [LiveAgentSession] {
        groups.flatMap { group in
            group.children.map { LiveAgentSession(host: host, workspaceID: group.id, workspaceName: group.label,
                                                       tab: $0, workspaceTabCount: group.children.count) }
        }
    }
}
