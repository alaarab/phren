import PhrenKit
import PhrenLive
import GameController
import SwiftTerm
import SwiftUI

@Observable @MainActor
private final class HerdrTerminalModel: NSObject, @preconcurrency TerminalViewDelegate {
    let terminal = TouchTerminalView(frame: .zero, font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                options: TerminalOptions(cols: 80, rows: 24, scrollback: 2_000))
    var connected = false
    var reconnecting = false
    var error: String?
    var pendingLink: URL?
    var control = false
    /// The pane this terminal was opened on, once the computer has confirmed
    /// it: its agent names the toolbar's Chat control.
    var pane: AgentChatPanes.Pane?
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
    private let resize = TerminalResizeCoordinator()
    private var generation = UUID()
    private var connectionID = UUID()
    override init() {
        super.init()
        terminal.terminalDelegate = self
        terminal.configureTouchInput()
        terminal.setContentHuggingPriority(.defaultLow, for: .horizontal)
        terminal.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        terminal.onBoundsChanged = { [weak self] in self?.updateTerminalSize() }
        let defaults = AppRuntime.defaults
        // Gesture fixtures always begin at a known size; production restores
        // the user's choice across terminals and app launches.
        let savedSize = AppModel.isUITesting ? 12 : defaults.double(forKey: "terminal.textSize.v1")
        terminal.font = TerminalFonts.font(size: savedSize > 0 ? savedSize : 12)
        terminal.setTextSize(savedSize > 0 ? savedSize : 12)
        terminal.onTextSizeChanged = { defaults.set(Double($0), forKey: "terminal.textSize.v1") }
        applyAppearance()
        applySettings()
        for name in [TerminalFonts.changed, TerminalSettings.changed] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.applySettings() }
            }
        }
        terminal.accessibilityIdentifier = "herdr-terminal"
    }
    /// Font, cursor and autocorrection from Settings — on open and whenever they change.
    func applySettings() {
        let size = terminal.font.pointSize
        let font = TerminalFonts.font(size: size)
        if font.fontName != terminal.font.fontName { terminal.font = font }
        terminal.getTerminal().setCursorStyle(TerminalSettings.cursorStyle)
        terminal.autocorrectionType = TerminalSettings.autocorrects ? .yes : .no
        terminal.optionAsMetaKey = IntegrationSettings.enabled(IntegrationSettings.optionAsMetaKey)
    }
    func applyAppearance() {
        terminal.nativeBackgroundColor = UIColor(PhrenTheme.bgSunken)
        terminal.nativeForegroundColor = UIColor(PhrenTheme.text)
        terminal.caretColor = UIColor(PhrenTheme.cyan)
        terminal.selectedTextBackgroundColor = UIColor(PhrenTheme.lavender.opacity(0.30))
        terminal.selectedTextForegroundColor = UIColor(PhrenTheme.text)
        terminal.selectionHandleColor = UIColor(PhrenTheme.lavender)
    }
    func run(host: LiveHost, session: LiveAgentSession?, target: AgentChatTarget?, paneID: String?, route: TerminalRoute? = nil, commandMenu: Bool = false) async {
        let run = UUID(); generation = run
        connected = false; reconnecting = false; error = nil; pane = nil
        defer {
            if generation == run { resize.detach(); connected = false; reconnecting = false; self.socket = nil; writes?.cancel(); _ = terminal.resignFirstResponder() }
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
                } else if args.contains("--terminal-tour-fixture") {
                    renderTourFixture()
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
                self.pane = pane
                canOpenCommands = ["idle", "done"].contains(pane.agentStatus ?? "")
                try await PhrenConnection.herdrAction(host: host, privateKey: key, operation: .focus,
                                                     workspaceID: target.workspaceID, tabID: target.tabID, paneID: target.paneID)
            } else if let session {
                guard session.host == host else { throw PhrenKitError.validation("The Herdr server changed.") }
                let fresh = try await PhrenConnection.fetch(host: host, privateKey: key)
                guard fresh.sessions(on: host).contains(where: { $0.id == session.id }) else { throw PhrenKitError.validation("This Herdr tab has closed.") }
                if let paneID {
                    let list = try await PhrenConnection.chatPanes(host: host, privateKey: key, workspaceID: session.workspaceID, tabID: session.tab.id)
                    guard let pane = list.panes.first(where: { $0.id == paneID }) else { throw PhrenKitError.validation("This pane has closed.") }
                    self.pane = pane
                }
                try await PhrenConnection.herdrAction(host: host, privateKey: key, operation: .focus, workspaceID: session.workspaceID, tabID: session.tab.id, paneID: paneID)
            }
            var recovery = HerdrTerminalRecovery()
            var receivedBefore = false
            // A shell route starts a fresh process on every connection, so a
            // dropped link ends the session instead of silently restarting it.
            let restarts = route?.needsHerdr ?? true
            while !Task.isCancelled {
                let socket = HerdrTerminalSocket(); self.socket = socket
                connectionID = UUID()
                terminal.layoutIfNeeded()
                var graphicsFilter = TerminalGraphicsFilter()
                var first = true
                do {
                    for try await bytes in PhrenConnection.herdrTerminal(host: host, privateKey: key, socket: socket, route: route,
                                                                       columns: terminal.getTerminal().cols, rows: terminal.getTerminal().rows) {
                        try Task.checkCancellation()
                        guard generation == run else { return }
                        if first {
                            if receivedBefore { terminal.getTerminal().resetToInitialState() }
                            first = false; receivedBefore = true
                            recovery.connected(at: HerdrTerminalRecovery.now())
                            updateTerminalSize()
                            resize.attach { size in try await socket.resize(columns: size.columns, rows: size.rows) }
                        }
                        terminal.feed(byteArray: ArraySlice(graphicsFilter.filter([UInt8](bytes))))
                        // @Observable notifies on every set, changed or not; the
                        // terminal paints itself, so don't re-render the chrome per packet.
                        if !connected { connected = true }
                        if reconnecting { reconnecting = false }
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
                    resize.detach()
                    connected = false; writes?.cancel(); writes = nil; self.socket = nil
                    if !restarts { throw receivedBefore ? PhrenKitError.validation("The session ended. Reconnect to start a new one.") : error }
                    guard let delay = recovery.delay(after: error, now: HerdrTerminalRecovery.now()) else { throw error }
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
        resize.update(columns: newCols, rows: newRows)
    }
    private func updateTerminalSize() {
        sizeChanged(source: terminal, newCols: terminal.getTerminal().cols, newRows: terminal.getTerminal().rows)
    }
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        input(String(decoding: data, as: UTF8.self))
        Task { @MainActor [weak self] in self?.control = source.controlModifier }
    }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ExternalLinkPolicy.host(for: url) != nil else { return }
        pendingLink = url
    }
    func openConfirmedLink(_ url: URL) {
        guard ExternalLinkPolicy.host(for: url) != nil else { return }
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { fixtureLinks.append(url.absoluteString); return }
        #endif
        UIApplication.shared.open(url)
    }

    #if DEBUG && targetEnvironment(simulator)
    /// The App Store tour: a Claude Code turn as it looks in Herdr, drawn to
    /// the current width.
    private func renderTourFixture() {
        let cols = max(24, terminal.getTerminal().cols)
        let lavender = "\u{1B}[38;2;185;148;244m", cyan = "\u{1B}[38;2;40;211;242m", dim = "\u{1B}[38;2;164;169;177m"
        let green = "\u{1B}[38;2;138;200;172m", bold = "\u{1B}[1m", reset = "\u{1B}[0m"
        func box(_ lines: [String]) -> [String] {
            let inner = cols - 2
            // Pad by what the terminal shows, not by the colour codes.
            func visible(_ line: String) -> Int { line.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression).count }
            func fit(_ line: String) -> String { line + String(repeating: " ", count: max(0, inner - 1 - visible(line))) }
            return [dim + "╭" + String(repeating: "─", count: inner) + "╮" + reset]
                + lines.map { dim + "│" + reset + fit($0) + dim + " │" + reset }
                + [dim + "╰" + String(repeating: "─", count: inner) + "╯" + reset]
        }
        let screen = ["\(dim)$ claude\(reset)"]
            + box([" \(lavender)✻\(reset) \(bold)Claude Code\(reset) \(dim)· Opus 5\(reset)", "   \(dim)/work/phren · main\(reset)"])
            + ["",
               "\(dim)>\(reset) Ship the onboarding flow",
               "",
               "\(lavender)●\(reset) I'll start with the first-run screens.",
               "",
               "\(lavender)●\(reset) \(bold)Read\(reset)(Onboarding/WelcomeView.swift)",
               "  \(dim)⎿  Read 84 lines\(reset)",
               "",
               "\(lavender)●\(reset) \(bold)Update\(reset)(Onboarding/WelcomeView.swift)",
               "  \(dim)⎿  Updated with \(green)12 additions\(dim) and 3 removals\(reset)",
               "",
               "\(lavender)●\(reset) \(bold)Bash\(reset)(xcodebuild build -scheme Phren)",
               "  \(dim)⎿  ** BUILD SUCCEEDED **\(reset)",
               "",
               "\(lavender)●\(reset) \(bold)phren\(reset) - add_finding \(dim)(MCP)\(reset)",
               "  \(dim)⎿  Saved: [decision] One tap to the first screen\(reset)",
               "",
               "\(cyan)✻\(reset) \(dim)Thinking… (12s · ↑ 1.2k tokens)\(reset)",
               ""]
            + box([" \(dim)>\(reset) "])
            + ["  \(dim)? for shortcuts\(reset)"]
        terminal.feed(text: "\u{1B}[2J\u{1B}[H" + screen.joined(separator: "\r\n") + "\u{1B}[2 q")
    }

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
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: TerminalView, context: Context) -> CGSize? {
        guard let width = proposal.width, let height = proposal.height, width.isFinite, height.isFinite else { return nil }
        return CGSize(width: width, height: height)
    }
}

