import PhrenKit
import SwiftUI

struct ChatBackgroundJobsView: View {
    let jobs: [ChatBackgroundJob]
    @State private var expanded: Set<String> = []
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { tick in
            let jobs = jobs.filter { $0.finishedAt.map { tick.date.timeIntervalSince($0) <= ChatBackgroundJobs.finishedLinger } ?? true }
            if !jobs.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                let running = jobs.filter { $0.state == .running }.count
                HStack {
                    Label("Background", systemImage: "clock.arrow.circlepath").font(.caption.weight(.semibold))
                    Spacer()
                    Text(running > 0 ? "\(running) running" : "done").font(.caption.monospacedDigit()).foregroundStyle(PhrenTheme.chatNeutralDim)
                        .accessibilityIdentifier("chat-background-count")
                }
                ForEach(jobs) { job in
                    Button { if expanded.contains(job.id) { expanded.remove(job.id) } else { expanded.insert(job.id) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Circle().fill(job.state == .running ? PhrenTheme.cyan : PhrenTheme.success).frame(width: 6, height: 6)
                                if let worker = job.worker { AgentProviderGlyph(source: worker, size: 14) }
                                Text(job.title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                                Text(status(job, at: tick.date)).foregroundStyle(PhrenTheme.chatNeutralDim)
                                Image(systemName: "chevron.down").rotationEffect(.degrees(expanded.contains(job.id) ? 180 : 0))
                            }
                            if expanded.contains(job.id) {
                                Text(ToolOutputPreview(job.command, lines: 4, characters: 640).text).foregroundStyle(PhrenTheme.chatNeutral).lineLimit(4)
                                if !job.output.isEmpty { Text(ToolOutputPreview(job.output, lines: 8, characters: 1_200).text).foregroundStyle(PhrenTheme.chatText).lineLimit(8) }
                            }
                        }.font(.system(.caption, design: .monospaced)).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("chat-background-job:\(job.id)")
                }
            }.padding(PhrenTheme.Space.medium).phrenPanel(tool: true)
                .padding(.horizontal, 12).padding(.vertical, 4)
                // A marker, not an identifier on the card: an identifier on the
                // container would hide the rows' own ids from tests.
                .overlay(alignment: .topLeading) {
                    Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityIdentifier("chat-background-jobs")
                }
            }
        }
    }
    private func status(_ job: ChatBackgroundJob, at date: Date) -> String {
        let elapsed = Int(max(0, (job.finishedAt ?? date).timeIntervalSince(job.startedAt)))
        let duration = elapsed < 60 ? "\(elapsed)s" : "\(elapsed / 60)m \(elapsed % 60)s"
        switch job.state {
        case .running: return "running · \(duration)"
        case .finished(let code): return "finished" + (code.map { " · exit \($0)" } ?? "") + " · \(duration)"
        }
    }
}

struct ChatReadRun: View, Equatable {
    let messages: [AgentChatMessage]
    var resultImages: ((AgentChatMessage) -> AnyView)? = nil
    var imageContext = ""
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.messages == rhs.messages && lhs.imageContext == rhs.imageContext }
    private let groups: [ChatTimelineEntry]
    private let title: String
    private let preview: String
    init(messages: [AgentChatMessage], resultImages: ((AgentChatMessage) -> AnyView)? = nil, imageContext: String = "") {
        self.messages = messages; self.resultImages = resultImages; self.imageContext = imageContext
        // The outer grouping has already established the run. Re-grouping
        // restores the exact call/result cards shown before it was folded.
        groups = ChatTimelineEntry.group(messages, foldingReads: false)
        let calls = groups.compactMap { $0.messages.first(where: { !$0.isToolResult && !$0.isChange }) }
        // What the agent did, in the order it did it: "Shell ×4 · Read ×2".
        var counts: [(name: String, count: Int)] = []
        for name in calls.map({ ToolPresentationCache.value($0).title }) {
            if let index = counts.firstIndex(where: { $0.name == name }) { counts[index].count += 1 }
            else { counts.append((name, 1)) }
        }
        title = counts.prefix(3).map { $0.count > 1 ? "\($0.name) ×\($0.count)" : $0.name }.joined(separator: " · ")
            + (counts.count > 3 ? " …" : "")
        // The last command, so the row still says where the agent got to.
        preview = calls.last.map { ToolPresentationCache.value($0).preview } ?? ""
    }
    var body: some View { ChatPerformance.measure("read-run row") { content } }
    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: expanded ? PhrenDensity.toolCardRowSpacing : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "doc.text.magnifyingglass").font(.system(size: 14)).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                    Text(title).fontWeight(.semibold).foregroundStyle(PhrenTheme.chatText).lineLimit(1)
                    Text(preview).foregroundStyle(PhrenTheme.chatNeutral).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.chatNeutralDim)
                }.font(PhrenTypography.footnote).padding(.horizontal, 12).frame(height: 44)
            }.buttonStyle(.plain)
                .accessibilityLabel("\(title), \(groups.count) read operations")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("chat-read-run:\(messages[0].id)")
            if expanded {
                ForEach(groups) { group in
                    ChatToolActivity(messages: group.messages, resultImages: resultImages, imageContext: imageContext).equatable()
                }.padding(.horizontal, PhrenDensity.toolCardPadding)
            }
        }.padding(.bottom, expanded ? PhrenDensity.toolCardPadding : 0)
            .phrenPanel(tool: true)
    }
}

