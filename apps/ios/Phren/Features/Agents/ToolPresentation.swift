import Foundation

/// Display-only decoding. Never evaluate tool arguments or discard the raw
/// source: unfamiliar provider envelopes remain available in Raw details.
struct ToolPresentation {
    let title: String
    let body: String
    let patch: String?
    let path: String?
    /// A short qualifier after the path — "lines 10–50", "in src/".
    var note: String? = nil
    let raw: String
    /// Whether this call looks like it wrote to files — a heredoc, `sed -i`,
    /// a redirect, `tee`, a Python `open(..., "w")`, `git apply` — so the
    /// chat can offer the repository diff that shows what actually changed.
    /// Only for commands: Write/Edit already carry their own patch.
    var editsFiles: Bool {
        guard patch == nil, ["Shell", "Tools"].contains(title) else { return false }
        return Self.fileEdit.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)) != nil
    }
    private static let fileEdit = try! NSRegularExpression(pattern: #"(?m)(<<-?\s*['"]?\w+['"]?|\bsed\s+-[a-zA-Z]*i|\btee\b|(?<![<>&|\d])>{1,2}\s*[~./\w-]+|\bopen\([^)]*['"][wa]\+?['"]|\.write_(?:text|bytes)\(|\bwriteFile(?:Sync)?\(|\bjson\.dump\(|\bgit\s+(?:apply|mv|rm|checkout|restore|stash|commit)\b|\bpatch\s+-p\d|\b(?:cp|mv|rm|touch|mkdir|ln)\s+-?\w*\s*[~./\w-]+|\bnpm\s+(?:i|install|uninstall)\b|\bpnpm\s+(?:add|remove)\b|\bpip3?\s+(?:install|uninstall)\b|\bcargo\s+(?:add|remove)\b|\bgo\s+(?:get|mod)\b)"#)

    /// The places the command named — `/…`, `~/…` or `./…` — so the diff can
    /// look them up even when they sit in another repository, or were
    /// committed by a hook before anyone looked. Absolute system paths such
    /// as `/dev/null` are harmless: the computer keeps to your home folder.
    var editedPaths: [String] {
        guard editsFiles else { return [] }
        var seen = Set<String>(), paths: [String] = []
        for match in Self.pathLiteral.matches(in: body, range: NSRange(body.startIndex..., in: body)) {
            guard let range = Range(match.range, in: body) else { continue }
            let path = String(body[range])
            guard path.count > 2, seen.insert(path).inserted else { continue }
            paths.append(path)
            if paths.count == 24 { break }
        }
        return paths
    }
    private static let pathLiteral = try! NSRegularExpression(pattern: #"(?<![\w@:/])(?:~/|\./|/)[\w.@+~-]+(?:/[\w.@+~-]+)*"#)

    var preview: String {
        // The file, not its whole absolute path: the last two components
        // read like VS Code's "folder/file" and leave room for the counts.
        if let path { return Self.short(path) + (note.map { " · " + $0 } ?? "") }
        let start = body.firstIndex(where: { !$0.isNewline }) ?? body.endIndex
        let first = String(body[start...].prefix(180).prefix { !$0.isNewline })
        // A tool whose input is a bare JSON object has no summary field we
        // know: read its first real field rather than the opening brace.
        if ["{", "[", "{}", "[]"].contains(first) {
            return body.components(separatedBy: "\n")
                .lazy.map { $0.trimmingCharacters(in: .whitespaces) }
                .first { !$0.isEmpty && !["{", "}", "[", "]"].contains($0) }
                .map { String($0.prefix(180)) } ?? ""
        }
        return first
    }

    init(title rawTitle: String, text: String) {
        raw = text
        let name = rawTitle.split(separator: ".").last.map(String.init) ?? rawTitle
        var body = text
        var title = Self.name(name)
        var path: String?
        let fields = Self.json(text) as? [String: Any]
        if rawTitle == "Tool result" {
            body = Self.unwrap(text)
        } else if let fields {
            path = fields["file_path"] as? String ?? fields["path"] as? String ?? fields["notebook_path"] as? String
            let edits = (fields["edits"] as? [[String: Any]] ?? []).compactMap { edit -> (String, String)? in
                guard let old = edit["old_string"] as? String, let new = edit["new_string"] as? String else { return nil }
                return (old, new)
            }
            if let old = (fields["old_string"] ?? fields["old_str"]) as? String, let new = (fields["new_string"] ?? fields["new_str"]) as? String {
                body = Self.updatePatch(path, edits: [(old, new)]); title = "Patch"
            } else if !edits.isEmpty {
                // MultiEdit: one file, several replacements — one hunk each.
                body = Self.updatePatch(path, edits: edits); title = "Patch"
            } else if let source = fields["new_source"] as? String, name == "NotebookEdit" {
                body = Self.updatePatch(path, edits: [("", source)]); title = "Patch"
            } else if let content = (fields["content"] ?? fields["file_text"]) as? String, path != nil {
                // Write: the whole file as it now stands, every line new.
                body = "*** Add File: \(path!)\n"
                    + content.components(separatedBy: "\n").map { "+" + $0 }.joined(separator: "\n")
                title = "Write"
            } else if name == "Read", let file = path {
                // Claude Code's Read: the file and, when paged, the window.
                let offset = fields["offset"] as? Int, limit = fields["limit"] as? Int
                if let offset { note = "lines \(offset)–\(limit.map { offset + $0 - 1 }.map(String.init) ?? "end")" }
                else if let limit { note = "first \(limit) lines" }
                body = file + (note.map { " · " + $0 } ?? "")
            } else if ["Grep", "Glob"].contains(name), let pattern = fields["pattern"] as? String {
                let scope = (fields["path"] as? String).map(Self.short) ?? (fields["glob"] as? String)
                body = pattern + (scope.map { " in " + $0 } ?? "")
                path = nil
            } else if let todos = fields["todos"] as? [[String: Any]], !todos.isEmpty {
                body = todos.compactMap { todo -> String? in
                    guard let content = todo["content"] as? String else { return nil }
                    let status = todo["status"] as? String ?? ""
                    return (status == "completed" ? "☑ " : status == "in_progress" ? "◐ " : "☐ ") + content
                }.joined(separator: "\n")
            } else {
                body = ["cmd", "command", "patch", "input", "query", "q", "url", "description", "prompt", "summary", "message", "to", "recipient", "subject"].compactMap { fields[$0] as? String }.first ?? Self.pretty(fields)
            }
        } else if ["exec", "parallel"].contains(name) {
            // Extract only JSON string literals, without executing JavaScript.
            // Computed arguments stay as source, rather than guessing a command.
            let commands = Self.literals(text, pattern: #"(?:\"cmd\"|\bcmd|\"command\"|\bcommand)\s*:\s*(\"(?:\\.|[^\"\\])*\")"#)
            let patches = Self.literals(text, pattern: #"\btools\.apply_patch\(\s*(\"(?:\\.|[^\"\\])*\")"#)
            if !patches.isEmpty { body = patches.joined(separator: "\n"); title = "Patch" }
            else if !commands.isEmpty { body = commands.joined(separator: "\n\n"); title = "Shell" }
        }
        let hasPatch = body.contains("*** Begin Patch") || body.contains("*** Update File:") || body.contains("*** Add File:") || body.contains("*** Delete File:")
            || body.contains("diff --git ") || body.range(of: #"(?m)^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@"#, options: .regularExpression) != nil
        if hasPatch {
            path = path ?? body.components(separatedBy: "\n").first(where: { $0.hasPrefix("*** Update File: ") || $0.hasPrefix("*** Add File: ") || $0.hasPrefix("*** Delete File: ") || $0.hasPrefix("+++ b/") }).map {
                $0.replacingOccurrences(of: "*** Update File: ", with: "").replacingOccurrences(of: "*** Add File: ", with: "").replacingOccurrences(of: "*** Delete File: ", with: "").replacingOccurrences(of: "+++ b/", with: "")
            }
        }
        self.title = title; self.body = body; self.path = path; patch = hasPatch ? body : nil
    }

    /// The last two path components — enough to tell files apart on a phone.
    static func short(_ path: String) -> String {
        path.split(separator: "/").suffix(2).joined(separator: "/")
    }

    /// An Edit/MultiEdit as the apply_patch shape the diff renderer reads:
    /// the removed lines then the replacement, one `@@` hunk per edit.
    private static func updatePatch(_ path: String?, edits: [(String, String)]) -> String {
        "*** Update File: \(path ?? "File")\n" + edits.map { old, new in
            "@@\n" + old.components(separatedBy: "\n").map { "-" + $0 }.joined(separator: "\n") + "\n"
                + new.components(separatedBy: "\n").map { "+" + $0 }.joined(separator: "\n")
        }.joined(separator: "\n")
    }

    static func name(_ name: String) -> String {
        let components = name.components(separatedBy: "__")
        if components.count >= 3, components[0] == "mcp" {
            let server = components[1].replacingOccurrences(of: "_", with: " ").capitalized
            let tool = components.dropFirst(2).joined(separator: " ").replacingOccurrences(of: "_", with: " ").capitalized
            return "\(server) · \(tool)"
        }
        if ["exec_command", "bash", "shell", "Bash", "Shell", "write_stdin"].contains(name) { return "Shell" }
        if ["apply_patch", "Edit", "MultiEdit", "str_replace_editor"].contains(name) { return "Patch" }
        if ["exec", "parallel"].contains(name) { return "Tools" }
        if name == "LS" { return "List" }
        if name == "WebFetch" { return "Fetch" }
        if name == "WebSearch" { return "Search" }
        if name == "TodoWrite" { return "Todos" }
        if ["Task", "Agent"].contains(name) { return "Agent" }
        if name.contains("search") || name.contains("web") { return "Browse" }
        return name.replacingOccurrences(of: "_", with: " ").capitalized
    }
    private static func json(_ text: String) -> Any? {
        guard text.utf8.count <= 524_288 else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    }
    private static func pretty(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted, .fragmentsAllowed]) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
    static func unwrap(_ text: String, depth: Int = 0) -> String {
        guard depth < 5, let value = json(text) else { return text }
        if let string = value as? String { return unwrap(string, depth: depth + 1) }
        if let blocks = value as? [[String: Any]], !blocks.isEmpty,
           blocks.allSatisfy({ $0["text"] is String && ($0["type"] == nil || ["text", "input_text", "output_text"].contains($0["type"] as? String ?? "")) }) {
            return blocks.compactMap { $0["text"] as? String }.map { unwrap($0, depth: depth + 1) }.joined(separator: "\n\n")
        }
        if let fields = value as? [String: Any], let output = fields["output"] as? String,
           fields["exit_code"] != nil || fields["chunk_id"] != nil || fields["session_id"] != nil {
            let status = (fields["exit_code"] as? Int).flatMap { $0 == 0 ? nil : "Exit code: \($0)" }
            return [unwrap(output, depth: depth + 1), status].compactMap { $0 }.joined(separator: "\n")
        }
        return pretty(value)
    }
    private static func literals(_ text: String, pattern: String) -> [String] {
        guard text.utf8.count <= 524_288, let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).prefix(32).compactMap {
            guard let range = Range($0.range(at: 1), in: text) else { return nil }
            return json(String(text[range])) as? String
        }
    }
}

struct DiffPreview {
    enum Kind { case context, added, removed, hunk, header }
    struct Line: Identifiable {
        let id: Int
        let text: String
        let kind: Kind
        let old: Int?
        let new: Int?
    }
    let lines: [Line]
    let truncated: Bool
    var added: Int { lines.filter { $0.kind == .added }.count }
    var removed: Int { lines.filter { $0.kind == .removed }.count }

    init(_ patch: String) {
        var old: Int?, new: Int?, inside = false
        var lines: [Line] = []
        let bounded = String(patch.prefix(160_000))
        for (index, line) in bounded.components(separatedBy: "\n").prefix(4_000).enumerated() {
            if ["*** Begin Patch", "*** End Patch", "*** End of File", ""].contains(line) { continue }
            let kind: Kind
            if line.hasPrefix("@@") {
                let parts = line.split(separator: " ")
                old = parts.count > 2 ? parts[1].dropFirst().split(separator: ",").first.flatMap { Int($0) } : nil
                new = parts.count > 2 ? parts[2].dropFirst().split(separator: ",").first.flatMap { Int($0) } : nil
                inside = true; kind = .hunk
            } else if line.hasPrefix("diff --git ") || line.hasPrefix("*** ") || line.hasPrefix("--- ") && !inside || line.hasPrefix("+++ ") && !inside {
                inside = line.hasPrefix("*** Add File:"); old = nil; new = inside ? 1 : nil; kind = .header
            } else if inside && line.hasPrefix("+") { kind = .added }
            else if inside && line.hasPrefix("-") { kind = .removed }
            else { kind = inside && line.hasPrefix(" ") ? .context : .header }
            if line == "@@" { continue } // Edit tools do not report source line numbers.
            let display = line.replacingOccurrences(of: "*** Update File: ", with: "")
                .replacingOccurrences(of: "*** Add File: ", with: "New file · ")
                .replacingOccurrences(of: "*** Delete File: ", with: "Deleted file · ")
            lines.append(.init(id: index, text: display, kind: kind,
                               old: kind == .context || kind == .removed ? old : nil,
                               new: kind == .context || kind == .added ? new : nil))
            if kind == .context || kind == .removed { old = old.map { $0 + 1 } }
            if kind == .context || kind == .added { new = new.map { $0 + 1 } }
        }
        self.lines = lines; truncated = patch.count > 160_000 || bounded.components(separatedBy: "\n").count > 4_000
    }
}
