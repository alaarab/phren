import Foundation

public struct SessionProject: Codable, Hashable, Sendable {
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
            let candidate = "/" + parts.joined(separator: "/")
            // A home folder is never a project, even when a project shares the
            // user's name: /home/sam/Projects/hub must not resolve to "sam".
            if Self.isHomeDirectory(candidate) { break }
            let matches = Set(projects.filter { $0.name != "global" && $0.name.caseInsensitiveCompare(parts.last!) == .orderedSame })
            if !matches.isEmpty {
                guard matches.count == 1, let project = matches.first else { return nil }
                return SessionProjectMatch(project: project, directory: "/" + parts.joined(separator: "/"), automatic: true)
            }
            parts.removeLast()
        }
        return nil
    }

    /// `/home/<user>`, `/Users/<user>`, `/root`, and the mount points above them.
    static func isHomeDirectory(_ path: String) -> Bool {
        path == "/root" || path.range(of: #"^/(home|Users)(/[^/]+)?$"#, options: .regularExpression) != nil
    }
}

/// The tab selected on a known computer. Its destination comes from the hook's
/// workspace and (when needed) tab IDs, never the agent `sessionId` or label.
public struct LiveAgentSession: Codable, Equatable, Hashable, Identifiable, Sendable {
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
    /// Navigation destinations hash sessions; equal sessions share an id, so
    /// the id alone keeps Hashable consistent with Equatable.
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }

    /// A human folder label for sessions whose cwd is not linked to a phren
    /// project. Herdr workspace labels can be usernames or transport names.
    public var folderName: String? {
        guard let cwd = tab.cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cwd.isEmpty else { return nil }
        let trimmed = cwd.count > 1 ? cwd.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression) : cwd
        guard let name = trimmed.split(separator: "/").last.map(String.init), !name.isEmpty else { return nil }
        return name
    }

    public func projectDisplayName(_ mappedProject: String?) -> String {
        if let mappedProject = mappedProject?.trimmingCharacters(in: .whitespacesAndNewlines), !mappedProject.isEmpty { return mappedProject }
        return folderName ?? (workspaceName.isEmpty ? tab.displayTitle : workspaceName)
    }

    public func usesFolderFallback(mappedProject: String?) -> Bool {
        mappedProject?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false && folderName != nil
    }

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

/// A display section that can contain tabs from more than one Herdr
/// workspace. The sessions retain their original workspace IDs so opening or
/// closing one still targets the workspace the Hook reported.
public struct LiveAgentWorkspaceSection: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let sessions: [LiveAgentSession]
}

public enum LiveAgentWorkspaceGrouping {
    /// Groups the host screen by the Phren project when one can be resolved,
    /// then by a normalized workspace label. Herdr creates a new workspace ID
    /// each time a project is opened, so the ID is a destination rather than a
    /// useful presentation key.
    public static func sections(_ sessions: [LiveAgentSession], preferences: LiveSessionPreferences?,
                                projects: [SessionProject]) -> [LiveAgentWorkspaceSection] {
        struct Pending {
            let title: String
            var sessions: [LiveAgentSession]
        }
        var pending: [String: Pending] = [:]
        var order: [String] = []
        for session in sessions {
            let match = preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd, projects: projects)
            let title: String
            let key: String
            if let project = match?.project {
                title = project.name
                key = "project:\(project.storeID)\u{0}\(project.name)"
            } else {
                let label = session.workspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
                if label.isEmpty {
                    title = session.projectDisplayName(nil)
                    key = "workspace:\(session.workspaceID)"
                } else {
                    title = label
                    key = "label:\(normalizedLabel(label))"
                }
            }
            if var existing = pending[key] {
                existing.sessions.append(session)
                pending[key] = existing
            } else {
                pending[key] = Pending(title: title, sessions: [session])
                order.append(key)
            }
        }
        return order.compactMap { key in
            pending[key].map { LiveAgentWorkspaceSection(id: key, title: $0.title, sessions: $0.sessions) }
        }
    }

    private static func normalizedLabel(_ label: String) -> String {
        label.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                     locale: Locale(identifier: "en_US_POSIX"))
    }
}
