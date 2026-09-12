import PhrenKit
import PhrenLive
import SwiftTerm
import SwiftUI

@Observable @MainActor
private final class HerdrTerminalModel: NSObject, @preconcurrency TerminalViewDelegate {
    let terminal = TouchTerminalView(frame: .zero, font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                options: TerminalOptions(cols: 80, rows: 24, scrollback: 2_000))
    var connected = false
    var reconnecting = false
    var error: String?
    var control = false
    #if DEBUG && targetEnvironment(simulator)
    var fixtureReport = ""
    private var fixtureInput = ""
    private var fixtureLinks: [String] = []
    private var fixtureSwitchOpen = false
    private var fixtureSwitchPressed = false
    private var fixtureMouseInput = ""
    #endif
    private var commandMenuOpened = false
    private var socket: HerdrTerminalSocket?
    private var writes: Task<Void, Never>?
    private var generation = UUID()
    private var connectionID = UUID()
    override init() {
        super.init()
        terminal.terminalDelegate = self
        terminal.configureTouchInput()
        let defaults = AppRuntime.defaults
        // Gesture fixtures always begin at a known size; production restores
        // the user's choice across terminals and app launches.
        let savedSize = AppModel.isUITesting ? 12 : defaults.double(forKey: "terminal.textSize.v1")
        terminal.setTextSize(savedSize > 0 ? savedSize : 12)
        terminal.onTextSizeChanged = { defaults.set(Double($0), forKey: "terminal.textSize.v1") }
        applyAppearance()
        terminal.accessibilityIdentifier = "herdr-terminal"
    }
    func applyAppearance() {
        terminal.nativeBackgroundColor = UIColor(PhrenTheme.bgSunken)
        terminal.nativeForegroundColor = UIColor(PhrenTheme.text)
        terminal.caretColor = UIColor(PhrenTheme.cyan)
        terminal.selectedTextBackgroundColor = UIColor(PhrenTheme.lavender.opacity(0.30))
        terminal.selectedTextForegroundColor = UIColor(PhrenTheme.text)
        terminal.selectionHandleColor = UIColor(PhrenTheme.lavender)
    }
    func run(host: LiveHost, session: LiveAgentSession?, target: AgentChatTarget?, paneID: String?, commandMenu: Bool = false) async {
        let run = UUID(); generation = run
        connected = false; reconnecting = false; error = nil
        defer {
            if generation == run { connected = false; reconnecting = false; self.socket = nil; writes?.cancel(); _ = terminal.resignFirstResponder() }
        }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                try await Task.sleep(for: .milliseconds(200))
                fixtureInput = ""
                fixtureLinks = []
                fixtureSwitchOpen = false
                fixtureSwitchPressed = false
                fixtureMouseInput = ""
                let args = ProcessInfo.processInfo.arguments
                if args.contains("--terminal-controls-fixture") {
                    terminal.feed(text: "\u{1B}[?1049h\u{1B}[?1002h\u{1B}[?1006h")
                    renderControlsFixture()
                } else if args.contains("--terminal-links-fixture") {
                    terminal.feed(text: "\u{1B}[2J\u{1B}[H\u{1B}]8;;https://example.com/explicit\u{1B}\\Open website\u{1B}]8;;\u{1B}\\\r\nhttps://example.com/plain\r\n$ ")
                } else if args.contains("--terminal-mouse-fixture") {
                    terminal.feed(text: "\u{1B}[?1049h\u{1B}[?1002h\u{1B}[?1006h")
                    terminal.feed(text: (1...18).map { "Selectable terminal text · line \($0)" }.joined(separator: "\r\n"))
                } else if args.contains("--terminal-scrollback-fixture") {
                    terminal.feed(text: (1...100).map { "Scrollback history · line \($0)" }.joined(separator: "\r\n"))
                } else {
                    terminal.feed(text: "\u{1B}[2J\u{1B}[HPhren · Herdr\r\nFixture workspace · pane 1\r\n$ ")
                }
                terminal.feed(text: "\u{1B}[2 q") // Steady cursor keeps UI automation idle.
                connected = true
                if commandMenu && !commandMenuOpened { commandMenuOpened = true; input("/") }
                while !Task.isCancelled {
                    let report: [String: Any] = ["input": fixtureInput,
                        "selected": terminal.selection.getSelectedText(),
                        "topRow": terminal.getTerminal().getTopVisibleRow(),
                        "copyActions": terminal.copyActions,
                        "links": fixtureLinks, "switchOpen": fixtureSwitchOpen,
                        "fontSize": terminal.font.pointSize, "columns": terminal.getTerminal().cols,
                        "rows": terminal.getTerminal().rows,
                        "cellWidth": terminal.getOptimalFrameSize().width / CGFloat(terminal.getTerminal().cols),
                        "cellHeight": terminal.getOptimalFrameSize().height / CGFloat(terminal.getTerminal().rows)]
                    let updated = String(decoding: try JSONSerialization.data(withJSONObject: report, options: .sortedKeys), as: UTF8.self)
                    if fixtureReport != updated { fixtureReport = updated }
                    try await Task.sleep(for: .milliseconds(100))
                }
                return
            }
            #endif
            let key = try DeviceSSHKey.load(host.id)
            var canOpenCommands = false
            if let target {
                guard target.hostID == host.id, target.muxID == host.muxID else { throw PhrenKitError.validation("Reopen this terminal from the current computer.") }
                let pane = try await PhrenConnection.chatPanes(host: host, privateKey: key, workspaceID: target.workspaceID, tabID: target.tabID).validate(target)
                canOpenCommands = ["idle", "done"].contains(pane.agentStatus ?? "")
                try await PhrenConnection.herdrAction(host: host, privateKey: key, operation: .focus,
                                                     workspaceID: target.workspaceID, tabID: target.tabID, paneID: target.paneID)
            } else if let session {
                guard session.host == host else { throw PhrenKitError.validation("The Herdr server changed.") }
                let fresh = try await PhrenConnection.fetch(host: host, privateKey: key)
                guard fresh.sessions(on: host).contains(where: { $0.id == session.id }) else { throw PhrenKitError.validation("This Herdr tab has closed.") }
                if let paneID {
                    let list = try await PhrenConnection.chatPanes(host: host, privateKey: key, workspaceID: session.workspaceID, tabID: session.tab.id)
                    guard list.panes.contains(where: { $0.id == paneID }) else { throw PhrenKitError.validation("This pane has closed.") }
                }
                try await PhrenConnection.herdrAction(host: host, privateKey: key, operation: .focus, workspaceID: session.workspaceID, tabID: session.tab.id, paneID: paneID)
            }
            var recovery = HerdrTerminalRecovery()
            var receivedBefore = false
            while !Task.isCancelled {
                let socket = HerdrTerminalSocket(); self.socket = socket
                connectionID = UUID()
                var first = true
                do {
                    for try await bytes in PhrenConnection.herdrTerminal(host: host, privateKey: key, socket: socket,
                                                                       columns: terminal.getTerminal().cols, rows: terminal.getTerminal().rows) {
                        try Task.checkCancellation()
                        guard generation == run else { return }
                        if first {
                            if receivedBefore { terminal.getTerminal().resetToInitialState() }
                            first = false; receivedBefore = true
                            recovery.connected(at: ProcessInfo.processInfo.systemUptime)
                        }
                        terminal.feed(byteArray: ArraySlice(bytes)); connected = true; reconnecting = false
                        if commandMenu && !commandMenuOpened {
                            commandMenuOpened = true
                            if canOpenCommands { try await socket.input("/") }
                        }
                        try await socket.acknowledge(bytes.count)
                        // Yield the main actor and coalesce network bursts into
                        // the next bounded batch, rather than repaint per packet.
                        try await Task.sleep(for: .milliseconds(16))
                    }
                    throw LiveConnectionError.disconnected
                } catch {
                    guard !Task.isCancelled, generation == run else { return }
                    connected = false; writes?.cancel(); writes = nil; self.socket = nil
                    guard let delay = recovery.delay(after: error, now: ProcessInfo.processInfo.systemUptime) else { throw error }
                    reconnecting = true
                    try await Task.sleep(for: .seconds(delay))
                    // Reattach the same server without refocusing a stale tab
                    // or replaying any keyboard input from the lost connection.
                }
            }
        } catch {
            if !Task.isCancelled, generation == run { self.error = error.localizedDescription }
        }
    }
    func input(_ text: String) {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            if connected {
                fixtureInput += text
                if ProcessInfo.processInfo.arguments.contains("--terminal-controls-fixture") { handleControlsFixture(text) }
            }
            return
        }
        #endif
        guard connected, let socket else { return }
        let previous = writes, run = generation, connection = connectionID
        writes = Task {
            await previous?.value
            guard !Task.isCancelled, connected, generation == run, connectionID == connection else { return }
            do { try await socket.input(text) }
            catch {
                guard generation == run, connectionID == connection, !Task.isCancelled else { return }
                connected = false; self.error = "Input wasn't confirmed. Check the terminal before typing it again."
            }
        }
    }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            if ProcessInfo.processInfo.arguments.contains("--terminal-controls-fixture") { renderControlsFixture() }
            return
        }
        #endif
        guard connected, let socket else { return }
        Task { try? await socket.resize(columns: newCols, rows: newRows) }
    }
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        input(String(decoding: data, as: UTF8.self))
        Task { @MainActor [weak self] in self?.control = source.controlModifier }
    }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { fixtureLinks.append(link); return }
        #endif
        if let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { UIApplication.shared.open(url) }
    }

    #if DEBUG && targetEnvironment(simulator)
    private func renderControlsFixture() {
        let column = max(1, terminal.getTerminal().cols - 7)
        let sidebar = terminal.getTerminal().cols >= 100 ? "Sidebar visible" : "Narrow layout"
        terminal.feed(text: "\u{1B}[2J\u{1B}[HPhren\u{1B}[1;\(column)H switch\u{1B}[3;1H\(fixtureSwitchOpen ? "Workspaces: phren, demo" : "Workspace: phren")\u{1B}[5;1H\u{1B}]8;;https://example.com/herdr\u{1B}\\Open website\u{1B}]8;;\u{1B}\\\u{1B}[7;1H\(sidebar)\u{1B}[2 q")
    }

    private func handleControlsFixture(_ text: String) {
        // Require a complete left press/release at the rendered Switch cells.
        // Merely emitting some mouse bytes is not a successful control tap.
        fixtureMouseInput += text
        let expression = try! NSRegularExpression(pattern: "\u{1B}\\[<([0-9]+);([0-9]+);([0-9]+)([Mm])")
        let matches = expression.matches(in: fixtureMouseInput, range: NSRange(fixtureMouseInput.startIndex..., in: fixtureMouseInput))
        for match in matches {
            let value = fixtureMouseInput as NSString
            let button = value.substring(with: match.range(at: 1))
            let column = Int(value.substring(with: match.range(at: 2))) ?? 0
            let row = Int(value.substring(with: match.range(at: 3))) ?? 0
            let isPress = value.substring(with: match.range(at: 4)) == "M"
            let onSwitch = button == "0" && row == 1 && column >= terminal.getTerminal().cols - 6
            if isPress { fixtureSwitchPressed = onSwitch }
            else {
                if fixtureSwitchPressed && onSwitch { fixtureSwitchOpen.toggle(); renderControlsFixture() }
                fixtureSwitchPressed = false
            }
        }
        if let last = matches.last { fixtureMouseInput = (fixtureMouseInput as NSString).substring(from: NSMaxRange(last.range)) }
    }
    #endif
    func clipboardCopy(source: TerminalView, content: Data) {}
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    func bell(source: TerminalView) {}
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
}

