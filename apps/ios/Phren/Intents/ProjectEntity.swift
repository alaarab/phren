import AppIntents
import Foundation

/// A phren project. Capture queries suggest writable destinations; Spotlight
/// can also resolve and open projects in read-only stores.
///
/// Identity is the (store, project) pair, not the bare name: the app keys
/// projects by store precisely because the same name can exist in two stores
/// (AppModel's `StoreProject`), and a saved shortcut has to keep pointing at
/// the one the user picked.
struct ProjectEntity: AppEntity, Equatable, Codable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Project")
    }

    static var defaultQuery = ProjectEntityQuery()

    let id: String
    let project: String
    let storeId: String
    let storeName: String
    /// Whether the store has to be shown alongside the project name.
    let qualified: Bool
    var sourceFolder: String?
    var sessions: [AgentSessionEntity] = []

    init(target: PhrenCaptureTarget) {
        self.id = target.entityId
        self.project = target.project
        self.storeId = target.storeId
        self.storeName = target.storeName
        self.qualified = target.qualified
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(displayName)", image: sessions.first?.spotlightImage ?? .init(systemName: "folder"), synonyms: synonyms)
    }

    private var displayName: String {
        qualified ? "\(project) · \(storeName)" : project
    }

    /// Store names are slugs; a speaker says the words. "alpha-lens-website"
    /// is heard and read back as "alpha lens website", so offer that spelling
    /// as a match candidate too. (Nothing can recover the word boundary in an
    /// unseparated slug like "alphalens" — `ProjectEntityQuery` handles that
    /// direction instead, by stripping spaces out of what was heard.)
    private var synonyms: [LocalizedStringResource] {
        let spaced = project
            .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." })
            .joined(separator: " ")
        return spaced == project ? [] : ["\(spaced)"]
    }
}

/// Lists and matches projects for the `project` parameter.
///
/// `EntityStringQuery` is what makes "add a task to alpha lens in phren" work:
/// Siri hands over the raw phrase fragment and expects the app to say which
/// projects it could mean. Both sides are normalized down to letters and
/// digits, so spoken word breaks ("alpha lens") match an unseparated slug
/// ("alphalens") and a hyphenated slug ("alpha-lens-website") matches a
/// spoken phrase either way round.
///
/// Every survivor is returned, best first, rather than the top hit alone:
/// when "alpha lens" could be `alphalens` or `alpha-lens-website`, Siri asks
/// which one instead of silently filing the capture in the wrong project. A
/// single survivor resolves without a question.
struct ProjectEntityQuery: EntityStringQuery {
    func entities(for identifiers: [ProjectEntity.ID]) async throws -> [ProjectEntity] {
        let wanted = Set(identifiers)
        // Opening is also available for read-only projects. Capture intents
        // still validate against PhrenCapture's writable targets before writing.
        return await SpotlightProjects.current().filter { wanted.contains($0.id) }
    }

    func suggestedEntities() async throws -> [ProjectEntity] {
        await PhrenCapture.targets().map(ProjectEntity.init(target:))
    }

    func entities(matching string: String) async throws -> [ProjectEntity] {
        let needle = Self.normalized(string)
        let targets = await PhrenCapture.targets()
        guard !needle.isEmpty else { return targets.map(ProjectEntity.init(target:)) }

        let ranked = targets.compactMap { target -> (rank: Int, target: PhrenCaptureTarget)? in
            let name = Self.normalized(target.project)
            // With more than one store attached the project name alone can
            // name two different places, so the store has to be matchable too
            // — "alphalens in work-shared" must be able to pick the one the
            // speaker meant instead of leaving both equally likely.
            if target.qualified {
                let store = Self.normalized(target.storeName)
                if needle == name + store { return (0, target) }
                if !store.isEmpty, needle.contains(name), needle.contains(store) { return (1, target) }
            }
            if name == needle { return (0, target) }
            if name.hasPrefix(needle) { return (2, target) }
            if name.contains(needle) { return (3, target) }
            // The other direction: Siri often hands over a fragment with a
            // stray word attached ("alpha lens project").
            if name.count >= 3, needle.contains(name) { return (4, target) }
            return nil
        }
        // Ties break on the store too, so two same-named projects in different
        // stores come back in a stable order rather than an arbitrary one.
        return ranked
            .sorted { ($0.rank, $0.target.project, $0.target.storeName) < ($1.rank, $1.target.project, $1.target.storeName) }
            .map { ProjectEntity(target: $0.target) }
    }

    /// Everything a slug and a dictated phrase have in common: letters and
    /// digits, lowercased. Drops the hyphens/underscores slugs use and the
    /// spaces and punctuation dictation inserts.
    private static func normalized(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