struct ChatToolActivity: View, Equatable {
    let messages: [AgentChatMessage]
    /// Draws the images a tool result carries (a Read of a screenshot), given
    /// the live session; nil where a card is shown without one.
    var resultImages: ((AgentChatMessage) -> AnyView)? = nil
    var imageContext = ""
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.messages == rhs.messages && lhs.imageContext == rhs.imageContext }
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// A very large folded patch shows only summary rows on screen. Its outer
    /// button remains accessible; opening it restores the patch controls and
    /// their identifiers.
    private var condensesCollapsedAccessibility: Bool {
        !expanded && messages.contains { message in
            message.isChange
                && DiffDocumentSummaryCache.value(for: message.text, key: message.renderKey).rowCount > 120
        }
    }
    var body: some View {
        ChatPerformance.measure("tool row") { content }
    }
    @ViewBuilder private var content: some View {
        // A fetch or search folds into a read run like a Read does, so it
        // can reach this row from an expanded run: it keeps its card there.
        // Skills and other MCP servers never fold; they are dispatched here
        // too so the card shows wherever the activity row is drawn.
        if let web = WebToolCard.presentation(messages) {
            WebToolCard(presentation: web, messages: messages)
        } else if let skill = SkillChip.presentation(messages) {
            SkillChip(presentation: skill, messages: messages)
        } else if let mcp = MCPToolCard.presentation(messages) {
            MCPToolCard(presentation: mcp, messages: messages)
        } else { pill }
    }
    @ViewBuilder private var pill: some View {
        let summary = ChatToolSummary(messages)
        #if DEBUG
        let _ = ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" ? Self._printChanges() : ()
        #endif
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: summary.icon).font(.system(size: 14)).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                    Text(summary.title).fontWeight(.semibold).foregroundStyle(PhrenTheme.chatText).lineLimit(1)
                    if summary.count > 1 { Text("×\(summary.count)").foregroundStyle(PhrenTheme.chatNeutralDim) }
                    Text(summary.preview).foregroundStyle(PhrenTheme.chatNeutral).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if messages.contains(where: \.isToolResult) {
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .medium)).foregroundStyle(PhrenTheme.chatNeutralDim)
                    }
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.chatNeutralDim)
                }
                .font(PhrenTypography.footnote)
                .padding(.horizontal, 12).frame(height: 44)
                .contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel("\(summary.title), \(summary.count) \(summary.count == 1 ? "operation" : "operations")")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityHint("Expand this call and its output")
                .accessibilityIdentifier("chat-tool-group:\(messages[0].id)")
            // What the command changed, right there under the call without
            // opening the card — each file folded to its title bar, so this
            // costs a row per file, not a diff. (An earlier decision the
            // round-10 "defer until tapped" pass had undone.)
            let changed = messages.filter(\.isChange)
            if !expanded, !changed.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(changed.prefix(4)) { change in
                        CodeDiffView(patch: change.text, cacheKey: change.renderKey, previewLineLimit: 12, collapsible: true)
                    }
                    if changed.count > 4 {
                        Text("+\(changed.count - 4) more files").font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutralDim)
                    }
                }
                .padding(.horizontal, 10).padding(.bottom, 10)
                .accessibilityHidden(condensesCollapsedAccessibility)
            }
            // The pictures a result carries — a Read of a screenshot, every
            // frame of it — under the pill without opening the card, side by
            // side and scrolling sideways when there are more than fit.
            let pictured = messages.filter { $0.isToolResult && !$0.resultImages.isEmpty }
            if !expanded, !pictured.isEmpty, let resultImages {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 8) {
                        ForEach(pictured) { resultImages($0) }
                    }.padding(.horizontal, 10)
                }
                .environment(\.chatImageLayout, .thumbnail)
                .padding(.bottom, 10)
            }
            if !expanded, changed.isEmpty {
                // Older Hooks and non-Git folders still provide Edit/Write inputs.
                // Use the already cached presentation; defer the diff's body until tapped.
                ForEach(messages.filter { !$0.isToolResult && !$0.isChange }) { message in
                    let presentation = ToolPresentationCache.value(message)
                    if let patch = presentation.patch {
                        CodeDiffView(patch: patch, cacheKey: message.renderKey, previewLineLimit: 12, collapsible: true)
                            .padding(.horizontal, 10).padding(.bottom, 10)
                    }
                }
            }
            if expanded {
                VStack(alignment: .leading, spacing: PhrenDensity.toolCardRowSpacing) {
                    ForEach(messages) { message in
                        // The call and its output, both in full: the command
                        // is what tells you what happened, so it is never
                        // folded behind a disclosure.
                        ToolDetailView(presentation: ToolPresentationCache.value(message),
                                       id: message.id, renderKey: message.renderKey, isResult: message.isToolResult, collapsible: message.isChange)
                        if message.isToolResult, !message.resultImages.isEmpty, let resultImages { resultImages(message) }
                    }
                }.padding(.horizontal, PhrenDensity.toolCardPadding).padding(.bottom, PhrenDensity.toolCardPadding)
            }
        }
        .phrenPanel(tool: true)
    }
}

