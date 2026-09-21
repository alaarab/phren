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
        case interval(minutes: Int)
        case daily(hour: Int, minute: Int)
        case weekly(days: Set<Weekday>, hour: Int, minute: Int)
        case once(Date)
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
    public let createdAt: Date
    public var updatedAt: Date

    public init(id: String, name: String, enabled: Bool, computer: String,
                harness: Harness, model: String? = nil, every: Every,
                prompt: String, createdAt: Date, updatedAt: Date) {
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
        createdAt = try Self.timestamp(values.decode(String.self, forKey: .createdAt))
        updatedAt = try Self.timestamp(values.decode(String.self, forKey: .updatedAt))
        let kind = try values.decode(String.self, forKey: .every)
        var fields = ["every": kind]
        for key in [CodingKeys.interval, .at, .once, .cron] {
            fields[key.rawValue] = try values.decodeIfPresent(String.self, forKey: key)
        }
        if let days = try values.decodeIfPresent([Weekday].self, forKey: .days) {
            fields["days"] = "[" + days.map(\.rawValue).joined(separator: ",") + "]"
        }
        guard let parsed = SchedulesFile.frequency(from: fields) else {
            throw DecodingError.dataCorruptedError(forKey: .every, in: values,
                                                   debugDescription: "Invalid schedule frequency.")
        }
        every = parsed
    }

    private static func timestamp(_ value: String) throws -> Date {
        guard let date = ISO8601Dates.parse(value) else {
            throw PhrenKitError.validation("Invalid schedule timestamp.")
        }
        return date
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
        case .interval(let minutes): try values.encode(SchedulesFile.intervalText(minutes), forKey: .interval)
        case .daily(let hour, let minute):
            try values.encode(SchedulesFile.timeText(hour, minute), forKey: .at)
        case .weekly(let days, let hour, let minute):
            try values.encode(SchedulesFile.timeText(hour, minute), forKey: .at)
            try values.encode(Weekday.allCases.filter(days.contains), forKey: .days)
        case .once(let date): try values.encode(SchedulesFile.onceText(date), forKey: .once)
        case .cron(let cron): try values.encode(cron, forKey: .cron)
        }
        try values.encode(prompt, forKey: .prompt)
        try values.encode(SchedulesFile.timestampText(createdAt), forKey: .createdAt)
        try values.encode(SchedulesFile.timestampText(updatedAt), forKey: .updatedAt)
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
        var identifiers: Set<String> = []
        for entry in entries {
            guard schedules.count < maximumSchedules else { break }
            // Rows and runtime state use this ID as a key; a duplicate must not reach either.
            if let schedule = schedule(from: entry), identifiers.insert(schedule.id).inserted {
                schedules.append(schedule)
            }
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
              let every = frequency(from: fields),
              let prompt = fields["prompt"], !prompt.isEmpty, prompt.count <= 8_000,
              let createdAt = ISO8601Dates.parse(fields["createdAt"]),
              let updatedAt = ISO8601Dates.parse(fields["updatedAt"]) else { return nil }

        let model = fields["model"].flatMap { $0.isEmpty ? nil : $0 }
        return Schedule(id: id, name: name, enabled: enabled, computer: computer,
                        harness: harness, model: model, every: every, prompt: prompt,
                        createdAt: createdAt, updatedAt: updatedAt)
    }

    fileprivate static func frequency(from fields: [String: String]) -> Schedule.Every? {
        switch fields["every"] {
        case "interval":
            guard let value = fields["interval"], JSRegex(#"^[1-9][0-9]*[mhd]$"#).test(value),
                  let amount = Int(value.dropLast()) else { return nil }
            let multiplier = value.last == "d" ? 1_440 : value.last == "h" ? 60 : 1
            let minutes = amount.multipliedReportingOverflow(by: multiplier)
            guard !minutes.overflow, minutes.partialValue >= 5 else { return nil }
            return .interval(minutes: minutes.partialValue)
        case "daily", "weekly":
            guard let at = fields["at"], validTime(at) else { return nil }
            let parts = at.split(separator: ":").compactMap { Int($0) }
            guard parts.count == 2 else { return nil }
            if fields["every"] == "daily" { return .daily(hour: parts[0], minute: parts[1]) }
            guard let rawDays = fields["days"] else { return nil }
            let days = inlineList(rawDays).compactMap(Schedule.Weekday.init(rawValue:))
            guard !days.isEmpty, days.count == inlineList(rawDays).count else { return nil }
            return .weekly(days: Set(days), hour: parts[0], minute: parts[1])
        case "once":
            guard let value = fields["once"] else { return nil }
            for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
                let formatter = onceFormatter(format)
                if let date = formatter.date(from: value), formatter.string(from: date) == value {
                    return .once(date)
                }
            }
            return ISO8601Dates.parse(value).map { .once($0) }
        case "cron":
            guard let value = fields["cron"], value.split(whereSeparator: \.isWhitespace).count == 5 else { return nil }
            return .cron(value)
        default: return nil
        }
    }

    fileprivate static func timestampText(_ date: Date) -> String {
        // ISO8601FormatStyle can truncate a parsed .456 second to .455; this formatter rounds it.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    fileprivate static func intervalText(_ minutes: Int) -> String {
        if minutes.isMultiple(of: 1_440) { return "\(minutes / 1_440)d" }
        if minutes.isMultiple(of: 60) { return "\(minutes / 60)h" }
        return "\(minutes)m"
    }

    fileprivate static func timeText(_ hour: Int, _ minute: Int) -> String {
        String(format: "%02d:%02d", hour, minute)
    }

    // Once is a wall-clock time on the chosen computer, so keep the wire value zone-free.
    fileprivate static func onceText(_ date: Date) -> String {
        onceFormatter("yyyy-MM-dd'T'HH:mm:ss").string(from: date)
    }

    private static func onceFormatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = format
        formatter.isLenient = false
        return formatter
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
            case .interval(let minutes): lines.append("    interval: \(intervalText(minutes))")
            case .daily(let hour, let minute): lines.append("    at: \(quoted(timeText(hour, minute)))")
            case .weekly(let days, let hour, let minute):
                lines.append("    at: \(quoted(timeText(hour, minute)))")
                lines.append("    days: [\(Schedule.Weekday.allCases.filter(days.contains).map(\.rawValue).joined(separator: ", "))]")
            case .once(let once): lines.append("    once: \(yamlScalar(onceText(once)))")
            case .cron(let cron): lines.append("    cron: \(quoted(cron))")
            }
            appendPrompt(schedule.prompt, to: &lines)
            lines.append("    createdAt: \(yamlScalar(timestampText(schedule.createdAt)))")
            lines.append("    updatedAt: \(yamlScalar(timestampText(schedule.updatedAt)))")
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
        if text.first == "'", let closing = text.lastIndex(of: "'"), closing > text.startIndex {
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
