import Foundation
import PhrenKit
import SwiftUI

/// What one finished agent turn changed, read from the transcript alone: the
/// Hook's before/after patches under shell calls (`Changes` rows) and the
/// patches edit calls carry in their input (Edit, MultiEdit, Write,
/// apply_patch). Git is never asked, because another agent may be editing the
/// same checkout and its work is not this turn's.
struct ChatTurnChanges: Hashable, Identifiable {
    struct File: Hashable, Identifiable {
        let path: String
        /// A, D or M, as the diff badges read them.
        let status: String
        /// Every piece this turn wrote to the file, in order, as one patch.
        let patch: String
        let added: Int
        let removed: Int
        var id: String { path }
    }
    let ownerID: String
    let files: [File]
    var id: String { ownerID }
    var added: Int { files.reduce(0) { $0 + $1.added } }
    var removed: Int { files.reduce(0) { $0 + $1.removed } }
    var title: String { files.count == 1 ? "1 file changed" : "\(files.count) files changed" }
    var spokenLabel: String { "\(title), \(added) added, \(removed) removed" }
    var identifier: String { "chat-turn-changes:\(ownerID)" }

    static let maximumFiles = 200

    /// The change set of the rows between a turn's user message and its end,
    /// or nil when the turn changed no files.
    /// `root` is the pane's folder: an absolute path inside it is named
    /// relative to it, as the Hook and Codex name files.
    static func collect(ownerID: String, rows: [AgentChatMessage], root: String? = nil) -> Self? {
        let key = ownerID + "|" + (root ?? "") + "|" + rows.lazy.filter { $0.role == .tool }.map(\.renderKey).joined(separator: ",")
        if let cached = ChatTurnChangesCache.value(key) { return cached.changes }
        let changes = build(ownerID: ownerID, rows: rows, root: root)
        ChatTurnChangesCache.store(changes, key: key)
        return changes
    }

    private static func build(ownerID: String, rows: [AgentChatMessage], root: String?) -> Self? {
        let tools = rows.filter { $0.role == .tool }
        guard !tools.isEmpty else { return nil }
        // A call the Hook measured on disk is described by its Changes rows;
        // a call that failed wrote nothing, whatever its input said.
        let captured = Set(tools.filter(\.isChange).compactMap(\.toolCallID))
        let failed = Set(tools.filter { $0.isToolResult && $0.isToolError }.compactMap(\.toolCallID))
        var pieces: [Piece] = []
        for message in tools {
            if message.isChange {
                pieces += Self.pieces(message.text)
            } else if !message.isToolResult, !message.isCompaction, message.title != "Background notification" {
                if let id = message.toolCallID, captured.contains(id) || failed.contains(id) { continue }
                guard let patch = ToolPresentationCache.value(message).patch else { continue }
                pieces += Self.pieces(patch)
            }
        }
        guard !pieces.isEmpty else { return nil }
        // Claude's Edit names a file by its absolute path where the Hook and
        // Codex name it inside the repository: fold the two together.
        let relative = Set(pieces.map(\.path).filter { !$0.hasPrefix("/") })
        let folder = root.map { $0.hasSuffix("/") ? $0 : $0 + "/" }
        func canonical(_ path: String) -> String {
            guard path.hasPrefix("/") else { return path }
            if let folder, path.hasPrefix(folder), path.count > folder.count { return String(path.dropFirst(folder.count)) }
            return relative.filter { path.hasSuffix("/" + $0) }.max { $0.count < $1.count } ?? path
        }
        var order: [String] = [], grouped: [String: [Piece]] = [:]
        for piece in pieces {
            let path = canonical(piece.path)
            if grouped[path] == nil {
                guard order.count < maximumFiles else { continue }
                order.append(path)
            }
            grouped[path, default: []].append(piece)
        }
        let files = order.compactMap { path -> File? in
            guard let parts = grouped[path], let first = parts.first, let last = parts.last else { return nil }
            let status = last.status == "D" ? "D" : first.status == "A" ? "A" : "M"
            let header = status == "A" ? "*** Add File: " : status == "D" ? "*** Delete File: " : "*** Update File: "
            var lines = [header + path]
            var added = 0, removed = 0
            for part in parts {
                // Each piece is its own hunk: an Add's lines have no `@@` of
                // their own, and would not read as changes after another's.
                if let head = part.lines.first, !head.hasPrefix("@@") { lines.append("@@") }
                var inside = part.status == "A"
                for line in part.lines {
                    if line.hasPrefix("@@") { inside = true }
                    else if inside, line.hasPrefix("+") { added += 1 }
                    else if inside, line.hasPrefix("-") { removed += 1 }
                    lines.append(line)
                }
            }
            return File(path: path, status: status, patch: lines.joined(separator: "\n"), added: added, removed: removed)
        }
        return files.isEmpty ? nil : .init(ownerID: ownerID, files: files)
    }

