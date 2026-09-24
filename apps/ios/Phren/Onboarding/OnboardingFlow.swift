import SwiftUI
import PhrenKit

struct OnboardingFlow: View {
    var isPresented = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .signedOut: WelcomeView()
                case .pickingRepo: RepoPickerView()
                case .initialSync: InitialSyncView()
                default: ProgressView("Loading memory…")
                }
            }
            .toolbar {
                if isPresented {
                    ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
                }
            }
        }
    }
}

// MARK: - Welcome + sign-in

struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showPATSheet = false
    @State private var deviceCode: DeviceCodeResponse?
    @State private var authError: String?
    @State private var polling = false
    @State private var authTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 20) {
            PhrenMascotView(size: 84, bobbing: false, glow: false)
                .padding(.top, 20)
            Text("Connect project memory")
                .font(.system(.largeTitle).weight(.semibold))
                .foregroundStyle(PhrenTheme.text)
            Text("Findings, skills, and tasks — synced with your GitHub repositories.")
                .font(.callout)
                .foregroundStyle(PhrenTheme.textMuted)
            Text("Agents and terminals work without GitHub. Connect memory whenever you're ready.")
                .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
            if let message = model.authenticationMessage {
                Text(message).font(.footnote).foregroundStyle(PhrenTheme.warning)
            }

            if let code = deviceCode {
                DeviceCodeView(code: code, polling: polling)
            }
            if let authError {
                Text(authError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            VStack(spacing: 12) {
                if DeviceFlowAuth.isConfigured {
                    Button {
                        authTask = Task { await startDeviceFlow() }
                    } label: {
                        Label("Sign in with GitHub", systemImage: "person.crop.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(PhrenTheme.accentSolid)
                    .disabled(polling)
                }
                Button {
                    authTask?.cancel()
                    showPATSheet = true
                } label: {
                    Label("Connect with a GitHub token", systemImage: "key.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .padding(.top, 8)
            Text("Your sign-in is saved in this device's Keychain. Sync goes directly to GitHub.")
                .font(.caption).foregroundStyle(PhrenTheme.textDim)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Memory").navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showPATSheet) {
            PATSignInSheet()
        }
        .onDisappear { authTask?.cancel() }
    }

    private func startDeviceFlow() async {
        guard !polling else { return }
        authError = nil
        guard DeviceFlowAuth.isConfigured else {
            authError = "GitHub sign-in isn't set up yet — use a token instead."
            return
        }
        polling = true
        defer { polling = false; deviceCode = nil }
        let auth = DeviceFlowAuth()
        do {
            let code = try await auth.requestCode()
            deviceCode = code
            #if canImport(UIKit)
            if let url = URL(string: code.verificationUri) {
                await UIApplication.shared.open(url)
            }
            #endif
            switch try await auth.waitForAuthorization(code) {
            case .authorized(let token):
                try Task.checkCancellation()
                try await model.signIn(token: token, kind: .oauth)
            case .expired:
                authError = "The code expired — try again."
            case .denied:
                authError = "Authorization was denied."
            default:
                break
            }
        } catch {
            if !Task.isCancelled { authError = "Couldn't reach GitHub: \(error.localizedDescription)" }
        }
    }
}

struct DeviceCodeView: View {
    let code: DeviceCodeResponse
    let polling: Bool

    var body: some View {
        VStack(spacing: 8) {
            Text("Enter this code on GitHub:")
                .font(.footnote.monospaced())
                .foregroundStyle(PhrenTheme.textMuted)
            Text(code.userCode)
                .font(.system(.title, design: .monospaced).bold())
                .foregroundStyle(PhrenTheme.cyan)
                .textSelection(.enabled)
            if polling {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Waiting for approval…")
                        .font(.footnote.monospaced())
                        .foregroundStyle(PhrenTheme.textMuted)
                }
            }
        }
        .padding()
        .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(PhrenTheme.border, lineWidth: 1))
    }
}

struct PATSignInSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var error: String?
    @State private var validating = false

    var body: some View {
        NavigationStack {
            PhrenForm {
                Section {
                    Link("Create a token on GitHub", destination: URL(string: "https://github.com/settings/personal-access-tokens/new")!)
                    PhrenSecureField("github_pat_… or ghp_…", text: $token, identifier: "onboarding-token",
                                     monospaced: true, surface: .bare)
                } header: {
                    Text("Personal access token")
                } footer: {
                    Text("Create a fine-grained token with **Contents: Read and write** and **Metadata: Read** on your phren store repository. The token is stored only in this device's Keychain. Under Repository access, select your store repository — a token that can't see it will show only your public repos.")
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            }
            .navigationTitle("Token sign-in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sign in") {
                        Task { await submit() }
                    }
                    .disabled(token.trimmingCharacters(in: .whitespaces).isEmpty || validating)
                }
            }
        }
    }

    private func submit() async {
        validating = true
        defer { validating = false }
        do {
            try await model.signIn(token: token, kind: .pat)
            dismiss()
        } catch {
            self.error = "GitHub rejected that token. Check you pasted all of it and that it hasn't expired."
        }
    }
}

// MARK: - Repo picker

/// First-run store selection: picking a repo adds it as the first store.
struct RepoPickerView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        RepoPickerList(
            existingStoreIds: [],
            footer: "Pick the GitHub repository that holds your phren store (it contains phren.root.yaml). Set one up on your computer with `phren team init` or `phren store add`."
        ) { repo in
            Task { await model.addStore(repo: repo) }
        }
        .navigationTitle("Choose your store")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Sign out") {
                    Task { await model.signOut() }
                }
            }
        }
    }
}

