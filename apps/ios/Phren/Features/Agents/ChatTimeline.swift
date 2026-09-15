import PhrenKit
import SwiftUI

private enum ToolPresentationCache {
    final class Box: NSObject { let value: ToolPresentation; init(_ value: ToolPresentation) { self.value = value } }
    static let values: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>(); cache.countLimit = 500; return cache
    }()
    static func value(_ message: AgentChatMessage) -> ToolPresentation {
        let key = "\(message.id)|\(message.title ?? "")|\(message.text.hashValue)" as NSString
        if let cached = values.object(forKey: key) { return cached.value }
        let started = CFAbsoluteTimeGetCurrent()
        let value = ToolPresentation(title: message.title ?? "Tool", text: message.text)
        values.setObject(Box(value), forKey: key)
        #if DEBUG
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] parsed tool \(message.id): \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
        }
        #endif
        return value
    }
}

struct ChatTimelineEntry: Identifiable {
    enum Kind: Equatable { case message, activity, readRun }
    var messages: [AgentChatMessage]
    var kind: Kind = .message
    var id: String { messages[0].id }
    var isActivity: Bool { kind != .message }
    var isReadRun: Bool { kind == .readRun }

    static func group(_ messages: [AgentChatMessage]) -> [Self] {
        var entries: [Self] = []
        var previousMessageID: String?
        var calls: [String: Int] = [:], ambiguous: Set<String> = []
        for message in messages {
            // Completion metadata feeds the pinned Background panel. It is
            // transport state, not another conversation card.
            if message.role == .tool, message.title == "Background notification" { continue }
            guard message.role == .tool else {
                entries.append(.init(messages: [message], kind: .message))
                calls.removeAll(keepingCapacity: true); ambiguous.removeAll(keepingCapacity: true)
                previousMessageID = message.id
                continue
            }
            // A result — or what the call changed on disk — joins its call.
            if message.isToolResult || message.isChange {
                if let key = message.toolCallID, !key.isEmpty, !ambiguous.contains(key), let index = calls[key] {
                    entries[index].messages.append(message)
                    previousMessageID = message.id
                    continue
                }
                // Older transcripts lack IDs. Only pair an immediately adjacent,
                // unidentified call/result; never guess among parallel calls.
                if message.toolCallID == nil, let previous = entries.last,
                   previous.messages.count == 1, let call = previous.messages.first,
                   call.role == .tool, !call.isToolResult, call.toolCallID == nil,
                   call.id == previousMessageID {
                    entries[entries.count - 1].messages.append(message)
                    previousMessageID = message.id
                    continue
                }
            } else if let key = message.toolCallID, !key.isEmpty {
                if calls[key] != nil { ambiguous.insert(key) }
                else { calls[key] = entries.count }
            }
            entries.append(.init(messages: [message], kind: .activity))
            previousMessageID = message.id
        }
        return foldReadRuns(entries)
    }

    private static func foldReadRuns(_ entries: [Self]) -> [Self] {
        var result: [Self] = [], run: [Self] = []
        func flush() {
            if run.count >= 3 {
                result.append(.init(messages: run.flatMap(\.messages), kind: .readRun))
            } else { result.append(contentsOf: run) }
            run.removeAll(keepingCapacity: true)
        }
        for entry in entries {
            if entry.kind == .activity, ReadOnlyToolCall.isReadOnly(entry.messages) { run.append(entry) }
            else { flush(); result.append(entry) }
        }
        flush()
        return result
    }
}

/// Conservative classification: uncertain shell commands remain ordinary
/// cards. A call carrying a filesystem-change attachment can never be folded.
enum ReadOnlyToolCall {
    static func isReadOnly(_ messages: [AgentChatMessage]) -> Bool {
        guard !messages.contains(where: \.isChange), messages.contains(where: \.isToolResult),
              let call = messages.first(where: { $0.role == .tool && !$0.isToolResult }) else { return false }
        let presentation = ToolPresentation(title: call.title ?? "Tool", text: call.text)
        switch presentation.title {
        case "Read", "Browse", "List": return true
        case "Shell": return shell(presentation.body)
        default:
            let raw = (call.title ?? "").split(separator: ".").last.map(String.init)?.lowercased() ?? ""
            return ["read", "glob", "grep", "ls"].contains(raw)
        }
    }

