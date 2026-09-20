import Foundation

/// One prompt the owner has asked Phren Hook to run on a named computer.
/// The custom Codable shape matches both `schedules.yaml` and the Hook's JSON:
/// `every` is a discriminator while its associated values remain sibling keys.
public struct Schedule: Codable, Equatable, Identifiable, Sendable {
    public enum Harness: String, Codable, CaseIterable, Equatable, Identifiable, Sendable {
        case claude, codex, opencode
        public var id: String { rawValue }
    }

    public enum Weekday: String, Codable, CaseIterable, Equatable, Identifiable, Sendable {
        case mon, tue, wed, thu, fri, sat, sun
        public var id: String { rawValue }
    }

    public enum Every: Equatable, Sendable {
        case interval(String)
        case daily(at: String)
        case weekly(at: String, days: [Weekday])
        case once(String)
        case cron(String)

        public var kind: String {
            switch self {
            case .interval: return "interval"
            case .daily: return "daily"
            case .weekly: return "weekly"
            case .once: return "once"
            case .cron: return "cron"
            }
        }
    }

    public let id: String
    public var name: String
    public var enabled: Bool
    public var computer: String
    public var harness: Harness
    public var model: String?
    public var every: Every
    public var prompt: String
    public let createdAt: String
    public var updatedAt: String

    public init(id: String, name: String, enabled: Bool, computer: String,
                harness: Harness, model: String? = nil, every: Every,
                prompt: String, createdAt: String, updatedAt: String) {
        self.id = id
        self.name = name
        self.enabled = enabled
        self.computer = computer
        self.harness = harness
        self.model = model
        self.every = every
        self.prompt = prompt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Eight lower-case hex characters, matching the CLI's schedule ids.
    public static func generateID() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(8))
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, enabled, computer, harness, model, every
        case at, days, interval, once, cron, prompt, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        enabled = try values.decode(Bool.self, forKey: .enabled)
        computer = try values.decode(String.self, forKey: .computer)
        harness = try values.decode(Harness.self, forKey: .harness)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        prompt = try values.decode(String.self, forKey: .prompt)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        switch try values.decode(String.self, forKey: .every) {
        case "interval": every = .interval(try values.decode(String.self, forKey: .interval))
        case "daily": every = .daily(at: try values.decode(String.self, forKey: .at))
        case "weekly":
            every = .weekly(at: try values.decode(String.self, forKey: .at),
                            days: try values.decode([Weekday].self, forKey: .days))
        case "once": every = .once(try values.decode(String.self, forKey: .once))
        case "cron": every = .cron(try values.decode(String.self, forKey: .cron))
        case let value:
            throw DecodingError.dataCorruptedError(forKey: .every, in: values,
                                                   debugDescription: "Unknown schedule frequency \(value).")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(name, forKey: .name)
        try values.encode(enabled, forKey: .enabled)
        try values.encode(computer, forKey: .computer)
        try values.encode(harness, forKey: .harness)
        try values.encodeIfPresent(model, forKey: .model)
        try values.encode(every.kind, forKey: .every)
        switch every {
        case .interval(let interval): try values.encode(interval, forKey: .interval)
        case .daily(let at): try values.encode(at, forKey: .at)
        case .weekly(let at, let days):
            try values.encode(at, forKey: .at)
            try values.encode(days, forKey: .days)
        case .once(let once): try values.encode(once, forKey: .once)
        case .cron(let cron): try values.encode(cron, forKey: .cron)
        }
        try values.encode(prompt, forKey: .prompt)
        try values.encode(createdAt, forKey: .createdAt)
        try values.encode(updatedAt, forKey: .updatedAt)
    }
}

/// The intentionally small YAML surface shared with the CLI. It understands
/// only a top-level list of scalar mappings, inline weekday lists, and literal
/// prompt blocks. Rewrites replace that list while copying other top-level
/// sections through unchanged.
public enum SchedulesFile {
    public static let fileName = "schedules.yaml"
    public static let maximumSchedules = 64

    public static func parse(_ text: String) -> [Schedule] {
        let lines = text.components(separatedBy: "\n")
        guard let range = schedulesRange(in: lines) else { return [] }
        var entries: [[String: String]] = []
        var fields: [String: String]?
        var index = range.lowerBound + 1

        func finishEntry() {
            if let fields { entries.append(fields) }
            fields = nil
        }

        while index < range.upperBound {
            let raw = lines[index]
            let indent = indentation(of: raw)
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("- "), indent > 0 {
                finishEntry()
                fields = [:]
                let first = String(trimmed.dropFirst(2))
                if let pair = mapping(first) { fields?[pair.key] = scalar(pair.value) }
                index += 1
                continue
            }
            guard fields != nil, !trimmed.isEmpty, !trimmed.hasPrefix("#"),
                  let pair = mapping(trimmed) else {
                index += 1
                continue
            }
            if pair.key == "prompt", pair.value.hasPrefix("|") {
                let style = pair.value
                let keyIndent = indent
                var block: [String] = []
                index += 1
                while index < range.upperBound {
                    let line = lines[index]
                    let lineIndent = indentation(of: line)
                    if !line.trimmingCharacters(in: .whitespaces).isEmpty, lineIndent <= keyIndent { break }
                    block.append(line)
                    index += 1
                }
                fields?[pair.key] = literal(block, keyIndent: keyIndent, style: style)
                continue
            }
            fields?[pair.key] = scalar(pair.value)
            index += 1
        }
        finishEntry()

        var schedules: [Schedule] = []
        for entry in entries {
            guard schedules.count < maximumSchedules else { break }
            if let schedule = schedule(from: entry) { schedules.append(schedule) }
        }
        return schedules
    }