/// Reusable repo list with phren-store detection: used by first-run onboarding
/// and by Settings → Stores → Add store.
struct RepoPickerList: View {
    let existingStoreIds: Set<String>
    let footer: String
    let onSelect: (GitHubRepo) -> Void

    @Environment(AppModel.self) private var model
    @State private var repos: [GitHubRepo] = []
    @State private var phrenStoreNames: Set<String> = []
    /// Repos the token can list (via `listAllRepos`) but that answered
    /// 401/403 probing for `phren.root.yaml` — a fine-grained token can have
    /// enough scope to list a repo's metadata but not its contents. Counted
    /// rather than silently folded into "not a store" so a scope problem
    /// never looks identical to "you just haven't set one up".
    @State private var noAccessCount = 0
    @State private var loading = true
    @State private var probing = false
    @State private var loadError: String?
    @State private var error: String?
    @State private var manualEntry = ""

    init(existingStoreIds: Set<String>,
         footer: String = "Add any repository that holds a phren store (it contains phren.root.yaml).",
         onSelect: @escaping (GitHubRepo) -> Void) {
        self.existingStoreIds = existingStoreIds
        self.footer = footer
        self.onSelect = onSelect
    }

    private var likelyStores: [GitHubRepo] {
        repos.filter { phrenStoreNames.contains($0.fullName) }
    }

    private var otherRepos: [GitHubRepo] {
        repos.filter { !phrenStoreNames.contains($0.fullName) }
    }

    /// True once repos have loaded and every one of them is public — a token
    /// scoped away from a private store repo still lists successfully, it
    /// just silently omits the repo the user actually needs.
    private var onlyPublicReposListed: Bool {
        !loading && loadError == nil && !repos.isEmpty && repos.allSatisfy { !$0.isPrivate }
    }

    /// The `.noAccess` count phrased as a footer message, or nil once there's
    /// nothing to report — mirrors `onlyPublicReposListed`'s "describe the
    /// scope gap, don't just hide the repo" approach for the other shape a
    /// token-scope mismatch takes (visible in the list, unreadable at the
    /// contents endpoint).
    private var noAccessMessage: String? {
        guard noAccessCount > 0 else { return nil }
        let subject = noAccessCount == 1 ? "1 repository answers" : "\(noAccessCount) repositories answer"
        let pronoun = noAccessCount == 1 ? "it" : "them"
        return "\(subject) a permissions error checking for phren.root.yaml — your token can list \(pronoun) but not read contents. Add Contents: Read and write under Repository access on GitHub, then pull to refresh."
    }

