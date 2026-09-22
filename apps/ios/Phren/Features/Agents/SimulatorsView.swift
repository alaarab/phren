import PhrenKit
import PhrenLive
import SwiftUI

/// The iOS simulators booted on each computer, each with a live screen —
/// refreshed every few seconds in the list, faster once opened.
struct SimulatorsView: View {
    var hostID: UUID? = nil
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var refresh = UUID()
    private var hosts: [LiveHost] {
        ((try? LiveSessionPreferences.read(data))?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }
    var body: some View {
        PhrenList {
            if hosts.isEmpty { Text("Add a computer in Agents to see its simulators.").foregroundStyle(PhrenTheme.textMuted) }
            ForEach(hosts) { host in SimulatorSection(host: host, refresh: refresh) }
        }
        .navigationTitle("Simulators").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .toolbar { Button("Refresh simulators", systemImage: "arrow.clockwise") { refresh = UUID() } }
        .refreshable { refresh = UUID() }
    }
}

private struct SimulatorSection: View {
    let host: LiveHost
    let refresh: UUID
    @State private var simulators: [HostSimulator]?
    @State private var error: String?
    var body: some View {
        Section {
            if let booted = simulators {
                if booted.isEmpty { Text("No simulator is booted on \(host.name).").foregroundStyle(PhrenTheme.textMuted) }
                ForEach(booted) { simulator in
                    NavigationLink { SimulatorScreenView(host: host, simulator: simulator) } label: {
                        HStack(spacing: 12) {
                            SimulatorScreen(host: host, simulator: simulator, interval: 4).frame(width: 44, height: 92)
                                .allowsHitTesting(false)
                                .clipShape(RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(PhrenTheme.border))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(simulator.name).font(.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text)
                                Text(simulator.runtime).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            }
                        }
                    }.accessibilityIdentifier("simulator:\(simulator.udid)")
                    .swipeActions {
                        Button("Shut down", systemImage: "power", role: .destructive) {
                            Task { try? await PhrenConnection.simulatorAct(host: host, privateKey: DeviceSSHKey.load(host.id), udid: simulator.udid, action: "shutdown"); self.simulators?.removeAll { $0.id == simulator.id } }
                        }
                    }
                }
            } else if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            else { ProgressView("Asking \(host.name)…") }
        } header: { Text(host.name) }
        .task(id: refresh) {
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { simulators = [HostSimulator(udid: "11111111-2222-3333-4444-555555555555", name: "iPhone 17 Pro", runtime: "iOS 26.1")]; return }
                #endif
                simulators = try await PhrenConnection.simulators(host: host, privateKey: DeviceSSHKey.load(host.id))
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}

/// One simulator's screen, polled from the computer.
struct SimulatorScreen: View {
    let host: LiveHost
    let simulator: HostSimulator
    var interval: Double = 2
    @Environment(\.scenePhase) private var phase
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        ZStack {
            Rectangle().fill(PhrenTheme.bgSunken)
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else if failed { Image(systemName: "iphone.slash").foregroundStyle(PhrenTheme.textMuted) }
            else { ProgressView() }
        }
        .task(id: phase) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                do {
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.enabled { image = Self.fixtureImage; try await Task.sleep(for: .seconds(interval)); continue }
                    #endif
                    let data = try await PhrenConnection.simulatorScreenshot(host: host, privateKey: DeviceSSHKey.load(host.id), udid: simulator.udid)
                    let decoded = await Task.detached(priority: .userInitiated) {
                        UIImage(data: data)?.preparingForDisplay()
                    }.value
                    if let decoded { image = decoded; failed = false } else { failed = true }
                } catch { if !Task.isCancelled { failed = image == nil } }
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
    #if DEBUG && targetEnvironment(simulator)
    static let fixtureImage: UIImage = UIGraphicsImageRenderer(size: CGSize(width: 390, height: 844)).image { context in
        UIColor(red: 0.08, green: 0.08, blue: 0.1, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 390, height: 844))
        UIColor.systemPurple.setFill(); context.fill(CGRect(x: 40, y: 120, width: 310, height: 60))
    }
    #endif
}

/// The simulator, live and under your finger: tap the screen to tap the
/// device, Home and Lock in the toolbar, type into it, launch an app, open
/// a URL, or shut it down. Touches need one Accessibility grant on the Mac
/// for Phren Hook's helper; the first tap says exactly what to allow.
struct SimulatorScreenView: View {
    let host: LiveHost
    let simulator: HostSimulator
    @Environment(\.dismiss) private var dismiss
    @State private var apps: [SimulatorApp] = []
    @State private var typing = false
    @State private var text = ""
    @State private var url = ""
    @State private var opening = false
    @State private var message: String?
    @State private var busy = false
    @State private var flash: CGPoint?
    @State private var showingApps = false
    @State private var showingMore = false

