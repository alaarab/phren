import Foundation

/// A skill invocation as the chat's inline chip reads it — `/design` plus
/// whatever was typed after it. The result (Claude Code's launch notice,
/// or a skill body in harnesses that return one) stays behind a tap.
public struct SkillCallPresentation: Equatable, Sendable {
    public enum Status: String, Sendable { case running, succeeded, failed }
    /// The skill as it is typed: "/design".
    public let command: String
    /// What followed the command, one line, bounded; nil when nothing did.
    public let args: String?
    public let result: String?
    public let status: Status

    private static let names: Set<String> = ["skill", "use_skill", "load_skill", "invoke_skill", "run_skill"]
    public static func recognizes(_ name: String?) -> Bool {
        names.contains(String((name ?? "").split(separator: ".").last ?? "").lowercased())
    }

    /// nil when the input names no skill: the generic pill then shows the raw
    /// call rather than a chip for an invented command.
    public init?(name: String, input: String, result: String? = nil, isError: Bool = false) {
        guard Self.recognizes(name), let values = ToolCallText.object(input) as? [String: Any] else { return nil }
        func value(_ names: String...) -> String? {
            names.compactMap { values[$0] as? String }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first(where: { !$0.isEmpty })
        }
        guard let skill = value("skill", "name", "skill_name", "command") else { return nil }
        let bare = skill.hasPrefix("/") ? String(skill.dropFirst()) : skill
        guard !bare.isEmpty, bare.utf8.count <= 200, !bare.contains(where: \.isNewline) else { return nil }
        command = "/" + bare
        args = value("args", "arguments", "input", "prompt").map {
            let line = String($0.split(whereSeparator: \.isNewline).first ?? "")
            return line.count > 120 ? String(line.prefix(120)) + "…" : line
        }
        let unwrapped = result.map { ToolCallText.unwrap($0) }
        let failed = isError || (unwrapped as? [String: Any])?["isError"] as? Bool == true
        status = result == nil ? .running : failed ? .failed : .succeeded
        self.result = unwrapped.map { ToolCallText.text($0) }
    }
}
