import SwiftUI
import PhrenKit

/// One added store: its descriptor plus the live machinery and parsed state.
/// @Observable so views recomputing the merged accessors re-render when a
/// context's snapshot is replaced on refresh.
@Observable @MainActor
final class StoreContext: Identifiable {
    private(set) var descriptor: StoreDescriptor
    let store: LocalStore
    let engine: SyncEngine
    var snapshot: LocalStore.Snapshot = .empty
    var status = SyncEngine.Status()
    /// Per-project cold-tier summary (project → topics + bytes), refreshed
    /// with the snapshot. Read entirely from the catalogue the tree already
    /// paid for — no network, no hydration, safe to recompute every poll.
    var coldSummaries: [String: ColdSummary] = [:]

    // nonisolated: witnesses the nonisolated Identifiable requirement without
    // a MainActor hop. Captured once at init rather than derived from
    // `descriptor` — owner/name (and hence id) never change after a store is
    // added, only `canPush` does, so this stays safe without requiring
    // descriptor to be immutable.
    nonisolated let id: String

    init(descriptor: StoreDescriptor, store: LocalStore, engine: SyncEngine) {
        self.descriptor = descriptor
        self.store = store
        self.engine = engine
        self.id = descriptor.id
    }

    /// Best-effort refresh of push permission from a re-fetched repo — called
    /// from bootstrap/pullToRefresh. `canPush` is otherwise captured once at
    /// addStore time and never updated even if the token's access changes
    /// (StoreDescriptor.swift's doc comment promises this "correction").
    func updateCanPush(_ canPush: Bool) {
        descriptor.canPush = canPush
    }
}

/// A (store, project) pair — the app's addressing unit. Unlike the CLI's
/// name-keyed primary-wins merge (which silently shadows a project that exists
/// in two stores), the app shows both, disambiguated by store.
/// A skill plus the store it came from — skills exist in `global/` as well as
/// in projects, so they are addressed by store rather than by (store, project).
struct StoreSkill: Identifiable, Hashable {
    let storeId: String
    let storeName: String
    let skill: Skill

    var id: String { "\(storeId)/\(skill.path)" }

    static func == (lhs: StoreSkill, rhs: StoreSkill) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct StoreProject: Identifiable, Hashable {
    let storeId: String
    let storeName: String
    let project: Project

    var id: String { "\(storeId)/\(project.name)" }

    static func == (lhs: StoreProject, rhs: StoreProject) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct StoreQueueEntry: Identifiable {
    let storeId: String
    let storeName: String
    let entry: ProjectQueueItem

    var id: String { "\(storeId)/\(entry.id)" }
}

struct FailedOpEntry: Identifiable {
    let storeId: String
    let storeName: String
    let op: QueuedOp

    var id: UUID { op.id }
}

/// The app's tabs, in `MainTabView` display order. Exists as a binding
/// target (rather than the TabView's default no-selection mode) so a widget
/// deep link's `onOpenURL` handler can jump the user straight to a tab.
enum AppTab: Hashable {
    case projects, agents, tasks, search, settings
}

/// Why a mutation couldn't be routed to a store. Surfaced as
/// `lastActionError` in the UI and spoken verbatim by Siri when an App Intent
/// hits the same condition (`CustomLocalizedStringResourceConvertible` is what
/// AppIntents reads an error's dialog from).
enum StoreWriteError: LocalizedError, CustomLocalizedStringResourceConvertible {
    case storeNotOpen(String)
    case readOnly(String)

    var errorDescription: String? {
        switch self {
        case .storeNotOpen(let id):
            return "Store \(id) is not open."
        case .readOnly(let name):
            return "\(name) is read-only — your GitHub token can't push to it."
        }
    }

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .storeNotOpen:
            return "phren couldn't reach that store. Open the app and try again."
        case .readOnly(let name):
            return "\(name) is read-only — your GitHub token can't push to it."
        }
    }
}

/// Root observable state: auth, the store list, merged snapshots, and sync.
/// Views read the merged accessors and route mutations by store id.
@Observable @MainActor
final class AppModel {
    /// The live model, for code that runs outside the SwiftUI environment —
    /// App Intents execute in this process but have no view hierarchy to read
    /// `@Environment(AppModel.self)` from. Weak on purpose: a background
    /// launch that never connects a scene may not keep the App struct's
    /// `@State` alive, and a nil hook is exactly the signal the capture path
    /// needs to take its own offline route (see `PhrenCapture`).
    private(set) static weak var current: AppModel?

    struct Credentials {
        var load: () -> KeychainStore.StoredToken?
        var save: (KeychainStore.StoredToken) throws -> Void
        var delete: () -> Void
        static let keychain = Self(load: KeychainStore.load, save: KeychainStore.save, delete: KeychainStore.delete)
    }

    init(client: GitHubClient = GitHubClient(), credentials: Credentials = .keychain,
         storageDefaults: UserDefaults = .standard, storeDirectory: URL? = nil) {
        self.client = client
        self.credentials = credentials
        self.storageDefaults = storageDefaults
        self.storeDirectory = storeDirectory
        Self.current = self
    }

