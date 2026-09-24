import PhrenKit
import PhrenLive
import SwiftUI

/// A close asked for from a card, answered by the list that owns the dialog.
struct SessionCloseRequest: Identifiable {
    enum Scope { case tab, workspace }
    let session: LiveAgentSession
    let scope: Scope
    var id: String { "\(session.id.hostID):\(session.workspaceID):\(scope == .tab ? session.tab.id : "*")" }
}

/// A card's hold (or its "Session actions" accessibility action) asks the
/// list that owns the surfaces for the session's actions.
struct SessionCardMenuRequest: Identifiable {
    let session: LiveAgentSession
    /// The project the card shows, which decides Link or Change.
    let project: String?
    /// The card's identifier prefix, `overview` or `live`.
    let prefix: String
    var id: String { "\(prefix):\(session.accessibilityKey)" }
}

private struct SessionCardMenuKey: EnvironmentKey {
    static let defaultValue: ((SessionCardMenuRequest) -> Void)? = nil
}

extension EnvironmentValues {
    /// Set by `SessionCloseDialogs`: opens the list's action sheet for a card.
    var sessionCardMenu: ((SessionCardMenuRequest) -> Void)? {
        get { self[SessionCardMenuKey.self] }
        set { self[SessionCardMenuKey.self] = newValue }
    }
}

/// The list's one set of session surfaces: the card actions sheet (link a
/// project, start a session in a worktree, rename the workspace, close the
/// tab or workspace), the launch sheet, the close
/// confirmation, the workspace rename editor and their error dialogs. A
/// surface per card inside a list that re-renders every second presented for
/// the wrong row, so the list owns them and cards only ask. On Herdr's
/// confirmation the card leaves at once and the computer is asked again right
/// away.
struct SessionCloseDialogs: ViewModifier {
    @Binding var request: SessionCloseRequest?
    @Binding var error: String?
    let monitor: (LiveAgentSession) -> LiveHostMonitor?
    @Environment(\.liveSessionPreferences) private var livePreferences
    @Environment(AppModel.self) private var model
    @State private var menu: SessionCardMenuRequest?
    @State private var launchingWorktree: WorktreeLaunchRequest?
    @State private var assigning: SessionCardMenuRequest?
    @State private var renaming: SessionCardMenuRequest?
    @State private var renameError: String?

