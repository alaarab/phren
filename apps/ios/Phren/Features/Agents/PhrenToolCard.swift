import PhrenKit
import SwiftUI

struct PhrenToolCard: View, Equatable {
    let presentation: PhrenToolPresentation
    let messages: [AgentChatMessage]
    var session: LiveAgentSession? = nil
    @Environment(AppModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var model = PhrenToolCardModel()
    @State private var opened: PhrenToolCardModel.Destination?
    @State private var showingRaw = false
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.presentation == rhs.presentation && lhs.messages == rhs.messages && lhs.session == rhs.session
    }

    private var callID: String { messages.first?.toolCallID ?? messages.first?.id ?? "" }
    private var destination: PhrenToolCardModel.Destination? {
        let source = session.flatMap { session in
            preferencesStore.preferences?.projectMatch(
                hostID: session.host.id, cwd: session.tab.cwd, projects: appModel.sessionProjects)?.project.storeID
        }
        let snapshots = Dictionary(uniqueKeysWithValues: appModel.storeDescriptors.map { ($0.id, appModel.snapshot(for: $0.id)) })
        return PhrenToolCardModel.destination(presentation, sourceStore: source, snapshots: snapshots)
    }

    var body: some View {
        let destination = destination
        VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
            // The chevron is a sibling control, never a nested button, and an
            // overlay so its 44 pt target never makes the row taller.
            Button(action: toggle) {
                    Group {
                        if model.isExpanded { preview(hasDestination: destination != nil) }
                        else { folded(hasDestination: destination != nil) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-phren-card:\(callID)")
                .accessibilityValue(model.isExpanded ? "Expanded" : "Folded")
                .accessibilityHint(model.isExpanded ? "Fold to a preview" : "Show the full text")
                .overlay(alignment: .topTrailing) {
                    if let destination {
                        Button { opened = destination } label: {
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(PhrenTheme.phrenCardAccent)
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(destination.label)
                        .accessibilityIdentifier("chat-phren-open:\(callID)")
                        // One place whether folded or open, so nothing jumps:
                        // centred on the first line.
                        .offset(x: 12, y: -13)
                    }
                }
            if model.isExpanded {
                VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                    // Expanding unclamps the readable preview above; the raw
                    // output shows only when the preview has nothing to say.
                    if presentation.body.isEmpty, presentation.titles.isEmpty, presentation.resultSummary == nil,
                       let output = presentation.fullOutput { fullText("Output", output) }
                    ForEach(messages.filter(\.isChange)) { message in fullText("Changes", message.text) }
                    if presentation.status == .failed {
                        ForEach(presentation.issues, id: \.self) { issue in
                            Text(issue).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        // Raw text only when the failure gave no reason of its own.
                        if presentation.issues.isEmpty, presentation.resultSummary == "Call failed",
                           let raw = presentation.rawResult {
                            fullText("Raw error", PhrenToolPresentation.readable(raw))
                        }
                    }
                    rawCall
                }
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .contentShape(Rectangle())
                .onTapGesture(perform: toggle)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-phren-expanded:\(callID)")
            }
        }
        .toolCard(collapsed: !model.isExpanded)
        .navigationDestination(item: $opened) { destination in
            switch destination {
            case .task(let row): TaskDetailsSheet(row: row)
            case .finding(let store, let project, let finding):
                PhrenToolFindingDossier(store: store, project: project, finding: finding)
            case .search(let presentation): PhrenToolSearchResults(presentation: presentation)
            }
        }
    }

    /// The call exactly as the agent made it: tool name, full input and full
    /// output. Folded under one quiet line so the card's own view stays the default.
    @ViewBuilder private var rawCall: some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { showingRaw.toggle() }
        } label: {
            HStack(spacing: 4) {
                Text("Raw call").font(PhrenTypography.caption.weight(.semibold))
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                    .rotationEffect(.degrees(showingRaw ? 90 : 0))
                Spacer(minLength: 0)
            }
            .foregroundStyle(PhrenTheme.textMuted)
            .frame(minHeight: 32).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(showingRaw ? "Expanded" : "Collapsed")
        .accessibilityIdentifier("chat-phren-raw:\(callID)")
        if showingRaw {
            let raw = "\(presentation.toolName)\n\nInput\n\(presentation.fullInput)" + (presentation.fullOutput.map { "\n\nOutput\n\($0)" } ?? "")
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(presentation.toolName).font(PhrenTypography.monoCaption.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                    Spacer(minLength: 0)
                    Button { ChatClipboard.copy(raw) } label: {
                        Image(systemName: "doc.on.doc").font(.system(size: 13)).frame(width: 44, height: 32).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityLabel("Copy raw call").accessibilityIdentifier("chat-phren-raw-copy:\(callID)")
                }
                fullText("Input", presentation.fullInput)
                if let output = presentation.fullOutput { fullText("Output", output) }
            }
            .padding(10)
            .background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-phren-raw-body:\(callID)")
        }
    }

    private func toggle() {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { model.toggle() }
    }

    private func fullText(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            Text(title).font(PhrenTypography.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
            Text(text).font(PhrenTypography.monoFootnote).foregroundStyle(PhrenTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The folded card: one line the height of a tool pill. The mark, the
    /// verb, the project, the result in a line, and how the call stands.
    private func folded(hasDestination: Bool) -> some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Image("PhrenMark").resizable().scaledToFit().frame(width: 14, height: 14).accessibilityHidden(true)
            Text(presentation.verb).font(PhrenTypography.footnote.weight(.semibold))
                .foregroundStyle(PhrenTheme.text).lineLimit(1).layoutPriority(1)
            if let project = presentation.project {
                Text(project).font(.caption.weight(.medium)).lineLimit(1)
                    .foregroundStyle(PhrenTheme.sessionProject)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(PhrenTheme.sessionProject.opacity(0.1), in: Capsule())
            }
            Text(foldedSummary).font(.caption)
                .foregroundStyle(presentation.status == .failed ? PhrenTheme.danger : PhrenTheme.textSecondary)
                .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            status
            if hasDestination { Color.clear.frame(width: 16, height: 14).accessibilityHidden(true) }
        }
    }

    /// What the call came to, in one line: the failure's reason, the
    /// result, or the first line of what it wrote.
    private var foldedSummary: String {
        if presentation.status == .failed, let issue = presentation.issues.first { return issue }
        if case .handOff(let target) = presentation.conductor, presentation.status != .failed { return "→ " + target }
        if !presentation.items.isEmpty {
            return "\(presentation.items.count) \(presentation.verb.localizedCaseInsensitiveContains("finding") ? "findings" : "tasks")"
        }
        return presentation.resultSummary ?? presentation.body.split(separator: "\n").first.map(String.init) ?? presentation.titles.first ?? ""
    }

    private func preview(hasDestination: Bool) -> some View {
        VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
            HStack(spacing: PhrenTheme.Space.small) {
                Image("PhrenMark").resizable().scaledToFit().frame(width: 14, height: 14).accessibilityHidden(true)
                Text(presentation.verb).font(PhrenTypography.footnote.weight(.semibold))
                    .foregroundStyle(PhrenTheme.text).lineLimit(1).layoutPriority(1)
                // The project and tag ride on the title line (owner,
                // September 23): one line for what was done and where.
                if let project = presentation.project {
                    Text(project).font(.caption.weight(.medium)).lineLimit(1)
                        .foregroundStyle(PhrenTheme.sessionProject)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(PhrenTheme.sessionProject.opacity(0.1), in: Capsule())
                }
                if let tag = presentation.tag {
                    Text(tag).font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                }
                Spacer(minLength: 0)
                status
                if hasDestination { Color.clear.frame(width: 16, height: 14).accessibilityHidden(true) }
            }
            if case .sessions(let groups, let missing) = presentation.conductor {
                conductorSessions(groups, missing: missing)
            } else if case .handOff(let target) = presentation.conductor {
                // Where it went, then the prompt: one line, all of it on a tap.
                Text("→ " + target).font(PhrenTypography.caption.weight(.semibold))
                    .foregroundStyle(PhrenTheme.phrenCardAccent).lineLimit(model.isExpanded ? nil : 1)
                    .accessibilityIdentifier("chat-phren-handoff:\(callID)")
                if !presentation.body.isEmpty {
                    Text(presentation.body).font(PhrenTypography.monoFootnote).foregroundStyle(PhrenTheme.textSecondary)
                        .lineLimit(model.isExpanded ? nil : 1).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if !presentation.items.isEmpty {
                // One row per task or finding the call added.
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(presentation.items.enumerated()), id: \.offset) { index, item in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(index + 1)").foregroundStyle(PhrenTheme.phrenCardAccent)
                                .frame(minWidth: 14, alignment: .trailing)
                            Text(item).foregroundStyle(PhrenTheme.textSecondary)
                                .lineLimit(model.isExpanded ? nil : 2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityIdentifier("chat-phren-item:\(callID):\(index)")
                    }
                }
                .font(PhrenTypography.monoFootnote)
            } else if !presentation.body.isEmpty {
                // The chat's own monospace, a step smaller than the reply.
                Text(presentation.body).font(PhrenTypography.monoFootnote).foregroundStyle(PhrenTheme.textSecondary)
                    .lineLimit(model.bodyLineLimit).frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(presentation.fields.enumerated()), id: \.offset) { _, field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(field.name).foregroundStyle(PhrenTheme.textMuted).lineLimit(model.isExpanded ? nil : 1)
                    Text(field.value).foregroundStyle(PhrenTheme.textSecondary).lineLimit(model.isExpanded ? nil : 2)
                }.font(PhrenTypography.caption)
            }
            if let summary = presentation.resultSummary {
                Text(summary).font(.caption.weight(.medium)).lineLimit(model.isExpanded ? nil : 2)
                    .foregroundStyle(presentation.status == .failed ? PhrenTheme.danger : PhrenTheme.phrenCardAccent)
            }
            ForEach(Array(presentation.titles.enumerated()), id: \.offset) { _, title in
                Text("· \(title)").font(PhrenTypography.monoCaption).foregroundStyle(PhrenTheme.textSecondary).lineLimit(model.isExpanded ? nil : 1)
            }
        }
    }

    /// live_sessions as the owner reads it: each computer's sessions, one
    /// row each (state dot, project, title, idle time), and the computers it
    /// couldn't see on one muted line.
    private func conductorSessions(_ groups: [PhrenToolPresentation.SessionGroup], missing: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                VStack(alignment: .leading, spacing: 3) {
                    Label(group.computer, systemImage: "desktopcomputer")
                        .font(PhrenTypography.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                        .labelStyle(.titleAndIcon)
                    ForEach(Array(group.rows.prefix(model.isExpanded ? 60 : 8).enumerated()), id: \.offset) { index, row in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Circle().fill(Self.color(row.status)).frame(width: 7, height: 7)
                                .accessibilityLabel(row.status == "needs-you" ? "needs you" : row.status)
                            Text(row.conductor ? "Conductor" : row.project ?? row.label ?? "Session")
                                .foregroundStyle(row.conductor ? PhrenTheme.accent : PhrenTheme.sessionProject)
                                .fontWeight(.medium).lineLimit(1)
                            Text(row.title ?? "").foregroundStyle(PhrenTheme.textSecondary).lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if let idle = row.idleFor, row.status != "working" {
                                Text(Self.idle(idle)).foregroundStyle(PhrenTheme.textMuted).monospacedDigit().lineLimit(1)
                            }
                        }
                        .font(PhrenTypography.caption)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("chat-phren-session:\(callID):\(group.computer):\(index)")
                    }
                    if !model.isExpanded, group.rows.count > 8 {
                        Text("+\(group.rows.count - 8) more").font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                }
            }
            if !missing.isEmpty {
                Text("Not checked: " + missing.joined(separator: ", ")).font(PhrenTypography.caption)
                    .foregroundStyle(PhrenTheme.textMuted).lineLimit(model.isExpanded ? nil : 1)
                    .accessibilityIdentifier("chat-phren-sessions-missing:\(callID)")
            }
        }
    }

    static func color(_ status: String) -> Color {
        switch status {
        case "working": PhrenTheme.stateWorking
        case "needs-you": PhrenTheme.stateWaiting
        case "done": PhrenTheme.stateDone
        default: PhrenTheme.textMuted
        }
    }

    static func idle(_ seconds: Int) -> String {
        seconds < 60 ? "now" : seconds < 3_600 ? "\(seconds / 60)m" : seconds < 86_400 ? "\(seconds / 3_600)h" : "\(seconds / 86_400)d"
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