    private let credentials: Credentials
    private let storageDefaults: UserDefaults
    private let storeDirectory: URL?
    private var authenticationGeneration = UUID()
    private(set) var authenticationMessage: String?

    static var isUITesting: Bool { AppRuntime.isUITesting }

    enum Phase {
        case loading
        case signedOut
        case pickingRepo
        case initialSync
        case ready
    }

    private(set) var phase: Phase = .loading
    private(set) var user: GitHubUser?
    private(set) var storeContexts: [StoreContext] = []
    private(set) var searchIndex = SearchIndex()
    private(set) var searchRevision = UUID()
    @ObservationIgnored private var indexedSnapshots: [String: UUID] = [:]
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshRequested = false
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var liveGeneration = UUID()
    private(set) var syncStatus = SyncEngine.Status()
    /// Global store filter (store id) applied by list screens when set.
    var storeFilter: String?
    var lastActionError: String?
    /// On-device data that couldn't be read (and was set aside) or couldn't be
    /// written. Newest last. Readable by the Settings health section; the
    /// newest one also lands in `lastActionError`, because a user whose
    /// unsynced work was quarantined must not have to go looking for that.
    private(set) var storageIssues: [StorageIssue] = []
    /// The issue already shown, so a ~7s refresh can't keep re-raising a
    /// banner the user dismissed.
    private var lastSurfacedIssueId: UUID?
    /// Bound to `MainTabView`'s `TabView` selection — set from a widget deep
    /// link (`phren://review`, `phren://tasks`) via `PhrenApp.onOpenURL`.
    var selectedTab: AppTab = .projects
    var showingMemoryMaintenance = false
    var showingMemoryConnection = false

    /// Parsed `stores.yaml`, from whichever attached store actually carries
    /// the registry (see `refreshStoreRegistry`). Powers the claim-awareness
    /// badges in Projects, the health-section summary in Settings, and — as
    /// the fallback behind `.phren-team.yaml` — `storeRoles`.
    private(set) var storesManifest = StoresManifest()
    /// Last raw registry content parsed into `storesManifest` and
    /// `storeRoles`, keyed by store id, so a refresh only re-parses when a
    /// file actually changed — which, since `stores.yaml` and
    /// `.phren-team.yaml` are synced root paths (LocalStore.isSyncedPath),
    /// only happens when a store's ref sha moves. This is what keys the
    /// re-parse to the ref sha without fetching anything separately on every
    /// ~7s poll.
    private var lastRegistryRaw: [String: String] = [:]
    /// Store id → the CLI registry role that store is treated as
    /// ("primary" | "team" | "readonly"). Absent means "nothing in any
    /// attached store says", which is not the same as primary — see
    /// ``usesTeamJournal(storeId:)``.
    private(set) var storeRoles: [String: String] = [:]
    /// The journal routing already pushed into each engine's write context,
    /// so a ~7s refresh doesn't re-send an unchanged one.
    private var appliedJournalRouting: [String: Bool] = [:]

    let client: GitHubClient

    private static let storesDefaultsKey = "phren.stores"
    private static let legacyRepoDefaultsKey = "phren.selected-repo"
    /// The registry's on-disk shape. Version 1 is a bare `[StoreDescriptor]`
    /// array — what shipped builds wrote — which `VersionedList` still reads.
    private typealias StoreRegistry = VersionedList<StoreDescriptor>
    /// What the user calls this list when it goes wrong.
    private static let storeRegistryDocumentName = "store settings"

    var storeDescriptors: [StoreDescriptor] { storeContexts.map(\.descriptor) }
    var hasMultipleStores: Bool { storeContexts.count > 1 }

    func storeName(for id: String) -> String {
        storeContexts.first { $0.id == id }?.descriptor.displayName ?? id
    }

    func canPush(storeId: String) -> Bool {
        storeContexts.first { $0.id == storeId }?.descriptor.canPush ?? false
    }

    /// Whether this (store, project) pair can take a write at all. Two
    /// independent reasons it can't: the token has no push on the repo, or the
    /// project is one of phren's read-only tiers (`global` — the consolidate
    /// skill owns it). Every surface that offers an add/edit/delete affordance
    /// asks this, so a read-only project never presents a control that would
    /// fail at flush time against `LocalStore.isWritablePath`.
    func canWrite(storeId: String, project: String) -> Bool {
        canPush(storeId: storeId) && !LocalStore.isReadOnlyProject(project)
    }

    /// Every (store, project) pair a capture can actually land in.
    var writableProjects: [StoreProject] {
        mergedProjects.filter { canWrite(storeId: $0.storeId, project: $0.project.name) }
    }

    /// Whether a finding added to this store must be journalled rather than
    /// spliced into `FINDINGS.md` — the app's side of tools/finding.ts:186.
    ///
    /// Only a store the registry positively calls `team` journals. An
    /// *unknown* role does not: the phone may simply have no visibility (the
    /// personal store that holds `stores.yaml` isn't attached, and this repo
    /// carries no `.phren-team.yaml`), and guessing "team" there would write
    /// journal files the CLI never compacts into a personal store's
    /// FINDINGS.md. Guessing wrong in this direction is the status quo;
    /// guessing wrong in the other invents a file nothing reads.
    func usesTeamJournal(storeId: String) -> Bool {
        storeRoles[storeId] == "team"
    }

