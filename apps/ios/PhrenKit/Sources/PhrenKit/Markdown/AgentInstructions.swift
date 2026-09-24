import Foundation

/// Canonical instructions consumed by phren's link step. The CLI derives
/// managed AGENTS.md and Copilot mirrors from these files (link/link.ts).
public enum AgentInstructions {
    public static let fileName = "AGENTS.md"
    public static let legacyFileName = "CLAUDE.md"

    public static func isPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        return parts.count == 2 && LocalStore.isReadableProjectDirName(parts[0])
            && [fileName, legacyFileName].contains(parts[1])
    }

    public static func template(scope: String) -> String {
        "# \(scope == "global" ? "Global agent instructions" : scope)\n\n## Working instructions\n\n"
    }
}

/// Whole-file edits must compare the bytes the user opened with the current
/// file, including during conflict replay. A nil expected value means create.
public enum AuthoredFile {
    public static func validate(path: String, current: String?, expected: String?, content: String?) throws {
        guard LocalStore.isSkillPath(path) || AgentInstructions.isPath(path) else {
            throw PhrenKitError.validation("That file cannot be edited here.")
        }
        if let content {
            guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw PhrenKitError.emptyInput("Add some instructions before saving.")
            }
            if let secret = SecretScanner.scan(content) {
                throw PhrenKitError.secretDetected(secret)
            }
        }
        // An already-landed save/delete is safe to replay after a lost reply.
        guard current == expected || current == content else {
            throw PhrenKitError.validation(
                "\(path) changed since you opened it. Your draft is preserved. Review the latest version before saving again."
            )
        }
    }

    /// The CLI resolves names case-insensitively across both file shapes.
    public static func conflictingSkillPath(for path: String, among paths: [String]) -> String? {
        guard let skill = Skill.parse(path: path, content: "") else { return nil }
        return paths.sorted().first { candidate in
            guard candidate != path, let other = Skill.parse(path: candidate, content: "") else { return false }
            return other.scope == skill.scope && other.name.lowercased() == skill.name.lowercased()
        }
    }
}
