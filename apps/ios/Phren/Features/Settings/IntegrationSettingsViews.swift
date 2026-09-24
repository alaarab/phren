import UserNotifications
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
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var platform = "macOS"
    @State private var copied = false
    private var hosts: [LiveHost] { preferencesStore.preferences?.hosts ?? [] }
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
/// How a notification shows while phren is open, and where a tap on one goes.
enum NotificationPreferences {
    static let whileOpenKey = "notifications.whileOpen.v1"
    static let tapOpensKey = "notifications.tapOpens.v1"
    enum WhileOpen: String, CaseIterable { case alert, quiet, off }
    enum TapOpens: String, CaseIterable { case chat, agents }

    static func whileOpen(in defaults: UserDefaults = AppRuntime.defaults) -> WhileOpen {
        defaults.string(forKey: whileOpenKey).flatMap(WhileOpen.init(rawValue:)) ?? .alert
    }
    static func tapOpens(in defaults: UserDefaults = AppRuntime.defaults) -> TapOpens {
        defaults.string(forKey: tapOpensKey).flatMap(TapOpens.init(rawValue:)) ?? .chat
    }
    /// Alert: banner and sound. Quiet: only in Notification Center. Off: nothing.
    static func presentation(_ value: WhileOpen) -> UNNotificationPresentationOptions {
        switch value {
        case .alert: [.banner, .list, .sound]
        case .quiet: [.list]
        case .off: []
        }
    }
}

struct NotificationSettingsView: View {
    @AppStorage(IntegrationSettings.liveActivityKey) private var liveActivity = true
    @AppStorage(IntegrationSettings.agentsKeepScreenOnKey) private var keepScreenOn = false
    @AppStorage(LocalNotificationSettings.approvalsKey) private var approvals = true
    @AppStorage(LocalNotificationSettings.schedulesKey) private var schedules = true
    @AppStorage(NotificationPreferences.whileOpenKey) private var whileOpen = NotificationPreferences.WhileOpen.alert.rawValue
    @AppStorage(NotificationPreferences.tapOpensKey) private var tapOpens = NotificationPreferences.TapOpens.chat.rawValue
    @State private var denied = false
    @State private var choosingOpen = false
    @State private var choosingTap = false
    @State private var testSent = false
    @Environment(\.liveSessionPreferences) private var preferencesStore
    /// Connected computers whose Hook reports push `configured: false`.
    @State private var pushMissing: [String] = []

    private let openOptions = [
        PhrenOption(id: "alert", value: "alert", title: "Alert", caption: "A banner with sound."),
        PhrenOption(id: "quiet", value: "quiet", title: "Quiet", caption: "Into Notification Center, no banner or sound."),
        PhrenOption(id: "off", value: "off", title: "Off", caption: "Nothing while you're in phren."),
    ]
    private let tapOptions = [
        PhrenOption(id: "chat", value: "chat", title: "The session's chat"),
        PhrenOption(id: "agents", value: "agents", title: "Agents"),
    ]
    private var enabled: Bool { approvals || schedules }
    /// One line for what happens where: "Open: Alert · Closed: Live Activity · Tap: Chat".
    private var summary: String {
        let open = openOptions.first { $0.value == whileOpen }?.title ?? "Alert"
        let closed = [approvals || schedules ? "Alerts" : nil, liveActivity ? "Live Activity" : nil].compactMap { $0 }
        return "Open: \(open) · Closed: \(closed.isEmpty ? "Off" : closed.joined(separator: " + ")) · Tap: \(tapOpens == "agents" ? "Agents" : "Chat")"
    }

    var body: some View {
        PhrenScreen {
            VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                Text(summary).font(PhrenTypography.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text)
                    .phrenIdentifier("notifications-summary")
                if denied {
                    Text("Notifications are off in iOS. Allow them in Settings to receive these alerts.")
                        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.warning)
                        .phrenIdentifier("notifications-permission-denied")
                }
            }
            PhrenGroup("While phren is open") {
                PhrenSingleSelect(options: openOptions, selection: $whileOpen, placeholder: "Alerts",
                                  identifier: "notifications-while-open", isPresented: $choosingOpen)
            }
            PhrenGroup("While phren is closed") {
                PhrenSwitch("Approvals", systemImage: "hand.raised", isOn: $approvals)
                    .phrenIdentifier("notifications-approvals")
                PhrenSwitch("Scheduled prompts", systemImage: "clock", isOn: $schedules)
                    .phrenIdentifier("notifications-schedules")
                PhrenSwitch("Live Activity", systemImage: "waveform.path.ecg", isOn: $liveActivity)
                    .phrenIdentifier("notifications-live-activity")
                // One line on whether alerts can reach a closed phren at once.
                Text(pushMissing.isEmpty
                     ? "Approvals reach a closed phren within minutes; the Live Activity shows them on the Lock Screen and Dynamic Island."
                     : "Instant alerts need an APNs key on \(ListFormatter.localizedString(byJoining: pushMissing)); until then they can arrive late.")
                    .font(PhrenTypography.caption)
                    .foregroundStyle(pushMissing.isEmpty ? PhrenTheme.textMuted : PhrenTheme.warning)
                    .phrenIdentifier(pushMissing.isEmpty ? "notifications-closed-note" : "notifications-push-unconfigured")
            }
            .phrenContainerMarker("notifications-local-section", label: "While phren is closed")
            PhrenGroup("When I tap a notification") {
                PhrenSingleSelect(options: tapOptions, selection: $tapOpens, placeholder: "Opens",
                                  identifier: "notifications-tap-opens", isPresented: $choosingTap)
            }
            VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                Button { sendTest() } label: {
                    Label(testSent ? "Sent. It arrives in a few seconds." : "Send a test notification", systemImage: "paperplane")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(PhrenTheme.accent)
                .disabled(!enabled)
                .phrenIdentifier("notifications-send-test")
            }
            PhrenGroup("Agents") {
                PhrenSwitch("Keep screen on", systemImage: "sun.max", isOn: $keepScreenOn)
                    .phrenIdentifier("notifications-keep-screen-on")
            }
        }
        .navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
        .phrenSingleSelectSheet(isPresented: $choosingOpen, title: "While phren is open", options: openOptions,
                                selection: $whileOpen, rowPrefix: "notifications-while-open")
        .phrenSingleSelectSheet(isPresented: $choosingTap, title: "When I tap a notification", options: tapOptions,
                                selection: $tapOpens, rowPrefix: "notifications-tap-opens")
        .task {
            if approvals || schedules { denied = !(await LocalNotificationMonitor.shared.requestAuthorization()) }
        }
        .task(id: preferencesStore.data) { pushMissing = await PushSetupCheck.unconfigured(preferencesStore.data) }
        .onChange(of: approvals) { _, value in changed(enabling: value) }
        .onChange(of: schedules) { _, value in changed(enabling: value) }
    }

    private func changed(enabling: Bool) {
        Task {
            if enabling { denied = !(await LocalNotificationMonitor.shared.requestAuthorization()) }
            await LocalNotificationMonitor.shared.settingsChanged()
        }
    }

    /// A local notification in three seconds, shown as the choices above say.
    private func sendTest() {
        Task {
            guard await LocalNotificationMonitor.shared.requestAuthorization() else { denied = true; return }
            let content = UNMutableNotificationContent()
            content.title = "phren"
            content.body = "Test notification. This is how an approval or a finished schedule arrives."
            content.sound = .default
            let request = UNNotificationRequest(identifier: "phren-test-\(UUID().uuidString)", content: content,
                                                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false))
            try? await UNUserNotificationCenter.current().add(request)
            testSent = true
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
