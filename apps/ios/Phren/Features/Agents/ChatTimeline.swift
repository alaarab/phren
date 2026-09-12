import PhrenKit
import SwiftUI

struct ChatTimelineEntry: Identifiable {
    var messages: [AgentChatMessage]
    var id: String { messages[0].id }
    var isActivity: Bool { messages[0].role == .tool }

    static func group(_ messages: [AgentChatMessage]) -> [Self] {
        var entries: [Self] = []
        var previousMessageID: String?
        var calls: [String: Int] = [:], ambiguous: Set<String> = []
        for message in messages {
            guard message.role == .tool else {
                entries.append(.init(messages: [message]))
                calls.removeAll(keepingCapacity: true); ambiguous.removeAll(keepingCapacity: true)
                previousMessageID = message.id
                continue
            }
            if message.isToolResult {
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
            entries.append(.init(messages: [message]))
            previousMessageID = message.id
        }
        return entries
    }
}

struct ChatToolSummary {
    let title: String
    let icon: String
    let preview: String
    let count: Int

    init(_ messages: [AgentChatMessage]) {
        let calls = messages.filter { $0.title != "Tool result" }
        let presentations = calls.map { ToolPresentation(title: $0.title ?? "Tool", text: $0.text) }
        let names = presentations.map(\.title)
        title = Set(names).count == 1 ? names[0] : calls.isEmpty ? "Tool results" : "Activity"
        icon = title == "Shell" ? "terminal" : title == "Browse" ? "globe" : title == "Patch" ? "pencil.line" : "wrench.and.screwdriver"
        count = max(1, calls.isEmpty ? messages.count : calls.count)
        preview = presentations.last?.preview ?? messages.last.map { ToolPresentation(title: $0.title ?? "Tool result", text: $0.text).preview } ?? ""
    }
}

struct ChatToolActivity: View, Equatable {
    let messages: [AgentChatMessage]
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
                    Image(systemName: summary.icon).foregroundStyle(PhrenTheme.textDim).frame(width: 14)
                    Text(summary.title).fontWeight(.semibold).foregroundStyle(PhrenTheme.textSecondary).lineLimit(1)
                    if summary.count > 1 { Text("×\(summary.count)").foregroundStyle(PhrenTheme.textDim) }
                    Text(summary.preview).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if messages.contains(where: \.isToolResult) {
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .medium)).foregroundStyle(PhrenTheme.textDim)
                    }
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(PhrenTheme.textDim)
                }
                .font(.system(.caption2, design: .monospaced))
                .padding(.horizontal, 12).padding(.vertical, 4).frame(minHeight: 34)
                .contentShape(Rectangle().inset(by: -5))
            }.buttonStyle(.plain)
                .accessibilityLabel("\(summary.title), \(summary.count) \(summary.count == 1 ? "operation" : "operations")")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityHint("Expand this call and its output")
                .accessibilityIdentifier("chat-tool-group:\(messages[0].id)")
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(messages) { message in
                        let presentation = ToolPresentation(title: message.title ?? "Tool activity", text: message.text)
                        if !message.isToolResult, presentation.patch == nil, messages.contains(where: \.isToolResult) {
                            DisclosureGroup("Input details") {
                                ToolDetailView(presentation: presentation, id: message.id)
                            }.font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                        } else {
                            ToolDetailView(presentation: presentation, id: message.id)
                        }
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
    @State private var fullOutput: FullToolOutput?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let patch = presentation.patch { CodeDiffView(patch: patch, previewLineLimit: 8) }
            else {
                HStack(spacing: 8) {
                    Text(presentation.title == "Tool Result" ? "Output" : presentation.title).fontWeight(.medium)
                    Spacer()
                    Button("View full output", systemImage: "arrow.up.left.and.arrow.down.right") {
                        fullOutput = .init(title: presentation.title, text: presentation.body)
                    }.frame(width: 36, height: 32).contentShape(Rectangle())
                        .accessibilityIdentifier("chat-tool-output:\(id)")
                    Button("Copy tool details", systemImage: "doc.on.doc") { UIPasteboard.general.string = presentation.body }
                        .frame(width: 36, height: 32).contentShape(Rectangle())
                }.font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                    .labelStyle(.iconOnly).buttonStyle(.plain).frame(minHeight: 32)
                Text(presentation.body.isEmpty ? "No output" : ToolOutputPreview(presentation.body).text)
                    .font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.text)
                    .lineLimit(6).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat-tool-preview:\(id)")
            }
            if presentation.raw != presentation.body {
                Button("Raw details") { fullOutput = .init(title: "Raw details", text: presentation.raw) }
                    .font(.caption2).foregroundStyle(PhrenTheme.textDim).padding(.vertical, 4)
            }
        }
        .sheet(item: $fullOutput) { output in FullToolOutputView(output: output) }
    }
}

private struct FullToolOutput: Identifiable {
    let id = UUID()
    let title: String
    let contents: ToolOutputPages
    init(title: String, text: String) {
        self.title = title; contents = .init(text)
    }
}

private struct FullToolOutputView: View {
    let output: FullToolOutput
    @State private var page = 0
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        let contents = output.contents
        let current = contents.pages[page]
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                Text(current.displayText).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(PhrenTheme.text).textSelection(.enabled)
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
        }.presentationDetents([.large])
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
    init(_ output: String) {
        let bounded = output.prefix(641)
        let prefix = String(bounded.prefix(640))
        let lines = prefix.components(separatedBy: .newlines)
        let visible = lines.prefix(6).joined(separator: "\n")
        text = visible + (bounded.count > 640 || lines.count > 6 ? "…" : "")
    }
}
