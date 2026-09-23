import PhrenKit
import SwiftUI

/// GitHub's dark syntax palette, which reads well on every Phren theme:
/// keywords red, strings blue, numbers light blue, types orange, calls
/// purple, comments grey. Applied through `SyntaxTokenizer`, so a diff row
/// and a chat code block colour the same line the same way.
enum CodeHighlighting {
    static func color(_ kind: SyntaxTokenizer.Kind) -> Color {
        switch kind {
        case .comment: return Color(hex: 0x8B949E)
        case .string: return Color(hex: 0xA5D6FF)
        case .number: return Color(hex: 0x79C0FF)
        case .keyword: return Color(hex: 0xFF7B72)
        case .type: return Color(hex: 0xFFA657)
        case .function: return Color(hex: 0xD2A8FF)
        case .attribute: return Color(hex: 0x7EE787)
        case .punctuation: return PhrenTheme.chatNeutral
        }
    }

    /// One line, tinted by token; plain text keeps the caller's foreground.
    static func highlighted(_ line: String, language: SyntaxTokenizer.Language) -> AttributedString {
        PerformanceCounters.bump("highlight.lines")
        var text = AttributedString(line)
        guard language != .plain else { return text }
        for token in SyntaxTokenizer.tokenize(line, language: language) {
            guard let range = Range(token.range, in: text) else { continue }
            text[range].foregroundColor = color(token.kind)
        }
        return text
    }

    /// Whole blocks are tinted line by line, which is what the tokenizer
    /// promises to get right.
    static func highlightedBlock(_ code: String, language: SyntaxTokenizer.Language) -> AttributedString {
        guard language != .plain else { return AttributedString(code) }
        var result = AttributedString()
        for (index, line) in code.components(separatedBy: "\n").enumerated() {
            if index > 0 { result += AttributedString("\n") }
            result += highlighted(line, language: language)
        }
        return result
    }
}
