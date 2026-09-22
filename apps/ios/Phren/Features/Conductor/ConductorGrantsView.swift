import PhrenKit
import PhrenLive
import SwiftUI

/// Standing conductor grants the Hook stores in `conductor.yaml`: one row per
/// grant with its scope, actions, computers and expiry, plus add and revoke.
struct ConductorGrantsView: View {
    let host: LiveHost
    let storeId: String?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var grants: [ConductorGrant] = []
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var showingAdd = false
    @State private var revokeIndex: Int?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            if errorMessage != nil {
                PhrenNoticeBanner(title: "Grants", message: errorMessage ?? "", identifier: "conductor-grants-error") {
                    self.errorMessage = nil
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            PhrenScrollScreen {
                if loading && grants.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
                        .accessibilityIdentifier("conductor-grants-loading")
                } else if grants.isEmpty {
                    Text("No standing grants. A grant lets this conductor dispatch or hand off without asking each time.")
                        .font(PhrenTypography.subheadline)
                        .foregroundStyle(PhrenTheme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                        .accessibilityIdentifier("conductor-grants-empty")
                } else {
                    ForEach(grants.indices, id: \.self) { index in
                        grantRow(grants[index], index: index)
                    }
                }
                addButton
            }
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Grants")
        .navigationBarTitleDisplayMode(.inline)
        .phrenContainerMarker("conductor-grants", label: "Grants")
        .task { await load() }
        .sheet(isPresented: $showingAdd) {
            ConductorGrantEditorView(host: host, storeId: storeId) { grant in
                await add(grant)
            }
        }
        .phrenDialog(
            isPresented: Binding(get: { revokeIndex != nil }, set: { if !$0 { revokeIndex = nil } }),
            title: "Revoke this grant?",
            message: "The conductor will ask again the next time it covers this call.",
            actions: [
                PhrenControlAction(id: "keep", title: "Keep", role: .cancel, handler: {}),
                PhrenControlAction(id: "revoke", title: "Revoke", role: .destructive) {
                    if let index = revokeIndex { Task { await revoke(index) } }
                },
            ],
            identifier: "conductor-grant-revoke")
    }

    private func grantRow(_ grant: ConductorGrant, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(grant.scopeTitle)
                    .font(PhrenTypography.subheadline.weight(.semibold))
                    .foregroundStyle(PhrenTheme.text)
                Spacer(minLength: 0)
                Button {
                    revokeIndex = index
                } label: {
                    Text("Revoke")
                        .font(PhrenTypography.caption.weight(.medium))
                        .foregroundStyle(PhrenTheme.danger)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("conductor-grant-revoke:\(index)")
            }
            HStack(spacing: 6) {
                ForEach(grant.actions, id: \.self) { action in
                    PhrenChip(text: grant.actionTitle(action), role: .type)
                }
                PhrenChip(text: grant.computers?.joined(separator: ", ") ?? "Any computer", role: .host)
            }
            Text(grant.expiresAt.map { "Until " + $0.formatted(date: .abbreviated, time: .shortened) } ?? "Until revoked")
                .font(PhrenTypography.caption)
                .foregroundStyle(PhrenTheme.textMuted)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .sessionCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conductor-grant:\(index)")
    }

    private var addButton: some View {
        Button {
            showingAdd = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus.circle").font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(PhrenTheme.accent).frame(width: 22)
                Text("Add grant").font(PhrenTypography.body)
                Spacer(minLength: 0)
            }
            .foregroundStyle(PhrenTheme.text)
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy || grants.count >= 64)
        .opacity(busy || grants.count >= 64 ? 0.45 : 1)
        .accessibilityIdentifier("conductor-grant-add")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.grantsEnabled {
                grants = AgentChatFixture.fixtureGrants
                return
            }
            #endif
            let key = try DeviceSSHKey.load(host.id)
            grants = try await PhrenConnection.conductorGrants(host: host, privateKey: key)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func add(_ grant: ConductorGrant) async {
        busy = true
        defer { busy = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.grantsEnabled {
                grants.append(grant)
                showingAdd = false
                return
            }
            #endif
            let key = try DeviceSSHKey.load(host.id)
            _ = try await PhrenConnection.addConductorGrant(host: host, privateKey: key, grant: grant)
            errorMessage = nil
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revoke(_ index: Int) async {
        guard grants.indices.contains(index) else { return }
        busy = true
        defer { busy = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.grantsEnabled {
                grants.remove(at: index)
                return
            }
            #endif
            let key = try DeviceSSHKey.load(host.id)
            try await PhrenConnection.removeConductorGrant(host: host, privateKey: key, index: index)
            errorMessage = nil
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// The add-grant editor: scope, actions, optional computers and expiry, saved
/// through `PhrenSheetHeader` with `conductor-grant-add` id prefixes.
private struct ConductorGrantEditorView: View {
    let host: LiveHost
    let storeId: String?
    let save: (ConductorGrant) async -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var scope = "global"
    @State private var actions: Set<ConductorGrant.Action> = [.dispatch]
    @State private var computers: Set<String> = []
    @State private var hasUntil = false
    @State private var until = Calendar.current.date(byAdding: .day, value: 7, to: .now) ?? .now
    @State private var validUntil = true
    @State private var showScope = false
    @State private var showComputers = false
    @State private var saving = false

    private var snapshot: LocalStore.Snapshot { model.snapshot(for: storeId ?? "") }
    private var projects: [String] { snapshot.projects.map(\.name).sorted() }
    private var computerNames: [String] {
        Set(snapshot.machines.machines.keys.sorted()).sorted()
    }

    private var scopeOptions: [PhrenOption<String>] {
        var options = [PhrenOption(id: "global", value: "global", title: "Everywhere")]
        options += projects.map { PhrenOption(id: "project:\($0)", value: "project:\($0)", title: $0) }
        return options
    }
    private var actionOptions: [PhrenOption<ConductorGrant.Action>] {
        ConductorGrant.Action.allCases.map { action in
            PhrenOption(id: action.rawValue, value: action, title: action == .handOff ? "Hand off" : "Dispatch")
        }
    }
    private var computerOptions: [PhrenOption<String>] {
        computerNames.map { PhrenOption(id: $0, value: $0, title: $0) }
    }

    private var canSave: Bool {
        !saving && !actions.isEmpty && actions.count <= 2 && (hasUntil ? validUntil : true)
    }

    var body: some View {
        VStack(spacing: 0) {
            PhrenSheetHeader(title: "Add grant", trailingTitle: "Save", canSave: canSave,
                             identifierPrefix: "conductor-grant-add",
                             cancel: { dismiss() }, save: { Task { await commit() } })
            PhrenScreen {
                PhrenGroup("Scope", identifier: "conductor-grant-group:scope") {
                    PhrenSingleSelect(options: scopeOptions, selection: $scope,
                                      placeholder: "Everywhere", identifier: "conductor-grant-scope",
                                      isPresented: $showScope)
                }
                PhrenGroup("Actions", identifier: "conductor-grant-group:actions") {
                    PhrenMultiOptionGroup(options: actionOptions, selection: $actions,
                                          identifier: "conductor-grant-actions")
                }
                if !computerNames.isEmpty {
                    PhrenGroup("Computers", identifier: "conductor-grant-group:computers") {
                        PhrenMultiSelect(options: computerOptions, selection: $computers,
                                         allLabel: "Any computer", identifier: "conductor-grant-computers",
                                         isPresented: $showComputers)
                    }
                }
                PhrenGroup("Expiry", identifier: "conductor-grant-group:expiry") {
                    HStack {
                        Text("Expires").font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
                        Spacer()
                        PhrenSwitch(isOn: $hasUntil, label: "Expires")
                    }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("conductor-grant-expires")
                    if hasUntil {
                        PhrenDateField(date: $until, isValid: $validUntil)
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(PhrenTheme.bg)
        .phrenContainerMarker("conductor-grant-add-editor", label: "Add grant")
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
    }

    private func commit() async {
        guard canSave else { return }
        saving = true
        defer { saving = false }
        let actionList = ConductorGrant.Action.allCases.filter { actions.contains($0) }
        let computerList = computers.isEmpty ? nil : Array(computers).sorted()
        let untilValue = hasUntil ? (try? Date.ISO8601FormatStyle().format(until)) : nil
        do {
            let grant = try ConductorGrant(scope: scope, actions: actionList,
                                           computers: computerList, until: untilValue)
            await save(grant)
            dismiss()
        } catch {
            // The header stays disabled; surface the modelled validation text.
        }
    }
}