    // MARK: - Merged accessors

    private var filteredContexts: [StoreContext] {
        guard let storeFilter else { return storeContexts }
        return storeContexts.filter { $0.id == storeFilter }
    }

    var mergedProjects: [StoreProject] {
        filteredContexts.flatMap { context in
            context.snapshot.projects.map {
                StoreProject(storeId: context.id, storeName: context.descriptor.displayName, project: $0)
            }
        }
        .sorted { ($0.project.name, $0.storeName) < ($1.project.name, $1.storeName) }
    }

    var mergedReviewQueue: [StoreQueueEntry] {
        var entries: [(StoreContext, ProjectQueueItem)] = []
        for context in filteredContexts {
            for item in context.snapshot.reviewQueue {
                entries.append((context, item))
            }
        }
        return entries
            .sorted { LocalStore.reviewQueueOrder($0.1, $1.1) }
            .map { StoreQueueEntry(storeId: $0.0.id, storeName: $0.0.descriptor.displayName, entry: $0.1) }
    }

    var mergedTaskDocs: [(storeId: String, storeName: String, doc: TaskDoc)] {
        filteredContexts.flatMap { context in
            context.snapshot.tasks
                .sorted { $0.key < $1.key }
                .map { (context.id, context.descriptor.displayName, $0.value) }
        }
    }

    func snapshot(for storeId: String) -> LocalStore.Snapshot {
        storeContexts.first { $0.id == storeId }?.snapshot ?? .empty
    }

    func findings(storeId: String, project: String) -> [Finding] {
        snapshot(for: storeId).findings[project] ?? []
    }

    func notes(storeId: String, project: String) -> [Note] {
        snapshot(for: storeId).notes[project] ?? []
    }

    /// Pinned truths (`truths.md`) — phren's always-injected, never-decaying
    /// memory for this project.
    func truths(storeId: String, project: String) -> [Truth] {
        snapshot(for: storeId).truths[project] ?? []
    }

    func summary(storeId: String, project: String) -> String? {
        snapshot(for: storeId).summaries[project]
    }

    /// The date this project was last consolidated, if it ever was — read from
    /// the `<!-- consolidated: … -->` stamp in a FINDINGS.md the app already
    /// syncs, so knowing an archive exists costs nothing.
    func consolidatedDate(storeId: String, project: String) -> String? {
        snapshot(for: storeId).consolidated[project]
    }

    // MARK: - Cold tier (archived findings)

    /// What this project's archive weighs, without reading any of it.
    func coldSummary(storeId: String, project: String) -> ColdSummary? {
        storeContexts.first { $0.id == storeId }?.coldSummaries[project]
    }

    /// The archive's table of contents — catalogue only, still no fetch.
    func coldTopics(storeId: String, project: String) async -> [ColdDocRef] {
        guard let context = storeContexts.first(where: { $0.id == storeId }) else { return [] }
        return await context.engine.coldStore.topics(for: project)
    }

    /// Reads one archived topic, fetching its blob only if the cache doesn't
    /// hold it at the tree's current sha. The only cold fetch in the app, and
    /// it only ever happens because someone opened this topic.
    func coldDocument(storeId: String, path: String) async throws -> TopicDocument {
        guard let context = storeContexts.first(where: { $0.id == storeId }) else {
            throw StoreWriteError.storeNotOpen(storeId)
        }
        let document = try await context.engine.coldDocument(at: path)
        // Hydrating changes what the archive row can honestly claim (it can
        // now count this topic's findings), so let the summaries catch up.
        context.coldSummaries = await context.engine.coldStore.projectSummaries()
        return document
    }

    // MARK: - stores.yaml claim awareness

    /// The claiming store's display name, if `stores.yaml` says this project
    /// belongs elsewhere — surfaced as a warning chip on its Projects row.
    func claimingStoreName(for item: StoreProject) -> String? {
        let physicalName = storeContexts.first { $0.id == item.storeId }?.descriptor.displayName
        return storesManifest.claimingEntry(for: item.project.name, physicalStoreName: physicalName)?.name
    }

    /// Per-claimant counts of this store's projects that `stores.yaml` says
    /// belong to a different store — one row per claimant in the Settings
    /// health card ("3 projects in this store are claimed by 'work-shared'").
    func claimedElsewhere(storeId: String) -> [(name: String, count: Int)] {
        guard let context = storeContexts.first(where: { $0.id == storeId }) else { return [] }
        var counts: [String: Int] = [:]
        for project in context.snapshot.projects {
            if let entry = storesManifest.claimingEntry(for: project.name, physicalStoreName: context.descriptor.displayName) {
                counts[entry.name, default: 0] += 1
            }
        }
        return counts.sorted { $0.key < $1.key }.map { (name: $0.key, count: $0.value) }
    }