    var body: some View {
        VStack(spacing: 0) {
            if let message {
                Text(message).font(.footnote).foregroundStyle(PhrenTheme.warning).padding(.horizontal, 16).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading).background(PhrenTheme.surface)
                    .accessibilityIdentifier("simulator-message")
            }
            GeometryReader { geometry in
                SimulatorScreen(host: host, simulator: simulator, interval: 1.0)
                    .overlay {
                        if let flash { Circle().stroke(PhrenTheme.accent, lineWidth: 2).frame(width: 34, height: 34).position(flash).transition(.opacity) }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { point in
                        // The screenshot is fitted into the view; map the tap
                        // back onto the device's own frame.
                        let frame = Self.fitted(in: geometry.size, aspect: 1320.0 / 2868.0)
                        guard frame.contains(point) else { return }
                        let x = (point.x - frame.minX) / frame.width, y = (point.y - frame.minY) / frame.height
                        withAnimation(.easeOut(duration: 0.12)) { flash = point }
                        Task { await act("tap", ["x": x, "y": y]); try? await Task.sleep(for: .milliseconds(250)); withAnimation { flash = nil } }
                    }
                    .accessibilityIdentifier("simulator-screen")
            }
            .padding(8)
            HStack(spacing: 6) {
                control("Home", "house") { await act("home") }
                control("Lock", "lock") { await act("lock") }
                control("Type", "keyboard") { typing = true }
                Button { showingApps = true } label: {
                    Label("Apps", systemImage: "square.grid.2x2").font(.caption).frame(maxWidth: .infinity, minHeight: 44)
                }
                .accessibilityIdentifier("simulator-apps")
                PhrenIconButton(icon: "ellipsis.circle", label: "More") { showingMore = true }
                    .phrenIdentifier("simulator-more")
            }
            .padding(.horizontal, 10).padding(.bottom, 6)
            .buttonStyle(.plain).foregroundStyle(PhrenTheme.text)
        }
        .navigationTitle(simulator.name).navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .disablesPanToGoBack()
        .task {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { apps = [SimulatorApp(bundleId: "com.phren.ios", name: "Phren")]; return }
            #endif
            apps = (try? await PhrenConnection.simulatorApps(host: host, privateKey: DeviceSSHKey.load(host.id), udid: simulator.udid)) ?? []
        }
        .sheet(isPresented: $typing) {
            NavigationStack {
                PhrenScreen {
                    PhrenGroup("Text") {
                        TextField("Text", text: $text)
                            .accessibilityIdentifier("simulator-type-field")
                    }
                }
                .navigationTitle("Type into the simulator")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { text = "" } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Type") { let value = text; text = ""; Task { await act("type", ["text": value]) } }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .sheet(isPresented: $opening) {
            NavigationStack {
                PhrenScreen {
                    PhrenGroup("URL") {
                        TextField("https://", text: $url)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .keyboardType(.URL)
                            .accessibilityIdentifier("simulator-url-field")
                    }
                }
                .navigationTitle("Open a URL in the simulator")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { url = "" } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Open") { let value = url; url = ""; Task { await act("openurl", ["url": value]) } }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .phrenActionSheet(isPresented: $showingApps, title: "Apps", actions: appActions,
                          identifier: "simulator-apps-sheet")
        .phrenActionSheet(isPresented: $showingMore, title: "Simulator", actions: moreActions,
                          identifier: "simulator-more-sheet")
    }

    private var appActions: [PhrenControlAction] {
        var actions: [PhrenControlAction] = []
        if apps.isEmpty {
            actions.append(PhrenControlAction(id: "empty", title: "No apps installed", isEnabled: false) {})
        } else {
            actions.append(contentsOf: apps.map { app in
                PhrenControlAction(id: app.bundleId, title: app.name) {
                    Task { await act("launch", ["bundleId": app.bundleId]) }
                }
            })
        }
        actions.append(PhrenControlAction(id: "open-url", title: "Open URL…", icon: "link") { opening = true })
        return actions
    }

    private var moreActions: [PhrenControlAction] {
        [PhrenControlAction(id: "shutdown", title: "Shut down", icon: "power", role: .destructive) {
            Task { await act("shutdown"); dismiss() }
        }]
    }

    private func control(_ title: String, _ symbol: String, _ action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Label(title, systemImage: symbol).font(.caption).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }.disabled(busy).accessibilityIdentifier("simulator-" + title.lowercased())
    }

    /// Where a `scaledToFit` image of `aspect` lands inside `size`.
    static func fitted(in size: CGSize, aspect: CGFloat) -> CGRect {
        let width = min(size.width, size.height * aspect), height = width / aspect
        return CGRect(x: (size.width - width) / 2, y: (size.height - height) / 2, width: width, height: height)
    }

    private func act(_ action: String, _ fields: [String: Any] = [:]) async {
        busy = true; defer { busy = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { AgentChatFixture.simulatorActions.append(action); message = nil; return }
            #endif
            try await PhrenConnection.simulatorAct(host: host, privateKey: DeviceSSHKey.load(host.id), udid: simulator.udid, action: action, fields: fields)
            message = nil
        } catch { message = error.localizedDescription }
    }
}