    static func shell(_ command: String) -> Bool {
        let source = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty, !source.contains("\n"),
              source.range(of: #"(?:;|`|\$\(|>>?|<<|\b(?:rm|mv|cp|tee|touch|mkdir|ln|chmod|chown|install|xargs)\b|\bfind\b[^|]*(?:-delete|-exec)|\bgit\s+(?:commit|push|checkout|switch|restore|reset|clean|merge|rebase|pull|fetch|add|rm|mv|stash|apply)\b)"#,
                           options: [.regularExpression, .caseInsensitive]) == nil else { return false }
        let segments = source.components(separatedBy: "|").flatMap { $0.components(separatedBy: "&&") }
        return !segments.isEmpty && segments.allSatisfy { segment in
            let words = segment.trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).map(String.init)
            guard let first = words.first?.lowercased() else { return false }
            if first == "git" { return words.count > 1 && ["diff", "log", "status", "show"].contains(words[1].lowercased()) }
            if first == "sed" { return words.dropFirst().contains { $0 == "-n" || ($0.hasPrefix("-") && $0.contains("n") && !$0.contains("i")) } }
            return ["cat", "head", "tail", "grep", "rg", "ls", "find", "wc", "echo", "pwd", "which", "type"].contains(first)
        }
    }
}

struct ChatBackgroundJob: Identifiable, Equatable {
    enum State: Equatable { case running, finished(exitCode: Int?) }
    let id: String
    let title: String
    let command: String
    let output: String
    let state: State
    let startedAt: Date
    let finishedAt: Date?
}

enum ChatBackgroundJobs {
    static func parse(_ messages: [AgentChatMessage], firstSeen: [String: Date], now: Date = .now) -> [ChatBackgroundJob] {
        var results: [String: AgentChatMessage] = [:]
        var notifications: [String: (summary: String, status: String, output: String)] = [:]
        for message in messages where message.role == .tool {
            if message.isToolResult, let id = message.toolCallID { results[id] = message }
            if message.title == "Background notification",
               let id = tag("tool-use-id", in: message.text) {
                notifications[id] = (tag("summary", in: message.text) ?? "Background command finished",
                                     tag("status", in: message.text) ?? "completed",
                                     tag("output", in: message.text) ?? "")
            }
        }
        return messages.compactMap { message in
            guard message.role == .tool, !message.isToolResult, !message.isChange,
                  let id = message.toolCallID, isBackground(message) else { return nil }
            let presentation = ToolPresentation(title: message.title ?? "Tool", text: message.text)
            let result = results[id], notification = notifications[id]
            let resultText = result.map { ToolPresentation(title: $0.title ?? "Tool result", text: $0.text).body } ?? ""
            let output = notification?.output.isEmpty == false ? notification!.output : resultText
            let summary = notification?.summary ?? presentation.preview
            let code = exitCode(notification?.summary) ?? exitCode(resultText)
            let finished = notification?.status.lowercased() == "completed" || notification?.status.lowercased() == "failed" || result != nil
            return ChatBackgroundJob(id: id, title: summary.isEmpty ? "Background command" : summary,
                                     command: presentation.body, output: output,
                                     state: finished ? .finished(exitCode: code) : .running,
                                     startedAt: firstSeen[id] ?? now, finishedAt: finished ? now : nil)
        }
    }