    /// Close on the computer, then take the card out of the list at once and
    /// ask that computer again so the truth replaces the guess.
    static func perform(_ what: SessionCloseRequest, monitor: LiveHostMonitor?, failed: @escaping (String) -> Void) {
        let session = what.session, tab = what.scope == .tab ? session.tab.id : nil
        Task { @MainActor in
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AppModel.isUITesting {
                    for id in tab.map({ [$0] }) ?? ["w1:t1", "w1:t2"] { UITestFixtures.closedTabs.insert("\(session.host.id):\(id)") }
                } else {
                    try await PhrenConnection.herdrAction(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), operation: .close,
                                                         workspaceID: session.workspaceID, tabID: tab)
                }
                #else
                try await PhrenConnection.herdrAction(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), operation: .close,
                                                     workspaceID: session.workspaceID, tabID: tab)
                #endif
                withAnimation { monitor?.closed(workspace: session.workspaceID, tab: tab) }
            } catch let failure { failed(failure.localizedDescription) }
        }
    }

    func body(content: Content) -> some View {
        content
            .environment(\.sessionCardMenu) { menu = $0 }
            .phrenActionSheet(isPresented: $menu.isPresent(), title: menu?.session.tab.displayTitle ?? "Session",
                              actions: menuActions, identifier: "\(menu?.prefix ?? "session")-session-actions")
            .phrenDialog(isPresented: $request.isPresent(),
                         title: request?.scope == .workspace ? "Close the whole workspace?" : "Close this tab?",
                         message: closeMessage, actions: closeActions, identifier: "session-close-dialog")
            .phrenDialog(isPresented: $error.isPresent(), title: "Couldn't close", message: error ?? "",
                         actions: [.init(id: "ok", title: "OK", role: .cancel) { error = nil }],
                         identifier: "session-close-error-dialog")
            .phrenDialog(isPresented: $renameError.isPresent(), title: "Couldn't rename", message: renameError ?? "",
                         actions: [.init(id: "ok", title: "OK", role: .cancel) { renameError = nil }],
                         identifier: "session-rename-error-dialog")
            .sheet(item: $assigning) { what in
                NavigationStack {
                    LiveProjectPicker(hostID: what.session.host.id, cwd: what.session.tab.cwd ?? "",
                                      existing: livePreferences.preferences?.mapping(hostID: what.session.host.id,
                                                                                     cwd: what.session.tab.cwd))
                }
            }
            .sheet(item: $renaming) { what in
                SessionWorkspaceRenameEditor(session: what.session, prefix: what.prefix) { renameError = $0 }
            }
            .sheet(item: $launchingWorktree) { LaunchSessionView(worktree: $0) }
    }

    private var menuActions: [PhrenActionSheet.Action] {
        guard let what = menu else { return [] }
        let session = what.session
        var actions: [PhrenActionSheet.Action] = []
        // The folder decides the name on the row. Linking overrides the
        // automatic match (or fixes a wrong one); renaming changes Herdr's
        // workspace label, which the row shows when there is no folder.
        if session.tab.cwd != nil {
            actions.append(.init(id: "link", title: what.project == nil ? "Link to project" : "Change project",
                                 icon: "link") { assigning = what })
        }
        // Only where the folder resolves to a project, the way the chat's own
        // options offer it.
        if let project = livePreferences.preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd,
                                                                    projects: model.sessionProjects)?.project,
           let launch = WorktreeLaunchRequest(session: session, project: project) {
            actions.append(.init(id: "worktree", title: "New session in a worktree", icon: "arrow.branch") {
                launchingWorktree = launch
            })
        }
        actions.append(.init(id: "rename", title: "Rename workspace", icon: "pencil") { renaming = what })
        actions.append(.init(id: "close-tab", title: "Close tab", icon: "xmark", role: .destructive) {
            request = .init(session: session, scope: .tab)
        })
        actions.append(.init(id: "close-workspace", title: "Close workspace \u{201C}\(session.workspaceName)\u{201D}",
                             icon: "xmark.square", role: .destructive) {
            request = .init(session: session, scope: .workspace)
        })
        return actions
    }

    private var closeMessage: String {
        guard let what = request else { return "" }
        return what.scope == .workspace
            ? "Every tab in \u{201C}\(what.session.workspaceName)\u{201D} on \(what.session.host.name) closes; running agents in them stop."
            : "\u{201C}\(what.session.tab.displayTitle)\u{201D} on \(what.session.host.name) closes; an agent running in it stops."
    }

    private var closeActions: [PhrenDialog.Action] {
        guard let what = request else { return [.init(id: "keep", title: "Keep", role: .cancel) {}] }
        return [
            .init(id: "close", title: what.scope == .workspace ? "Close workspace" : "Close tab", role: .destructive) {
                Self.perform(what, monitor: monitor(what.session)) { error = $0 }
            },
            .init(id: "keep", title: what.scope == .workspace ? "Keep workspace" : "Keep tab", role: .cancel) {},
        ]
    }
}

/// Renames a Herdr workspace: a labelled field with explicit Cancel and
/// Rename, in place of a text-entry alert. It starts with the current name.
private struct SessionWorkspaceRenameEditor: View {
    let session: LiveAgentSession
    let prefix: String
    let failed: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label: String

    init(session: LiveAgentSession, prefix: String, failed: @escaping (String) -> Void) {
        self.session = session
        self.prefix = prefix
        self.failed = failed
        _label = State(initialValue: session.workspaceName)
    }

    private var trimmed: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            PhrenScreen {
                PhrenGroup("Workspace name", identifier: "\(prefix)-rename-caption") {
                    PhrenTextField("Workspace name", text: $label, identifier: "\(prefix)-rename-field")
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.done).onSubmit(rename)
                    Text("Changes the workspace label in Herdr on \(session.host.name).")
                        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                }
            }
            .navigationTitle("Rename workspace").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.phrenIdentifier("\(prefix)-rename-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Rename", action: rename)
                        .disabled(trimmed.isEmpty || trimmed == session.workspaceName)
                        .phrenIdentifier("\(prefix)-rename-confirm")
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func rename() {
        let label = trimmed
        guard !label.isEmpty, label != session.workspaceName else { return }
        dismiss()
        let session = session, failed = failed
        Task {
            do { try await PhrenConnection.herdrAction(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), operation: .rename, workspaceID: session.workspaceID, label: label) }
            catch { failed(error.localizedDescription) }
        }
    }
}
