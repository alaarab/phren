import Foundation
import PhrenKit

/// One writable destination for a hands-free capture: a (store, project) pair,
/// the same addressing unit the in-app capture sheet uses
/// (`VoiceCaptureTarget`), reachable without a SwiftUI environment.
struct PhrenCaptureTarget: Sendable, Hashable {
    let storeId: String
    let storeName: String
    let project: String
    /// True when more than one store is attached, so the project name alone
    /// is ambiguous and the store has to be shown/spoken alongside it.
    let qualified: Bool

    /// Stable across launches — `ProjectEntity.id`, which the Shortcuts app
    /// persists inside a saved shortcut.
    var entityId: String { "\(storeId)|\(project)" }

    /// How the project reads on screen ("myproj", "myproj · work-shared").
    var displayName: String { qualified ? "\(project) · \(storeName)" : project }

    /// How Siri says it back — a middle dot doesn't survive text-to-speech.
    var spokenName: String { qualified ? "\(project) in \(storeName)" : project }
}

/// Capture failures that have nothing to do with a specific store (those are
/// `StoreWriteError`). Siri speaks `localizedStringResource` verbatim, so
/// each case has to stand on its own as a sentence heard once, eyes-free.
enum PhrenCaptureError: LocalizedError, CustomLocalizedStringResourceConvertible {
    /// No store has ever been attached — the user hasn't finished onboarding.
    case notSetUp
    /// Stores exist but the token can't push to any of them.
    case noWritableStore
    /// A writable store exists but nothing is cached under it yet.
    case nothingSynced
    /// A saved shortcut references a project that has since gone away.
    case unknownProject(String)
    /// The op itself was rejected (empty text, a secret, a parse failure).
    case rejected(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notSetUp:
            return "phren isn't set up yet — open the app to connect your store."
        case .noWritableStore:
            return "Your phren store is read-only. Your GitHub token needs Contents: Read and write on the store repo."
        case .nothingSynced:
            return "phren hasn't synced your store yet — open the app once and try again."
        case .unknownProject(let name):
            return "phren has no project called \(name)."
        case .rejected(let reason):
            return "phren couldn't save that: \(reason)"
        }
    }

    var errorDescription: String? { String(localized: localizedStringResource) }
}

/// The outcome of deciding where a capture goes. `ask` is a first-class
/// result, not a failure: "I will not choose for you" is the correct answer
/// whenever the user hasn't said and hasn't configured a default.
enum PhrenCaptureResolution {
    case resolved(PhrenCaptureTarget)
    case ask(PhrenCaptureAskReason)
}

/// Why the capture path is declining to pick a destination. Each case is
/// phrased as the sentence Siri speaks / the Shortcuts app shows above the
/// project picker, so the user is never asked a bare question they can't place.
enum PhrenCaptureAskReason {
    /// No default is configured — the state a new install ships in.
    case noDefault
    /// A default was configured but its project isn't in an attached, writable
    /// store any more. Never substituted for silently: a same-named project in
    /// a different store is a *different* project.
    case defaultUnavailable(String)

    var prompt: LocalizedStringResource {
        switch self {
        case .noDefault:
            return "Which project?"
        case .defaultUnavailable(let name):
            return "Your default capture project \(name) isn't available any more. Which project?"
        }
    }
}

/// The capture path shared by every App Intent: find the writable
/// (store, project) pairs, pick one, and get an op into the store.
///
/// Two worlds, because an App Intent runs in the app's own process but the
/// system may have launched that process *for the intent*, with no scene and
/// therefore no `AppModel.bootstrap()`:
///
/// 1. **App alive** — `AppModel.current` has open store contexts. Route
///    through `AppModel.enqueue` so the local cache, the pending queue, the
///    sync engine and the widget snapshot all see the write exactly as they
///    would from a tap.
/// 2. **Cold background launch** — no contexts. Open the store's `LocalStore`
///    directly and hand it to a `SyncEngine` wired to a client that refuses to
///    talk to the network, so `enqueue` still does its normal apply-locally +
///    append-to-`pending-ops.json` (identical bytes, identical format) while
///    the flush it schedules dies instantly. The op ships on the next
///    foreground pass. Capture never needs the radio, and never needs the
///    Keychain — the GitHub token is not read anywhere on this path.
///
/// The two never run at once: the offline route is taken only when no store
/// context exists, and once `bootstrap()` has opened one, every later intent
/// in this process takes route 1. The offline engines are cached per process
/// so back-to-back Siri captures share one queue in memory.
@MainActor
enum PhrenCapture {
    // MARK: - Targets

