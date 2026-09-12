import SwiftUI
import PhrenKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var failedOps: [FailedOpEntry] = []
    @State private var confirmSignOut = false
    @State private var showAddStore = false
    @State private var removingStore: StoreDescriptor?
    /// The same writable (store, project) list the App Intents resolve
    /// against — read through `PhrenCapture` rather than rebuilt from
    /// `mergedProjects` so the picker can't offer a destination capture
    /// wouldn't accept (and isn't narrowed by the global store filter).
    @State private var captureTargets: [PhrenCaptureTarget] = []
    /// `nil` = "Always ask". Mirrors `QuickCaptureDefault`, held in state so
    /// the picker has something to bind to.
    @State private var captureDefaultId: String?
    @State private var captureLog: [CaptureLogEntry] = []
    @State private var captureQueue = CaptureQueueState()
    /// Drives the health cards' relative "synced Xm ago" text and staleness
    /// check. A 30s tick is plenty for a 10-minute staleness threshold —
    /// unlike LiveStatusBar this doesn't need per-second precision.
    @State private var now = Date()
    private let healthTicker = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private static let needsAttentionAnchor = "needs-attention"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ActionErrorBanner()
                ScrollViewReader { proxy in
                PhrenForm {
                Section("Appearance") {
                    NavigationLink { AppearanceSettingsView() } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "paintpalette").foregroundStyle(PhrenTheme.accent)
                            Text("Theme")
                            Spacer()
                            Text(PhrenAppearance.shared.name).foregroundStyle(PhrenTheme.textMuted)
                        }
                    }.accessibilityIdentifier("settings-theme")
                }
                if model.phase == .ready {
                Section {
                    ForEach(model.storeContexts) { context in
                        StoreHealthCard(
                            context: context,
                            claims: model.claimedElsewhere(storeId: context.id),
                            queuedCaptures: queuedCaptureCount(storeId: context.id),
                            now: now,
                            onTapFailedOps: {
                                withAnimation { proxy.scrollTo(Self.needsAttentionAnchor, anchor: .top) }
                            }
                        )
                    }
                    ForEach(Array(model.duplicateProjectGroups.enumerated()), id: \.offset) { _, group in
                        DuplicateProjectHintRow(names: group)
                    }
                    // Data that couldn't be read after an update is set aside
                    // rather than dropped. The transient banner is easy to
                    // miss, so the issue also persists here with the path the
                    // quarantined bytes are recoverable from.
                    ForEach(model.storageIssues) { issue in
                        StorageIssueRow(issue: issue)
                    }
                } header: {
                    Text("Store health")
                } footer: {
                    Text("Amber indicates a failed or delayed sync.")
                }

                quickCaptureSection
                recentCapturesSection

                Section("Memory") {
                    Button("Memory maintenance", systemImage: "wrench.and.screwdriver") {
                        model.showingMemoryMaintenance = true
                    }
                }
                }

                Section("Agent connections") {
                    NavigationLink("Computers & Phren Hook") { LiveSessionsView() }
                    Text("Chat, terminals, and project memory stay together in Phren. Connect the agents already running on your computers.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("GitHub memory") {
                    if model.phase == .signedOut || model.phase == .loading {
                        Button("Connect memory", systemImage: "arrow.triangle.2.circlepath") {
                            model.showingMemoryConnection = true
                        }.accessibilityIdentifier("settings-connect-memory")
                        Text("GitHub is used for memory sync. Agent connections use your computers' SSH keys.")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    } else {
                    if let user = model.user {
                        LabeledContent("GitHub", value: "@\(user.login)")
                        if let name = user.name {
                            LabeledContent("Name", value: name)
                        }
                    }
                    Button("Sign out", role: .destructive) {
                        confirmSignOut = true
                    }
                    }
                }

                if model.phase == .ready {
                Section {
                    ForEach(model.storeContexts) { context in
                        StoreRow(context: context)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    removingStore = context.descriptor
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            }
                    }
                    Button {
                        showAddStore = true
                    } label: {
                        Label("Add store", systemImage: "plus")
                    }
                } header: {
                    Text("Stores")
                } footer: {
                    Text("Each store is a GitHub repository holding a phren store. Removing one only deletes this device's local copy.")
                }

                Section("Sync") {
                    LabeledContent("Live updates", value: model.syncStatus.isLive ? "On" : "Paused")
                    if let last = model.syncStatus.lastSyncedAt {
                        LabeledContent("Last synced", value: last.formatted(date: .omitted, time: .standard))
                    }
                    LabeledContent("Pending changes", value: "\(model.syncStatus.pendingCount)")
                    if let error = model.syncStatus.lastError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    Button("Sync now") {
                        Task {
                            await model.pullToRefresh()
                            failedOps = await model.failedOps()
                        }
                    }
                }
                }

                if !failedOps.isEmpty {
                    Section {
                        ForEach(failedOps) { failed in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(failed.op.op.label).font(.callout)
                                if case .saveAuthoredFile(_, let content, _) = failed.op.op {
                                    NavigationLink("Review saved draft") {
                                        PhrenList {
                                            Section("Your draft") { DocumentPreview(content: content) }
                                            Section {
                                                ShareLink(item: content) {
                                                    Label("Share draft", systemImage: "square.and.arrow.up")
                                                }
                                                Text("Copy the text you want to keep, then open the latest instructions or skill to apply it.")
                                                    .font(.caption).foregroundStyle(.secondary)
                                            }
                                        }.navigationTitle("Saved draft")
                                    }
                                }
                                HStack(spacing: 6) {
                                    if model.hasMultipleStores {
                                        TagChip(text: failed.storeName, role: .store)
                                    }
                                    if let error = failed.op.lastError {
                                        Text(error).font(.caption).foregroundStyle(.red)
                                    }
                                }
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    Task {
                                        await model.discardFailedOp(storeId: failed.storeId, id: failed.op.id)
                                        failedOps = await model.failedOps()
                                    }
                                } label: {
                                    Label("Discard", systemImage: "trash")
                                }
                            }
                        }
                        Button("Retry all") {
                            Task {
                                await model.retryFailedOps()
                                failedOps = await model.failedOps()
                            }
                        }
                    } header: {
                        Text("Needs attention")
                    } footer: {
                        Text("These changes couldn't be applied — usually because the item changed on another machine. Retry or discard them.")
                    }
                    .id(Self.needsAttentionAnchor)
                }

                Section("About") {
                    LabeledContent("App", value: "phren for iOS")
                    LabeledContent("Version", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"))")
                    Link("phren on GitHub", destination: URL(string: "https://github.com/alaarab/phren")!)
                    NavigationLink("Open-source notices") {
                        ScrollView {
                            Text(Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt")
                                .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "Notices unavailable.")
                                .font(.caption).textSelection(.enabled).padding()
                        }
                        .navigationTitle("Open-source notices")
                        .phrenScreen()
                    }
                }
            }
            .phrenScreen()
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                failedOps = await model.failedOps()
                await reloadCaptureState()
            }
            // Re-reads the log and the queue when anything enters or leaves
            // the pending queue — which is what a Siri capture landing while
            // this screen is open, or a flush finishing, looks like from here.
            .onChange(of: model.syncStatus.pendingCount) {
                Task { await reloadCaptureState() }
            }
            .onReceive(healthTicker) { now = $0 }
            .refreshable {
                await model.pullToRefresh()
                failedOps = await model.failedOps()
                await reloadCaptureState()
            }
            .sheet(isPresented: $showAddStore) {
                NavigationStack {
                    RepoPickerList(
                        existingStoreIds: Set(model.storeDescriptors.map(\.id))
                    ) { repo in
                        showAddStore = false
                        Task { await model.addStore(repo: repo) }
                    }
                    .navigationTitle("Add store")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showAddStore = false }
                        }
                    }
                }
            }
            .confirmationDialog(
                "Remove \(removingStore?.id ?? "this store") from this device? The GitHub repository is not affected.",
                isPresented: $removingStore.isPresent(),
                titleVisibility: .visible
            ) {
                Button("Remove store", role: .destructive) {
                    if let store = removingStore {
                        Task { await model.removeStore(id: store.id) }
                    }
                    removingStore = nil
                }
            }
            .confirmationDialog(
                "Sign out of GitHub and remove local memory stores? Your agent connections and chat drafts stay on this device.",
                isPresented: $confirmSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive) {
                    Task { await model.signOut() }
                }
            }
            }
            }
        }
    }

    // MARK: - Quick capture

    /// The one place a capture destination is ever chosen without the user
    /// present. "Always ask" is the shipping default and stays a first-class
    /// option: with nine projects attached, a destination the user never
    /// picked is exactly how a capture disappears.
    @ViewBuilder
    private var quickCaptureSection: some View {
        Section {
            Picker("Default project", selection: captureDefaultBinding) {
                Text("Always ask").tag(String?.none)
                // Keeps a broken default visible (and selected) instead of
                // rendering an empty row that looks like "Always ask".
                if let unavailable = unavailableDefault {
                    Text("\(unavailable.label) — unavailable").tag(String?.some(unavailable.id))
                }
                ForEach(captureTargets, id: \.entityId) { target in
                    Text(target.displayName).tag(String?.some(target.entityId))
                }
            }
            .disabled(captureTargets.isEmpty && unavailableDefault == nil)
        } header: {
            Text("Quick capture")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if let unavailable = unavailableDefault {
                    Text("'\(unavailable.label)' isn't in an attached, writable store any more — captures ask where to go until you pick a new default.")
                        .foregroundStyle(PhrenTheme.warning)
                }
                Text("Choose where Siri, Shortcuts, and voice captures are saved. With Always ask, you choose a project each time.")
            }
        }
    }

    /// Writes straight through to `QuickCaptureDefault` so the setting is
    /// durable the moment it's picked — the App Intents read it from there,
    /// possibly in a process this view never shares.
    private var captureDefaultBinding: Binding<String?> {
        Binding(
            get: { captureDefaultId },
            set: { newValue in
                captureDefaultId = newValue
                guard let newValue, let parsed = QuickCaptureDefault.parse(entityId: newValue) else {
                    QuickCaptureDefault.clear()
                    return
                }
                QuickCaptureDefault.save(storeId: parsed.storeId, project: parsed.project)
            }
        )
    }

    /// The configured default when it no longer resolves to a writable
    /// project. Always store-qualified: when the store itself is what went
    /// away, its name is the whole explanation.
    private var unavailableDefault: (id: String, label: String)? {
        guard let id = captureDefaultId,
              !captureTargets.contains(where: { $0.entityId == id }),
              let parsed = QuickCaptureDefault.parse(entityId: id) else { return nil }
        return (id, "\(parsed.project) · \(model.storeName(for: parsed.storeId))")
    }

    // MARK: - Recent captures

    /// "Where did that go?", answered without leaving the app. Every capture
    /// this device made, in order, with its destination and whether it has
    /// actually left the phone yet.
    @ViewBuilder
    private var recentCapturesSection: some View {
        if !captureLog.isEmpty {
            Section {
                ForEach(captureLog) { entry in
                    let row = CaptureLogRow(
                        entry: entry,
                        destination: destinationLabel(entry),
                        state: captureQueue.state(of: entry),
                        missing: !projectExists(entry),
                        now: now
                    )
                    // A capture whose project is still here is worth a tap;
                    // one whose project has gone is still worth showing, with
                    // the destination it had.
                    if projectExists(entry) {
                        NavigationLink {
                            ProjectDetailView(storeId: entry.storeId, project: entry.project)
                        } label: {
                            row
                        }
                    } else {
                        row
                    }
                }
                Button("Clear list") {
                    CaptureLog.clear()
                    captureLog = []
                }
            } header: {
                Text("Recent captures")
            } footer: {
                Text("The last \(CaptureLog.limit) notes and tasks captured on this device, newest first. Tap one to open the project it went to. Clearing the list doesn't remove anything from your store.")
            }
        }
    }

    private func destinationLabel(_ entry: CaptureLogEntry) -> String {
        model.hasMultipleStores ? "\(entry.project) · \(model.storeName(for: entry.storeId))" : entry.project
    }

    private func projectExists(_ entry: CaptureLogEntry) -> Bool {
        model.storeContexts.first { $0.id == entry.storeId }?
            .snapshot.projects.contains { $0.name == entry.project } ?? false
    }

    /// Captures still sitting in this store's pending queue — the ones a Siri
    /// capture made with the app closed produces, and the reason the health
    /// card's pending count isn't always something the user did on screen.
    private func queuedCaptureCount(storeId: String) -> Int {
        captureLog.filter { $0.storeId == storeId && captureQueue.state(of: $0) == .queued }.count
    }

    private func reloadCaptureState() async {
        captureTargets = await PhrenCapture.targets()
        captureDefaultId = QuickCaptureDefault.load().map {
            QuickCaptureDefault.entityId(storeId: $0.storeId, project: $0.project)
        }
        captureLog = CaptureLog.entries()
        captureQueue = await CaptureQueueState.sample(from: model)
    }
}