    /// Groups of distinct project names (across every attached store) that
    /// normalize to the same canonical key — a subtle nudge for
    /// `max4liveplugins` vs `max4live-plugins`-style near-duplicates that
    /// nobody notices because nothing ever puts them side by side.
    var duplicateProjectGroups: [[String]] {
        let names = Set(storeContexts.flatMap { $0.snapshot.projects.map(\.name) })
        var byKey: [String: [String]] = [:]
        for name in names {
            byKey[Self.canonicalProjectKey(name), default: []].append(name)
        }
        return byKey.values
            .filter { $0.count > 1 }
            .map { $0.sorted() }
            .sorted { $0[0] < $1[0] }
    }

    private static func canonicalProjectKey(_ name: String) -> String {
        name.lowercased().replacingOccurrences(of: "-", with: "").replacingOccurrences(of: "_", with: "")
    }

    /// Re-parses the CLI's two registry files from every attached store's
    /// local cache, when any of them has changed since the last refresh.
    /// `LocalStore` already mirrors both as part of the normal recursive-tree
    /// sync (`LocalStore.isSyncedPath`), so these are local file reads, not
    /// network calls — their content (and hence the raw-content equality check
    /// below) only changes when a store's ref sha moves, which is exactly the
    /// "once per sync generation, keyed on the ref sha" cadence the live ~7s
    /// poll needs.
    ///
    /// **Every store, not the first one.** `stores.yaml` is the *primary*
    /// store's registry (`storesFilePath`, store-registry.ts:59); a team store
    /// repo never has one. Reading it from `storeContexts.first` — the app's
    /// old stand-in for "primary" — therefore found nothing at all for anyone
    /// who happened to attach a team repo first. Scanning all of them removes
    /// the guess: whichever attached store actually carries the registry is
    /// the one that has it, and a store that declares a `primary` entry wins
    /// over one that doesn't if somehow two do.
    private func refreshStoreRegistry() async {
        var raws: [String: String] = [:]
        var manifests: [StoresManifest] = []
        var bootstraps: [String: TeamBootstrap] = [:]

        for context in storeContexts {
            let registryRaw = await context.store.read("stores.yaml")
            let bootstrapRaw = await context.store.read(TeamBootstrap.fileName)
            raws[context.id] = "\(registryRaw ?? "")\u{0}\(bootstrapRaw ?? "")"
            if let registryRaw {
                let manifest = StoresManifest.parse(registryRaw)
                if !manifest.stores.isEmpty { manifests.append(manifest) }
            }
            if let bootstrapRaw, let bootstrap = TeamBootstrap.parse(bootstrapRaw) {
                bootstraps[context.id] = bootstrap
            }
        }

        guard raws != lastRegistryRaw else { return }
        lastRegistryRaw = raws
        storesManifest = manifests.first { entry in entry.stores.contains(where: \.isPrimary) }
            ?? manifests.first
            ?? .empty
        storeRoles = resolveStoreRoles(bootstraps: bootstraps)
    }

    /// The role each attached store is treated as.
    ///
    /// `.phren-team.yaml` wins, because that is the CLI's own precedence:
    /// `phren store add` takes the role from `bootstrap?.default_role` ahead
    /// of the `--role` flag the user typed (cli/namespaces-store.ts:147). It
    /// is also the only signal that lives inside the repo being described, so
    /// it holds even when the store that registers it isn't on this device.
    ///
    /// The registry is the fallback, matched on store name. That match is the
    /// same display-name-is-registry-name assumption `claimingStoreName`
    /// already makes; a store renamed away from its repo name just falls
    /// through to "unknown", which routes exactly as the app did before.
    private func resolveStoreRoles(bootstraps: [String: TeamBootstrap]) -> [String: String] {
        var roles: [String: String] = [:]
        for context in storeContexts {
            if let bootstrap = bootstraps[context.id] {
                roles[context.id] = bootstrap.role
                continue
            }
            if let entry = storesManifest.stores.first(where: { $0.name == context.descriptor.displayName }) {
                roles[context.id] = entry.role
            }
        }
        return roles
    }

    /// Pushes journal routing into each engine, only when it changed. Called
    /// after the registry refresh, so an engine's very first write already
    /// knows where it belongs.
    private func applyWriteContexts() async {
        for context in storeContexts {
            let journal = usesTeamJournal(storeId: context.id)
            guard appliedJournalRouting[context.id] != journal else { continue }
            appliedJournalRouting[context.id] = journal
            await context.engine.setWriteContext(
                .init(actor: user?.login, machine: deviceName(), usesTeamJournal: journal)
            )
        }
    }

    // MARK: - Lifecycle

    func bootstrap() async {
        guard phase == .loading else { return }
        #if DEBUG && targetEnvironment(simulator)
        if Self.isUITesting {
            do {
                switch try await UITestFixtures.bootstrap() {
                case .agentsOnly:
                    phase = .signedOut
                    selectedTab = .agents
                case .memory(let contexts):
                    storeContexts = contexts
                    await refresh()
                    phase = .ready
                }
            } catch { lastActionError = error.localizedDescription }
            return
        }
        #endif
        guard let stored = credentials.load() else {
            selectedTab = .agents
            phase = .signedOut
            return
        }
        await client.setToken(stored.token)
        user = stored.user

        await openSavedStores()
        // Local data and navigation are available even while /user is stalled.
        guard await refreshAccount() else { return }
        await refreshStorePermissions()
        await pullAllAndGoLive()
    }

