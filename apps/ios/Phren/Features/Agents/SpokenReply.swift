import Foundation

/// What talk mode reads aloud from an agent's final reply: the prose, without
/// code blocks, tables or markdown punctuation, cut into sentences so the
/// first can play while the next is being voiced.
enum SpokenReply {
    static func text(fromMarkdown markdown: String) -> String {
        var lines: [String] = []
        var inFence = false
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            if inFence || line.hasPrefix("|") || line.hasPrefix("    ") || raw.hasPrefix("\t") { continue }
            if line.allSatisfy({ "-*_=".contains($0) }) { continue } // rules and blanks
            lines.append(clean(line))
        }
        return lines.filter { !$0.isEmpty }
            .map { $0.last.map { ".!?:;".contains($0) } == true ? $0 : $0 + "." }
            .joined(separator: " ")
    }

    /// Sentences short enough to voice one at a time; very short ones ride
    /// with the next so the voice doesn't stop after every clause.
    static func sentences(_ text: String, minimumLength: Int = 40) -> [String] {
        var sentences: [String] = []
        var current = ""
        text.enumerateSubstrings(in: text.startIndex..., options: .bySentences) { sentence, _, _, _ in
            guard let sentence = sentence?.trimmingCharacters(in: .whitespacesAndNewlines), !sentence.isEmpty else { return }
            current = current.isEmpty ? sentence : current + " " + sentence
            if current.count >= minimumLength {
                sentences.append(current)
                current = ""
            }
        }
        if !current.isEmpty { sentences.append(current) }
        return sentences
    }

    private static func clean(_ line: String) -> String {
        var text = line
        // Headings, quotes and list markers.
        text = text.replacingOccurrences(of: #"^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)"#, with: "", options: .regularExpression)
        // Links and images keep their words; bare URLs become "a link".
        text = text.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"https?://\S+"#, with: "a link", options: .regularExpression)
        // Inline code keeps its words; emphasis marks go.
        text = text.replacingOccurrences(of: "`", with: "")
        text = text.replacingOccurrences(of: #"(\*\*|__|\*|~~)"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?<![\p{L}\p{N}])_(?=\S)|(?<=\S)_(?![\p{L}\p{N}])"#, with: "", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespaces)
    }
}