/// One line of the capture receipt drawer: what was said, where it went, when,
/// and whether it has left the device yet.
private struct CaptureLogRow: View {
    let entry: CaptureLogEntry
    let destination: String
    let state: CaptureSyncState
    /// The destination project isn't in an attached store any more (removed
    /// store, or deleted elsewhere) — the row still names where it went.
    let missing: Bool
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.snippet)
                .font(.callout)
                .foregroundStyle(PhrenTheme.text)
                .lineLimit(2)

            HStack(spacing: 6) {
                Image(systemName: entry.kind.systemImage)
                Text(destination)
                    .fontWeight(.medium)
                    .lineLimit(1)
                if missing {
                    Text("(not in an attached store)")
                        .foregroundStyle(PhrenTheme.warning)
                }
                Spacer(minLength: 6)
                Text(relativeTime)
            }
            .font(.caption)
            .foregroundStyle(PhrenTheme.textMuted)

            HStack(spacing: 6) {
                Label(state.label, systemImage: state.systemImage)
                    .foregroundStyle(stateColor)
                Text("·")
                Text(entry.source.label)
            }
            .font(.caption2)
            .foregroundStyle(PhrenTheme.textDim)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.kind.label): \(entry.snippet). Saved to \(destination), \(relativeTime), \(state.label).")
    }

    private var relativeTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: entry.at, relativeTo: now)
    }

    private var stateColor: Color {
        switch state {
        case .synced: return PhrenTheme.textDim
        case .queued: return PhrenTheme.amber
        case .failed: return PhrenTheme.danger
        }
    }
}

