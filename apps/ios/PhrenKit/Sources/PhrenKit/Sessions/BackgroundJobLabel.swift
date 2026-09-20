import Foundation

/// A worker launched through one of phren's provider wrappers.
public enum BackgroundJobLabel {
    /// Returns the provider and the human label passed to a recognized wrapper.
    public static func parse(command: String) -> (provider: String, label: String)? {
        let provider: String
        if command.contains("skills/codex/scripts/run.sh") {
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
        return label.isEmpty ? nil : (provider, label)
    }

    private static let labelExpression = try! NSRegularExpression(
        pattern: #"(?:^|\s)--label\s+(["'])(.*?)\1"#,
        options: [.dotMatchesLineSeparators]
    )
}
