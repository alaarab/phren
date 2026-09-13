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
            if let simulators {
                if simulators.isEmpty { Text("No simulator is booted on \(host.name).").foregroundStyle(PhrenTheme.textMuted) }
                ForEach(simulators) { simulator in
                    NavigationLink { SimulatorScreenView(host: host, simulator: simulator) } label: {
                        HStack(spacing: 12) {
                            SimulatorScreen(host: host, simulator: simulator, interval: 4).frame(width: 44, height: 92)
                                .clipShape(RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(PhrenTheme.border))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(simulator.name).font(.subheadline.weight(.medium)).foregroundStyle(PhrenTheme.text)
                                Text(simulator.runtime).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            }
                        }
                    }.accessibilityIdentifier("simulator:\(simulator.udid)")
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
                    if let decoded = UIImage(data: data) { image = decoded; failed = false } else { failed = true }
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

struct SimulatorScreenView: View {
    let host: LiveHost
    let simulator: HostSimulator
    var body: some View {
        SimulatorScreen(host: host, simulator: simulator, interval: 1.5)
            .padding(12)
            .navigationTitle(simulator.name).navigationBarTitleDisplayMode(.inline)
            .phrenScreen()
    }
}