    static func backgroundIDs(_ messages: [AgentChatMessage]) -> Set<String> {
        Set(messages.compactMap { message in
            guard message.role == .tool, !message.isToolResult, let id = message.toolCallID, isBackground(message) else { return nil }
            return id
        })
    }
    private static func isBackground(_ message: AgentChatMessage) -> Bool {
        let text = message.text.lowercased()
        guard ["shell", "tools"].contains(ToolPresentation(title: message.title ?? "Tool", text: message.text).title.lowercased()) else { return false }
        return text.range(of: #"[\"']?run_in_background[\"']?\s*[:=]\s*true"#, options: .regularExpression) != nil
            || text.range(of: #"[\"']?background[\"']?\s*[:=]\s*true"#, options: .regularExpression) != nil
            || text.range(of: #"[\"']?yield_time-ms[\"']?\s*[:=]"#, options: .regularExpression) != nil
            || text.range(of: #"[\"']?yield_time_ms[\"']?\s*[:=]"#, options: .regularExpression) != nil
    }
    private static func tag(_ name: String, in text: String) -> String? {
        guard let open = text.range(of: "<\(name)>"), let close = text.range(of: "</\(name)>", range: open.upperBound..<text.endIndex) else { return nil }
        return String(text[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func exitCode(_ text: String?) -> Int? {
        guard let text, let match = text.range(of: #"(?i)exit (?:code )?(-?\d+)"#, options: .regularExpression) else { return nil }
        return text[match].split(whereSeparator: { !$0.isNumber && $0 != "-" }).last.flatMap { Int($0) }
    }
}

struct ChatBackgroundJobsView: View {
    let jobs: [ChatBackgroundJob]
    @State private var expanded: Set<String> = []
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { tick in
            VStack(alignment: .leading, spacing: 5) {
                HStack { Label("Background", systemImage: "clock.arrow.circlepath").font(.caption.weight(.semibold)); Spacer(); Text("\(jobs.count)").font(.caption.monospacedDigit()) }
                ForEach(jobs) { job in
                    Button { if expanded.contains(job.id) { expanded.remove(job.id) } else { expanded.insert(job.id) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Circle().fill(job.state == .running ? PhrenTheme.cyan : PhrenTheme.success).frame(width: 6, height: 6)
                                Text(job.title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                                Text(status(job, at: tick.date)).foregroundStyle(PhrenTheme.chatNeutralDim)
                                Image(systemName: "chevron.down").rotationEffect(.degrees(expanded.contains(job.id) ? 180 : 0))
                            }
                            if expanded.contains(job.id) {
                                Text(job.command).foregroundStyle(PhrenTheme.chatNeutral).lineLimit(4)
                                if !job.output.isEmpty { Text(ToolOutputPreview(job.output, lines: 8, characters: 1_200).text).foregroundStyle(PhrenTheme.chatText).lineLimit(8) }
                            }
                        }.font(.system(.caption, design: .monospaced)).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("chat-background-job:\(job.id)")
                }
            }.padding(10).background(PhrenTheme.toolPanel, in: RoundedRectangle(cornerRadius: 14))
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

struct ChatReadRun: View {
    let messages: [AgentChatMessage]
    var resultImages: ((AgentChatMessage) -> AnyView)? = nil
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var groups: [ChatTimelineEntry] {
        // The outer grouping has already established the run. Re-grouping
        // restores the exact call/result cards shown before it was folded.
        ChatTimelineEntry.group(messages).flatMap { entry in
            entry.isReadRun ? split(entry.messages) : [entry]
        }
    }
    private func split(_ messages: [AgentChatMessage]) -> [ChatTimelineEntry] {
        var result: [ChatTimelineEntry] = [], current: [AgentChatMessage] = []
        for message in messages {
            if message.role == .tool, !message.isToolResult, !message.isChange, !current.isEmpty {
                result.append(.init(messages: current, kind: .activity)); current = []
            }
            current.append(message)
        }
        if !current.isEmpty { result.append(.init(messages: current, kind: .activity)) }
        return result
    }
    private var names: [String] {
        groups.compactMap { group in
            group.messages.first(where: { !$0.isToolResult && !$0.isChange }).map {
                ToolPresentationCache.value($0).title
            }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: expanded ? 8 : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "doc.text.magnifyingglass").foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                    Text("\(groups.count) reads").fontWeight(.semibold).foregroundStyle(PhrenTheme.chatText)
                    Text(names.prefix(4).joined(separator: ", ") + (names.count > 4 ? "…" : ""))
                        .foregroundStyle(PhrenTheme.chatNeutral).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.chatNeutralDim)
                }.font(.system(.caption, design: .monospaced)).padding(.horizontal, 12).frame(minHeight: 38)
            }.buttonStyle(.plain)
                .accessibilityLabel("\(groups.count) read operations")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("chat-read-run:\(messages[0].id)")
            if expanded {
                ForEach(groups) { group in
                    ChatToolActivity(messages: group.messages, resultImages: resultImages).equatable()
                }.padding(.horizontal, 8)
            }
        }.padding(.bottom, expanded ? 8 : 0)
            .background(PhrenTheme.toolPanel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(PhrenTheme.border, lineWidth: 0.5))
    }
}

struct ChatToolSummary {
    let title: String
    let icon: String
    let preview: String
    let count: Int

    init(_ messages: [AgentChatMessage]) {
        // What a call changed on disk is listed under it, not counted as a call.
        let calls = messages.filter { $0.title != "Tool result" && !$0.isChange }
        let presentations = calls.map(ToolPresentationCache.value)
        let names = presentations.map(\.title)
        title = Set(names).count == 1 ? names[0] : calls.isEmpty ? "Tool results" : "Activity"
        icon = title == "Shell" ? "terminal" : title == "Browse" ? "globe" : title == "Patch" ? "pencil.line" : title == "Write" ? "doc.badge.plus" : "wrench.and.screwdriver"
        count = max(1, calls.isEmpty ? messages.count : calls.count)
        preview = presentations.last?.preview ?? messages.last.map { ToolPresentationCache.value($0).preview } ?? ""
    }
}

struct ChatToolActivity: View, Equatable {
    let messages: [AgentChatMessage]
    /// Draws the images a tool result carries (a Read of a screenshot), given
    /// the live session; nil where a card is shown without one.
    var resultImages: ((AgentChatMessage) -> AnyView)? = nil
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.messages == rhs.messages }
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let summary = ChatToolSummary(messages)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: summary.icon).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                    Text(summary.title).fontWeight(.semibold).foregroundStyle(PhrenTheme.chatText).lineLimit(1)
                    if summary.count > 1 { Text("×\(summary.count)").foregroundStyle(PhrenTheme.chatNeutralDim) }
                    Text(summary.preview).foregroundStyle(PhrenTheme.chatNeutral).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if messages.contains(where: \.isToolResult) {
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .medium)).foregroundStyle(PhrenTheme.chatNeutralDim)
                    }
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.chatNeutralDim)
                }
                .font(.system(.caption, design: .monospaced))
                .padding(.horizontal, 12).padding(.vertical, 4).frame(minHeight: 34)
                .contentShape(Rectangle().inset(by: -5))
            }.buttonStyle(.plain)
                .accessibilityLabel("\(summary.title), \(summary.count) \(summary.count == 1 ? "operation" : "operations")")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityHint("Expand this call and its output")
                .accessibilityIdentifier("chat-tool-group:\(messages[0].id)")
            // What the command changed, right there under the call without
            // opening the card — the way a terminal shows "Updated file
            // (+n −m)" and the lines beneath it.
            let changed = messages.filter(\.isChange)
            if !expanded, !changed.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(changed.prefix(4)) { change in
                        CodeDiffView(patch: change.text, previewLineLimit: 12, collapsible: true)
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("chat-tool-change:\(change.id)")
                    }
                    if changed.count > 4 {
                        Text("+\(changed.count - 4) more files").font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutralDim)
                    }
                }
                .padding(.horizontal, 10).padding(.bottom, 10)
            }
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(messages) { message in
                        // The call and its output, both in full: the command
                        // is what tells you what happened, so it is never
                        // folded behind a disclosure.
                        ToolDetailView(presentation: ToolPresentationCache.value(message),
                                       id: message.id, isResult: message.isToolResult, collapsible: message.isChange)
                        if message.isToolResult, !message.resultImages.isEmpty, let resultImages { resultImages(message) }
                    }
                }.padding(.horizontal, 10).padding(.bottom, 10)
            }
        }
        .background(PhrenTheme.toolPanel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(PhrenTheme.border, lineWidth: 0.5))
    }
}