    private func openSavedStores() async {
        for descriptor in loadDescriptors() where !storeContexts.contains(where: { $0.id == descriptor.id }) {
            await openContext(descriptor)
        }
        // openContext can fail (LocalStore init) for every descriptor — never
        // strand the user in an empty tab view with no way back. Mirrors the
        // same guard in addStore().
        await refresh()
        phase = storeContexts.isEmpty ? .pickingRepo : .ready
    }

    private func loadDescriptors() -> [StoreDescriptor] { Self.storedDescriptors(defaults: storageDefaults) }

    private func persistDescriptors(_ descriptors: [StoreDescriptor]) { Self.persist(descriptors, defaults: storageDefaults) }

    /// The attached-store registry, readable without a bootstrapped model —
    /// an App Intent cold-launched in the background has no `storeContexts`
    /// yet but still needs to know which stores exist and which are writable.
    static func storedDescriptors(defaults: UserDefaults = .standard) -> [StoreDescriptor] {
        // A registry that can't be decoded is set aside rather than replaced,
        // so a user thrown back to the repo picker at least hears why.
        if let list = PersistedState.load(StoreRegistry.self, fromDefaults: defaults,
                                          key: storesDefaultsKey,
                                          document: storeRegistryDocumentName).value {
            return list.items
        }
        // Migrate the legacy single-store key: same owner/name/branch JSON
        // shape; canPush defaults true via StoreDescriptor's decoder.
        if let legacy = PersistedState.load(StoreDescriptor.self, fromDefaults: defaults,
                                            key: legacyRepoDefaultsKey,
                                            document: storeRegistryDocumentName).value {
            persist([legacy], defaults: defaults)
            defaults.removeObject(forKey: legacyRepoDefaultsKey)
            return [legacy]
        }
        return []
    }

    private static func persist(_ descriptors: [StoreDescriptor], defaults: UserDefaults = .standard) {
        PersistedState.save(StoreRegistry(items: descriptors), toDefaults: defaults,
                            key: storesDefaultsKey, document: storeRegistryDocumentName)
    }

    func enterForeground() async {
        foreground = true
        guard phase == .ready else { return }
        await startLiveAll()
        await refreshAccount()
    }

    func enterBackground() async {
        foreground = false
        liveGeneration = UUID()
        for context in storeContexts {
            await context.engine.stopLive()
        }
    }

    private func startLiveAll() async {
        guard !Self.isUITesting, foreground else { return }
        let generation = liveGeneration
        // Stagger starts so N stores don't wake the radio simultaneously.
        for (i, context) in storeContexts.enumerated() {
            if i > 0 {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
            }
            guard foreground, liveGeneration == generation, !Task.isCancelled else { return }
            guard storeContexts.contains(where: { $0 === context }) else { continue }
            await context.engine.startLive()
        }
    }

    private func pullAllAndGoLive() async {
        await pullAll()
        await refresh()
        await startLiveAll()
    }

    /// Parallel forced pull across stores. Captures the (Sendable) engines,
    /// not the @MainActor StoreContext, in the child tasks.
    private func pullAll() async {
        let engines = storeContexts.map(\.engine)
        await withTaskGroup(of: Void.self) { group in
            for engine in engines {
                group.addTask { await engine.pull(force: true) }
            }
        }
    }

    // MARK: - Auth

    /// Only an explicit credential rejection invalidates a saved sign-in.
    /// Offline, timeout, cancellation, throttling and server errors leave it
    /// intact; the existing sync loop retries when connectivity returns.
    @discardableResult
    private func refreshAccount() async -> Bool {
        guard let stored = credentials.load() else { return false }
        let generation = authenticationGeneration
        do {
            let verified = try await client.currentUser()
            guard generation == authenticationGeneration else { return false }
            user = verified
            // Metadata caching is best effort. A failed save retains the old token.
            try? credentials.save(.init(token: stored.token, kind: stored.kind, user: verified))
            appliedJournalRouting.removeAll()
            await applyWriteContexts()
        } catch GitHubError.http(status: 401, message: _, method: _, path: _) {
            guard generation == authenticationGeneration else { return false }
            let invalidation = UUID()
            authenticationGeneration = invalidation
            credentials.delete()
            await client.setToken(nil)
            await enterBackground()
            guard invalidation == authenticationGeneration else { return false }
            authenticationMessage = "GitHub no longer accepts your sign-in. Sign in again to reconnect. Your saved projects and pending changes are still here."
            phase = .signedOut
            return false
        } catch {
            // A failed request says nothing about whether the token is valid.
        }
        return generation == authenticationGeneration
    }

