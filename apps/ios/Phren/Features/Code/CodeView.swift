import PhrenKit
import PhrenLive
import SwiftUI

/// The project's code index: a search field over symbols, and with no query the
/// hottest and coldest symbols. Reached from the project page's Code cell. A
/// row opens `CodeSymbolDossier`. Capability `code`; each project needs its own
/// index on the computer.
struct CodeView: View {
    let storeId: String
    let project: String
    var origin: SessionCodeContext? = nil

    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var query = ""
    @State private var submitted = ""
    @State private var symbols: [CodeSymbol] = []
    @State private var usage: CodeUsage?
    @State private var selected: CodeDossierTarget?
    @State private var loading = false
    @State private var searchGeneration = 0
    @State private var errorText: String?
    @FocusState private var searchFocused: Bool

    private var hosts: [LiveHost] {
        if let origin { return [origin.host] }
        return ((try? LiveSessionPreferences.read(hostData))?.hosts ?? []).filter { SessionOverviewMonitor.shared.allows(.code, on: $0) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                search
                if let errorText {
                    Text(errorText).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.warning)
                        .padding(.horizontal, 2).padding(.top, PhrenTheme.Space.small)
                        .accessibilityIdentifier("code-error")
                } else if submitted.isEmpty {
                    usageSections
                } else if loading && symbols.isEmpty {
                    Text("Searching…").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                        .padding(.top, PhrenTheme.Space.section).accessibilityIdentifier("code-loading")
                } else if symbols.isEmpty {
                    Text("No symbols match “\(submitted)”")
                        .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                        .padding(.top, PhrenTheme.Space.section).accessibilityIdentifier("code-empty")
                } else {
                    PhrenSectionHeader(title: "Symbols", count: symbols.count)
                    ForEach(symbols) { symbol in
                        symbolRow(symbol)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, PhrenTheme.Space.small)
            .padding(.bottom, PhrenTheme.Space.section)
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Code")
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement()
                .accessibilityIdentifier("code-screen")
        }
        .sheet(item: $selected) { target in
            CodeSymbolDossier(storeId: storeId, project: project, symbol: target.name, hosts: hosts, origin: origin)
                .presentationDetents([.large])
        }
        .task { await loadInitial() }
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await runSearch()
        }
    }

    private var search: some View {
        PhrenSearchField(text: $query, placeholder: "Search symbols", identifier: "code-search", focus: $searchFocused) {
            Task { await runSearch() }
        }
        .padding(.bottom, PhrenTheme.Space.small)
    }

    @ViewBuilder private var usageSections: some View {
        if let usage {
            usageSection("Hot", entries: usage.hot)
            usageSection("Cold", entries: usage.cold)
        } else if loading {
            Text("Loading index…").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                .padding(.top, PhrenTheme.Space.section).accessibilityIdentifier("code-loading")
        } else {
            Text("No code index for \(project).")
                .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                .padding(.top, PhrenTheme.Space.section).accessibilityIdentifier("code-empty")
        }
    }

    @ViewBuilder private func usageSection(_ title: String, entries: [CodeUsageEntry]) -> some View {
        if !entries.isEmpty {
            PhrenSectionHeader(title: title, count: entries.count)
            ForEach(entries) { entry in
                Button { selected = CodeDossierTarget(name: entry.name) } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(entry.name).font(PhrenTheme.Font.body.weight(.medium)).foregroundStyle(PhrenTheme.text).lineLimit(1)
                                PhrenChip(text: entry.kind)
                            }
                            Text(entry.file).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: 0)
                        CodeUsageIndicator(uses: entry.uses)
                    }
                    .padding(12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                    .sessionCard()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(entry.name), \(entry.kind), \(entry.uses) uses")
                .accessibilityIdentifier("code-row:\(entry.id)")
            }
        }
    }

    private func symbolRow(_ symbol: CodeSymbol) -> some View {
        Button { selected = CodeDossierTarget(name: symbol.name) } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(symbol.name).font(PhrenTheme.Font.body.weight(.medium)).foregroundStyle(PhrenTheme.text).lineLimit(1)
                        PhrenChip(text: symbol.kind)
                    }
                    if !symbol.signature.isEmpty {
                        Text(symbol.signature).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
                CodeUsageIndicator(uses: symbol.uses)
            }
            .padding(12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .sessionCard()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(symbol.name), \(symbol.kind), \(symbol.uses) references")
        .accessibilityIdentifier("code-row:\(symbol.id)")
    }

    private func loadInitial() async {
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled {
            usage = CodeFixture.usage
            return
        }
        #endif
        guard let host = hosts.first else { return }
        loading = true
        defer { loading = false }
        do {
            async let usageTask = PhrenConnection.codeUsage(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, storeID: origin?.storeID)
            async let statusTask = PhrenConnection.codeStatus(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, storeID: origin?.storeID)
            usage = try await usageTask
            _ = try await statusTask
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func runSearch() async {
        searchGeneration += 1
        let generation = searchGeneration
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        submitted = text
        errorText = nil
        guard !text.isEmpty else { symbols = []; loading = false; return }
        loading = true
        defer { if generation == searchGeneration { loading = false } }
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled { symbols = CodeFixture.search(text); return }
        #endif
        guard let host = hosts.first else { symbols = []; return }
        do {
            let result = try await PhrenConnection.codeSearch(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, query: text, storeID: origin?.storeID)
            guard !Task.isCancelled, generation == searchGeneration else { return }
            symbols = result
        } catch {
            guard !Task.isCancelled, generation == searchGeneration else { return }
            symbols = []
            errorText = error.localizedDescription
        }
    }
}

struct CodeDossierTarget: Identifiable, Hashable {
    let name: String
    var id: String { name }
}


struct CodeUsageIndicator: View {
    let uses: Int
    var body: some View {
        VStack(alignment: .trailing, spacing: PhrenTheme.Space.xs) {
            Text("\(uses)").font(PhrenTheme.Font.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(PhrenTheme.textSecondary)
            ZStack(alignment: .leading) {
                Capsule().fill(PhrenTheme.surfaceRaised)
                Capsule().fill(PhrenTheme.accent).frame(width: uses > 0 ? max(2, min(36, CGFloat(log2(Double(uses) + 1)) * 6)) : 0)
            }.frame(width: 36, height: 3).accessibilityHidden(true)
        }.accessibilityLabel("\(uses) uses")
    }
}
