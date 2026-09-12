import Foundation

/// Orchestrates GitHub ⇄ LocalStore sync.
///
/// Reads: cheap ref poll (ETag'd, 304s are rate-limit-free) → recursive tree →
/// changed blobs only. Writes: offline-first — every mutation applies to the
/// local cache immediately, queues a domain op, and flushes FIFO with
/// consecutive same-file ops coalesced into one commit; a sha conflict
/// triggers refetch → re-apply the whole group → retry (bounded), then parks
/// the ops individually.
///
/// Live mode: while the app is foregrounded the engine polls continuously so
/// findings/tasks pushed by an agent on another machine appear within seconds.
public actor SyncEngine {
    public struct Status: Sendable, Equatable {
        public var isSyncing: Bool = false
        public var isLive: Bool = false
        public var lastSyncedAt: Date?
        public var pendingCount: Int = 0
        public var failedCount: Int = 0
        public var lastError: String?

        public init() {}
    }

    /// Identity stamped into `<!-- source: -->` comments on findings written
    /// from this device, plus how this store wants those findings recorded.
    public struct WriteContext: Sendable {
        /// Mirrors the CLI's `getCurrentActor()` (machine-identity.ts:41) —
        /// the *person*, which on the phone is the GitHub login.
        public var actor: String?
        /// Mirrors `getMachineName()` — the host, i.e. the device name.
        public var machine: String?
        /// True when this store has `role: team`, in which case a finding-add
        /// appends to `journal/YYYY-MM-DD-<actor>.md` and leaves `FINDINGS.md`
        /// alone, exactly as `handleAddFinding` does (tools/finding.ts:186).
        ///
        /// Store-level rather than project-level on purpose. The app always
        /// addresses a *(store, project)* pair, which is the CLI's
        /// store-qualified form (`work-shared/arc`), and for that form
        /// `resolveStoreForProject` takes the role straight off the store
        /// (tools/types.ts:105) without consulting any `projects:` claim list.
        public var usesTeamJournal: Bool

        public init(actor: String? = nil, machine: String? = nil, usesTeamJournal: Bool = false) {
            self.actor = actor
            self.machine = machine
            self.usesTeamJournal = usesTeamJournal
        }
    }

    public static let livePollInterval: TimeInterval = 7
    private static let maxWriteAttempts = 3

    private let client: any GitHubAPI
    private let store: LocalStore
    /// The cold tier's catalogue and cache. `nonisolated` so a view can read
    /// the catalogue without queueing behind an engine that spends most of its
    /// life awaiting the network — `ColdStore` does its own isolation.
    public nonisolated let coldStore: ColdStore
    private let queueURL: URL
    private var queue: PendingOpsQueue
    private var status = Status()
    private var writeContext = WriteContext()
    private var liveTask: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    private var enqueueGeneration = 0
    private var pullTask: Task<Void, Never>?
    private var pullGeneration = 0
    /// Tests drive `flushNow()` by hand so a background flush can't push the
    /// first op of a batch before the rest are queued. Always on in the app.
    private var autoFlush = true
    /// Queue reads that had to be quarantined and queue writes that failed.
    /// Kept for per-store attribution; the app surfaces them through
    /// `StorageIssueLog`, which already has them.
    public private(set) var storageIssues: [StorageIssue] = []

    /// Fires after any content change (remote pull or local apply) and on
    /// status transitions — the app re-reads the snapshot and re-renders.
    private var onUpdate: (@Sendable () -> Void)?

    public init(client: any GitHubAPI, store: LocalStore, stateDirectory: URL) {
        self.client = client
        self.store = store
        self.coldStore = ColdStore(rootDirectory: stateDirectory)
        self.queueURL = stateDirectory.appendingPathComponent("pending-ops.json")
        let loaded = PendingOpsQueue.load(from: queueURL)
        self.queue = loaded.queue
        // An unreadable queue starts empty — but from a file that was moved
        // aside, with an issue the app shows. Never silently.
        if let issue = loaded.issue {
            self.storageIssues = [issue]
        }
        self.status.pendingCount = queue.pending.count
        self.status.failedCount = queue.failed.count
    }

    public func setOnUpdate(_ callback: @escaping @Sendable () -> Void) {
        onUpdate = callback
    }

    public func setWriteContext(_ context: WriteContext) {
        writeContext = context
    }

    public func currentStatus() -> Status { status }

    private func notify() {
        onUpdate?()
    }

    private func setStatus(_ mutate: (inout Status) -> Void) {
        mutate(&status)
        status.pendingCount = queue.pending.count
        status.failedCount = queue.failed.count
        notify()
    }

    // MARK: - Pull

    /// One sync pass. `force` skips the ETag shortcut (used for pull-to-refresh
    /// and sha-conflict recovery). Concurrent callers serialize: a caller that
    /// finds a pull in flight awaits it, and a forced caller then runs its own
    /// pass — the conflict-recovery path must never no-op on a stale sha.
    public func pull(force: Bool = false) async {
        await pull(force: force, overwritingPendingPaths: [])
    }

    private func pull(force: Bool, overwritingPendingPaths: Set<String>) async {
        if let inFlight = pullTask {
            await inFlight.value
            if !force { return }
        }
        pullGeneration += 1
        let generation = pullGeneration
        let task = Task { await self.performPull(force: force, overwritingPendingPaths: overwritingPendingPaths) }
        pullTask = task
        await task.value
        if pullGeneration == generation {
            pullTask = nil
        }
    }

    private func performPull(force: Bool, overwritingPendingPaths: Set<String>) async {
        setStatus { $0.isSyncing = true; $0.lastError = nil }
        defer {
            setStatus { $0.isSyncing = false }
            // An unchanged head still needs to retry edits queued offline.
            // Retry once per sync pass, including 304 responses.
            if !queue.pending.isEmpty { scheduleFlush() }
        }

        do {
            let manifest = await store.currentManifest
            let headSha: String?
            if force {
                // A forced pull must not be short-circuited by a stale ETag.
                headSha = try await client.headSha(owner: manifest.owner, repo: manifest.repo, branch: manifest.branch)
                    ?? manifest.headSha
            } else {
                headSha = try await client.headSha(owner: manifest.owner, repo: manifest.repo, branch: manifest.branch)
            }
            guard let headSha else {
                // 304 — nothing changed; the poll was free.
                setStatus { $0.lastSyncedAt = Date() }
                return
            }
            if !force, headSha == manifest.headSha {
                setStatus { $0.lastSyncedAt = Date() }
                return
            }

            let tree = try await client.tree(owner: manifest.owner, repo: manifest.repo, sha: headSha)
            // The recursive tree already carries every cold blob's path, sha
            // AND size, so cataloguing the archive tier costs zero extra
            // requests and zero extra bytes — the filter below used to throw
            // all of it away, which is why consolidated findings vanished on
            // the phone instead of collapsing into an archive.
            await coldStore.replaceCatalogue(tree.tree.compactMap(ColdDocRef.init(entry:)))
            let remote = Dictionary(
                tree.tree
                    .filter { $0.type == "blob" && LocalStore.isSyncedPath($0.path) }
                    .compactMap { entry in entry.sha.map { (entry.path, $0) } },
                uniquingKeysWith: { first, _ in first }
            )

            var changed = false
            for (path, sha) in remote {
                guard !preservesPendingFile(path, overwriting: overwritingPendingPaths) else { continue }
                let cached = await store.blobSha(for: path)
                guard cached != sha else { continue }
                let data = try await client.blob(owner: manifest.owner, repo: manifest.repo, sha: sha)
                let content = String(data: data, encoding: .utf8) ?? ""
                // An edit can be queued while a blob request is in flight.
                guard !preservesPendingFile(path, overwriting: overwritingPendingPaths) else { continue }
                try await store.write(path, content: content, blobSha: sha)
                changed = true
            }
            for path in await store.allPaths() {
                guard remote[path] == nil, LocalStore.isSyncedPath(path) else { continue }
                guard !preservesPendingFile(path, overwriting: overwritingPendingPaths) else { continue }
                // A nil blob sha means the file was created locally and never
                // synced (e.g. a new day's notes file from a queued op) —
                // deleting it here would drop the user's change before the
                // flush pushes it.
                let hasRemoteSha = await store.blobSha(for: path) != nil
                guard hasRemoteSha || overwritingPendingPaths.contains(path) else { continue }
                try await store.delete(path)
                changed = true
            }

            try await store.updateManifest { m in
                m.headSha = headSha
                m.lastSyncedAt = Date()
            }
            setStatus { $0.lastSyncedAt = Date() }
            if changed { notify() }
        } catch {
            setStatus { $0.lastError = error.localizedDescription }
        }
    }

    /// Polls must keep queued edits and their original blob SHAs intact until
    /// flush can check them. Only conflict recovery replaces pending files;
    /// it immediately replays the queue against the downloaded version.
    private func preservesPendingFile(_ path: String, overwriting paths: Set<String>) -> Bool {
        !paths.contains(path) && queue.pending.contains { $0.editedPaths.contains(path) }
    }

    // MARK: - Cold tier

    /// Reads one archived-findings document, fetching its blob **only** if the
    /// cache doesn't already hold it at the tree's current sha.
    ///
    /// This is the single place a cold blob is ever fetched, and it is only
    /// ever reached by a user opening a specific topic. The staleness check is
    /// inside `ColdStore.hydration(for:)` rather than here, so no caller can
    /// render cached archive text without it.
    public func coldDocument(at path: String) async throws -> TopicDocument {
        guard let reference = await coldStore.reference(for: path) else {
            throw PhrenKitError.notFound("That archive topic isn't in this store any more.")
        }
        switch await coldStore.hydration(for: path) {
        case .cached(let text):
            return TopicDocument(reference: reference, content: text)
        case .unknown:
            throw PhrenKitError.notFound("That archive topic isn't in this store any more.")
        case .tooLarge(let bytes):
            // Refused on the size the tree already gave us — before a request
            // that would sit there spinning on a cellular connection.
            throw PhrenKitError.validation(
                "\(reference.displayName) is \(Self.megabytes(bytes)) of archived findings — too large to open on the phone. Read it from your computer."
            )
        case .fetch(let sha):
            let manifest = await store.currentManifest
            let data = try await client.blob(owner: manifest.owner, repo: manifest.repo, sha: sha)
            let text = String(data: data, encoding: .utf8) ?? ""
            let document = TopicDocument(reference: reference, content: text)
            await coldStore.cache(path: path, text: text, sha: sha, findingCount: document.entries.count)
            return document
        }
    }

    private static func megabytes(_ bytes: Int) -> String {
        String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }

    // MARK: - Live polling

    /// Start continuous foreground polling. Conditional ref checks answered
    /// 304 don't count against the rate limit, so a tight interval is fine.
    public func startLive() {
        guard liveTask == nil else { return }
        setStatus { $0.isLive = true }
        liveTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.pull()
                try? await Task.sleep(nanoseconds: UInt64(Self.livePollInterval * 1_000_000_000))
            }
        }
    }

    public func stopLive() {
        liveTask?.cancel()
        liveTask = nil
        setStatus { $0.isLive = false }
    }

    // MARK: - Mutations

    /// Persists the queue, recording a failed write instead of dropping it on
    /// the floor: without this, work the user did offline disappears the next
    /// time iOS kills the app, with nothing having gone wrong on screen.
    private func persistQueue() {
        guard let issue = queue.save(to: queueURL) else { return }
        // Repeated failures are one condition, not many — keep the newest so a
        // device that refuses every write doesn't grow this without bound.
        storageIssues.removeAll { $0.kind == .unwritable }
        storageIssues.append(issue)
    }

    /// Applies the op locally (instant UI), persists it, and schedules a flush.
    public func enqueue(_ op: PendingOp) async throws {
        // Writability first. `write` checks the same predicate at flush time,
        // but by then the op has already been applied to the local cache and
        // shown to the user — a read-only tier (`global`) would appear to have
        // accepted the edit and then park it in "Needs attention" minutes
        // later. Refusing here is the same rule, enforced while the user is
        // still looking at what they did.
        guard LocalStore.isWritablePath(op.primaryPath) else {
            throw PhrenKitError.validation(
                "\"\(op.project)\" is read-only in the app — edit it with the phren CLI."
            )
        }
        // Local apply next — a domain error (empty text, secret, ambiguous
        // match) surfaces to the user immediately and nothing is queued.
        var queued = QueuedOp(op: op)
        let applied = try await applyLocally(op, createdAt: queued.queuedAt)
        queued.paths = applied.paths
        queued.deletedShas = applied.deletedShas.isEmpty ? nil : applied.deletedShas
        queue.pending.append(queued)
        enqueueGeneration += 1
        persistQueue()
        setStatus { _ in }
        scheduleFlush()
    }

    /// Moves a skill's instructions to another scope (`global` or a project in
    /// this store), keeping its name and file shape. Composed from the existing
    /// authored-file ops rather than a new persisted case, so older builds keep
    /// reading the queue. Create runs before delete: a failure between the two
    /// leaves a duplicate, never a lost skill. An explicit enabled/disabled
    /// choice follows the skill to its new key; supporting files in a folder
    /// skill are not synced and stay where they were.
    public func moveSkill(_ skill: Skill, to scope: String) async throws {
        guard scope != skill.scope.source else {
            throw PhrenKitError.validation("The skill is already in \(scope).")
        }
        let destination = skill.format == .folder
            ? "\(scope)/skills/\(skill.name)/SKILL.md"
            : "\(scope)/skills/\(skill.name).md"
        guard LocalStore.isSkillPath(destination) else {
            throw PhrenKitError.validation("Invalid skill scope or name.")
        }
        let preferences = try SkillPreferences.parse(await store.read(SkillPreferences.path))
        let enabled = preferences.explicitSetting(scope: skill.scope.source, name: skill.name)
        try await enqueue(.saveAuthoredFile(path: destination, content: skill.content, expectedContent: nil))
        try await enqueue(.deleteAuthoredFile(path: skill.path, expectedContent: skill.content))
        if let enabled {
            try await enqueue(.setSkillEnabled(scope: scope, name: skill.name, enabled: enabled,
                                               expectedEnabled: preferences.explicitSetting(scope: scope, name: skill.name)))
        }
    }

    /// Re-queues everything in "Needs attention". An op parked before its edit
    /// reached the local document (its target had vanished when the group was
    /// re-applied) is applied again here — the flush pushes the local document
    /// as it stands, so without this the retry would commit nothing for it.
    /// Ops parked with their edit already in place are simply re-queued.
    public func retryFailed() async {
        enqueueGeneration += 1
        let retrying = queue.failed
        queue.failed.removeAll()
        for var queued in retrying {
            if queued.paths?.isEmpty ?? false {
                do {
                    let applied = try await applyLocally(queued.op, createdAt: queued.queuedAt)
                    queued.paths = applied.paths
                    queued.deletedShas = applied.deletedShas.isEmpty ? nil : applied.deletedShas
                } catch {
                    // Still unresolvable — leave it parked rather than
                    // pretending the retry pushed it.
                    queued.lastError = error.localizedDescription
                    queue.failed.append(queued)
                    continue
                }
            }
            queued.lastError = nil
            queue.pending.append(queued)
        }
        persistQueue()
        setStatus { _ in }
        scheduleFlush()
    }

    public func discardFailed(id: UUID) {
        queue.failed.removeAll { $0.id == id }
        persistQueue()
        setStatus { _ in }
    }

    public func failedOps() -> [QueuedOp] { queue.failed }

    /// Ops applied locally but not yet pushed. `status.pendingCount` says how
    /// many there are; this says *which*, so a surface that recorded a write
    /// (the capture log) can tell one that has shipped from one still waiting
    /// on the next flush.
    public func pendingOps() -> [QueuedOp] { queue.pending }

    private func scheduleFlush() {
        guard autoFlush, flushTask == nil else { return }
        let generation = enqueueGeneration
        flushTask = Task { [weak self] in
            await self?.flush()
            await self?.clearFlushTask(generation: generation)
        }
    }

    private func clearFlushTask(generation: Int) {
        flushTask = nil
        // An op enqueued in the window between `flush` returning and this
        // running would otherwise sit until the next poll.
        // Old pending work may have just failed because we're offline. Only
        // newly enqueued work warrants another immediate pass.
        if enqueueGeneration != generation, !queue.pending.isEmpty { scheduleFlush() }
    }

    /// Runs a flush pass to completion, awaiting one already in flight.
    func flushNow() async {
        if let inFlight = flushTask { await inFlight.value }
        await flush()
    }

    func setAutoFlush(_ enabled: Bool) {
        autoFlush = enabled
    }

    // MARK: - Flush (coalesced writes)

    /// FIFO flush with op coalescing: everything pending rides one write plan,
    /// ONE Contents PUT per distinct file — one commit per file — instead of
    /// one commit per op. Batch-approving 40 review items across three
    /// projects is three commits (one per review.md), not 40 sequential ones
    /// racing the ~7s live poll.
    ///
    /// Collapsing the whole queue is safe because ops were already applied to
    /// the local cache in FIFO order at enqueue time: per file, the cache
    /// holds the batch result, and the plan serializes each file exactly once.
    private func flush() async {
        while true {
            let group = nextGroup()
            guard !group.isEmpty else { return }

            var plan = GroupPlan(ops: group)
            var parked: [(op: QueuedOp, error: String)] = []
            var transient: Error?
            var attempt = 0

            attempts: while !plan.paths.isEmpty {
                attempt += 1
                var landed: [String] = []
                do {
                    try await write(plan)
                    break attempts
                } catch let failure as PartialWriteFailure {
                    landed = failure.succeeded
                    // Files this attempt already committed are done. Retire
                    // them and every op they complete, so recovery only ever
                    // reasons about work that is genuinely still outstanding —
                    // re-applying a landed op throws "not found" and would park
                    // it forever, with no retry able to clear it.
                    plan = plan.retiring(paths: landed)
                    if plan.paths.isEmpty && plan.ops.isEmpty { break attempts }

                    switch failure.underlying {
                    case let error as GitHubError where error.isShaConflict:
                        guard attempt < Self.maxWriteAttempts else {
                            // Re-applying never converged — park each op so
                            // "Needs attention" keeps per-item granularity.
                            parked.append(contentsOf: plan.ops.map {
                                (op: $0, error: error.localizedDescription)
                            })
                            plan = .empty
                            break attempts
                        }
                        // Remote changed underneath the group: refresh and
                        // replay the outstanding ops onto the new content. Only
                        // the paths that did NOT land forget their sha; the
                        // ones that did are current and must stay cached.
                        await forgetCachedShas(plan.paths)
                        await pull(force: true, overwritingPendingPaths: Set(plan.paths))
                        let retry = await reapply(plan.ops)
                        plan = retry.plan
                        parked.append(contentsOf: retry.parked)
                        recordReapply(plan.ops)
                    case let error as PhrenKitError:
                        // Domain failure the group can never resolve (a
                        // non-writable path) — park the ops for the user.
                        parked.append(contentsOf: plan.ops.map {
                            (op: $0, error: error.localizedDescription)
                        })
                        plan = .empty
                        break attempts
                    default:
                        transient = failure.underlying
                        break attempts
                    }
                } catch {
                    transient = error
                    break attempts
                }
            }

            if let transient {
                // Network/API failure — keep the group queued and stop; the
                // next sync trigger retries.
                for index in queue.pending.indices where index < group.count {
                    queue.pending[index].attempts += 1
                    queue.pending[index].lastError = transient.localizedDescription
                }
                persistQueue()
                setStatus { $0.lastError = transient.localizedDescription }
                return
            }

            dropLeading(group)
            for entry in parked {
                var failed = entry.op
                failed.lastError = entry.error
                queue.failed.append(failed)
            }
            persistQueue()
            setStatus { _ in }
        }
    }

    /// The entire pending queue, flushed as one plan. Grouping used to stop at
    /// the first op whose `primaryPath` differed, which shattered a
    /// multi-project batch approve into one commit per project *run* — and
    /// every group after the first re-PUT bytes the first push already
    /// carried, which GitHub records as empty commits. Ops apply to the local
    /// cache in FIFO order at enqueue time, so per file the cache already *is*
    /// the batch result and one plan can serialize every touched file once.
    private func nextGroup() -> [QueuedOp] {
        queue.pending
    }

    /// Removes the flushed group from the head of the queue. Ids are checked
    /// because `enqueue`/`retryFailed` can append (never prepend) while a
    /// flush awaits a request.
    private func dropLeading(_ group: [QueuedOp]) {
        for queued in group {
            guard queue.pending.first?.id == queued.id else { return }
            queue.pending.removeFirst()
        }
    }

    /// Drops the cached blob shas of the group's files so the conflict pull
    /// really re-downloads them. The local copies already carry the group's
    /// optimistic edits while still tagged with the sha they were pulled at,
    /// and the pull's sha comparison alone would skip them — the re-apply
    /// would then replay ops onto content that already has them.
    private func forgetCachedShas(_ paths: [String]) async {
        try? await store.updateManifest { manifest in
            for path in paths { manifest.blobShas.removeValue(forKey: path) }
        }
    }

    /// Persists the paths a re-apply produced back onto the queued ops, so a
    /// later flush of the same group (after a transient failure) pushes what
    /// the replay actually wrote rather than what the original apply did.
    private func recordReapply(_ ops: [QueuedOp]) {
        for updated in ops {
            guard let index = queue.pending.firstIndex(where: { $0.id == updated.id }) else { continue }
            queue.pending[index].paths = updated.paths
            queue.pending[index].deletedShas = updated.deletedShas
        }
    }

    /// The write plan for one coalesced group: the files to push, the shas of
    /// files the group deleted, and the ops the commit message counts.
    private struct GroupPlan {
        var ops: [QueuedOp]
        var paths: [String]
        var deletedShas: [String: String]

        static let empty = GroupPlan(ops: [], paths: [], deletedShas: [:])

        /// The plan minus files an attempt already committed, and minus every
        /// op those files fully completed. Recovery must never re-apply or
        /// park work that is already on the remote: replaying a landed
        /// `approve` throws "queue item not found", which parks it in "Needs
        /// attention" where no retry can ever clear it.
        func retiring(paths landed: [String]) -> GroupPlan {
            guard !landed.isEmpty else { return self }
            let done = Set(landed)
            var remainingDeleted = deletedShas
            for path in landed { remainingDeleted.removeValue(forKey: path) }
            return GroupPlan(
                ops: ops.filter { !$0.editedPaths.allSatisfy(done.contains) },
                paths: paths.filter { !done.contains($0) },
                deletedShas: remainingDeleted
            )
        }

        init(ops: [QueuedOp], paths: [String], deletedShas: [String: String]) {
            self.ops = ops
            self.paths = paths
            self.deletedShas = deletedShas
        }

        init(ops: [QueuedOp]) {
            var seen = Set<String>()
            var paths: [String] = []
            var deleted: [String: String] = [:]
            for queued in ops {
                for path in queued.editedPaths where seen.insert(path).inserted {
                    paths.append(path)
                }
                for (path, sha) in queued.deletedShas ?? [:] { deleted[path] = sha }
            }
            // Secondary files first, the ops' own files last. If a secondary
            // write (the FINDINGS.md mirror of a reject/edit) conflicts, the
            // primary file is then still untouched remotely, so the refetch →
            // re-apply round can still find the queue lines the ops address.
            //
            // Classify by "is a secondary for SOME op", not by "is a primary
            // for some op": across a whole-queue plan one file is routinely
            // both — `reject` mirrors into FINDINGS.md while `addFinding` owns
            // it — and treating that as a primary put review.md first, exactly
            // inverting the property this ordering exists to guarantee.
            var secondaries = Set<String>()
            for queued in ops {
                for path in queued.editedPaths where path != queued.op.primaryPath {
                    secondaries.insert(path)
                }
            }
            paths = paths.filter { secondaries.contains($0) } + paths.filter { !secondaries.contains($0) }
            self.init(ops: ops, paths: paths, deletedShas: deleted)
        }
    }

    /// One PUT (or DELETE) per file the group touched, all carrying the same
    /// commit message. The bytes pushed are what the ops already produced in
    /// the local cache — they were applied in FIFO order as they were made, so
    /// the file on disk *is* the batch result, serialized once.
    ///
    /// A plan now spans every file the queue touches, so a failure partway
    /// through leaves earlier files already committed. The error carries which
    /// paths landed: recovery must not re-apply, re-park, or forget the sha of
    /// work that is already on the remote.
    private struct PartialWriteFailure: Error {
        let underlying: Error
        let succeeded: [String]
    }

    private func write(_ plan: GroupPlan) async throws {
        let manifest = await store.currentManifest
        let message = PendingOp.commitMessage(for: plan.ops.map(\.op))
        var succeeded: [String] = []
        for path in plan.paths {
            do {
                guard LocalStore.isWritablePath(path) else {
                    throw PhrenKitError.validation("Refusing to write non-writable path \(path).")
                }
                if let content = await store.read(path) {
                    // Ops land in the local cache at enqueue time, so an earlier
                    // flush (or an interleaved enqueue during one) may already
                    // have pushed these exact bytes. GitHub's Contents API records
                    // an empty commit for a byte-identical PUT — skip it instead.
                    if let known = await store.blobSha(for: path), known == GitBlob.sha(of: content) {
                        succeeded.append(path)
                        continue
                    }
                    let response = try await client.putFile(
                        owner: manifest.owner, repo: manifest.repo, path: path,
                        branch: manifest.branch, content: Data(content.utf8),
                        message: message, sha: await store.blobSha(for: path)
                    )
                    try await store.write(path, content: content, blobSha: response.content?.sha)
                } else if let sha = await store.blobSha(for: path) ?? plan.deletedShas[path] {
                    try await client.deleteFile(
                        owner: manifest.owner, repo: manifest.repo, path: path,
                        branch: manifest.branch, message: message, sha: sha
                    )
                    try await store.delete(path)
                }
            } catch {
                throw PartialWriteFailure(underlying: error, succeeded: succeeded)
            }
            succeeded.append(path)
        }
    }

    /// Refetch → re-apply: replays every op of a conflicted group against the
    /// freshly pulled content, in queue order, so the batch lands on top of
    /// whatever changed remotely (ops are fid/text-addressed, so replaying is
    /// natural). Ops whose target vanished in that remote change can never
    /// succeed — they come back for individual parking while the rest of the
    /// group proceeds.
    private func reapply(_ ops: [QueuedOp]) async -> (plan: GroupPlan, parked: [(op: QueuedOp, error: String)]) {
        var overlay: [String: String?] = [:]
        var order: [String] = []
        var applied: [QueuedOp] = []
        var parked: [(op: QueuedOp, error: String)] = []

        for queued in ops {
            do {
                let edits = try await computeEdits(queued.op, createdAt: queued.queuedAt, overlay: overlay)
                for edit in edits {
                    if overlay.updateValue(edit.content, forKey: edit.path) == nil {
                        order.append(edit.path)
                    }
                }
                var updated = queued
                updated.paths = edits.map(\.path)
                updated.deletedShas = nil
                applied.append(updated)
            } catch {
                // Nothing of this op is in the materialized batch below, so
                // record it as un-applied: a later retry must re-apply it
                // rather than assume the document already carries it.
                var failed = queued
                failed.paths = []
                failed.deletedShas = nil
                parked.append((op: failed, error: error.localizedDescription))
            }
        }

        // Materialize the batch so the UI keeps showing the user's edits on
        // top of the content the forced pull just brought down.
        var deleted: [String: String] = [:]
        for path in order {
            guard let content = overlay[path] else { continue }
            if let content {
                try? await store.write(path, content: content, blobSha: nil)
            } else {
                if let sha = await store.blobSha(for: path) { deleted[path] = sha }
                try? await store.delete(path)
            }
        }
        notify()

        for index in applied.indices {
            let shas = applied[index].paths?.compactMap { path in
                deleted[path].map { (path, $0) }
            } ?? []
            applied[index].deletedShas = shas.isEmpty ? nil : Dictionary(uniqueKeysWithValues: shas)
        }
        return (GroupPlan(ops: applied), parked)
    }

    // MARK: - Op application

    private struct FileEdit {
        let path: String
        /// nil content means delete the file.
        let content: String?
    }

    /// Applies the op to local cached content only (optimistic UI), reporting
    /// the files it touched so the flush knows exactly what to push.
    @discardableResult
    private func applyLocally(_ op: PendingOp, createdAt: Date) async throws -> (paths: [String], deletedShas: [String: String]) {
        var paths: [String] = []
        var deletedShas: [String: String] = [:]
        for edit in try await computeEdits(op, createdAt: createdAt) {
            paths.append(edit.path)
            if let content = edit.content {
                try await store.write(edit.path, content: content, blobSha: nil)
            } else {
                // Capture the sha first: `delete` drops the manifest entry.
                if let sha = await store.blobSha(for: edit.path) { deletedShas[edit.path] = sha }
                try await store.delete(edit.path)
            }
        }
        notify()
        return (paths, deletedShas)
    }

    /// Current content for a path, honoring edits an earlier op in the same
    /// coalesced group already made but that are not on disk yet.
    private func read(_ path: String, overlay: [String: String?]) async -> String? {
        if let pending = overlay[path] { return pending }
        return await store.read(path)
    }

    /// The journal file today's adds belong in, for this store's actor.
    /// Separate from `PendingOp.primaryPath`, which still names `FINDINGS.md`:
    /// that property is *persisted* inside `pending-ops.json`, and teaching it
    /// about journals would mean changing a queue schema every shipped build
    /// has to keep reading. It costs nothing to leave alone — it is used as a
    /// coalescing key and as a writability probe, and `isWritablePath` gates
    /// `<project>/journal/…` on the very same ``LocalStore/isProjectDirName``
    /// as `<project>/FINDINGS.md`, so the two answer identically. The bytes
    /// pushed come from `QueuedOp.paths`, which records what was really
    /// edited.
    private func journalTarget(project: String) -> (path: String, file: JournalFile) {
        let actor = JournalFile.sanitizeActor(writeContext.actor)
        // journal.ts:153 — `new Date().toISOString().slice(0, 10)`, i.e. UTC.
        let date = String(FindingsFile.isoTimestamp(Date()).prefix(10))
        return (JournalFile.path(project: project, date: date, actor: actor),
                JournalFile(date: date, actor: actor))
    }

    /// Appends one finding to this store's journal instead of splicing
    /// `FINDINGS.md` — the app's half of tools/finding.ts:186.
    ///
    /// A journal file that exists on GitHub but hasn't been pulled yet reads
    /// as absent here, so this would write a fresh heading and PUT without a
    /// sha. GitHub rejects that with the same 422 as any stale write, which
    /// the flush already recovers from by refetching and re-applying the group
    /// onto the real file — the append lands, once.
    private func journalEdit(project: String, text: String, type: String?,
                             overlay: [String: String?]) async throws -> FileEdit {
        let finding = try JournalFile.preparedFinding(text, type: type.flatMap(FindingType.init(rawValue:)))
        let target = journalTarget(project: project)
        var file = JournalFile(date: target.file.date, actor: target.file.actor,
                               content: await read(target.path, overlay: overlay))
        file.append(finding, machine: writeContext.machine)
        return FileEdit(path: target.path, content: file.content)
    }

    /// Maps a domain op to concrete file edits against current local content.
    /// Each case mirrors the CLI handler documented on the file types.
    private func computeEdits(_ op: PendingOp, createdAt: Date, overlay: [String: String?] = [:]) async throws -> [FileEdit] {
        let project = op.project
        switch op {
        case .addFinding(_, let text, let type):
            if writeContext.usesTeamJournal {
                return [try await journalEdit(project: project, text: text, type: type, overlay: overlay)]
            }
            var file = FindingsFile(content: await read("\(project)/FINDINGS.md", overlay: overlay) ?? "")
            var provenance = FindingProvenance(source: "human", tool: "phren-ios")
            provenance.machine = writeContext.machine
            provenance.actor = writeContext.actor
            try file.add(project: project, text: text, options: .init(
                type: type.flatMap(FindingType.init(rawValue:)),
                provenance: provenance
            ))
            return [FileEdit(path: "\(project)/FINDINGS.md", content: file.content)]

        case .editFinding(_, let match, let newText):
            var file = FindingsFile(content: await read("\(project)/FINDINGS.md", overlay: overlay) ?? "")
            try file.edit(project: project, oldText: match, newText: newText)
            return [FileEdit(path: "\(project)/FINDINGS.md", content: file.content)]

        case .removeFinding(_, let match):
            var file = FindingsFile(content: await read("\(project)/FINDINGS.md", overlay: overlay) ?? "")
            try file.remove(project: project, match: match)
            return [FileEdit(path: "\(project)/FINDINGS.md", content: file.content)]

        case .approveQueue(_, let line):
            var file = ReviewFile(content: await read("\(project)/review.md", overlay: overlay) ?? "")
            try file.approve(lineText: line)
            return [FileEdit(path: "\(project)/review.md", content: file.content)]

        case .rejectQueue(_, let line):
            // access.ts:709 — remove the queue line AND the finding; a
            // missing finding is tolerated.
            var review = ReviewFile(content: await read("\(project)/review.md", overlay: overlay) ?? "")
            try review.reject(lineText: line)
            var edits = [FileEdit(path: "\(project)/review.md", content: review.content)]
            let needle = ReviewFile.findingsTextFor(lineText: line)
            if !needle.isEmpty {
                var findings = FindingsFile(content: await read("\(project)/FINDINGS.md", overlay: overlay) ?? "")
                if (try? findings.remove(project: project, match: needle)) != nil {
                    edits.append(FileEdit(path: "\(project)/FINDINGS.md", content: findings.content))
                }
            }
            return edits

        case .editQueue(_, let line, let newText):
            // access.ts:728 — rewrite the queue line, tolerantly edit the finding.
            var review = ReviewFile(content: await read("\(project)/review.md", overlay: overlay) ?? "")
            let oldNeedle = ReviewFile.findingsTextFor(lineText: line)
            let trimmed = try review.edit(lineText: line, newText: newText)
            var edits = [FileEdit(path: "\(project)/review.md", content: review.content)]
            if !oldNeedle.isEmpty {
                var findings = FindingsFile(content: await read("\(project)/FINDINGS.md", overlay: overlay) ?? "")
                if (try? findings.edit(project: project, oldText: oldNeedle, newText: trimmed)) != nil {
                    edits.append(FileEdit(path: "\(project)/FINDINGS.md", content: findings.content))
                }
            }
            return edits

        case .addNote(_, let date, let time, let text):
            let path = "\(project)/notes/\(date).md"
            var file = NotesFile(project: project, date: date, content: await read(path, overlay: overlay))
            try file.add(text: text, time: time)
            return [FileEdit(path: path, content: file.render())]

        case .editNote(_, let date, let stableId, let text):
            let path = "\(project)/notes/\(date).md"
            var file = NotesFile(project: project, date: date, content: await read(path, overlay: overlay))
            try file.edit(stableId: stableId, text: text)
            return [FileEdit(path: path, content: file.render())]

        case .removeNote(_, let date, let stableId):
            let path = "\(project)/notes/\(date).md"
            var file = NotesFile(project: project, date: date, content: await read(path, overlay: overlay))
            try file.remove(stableId: stableId)
            // render() returns nil when the last note was removed → delete file.
            return [FileEdit(path: path, content: file.render())]

        case .promoteNote(_, let date, let stableId, let findingType):
            // core/note.ts:13 — refuse if promoted; add finding; mark note.
            let notePath = "\(project)/notes/\(date).md"
            var notesFile = NotesFile(project: project, date: date, content: await read(notePath, overlay: overlay))
            guard let note = notesFile.notes.first(where: { $0.stableId == stableId }) else {
                throw PhrenKitError.notFound("No note matching \"nid:\(stableId)\" was found.")
            }
            guard !note.promoted else {
                throw PhrenKitError.validation("Note nid:\(stableId) has already been promoted.")
            }
            // A promotion *is* a finding-add, so it takes the same route: in a
            // team store the finding half lands in the journal and the note is
            // marked promoted either way.
            if writeContext.usesTeamJournal {
                let journal = try await journalEdit(project: project, text: note.text,
                                                    type: findingType, overlay: overlay)
                try notesFile.markPromoted(stableId: stableId)
                return [journal, FileEdit(path: notePath, content: notesFile.render())]
            }
            var findings = FindingsFile(content: await read("\(project)/FINDINGS.md", overlay: overlay) ?? "")
            var provenance = FindingProvenance(source: "human", tool: "phren-ios")
            provenance.machine = writeContext.machine
            provenance.actor = writeContext.actor
            try findings.add(project: project, text: note.text, options: .init(
                type: findingType.flatMap(FindingType.init(rawValue:)),
                provenance: provenance
            ))
            try notesFile.markPromoted(stableId: stableId)
            return [
                FileEdit(path: "\(project)/FINDINGS.md", content: findings.content),
                FileEdit(path: notePath, content: notesFile.render()),
            ]

        case .addTask(_, let text):
            var file = TasksFile(project: project, content: await read("\(project)/tasks.md", overlay: overlay))
            try file.add(text, createdAt: createdAt.ISO8601Format(.init(includingFractionalSeconds: true)))
            return [FileEdit(path: "\(project)/tasks.md", content: file.render())]

        case .completeTask(_, let match):
            var file = TasksFile(project: project, content: await read("\(project)/tasks.md", overlay: overlay))
            try file.complete(match)
            return [FileEdit(path: "\(project)/tasks.md", content: file.render())]

        case .removeTask(_, let match):
            var file = TasksFile(project: project, content: await read("\(project)/tasks.md", overlay: overlay))
            try file.remove(match)
            return [FileEdit(path: "\(project)/tasks.md", content: file.render())]

        case .updateTask(_, let match, let text, let priority, let section):
            var file = TasksFile(project: project, content: await read("\(project)/tasks.md", overlay: overlay))
            try file.update(match, updates: .init(
                text: text,
                priority: priority.flatMap(PhrenTask.Priority.init(rawValue:)),
                section: section.flatMap(PhrenTask.Section.init(rawValue:))
            ))
            return [FileEdit(path: "\(project)/tasks.md", content: file.render())]

        case .setSkillEnabled(let scope, let name, let enabled, let expected):
            let content = try SkillPreferences.setting(await read(SkillPreferences.path, overlay: overlay),
                                                       scope: scope, name: name, enabled: enabled, expected: expected)
            return [FileEdit(path: SkillPreferences.path, content: content)]

        case .saveAuthoredFile(let path, let content, let expected):
            let current = await read(path, overlay: overlay)
            try AuthoredFile.validate(path: path, current: current, expected: expected, content: content)
            if expected == nil, LocalStore.isSkillPath(path) {
                var paths = Set(await store.allPaths())
                for (candidate, value) in overlay {
                    if value == nil { paths.remove(candidate) } else { paths.insert(candidate) }
                }
                if let conflict = AuthoredFile.conflictingSkillPath(for: path, among: Array(paths)) {
                    throw PhrenKitError.duplicate("A skill with that name already exists at \(conflict).")
                }
            }
            return [FileEdit(path: path, content: content)]

        case .deleteAuthoredFile(let path, let expected):
            try AuthoredFile.validate(path: path, current: await read(path, overlay: overlay),
                                      expected: expected, content: nil)
            return [FileEdit(path: path, content: nil)]

        case .updateSkill(let path, let content):
            // A skill is authored prose, so the op already holds the finished
            // bytes: there is nothing to re-derive from current content, which
            // makes a replay trivially deterministic.
            guard LocalStore.isSkillPath(path) else {
                throw PhrenKitError.validation("\(path) is not a skill path.")
            }
            guard !content.isEmpty else {
                throw PhrenKitError.validation("Refusing to save an empty skill.")
            }
            // The same gate the CLI applies to findings — a skill body is free
            // prose and just as capable of carrying a pasted token.
            if let secret = SecretScanner.scan(content) {
                throw PhrenKitError.validation(secret)
            }
            return [FileEdit(path: path, content: content)]

        case .deleteSkill(let path):
            guard LocalStore.isSkillPath(path) else {
                throw PhrenKitError.validation("\(path) is not a skill path.")
            }
            return [FileEdit(path: path, content: nil)]
        }
    }
}