    func signIn(token: String, kind: KeychainStore.TokenKind) async throws {
        let generation = UUID()
        authenticationGeneration = generation
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        await client.setToken(trimmed)
        let user = try await client.currentUser()
        guard generation == authenticationGeneration else { throw CancellationError() }
        try credentials.save(.init(token: trimmed, kind: kind, user: user))
        self.user = user
        authenticationMessage = nil
        appliedJournalRouting.removeAll()
        await openSavedStores()
        await pullAllAndGoLive()
    }

    func signOut() async {
        authenticationGeneration = UUID()
        liveGeneration = UUID()
        await ApprovalActivityController.shared.clear()
        for context in storeContexts {
            await context.engine.stopLive()
            try? await context.store.wipe()
        }
        credentials.delete()
        storageDefaults.removeObject(forKey: Self.storesDefaultsKey)
        storageDefaults.removeObject(forKey: Self.legacyRepoDefaultsKey)
        await client.setToken(nil)
        user = nil
        authenticationMessage = nil
        storeContexts = []
        storeFilter = nil
        storesManifest = StoresManifest()
        storeRoles = [:]
        appliedJournalRouting = [:]
        lastRegistryRaw = [:]
        searchIndex = SearchIndex()
        indexedSnapshots = [:]
        searchRevision = UUID()
        syncStatus = SyncEngine.Status()
        // Sign-out deleted the local copies, quarantined ones included, so
        // stop promising the user they're still recoverable on the device.
        StorageIssueLog.shared.removeAll()
        storageIssues = []
        lastSurfacedIssueId = nil
        phase = .signedOut
    }

    // MARK: - Store management

    /// Adds a store from a picked repo. The first store also completes onboarding.
    func addStore(repo: GitHubRepo) async {
        let descriptor = StoreDescriptor(
            owner: repo.owner.login,
            name: repo.name,
            branch: repo.defaultBranch,
            canPush: repo.permissions?.push ?? true
        )
        guard !storeContexts.contains(where: { $0.id == descriptor.id }) else { return }

        let firstStore = storeContexts.isEmpty
        if firstStore { phase = .initialSync }

        await openContext(descriptor)
        persistDescriptors(storeDescriptors)

        if let context = storeContexts.first(where: { $0.id == descriptor.id }) {
            await context.engine.pull(force: true)
            await refresh()
            await context.engine.startLive()
        }
        if firstStore {
            // openContext can fail (LocalStore init) — never strand the user
            // in the tab view with zero stores.
            phase = storeContexts.isEmpty ? .pickingRepo : .ready
        }
    }

    /// Removes the store's local copy and registry entry. Never touches GitHub.
    func removeStore(id: String) async {
        guard let index = storeContexts.firstIndex(where: { $0.id == id }) else { return }
        let context = storeContexts[index]
        await context.engine.stopLive()
        try? await context.store.wipe()
        storeContexts.remove(at: index)
        if storeFilter == id { storeFilter = nil }
        storeRoles.removeValue(forKey: id)
        appliedJournalRouting.removeValue(forKey: id)
        lastRegistryRaw.removeValue(forKey: id)
        persistDescriptors(storeDescriptors)
        await refresh()
        if storeContexts.isEmpty {
            phase = .pickingRepo
        }
    }

    private func openContext(_ descriptor: StoreDescriptor) async {
        do {
            let directory = storeDirectory?.appendingPathComponent(descriptor.id, isDirectory: true)
                ?? LocalStore.defaultDirectory(owner: descriptor.owner, repo: descriptor.name)
            let store = try LocalStore(rootDirectory: directory, owner: descriptor.owner,
                                       repo: descriptor.name, branch: descriptor.branch)
            let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
            let context = StoreContext(descriptor: descriptor, store: store, engine: engine)
            storeContexts.append(context)

            // The write context is `applyWriteContexts`'s to set — it is the
            // one place that knows whether this store journals its findings,
            // and a second writer here would race it. `refresh()` runs it
            // before anything can be enqueued, on every path that opens a
            // store.
            appliedJournalRouting.removeValue(forKey: descriptor.id)
            await engine.setOnUpdate { [weak self] update in
                Task { @MainActor [weak self] in
                    switch update {
                    case .content: await self?.refresh()
                    case .status: await self?.refreshStatus()
                    }
                }
            }
        } catch {
            lastActionError = error.localizedDescription
        }
    }