    public static func render(_ schedules: [Schedule], preserving original: String? = nil) -> String {
        let selected = Array(schedules.prefix(maximumSchedules))
        let replacement = renderBlock(selected)
        guard let original, !original.isEmpty else {
            return (["version: 1"] + replacement).joined(separator: "\n") + "\n"
        }

        var lines = original.components(separatedBy: "\n")
        if let range = schedulesRange(in: lines) {
            lines.replaceSubrange(range, with: replacement)
            var rendered = lines.joined(separator: "\n")
            if original.hasSuffix("\n"), !rendered.hasSuffix("\n") { rendered += "\n" }
            return rendered
        }

        if !hasTopLevelKey("version", in: lines) {
            lines.insert("version: 1", at: 0)
        }
        let trailingEmpty = lines.last == ""
        if trailingEmpty { lines.removeLast() }
        if !lines.isEmpty, lines.last?.isEmpty == false { lines.append("") }
        lines.append(contentsOf: replacement)
        if trailingEmpty { lines.append("") }
        return lines.joined(separator: "\n")
    }

    private static func schedule(from fields: [String: String]) -> Schedule? {
        guard let id = fields["id"], JSRegex(#"^[0-9a-fA-F]{8}$"#).test(id),
              let name = fields["name"], !name.isEmpty, name.count <= 80,
              let enabledText = fields["enabled"], let enabled = bool(enabledText),
              let computer = fields["computer"], !computer.isEmpty,
              let harnessText = fields["harness"], let harness = Schedule.Harness(rawValue: harnessText),
              let frequency = fields["every"],
              let prompt = fields["prompt"], !prompt.isEmpty, prompt.count <= 8_000,
              let createdAt = fields["createdAt"], !createdAt.isEmpty,
              let updatedAt = fields["updatedAt"], !updatedAt.isEmpty else { return nil }

        let every: Schedule.Every
        switch frequency {
        case "interval":
            guard let value = fields["interval"], JSRegex(#"^[1-9][0-9]*[mhd]$"#).test(value) else { return nil }
            every = .interval(value)
        case "daily":
            guard let at = fields["at"], validTime(at) else { return nil }
            every = .daily(at: at)
        case "weekly":
            guard let at = fields["at"], validTime(at), let rawDays = fields["days"] else { return nil }
            let days = inlineList(rawDays).compactMap(Schedule.Weekday.init(rawValue:))
            guard !days.isEmpty, days.count == inlineList(rawDays).count else { return nil }
            every = .weekly(at: at, days: days)
        case "once":
            guard let value = fields["once"],
                  JSRegex(#"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$"#).test(value) else { return nil }
            every = .once(value)
        case "cron":
            guard let value = fields["cron"], value.split(whereSeparator: \.isWhitespace).count == 5 else { return nil }
            every = .cron(value)
        default:
            return nil
        }
        let model = fields["model"].flatMap { $0.isEmpty ? nil : $0 }
        return Schedule(id: id, name: name, enabled: enabled, computer: computer,
                        harness: harness, model: model, every: every, prompt: prompt,
                        createdAt: createdAt, updatedAt: updatedAt)
    }

    private static func renderBlock(_ schedules: [Schedule]) -> [String] {
        var lines = ["schedules:"]
        if schedules.isEmpty { return ["schedules: []"] }
        for schedule in schedules {
            lines.append("  - id: \(yamlScalar(schedule.id))")
            lines.append("    name: \(yamlScalar(schedule.name))")
            lines.append("    enabled: \(schedule.enabled ? "true" : "false")")
            lines.append("    computer: \(yamlScalar(schedule.computer))")
            lines.append("    harness: \(schedule.harness.rawValue)")
            if let model = schedule.model { lines.append("    model: \(yamlScalar(model))") }
            lines.append("    every: \(schedule.every.kind)")
            switch schedule.every {
            case .interval(let interval): lines.append("    interval: \(yamlScalar(interval))")
            case .daily(let at): lines.append("    at: \(quoted(at))")
            case .weekly(let at, let days):
                lines.append("    at: \(quoted(at))")
                lines.append("    days: [\(days.map(\.rawValue).joined(separator: ", "))]")
            case .once(let once): lines.append("    once: \(yamlScalar(once))")
            case .cron(let cron): lines.append("    cron: \(quoted(cron))")
            }
            appendPrompt(schedule.prompt, to: &lines)
            lines.append("    createdAt: \(yamlScalar(schedule.createdAt))")
            lines.append("    updatedAt: \(yamlScalar(schedule.updatedAt))")
        }
        return lines
    }

    private static func appendPrompt(_ prompt: String, to lines: inout [String]) {
        let trailingNewlines = prompt.reversed().prefix { $0 == "\n" }.count
        lines.append("    prompt: \(trailingNewlines == 0 ? "|-" : trailingNewlines == 1 ? "|" : "|+")")
        var body = prompt.components(separatedBy: "\n")
        if prompt.hasSuffix("\n") { body.removeLast() }
        for line in body { lines.append("      \(line)") }
    }

    private static func schedulesRange(in lines: [String]) -> Range<Int>? {
        guard let header = lines.indices.first(where: { topLevelKey(lines[$0]) == "schedules" }) else { return nil }
        var end = header + 1
        while end < lines.count {
            let line = lines[end]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty, !trimmed.hasPrefix("#"), indentation(of: line) == 0 { break }
            end += 1
        }
        return header..<end
    }

    private static func hasTopLevelKey(_ key: String, in lines: [String]) -> Bool {
        lines.contains { topLevelKey($0) == key }
    }

    private static func topLevelKey(_ line: String) -> String? {
        guard indentation(of: line) == 0 else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("#"), let colon = trimmed.firstIndex(of: ":") else { return nil }
        return String(trimmed[..<colon]).trimmingCharacters(in: .whitespaces)
    }

    private static func mapping(_ line: String) -> (key: String, value: String)? {
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return nil }
        return (key, String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces))
    }

    private static func scalar(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text.first == "\"", let closing = text.lastIndex(of: "\"") {
            let quoted = String(text[...closing])
            let remainder = text[text.index(after: closing)...].trimmingCharacters(in: .whitespaces)
            if (remainder.isEmpty || remainder.hasPrefix("#")),
               let data = quoted.data(using: .utf8),
               let decoded = try? JSONDecoder().decode(String.self, from: data) {
                return decoded
            }
        }
        if text.first == "'", let closing = text.lastIndex(of: "'") {
            let remainder = text[text.index(after: closing)...].trimmingCharacters(in: .whitespaces)
            if remainder.isEmpty || remainder.hasPrefix("#") {
                return String(text[text.index(after: text.startIndex)..<closing])
                    .replacingOccurrences(of: "''", with: "'")
            }
        }
        if let comment = text.range(of: " #") {
            return String(text[..<comment.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return text
    }

    private static func inlineList(_ raw: String) -> [String] {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard text.first == "[", text.last == "]" else { return [] }
        let contents = text.dropFirst().dropLast()
        if contents.trimmingCharacters(in: .whitespaces).isEmpty { return [] }
        return contents.split(separator: ",").map { scalar(String($0)) }
    }

    private static func literal(_ lines: [String], keyIndent: Int, style: String) -> String {
        let nonemptyIndents = lines.compactMap { line -> Int? in
            line.trimmingCharacters(in: .whitespaces).isEmpty ? nil : indentation(of: line)
        }
        let contentIndent = nonemptyIndents.min() ?? keyIndent + 2
        let body = lines.map { line -> String in
            guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return "" }
            return String(line.dropFirst(min(contentIndent, line.count)))
        }.joined(separator: "\n") + (lines.isEmpty ? "" : "\n")
        let trailingNewlines = body.reversed().prefix { $0 == "\n" }.count
        let stripped = String(body.dropLast(trailingNewlines))
        if style.hasPrefix("|-") { return stripped }
        if style.hasPrefix("|+") { return body }
        return stripped + (lines.isEmpty ? "" : "\n")
    }

    private static func indentation(of line: String) -> Int {
        line.prefix { $0 == " " || $0 == "\t" }.count
    }

    private static func bool(_ text: String) -> Bool? {
        switch text.lowercased() {
        case "true": return true
        case "false": return false
        default: return nil
        }
    }

    private static func validTime(_ text: String) -> Bool {
        guard JSRegex(#"^([01]\d|2[0-3]):[0-5]\d$"#).test(text) else { return false }
        return true
    }

    private static func yamlScalar(_ value: String) -> String {
        let reserved = ["true", "false", "null", "yes", "no", "on", "off", "~"]
        let safe = JSRegex(#"^[A-Za-z0-9][A-Za-z0-9._/@ -]*$"#).test(value)
            && !reserved.contains(value.lowercased())
            && !JSRegex(#"^[0-9]+$"#).test(value)
        return safe ? value : quoted(value)
    }

    private static func quoted(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
        return "\"\(escaped)\""
    }
}
