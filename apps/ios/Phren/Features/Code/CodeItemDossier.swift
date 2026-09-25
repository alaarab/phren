import PhrenKit
import PhrenLive
import SwiftUI

/// One function, type or variable: its definition snippet in the Changes screen's
/// monospace, the last change, every resolved reference grouped by file, and
/// the findings cited on it. Opened from a Code row or a name in the code
/// viewer; with `onOpen`, the definition and each reference open in the viewer.
/// A function, type or variable: where it is defined, where it is used, and
/// what Phren remembers about it.
struct CodeItemDossier: View {
    let storeId: String
    let project: String
    /// File-qualified, as the index names it: `src/app.ts::Point.length`.
    let name: String
    let hosts: [LiveHost]
    var origin: SessionCodeContext? = nil
    var onOpen: ((_ file: String, _ line: Int) -> Void)? = nil

    // Project navigation has no chat origin, but still owns a store. Keep
    // definition, references and saved notes in that same explicit scope.
    /// "Point.length": the name a person reads, without its file.
    private var displayName: String { name.components(separatedBy: "::").last ?? name }
    var requests: CodeDossierRequests { .init(storeID: storeId, project: project, symbol: name) }

    @Environment(\.dismiss) private var dismiss
    @State private var definition: CodeDefinition?
    @State private var references: CodeReferences?
    @State private var selectedLine: Int?
    @State private var note = ""
    @State private var sending = false
    @State private var noteStatus: String?
    @State private var showingRecipients = false
    @State private var recipient = ""
    @State private var harness = "codex"
    @State private var showingHarness = false
    @State private var recipients: [CodeNoteRecipient] = []
    @State private var findings: [CodeFinding] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(PhrenTheme.border).frame(height: 0.5)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if let errorText {
                        Text(errorText).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.warning)
                            .padding(.top, PhrenTheme.Space.section).accessibilityIdentifier("code-dossier-error")
                    } else if loading && definition == nil {
                        Text("Loading…").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted)
                            .padding(.top, PhrenTheme.Space.section).accessibilityIdentifier("code-dossier-loading")
                    } else if let definition {
                        definitionSection(definition)
                        lastChange(definition)
                    }
                    referencesSection
                    PhrenSectionHeader(title: "Findings", count: findings.count)
                    ForEach(findings) { finding in
                        Text(finding.text).font(PhrenTheme.Font.body).foregroundStyle(PhrenTheme.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(PhrenTheme.Space.medium).sessionCard()
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, PhrenTheme.Space.small)
                .padding(.bottom, PhrenTheme.Space.section)
            }
        }
        .background(PhrenTheme.bg)
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement()
                .accessibilityIdentifier("code-dossier")
        }
        .task { await load() }
        .sheet(isPresented: $showingRecipients) {
            PhrenSingleSelectSheet(title: "Also tell an agent?", options: recipientOptions, selection: $recipient,
                rowPrefix: "code-recipient", footer: AnyView(
                    PhrenSingleSelect(options: harnessOptions, selection: $harness, placeholder: "New worker harness",
                                      identifier: "code-harness", isPresented: $showingHarness)
                ), onSelect: { choice in Task { await send(to: choice) } }, dismiss: { showingRecipients = false })
                .padding(PhrenTheme.Space.large).background(PhrenTheme.bg)
                .phrenSingleSelectSheet(isPresented: $showingHarness, title: "Harness", options: harnessOptions,
                                        selection: $harness, rowPrefix: "code-harness-option")
                .presentationDetents([.large])
        }
    }

    private var header: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(definition?.symbol.name ?? displayName).font(PhrenTheme.Font.body.weight(.semibold)).foregroundStyle(PhrenTheme.text).lineLimit(1)
                    if let kind = definition?.symbol.kind { PhrenChip(text: kind) }
                }
                if let definition {
                    Text(definition.symbol.location).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
            if let definition {
                CodeUsageIndicator(uses: references?.total ?? definition.symbol.uses)
                if let onOpen {
                    PhrenIconButton(icon: "arrow.turn.down.right", label: "Go to definition") {
                        onOpen(definition.symbol.file, definition.symbol.line)
                    }.phrenIdentifier("code-dossier-definition")
                }
            }
            PhrenIconButton(icon: "xmark", label: "Close") { dismiss() }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
    }

    @ViewBuilder private func definitionSection(_ definition: CodeDefinition) -> some View {
        if !definition.snippet.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(definition.snippet.components(separatedBy: "\n")
                    .prefix(max(0, definition.symbol.endLine - definition.symbol.line + 1)).enumerated()), id: \.offset) { index, text in
                    let line = definition.symbol.line + index
                    Button { selectedLine = line } label: {
                        HStack(alignment: .top, spacing: PhrenTheme.Space.small) {
                            Rectangle().fill(selectedLine == line ? PhrenTheme.accent : .clear).frame(width: 3)
                            Text("\(line)").foregroundStyle(PhrenTheme.textMuted).frame(minWidth: 30, alignment: .trailing)
                            Text(text.isEmpty ? " " : text).foregroundStyle(PhrenTheme.text).frame(maxWidth: .infinity, alignment: .leading)
                        }.font(PhrenTheme.Font.monoCaption).frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityIdentifier("code-line:\(line)")
                    .accessibilityAddTraits(selectedLine == line ? .isSelected : [])
                }
            }.padding(PhrenTheme.Space.small).phrenPanel(tool: true)
                .phrenContainerMarker("code-dossier-snippet", label: "Definition")
            if selectedLine != nil {
                VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                    PhrenTextField("Remember this about \(displayName)", text: $note, identifier: "code-note", axis: .vertical).lineLimit(2...8)
                    HStack {
                        if let noteStatus { Text(noteStatus).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textSecondary) }
                        Spacer()
                        Button("Remember") { Task { await chooseRecipient() } }
                            .frame(minWidth: 44, minHeight: 44).disabled(sending || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("code-send")
                    }
                }
            }
        }
    }

    @ViewBuilder private func lastChange(_ definition: CodeDefinition) -> some View {
        if let blame = definition.blame {
            Text("Last change \(String(blame.at.prefix(10))) · \(blame.authorHash.prefix(12))")
                .font(PhrenTheme.Font.monoCaption)
                .foregroundStyle(PhrenTheme.textMuted)
                .padding(.top, PhrenTheme.Space.xs)
                .accessibilityIdentifier("code-dossier-blame")
        }
    }

    @ViewBuilder private var referencesSection: some View {
        if let references, !references.groups.isEmpty {
            PhrenSectionHeader(title: CodeView.usedIn(references.total))
            // One flat run of rows with unique ids: nested ForEach blocks of
            // mixed rows inside a lazy stack misjudge heights on long lists
            // and leave blank bands while scrolling.
            ForEach(Self.referenceRows(references.groups)) { row in
                switch row.content {
                case .file(let file):
                    Text(file).plainListSectionLabel()
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .reference(let file, let reference):
                    Button { onOpen?(file, reference.line) } label: {
                        HStack(spacing: 10) {
                            Text("\(reference.line)")
                                .font(PhrenTheme.Font.monoCaption)
                                .foregroundStyle(PhrenTheme.textSecondary)
                                .frame(minWidth: 34, alignment: .trailing)
                            PhrenChip(text: reference.kind)
                            Spacer(minLength: 0)
                            if onOpen != nil {
                                Image(systemName: "chevron.right").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textDim)
                                    .accessibilityHidden(true)
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                        .sessionCard()
                    }
                    .buttonStyle(.plain).disabled(onOpen == nil)
                    .accessibilityIdentifier("code-reference:\(file):\(reference.line)")
                }
            }
        } else if references != nil {
            PhrenSectionHeader(title: CodeView.usedIn(0))
        }
    }

    private struct ReferenceRow: Identifiable {
        enum Content { case file(String), reference(String, CodeReference) }
        let id: String
        let content: Content
    }

    private static func referenceRows(_ groups: [CodeReferenceGroup]) -> [ReferenceRow] {
        groups.flatMap { group in
            [ReferenceRow(id: "file:\(group.file)", content: .file(group.file))]
                + group.references.enumerated().map { index, reference in
                    ReferenceRow(id: "ref:\(group.file):\(index)", content: .reference(group.file, reference))
                }
        }
    }

    private var harnessOptions: [PhrenOption<String>] {
        ["codex", "claude", "opencode"].map { PhrenOption(id: $0, value: $0, title: $0.capitalized) }
    }
    private var recipientOptions: [PhrenOption<String>] {
        recipients.map { PhrenOption(id: $0.id, value: $0.id, title: $0.title) }
            + [PhrenOption(id: "new", value: "new", title: "New worker"), PhrenOption(id: "save", value: "save", title: "Just remember it")]
    }
    private func chooseRecipient() async {
        if let origin { await send(to: origin.target.sessionID); return }
        sending = true
        defer { sending = false }
        noteStatus = nil
        recipients = []
        guard let host = hosts.first else { noteStatus = "Connect a computer to remember this."; return }
        let overview = SessionOverviewMonitor.shared.screen
        let sessions = overview.groups.filter(\.fresh).flatMap(\.sessions)
            .filter { $0.host.id == host.id && overview.projects[$0.id] == project }
        for session in sessions {
            do {
                let panes = try await PhrenConnection.chatPanes(host: host, privateKey: DeviceSSHKey.load(host.id), workspaceID: session.workspaceID, tabID: session.tab.id)
                for pane in panes.panes {
                    if let target = try? pane.target(hostID: host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: host.muxID), !target.isStarting {
                        if !recipients.contains(where: { $0.id == target.sessionID }) {
                            recipients.append(CodeNoteRecipient(id: target.sessionID, title: pane.displayTitle))
                        }
                    }
                }
            } catch { noteStatus = error.localizedDescription }
        }
        recipient = ""
        showingRecipients = true
    }
    private func send(to choice: String) async {
        guard let host = hosts.first, let definition, let selectedLine else { return }
        sending = true
        defer { sending = false }
        let target: CodeNoteRequest.Target? = choice == "save" ? nil : choice == "new" ? .init(harness: harness) : .init(session: choice)
        do {
            #if DEBUG && targetEnvironment(simulator)
            if CodeFixture.enabled {
                note = ""
                noteStatus = origin == nil ? "Remembered." : "Remembered and sent to this session."
                return
            }
            #endif
            let result = try await PhrenConnection.codeNote(host: host, privateKey: DeviceSSHKey.load(host.id),
                note: requests.note(file: definition.symbol.file, line: selectedLine, text: note, target: target))
            guard result.saved else { noteStatus = "The computer did not confirm it was remembered."; return }
            findings = result.findings
            note = ""
            noteStatus = result.delivery.map { $0.confirmed ? "Remembered and sent." : "Remembered. Delivery not confirmed: \($0.message ?? $0.error ?? "check the agent before retrying")" } ?? "Note saved."
        } catch { noteStatus = error.localizedDescription }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled {
            definition = CodeFixture.definition(name)
            references = CodeFixture.references(name)
            return
        }
        #endif
        guard let host = hosts.first else { return }
        do {
            async let definitionTask = requests.definition { project, symbol, storeID in
                try await PhrenConnection.codeDefinition(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, symbol: name, storeID: storeID)
            }
            async let referencesTask = requests.references { project, symbol, storeID in
                try await PhrenConnection.codeReferences(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, symbol: name, storeID: storeID)
            }
            definition = try await definitionTask
            findings = definition?.findings ?? []
            references = try await referencesTask
        } catch {
            errorText = error.localizedDescription
        }
    }
}

struct CodeDossierRequests: Sendable {
    let storeID: String
    let project: String
    let symbol: String

    func definition(using read: (String, String, String) async throws -> CodeDefinition) async throws -> CodeDefinition {
        try await read(project, symbol, storeID)
    }

    func references(using read: (String, String, String) async throws -> CodeReferences) async throws -> CodeReferences {
        try await read(project, symbol, storeID)
    }

    func note(file: String, line: Int, text: String, target: CodeNoteRequest.Target?) -> CodeNoteRequest {
        CodeNoteRequest(project: project, symbol: symbol, file: file, line: line, text: text, target: target, store: storeID)
    }
}

private struct CodeNoteRecipient: Identifiable { let id: String; let title: String }