    private func deviceName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }

    // MARK: - Data refresh

    func refresh() async {
        refreshRequested = true
        if let refreshTask { await refreshTask.value; return }
        let task = Task { [self] in
            defer { refreshTask = nil }
            while refreshRequested {
                refreshRequested = false
                await refreshOnce()
            }
        }
        refreshTask = task
        await task.value
    }

    private func refreshOnce() async {
        let generation = authenticationGeneration
        for context in storeContexts {
            let snapshot = await context.store.snapshot()
            guard generation == authenticationGeneration else { return }
            if context.snapshot.revision != snapshot.revision { context.snapshot = snapshot }
            let status = await context.engine.currentStatus()
            if context.status != status { context.status = status }
            let coldSummaries = await context.engine.coldStore.projectSummaries()
            if context.coldSummaries != coldSummaries { context.coldSummaries = coldSummaries }
        }
        // Key by store id (owner/name) — display names alone collide when two
        // owners have same-named repos. The UI translates via storeName(for:).
        guard generation == authenticationGeneration else { return }
        let snapshots = storeContexts.map { (store: $0.id, snapshot: $0.snapshot) }
        let revisions = Dictionary(uniqueKeysWithValues: snapshots.map { ($0.store, $0.snapshot.revision) })
        if revisions != indexedSnapshots {
            let index = await Task.detached(priority: .userInitiated) { SearchIndex(snapshots: snapshots) }.value
            guard generation == authenticationGeneration,
                  revisions == Dictionary(uniqueKeysWithValues: storeContexts.map { ($0.id, $0.snapshot.revision) }) else { return }
            searchIndex = index
            indexedSnapshots = revisions
            searchRevision = UUID()
        }
        let status = aggregateStatus()
        if syncStatus != status { syncStatus = status }
        collectStorageIssues()
        await refreshStoreRegistry()
        await applyWriteContexts()
        // Store health (syncStatus) and the review/task data the widget
        // needs both settle right here — the same generation, every ~7s
        // live-poll cycle. WidgetBridge itself gates the widget-visible
        // reload on content actually changing.
        await WidgetBridge.publish(from: self)
        // Likewise for the project names Siri can resolve by voice — gated
        // on the project set changing, not on every poll.
        PhrenAppShortcuts.donateProjects(from: self)
    }

    /// The status-only counterpart of `refreshOnce`, for a `SyncEngine.Update`
    /// of `.status`. A pull flips `isSyncing` on, stamps `lastSyncedAt`, and
    /// flips `isSyncing` off — three status notifications per poll per store,
    /// each of which used to run the full refresh and so re-stat every file in
    /// every store. Nothing in the local cache moved, so this reads the
    /// engines' status and stops there; the snapshot, search index, registry
    /// and Siri donations wait for a `.content` update.
    private func refreshStatus() async {
        let generation = authenticationGeneration
        for context in storeContexts {
            let status = await context.engine.currentStatus()
            guard generation == authenticationGeneration else { return }
            if context.status != status { context.status = status }
        }
        let status = aggregateStatus()
        if syncStatus != status { syncStatus = status }
        collectStorageIssues()
        await WidgetBridge.publish(from: self)
    }

    /// Drains the process-wide persistence log into the model.
    ///
    /// One source, not a union of the per-store arrays: the capture surfaces
    /// write from App Intents that can run with no model at all, so
    /// `StorageIssueLog` is the only place that sees everything — and it
    /// already holds what `LocalStore` and `SyncEngine` recorded too.
    private func collectStorageIssues() {
        let issues = StorageIssueLog.shared.issues
        guard let latest = issues.last, latest.id != lastSurfacedIssueId else { return }
        storageIssues = issues
        lastSurfacedIssueId = latest.id
        lastActionError = latest.userMessage
    }

    private func aggregateStatus() -> SyncEngine.Status {
        var aggregate = SyncEngine.Status()
        guard !storeContexts.isEmpty else { return aggregate }
        let statuses = storeContexts.map(\.status)
        aggregate.isLive = statuses.allSatisfy(\.isLive)
        aggregate.isSyncing = statuses.contains { $0.isSyncing }
        // Oldest last-synced across stores — "everything is at least this fresh".
        let timestamps = statuses.compactMap(\.lastSyncedAt)
        aggregate.lastSyncedAt = timestamps.count == statuses.count ? timestamps.min() : nil
        aggregate.pendingCount = statuses.reduce(0) { $0 + $1.pendingCount }
        aggregate.failedCount = statuses.reduce(0) { $0 + $1.failedCount }
        aggregate.lastError = statuses.compactMap(\.lastError).first
        return aggregate
    }

    func pullToRefresh() async {
        guard await refreshAccount() else { return }
        await pullAll()
        await refreshStorePermissions()
        await refresh()
    }

    /// Re-fetches each store's repo to pick up push-permission changes (e.g.
    /// the user broadened a fine-grained token's access after adding a store
    /// read-only). Best-effort: a failed fetch just leaves canPush as-is.
    private func refreshStorePermissions() async {
        var changed = false
        for context in storeContexts {
            guard let repo = try? await client.repo(owner: context.descriptor.owner, name: context.descriptor.name) else {
                continue
            }
            let canPush = repo.permissions?.push ?? true
            if canPush != context.descriptor.canPush {
                context.updateCanPush(canPush)
                changed = true
            }
        }
        if changed {
            persistDescriptors(storeDescriptors)
        }
    }

    // MARK: - Mutations

    // MARK: - Skills

    /// Every synced skill across the open (and filtered) stores.
    var mergedSkills: [StoreSkill] {
        filteredContexts.flatMap { context in
            context.snapshot.skills.map {
                StoreSkill(storeId: context.id, storeName: context.descriptor.displayName, skill: $0)
            }
        }
    }

    func saveDocument(path: String, content: String, expectedContent: String?, in storeId: String) async throws {
        try await enqueue(.saveAuthoredFile(path: path, content: content, expectedContent: expectedContent), in: storeId)
        await refresh()
    }

    func deleteSkill(_ entry: StoreSkill) async throws {
        try await enqueue(.deleteAuthoredFile(path: entry.skill.path, expectedContent: entry.skill.content), in: entry.storeId)
        await refresh()
    }

    /// Moves a skill to `global` or another project within its own store.
    func moveSkill(_ entry: StoreSkill, to scope: String) async throws {
        guard let context = storeContexts.first(where: { $0.id == entry.storeId }) else {
            throw StoreWriteError.storeNotOpen(entry.storeId)
        }
        guard context.descriptor.canPush else {
            throw StoreWriteError.readOnly(context.descriptor.displayName)
        }
        try await context.engine.moveSkill(entry.skill, to: scope)
        await refresh()
    }

    func instructions(scope: String, in storeId: String) -> String? {
        storeContexts.first { $0.id == storeId }?.snapshot.instructions[scope]
    }

    func skills(in storeId: String) -> [Skill] {
        storeContexts.first { $0.id == storeId }?.snapshot.skills ?? []
    }

    func skillPreferences(in storeId: String) throws -> SkillPreferences {
        try SkillPreferences.parse(snapshot(for: storeId).skillPreferencesContent)
    }

    func setSkillEnabled(_ entry: StoreSkill, enabled: Bool) async throws {
        let current = try skillPreferences(in: entry.storeId)
        try await enqueue(.setSkillEnabled(scope: entry.skill.scope.source, name: entry.skill.name,
                                          enabled: enabled,
                                          expectedEnabled: current.explicitSetting(scope: entry.skill.scope.source, name: entry.skill.name)),
                          in: entry.storeId)
        await refresh()
    }

    // MARK: - Graph

    /// The phone explores one store at a time. Project/node identities remain
    /// CLI-compatible without collisions between same-named projects in stores.
    func graphPayload(storeId: String, focusProject: String?) async throws -> GraphPayload {
        guard let context = storeContexts.first(where: { $0.id == storeId }) else {
            throw StoreWriteError.storeNotOpen(storeId)
        }
        let input = await context.store.graphInput(storeName: context.id)
        if let focusProject, !input.projects.contains(focusProject) {
            return GraphPayload(nodes: [], links: [], topics: [], total: 0)
        }
        return await Task.detached(priority: .userInitiated) { GraphBuilder.build(input, focusProject: focusProject) }.value
    }

    func perform(_ op: PendingOp, in storeId: String) async {
        do {
            try await enqueue(op, in: storeId)
            lastActionError = nil
        } catch let routing as StoreWriteError {
            // Nothing was applied, so there is nothing to re-read.
            lastActionError = routing.errorDescription
            return
        } catch {
            lastActionError = error.localizedDescription
        }
        await refresh()
    }

    /// Throwing core of `perform`, shared with the App Intents capture path —
    /// Siri needs the failure itself (to speak it), not a string parked in
    /// `lastActionError` for a view that isn't on screen.
    func enqueue(_ op: PendingOp, in storeId: String) async throws {
        guard let context = storeContexts.first(where: { $0.id == storeId }) else {
            throw StoreWriteError.storeNotOpen(storeId)
        }
        guard context.descriptor.canPush else {
            throw StoreWriteError.readOnly(context.descriptor.displayName)
        }
        try await context.engine.enqueue(op)
    }

    func retryFailedOps() async {
        for context in storeContexts {
            await context.engine.retryFailed()
        }
        await refresh()
    }

    func discardFailedOp(storeId: String, id: UUID) async {
        guard let context = storeContexts.first(where: { $0.id == storeId }) else { return }
        await context.engine.discardFailed(id: id)
        await refresh()
    }

    func failedOps() async -> [FailedOpEntry] {
        var result: [FailedOpEntry] = []
        for context in storeContexts {
            for op in await context.engine.failedOps() {
                result.append(FailedOpEntry(storeId: context.id, storeName: context.descriptor.displayName, op: op))
            }
        }
        return result
    }

    /// Every op still waiting to be pushed, store-qualified. Backs the capture
    /// log's per-row "synced / waiting to sync" indicator — a capture is still
    /// on the device exactly as long as its op is in one of these queues.
    func pendingOps() async -> [(storeId: String, op: PendingOp)] {
        var result: [(storeId: String, op: PendingOp)] = []
        for context in storeContexts {
            for queued in await context.engine.pendingOps() {
                result.append((storeId: context.id, op: queued.op))
            }
        }
        return result
    }

    /// Current time formatted as the note heading time (HH:MM:SS UTC —
    /// matching `now.toISOString().slice(11,19)` in notes.ts:181). Static so
    /// the App Intents capture path, which may have no model at all, stamps
    /// notes exactly the way the capture sheet does.
    static func nowNoteTimestamp() -> (date: String, time: String) {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        let iso = formatter.string(from: Date())
        return (String(iso.prefix(10)), String(iso.suffix(8)))
    }
}

#if canImport(UIKit)
import UIKit
#endif