    /// Every writable (store, project) pair, live model or not.
    static func targets() async -> [PhrenCaptureTarget] {
        if let model = AppModel.current, !model.storeContexts.isEmpty {
            return liveTargets(model)
        }
        return await offlineTargets()
    }

    private static func liveTargets(_ model: AppModel) -> [PhrenCaptureTarget] {
        model.storeContexts.flatMap { context in
            context.descriptor.canPush
                ? context.snapshot.projects
                    .filter { !LocalStore.isReadOnlyProject($0.name) }
                    .map {
                        PhrenCaptureTarget(
                            storeId: context.id,
                            storeName: context.descriptor.displayName,
                            project: $0.name,
                            qualified: model.hasMultipleStores
                        )
                    }
                : []
        }
        .sorted { ($0.project, $0.storeName) < ($1.project, $1.storeName) }
    }

    private static func offlineTargets() async -> [PhrenCaptureTarget] {
        let descriptors = AppModel.storedDescriptors()
        let qualified = descriptors.count > 1
        var result: [PhrenCaptureTarget] = []
        for descriptor in descriptors where descriptor.canPush {
            guard let store = try? openStore(descriptor) else { continue }
            for project in await projectNames(in: store) {
                result.append(PhrenCaptureTarget(
                    storeId: descriptor.id,
                    storeName: descriptor.displayName,
                    project: project,
                    qualified: qualified
                ))
            }
        }
        return result.sorted { ($0.project, $0.storeName) < ($1.project, $1.storeName) }
    }

    /// Writable project names straight off the cached tree — every path
    /// `LocalStore` holds is either a project-scoped file or one of the two
    /// root YAMLs (which have no directory component), so the first component
    /// of any two-part-or-longer path is a project directory. Cheaper than
    /// `snapshot()`, which would parse every findings/tasks/notes file just to
    /// list names. Read-only tiers (`global`) are dropped here rather than at
    /// enqueue time so they never appear as a Siri destination at all.
    private static func projectNames(in store: LocalStore) async -> [String] {
        var names = Set<String>()
        for path in await store.allPaths() {
            let parts = path.split(separator: "/")
            guard parts.count >= 2 else { continue }
            let name = String(parts[0])
            guard !LocalStore.isReadOnlyProject(name) else { continue }
            names.insert(name)
        }
        return names.sorted()
    }

    // MARK: - Resolution

    /// Decides where a capture goes, in this order and no other:
    ///
    /// 1. **The project the user named.** Matched store-qualified — a saved
    ///    shortcut points at one specific (store, project), not at a name.
    /// 2. **Nothing writable at all** → a specific error, since asking would
    ///    offer an empty list.
    /// 3. **The default the user set** in Settings → Quick capture, *if* it is
    ///    still an attached, writable project.
    /// 4. **Otherwise: ask.** Both when no default is configured and when the
    ///    configured one has gone away. There is deliberately no fallback tier
    ///    below this — no "last used", no first-in-sort-order. A capture whose
    ///    destination nobody chose is how a task ends up in a project the user
    ///    can't name afterwards, which is the whole bug this path had.
    static func resolveTarget(_ entity: ProjectEntity?) async throws -> PhrenCaptureResolution {
        let available = await targets()
        guard !available.isEmpty else {
            let descriptors = AppModel.storedDescriptors()
            if descriptors.isEmpty { throw PhrenCaptureError.notSetUp }
            throw descriptors.contains(where: \.canPush)
                ? PhrenCaptureError.nothingSynced
                : PhrenCaptureError.noWritableStore
        }
        if let entity {
            guard let match = available.first(where: {
                $0.storeId == entity.storeId && $0.project == entity.project
            }) else {
                throw PhrenCaptureError.unknownProject(entity.project)
            }
            return .resolved(match)
        }
        guard let preferred = QuickCaptureDefault.load() else {
            return .ask(.noDefault)
        }
        guard let match = available.first(where: {
            $0.storeId == preferred.storeId && $0.project == preferred.project
        }) else {
            // The store was removed, or the project was deleted on another
            // machine. Say so — an unexplained question after months of the
            // same answer is its own kind of silent failure.
            return .ask(.defaultUnavailable(preferred.project))
        }
        return .resolved(match)
    }

    // MARK: - Execution