struct HerdrTerminalView: View {
    let host: LiveHost
    var session: LiveAgentSession? = nil
    var target: AgentChatTarget? = nil
    var paneID: String? = nil
    /// Set for a terminal that does not go through Herdr (a project shell or
    /// agent started straight over SSH); nil attaches the host's Herdr server.
    var route: TerminalRoute? = nil
    var commandMenu = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var model = HerdrTerminalModel()
    @State private var visible = false
    @State private var shortcuts = false
    @State private var reconnect = UUID()
    @State private var uploadRequest: TerminalUploadRequest?
    @State private var chatOpen: ChatOpen?
    @State private var showingAgents = false
    @State private var showingDictation = false
    @State private var hardwareKeyboard = GCKeyboard.coalesced != nil
    @State private var stack = NavigationStackHandle()
    /// Settings → Keyboard: the toolbar steps aside for a physical keyboard.
    private var toolbarHidden: Bool { hardwareKeyboard && IntegrationSettings.enabled(IntegrationSettings.autoHideToolbarKey, default: false) }
    private var currentHost: LiveHost? { (try? LiveSessionPreferences.read(hostData))?.hosts.first { $0.id == host.id } }
    private var active: Bool { visible && scenePhase == .active && currentHost == host }
    /// A terminal opened for the computer as a whole shows whatever Herdr
    /// has in front; the sessions overview knows which tab that is.
    private var focusedSession: LiveAgentSession? {
        guard session == nil, target == nil,
              let snapshot = SessionOverviewMonitor.shared.computers.first(where: { $0.host.id == host.id })?.monitor.snapshot,
              let focus = snapshot.focus else { return nil }
        return snapshot.sessions(on: host).first { $0.workspaceID == focus.workspaceID && $0.tab.id == focus.tabID }
    }
    private var chatSession: LiveAgentSession? { session ?? focusedSession }
    /// The agent in the pane on screen: the chat's target, the pane this
    /// terminal was opened on, or the tab's agent.
    private var paneAgent: String? {
        if let target { return target.source }
        if paneID != nil { return model.pane?.agent }
        return chatSession?.tab.agent
    }
    /// The opened pane, when chat can take it up directly.
    private var chatPane: AgentChatPanes.Pane? {
        guard let pane = model.pane, let session,
              (try? pane.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil else { return nil }
        return pane
    }
    private struct ChatOpen: Identifiable, Hashable {
        let id = UUID()
        let session: LiveAgentSession
        var pane: AgentChatPanes.Pane? = nil
        var attachments: [AgentAttachment] = []
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
    var body: some View {
        VStack(spacing: 0) {
            header
            if let error = model.error {
                Label(error, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(PhrenTheme.warning).padding(.horizontal, 12).padding(.bottom, 8)
            }
            if currentHost != host { Text("Connection settings changed. Reopen Herdr from the computer list.").font(.footnote).padding() }
            HerdrTerminalSurface(model: model).frame(maxWidth: .infinity, maxHeight: .infinity).padding(.horizontal, 4)
            if !toolbarHidden {
                TerminalControls(terminal: model.terminal, hostID: host.id,
                                 source: paneAgent ?? "", enabled: model.connected && active, control: $model.control,
                                 shortcuts: $shortcuts, send: model.input,
                                 attach: { uploadRequest = TerminalUploadRequest(attachments: $0) },
                                 openAgents: { showingAgents = true }, openChat: openChat)
                    .padding(.bottom, 6)
            }
        }
        #if DEBUG && targetEnvironment(simulator)
        .overlay(alignment: .topLeading) {
            if AgentChatFixture.enabled {
                Text(model.fixtureReport).font(.system(size: 1)).frame(width: 1, height: 1)
                    .accessibilityIdentifier("terminal-fixture-report")
            }
        }
        #endif
        .confirmWebLink($model.pendingLink, open: model.openConfirmedLink)
        .background(PhrenTheme.bgSunken)
        .overlay {
            if showingAgents {
                ZStack(alignment: .leading) {
                    Color.black.opacity(0.34).ignoresSafeArea().onTapGesture { closeAgents() }
                    AgentDrawer(current: session, chooseSession: { selected in
                        chatOpen = .init(session: selected); closeAgents()
                    }, close: closeAgents)
                }.zIndex(20)
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .keepsInteractivePop(stack: stack)
        .onChange(of: PhrenAppearance.shared.palette) { _, _ in model.applyAppearance() }
        .toolbar(.hidden, for: .tabBar)
        .sheet(item: $uploadRequest) { request in
            TerminalUploadFlow(host: host, attachments: request.attachments) { session, pane, attachments in
                chatOpen = .init(session: session, pane: pane, attachments: attachments)
            }
        }
        .navigationDestination(item: $chatOpen) {
            AgentChatSheet(session: $0.session, initialPane: $0.pane, attachments: $0.attachments)
        }
        .sheet(isPresented: $showingDictation) { ChatDictationView { text in model.input(text) } }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidConnect)) { _ in hardwareKeyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidDisconnect)) { _ in hardwareKeyboard = GCKeyboard.coalesced != nil }
        .onAppear {
            // Settings → Advanced: no auto-lock while a terminal is up.
            if TerminalSettings.keepsScreenOn { UIApplication.shared.isIdleTimerDisabled = true }
            visible = true
            model.terminal.onShortcutGesture = { shortcuts = true }
            model.terminal.onOpenChat = openChat
            model.terminal.onDictate = { showingDictation = true }
        }.onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            visible = false
            shortcuts = false
            model.terminal.onShortcutGesture = nil
            model.terminal.onOpenChat = nil
            model.terminal.onDictate = nil
        }
        .task(id: Run(active: active, reconnect: reconnect)) {
            if active { await model.run(host: host, session: session, target: target, paneID: paneID, route: route, commandMenu: commandMenu) }
        }
    }
    private func closeAgents() { withAnimation(.easeInOut(duration: 0.18)) { showingAgents = false } }
    /// Back to the chat this terminal was opened from — through the diff
    /// screen if that is where it came from — else into this pane's chat;
    /// a terminal that knows no agent asks which one.
    private func openChat() {
        if stack.pop(toScreen: AgentChatView.screenTag) { return }
        if let chatSession { chatOpen = .init(session: chatSession, pane: chatPane) }
        else { showingAgents = true }
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
                if case .shell(let directory, let agent) = route {
                    Text((agent?.title ?? "Shell") + " · " + (directory as NSString).lastPathComponent)
                        .font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                } else if let name = host.herdrSession, name != "default" {
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
