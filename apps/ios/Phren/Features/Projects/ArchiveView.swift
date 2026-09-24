import SwiftUI
import PhrenKit

/// The one row at the foot of the Findings tab that says an archive exists.
///
/// Everything it shows is already on the device: the date comes from the
/// `<!-- consolidated: … -->` stamp the CLI leaves in the project's own
/// FINDINGS.md, the topic count and byte total from the catalogue the
/// recursive tree paid for. Nothing here triggers a fetch — tapping it does.
/// Route value for the archive browser.
///
/// The whole archive chain pushes by value and registers its destinations at
/// the NavigationStack root (ProjectsView). Mixing the closure form
/// `NavigationLink { destination }` with value links plus
/// `.navigationDestination(for:)` in one stack makes SwiftUI resolve a tap
/// twice — the observed symptom was a tap that appeared to do nothing, left
/// you on the topic list, and stacked duplicate pages behind you.
struct ArchiveRoute: Hashable {
    let storeId: String
    let project: String
}

/// A topic plus the store it came from. `ColdDocRef` deliberately carries no
/// store id — it is built from one store's tree — so the route supplies it,
/// which also lets the destination live at the stack root.
struct ArchiveTopicRoute: Hashable {
    let storeId: String
    let topic: ColdDocRef
}

struct ArchiveFooter: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model

    private var consolidatedDate: String? {
        model.consolidatedDate(storeId: storeId, project: project)
    }

    private var summary: ColdSummary? {
        model.coldSummary(storeId: storeId, project: project)
    }

    var body: some View {
        if let summary, summary.topicCount > 0 {
            Section {
                NavigationLink(value: ArchiveRoute(storeId: storeId, project: project)) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(headline(summary)).font(.subheadline.weight(.semibold))
                            Text("\(ArchiveFormat.size(summary.totalBytes)), downloaded when you open it")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "archivebox")
                    }
                    .padding(.vertical, 2)
                }
            }
        } else if let consolidatedDate {
            // Consolidated, but this store holds no `reference/topics/` — the
            // archive is real and simply isn't here. Say so rather than
            // leaving the findings look inexplicably short.
            Section {
                Label("Consolidated \(consolidatedDate) — no archive topics in this store",
                      systemImage: "archivebox")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// "Archived 2026-08-01 — 214 findings in 6 topics" once every topic has
    /// been read at least once; until then the finding count is genuinely
    /// unknown (it lives inside documents nobody has downloaded) and the row
    /// says what it can stand behind instead of guessing.
    private func headline(_ summary: ColdSummary) -> String {
        let topics = "\(summary.topicCount) topic\(summary.topicCount == 1 ? "" : "s")"
        let scope = summary.findingCount.map { "\($0) finding\($0 == 1 ? "" : "s") in \(topics)" } ?? topics
        // An archive with no stamp is a store consolidated by a CLI old enough
        // not to have written one — still real, just undated.
        guard let consolidatedDate else { return "Archived findings — \(scope)" }
        return "Archived \(consolidatedDate) — \(scope)"
    }
}

/// The cold tier's table of contents for one project: every
/// `reference/topics/*.md` the CLI's consolidation wrote, listed from the
/// catalogue the recursive tree already paid for. Opening a row is the only
/// thing in the app that fetches an archived document.
struct ArchiveBrowserView: View {
    let storeId: String
    let project: String

    @Environment(AppModel.self) private var model
    @State private var topics: [ColdDocRef] = []
    @State private var loaded = false

    var body: some View {
        PhrenList {
            Section {
                ForEach(topics) { topic in
                    NavigationLink(value: ArchiveTopicRoute(storeId: storeId, topic: topic)) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(topic.displayName).font(.headline)
                            Text(subtitle(for: topic))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            } footer: {
                // Say plainly what the tier is, so "why isn't this in search?"
                // has an answer on the screen where it comes up.
                Text("Consolidated findings the phren CLI moved out of FINDINGS.md. Read-only, downloaded one topic at a time, and left out of search so a search returns live knowledge.")
            }
        }
        .overlay {
            if loaded && topics.isEmpty {
                PhrenEmptyState(title: "Nothing archived",
                                message: "\(project) hasn't passed its findings cap yet, so nothing has been consolidated.")
            }
        }
        .phrenScreen()
        .navigationTitle("Archive")
        .navigationBarTitleDisplayMode(.inline)
        // No .navigationDestination here — it lives at the stack root in
        // ProjectsView. Registering it on a pushed view is what made a single
        // tap resolve twice.
        .task {
            topics = await model.coldTopics(storeId: storeId, project: project)
            loaded = true
        }
    }

    private func subtitle(for topic: ColdDocRef) -> String {
        guard let size = topic.size else { return "archived findings" }
        return "\(ArchiveFormat.size(size)) of archived findings"
    }
}

/// One hydrated topic document. Every entry is marked archived and has no edit
/// affordance — archived findings are read-only everywhere else in phren
/// (`FindingsFile.matchBullet` refuses them outright), and they are read-only
/// here too.
struct ArchiveTopicView: View {
    let storeId: String
    let topic: ColdDocRef

    @Environment(AppModel.self) private var model
    @State private var document: TopicDocument?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        Group {
            if let document {
                PhrenList {
                    ForEach(document.groupedByDate, id: \.date) { group in
                        Section("Archived \(group.date)") {
                            ForEach(group.entries) { entry in
                                ArchivedFindingRow(finding: entry)
                            }
                        }
                    }
                }
            } else if loading {
                ProgressView("Fetching \(topic.displayName)…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                PhrenEmptyState(
                    title: "Couldn't open this topic",
                    message: error ?? "The archive document is no longer in this store."
                )
            }
        }
        .phrenScreen()
        .navigationTitle(topic.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // A cached copy still goes through here: `coldDocument` compares
            // the cached sha against the tree's before serving it, so a topic
            // the CLI has re-consolidated since is refetched rather than
            // rendered stale.
            do {
                document = try await model.coldDocument(storeId: storeId, path: topic.path)
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        }
    }
}

/// A read-only archived finding: same layout as the live rows, plus an
/// unmissable "archived" chip and no swipe actions at all.
private struct ArchivedFindingRow: View {
    let finding: Finding

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(displayText)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            HStack(spacing: 6) {
                TagChip(text: "archived", role: .status)
                if let tag = finding.typeTag {
                    TagChip(text: tag, role: .type)
                }
                if let scope = finding.scope {
                    TagChip(text: scope, role: .scope)
                }
                Spacer()
                Text(finding.date)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    // Mirrors Components.swift FindingRow.displayText: the [tag] prefix is
    // dropped because the type chip already carries it.
    private var displayText: String {
        guard let tag = finding.typeTag else { return finding.text }
        let prefix = "[\(tag)] "
        return finding.text.lowercased().hasPrefix(prefix.lowercased())
            ? String(finding.text.dropFirst(prefix.count))
            : finding.text
    }
}

/// Byte counts as a person reads them. Local to the archive surfaces — this is
/// the only place in the app that has a size to show.
enum ArchiveFormat {
    static func size(_ bytes: Int) -> String {
        bytes < 1024
            ? "\(bytes) B"
            : (bytes < 1_048_576
                ? String(format: "%.0f KB", Double(bytes) / 1024)
                : String(format: "%.1f MB", Double(bytes) / 1_048_576))
    }
}
