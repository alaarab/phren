import Foundation

/// A small, regular-expression tokenizer for colouring code the way GitHub
/// and VS Code do at a glance: comments, strings, numbers, keywords, types
/// and calls. It is deliberately per-line — diff rows are single lines and a
/// multi-line comment or string is rare enough in a hunk that mis-colouring
/// its continuation is acceptable — and deliberately shallow: it never needs
/// to be right about grammar, only about what a reader expects to see tinted.
public enum SyntaxTokenizer {
    public enum Kind: Sendable { case comment, string, number, keyword, type, function, attribute, punctuation }

    public struct Token: Equatable, Sendable {
        public let range: Range<String.Index>
        public let kind: Kind
    }

    public enum Language: String, CaseIterable, Sendable {
        case swift, python, javascript, typescript, json, yaml, shell, markdown, rust, go, ruby, css, html, sql, toml, plain

        /// From a fence label or a file extension; anything unknown is plain.
        public static func detect(_ hint: String?) -> Language {
            guard let hint, !hint.isEmpty else { return .plain }
            let name = hint.split(separator: "/").last.map(String.init) ?? hint
            let ext = name.contains(".") ? String(name.split(separator: ".").last ?? "") : name
            switch ext.lowercased() {
            case "swift": return .swift
            case "py", "python", "pyi": return .python
            case "js", "jsx", "mjs", "cjs", "javascript": return .javascript
            case "ts", "tsx", "mts", "cts", "typescript": return .typescript
            case "json", "jsonc": return .json
            case "yml", "yaml": return .yaml
            case "sh", "bash", "zsh", "shell", "fish": return .shell
            case "md", "markdown": return .markdown
            case "rs", "rust": return .rust
            case "go", "golang": return .go
            case "rb", "ruby", "gemfile", "rakefile": return .ruby
            case "css", "scss", "less": return .css
            case "html", "htm", "xml", "svg", "vue", "svelte": return .html
            case "sql": return .sql
            case "toml": return .toml
            default: return .plain
            }
        }
    }

    private struct Rule { let regex: JSRegex; let kind: Kind; let group: Int }

