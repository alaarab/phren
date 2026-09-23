import PhrenKit
import SwiftUI

struct FileTextView: View {
    let url: URL
    let kind: FilePreviewKind
    @State private var text = ""
    @State private var csv: [[String]] = []
    @State private var json: FileJSONNode?
    @State private var cursor = FileTextCursor()
    @State private var next = FileTextCursor()
    @State private var history: [FileTextCursor] = []
    @State private var eof = false
    @State private var loading = false
    @State private var error: String?
    @State private var page = 0
    @State private var expanded = true
    var body: some View {
        VStack(spacing: 0) {
            if let error { Text(error).foregroundStyle(PhrenTheme.warning).padding() }
            ScrollView([.horizontal, .vertical]) {
                if kind == .csv {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(csv.enumerated()), id: \.offset) { row, fields in
                            HStack(alignment: .top, spacing: 0) {
                                ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                                    Text(field).font(PhrenTypography.monoFootnote).textSelection(.enabled)
                                        .frame(width: 180, alignment: .leading).padding(10)
                                        .background(row == 0 && page == 0 ? PhrenTheme.surfaceRaised : PhrenTheme.surface)
                                        .overlay(Rectangle().stroke(PhrenTheme.border, lineWidth: 0.5))
                                }
                            }
                        }
                    }
                } else if let json {
                    FileJSONRow(node: json, label: nil, identity: "root").padding(16)
                } else if kind == .markdown {
                    ChatRichText(text: text).frame(minWidth: 280, maxWidth: 680, alignment: .leading).padding(16)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        if kind == .json {
                            Button { expanded.toggle() } label: {
                                HStack {
                                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                                    Text("JSON page \(page + 1)")
                                }.font(PhrenTypography.subheadline).frame(minHeight: 44)
                            }.buttonStyle(.plain).phrenIdentifier("file-json-page-fold")
                        }
                        if kind != .json || expanded {
                            Text(CodeHighlighting.highlightedBlock(text, language: .detect(kind == .json ? "json" : url.pathExtension)))
                                .font(PhrenTypography.monoFootnote).textSelection(.enabled)
                        }
                    }.padding(16)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            if json == nil {
                HStack {
                    PhrenIconButton(icon: "chevron.left", label: "Previous text page") {
                        guard let prior = history.popLast() else { return }; cursor = prior; page -= 1
                    }.disabled(history.isEmpty || loading).phrenIdentifier("file-text-previous")
                    Spacer()
                    Text(loading ? "Reading…" : "Page \(page + 1)").font(PhrenTypography.monoCaption)
                    Spacer()
                    PhrenIconButton(icon: "chevron.right", label: "Next text page") {
                        history.append(cursor); cursor = next; page += 1
                    }.disabled(eof || loading).phrenIdentifier("file-text-next")
                }.padding(.horizontal, 12).background(PhrenTheme.surface)
            }
        }.phrenContainerMarker("file-viewer-\(kind.rawValue)", label: "File text")
            .task(id: page) { await read() }
    }
    @MainActor private func read() async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let url = url, kind = kind, position = cursor
            let result = try await Task.detached(priority: .userInitiated) { () -> TextResult in
                if kind == .csv {
                    let page = try FileCSVPage.read(url: url, offset: position.offset)
                    var next = FileTextCursor(); next.offset = page.nextOffset
                    return TextResult(text: "", csv: page.rows, next: next, eof: page.eof)
                }
                // A bounded JSON object offers semantic per-node folding. Larger
                // documents use a streaming pretty printer and foldable pages.
                if kind == .json, position.offset == 0,
                   let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber, size.intValue <= 1_048_576 {
                    let data = try Data(contentsOf: url)
                    let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
                    return TextResult(text: "", json: try FileJSONNode.make(object, depth: 0), next: position, eof: true)
                }
                let page = try FileTextPage.read(url: url, cursor: position, json: kind == .json)
                return TextResult(text: page.text, next: page.next, eof: page.eof)
            }.value
            try Task.checkCancellation()
            text = result.text; csv = result.csv; json = result.json; next = result.next; eof = result.eof
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private struct TextResult: Sendable {
        var text: String
        var csv: [[String]] = []
        var json: FileJSONNode?
        var next: FileTextCursor
        var eof: Bool
    }
}

indirect enum FileJSONNode: Sendable {
    case object([(String, FileJSONNode)])
    case array([FileJSONNode])
    case value(String)
    static func make(_ value: Any, depth: Int) throws -> Self {
        guard depth < 64 else { throw PhrenKitError.validation("This JSON is nested too deeply. Save or share the file to read it elsewhere.") }
        if let object = value as? [String: Any] { return .object(try object.keys.sorted().map { ($0, try make(object[$0]!, depth: depth + 1)) }) }
        if let array = value as? [Any] { return .array(try array.map { try make($0, depth: depth + 1) }) }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        return .value(String(decoding: data, as: UTF8.self))
    }
    var children: [(String, FileJSONNode)] {
        switch self {
        case .object(let values): return values
        case .array(let values): return values.enumerated().map { (String($0.offset), $0.element) }
        case .value: return []
        }
    }
    var summary: String {
        switch self {
        case .object(let values): return "{ \(values.count) keys }"
        case .array(let values): return "[ \(values.count) items ]"
        case .value(let value): return value
        }
    }
}
private struct FileJSONRow: View {
    let node: FileJSONNode
    let label: String?
    let identity: String
    @State private var expanded = true
    @State private var visible = 100
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if node.children.isEmpty {
                Text((label.map { "\($0): " } ?? "") + node.summary)
                    .font(PhrenTypography.monoFootnote).textSelection(.enabled).padding(.vertical, 4)
            } else {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").accessibilityHidden(true)
                        Text((label.map { "\($0): " } ?? "") + node.summary)
                    }.font(PhrenTypography.monoFootnote).frame(minHeight: 44)
                }.buttonStyle(.plain).phrenIdentifier("file-json-fold:\(identity)")
                if expanded {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(node.children.prefix(visible).enumerated()), id: \.offset) { index, child in
                            FileJSONRow(node: child.1, label: child.0, identity: "\(identity)/\(index)")
                        }
                        if node.children.count > visible {
                            Button("Show next 100 items") { visible += 100 }.buttonStyle(.plain).frame(minHeight: 44)
                        }
                    }.padding(.leading, 18)
                }
            }
        }
    }
}