    struct Piece: Equatable {
        let path: String
        var status: String
        var lines: [String]
    }

    /// One piece per file named in a patch: the apply_patch form (Update,
    /// Add, Delete sections) or git's unified form, headers dropped.
    static func pieces(_ patch: String) -> [Piece] {
        var result: [Piece] = []
        var current: Piece?
        var gitHeader = false
        func flush() { if let current { result.append(current) }; current = nil }
        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw.hasSuffix("\r") ? raw.dropLast() : raw)
            let sections: [(String, String)] = [("*** Update File: ", "M"), ("*** Add File: ", "A"), ("*** Delete File: ", "D")]
            if let (prefix, status) = sections.first(where: { line.hasPrefix($0.0) }) {
                flush()
                let path = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
                if !path.isEmpty { current = Piece(path: path, status: status, lines: []) }
                gitHeader = false
            } else if line.hasPrefix("diff --git ") {
                flush()
                if let range = line.range(of: " b/", options: .backwards) {
                    current = Piece(path: String(line[range.upperBound...]), status: "M", lines: [])
                }
                gitHeader = true
            } else if line.hasPrefix("*** ") {
                // Begin, End, End of File, Move to: framing, not content.
                continue
            } else if gitHeader {
                if line.hasPrefix("new file mode") { current?.status = "A" }
                else if line.hasPrefix("deleted file mode") { current?.status = "D" }
                else if line.hasPrefix("@@") { gitHeader = false; current?.lines.append(line) }
            } else if current != nil {
                current?.lines.append(line)
            }
        }
        flush()
        // A trailing newline leaves one empty line that is not content.
        return result.map { piece in
            var piece = piece
            while piece.lines.last == "" { piece.lines.removeLast() }
            return piece
        }
    }
}

/// Keyed by the turn's owner and every tool row's content revision, so a
/// finished turn is read once however often its activity context changes.
enum ChatTurnChangesCache {
    final class Box: NSObject { let changes: ChatTurnChanges?; init(_ changes: ChatTurnChanges?) { self.changes = changes } }
    private static let values: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>(); cache.countLimit = 400; return cache
    }()
    static func value(_ key: String) -> Box? { values.object(forKey: key as NSString) }
    static func store(_ changes: ChatTurnChanges?, key: String) { values.setObject(Box(changes), forKey: key as NSString) }
}

/// The quiet row at the end of a turn that changed files: one 44-point pill
/// with the count and the lines, opening the turn's combined diff.
struct ChatTurnChangesRow: View, Equatable {
    let changes: ChatTurnChanges
    @Environment(\.openTurnChanges) private var open
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.changes == rhs.changes }
    var body: some View {
        Button { open(changes) } label: {
            HStack(spacing: 7) {
                Image(systemName: "plusminus").font(PhrenTypography.icon(14)).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                Text(changes.title).fontWeight(.semibold).foregroundStyle(PhrenTheme.chatText).lineLimit(1)
                DiffCounts(added: changes.added, removed: changes.removed)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(PhrenTypography.icon(12, weight: .semibold)).foregroundStyle(PhrenTheme.chatNeutralDim)
            }
            .font(PhrenTypography.footnote)
            .padding(.horizontal, 12).frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .phrenPanel(tool: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(changes.spokenLabel)
        .accessibilityHint("Open what this turn changed")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { open(changes) }
        .accessibilityIdentifier(changes.identifier)
    }
}

/// Everything one turn changed, file by file, drawn with the chat's own diff
/// cards. Each card's title bar folds it; its open button shows the file's
/// full diff.
struct ChatTurnDiffView: View {
    let changes: ChatTurnChanges
    @State private var fullDiff: ChatFullDiff?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PhrenTheme.Space.medium) {
                HStack(spacing: 10) {
                    Text(changes.title).font(PhrenTheme.Font.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                    Spacer(minLength: 8)
                    DiffCounts(added: changes.added, removed: changes.removed)
                }
                .accessibilityElement(children: .ignore).accessibilityLabel(changes.spokenLabel)
                .accessibilityIdentifier("chat-turn-diff-summary")
                ForEach(changes.files) { file in
                    CodeDiffView(patch: file.patch, cacheKey: "turn|\(changes.ownerID)|\(file.path)|\(file.patch.hashValue)",
                                 previewLineLimit: 40, collapsible: true, initiallyOpen: changes.files.count <= 6).equatable()
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 12)
        }
        .background(PhrenTheme.chatCanvas)
        .environment(\.openChatDiff) { fullDiff = $0 }
        .navigationTitle("Turn changes").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .navigationDestination(item: $fullDiff) { FileDiffView(file: $0.file, section: $0.section) }
    }
}