    private static let keywords: [Language: Set<String>] = [
        .swift: ["import", "let", "var", "func", "class", "struct", "enum", "protocol", "extension", "actor", "init", "deinit", "return", "if", "else", "guard", "switch", "case", "default", "for", "in", "while", "repeat", "break", "continue", "throw", "throws", "rethrows", "try", "catch", "async", "await", "defer", "where", "as", "is", "nil", "true", "false", "self", "Self", "super", "public", "private", "fileprivate", "internal", "open", "static", "final", "override", "mutating", "nonisolated", "some", "any", "inout", "typealias", "associatedtype", "subscript", "get", "set", "willSet", "didSet", "lazy", "weak", "unowned", "indirect", "convenience", "required", "operator", "precedencegroup", "fallthrough", "do"],
        .python: ["import", "from", "as", "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "None", "True", "False", "try", "except", "finally", "raise", "with", "yield", "lambda", "pass", "break", "continue", "global", "nonlocal", "assert", "del", "async", "await", "self", "print"],
        .javascript: ["import", "export", "from", "default", "const", "let", "var", "function", "class", "extends", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "delete", "typeof", "instanceof", "in", "of", "try", "catch", "finally", "throw", "async", "await", "yield", "this", "super", "null", "undefined", "true", "false", "static", "get", "set"],
        .typescript: ["import", "export", "from", "default", "const", "let", "var", "function", "class", "extends", "implements", "interface", "type", "enum", "namespace", "declare", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "delete", "typeof", "instanceof", "keyof", "in", "of", "try", "catch", "finally", "throw", "async", "await", "yield", "this", "super", "null", "undefined", "true", "false", "static", "readonly", "public", "private", "protected", "abstract", "as", "satisfies", "get", "set"],
        .rust: ["use", "mod", "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "for", "in", "while", "loop", "if", "else", "match", "return", "pub", "crate", "self", "Self", "super", "where", "as", "ref", "move", "async", "await", "dyn", "type", "unsafe", "true", "false", "break", "continue"],
        .go: ["package", "import", "func", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "return", "if", "else", "for", "range", "switch", "case", "default", "select", "break", "continue", "fallthrough", "goto", "nil", "true", "false", "make", "new", "len", "cap", "append"],
        .ruby: ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "require", "include", "extend", "attr_accessor", "attr_reader", "self", "nil", "true", "false", "and", "or", "not", "then", "puts"],
        .shell: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "return", "exit", "export", "local", "readonly", "source", "set", "unset", "echo", "cd", "true", "false"],
        .sql: ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "limit", "offset", "as", "and", "or", "not", "null", "is", "in", "exists", "primary", "key", "references", "default", "unique", "begin", "commit", "rollback", "with", "union", "distinct", "having", "case", "when", "then", "else", "end"],
        .css: ["important", "media", "import", "font-face", "keyframes", "supports"],
        .toml: ["true", "false"],
        .yaml: ["true", "false", "null", "yes", "no"],
        .json: ["true", "false", "null"],
        .markdown: [], .html: [], .plain: [],
    ]

    private static func rules(for language: Language) -> [Rule] {
        switch language {
        case .plain: return []
        case .python, .shell, .yaml, .toml, .ruby:
            return [Rule(regex: JSRegex(#"#.*$"#), kind: .comment, group: 0)] + literals(language)
        case .sql:
            return [Rule(regex: JSRegex(#"--.*$"#), kind: .comment, group: 0)] + literals(language)
        case .css:
            return [Rule(regex: JSRegex(#"/\*.*?\*/"#), kind: .comment, group: 0),
                    Rule(regex: JSRegex(#"(?:^|[\s{;])([a-z-]+)\s*:"#), kind: .attribute, group: 1),
                    Rule(regex: JSRegex(#"(?:^|[\s,}])([.#][A-Za-z_-][\w-]*)"#), kind: .type, group: 1)] + literals(language)
        case .html:
            return [Rule(regex: JSRegex(#"<!--.*?-->"#), kind: .comment, group: 0),
                    Rule(regex: JSRegex(#"</?([A-Za-z][\w:-]*)"#), kind: .keyword, group: 1),
                    Rule(regex: JSRegex(#"\s([A-Za-z_:][\w:.-]*)="#), kind: .attribute, group: 1)] + literals(language)
        case .markdown:
            return [Rule(regex: JSRegex(#"^#{1,6}\s.*$"#), kind: .keyword, group: 0),
                    Rule(regex: JSRegex(#"`[^`]+`"#), kind: .string, group: 0),
                    Rule(regex: JSRegex(#"\*\*[^*]+\*\*"#), kind: .type, group: 0),
                    Rule(regex: JSRegex(#"\[[^\]]+\]\([^)]+\)"#), kind: .function, group: 0)]
        case .json:
            return [Rule(regex: JSRegex(#""(?:\\.|[^"\\])*"\s*:"#), kind: .attribute, group: 0)] + literals(language)
        case .swift, .javascript, .typescript, .rust, .go:
            return [Rule(regex: JSRegex(#"//.*$"#), kind: .comment, group: 0),
                    Rule(regex: JSRegex(#"/\*.*?\*/"#), kind: .comment, group: 0)] + literals(language)
                + [Rule(regex: JSRegex(#"(?:^|[^\w.])(@[A-Za-z_]\w*|#[a-z]+\b)"#), kind: .attribute, group: 1),
                   Rule(regex: JSRegex(#"\b([A-Z][A-Za-z0-9_]*)\b"#), kind: .type, group: 1),
                   Rule(regex: JSRegex(#"\b([a-z_][A-Za-z0-9_]*)\s*\("#), kind: .function, group: 1)]
        }
    }

    private static func literals(_ language: Language) -> [Rule] {
        var rules = [
            Rule(regex: JSRegex(#""(?:\\.|[^"\\])*""#), kind: .string, group: 0),
            Rule(regex: JSRegex(#"'(?:\\.|[^'\\])*'"#), kind: .string, group: 0),
            Rule(regex: JSRegex(#"\b(?:0x[0-9A-Fa-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b"#), kind: .number, group: 0),
        ]
        if language == .swift || language == .javascript || language == .typescript || language == .go {
            rules.append(Rule(regex: JSRegex(#"`(?:\\.|[^`\\])*`"#), kind: .string, group: 0))
        }
        if language == .python { rules.insert(Rule(regex: JSRegex(#"(?:\"\"\"|''')[^\n]*?(?:\"\"\"|''')"#), kind: .string, group: 0), at: 0) }
        return rules
    }

    private static let rulesCache: [Language: [Rule]] = Dictionary(uniqueKeysWithValues: Language.allCases.map { ($0, rules(for: $0)) })
    private static let word = JSRegex(#"[A-Za-z_][A-Za-z0-9_-]*"#)

    /// Non-overlapping tokens for one line, earliest-first. Comments and
    /// strings win over everything inside them; keywords are matched on
    /// whole words afterwards, outside any earlier token.
    public static func tokenize(_ line: String, language: Language) -> [Token] {
        guard language != .plain, !line.isEmpty else { return [] }
        var taken: [Range<String.Index>] = []
        var tokens: [Token] = []
        func claim(_ range: Range<String.Index>, _ kind: Kind) {
            guard !range.isEmpty, !taken.contains(where: { $0.overlaps(range) }) else { return }
            taken.append(range); tokens.append(Token(range: range, kind: kind))
        }
        for rule in rulesCache[language] ?? [] {
            for match in rule.regex.regex.matches(in: line, range: NSRange(line.startIndex..., in: line)) {
                guard rule.group < match.numberOfRanges, let range = Range(match.range(at: rule.group), in: line) else { continue }
                claim(range, rule.kind)
            }
        }
        if let keywords = keywords[language], !keywords.isEmpty {
            let caseInsensitive = language == .sql
            for match in word.regex.matches(in: line, range: NSRange(line.startIndex..., in: line)) {
                guard let range = Range(match.range, in: line) else { continue }
                let text = caseInsensitive ? line[range].lowercased() : String(line[range])
                if keywords.contains(text) {
                    // A call rule may have claimed a keyword like `if (` in C-likes; keywords win.
                    taken.removeAll { $0 == range }; tokens.removeAll { $0.range == range }
                    claim(range, .keyword)
                }
            }
        }
        return tokens.sorted { $0.range.lowerBound < $1.range.lowerBound }
    }
}
