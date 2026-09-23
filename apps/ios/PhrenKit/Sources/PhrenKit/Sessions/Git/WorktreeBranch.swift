import Foundation

/// The branch a launch in a new worktree starts on. Phren Hook runs
/// `git worktree add -b <branch>` and has the final say through
/// `git check-ref-format`; this only suggests a name and catches what the Hook
/// would refuse before the phone asks.
public enum WorktreeBranch {
    public static let maxLength = 100

    /// `phren/<slug of the first line>` when there is one, else `phren/<short id>`.
    public static func suggested(firstLine: String?, id: UUID = UUID()) -> String {
        let line = firstLine?.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let slug = slug(line)
        return "phren/" + (slug.isEmpty ? shortID(id) : slug)
    }

    /// Six lowercase hex characters of `id`.
    public static func shortID(_ id: UUID) -> String {
        String(id.uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(6))
    }

    /// Lowercase ASCII words joined by dashes, at most `limit` characters and
    /// cut at a word boundary when one is close.
    public static func slug(_ text: String, limit: Int = 40) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        var words: [String] = []
        var current = ""
        for scalar in folded.unicodeScalars {
            if scalar.isASCII, CharacterSet.alphanumerics.contains(scalar) { current.unicodeScalars.append(scalar) }
            else if !current.isEmpty { words.append(current); current = "" }
        }
        if !current.isEmpty { words.append(current) }
        var result = ""
        for word in words {
            let next = result.isEmpty ? word : result + "-" + word
            if next.count > limit {
                if result.isEmpty { result = String(word.prefix(limit)) }
                break
            }
            result = next
        }
        return result
    }

    /// Why the Hook would refuse `branch`, or nil when it looks acceptable.
    public static func problem(_ branch: String) -> String? {
        let name = branch.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "Enter a branch name." }
        if name.count > maxLength { return "Keep the branch name under \(maxLength) characters." }
        guard name.range(of: #"^[A-Za-z0-9][A-Za-z0-9._/-]*$"#, options: .regularExpression) != nil else {
            return "A branch name uses letters, digits, dots, dashes, underscores and slashes, and starts with a letter or digit."
        }
        if name.contains("..") || name.contains("//") || name.contains("/.") || name.hasSuffix("/")
            || name.hasSuffix(".") || name.hasSuffix(".lock") || name == "HEAD" {
            return "That is not a valid Git branch name."
        }
        return nil
    }
}
