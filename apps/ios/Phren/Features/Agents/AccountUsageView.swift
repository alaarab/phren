import PhrenKit
import PhrenLive
import SwiftUI

struct AccountUsageView: View {
    var hostID: UUID? = nil
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var refresh = UUID()
    private var hosts: [LiveHost] {
        ((try? LiveSessionPreferences.read(data))?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }
    var body: some View {
        PhrenList {
            if hosts.isEmpty { Text("Connect a computer in Agents to see Claude and Codex usage.") }
            ForEach(hosts) { host in AccountUsageSection(host: host, refresh: refresh) }
            Section {
                Text("Limits belong to the accounts signed in on each computer. Computers using the same account share its allowance. Claude updates after a response; Codex refreshes up to once a minute.")
                    .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
            }
        }
        .navigationTitle("Account usage")
        .navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .toolbar { Button("Refresh usage", systemImage: "arrow.clockwise") { refresh = UUID() } }
        .refreshable { refresh = UUID() }
    }
}

private struct AccountUsageSection: View {
    let host: LiveHost
    let refresh: UUID
    @Environment(\.scenePhase) private var phase
    @State private var snapshot: AccountUsageSnapshot?
    @State private var error: String?
    @State private var loading = true
    private struct PollID: Equatable { let host: LiveHost; let refresh: UUID; let active: Bool }

    var body: some View {
        Section(host.name) {
            if let snapshot {
                ForEach(snapshot.accounts) { account in
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        let stale = account.isStale(at: context.date) || error != nil
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text(account.name).font(.headline)
                                Spacer()
                                if stale && !account.windows.isEmpty {
                                    Text("Last reported").font(.caption).foregroundStyle(PhrenTheme.warning)
                                }
                            }
                            ForEach(account.windows) { window in
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack {
                                        Text(window.name).font(.subheadline)
                                        Spacer()
                                        Text("\(window.usedPercent.formatted(.number.precision(.fractionLength(0...1))))% used")
                                            .font(.subheadline.monospacedDigit().weight(.medium))
                                    }
                                    ProgressView(value: window.usedPercent, total: 100)
                                        .tint(stale ? PhrenTheme.textMuted : window.usedPercent >= 90 ? PhrenTheme.warning : PhrenTheme.accent)
                                        .accessibilityLabel("\(window.name): \(window.usedPercent.formatted()) percent used")
                                    if let reset = window.resetDate {
                                        if reset > context.date {
                                            Text("Resets \(reset, style: .relative) from now · \(reset.formatted(date: .abbreviated, time: .shortened))")
                                                .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                                        } else {
                                            Text("Reset time passed · waiting for updated usage")
                                                .font(.caption).foregroundStyle(PhrenTheme.warning)
                                        }
                                    } else {
                                        Text("Reset time unavailable").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                                    }
                                }
                            }
                            if let message = account.message {
                                Text(message).font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                            }
                            if let updated = account.updatedDate, !account.windows.isEmpty {
                                Text("Updated \(updated, style: .relative) ago")
                                    .font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                            }
                        }.padding(.vertical, 6)
                            .accessibilityIdentifier("account-usage:\(host.id):\(account.source)")
                    }
                }
            } else if loading { ProgressView("Reading account limits…") }
            if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
        }
        .task(id: PollID(host: host, refresh: refresh, active: phase == .active)) {
            guard phase == .active else { return }
            repeat {
                loading = true
                do {
                    let value = try await fetch()
                    try Task.checkCancellation()
                    snapshot = value; error = nil
                } catch {
                    guard !Task.isCancelled else { return }
                    self.error = error.localizedDescription
                }
                loading = false
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            } while !Task.isCancelled
        }
    }

    private func fetch() async throws -> AccountUsageSnapshot {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--account-usage-fixture") {
            let now = Date()
            let payload: [String: Any] = ["accounts": ["codex", "claude"].map { source in
                ["source": source, "updatedAt": now.ISO8601Format(), "windows": [
                    ["id": "five_hour", "name": "5-hour limit", "usedPercent": 23.5, "resetsAt": now.addingTimeInterval(7200).ISO8601Format()],
                    ["id": "seven_day", "name": "7-day limit", "usedPercent": 41.2, "resetsAt": now.addingTimeInterval(172800).ISO8601Format()]
                ]] as [String: Any]
            }]
            return try AccountUsageSnapshot.read(JSONSerialization.data(withJSONObject: payload))
        }
        #endif
        return try await PhrenConnection.accountUsage(host: host, privateKey: DeviceSSHKey.load(host.id))
    }
}
