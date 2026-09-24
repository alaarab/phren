import Foundation

/// The per-project knobs the CLI reads from `<project>/phren.project.yaml`,
/// under that file's top-level `config:` mapping
/// (packages/cli/src/project-config.ts, `ProjectConfigOverrides`). A nil value
/// means "inherit the global setting", so an absent key is deliberately not the
/// same as a key set to some default.
///
/// The same file carries keys this screen has no business touching —
/// `sourcePath`, `ownership`, a nested `retentionPolicy:` block, comments — so
/// ``apply(to:)`` rewrites only the five scalar lines it owns and copies every
/// other line through byte for byte. `phren.project.yaml` is otherwise
/// read-only to the phone (``LocalStore``).
public struct ProjectKnobs: Equatable, Sendable, Codable {
    public enum FindingSensitivity: String, CaseIterable, Sendable, Codable {
        case minimal, conservative, balanced, aggressive
    }

    public enum Proactivity: String, CaseIterable, Sendable, Codable {
        case high, medium, low
    }

    public enum TaskMode: String, CaseIterable, Sendable, Codable {
        case off, manual, suggest, auto
    }

    public var findingSensitivity: FindingSensitivity?
    public var proactivity: Proactivity?
    public var proactivityFindings: Proactivity?
    public var proactivityTask: Proactivity?
    public var taskMode: TaskMode?

    public init(
        findingSensitivity: FindingSensitivity? = nil,
        proactivity: Proactivity? = nil,
        proactivityFindings: Proactivity? = nil,
        proactivityTask: Proactivity? = nil,
        taskMode: TaskMode? = nil
    ) {
        self.findingSensitivity = findingSensitivity
        self.proactivity = proactivity
        self.proactivityFindings = proactivityFindings
        self.proactivityTask = proactivityTask
        self.taskMode = taskMode
    }

    /// How many of the five are overridden in this file. Drives the project
    /// row's "2 set" / "Global" summary.
    public var setCount: Int {
        [findingSensitivity != nil, proactivity != nil, proactivityFindings != nil,
         proactivityTask != nil, taskMode != nil].filter { $0 }.count
    }

    // MARK: - Parsing

    /// Reads the five knobs from the `config:` mapping. Any other top-level key,
    /// and any nested block inside `config:` (`retentionPolicy:`,
    /// `workflowPolicy:`), is ignored. Values are matched exactly; an unknown or
    /// malformed value reads as "not set", so a newer CLI's value can never be
    /// mistaken for a default the user chose.
    public static func parse(_ yaml: String) -> ProjectKnobs {
        var knobs = ProjectKnobs()
        let lines = yaml.components(separatedBy: "\n")
        guard let header = configHeaderIndex(in: lines) else { return knobs }
        for line in lines[(header + 1)...] {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty && line == trimmed { break }   // left the config block
            guard let entry = scalarLine(line) else { continue }
            knobs.assign(entry)
        }
        return knobs
    }

    private mutating func assign(_ entry: (key: String, value: String)) {
        switch entry.key {
        case "findingSensitivity": findingSensitivity = FindingSensitivity(rawValue: entry.value)
        case "proactivity": proactivity = Proactivity(rawValue: entry.value)
        case "proactivityFindings": proactivityFindings = Proactivity(rawValue: entry.value)
        case "proactivityTask": proactivityTask = Proactivity(rawValue: entry.value)
        case "taskMode": taskMode = TaskMode(rawValue: entry.value)
        default: break
        }
    }

    // MARK: - Writing

    /// Rewrites the knobs inside `config:`. A non-nil value replaces the line in
    /// place, or is appended at the end of the block when missing; a nil value
    /// deletes the line. Every other line — the `config:` header, `sourcePath`,
    /// a nested `retentionPolicy:` block — is copied through untouched.
    public func apply(to yaml: String) -> String {
        let desired = rawValues
        var lines = yaml.components(separatedBy: "\n")
        let trailing = lines.last == "" ? 1 : 0
        let contentEnd = lines.count - trailing

        guard let header = Self.configHeaderIndex(in: lines) else {
            let entries = desired.compactMap { key, value in value.map { "  \(key): \($0)" } }
            guard !entries.isEmpty else { return yaml }
            lines.insert(contentsOf: ["config:"] + entries, at: contentEnd)
            return lines.joined(separator: "\n")
        }

        // `config: {}` is what the CLI dumps once every override is cleared.
        // Normalize it to a block before hanging a child under it.
        if desired.contains(where: { $0.value != nil }),
           let colon = lines[header].firstIndex(of: ":") {
            let after = lines[header][lines[header].index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if after.isEmpty || after == "{}" { lines[header] = "config:" }
        }

        var blockEnd = header + 1
        while blockEnd < contentEnd {
            let line = lines[blockEnd]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty && line == trimmed { break }
            blockEnd += 1
        }
        let indent = Self.blockIndent(lines: lines, header: header)

        var present = Set<String>()
        var output: [String] = []
        for (index, line) in lines.enumerated() {
            if index > header && index < blockEnd {
                if let entry = Self.scalarLine(line), desired.contains(where: { $0.key == entry.key }) {
                    present.insert(entry.key)
                    if let value = desired.first(where: { $0.key == entry.key })?.value {
                        let lineIndent = line.prefix { $0 == " " || $0 == "\t" }
                        output.append("\(lineIndent)\(entry.key): \(value)")
                    }
                    // A nil desired value removes the line.
                } else {
                    output.append(line)
                }
            } else {
                output.append(line)
            }
            if index == blockEnd - 1 {
                for entry in desired where entry.value != nil && !present.contains(entry.key) {
                    output.append("\(indent)\(entry.key): \(entry.value!)")
                }
            }
        }
        return output.joined(separator: "\n")
    }

    private var rawValues: [(key: String, value: String?)] {
        [
            ("findingSensitivity", findingSensitivity?.rawValue),
            ("proactivity", proactivity?.rawValue),
            ("proactivityFindings", proactivityFindings?.rawValue),
            ("proactivityTask", proactivityTask?.rawValue),
            ("taskMode", taskMode?.rawValue),
        ]
    }

    // MARK: - Flat-YAML helpers

    /// The index of a top-level `config:` line. A nested or indented `config`
    /// is not it.
    private static func configHeaderIndex(in lines: [String]) -> Int? {
        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#"), line == trimmed,
                  let colon = trimmed.firstIndex(of: ":") else { continue }
            if trimmed[..<colon].trimmingCharacters(in: .whitespaces) == "config" { return index }
        }
        return nil
    }

    /// An indented `key: value` line, quotes and trailing comments allowed —
    /// the same tolerant reading as ``MachineRegistry/unquote``.
    private static func scalarLine(_ raw: String) -> (key: String, value: String)? {
        guard raw.hasPrefix(" ") || raw.hasPrefix("\t") else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("#"),
              let colon = trimmed.firstIndex(of: ":") else { return nil }
        let key = String(trimmed[..<colon]).trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return nil }
        let value = MachineRegistry.unquote(String(trimmed[trimmed.index(after: colon)...]))
        return (key, value)
    }

    /// The indentation of the block's first child, so appended keys line up with
    /// existing ones. Two spaces when the block is empty (js-yaml's default).
    private static func blockIndent(lines: [String], header: Int) -> String {
        for line in lines[(header + 1)...] {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty && line == trimmed { break }
            if !trimmed.isEmpty {
                let indent = line.prefix { $0 == " " || $0 == "\t" }
                if !indent.isEmpty { return String(indent) }
            }
        }
        return "  "
    }
}