struct StoreRow: View {
    let context: StoreContext

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(context.descriptor.id)
                    .font(.callout)
                if !context.descriptor.canPush {
                    TagChip(text: "read-only", role: .warn)
                }
            }
            HStack(spacing: 8) {
                if let last = context.status.lastSyncedAt {
                    Text("synced \(last.formatted(date: .omitted, time: .shortened))")
                } else {
                    Text("not synced yet")
                }
                if context.status.pendingCount > 0 {
                    Text("\(context.status.pendingCount) pending")
                        .foregroundStyle(.orange)
                }
                if let error = context.status.lastError {
                    Text(error)
                        .foregroundStyle(.red)
                        .lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

/// Glanceable per-store diagnostics: the whole point of the "your store had
/// silently leaked projects / silently stopped syncing for two months" story
/// is that nothing surfaced it until someone went looking. This card is the
/// surface — it renders in the warning color the moment any of its signals
/// (failed ops, a sync gone quiet, a read-only token, or a stores.yaml claim)
/// needs a look, rather than waiting for the user to dig into "Stores" or
/// "Needs attention" separately.
private struct StoreHealthCard: View {
    let context: StoreContext
    /// Per-claimant counts from `AppModel.claimedElsewhere` — projects
    /// physically in this store that `stores.yaml` says belong elsewhere.
    let claims: [(name: String, count: Int)]
    /// How many of the pending ops are captures this device made by voice or
    /// from a shortcut. A Siri capture with the app closed queues exactly like
    /// an in-app edit, so without naming it the count reads as "phren has
    /// unsent work" with no hint of what.
    let queuedCaptures: Int
    let now: Date
    let onTapFailedOps: () -> Void

    /// "No successful sync in > 10 minutes" only means something while the
    /// store is actively polling — a deliberately paused store isn't stale,
    /// it's just off.
    private var isStale: Bool {
        guard context.status.isLive, let last = context.status.lastSyncedAt else { return false }
        return now.timeIntervalSince(last) > 600
    }

    private var isWarning: Bool {
        context.status.failedCount > 0 || isStale || context.status.lastError != nil
    }

    private var indicatorColor: Color {
        if isWarning { return PhrenTheme.warning }
        return context.status.isLive ? PhrenTheme.success : PhrenTheme.textDim
    }

    private var lastSyncText: String {
        guard let last = context.status.lastSyncedAt else { return "not synced yet" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "synced \(formatter.localizedString(for: last, relativeTo: now))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle()
                    .fill(indicatorColor)
                    .frame(width: 8, height: 8)
                Text(context.descriptor.displayName)
                    .font(.callout.weight(.semibold))
                Spacer()
                Text(context.status.isLive ? "live" : "paused")
                    .font(.caption2.monospaced())
                    .foregroundStyle(context.status.isLive ? PhrenTheme.cyan : PhrenTheme.textDim)
            }

            Text(lastSyncText)
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 14) {
                if context.status.pendingCount > 0 {
                    Label("\(context.status.pendingCount) pending", systemImage: "arrow.up.circle")
                        .foregroundStyle(PhrenTheme.amber)
                }
                if context.status.failedCount > 0 {
                    Button(action: onTapFailedOps) {
                        Label("\(context.status.failedCount) failed", systemImage: "exclamationmark.triangle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(PhrenTheme.danger)
                }
            }
            .font(.caption)

            if queuedCaptures > 0 {
                Label(queuedCaptureText, systemImage: "mic")
                    .font(.caption)
                    .foregroundStyle(PhrenTheme.amber)
            }

            if let error = context.status.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(PhrenTheme.danger)
                    .lineLimit(2)
            }

            if !context.descriptor.canPush {
                Label("Read-only — your token can't push to this repo", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(PhrenTheme.amber)
            }

            ForEach(claims, id: \.name) { claim in
                Label(claimText(claim), systemImage: "person.2")
                    .font(.caption)
                    .foregroundStyle(PhrenTheme.amber)
            }
        }
        .padding(.vertical, 4)
    }

    private var queuedCaptureText: String {
        queuedCaptures == 1
            ? "1 of those is a capture waiting to sync — see Recent captures"
            : "\(queuedCaptures) of those are captures waiting to sync — see Recent captures"
    }

    private func claimText(_ claim: (name: String, count: Int)) -> String {
        let plural = claim.count == 1 ? "project" : "projects"
        let verb = claim.count == 1 ? "is" : "are"
        let pronoun = claim.count == 1 ? "it" : "they"
        return "\(claim.count) \(plural) in this store \(verb) claimed by '\(claim.name)' — \(pronoun) may belong in that store."
    }
}

/// Awareness-only nudge for near-duplicate project names (Task: canonical-key
/// normalization) — e.g. `max4liveplugins` vs `max4live-plugins` sitting side
/// by side unnoticed. No merge/rename action: this only names the pattern.
/// A persisted-state file that couldn't be read (after an update, or from a
/// newer build) and was quarantined instead of discarded. Shown here as well
/// as in the transient banner because the whole point of quarantining is that
/// the bytes stay recoverable — the user needs somewhere durable to find out
/// that happened, and where the copy went.
private struct StorageIssueRow: View {
    let issue: StorageIssue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(issue.userMessage, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(PhrenTheme.warning)
            if let quarantine = issue.quarantineLocation {
                Text(quarantine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

private struct DuplicateProjectHintRow: View {
    let names: [String]

    var body: some View {
        Label(sentence, systemImage: "doc.on.doc")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var sentence: String {
        let joined: String
        switch names.count {
        case 0: joined = ""
        case 1: joined = names[0]
        case 2: joined = "\(names[0]) and \(names[1])"
        default: joined = names.dropLast().joined(separator: ", ") + ", and \(names.last!)"
        }
        return "\(joined) look like the same project."
    }
}
