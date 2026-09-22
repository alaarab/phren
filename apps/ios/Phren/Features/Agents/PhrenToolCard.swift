import PhrenKit
import SwiftUI

struct PhrenToolCard: View, Equatable {
    let presentation: PhrenToolPresentation
    let messages: [AgentChatMessage]
    var session: LiveAgentSession? = nil
    @Environment(AppModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var model = PhrenToolCardModel()
    @State private var opened: PhrenToolCardModel.Destination?
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.presentation == rhs.presentation && lhs.messages == rhs.messages && lhs.session == rhs.session
    }

    private var callID: String { messages.first?.toolCallID ?? messages.first?.id ?? "" }
    private var destination: PhrenToolCardModel.Destination? {
        let source = session.flatMap { session in
            (try? LiveSessionPreferences.read(hostData))?.projectMatch(
                hostID: session.host.id, cwd: session.tab.cwd, projects: appModel.sessionProjects)?.project.storeID
        }
        let snapshots = Dictionary(uniqueKeysWithValues: appModel.storeDescriptors.map { ($0.id, appModel.snapshot(for: $0.id)) })
        return PhrenToolCardModel.destination(presentation, sourceStore: source, snapshots: snapshots)
    }

    var body: some View {
        let destination = destination
        VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
            ZStack(alignment: .topTrailing) {
                // The chevron is a sibling control, never a nested button.
                Button(action: toggle) {
                    preview(hasDestination: destination != nil)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-phren-card:\(callID)")
                .accessibilityValue(model.isExpanded ? "Expanded" : "Folded")
                .accessibilityHint(model.isExpanded ? "Fold to a preview" : "Show the full text")
                if let destination {
                    Button { opened = destination } label: {
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(PhrenTheme.phrenCardAccent)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(destination.label)
                    .accessibilityIdentifier("chat-phren-open:\(callID)")
                    .offset(x: 10, y: -10)
                }
            }
            if model.isExpanded {
                VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                    // Expanding unclamps the readable preview above; the raw
                    // output shows only when the preview has nothing to say.
                    if presentation.body.isEmpty, presentation.titles.isEmpty, presentation.resultSummary == nil,
                       let output = presentation.fullOutput { fullText("Output", output) }
                    ForEach(messages.filter(\.isChange)) { message in fullText("Changes", message.text) }
                    if presentation.status == .failed, let raw = presentation.rawResult {
                        fullText("Raw error", raw)
                    }
                }
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .contentShape(Rectangle())
                .onTapGesture(perform: toggle)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-phren-expanded:\(callID)")
            }
        }
        .toolCard()
        .navigationDestination(item: $opened) { destination in
            switch destination {
            case .task(let row): TaskDetailsSheet(row: row)
            case .finding(let store, let project, let finding):
                PhrenToolFindingDossier(store: store, project: project, finding: finding)
            case .search(let presentation): PhrenToolSearchResults(presentation: presentation)
            }
        }
    }

    private func toggle() {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { model.toggle() }
    }

    private func fullText(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            Text(title).font(PhrenTypography.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
            Text(text).font(PhrenTypography.subheadline).foregroundStyle(PhrenTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func preview(hasDestination: Bool) -> some View {
        VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
            HStack(spacing: PhrenTheme.Space.small) {
                Image("PhrenMark").resizable().scaledToFit().frame(width: 14, height: 14).accessibilityHidden(true)
                Text(presentation.verb).font(PhrenTypography.footnote.weight(.semibold))
                    .foregroundStyle(PhrenTheme.text).lineLimit(2)
                Spacer(minLength: 0)
                status
                if hasDestination { Color.clear.frame(width: 16, height: 14).accessibilityHidden(true) }
            }
            if presentation.project != nil || presentation.tag != nil {
                HStack(spacing: 6) {
                    if let project = presentation.project {
                        Text(project).font(.caption.weight(.medium)).lineLimit(1)
                            .foregroundStyle(PhrenTheme.sessionProject)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(PhrenTheme.sessionProject.opacity(0.1), in: Capsule())
                    }
                    if let tag = presentation.tag {
                        Text(tag).font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                    }
                }
            }
            if !presentation.body.isEmpty {
                Text(presentation.body).font(.subheadline).foregroundStyle(PhrenTheme.textSecondary)
                    .lineLimit(model.bodyLineLimit).frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(presentation.fields.enumerated()), id: \.offset) { _, field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(field.name).foregroundStyle(PhrenTheme.textMuted).lineLimit(model.isExpanded ? nil : 1)
                    Text(field.value).foregroundStyle(PhrenTheme.textSecondary).lineLimit(model.isExpanded ? nil : 2)
                }.font(.caption)
            }
            if let summary = presentation.resultSummary {
                Text(summary).font(.caption.weight(.medium)).lineLimit(model.isExpanded ? nil : 2)
                    .foregroundStyle(presentation.status == .failed ? PhrenTheme.danger : PhrenTheme.phrenCardAccent)
            }
            ForEach(Array(presentation.titles.enumerated()), id: \.offset) { _, title in
                Text("· \(title)").font(.caption).foregroundStyle(PhrenTheme.textSecondary).lineLimit(model.isExpanded ? nil : 1)
            }
        }
    }

    @ViewBuilder private var status: some View {
        switch presentation.status {
        case .running:
            Image(systemName: "ellipsis").font(.system(size: 12, weight: .medium))
                .foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Running")
        case .succeeded:
            Image(systemName: "checkmark").font(.system(size: 12, weight: .medium))
                .foregroundStyle(PhrenTheme.phrenCardAccent).accessibilityLabel("Completed")
        case .failed:
            Label("Failed", systemImage: "exclamationmark.circle")
                .font(PhrenTypography.caption.weight(.medium)).foregroundStyle(PhrenTheme.danger)
                .accessibilityIdentifier("chat-phren-failed:\(callID)")
        }
    }
}
