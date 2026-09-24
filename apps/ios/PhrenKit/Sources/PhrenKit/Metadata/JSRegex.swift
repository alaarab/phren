import Foundation

/// Thin wrapper over NSRegularExpression with JavaScript-like semantics, so the
/// patterns transcribed from packages/cli/src/content/metadata.ts behave
/// identically to their TypeScript originals.
struct JSRegex: @unchecked Sendable {
    let regex: NSRegularExpression
    // NSCache is thread-safe and evictable; patterns/options are the complete key.
    private static let compiled: NSCache<NSString, NSRegularExpression> = {
        let cache = NSCache<NSString, NSRegularExpression>()
        cache.countLimit = 256
        return cache
    }()

    private static func expression(_ pattern: String, options: NSRegularExpression.Options) -> NSRegularExpression {
        let key = "\(options.rawValue):\(pattern)" as NSString
        if let cached = compiled.object(forKey: key) { return cached }
        let regex = try! NSRegularExpression(pattern: pattern, options: options)
        compiled.setObject(regex, forKey: key)
        return regex
    }

    init(_ pattern: String, caseInsensitive: Bool = false) {
        var options: NSRegularExpression.Options = []
        if caseInsensitive { options.insert(.caseInsensitive) }
        // Patterns are compile-time constants transcribed from the CLI; a failure
        // to parse is a programmer error.
        // swiftlint:disable:next force_try
        self.regex = Self.expression(pattern, options: options)
    }

    init(multiline pattern: String) {
        // JS `m` flag: ^/$ match at line boundaries.
        // swiftlint:disable:next force_try
        self.regex = Self.expression(pattern, options: [.anchorsMatchLines])
    }

    func test(_ s: String) -> Bool {
        firstMatch(in: s) != nil
    }

    func firstMatch(in s: String) -> NSTextCheckingResult? {
        regex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s))
    }

    /// Equivalent of `s.match(re)?.[group]` for the first match.
    func group(_ s: String, _ group: Int = 1) -> String? {
        guard let m = firstMatch(in: s) else { return nil }
        return Self.substring(s, m, group)
    }

    /// All capture-group-1 values, like `[...s.matchAll(re)].map(m => m[1])`.
    func allGroups(_ s: String, _ group: Int = 1) -> [String] {
        regex.matches(in: s, range: NSRange(s.startIndex..., in: s))
            .compactMap { Self.substring(s, $0, group) }
    }

    /// All whole-match values, like `s.match(/.../g)`.
    func allMatches(_ s: String) -> [String] {
        regex.matches(in: s, range: NSRange(s.startIndex..., in: s))
            .compactMap { Self.substring(s, $0, 0) }
    }

    /// Equivalent of `s.replace(re, replacement)` with a global regex. The
    /// replacement string is literal (no $-templates).
    func replaceAll(_ s: String, with replacement: String) -> String {
        regex.stringByReplacingMatches(
            in: s,
            range: NSRange(s.startIndex..., in: s),
            withTemplate: NSRegularExpression.escapedTemplate(for: replacement)
        )
    }

    /// Equivalent of a non-global `s.replace(re, replacement)`: first match only.
    func replaceFirst(_ s: String, with replacement: String) -> String {
        guard let m = firstMatch(in: s), let range = Range(m.range, in: s) else { return s }
        return s.replacingCharacters(in: range, with: replacement)
    }

    static func substring(_ s: String, _ m: NSTextCheckingResult, _ group: Int) -> String? {
        guard group < m.numberOfRanges, let range = Range(m.range(at: group), in: s) else { return nil }
        return String(s[range])
    }
}

extension String {
    /// JS `String.prototype.trim()` trims the same whitespace set as
    /// `\s`, which `trimmingCharacters(in: .whitespacesAndNewlines)` matches
    /// closely enough for markdown content.
    var jsTrimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// JS `s.replace(/\s+/g, " ")`.
    var collapsedWhitespace: String {
        JSRegex(#"\s+"#).replaceAll(self, with: " ")
    }
}
