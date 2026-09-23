import Foundation
import PhrenKit
import SwiftUI

/// GitHub's dark syntax palette, which reads well on every Phren theme:
/// keywords red, strings blue, numbers light blue, types orange, calls
/// purple, comments grey. Applied through `SyntaxTokenizer`, so a diff row
/// and a chat code block color the same line the same way.
///
/// Results are cached by language and text: a view that renders again, a row
/// that scrolls back into view or a diff that redraws reuses the colored
/// string instead of tokenizing the line again.
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
        guard language != .plain else { return AttributedString(line) }
        return cache.value(language: language, text: line) { tokenized(line, language: language) }
    }

    /// Whole blocks are tinted line by line, which is what the tokenizer
    /// promises to get right.
    static func highlightedBlock(_ code: String, language: SyntaxTokenizer.Language) -> AttributedString {
        guard language != .plain else { return AttributedString(code) }
        return cache.value(language: language, text: code, block: true) {
            var result = AttributedString()
            for (index, line) in code.components(separatedBy: "\n").enumerated() {
                if index > 0 { result += AttributedString("\n") }
                result += highlighted(line, language: language)
            }
            return result
        }
    }

    private static func tokenized(_ line: String, language: SyntaxTokenizer.Language) -> AttributedString {
        PerformanceCounters.bump("highlight.lines")
        var text = AttributedString(line)
        for token in SyntaxTokenizer.tokenize(line, language: language) {
            guard let range = Range(token.range, in: text) else { continue }
            text[range].foregroundColor = color(token.kind)
        }
        return text
    }

    static let cache = CodeHighlightCache()
}

/// Colored lines and blocks by language and text, bounded by the characters
/// they hold. `NSCache` is thread-safe and gives memory back under pressure.
final class CodeHighlightCache: @unchecked Sendable {
    private final class Entry { let value: AttributedString; init(_ value: AttributedString) { self.value = value } }
    private let storage: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.totalCostLimit = 4_000_000
        return cache
    }()

    private let lock = NSLock()
    private var missCount = 0
    /// Lines and blocks colored since launch (cache misses), for tests.
    var misses: Int { lock.lock(); defer { lock.unlock() }; return missCount }

    func value(language: SyntaxTokenizer.Language, text: String, block: Bool = false,
               make: () -> AttributedString) -> AttributedString {
        let key = "\(block ? "b" : "l")\(language.rawValue)\u{0}\(text)" as NSString
        if let hit = storage.object(forKey: key) { return hit.value }
        lock.lock(); missCount += 1; lock.unlock()
        let value = make()
        storage.setObject(Entry(value), forKey: key, cost: text.utf16.count + 64)
        return value
    }

    func removeAll() { storage.removeAllObjects() }
}
