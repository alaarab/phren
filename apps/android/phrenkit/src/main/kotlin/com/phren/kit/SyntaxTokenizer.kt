package com.phren.kit

/**
 * SyntaxTokenizer.swift: a small per-line regular-expression tokenizer that
 * colours code the way GitHub does at a glance. Deliberately shallow: it
 * never needs to be right about grammar, only about what a reader expects
 * to see tinted. Ranges are UTF-16 index ranges into the line.
 */
object SyntaxTokenizer {
    enum class Kind { COMMENT, STRING, NUMBER, KEYWORD, TYPE, FUNCTION, ATTRIBUTE, PUNCTUATION }

    data class Token(val range: IntRange, val kind: Kind)

    enum class Language(val rawValue: String) {
        SWIFT("swift"), PYTHON("python"), JAVASCRIPT("javascript"), TYPESCRIPT("typescript"), JSON("json"), YAML("yaml"),
        SHELL("shell"), MARKDOWN("markdown"), RUST("rust"), GO("go"), RUBY("ruby"), CSS("css"), HTML("html"), SQL("sql"),
        TOML("toml"), PLAIN("plain");

        companion object {
            /** From a fence label or a file extension; anything unknown is plain. */
            fun detect(hint: String?): Language {
                if (hint.isNullOrEmpty()) return PLAIN
                val name = hint.split("/").lastOrNull { it.isNotEmpty() } ?: hint
                val ext = if (name.contains(".")) name.split(".").last() else name
                return when (ext.lowercase()) {
                    "swift" -> SWIFT
                    "py", "python", "pyi" -> PYTHON
                    "js", "jsx", "mjs", "cjs", "javascript" -> JAVASCRIPT
                    "ts", "tsx", "mts", "cts", "typescript" -> TYPESCRIPT
                    "json", "jsonc" -> JSON
                    "yml", "yaml" -> YAML
                    "sh", "bash", "zsh", "shell", "fish" -> SHELL
                    "md", "markdown" -> MARKDOWN
                    "rs", "rust" -> RUST
                    "go", "golang" -> GO
                    "rb", "ruby", "gemfile", "rakefile" -> RUBY
                    "css", "scss", "less" -> CSS
                    "html", "htm", "xml", "svg", "vue", "svelte" -> HTML
                    "sql" -> SQL
                    "toml" -> TOML
                    else -> PLAIN
                }
            }
        }
    }

    private class Rule(val regex: JSRegex, val kind: Kind, val group: Int)