    var body: some View {
        PhrenList {
            if !likelyStores.isEmpty || probing {
                Section {
                    if likelyStores.isEmpty {
                        HStack { ProgressView().controlSize(.small); Text("Checking your repositories for phren stores…") }
                    } else {
                        ForEach(likelyStores) { repo in
                            repoRow(repo, isStore: true)
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text("Phren stores")
                        if probing { ProgressView().controlSize(.mini) }
                    }
                }
            }
            Section {
                if loading {
                    HStack { ProgressView(); Text("Loading repositories…") }
                } else if let loadError {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(loadError).foregroundStyle(.red).font(.footnote)
                        Button("Try again") {
                            Task { await load() }
                        }
                    }
                }
                ForEach(otherRepos) { repo in
                    repoRow(repo, isStore: false)
                }
            } header: {
                Text(likelyStores.isEmpty ? "Your repositories" : "Other repositories")
            } footer: {
                if let noAccessMessage {
                    Text(noAccessMessage)
                } else if onlyPublicReposListed {
                    Text("Only public repositories are listed. If your phren store repo is private, your token doesn't have access to it yet — add the repo under Repository access on GitHub, then pull to refresh.")
                }
            }
            Section {
                PhrenTextField("owner/repo", text: $manualEntry, identifier: "onboarding-manual-repo", surface: .bare)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Open") {
                    Task { await openManual() }
                }
                .disabled(!manualEntry.contains("/"))
            } header: {
                Text("Or enter a repository directly")
            } footer: {
                if let error {
                    Text(error).foregroundStyle(.red)
                } else {
                    Text(footer)
                }
            }
        }
        .phrenScreen()
        .task { await load() }
    }

    private func repoRow(_ repo: GitHubRepo, isStore: Bool) -> some View {
        let alreadyAdded = existingStoreIds.contains(repo.fullName)
        return Button {
            onSelect(repo)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.fullName).font(.body)
                    HStack(spacing: 6) {
                        if repo.isPrivate {
                            Label("Private", systemImage: "lock").font(.caption2)
                        }
                        if repo.permissions?.push == false {
                            Label("Read-only", systemImage: "eye").font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
                Spacer()
                if alreadyAdded {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else if isStore {
                    Image(systemName: "brain.head.profile")
                        .foregroundStyle(.tint)
                }
            }
        }
        .tint(.primary)
        .disabled(alreadyAdded)
    }

    /// Fetches every page of repos (bounded at 5 — accounts with hundreds of
    /// repos used to keep their store off the picker entirely when only page
    /// 1 was fetched), then probes all of them for `phren.root.yaml`.
    ///
    /// The list renders as soon as `repos` is set — `loading` flips to
    /// `false` before probing starts, not after — and the "Phren stores"
    /// section fills in as probes complete, so a large account never blocks
    /// the whole picker on one request at a time the way `.prefix(10)` did.
    private func load() async {
        loading = true
        loadError = nil
        phrenStoreNames = []
        noAccessCount = 0
        do {
            repos = try await model.client.listAllRepos(maxPages: 5)
        } catch {
            loadError = error.localizedDescription
            loading = false
            return
        }
        loading = false
        probing = true
        await probeAll(repos)
        probing = false
    }

    /// Bounded-concurrency probe (~8 in flight) over every listed repo. Each
    /// candidate already came from `listAllRepos`, so `probeStore(_:)`'s
    /// visible-by-construction overload is used — a 404 there is unambiguous
    /// ("no manifest"), so it costs exactly one request per repo, not two.
    private func probeAll(_ candidates: [GitHubRepo]) async {
        let maxConcurrent = 8
        var pending = candidates[...]

        await withTaskGroup(of: (String, GitHubClient.StoreProbe).self) { group in
            func addNext() {
                guard let repo = pending.popFirst() else { return }
                group.addTask {
                    (repo.fullName, await model.client.probeStore(repo))
                }
            }
            for _ in 0..<maxConcurrent { addNext() }
            while let (fullName, probe) = await group.next() {
                switch probe {
                case .isStore:
                    phrenStoreNames.insert(fullName)
                case .noAccess:
                    // Visible in the list, but the token can't read its
                    // contents — a scope gap, not "not a store". Counted so
                    // the footer can say so instead of dropping the repo.
                    noAccessCount += 1
                case .notStore, .error:
                    break
                }
                addNext()
            }
        }
    }

    private func openManual() async {
        let parts = manualEntry.trimmingCharacters(in: .whitespaces).split(separator: "/")
        guard parts.count == 2 else { return }
        let owner = String(parts[0])
        let name = String(parts[1])
        do {
            let repo = try await model.client.repo(owner: owner, name: name)
            onSelect(repo)
        } catch {
            // Matched on the message because GitHubError.http now carries a typed
            // status; worth switching to a typed pattern next time this is touched.
            // error context lands (in progress elsewhere) — string matching
            // on the rendered description is a stopgap.
            if error.localizedDescription.contains("404") {
                self.error = "Can't see \(owner)/\(name). GitHub returns 'not found' for private repositories your token can't read. Give the token access under Repository access on GitHub (Contents: Read and write, Metadata: Read), then try again."
            } else {
                self.error = "Couldn't open \(manualEntry): \(error.localizedDescription)"
            }
        }
    }
}

struct InitialSyncView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 16) {
            PhrenMascotView(size: 90)
            ProgressView()
                .tint(PhrenTheme.cyan)
            Text("Syncing your store…")
                .font(.headline.monospaced())
                .foregroundStyle(PhrenTheme.text)
            if let store = model.storeDescriptors.last {
                Text(store.id)
                    .font(.footnote.monospaced())
                    .foregroundStyle(PhrenTheme.lavender)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PhrenTheme.bg)
    }
}
