package com.phren.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import com.phren.kit.SyntaxTokenizer.Kind
import com.phren.kit.SyntaxTokenizer.Language

/** SyntaxTokenizerTests.swift, case for case. */
class SyntaxTokenizerTests {
    private fun kinds(line: String, language: Language) = SyntaxTokenizer.tokenize(line, language).map { line.substring(it.range) to it.kind }

    @Test fun detectsLanguagesFromPathsAndFenceLabels() {
        assertEquals(Language.SWIFT, Language.detect("Sources/App/Theme.swift"))
        assertEquals(Language.PYTHON, Language.detect("scripts/deploy-phone.py"))
        assertEquals(Language.TYPESCRIPT, Language.detect("ts"))
        assertEquals(Language.SHELL, Language.detect("bash"))
        assertEquals(Language.PLAIN, Language.detect("Makefile"))
        assertEquals(Language.PLAIN, Language.detect(null))
    }

    @Test fun swiftLineTintsKeywordsTypesCallsStringsAndComments() {
        val tokens = kinds("let accent = Color(hex: 0xB994F4) // the theme's purple", Language.SWIFT)
        assertEquals("let" to Kind.KEYWORD, tokens.first())
        assertTrue(tokens.any { it == ("Color" to Kind.FUNCTION) || it == ("Color" to Kind.TYPE) })
        assertTrue(tokens.any { it == ("0xB994F4" to Kind.NUMBER) })
        assertTrue(tokens.any { it.first.startsWith("//") && it.second == Kind.COMMENT })
        assertFalse(tokens.any { it == ("the" to Kind.KEYWORD) })
    }

    @Test fun stringsShieldTheirContents() {
        val tokens = kinds("print(\"if this were code\", 12)", Language.PYTHON)
        assertEquals(listOf("print", "\"if this were code\"", "12"), tokens.map { it.first })
        assertEquals(listOf(Kind.KEYWORD, Kind.STRING, Kind.NUMBER), tokens.map { it.second })
    }

    @Test fun jsonKeysAndShellCommentsAndPlain() {
        assertEquals(listOf(Kind.ATTRIBUTE, Kind.STRING, Kind.ATTRIBUTE, Kind.NUMBER), kinds("  \"content\": \"import Foundation\", \"count\": 3", Language.JSON).map { it.second })
        assertEquals(listOf("export", "# tools"), kinds("export PATH=/usr/bin # tools", Language.SHELL).map { it.first })
        assertTrue(kinds("anything at all", Language.PLAIN).isEmpty())
        assertTrue(SyntaxTokenizer.tokenize("", Language.SWIFT).isEmpty())
    }

    @Test fun tokensNeverOverlapAndAreOrdered() {
        val line = "func run(_ name: String) throws -> [Token] { return \"x\\\"y\" }"
        val tokens = SyntaxTokenizer.tokenize(line, Language.SWIFT)
        tokens.zipWithNext().forEach { (a, b) -> assertTrue(a.range.last < b.range.first) }
    }
}