    private val keywords: Map<Language, Set<String>> = mapOf(
        Language.SWIFT to setOf("import", "let", "var", "func", "class", "struct", "enum", "protocol", "extension", "actor", "init", "deinit", "return", "if", "else", "guard", "switch", "case", "default", "for", "in", "while", "repeat", "break", "continue", "throw", "throws", "rethrows", "try", "catch", "async", "await", "defer", "where", "as", "is", "nil", "true", "false", "self", "Self", "super", "public", "private", "fileprivate", "internal", "open", "static", "final", "override", "mutating", "nonisolated", "some", "any", "inout", "typealias", "associatedtype", "subscript", "get", "set", "willSet", "didSet", "lazy", "weak", "unowned", "indirect", "convenience", "required", "operator", "precedencegroup", "fallthrough", "do"),
        Language.PYTHON to setOf("import", "from", "as", "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "None", "True", "False", "try", "except", "finally", "raise", "with", "yield", "lambda", "pass", "break", "continue", "global", "nonlocal", "assert", "del", "async", "await", "self", "print"),
        Language.JAVASCRIPT to setOf("import", "export", "from", "default", "const", "let", "var", "function", "class", "extends", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "delete", "typeof", "instanceof", "in", "of", "try", "catch", "finally", "throw", "async", "await", "yield", "this", "super", "null", "undefined", "true", "false", "static", "get", "set"),
        Language.TYPESCRIPT to setOf("import", "export", "from", "default", "const", "let", "var", "function", "class", "extends", "implements", "interface", "type", "enum", "namespace", "declare", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "delete", "typeof", "instanceof", "keyof", "in", "of", "try", "catch", "finally", "throw", "async", "await", "yield", "this", "super", "null", "undefined", "true", "false", "static", "readonly", "public", "private", "protected", "abstract", "as", "satisfies", "get", "set"),
        Language.RUST to setOf("use", "mod", "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "for", "in", "while", "loop", "if", "else", "match", "return", "pub", "crate", "self", "Self", "super", "where", "as", "ref", "move", "async", "await", "dyn", "type", "unsafe", "true", "false", "break", "continue"),
        Language.GO to setOf("package", "import", "func", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "return", "if", "else", "for", "range", "switch", "case", "default", "select", "break", "continue", "fallthrough", "goto", "nil", "true", "false", "make", "new", "len", "cap", "append"),
        Language.RUBY to setOf("def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "require", "include", "extend", "attr_accessor", "attr_reader", "self", "nil", "true", "false", "and", "or", "not", "then", "puts"),
        Language.SHELL to setOf("if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "return", "exit", "export", "local", "readonly", "source", "set", "unset", "echo", "cd", "true", "false"),
        Language.SQL to setOf("select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "limit", "offset", "as", "and", "or", "not", "null", "is", "in", "exists", "primary", "key", "references", "default", "unique", "begin", "commit", "rollback", "with", "union", "distinct", "having", "case", "when", "then", "else", "end"),
        Language.CSS to setOf("important", "media", "import", "font-face", "keyframes", "supports"),
        Language.TOML to setOf("true", "false"),
        Language.YAML to setOf("true", "false", "null", "yes", "no"),
        Language.JSON to setOf("true", "false", "null"),
    )

    private fun literals(language: Language): List<Rule> {
        val rules = mutableListOf(
            Rule(JSRegex("\"(?:\\\\.|[^\"\\\\])*\""), Kind.STRING, 0),
            Rule(JSRegex("'(?:\\\\.|[^'\\\\])*'"), Kind.STRING, 0),
            Rule(JSRegex("\\b(?:0x[0-9A-Fa-f_]+|\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b"), Kind.NUMBER, 0),
        )
        if (language in setOf(Language.SWIFT, Language.JAVASCRIPT, Language.TYPESCRIPT, Language.GO)) rules += Rule(JSRegex("`(?:\\\\.|[^`\\\\])*`"), Kind.STRING, 0)
        if (language == Language.PYTHON) rules.add(0, Rule(JSRegex("(?:\"\"\"|''')[^\\n]*?(?:\"\"\"|''')"), Kind.STRING, 0))
        return rules
    }

    private fun rules(language: Language): List<Rule> = when (language) {
        Language.PLAIN -> emptyList()
        Language.PYTHON, Language.SHELL, Language.YAML, Language.TOML, Language.RUBY -> listOf(Rule(JSRegex("#.*$"), Kind.COMMENT, 0)) + literals(language)
        Language.SQL -> listOf(Rule(JSRegex("--.*$"), Kind.COMMENT, 0)) + literals(language)
        Language.CSS -> listOf(
            Rule(JSRegex("/\\*.*?\\*/"), Kind.COMMENT, 0),
            Rule(JSRegex("(?:^|[\\s{;])([a-z-]+)\\s*:"), Kind.ATTRIBUTE, 1),
            Rule(JSRegex("(?:^|[\\s,}])([.#][A-Za-z_-][\\w-]*)"), Kind.TYPE, 1),
        ) + literals(language)
        Language.HTML -> listOf(
            Rule(JSRegex("<!--.*?-->"), Kind.COMMENT, 0),
            Rule(JSRegex("</?([A-Za-z][\\w:-]*)"), Kind.KEYWORD, 1),
            Rule(JSRegex("\\s([A-Za-z_:][\\w:.-]*)="), Kind.ATTRIBUTE, 1),
        ) + literals(language)
        Language.MARKDOWN -> listOf(
            Rule(JSRegex("^#{1,6}\\s.*$"), Kind.KEYWORD, 0),
            Rule(JSRegex("`[^`]+`"), Kind.STRING, 0),
            Rule(JSRegex("\\*\\*[^*]+\\*\\*"), Kind.TYPE, 0),
            Rule(JSRegex("\\[[^\\]]+\\]\\([^)]+\\)"), Kind.FUNCTION, 0),
        )
        Language.JSON -> listOf(Rule(JSRegex("\"(?:\\\\.|[^\"\\\\])*\"\\s*:"), Kind.ATTRIBUTE, 0)) + literals(language)
        Language.SWIFT, Language.JAVASCRIPT, Language.TYPESCRIPT, Language.RUST, Language.GO ->
            listOf(Rule(JSRegex("//.*$"), Kind.COMMENT, 0), Rule(JSRegex("/\\*.*?\\*/"), Kind.COMMENT, 0)) + literals(language) + listOf(
                Rule(JSRegex("(?:^|[^\\w.])(@[A-Za-z_]\\w*|#[a-z]+\\b)"), Kind.ATTRIBUTE, 1),
                Rule(JSRegex("\\b([A-Z][A-Za-z0-9_]*)\\b"), Kind.TYPE, 1),
                Rule(JSRegex("\\b([a-z_][A-Za-z0-9_]*)\\s*\\("), Kind.FUNCTION, 1),
            )
    }

    private val rulesCache: Map<Language, List<Rule>> = Language.entries.associateWith { rules(it) }
    private val word = JSRegex("[A-Za-z_][A-Za-z0-9_-]*")

    /** Non-overlapping tokens for one line, earliest first; comments and strings shield their contents, keywords win over calls. */
    fun tokenize(line: String, language: Language): List<Token> {
        if (language == Language.PLAIN || line.isEmpty()) return emptyList()
        val taken = mutableListOf<IntRange>()
        val tokens = mutableListOf<Token>()
        fun overlaps(a: IntRange, b: IntRange) = a.first <= b.last && b.first <= a.last
        fun claim(range: IntRange, kind: Kind) {
            if (range.isEmpty() || taken.any { overlaps(it, range) }) return
            taken += range; tokens += Token(range, kind)
        }
        for (rule in rulesCache[language].orEmpty()) {
            val m = rule.regex.pattern.matcher(line)
            while (m.find()) {
                if (rule.group > m.groupCount() || m.start(rule.group) < 0) continue
                claim(m.start(rule.group) until m.end(rule.group), rule.kind)
            }
        }
        val words = keywords[language].orEmpty()
        if (words.isNotEmpty()) {
            val m = word.pattern.matcher(line)
            while (m.find()) {
                val range = m.start() until m.end()
                val text = if (language == Language.SQL) line.substring(range).lowercase() else line.substring(range)
                if (text in words) {
                    taken.removeAll { it == range }; tokens.removeAll { it.range == range }
                    claim(range, Kind.KEYWORD)
                }
            }
        }
        return tokens.sortedBy { it.range.first }
    }
}