private struct ToolDetailView: View {
    let presentation: ToolPresentation
    let id: String
    let renderKey: String
    var isResult = false
    var collapsible = false
    @AppStorage(ChatSettings.wrapKey) private var wrap = false
    @Environment(\.openToolOutput) private var openToolOutput
    @State private var showMore = false
    /// Six lines in the card, twenty once opened; the pushed reader has the rest.
    private static let previewLines = 6, moreLines = 20

    private var lineCount: Int { presentation.body.components(separatedBy: "\n").count }
    private var hasMore: Bool { lineCount > Self.previewLines || presentation.body.count > 640 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let patch = presentation.patch {
                // No identifier on the container: it would be stamped onto the
                // diff's own rows and hide their `chat-patch-file:` ids.
                CodeDiffView(patch: patch, cacheKey: renderKey, previewLineLimit: collapsible ? 12 : 8, collapsible: collapsible)
            }
            else {
                HStack(spacing: 8) {
                    Text(isResult ? "Output" : presentation.title).fontWeight(.medium)
                    Spacer()
                    Button("View full output", systemImage: "arrow.up.left.and.arrow.down.right") {
                        openToolOutput(.init(title: isResult ? "Tool Result" : presentation.title, text: presentation.body))
                    }.frame(width: 36, height: 32).contentShape(Rectangle())
                        .accessibilityIdentifier("chat-tool-output:\(id)")
                    Button("Copy tool details", systemImage: "doc.on.doc") { ChatClipboard.copy(presentation.body) }
                        .frame(width: 36, height: 32).contentShape(Rectangle())
                }.font(.caption2).foregroundStyle(PhrenTheme.chatNeutral)
                    .labelStyle(.iconOnly).buttonStyle(.plain).frame(minHeight: 32)
                if isResult {
                    // Terminal output keeps its columns: scroll sideways
                    // rather than wrapping a table or a stack trace.
                    ScrollView(wrap ? [] : [.horizontal]) {
                        Text(presentation.body.isEmpty ? "No output"
                             : ToolOutputPreview(presentation.body, lines: showMore ? Self.moreLines : Self.previewLines,
                                                 characters: showMore ? 4_000 : 640).text)
                            .font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                            .lineLimit(showMore ? Self.moreLines : Self.previewLines)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("chat-tool-preview:\(id)")
                    }
                } else {
                    // A command wraps — every character of it matters more
                    // than its columns.
                    Text(presentation.body.isEmpty ? "No input"
                         : ToolOutputPreview(presentation.body, lines: showMore ? Self.moreLines : 12, characters: showMore ? 4_000 : 2_000).text)
                        .font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                        .lineLimit(showMore ? Self.moreLines : 12).frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("chat-tool-input:\(id)")
                }
                if hasMore {
                    Button(showMore ? "Show less" : "Show \(min(lineCount, Self.moreLines) - Self.previewLines > 0 ? "\(min(lineCount, Self.moreLines) - Self.previewLines) more lines" : "more")") {
                        showMore.toggle()
                    }
                    .font(.caption).foregroundStyle(PhrenTheme.accent).padding(.vertical, 4)
                    .accessibilityIdentifier("chat-tool-more:\(id)")
                }
            }
            if presentation.raw != presentation.body {
                Button("Raw details") { openToolOutput(.init(title: "Raw details", text: presentation.raw)) }
                    .font(.caption2).foregroundStyle(PhrenTheme.chatNeutralDim).padding(.vertical, 4)
            }
        }
    }
}