    /// Applies the op and queues it for the next flush. Never blocks on the
    /// network; never touches the Keychain.
    static func capture(_ op: PendingOp, to target: PhrenCaptureTarget) async throws {
        do {
            if let model = AppModel.current,
               model.storeContexts.contains(where: { $0.id == target.storeId }) {
                try await model.enqueue(op, in: target.storeId)
                // Same generation the UI and the widget snapshot settle on.
                await model.refresh()
            } else {
                try await captureOffline(op, to: target)
            }
        } catch let error as StoreWriteError {
            throw error
        } catch let error as PhrenCaptureError {
            throw error
        } catch {
            throw PhrenCaptureError.rejected(error.localizedDescription)
        }
        // Keep the in-app capture sheet defaulting to wherever the last
        // capture went, whichever surface made it.
        VoiceCaptureLastTarget.save(storeId: target.storeId, project: target.project)
        // A capture made with the phone in a pocket leaves no trace on screen;
        // the log is where "where did that go?" gets answered later.
        switch op {
        case .addNote(_, _, _, let text):
            CaptureLog.record(kind: .note, storeId: target.storeId, project: target.project,
                              text: text, source: .siri)
        case .addTask(_, let text):
            CaptureLog.record(kind: .task, storeId: target.storeId, project: target.project,
                              text: text, source: .siri)
        default:
            break
        }
    }

    private static func captureOffline(_ op: PendingOp, to target: PhrenCaptureTarget) async throws {
        guard let descriptor = AppModel.storedDescriptors().first(where: { $0.id == target.storeId }) else {
            throw PhrenCaptureError.notSetUp
        }
        guard descriptor.canPush else {
            throw StoreWriteError.readOnly(descriptor.displayName)
        }
        try await offlineEngine(for: descriptor).enqueue(op)
    }

    // MARK: - Offline store access

    private static var offlineStores: [String: LocalStore] = [:]
    private static var offlineEngines: [String: SyncEngine] = [:]

    /// One `LocalStore` per store per process. Two instances over the same
    /// directory would each hold their own copy of the manifest, and
    /// `LocalStore.write` rewrites the whole manifest from that copy — so the
    /// second one to write would drop the first one's blob SHAs.
    static func openStore(_ descriptor: StoreDescriptor) throws -> LocalStore {
        if let cached = offlineStores[descriptor.id] { return cached }
        // Plain files under Application Support, so the default
        // NSFileProtectionCompleteUntilFirstUserAuthentication applies: a
        // locked phone can read and write them, a phone that hasn't been
        // unlocked since boot cannot.
        let store = try LocalStore(
            rootDirectory: LocalStore.defaultDirectory(owner: descriptor.owner, repo: descriptor.name),
            owner: descriptor.owner,
            repo: descriptor.name,
            branch: descriptor.branch
        )
        offlineStores[descriptor.id] = store
        return store
    }

    private static func offlineEngine(for descriptor: StoreDescriptor) throws -> SyncEngine {
        if let cached = offlineEngines[descriptor.id] { return cached }
        let engine = SyncEngine(
            client: OfflineGitHubAPI(),
            store: try openStore(descriptor),
            stateDirectory: LocalStore.defaultDirectory(owner: descriptor.owner, repo: descriptor.name)
        )
        offlineEngines[descriptor.id] = engine
        return engine
    }
}

/// A `GitHubAPI` that refuses every request, so a `SyncEngine` built on it can
/// apply and queue but never push.
///
/// The cold-launch capture path wants `SyncEngine.enqueue` — it is the only
/// code that writes `pending-ops.json` in the format the app reads back, and
/// re-implementing it would be a second source of truth for the queue file.
/// What it does not want is the flush `enqueue` schedules: a background launch
/// can be suspended the instant `perform()` returns, and a PUT that lands on
/// GitHub after this process forgets it is how an offline-first queue ends up
/// committing the same task twice. Failing the request outright is treated by
/// the flush as a transient network error — the op stays queued, in order, and
/// the next foreground sync sends it.
private struct OfflineGitHubAPI: GitHubAPI {
    /// Deliberately neither `GitHubError` nor `PhrenKitError`: the flush parks
    /// ops for both of those, and this op is not in trouble, just not sent yet.
    private struct NotNow: LocalizedError {
        var errorDescription: String? {
            "Captured offline — phren pushes this the next time you open the app."
        }
    }

    func headSha(owner: String, repo: String, branch: String) async throws -> String? { throw NotNow() }

    func tree(owner: String, repo: String, sha: String) async throws -> GitTree { throw NotNow() }

    func blob(owner: String, repo: String, sha: String) async throws -> Data { throw NotNow() }

    func putFile(owner: String, repo: String, path: String, branch: String,
                 content: Data, message: String, sha: String?) async throws -> ContentsPutResponse {
        throw NotNow()
    }

    func deleteFile(owner: String, repo: String, path: String, branch: String,
                    message: String, sha: String) async throws {
        throw NotNow()
    }
}
