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
                Picker("Platform", selection: $platform) { Text("macOS").tag("macOS"); Text("Linux").tag("Linux") }
                    .pickerStyle(.segmented).accessibilityIdentifier("hook-platform")
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

/// What the phone does with an agent's permission requests and the Agents screen.
struct NotificationSettingsView: View {
    @AppStorage(IntegrationSettings.liveActivityKey) private var liveActivity = true
    @AppStorage(IntegrationSettings.agentsKeepScreenOnKey) private var keepScreenOn = false
    var body: some View {
        PhrenList {
            Section {
                Toggle(isOn: $liveActivity) { Label { Text("Live Activity for approvals"); Text("Deny or Approve from the Lock Screen and Dynamic Island").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "waveform.path.ecg") } }
                    .accessibilityIdentifier("notifications-live-activity")
            } header: { Text("Permission requests") } footer: {
                Text("Requests arrive over SSH while the app watches a session. Phren has no push server: nothing reaches this phone when the app is closed.")
            }
            Section {
                Toggle(isOn: $keepScreenOn) { Label { Text("Keep screen on"); Text("Don't sleep while the Agents screen is open").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "sun.max") } }
                    .accessibilityIdentifier("notifications-keep-screen-on")
            } header: { Text("Agents") }
        }
        .navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
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
                Toggle(isOn: $webServers) { Label("Web servers", systemImage: "globe") }.accessibilityIdentifier("home-web-servers")
                Toggle(isOn: $simulators) { Label("Simulators", systemImage: "iphone") }.accessibilityIdentifier("home-simulators")
                Toggle(isOn: $files) { Label("Files", systemImage: "folder") }.accessibilityIdentifier("home-files")
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
                Toggle(isOn: $autoHide) { Label { Text("Auto-hide toolbar"); Text("While a hardware keyboard is connected").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "keyboard") } }
                    .accessibilityIdentifier("keyboard-auto-hide")
            }
            Section("Shortcuts") {
                ForEach(shortcuts, id: \.0) { name, keys in
                    HStack { Text(name); Spacer(); Text(keys).font(.system(.callout, design: .monospaced)).foregroundStyle(PhrenTheme.textMuted) }
                }
            }
            Section {
                Toggle(isOn: $optionAsMeta) { Label("Option as Meta", systemImage: "option") }.accessibilityIdentifier("keyboard-option-meta")
            } header: { Text("Modifiers") } footer: { Text("On: Option sends Meta (Alt) to the terminal, as Emacs and many TUIs expect. Off: Option types the accented character.") }
        }
        .onChange(of: optionAsMeta) { _, _ in NotificationCenter.default.post(name: TerminalSettings.changed, object: nil) }
        .navigationTitle("Keyboard").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}