struct FullToolOutput: Identifiable, Hashable {
    let id = UUID()
    let title: String
    let contents: ToolOutputPages
    init(title: String, text: String) {
        self.title = title; contents = .init(text)
    }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct FullToolOutputView: View {
    let output: FullToolOutput
    @State private var page = 0
    /// Wrapped by default: recalled memories, JSON and prose are read, not
    /// scrolled sideways. Off keeps code and tables on their own lines.
    @AppStorage("chat.toolOutput.wrap") private var wrap = true
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        let contents = output.contents
        let current = contents.pages[page]
        ScrollView(wrap ? [.vertical] : [.horizontal, .vertical]) {
                Text(current.displayText).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(PhrenTheme.chatText).textSelection(.enabled)
                    .fixedSize(horizontal: !wrap, vertical: true)
                    .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading).padding(16)
            }
            .confirmsWebLinks()
            .id("\(page)-\(wrap)")
            .background(PhrenTheme.chatPanel).navigationTitle(output.title).navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if contents.pages.count > 1 {
                    HStack(spacing: 4) {
                        pageButton("First page", "chevron.left.2", "first", destination: 0)
                        pageButton("Previous page", "chevron.left", "previous", destination: page - 1)
                        Spacer(minLength: 4)
                        VStack(spacing: 2) {
                            Text(verbatim: "Page \(page + 1) of \(contents.pages.count)")
                            Text(verbatim: "Lines \(current.firstLine)–\(current.lastLine) of \(contents.totalLines)")
                                .font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                                .accessibilityIdentifier("chat-tool-output-page-range")
                        }.font(.caption).monospacedDigit()
                        Spacer(minLength: 4)
                        pageButton("Next page", "chevron.right", "next", destination: page + 1)
                        pageButton("Last page", "chevron.right.2", "last", destination: contents.pages.count - 1)
                    }.padding(.horizontal, 12).padding(.vertical, 4)
                        .background(PhrenTheme.chatPanel)
                }
            }
            .toolbar {
                // Pushed onto the chat's stack: the back chevron is the way
                // out, and a Done beside it only asked which one to tap.
                ToolbarItemGroup(placement: .primaryAction) {
                    Button(wrap ? "Show long lines" : "Wrap lines", systemImage: wrap ? "arrow.left.and.right.text.vertical" : "text.justify.leading") { wrap.toggle() }
                        .accessibilityIdentifier("chat-tool-output-wrap")
                    Button("Copy output", systemImage: "doc.on.doc") { ChatClipboard.copy(contents.source) }
                }
            }
    }
    private func pageButton(_ title: String, _ icon: String, _ id: String, destination: Int) -> some View {
        Button { page = destination } label: {
            Image(systemName: icon).frame(width: 44, height: 44).contentShape(Rectangle())
        }
            .accessibilityLabel(title)
            .disabled(destination < 0 || destination >= output.contents.pages.count || destination == page)
            .accessibilityIdentifier("chat-tool-output-\(id)")
    }
}

/// Keep full-output text layout bounded independently of its byte size. A
/// small newline-heavy string can otherwise lay out tens of thousands of rows.
/// Pages retain every source character; Copy always uses the original text.
struct ToolOutputPages {
    struct Page {
        let text: String
        let firstLine: Int
        let lastLine: Int
        var displayText: String { text.last?.isNewline == true ? String(text.dropLast()) : text }
    }
    let source: String
    let pages: [Page]
    let totalLines: Int
    init(_ source: String) {
        self.source = source
        var pages: [Page] = []
        var start = source.startIndex, index = start
        var line = 1, firstLine = 1, characters = 0
        while index < source.endIndex {
            let character = source[index]
            index = source.index(after: index); characters += 1
            let lastLine = line
            if character.isNewline { line += 1 }
            if index < source.endIndex && (characters >= 4_000 || line - firstLine >= 120) {
                pages.append(.init(text: String(source[start..<index]), firstLine: firstLine, lastLine: lastLine))
                start = index; firstLine = line; characters = 0
            }
        }
        pages.append(.init(text: String(source[start...]), firstLine: firstLine, lastLine: line))
        self.pages = pages; totalLines = line
    }
}

/// Bound layout work as well as visible height. Full provider text is retained
/// separately, so expanding a row never lays out thousands of output lines.
