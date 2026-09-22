import PhrenKit
import SwiftUI

/// A finding's complete synced record, without leaving the conversation stack.
struct PhrenToolFindingDossier: View {
    let store: String
    let project: String
    let finding: Finding
    @Environment(AppModel.self) private var model

    private var current: Finding {
        model.findings(storeId: store, project: project).first {
            if let stableID = finding.stableId { return $0.stableId == stableID }
            return $0.text == finding.text
        } ?? finding
    }

    var body: some View {
        let finding = current
        ScrollView {
            VStack(alignment: .leading, spacing: PhrenTheme.Space.large) {
                Text(finding.text).font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
                PhrenGroup("Details") {
                    detail("Project", project)
                    detail("Store", store)
                    detail("Created", finding.date)
                    detail("Status", finding.status.rawValue)
                    if let type = finding.typeTag { detail("Type", type) }
                    if let confidence = finding.confidence { detail("Confidence", confidence.formatted(.percent)) }
                    if let citation = finding.citation { detail("Citation", citation) }
                    if let task = finding.taskItem { detail("Task", task) }
                    if let reason = finding.statusReason { detail("Reason", reason) }
                    if let scope = finding.scope { detail("Scope", scope) }
                    if let supersedes = finding.supersedes { detail("Supersedes", supersedes) }
                    if let supersededBy = finding.supersededBy { detail("Superseded by", supersededBy) }
                    if let contradicts = finding.contradicts, !contradicts.isEmpty { detail("Contradicts", contradicts.joined(separator: ", ")) }
                    if let id = finding.stableId { detail("Finding ID", id) }
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(PhrenTheme.Space.large)
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Finding dossier").navigationBarTitleDisplayMode(.inline)
        .phrenIdentifier("chat-phren-finding-dossier")
    }

    private func detail(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            Text(name).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
            Text(value).font(PhrenTypography.subheadline).foregroundStyle(PhrenTheme.textSecondary)
        }
    }
}

/// The actual search response, including results beyond the three-line preview.
/// It stays available even when the originating store is not synced here.
struct PhrenToolSearchResults: View {
    let presentation: PhrenToolPresentation
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhrenTheme.Space.large) {
                if let summary = presentation.resultSummary {
                    Text(summary).font(PhrenTypography.subheadline).foregroundStyle(PhrenTheme.textMuted)
                }
                ForEach(Array(presentation.searchResults.enumerated()), id: \.offset) { _, hit in
                    VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                        if !hit.title.isEmpty { Text(hit.title).font(PhrenTypography.body.weight(.semibold)) }
                        if !hit.text.isEmpty { Text(hit.text).font(PhrenTypography.body) }
                        if let source = hit.source { Text(source).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .toolCard()
                }
                if presentation.searchResults.isEmpty, presentation.resultSummary == nil {
                    Text(presentation.fullOutput ?? "No results").font(PhrenTypography.body)
                }
            }
            .foregroundStyle(PhrenTheme.text).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(PhrenTheme.Space.large)
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Search results").navigationBarTitleDisplayMode(.inline)
        .phrenIdentifier("chat-phren-search-results")
    }
}
