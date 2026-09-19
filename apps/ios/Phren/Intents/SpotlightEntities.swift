import AppIntents
import CoreSpotlight
import PhrenKit

extension AgentSessionEntity {
    var spotlightImage: DisplayRepresentation.Image {
        switch agent {
        case "claude": return .init(named: "ClaudeMark", isTemplate: true)
        case "codex": return .init(named: "CodexMark", isTemplate: true)
        case "copilot": return .init(named: "CopilotMark", isTemplate: true)
        default: return .init(systemName: "terminal")
        }
    }

    var harnessName: String? {
        switch agent {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "copilot": return "Copilot"
        default: return agent
        }
    }
}

@available(iOS 18.0, *)
extension AgentSessionEntity: IndexedEntity {
    var attributeSet: CSSearchableItemAttributeSet {
        let attributes = defaultAttributeSet
        attributes.title = title
        attributes.displayName = "\(title) · \(project ?? workspace) on \(computer)"
        attributes.contentDescription = [project ?? workspace, computer, harnessName, state, branch, folder]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        attributes.keywords = ["phren", "session", "chat", "terminal", workspace, project, computer,
                               agent, harnessName, state, branch, folder].compactMap { $0 }
        attributes.containerTitle = project ?? workspace
        attributes.containerDisplayName = computer
        attributes.path = folder
        attributes.contentModificationDate = lastChangedAt
        return attributes
    }
}

@available(iOS 18.0, *)
extension ProjectEntity: IndexedEntity {
    var attributeSet: CSSearchableItemAttributeSet {
        let attributes = defaultAttributeSet
        attributes.title = project
        attributes.displayName = qualified ? "\(project) · \(storeName)" : project
        let details = sessions.flatMap { [$0.computer, $0.harnessName, $0.state, $0.branch, $0.folder].compactMap { $0 } }
        attributes.contentDescription = ([storeName] + details + [sourceFolder].compactMap { $0 }).joined(separator: " · ")
        attributes.keywords = Array(Set(["phren", "project", project, storeName, storeId] + details
                                       + [sourceFolder].compactMap { $0 })).sorted()
        attributes.containerTitle = storeName
        attributes.containerIdentifier = storeId
        attributes.path = sourceFolder ?? sessions.first?.folder
        return attributes
    }
}

/// Readable projects, independent of the on-screen store filter and capture's
/// write permissions. Used for indexing and resolving an indexed project ID.
@MainActor
enum SpotlightProjects {
    static func entities(from model: AppModel) -> [ProjectEntity] {
        model.storeContexts.flatMap { context in
            entities(in: context.snapshot, store: context.descriptor, qualified: model.hasMultipleStores)
        }.sorted { $0.id < $1.id }
    }

    static func entities(in snapshot: LocalStore.Snapshot, store: StoreDescriptor, qualified: Bool) -> [ProjectEntity] {
        snapshot.projects.filter { $0.name != "global" }.map { project in
            var entity = ProjectEntity(target: .init(storeId: store.id, storeName: store.displayName,
                                                     project: project.name, qualified: qualified))
            entity.sourceFolder = snapshot.machines.sourcePaths[project.name]
            return entity
        }
    }

    static func runningSession(for target: ProjectEntity, among sessions: [LiveAgentSession],
                               projects: [ProjectEntity], preferences: LiveSessionPreferences?) -> LiveAgentSession? {
        let choices = projects.map { SessionProject(storeID: $0.storeId, name: $0.project) }
        return sessions.first {
            $0.tab.agent != nil && preferences?.projectMatch(hostID: $0.host.id, cwd: $0.tab.cwd, projects: choices)?.project
                == SessionProject(storeID: target.storeId, name: target.project)
        }
    }

    static func current() async -> [ProjectEntity] {
        if let model = AppModel.current, !model.storeContexts.isEmpty { return entities(from: model) }
        let descriptors = AppModel.storedDescriptors()
        var result: [ProjectEntity] = []
        for descriptor in descriptors {
            guard let store = try? PhrenCapture.openStore(descriptor) else { continue }
            let snapshot = await store.snapshot()
            result += entities(in: snapshot, store: descriptor, qualified: descriptors.count > 1)
        }
        return result.sorted { $0.id < $1.id }
    }
}
