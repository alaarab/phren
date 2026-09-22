import PhrenKit
import PhrenLive
import SwiftUI

/// "Add project": pick the computer, pick a repository on it (or paste a
/// GitHub URL for it to clone), and phren there enrolls it the way `phren
/// add` would. The store is pushed from the computer, so the phone pulls
/// and opens the new project — the same starting point as "Open on a
/// computer" for everything that already exists.
struct AddProjectView: View {
    /// Called with the new project's name once it has arrived on this phone.
    var onAdded: (String) -> Void = { _ in }
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var hostID: UUID?
    @State private var repos: [UUID: [PhrenConnection.RepoCandidate]] = [:]
    @State private var loading = false
    @State private var directory = ""
    @State private var cloneURL = ""
    @State private var mode: Mode = .existing
    @State private var adding = false
    @State private var status: String?
    @State private var error: String?
    @State private var addingHost = false

    private enum Mode: String, CaseIterable, Identifiable {
        case existing, clone
        var id: String { rawValue }
        var title: String { self == .existing ? "On the computer" : "Clone from GitHub" }
    }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }
    private var selectedHost: LiveHost? { hosts.first { $0.id == hostID } }
    private var available: [PhrenConnection.RepoCandidate] { (selectedHost.flatMap { repos[$0.id] } ?? []).filter { !$0.registered } }
    private var tracked: [PhrenConnection.RepoCandidate] { (selectedHost.flatMap { repos[$0.id] } ?? []).filter(\.registered) }
    private var canAdd: Bool {
        guard !adding, selectedHost?.fingerprint != nil else { return false }
        switch mode {
        case .existing: return directory.hasPrefix("/")
        case .clone: return cloneURL.trimmingCharacters(in: .whitespacesAndNewlines).contains("/")
        }
    }

    var body: some View {
        PhrenNavigationStack {
            PhrenList {
                Section {
                    if hosts.isEmpty {
                        Text("Phren adds projects from a computer running Phren Hook. Connect one first.")
                            .foregroundStyle(PhrenTheme.textMuted)
                        Button { addingHost = true } label: { Label("Connect a computer", systemImage: "desktopcomputer.and.arrow.down") }
                            .accessibilityIdentifier("add-project-connect")
                    }
                    ForEach(hosts) { host in
                        Button { select(host) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "desktopcomputer").foregroundStyle(PhrenTheme.textMuted)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(host.name).foregroundStyle(PhrenTheme.text)
                                    if host.fingerprint == nil {
                                        Text("finish verifying in Agents").font(.caption).foregroundStyle(PhrenTheme.warning)
                                    }
                                }
                                Spacer()
                                if host.id == hostID { Image(systemName: "checkmark").foregroundStyle(PhrenTheme.cyan) }
                            }
                        }
                        .accessibilityIdentifier("add-project-computer:\(host.id)")
                        .accessibilityAddTraits(host.id == hostID ? .isSelected : [])
                    }
                } header: { Text("Computer") }

                if let host = selectedHost {
                    Section {
                        PhrenTextSegment(items: Mode.allCases.map {
                            PhrenOption(id: $0.rawValue, value: $0, title: $0.title)
                        }, selection: $mode, identifier: "add-project-mode")
                            .listRowBackground(Color.clear)
                    }
                    switch mode {
                    case .existing:
                        Section {
                            TextField("/path/to/repository", text: $directory)
                                .font(.system(.body, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                                .accessibilityIdentifier("add-project-folder")
                            if loading && repos[host.id] == nil {
                                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Asking \(host.name) for its repositories…") }
                                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            } else if repos[host.id] != nil && available.isEmpty {
                                Text(tracked.isEmpty ? "No git checkouts found in the usual places. Type the folder, or clone one." : "Every repository \(host.name) knows is already in phren. Type another folder, or clone one.")
                                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            }
                            ForEach(available) { repo in
                                Button { directory = repo.directory } label: { repoRow(repo, selected: repo.directory == directory) }
                                    .accessibilityIdentifier("add-project-repo:\(repo.name)")
                            }
                        } header: { Text("Repository on \(host.name)") } footer: {
                            Text("Checkouts where an agent worked, saved Herdr workspaces, and the usual project folders — newest first.")
                        }
                        if !tracked.isEmpty {
                            Section {
                                ForEach(tracked) { repo in
                                    repoRow(repo, selected: false).opacity(0.6)
                                }
                            } header: { Text("Already in phren") }
                        }
                    case .clone:
                        Section {
                            TextField("https://github.com/owner/repo", text: $cloneURL)
                                .font(.system(.body, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                                .keyboardType(.URL)
                                .accessibilityIdentifier("add-project-url")
                        } header: { Text("Repository URL") } footer: {
                            Text("\(host.name) clones it into its projects folder with its own git credentials, then adds it to phren.")
                        }
                    }

                    Section {
                        Button {
                            Task { await add() }
                        } label: {
                            HStack {
                                if adding { ProgressView().tint(PhrenTheme.chatPanel).padding(.trailing, 6) }
                                Text(adding ? (status ?? "Adding…") : "Add to phren").fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent).tint(PhrenTheme.cyan).foregroundStyle(PhrenTheme.chatPanel)
                        .disabled(!canAdd)
                        .accessibilityIdentifier("add-project-submit")
                    } footer: {
                        Text("Runs phren add on \(host.name) and syncs the store, so the project shows up here and in every agent on that computer.")
                    }
                }
            }
            .listSectionSpacing(12)
            .navigationTitle("Add project").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(adding) } }
            .phrenScreen()
            .phrenDialog(
                isPresented: $error.isPresent(),
                title: "Couldn't add project",
                message: error ?? "",
                actions: [.init(id: "ok", title: "OK", role: .cancel) { error = nil }],
                identifier: "add-project-error-dialog"
            )
            .sheet(isPresented: $addingHost) { NavigationStack { LiveHostEditor() } }
            .interactiveDismissDisabled(adding)
            .task { if hostID == nil, let first = hosts.first(where: { $0.fingerprint != nil }) ?? hosts.first { select(first) } }
            .onChange(of: hosts.map(\.id)) { _, ids in
                // A computer connected from the sheet above becomes the choice.
                guard let newest = ids.last, let host = hosts.first(where: { $0.id == newest }) else { return }
                if hostID.map({ !ids.contains($0) }) ?? true { select(host) }
            }
        }
    }

    private func repoRow(_ repo: PhrenConnection.RepoCandidate, selected: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: selected ? "checkmark.circle.fill" : "folder")
                .foregroundStyle(selected ? PhrenTheme.success : PhrenTheme.chatNeutralDim)
            VStack(alignment: .leading, spacing: 1) {
                Text(repo.name).foregroundStyle(PhrenTheme.text)
                Text(repo.directory).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted)
                    .lineLimit(1).truncationMode(.head)
                Text(repo.sourceLabel).font(.caption2).foregroundStyle(PhrenTheme.textMuted)
            }
        }
    }

    private func select(_ host: LiveHost) {
        hostID = host.id
        Task { await load(host) }
    }

    private func load(_ host: LiveHost) async {
        guard host.fingerprint != nil, repos[host.id] == nil else { return }
        loading = true
        defer { loading = false }
        let found: [PhrenConnection.RepoCandidate]
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { found = (try? await AgentChatFixture.repos()) ?? [] }
        else { found = (try? await PhrenConnection.candidateRepos(host: host, privateKey: DeviceSSHKey.load(host.id))) ?? [] }
        #else
        found = (try? await PhrenConnection.candidateRepos(host: host, privateKey: DeviceSSHKey.load(host.id))) ?? []
        #endif
        repos[host.id] = found
    }

    private func add() async {
        guard let host = selectedHost, canAdd else { return }
        adding = true; error = nil
        defer { adding = false; status = nil }
        do {
            let folder = directory.trimmingCharacters(in: .whitespacesAndNewlines)
            let url = cloneURL.trimmingCharacters(in: .whitespacesAndNewlines)
            status = mode == .clone ? "Cloning on \(host.name)…" : "Adding on \(host.name)…"
            let enrolled: PhrenConnection.EnrolledProject
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                enrolled = try await AgentChatFixture.enroll(directory: mode == .existing ? folder : nil, cloneURL: mode == .clone ? url : nil)
                // The fixture computer "pushed" straight into the fixture store.
                if enrolled.pushed, let store = model.storeContexts.first?.store {
                    try await store.write("\(enrolled.project)/summary.md", content: "# \(enrolled.project)\n\nAdded from iPhone.\n", blobSha: nil)
                }
            } else { enrolled = try await PhrenConnection.enrollProject(host: host, privateKey: DeviceSSHKey.load(host.id), directory: mode == .existing ? folder : nil, cloneURL: mode == .clone ? url : nil) }
            #else
            enrolled = try await PhrenConnection.enrollProject(host: host, privateKey: DeviceSSHKey.load(host.id), directory: mode == .existing ? folder : nil, cloneURL: mode == .clone ? url : nil)
            #endif
            guard enrolled.pushed else {
                error = "\(host.name) added \(enrolled.project) to its phren store but couldn't sync it to GitHub" + (enrolled.storeDetail.map { " (\($0))" } ?? "") + ". Run phren sync there, then pull to refresh here."
                return
            }
            status = "Syncing \(enrolled.project)…"
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { await model.refresh() } else { await model.pullToRefresh() }
            #else
            await model.pullToRefresh()
            #endif
            guard let arrived = model.mergedProjects.first(where: { $0.project.name == enrolled.project }) else {
                error = "\(host.name) added \(enrolled.project) and pushed its store, but this iPhone doesn't follow that store yet. Add it under Settings, then pull to refresh."
                return
            }
            // "Open on a computer" now knows the folder without asking.
            data = (try? LiveSessionPreferences.assigning(hostID: host.id, directory: enrolled.directory, storeID: arrived.storeId, project: enrolled.project, in: data)) ?? data
            dismiss()
            onAdded(enrolled.project)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
