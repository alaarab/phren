import PhrenKit
import PhrenLive
import SwiftUI

/// Keys behind the Integrations and Keyboard screens.
enum IntegrationSettings {
    static let liveActivityKey = "approvals.liveActivity.v1"
    static let agentsKeepScreenOnKey = "agents.keepScreenOn.v1"
    static let showWebServersKey = "home.webServers.v1"
    static let showSimulatorsKey = "home.simulators.v1"
    static let showFilesKey = "home.files.v1"
    static let optionAsMetaKey = "terminal.optionAsMeta.v1"
    static let autoHideToolbarKey = "terminal.autoHideToolbar.v1"
    static func enabled(_ key: String, default value: Bool = true) -> Bool { AppRuntime.defaults.object(forKey: key) as? Bool ?? value }
}

/// Phren Hook: how to put it on a computer, and whether each saved computer has it.
struct PhrenHookSettingsView: View {
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var platform = "macOS"
    @State private var copied = false
    private var hosts: [LiveHost] { (try? LiveSessionPreferences.read(data))?.hosts ?? [] }
    private var snippet: String {
        platform == "macOS"
            ? "npx --yes @phren/cli@\(Self.cliVersion) bridge install"
            : "# Node 20+ first (nodejs.org or your package manager)\nnpx --yes @phren/cli@\(Self.cliVersion) bridge install"
    }
    static let cliVersion = "0.2.14"

    var body: some View {
        PhrenList {
            Section {
                Text("Install Phren Hook on each computer that runs your agents. It unlocks native chat, live diffs of what commands changed, web previews, approvals and account usage.")
                    .font(.callout).foregroundStyle(PhrenTheme.textSecondary)
                PhrenTextSegment(items: [
                    PhrenOption(id: "macos", value: "macOS", title: "macOS"),
                    PhrenOption(id: "linux", value: "Linux", title: "Linux"),
                ], selection: $platform, identifier: "hook-platform")
                Text(snippet).font(.system(.caption, design: .monospaced)).textSelection(.enabled).foregroundStyle(PhrenTheme.text)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(PhrenTheme.bgSunken, in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("hook-snippet")
                Button(copied ? "Copied" : "Copy command", systemImage: copied ? "checkmark" : "doc.on.doc") { UIPasteboard.general.string = snippet; copied = true }
                    .accessibilityIdentifier("hook-copy")
                Link("Setup guide", destination: URL(string: "https://alaarab.github.io/phren/phren-hook.html")!)
            } header: { Text("Setup") } footer: {
                Text("Run it on the computer, as the user whose agents you use. Upgrade later by running the same command with a newer version; existing agents resume their hooks on restart.")
            }
            Section {
                if hosts.isEmpty { Text("No computers saved yet. Add one under Agents.").foregroundStyle(PhrenTheme.textMuted) }
                ForEach(hosts) { host in HookStatusRow(host: host) }
                NavigationLink { LiveSessionsView() } label: { Label("Computers", systemImage: "desktopcomputer") }
            } header: { Text("Hook status") } footer: {
                Text("Each row asks the computer for its Hook version over SSH. A missing Hook still allows terminals; chat and diffs need it.")
            }
        }
        .navigationTitle("Phren Hook").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}

private struct HookStatusRow: View {
    let host: LiveHost
    @State private var version: String??
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(host.name).foregroundStyle(PhrenTheme.text)
                Text(host.address).font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            Spacer()
            switch version {
            case .none: ProgressView()
            case .some(.none): Label("No Hook", systemImage: "circle").font(.caption).foregroundStyle(PhrenTheme.warning)
            case .some(.some(let v)): Label("Hook \(v)", systemImage: "circle.fill").font(.caption).foregroundStyle(PhrenTheme.success)
            }
        }
        .accessibilityIdentifier("hook-status:\(host.id.uuidString)")
        .task {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { version = .some("0.2.14-fixture"); return }
            #endif
            version = .some((try? await PhrenConnection.hookVersion(host: host, privateKey: DeviceSSHKey.load(host.id))) ?? nil)
        }
    }
}

/// Which saved computers answer that their Hook has no APNs key. A computer
/// that cannot be reached is left out: this names only a known missing key.
enum PushSetupCheck {
    static func unconfigured(_ hostsData: Data) async -> [String] {
        #if DEBUG && targetEnvironment(simulator)
        if await HookHealthFixture.enabled {
            return await HookHealthFixture.computers.filter { !$0.push.configured }.map(\.computer.name)
        }
        #endif
        let hosts = (try? LiveSessionPreferences.read(hostsData))?.hosts ?? []
        return await withTaskGroup(of: (Int, String?).self) { group in
            for (index, host) in hosts.enumerated() {
                group.addTask {
                    guard let key = try? DeviceSSHKey.load(host.id),
                          let status = try? await PhrenConnection.pushStatus(host: host, privateKey: key) else { return (index, nil) }
                    return (index, status.configured ? nil : host.name)
                }
            }
            var missing: [(Int, String)] = []
            for await case let (index, name?) in group { missing.append((index, name)) }
            return missing.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }
}

/// What the phone does with an agent's permission requests and the Agents screen.
struct NotificationSettingsView: View {
    @AppStorage(IntegrationSettings.liveActivityKey) private var liveActivity = true
    @AppStorage(IntegrationSettings.agentsKeepScreenOnKey) private var keepScreenOn = false
    @AppStorage(LocalNotificationSettings.approvalsKey) private var approvals = true
    @AppStorage(LocalNotificationSettings.schedulesKey) private var schedules = true
    @State private var denied = false
    @AppStorage("sessions.live.preferences.v1") private var hostsData = Data()
    /// Connected computers whose Hook reports push `configured: false`.
    @State private var pushMissing: [String] = []

