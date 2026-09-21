import PhrenKit
import PhrenLive
import SwiftUI

/// One symbol's dossier: its definition snippet in the Changes screen's
/// monospace, the last change, every resolved reference grouped by file, and a
/// Findings section reserved for stage 4. Opened from a Code row.
struct CodeSymbolDossier: View {
    let storeId: String
    let project: String
    let symbol: String
    let hosts: [LiveHost]

    @Environment(\.dismiss) private var dismiss
    @State private var definition: CodeDefinition?
    @State private var references: CodeReferences?
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
                    PhrenSectionHeader(title: "Findings")
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
    }

    private var header: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(symbol).font(PhrenTheme.Font.body.weight(.semibold)).foregroundStyle(PhrenTheme.text).lineLimit(1)
                    if let kind = definition?.symbol.kind { PhrenChip(text: kind) }
                }
                if let definition {
                    Text(definition.symbol.location).font(PhrenTheme.Font.monoCaption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
            PhrenIconButton(icon: "xmark", label: "Close symbol") { dismiss() }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
    }

    @ViewBuilder private func definitionSection(_ definition: CodeDefinition) -> some View {
        if !definition.snippet.isEmpty {
            Text(definition.snippet)
                .font(PhrenTheme.Font.monoCaption)
                .foregroundStyle(PhrenTheme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .phrenPanel(tool: true)
                .accessibilityIdentifier("code-dossier-snippet")
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
            PhrenSectionHeader(title: "References", count: references.total)
            ForEach(references.groups) { group in
                Text(group.file).plainListSectionLabel()
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(Array(group.references.enumerated()), id: \.offset) { _, reference in
                    HStack(spacing: 10) {
                        Text("\(reference.line)")
                            .font(PhrenTheme.Font.monoCaption)
                            .foregroundStyle(PhrenTheme.textSecondary)
                            .frame(minWidth: 34, alignment: .trailing)
                        PhrenChip(text: reference.kind)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(minHeight: 44)
                    .sessionCard()
                }
            }
        } else if references != nil {
            PhrenSectionHeader(title: "References", count: 0)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        #if DEBUG && targetEnvironment(simulator)
        if CodeFixture.enabled {
            definition = CodeFixture.definition(symbol)
            references = CodeFixture.references(symbol)
            return
        }
        #endif
        guard let host = hosts.first else { return }
        do {
            async let definitionTask = PhrenConnection.codeDefinition(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, symbol: symbol)
            async let referencesTask = PhrenConnection.codeReferences(host: host, privateKey: DeviceSSHKey.load(host.id), project: project, symbol: symbol)
            definition = try await definitionTask
            references = try await referencesTask
        } catch {
            errorText = error.localizedDescription
        }
    }
}
