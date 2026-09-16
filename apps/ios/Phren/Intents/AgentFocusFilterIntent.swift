import AppIntents
import Foundation
import PhrenKit

struct AgentFocusFilter: Codable, Equatable, Sendable {
    let computerID: UUID?
    let storeID: String?
    let label: String

    func includes(_ session: LiveAgentSession, preferences: LiveSessionPreferences?, projects: [SessionProject]) -> Bool {
        if let computerID, session.host.id != computerID { return false }
        if let storeID {
            guard preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd, projects: projects)?.project.storeID == storeID else { return false }
        }
        return true
    }
}

@MainActor
enum AgentFocusFilterStore {
    static let key = "agents.focus-filter.v1"
    static let changed = Notification.Name("phren.agents.focus-filter.changed")

    static func load(defaults: UserDefaults = AppRuntime.defaults) -> AgentFocusFilter? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(AgentFocusFilter.self, from: $0) }
    }
    static func save(_ filter: AgentFocusFilter?, defaults: UserDefaults = AppRuntime.defaults) {
        if let filter { defaults.set(try? JSONEncoder().encode(filter), forKey: key) }
        else { defaults.removeObject(forKey: key) }
        NotificationCenter.default.post(name: changed, object: nil)
    }
    static func refreshFromSystem(defaults: UserDefaults = AppRuntime.defaults) async -> AgentFocusFilter? {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting, ProcessInfo.processInfo.arguments.contains("--focus-filter-fixture") {
            let value = AgentFocusFilter(computerID: UUID(uuidString: "A1000000-0000-0000-0000-000000000002"),
                                         storeID: nil, label: "Test Linux")
            save(value, defaults: defaults); return value
        }
        #endif
        guard let current = try? await AgentFocusFilterIntent.current else { save(nil, defaults: defaults); return nil }
        let value = current.value
        save(value, defaults: defaults)
        return value
    }
}

struct FocusStoreEntity: AppEntity, Equatable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Phren store")
    static var defaultQuery = FocusStoreQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(id)", image: .init(systemName: "externaldrive")) }
}

struct FocusStoreQuery: EntityStringQuery {
    @MainActor private static func values() -> [FocusStoreEntity] { AppModel.storedDescriptors().map { .init(id: $0.id, name: $0.displayName) } }
    func entities(for identifiers: [String]) async throws -> [FocusStoreEntity] { let wanted = Set(identifiers); return await Self.values().filter { wanted.contains($0.id) } }
    func suggestedEntities() async throws -> [FocusStoreEntity] { await Self.values() }
    func entities(matching string: String) async throws -> [FocusStoreEntity] {
        await Self.values().filter { string.isEmpty || "\($0.name) \($0.id)".localizedCaseInsensitiveContains(string) }
    }
}

struct AgentFocusFilterIntent: SetFocusFilterIntent {
    static var title: LocalizedStringResource = "Filter Agent Sessions"
    static var description = IntentDescription("Shows sessions from one computer, one phren store, or both while a Focus is active.", categoryName: "Agents")

    @Parameter(title: "Computer") var computer: SessionComputerEntity?
    @Parameter(title: "Store") var store: FocusStoreEntity?
    static var parameterSummary: some ParameterSummary { Summary("Show agents for \(\.$computer) in \(\.$store)") }

    init() {}
    init(computer: SessionComputerEntity? = nil, store: FocusStoreEntity? = nil) { self.computer = computer; self.store = store }

    var value: AgentFocusFilter? {
        guard computer != nil || store != nil else { return nil }
        return AgentFocusFilter(computerID: computer?.id, storeID: store?.id,
                                label: [computer?.name, store?.name].compactMap { $0 }.joined(separator: " · "))
    }
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Agents · \(value?.label ?? "All sessions")", image: .init(systemName: "scope"))
    }
    var appContext: FocusFilterAppContext { FocusFilterAppContext() }

    @MainActor
    func perform() async throws -> some IntentResult {
        AgentFocusFilterStore.save(value)
        return .result()
    }

    static func suggestedFocusFilters(for context: FocusFilterSuggestionContext) async -> [Self] {
        let computers = await AgentSessions.hosts.prefix(4).map { SessionComputerEntity(id: $0.id, name: $0.name) }
        let stores = await MainActor.run { AppModel.storedDescriptors().prefix(4).map { FocusStoreEntity(id: $0.id, name: $0.displayName) } }
        return computers.map { Self(computer: $0) } + stores.map { Self(store: $0) }
    }
}
