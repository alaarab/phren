import Foundation

/// A worker launched through one of phren's provider wrappers.
public enum BackgroundJobLabel {
    /// Returns the provider and the human label passed to a recognized wrapper.
    public static func parse(command: String) -> (provider: String, label: String)? {
        let provider: String
        if command.contains("skills/fanout/scripts/") {
            // One launcher for every CLI worker; the provider is an argument,
            // or the wrapper's own name when a wrapper is called directly.
            if let match = providerExpression.firstMatch(in: command, range: NSRange(command.startIndex..., in: command)),
               let range = Range(match.range(at: 1), in: command) {
                provider = String(command[range])
            } else if command.contains("scripts/codex.sh") {
                provider = "codex"
            } else if command.contains("scripts/opencode.sh") {
                provider = "opencode"
            } else {
                return nil
            }
        } else if command.contains("skills/codex/scripts/run.sh") {
            provider = "codex"
        } else if command.contains("skills/deepseek/scripts/run.sh") {
            provider = "opencode"
        } else {
            return nil
        }

        guard let match = labelExpression.firstMatch(
            in: command,
            range: NSRange(command.startIndex..., in: command)
        ), let range = Range(match.range(at: 2), in: command) else { return nil }
        let label = command[range].trimmingCharacters(in: .whitespacesAndNewlines)
        // A label the shell had yet to expand ("${L[$n]}", "$(...)", `...`) is
        // not a name; the call's own description reads better than that.
        guard !label.isEmpty, !label.contains("$"), !label.contains("`") else { return nil }
        return (provider, label)
    }

    private static let providerExpression = try! NSRegularExpression(
        pattern: #"(?:^|\s)--provider\s+(codex|opencode)(?:\s|$)"#
    )

    private static let labelExpression = try! NSRegularExpression(
        pattern: #"(?:^|\s)--label\s+(["'])(.*?)\1"#,
        options: [.dotMatchesLineSeparators]
    )
}
