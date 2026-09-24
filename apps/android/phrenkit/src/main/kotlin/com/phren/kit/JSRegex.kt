package com.phren.kit

import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * java.util.regex wrapper with JavaScript semantics, so the patterns
 * transcribed from packages/cli/src/content/metadata.ts behave identically to
 * their TypeScript originals (port of JSRegex.swift).
 *
 * The one real gap between the engines is `\s`: JS matches Unicode whitespace
 * (NBSP, U+2028, BOM, ...) while Java's `\s` is ASCII-only. [jsPattern]
 * rewrites every `\s` to the JS set; `\w`/`\d` are ASCII in both.
 */
class JSRegex private constructor(val pattern: Pattern) {
    constructor(source: String, caseInsensitive: Boolean = false) :
        this(Pattern.compile(jsPattern(source), if (caseInsensitive) Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE else 0))

    fun test(s: String): Boolean = pattern.matcher(s).find()

    fun firstMatch(s: String): Matcher? {
        val m = pattern.matcher(s)
        return if (m.find()) m else null
    }

    /** Equivalent of `s.match(re)?.[group]` for the first match. */
    fun group(s: String, group: Int = 1): String? = firstMatch(s)?.let { substring(it, group) }

    /** All capture-group values, like `[...s.matchAll(re)].map(m => m[1])`. */
    fun allGroups(s: String, group: Int = 1): List<String> {
        val m = pattern.matcher(s)
        val out = mutableListOf<String>()
        while (m.find()) substring(m, group)?.let(out::add)
        return out
    }

    /** All whole-match values, like `s.match(/.../g)`. */
    fun allMatches(s: String): List<String> = allGroups(s, 0)

    /** `s.replace(re, replacement)` with a global regex; replacement is literal. */
    fun replaceAll(s: String, replacement: String): String =
        pattern.matcher(s).replaceAll(Matcher.quoteReplacement(replacement))

    /** Non-global `s.replace(re, replacement)`: first match only. */
    fun replaceFirst(s: String, replacement: String): String =
        pattern.matcher(s).replaceFirst(Matcher.quoteReplacement(replacement))

    companion object {
        /** JS `^`/`$` at line boundaries (the `m` flag). */
        fun multiline(source: String): JSRegex = JSRegex(Pattern.compile(jsPattern(source), Pattern.MULTILINE))

        fun substring(m: Matcher, group: Int): String? =
            if (group <= m.groupCount()) m.group(group) else null

        /** The members of JS's `\s` (ECMA-262 WhiteSpace + LineTerminator). */
        private const val JS_WS = "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"

        /** Rewrite `\s` / `\S` to the JS whitespace set, inside or outside a class. */
        internal fun jsPattern(source: String): String {
            val out = StringBuilder()
            var inClass = false
            var i = 0
            while (i < source.length) {
                val c = source[i]
                if (c == '\\' && i + 1 < source.length) {
                    val n = source[i + 1]
                    when {
                        n == 's' -> out.append(if (inClass) JS_WS else "[$JS_WS]")
                        n == 'S' && !inClass -> out.append("[^$JS_WS]")
                        else -> out.append(c).append(n)
                    }
                    i += 2
                    continue
                }
                if (c == '[' && !inClass) inClass = true
                else if (c == ']' && inClass) inClass = false
                out.append(c)
                i++
            }
            return out.toString()
        }

        private val JS_WS_CHARS: (Char) -> Boolean = { ch ->
            ch == '\t' || ch == '\n' || ch == '\u000B' || ch == '\u000C' || ch == '\r' || ch == ' ' ||
                ch == ' ' || ch == ' ' || ch in ' '..' ' || ch == ' ' ||
                ch == ' ' || ch == ' ' || ch == ' ' || ch == '　' || ch == '﻿'
        }

        fun isJsWhitespace(ch: Char): Boolean = JS_WS_CHARS(ch)
    }
}

/** JS `String.prototype.trim()`. */
val String.jsTrimmed: String get() = trim(JSRegex::isJsWhitespace)

private val WHITESPACE_RUN = JSRegex("\\s+")

/** JS `s.replace(/\s+/g, " ")`. */
val String.collapsedWhitespace: String get() = WHITESPACE_RUN.replaceAll(this, " ")