    var body: some View {
        PhrenScreen {
            PhrenGroup("On this iPhone") {
                PhrenSwitch("Approvals", systemImage: "hand.raised", isOn: $approvals)
                    .phrenIdentifier("notifications-approvals")
                PhrenSwitch("Scheduled prompts", systemImage: "clock", isOn: $schedules)
                    .phrenIdentifier("notifications-schedules")
                Text("Approvals alert as soon as this phone sees them during its brief background window. Later, iOS may wake Phren to check again; those alerts can arrive late or be missed.")
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                Text("Schedules register the next due time ahead of time, using the computer's clock. The reminder can arrive while Phren is closed. It does not confirm a run started or finished. Open Phren to refresh later runs and remote edits.")
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                Text("Immediate remote approval alerts and schedule results while Phren is suspended need an APNs key on your Hook. Local notifications need no key and no relay server.")
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                if !pushMissing.isEmpty {
                    Text("Instant approval alerts need an APNs key on the computer. Not set up on \(ListFormatter.localizedString(byJoining: pushMissing)).")
                        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.warning)
                        .phrenIdentifier("notifications-push-unconfigured")
                }
                if denied {
                    Text("Notifications are off in iOS. Allow them in Settings to receive these alerts.")
                        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.warning)
                        .phrenIdentifier("notifications-permission-denied")
                }
            }
            .phrenContainerMarker("notifications-local-section", label: "On this iPhone")
            PhrenGroup("Live Activity") {
                PhrenSwitch("Live Activity for approvals", systemImage: "waveform.path.ecg", isOn: $liveActivity)
                    .phrenIdentifier("notifications-live-activity")
                Text("Review requests from the Lock Screen and Dynamic Island while the phone watches a session.")
                    .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            PhrenGroup("Agents") {
                PhrenSwitch("Keep screen on", systemImage: "sun.max", isOn: $keepScreenOn)
                    .phrenIdentifier("notifications-keep-screen-on")
            }
        }
        .navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
        .task {
            if approvals || schedules { denied = !(await LocalNotificationMonitor.shared.requestAuthorization()) }
        }
        .task(id: hostsData) { pushMissing = await PushSetupCheck.unconfigured(hostsData) }
        .onChange(of: approvals) { _, value in changed(enabling: value) }
        .onChange(of: schedules) { _, value in changed(enabling: value) }
    }

    private func changed(enabling: Bool) {
        Task {
            if enabling { denied = !(await LocalNotificationMonitor.shared.requestAuthorization()) }
            await LocalNotificationMonitor.shared.settingsChanged()
        }
    }
}

/// Which extra icons sit in the Agents header.
struct ShowOnAgentsSettingsView: View {
    @AppStorage(IntegrationSettings.showWebServersKey) private var webServers = true
    @AppStorage(IntegrationSettings.showSimulatorsKey) private var simulators = true
    @AppStorage(IntegrationSettings.showFilesKey) private var files = true
    var body: some View {
        PhrenList {
            Section {
                PhrenSwitch(isOn: $webServers) { Label("Web servers", systemImage: "globe") }.accessibilityIdentifier("home-web-servers")
                PhrenSwitch(isOn: $simulators) { Label("Simulators", systemImage: "iphone") }.accessibilityIdentifier("home-simulators")
                PhrenSwitch(isOn: $files) { Label("Files", systemImage: "folder") }.accessibilityIdentifier("home-files")
            } header: { Text("Agents header") } footer: { Text("Account usage and refresh are always there.") }
        }
        .navigationTitle("Show on Agents").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}

/// Hardware keyboards: the shortcuts a terminal answers to, and Option as Meta.
struct KeyboardSettingsView: View {
    @AppStorage(IntegrationSettings.optionAsMetaKey) private var optionAsMeta = true
    @AppStorage(IntegrationSettings.autoHideToolbarKey) private var autoHide = false
    private let shortcuts: [(String, String)] = [("Shortcuts panel", "⌘ K"), ("Paste", "⌘ V"), ("Open chat", "⌘ J"), ("Dictate", "⌘ ⇧ M"), ("Hide keyboard", "Esc twice")]
    var body: some View {
        PhrenList {
            Section("Hardware keyboard") {
                PhrenSwitch(isOn: $autoHide) { Label { Text("Auto-hide toolbar"); Text("While a hardware keyboard is connected").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "keyboard") } }
                    .accessibilityIdentifier("keyboard-auto-hide")
            }
            Section("Shortcuts") {
                ForEach(shortcuts, id: \.0) { name, keys in
                    HStack { Text(name); Spacer(); Text(keys).font(.system(.callout, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted) }
                }
            }
            Section {
                PhrenSwitch(isOn: $optionAsMeta) { Label("Option as Meta", systemImage: "option") }.accessibilityIdentifier("keyboard-option-meta")
            } header: { Text("Modifiers") } footer: { Text("On: Option sends Meta (Alt) to the terminal, as Emacs and many TUIs expect. Off: Option types the accented character.") }
        }
        .onChange(of: optionAsMeta) { _, _ in NotificationCenter.default.post(name: TerminalSettings.changed, object: nil) }
        .navigationTitle("Keyboard").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}