private struct HerdrTerminalSurface: UIViewRepresentable {
    let model: HerdrTerminalModel
    func makeUIView(context: Context) -> TerminalView { model.terminal }
    func updateUIView(_ view: TerminalView, context: Context) { view.isUserInteractionEnabled = model.connected }
}

struct HerdrTerminalView: View {
    let host: LiveHost
    var session: LiveAgentSession? = nil
    var target: AgentChatTarget? = nil
    var paneID: String? = nil
    var commandMenu = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var model = HerdrTerminalModel()
    @State private var visible = false
    @State private var shortcuts = false
    @State private var reconnect = UUID()
    @State private var uploadRequest: TerminalUploadRequest?
    private var currentHost: LiveHost? { (try? LiveSessionPreferences.read(hostData))?.hosts.first { $0.id == host.id } }
    private var active: Bool { visible && scenePhase == .active && currentHost == host }
    var body: some View {
        VStack(spacing: 0) {
            header
            if let error = model.error {
                Label(error, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(PhrenTheme.warning).padding(.horizontal, 12).padding(.bottom, 8)
            }
            if currentHost != host { Text("Connection settings changed. Reopen Herdr from the computer list.").font(.footnote).padding() }
            HerdrTerminalSurface(model: model).padding(.horizontal, 4)
            TerminalControls(terminal: model.terminal, hostID: host.id,
                             source: target?.source ?? session?.tab.agent ?? "", enabled: model.connected && active, control: $model.control,
                             shortcuts: $shortcuts, send: model.input,
                             attach: { uploadRequest = TerminalUploadRequest(attachments: $0) })
                .padding(.bottom, 6)
        }
        #if DEBUG && targetEnvironment(simulator)
        .overlay(alignment: .topLeading) {
            if AgentChatFixture.enabled {
                Text(model.fixtureReport).font(.system(size: 1)).frame(width: 1, height: 1)
                    .accessibilityIdentifier("terminal-fixture-report")
            }
        }
        #endif
        .background(PhrenTheme.bgSunken)
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: PhrenAppearance.shared.palette) { _, _ in model.applyAppearance() }
        .toolbar(.hidden, for: .tabBar)
        .sheet(item: $uploadRequest) { request in
            TerminalUploadFlow(host: host, attachments: request.attachments)
        }
        .onAppear {
            visible = true
            model.terminal.onShortcutGesture = { shortcuts = true }
        }.onDisappear {
            visible = false
            shortcuts = false
            model.terminal.onShortcutGesture = nil
        }
        .task(id: Run(active: active, reconnect: reconnect)) {
            if active { await model.run(host: host, session: session, target: target, paneID: paneID, commandMenu: commandMenu) }
        }
    }
    private var header: some View {
        HStack(spacing: 8) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Back")
            .accessibilityIdentifier("herdr-terminal-back")
            Circle().fill(model.connected && active ? PhrenTheme.accent : PhrenTheme.textDim)
                .frame(width: 6, height: 6)
                .accessibilityLabel(model.connected && active ? "Connected" : "Disconnected")
            VStack(alignment: .leading, spacing: 1) {
                Text(host.name).font(.subheadline.weight(.medium)).lineLimit(1)
                if let name = host.herdrSession, name != "default" {
                    Text(name).font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if model.reconnecting {
                Text("Reconnecting…").font(.caption2).foregroundStyle(PhrenTheme.warning).lineLimit(1)
            } else if !model.connected && model.error == nil && active {
                ProgressView().controlSize(.small)
            }
            Button { reconnect = UUID() } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 18))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Reconnect")
            .disabled(!active)
        }
        .foregroundStyle(PhrenTheme.text)
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("herdr-terminal-header")
    }

    private struct Run: Equatable { let active: Bool; let reconnect: UUID }
}