private struct ToolDetailView: View {
    let presentation: ToolPresentation
    let id: String
    var isResult = false
    var collapsible = false
    @AppStorage(ChatSettings.wrapKey) private var wrap = false
    @Environment(\.openToolOutput) private var openToolOutput
    @State private var showMore = false
    /// Six lines in the card, eighty once opened; the sheet has the rest.
    private static let previewLines = 6, moreLines = 80

    private var lineCount: Int { presentation.body.components(separatedBy: "\n").count }
    private var hasMore: Bool { lineCount > Self.previewLines || presentation.body.count > 640 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let patch = presentation.patch { CodeDiffView(patch: patch, previewLineLimit: collapsible ? 12 : 8, collapsible: collapsible) }
            else {
                HStack(spacing: 8) {
                    Text(isResult ? "Output" : presentation.title).fontWeight(.medium)
                    Spacer()
                    Button("View full output", systemImage: "arrow.up.left.and.arrow.down.right") {
                        openToolOutput(.init(title: isResult ? "Tool Result" : presentation.title, text: presentation.body))
                    }.frame(width: 36, height: 32).contentShape(Rectangle())
                        .accessibilityIdentifier("chat-tool-output:\(id)")
                    Button("Copy tool details", systemImage: "doc.on.doc") { UIPasteboard.general.string = presentation.body }
                        .frame(width: 36, height: 32).contentShape(Rectangle())
                }.font(.caption2).foregroundStyle(PhrenTheme.chatNeutral)
                    .labelStyle(.iconOnly).buttonStyle(.plain).frame(minHeight: 32)
                if isResult {
                    // Terminal output keeps its columns: scroll sideways
                    // rather than wrapping a table or a stack trace.
                    ScrollView(wrap ? [] : [.horizontal]) {
                        Text(presentation.body.isEmpty ? "No output"
                             : ToolOutputPreview(presentation.body, lines: showMore ? Self.moreLines : Self.previewLines,
                                                 characters: showMore ? 16_000 : 640).text)
                            .font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                            .fixedSize(horizontal: !wrap, vertical: false).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("chat-tool-preview:\(id)")
                    }
                } else {
                    // A command wraps — every character of it matters more
                    // than its columns.
                    Text(presentation.body.isEmpty ? "No input"
                         : ToolOutputPreview(presentation.body, lines: showMore ? Self.moreLines : 12, characters: showMore ? 16_000 : 2_000).text)
                        .font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
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
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        let contents = output.contents
        let current = contents.pages[page]
        ScrollView([.horizontal, .vertical]) {
                Text(current.displayText).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(PhrenTheme.chatText).textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true).padding(16)
            }
            .id(page)
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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("chat-tool-output-done")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Copy output", systemImage: "doc.on.doc") { UIPasteboard.general.string = contents.source }
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
struct ToolOutputPreview {
    let text: String
    init(_ output: String, lines maximumLines: Int = 6, characters: Int = 640) {
        let bounded = output.prefix(characters + 1)
        let prefix = String(bounded.prefix(characters))
        let lines = prefix.components(separatedBy: .newlines)
        let visible = lines.prefix(maximumLines).joined(separator: "\n")
        text = visible + (bounded.count > characters || lines.count > maximumLines ? "…" : "")
    }
}
