package com.phren.kit

/**
 * Transcription of `scanForSecrets` (packages/cli/src/content/dedup.ts) via
 * SecretScanner.swift. The app refuses to commit any text the CLI would reject.
 */
object SecretScanner {
    // Fixed-prefix credentials sit above the generic base64 rule so the message names what to strip.
    private val fixedShapes = listOf(
        JSRegex("""AKIA[0-9A-Z]{16}""") to "AWS access key",
        JSRegex("""(?:aws[_-]?secret|AWS_SECRET)[_-]?(?:access[_-]?)?key[_-]?(?:id)?['":\s]+[A-Za-z0-9/+=]{40}""", caseInsensitive = true) to "AWS secret access key",
        JSRegex("""eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+""") to "JWT token",
        JSRegex("""github_pat_[A-Za-z0-9_]{22,}""") to "GitHub fine-grained token",
        JSRegex("""\bAIza[0-9A-Za-z_-]{35}\b""") to "Google API key",
        JSRegex("""https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+""") to "Slack webhook URL",
    )
    private val afterBase64 = listOf(
        JSRegex("""(mongodb|postgres|mysql|redis)://[^@\s]+:[^@\s]+@""", caseInsensitive = true) to "connection string with credentials",
        // Bare `BEGIN PRIVATE KEY` (PKCS#8) is the most common header of all.
        JSRegex("""-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----""") to "SSH private key",
        JSRegex("""sk-ant-api\d{2}-[A-Za-z0-9_\-]{10,}""") to "Anthropic API key",
        JSRegex("""sk-proj-[A-Za-z0-9_\-]{30,}""") to "OpenAI API key",
        JSRegex("""ghp_[A-Za-z0-9]{36}""") to "GitHub personal access token",
        JSRegex("""gho_[A-Za-z0-9]{36}""") to "GitHub OAuth token",
        JSRegex("""gh[pousr]_[A-Za-z0-9]{36}""") to "GitHub token",
        JSRegex("""xoxb-[0-9]+-[A-Za-z0-9-]+""") to "Slack bot token",
        JSRegex("""xoxp-[0-9]+-[A-Za-z0-9-]+""") to "Slack user token",
        JSRegex("""sk_live_[A-Za-z0-9]{24,}""") to "Stripe secret key",
        JSRegex("""pk_live_[A-Za-z0-9]{24,}""") to "Stripe publishable key",
        JSRegex("""npm_[A-Za-z0-9]{36}""") to "npm access token",
        JSRegex(""""private_key_id"\s*:\s*"[^"]{20,}"""") to "GCP service account key",
    )
    private val named = listOf(
        JSRegex("""\bhttps?://[^/\s:@]+:([^/\s:@]+)@[^\s]+""", caseInsensitive = true) to "URL with embedded credentials",
        JSRegex("""\bauthorization['"]?\s*[=:]\s*['"]?\s*bearer\s+([A-Za-z0-9\-._~+/]{20,}=*)""", caseInsensitive = true) to "bearer token",
        JSRegex("""_auth(?:Token)?\s*=\s*['"]?([A-Za-z0-9\-._~+/]{16,}=*)""", caseInsensitive = true) to "registry auth token",
        JSRegex("""['"]?(?:api_?key|secret|token|password)['"]?\s*[=:]\s*['"]?([a-zA-Z0-9_\-.]{20,})""", caseInsensitive = true) to "API key or secret",
    )

    private val plainHex40 = JSRegex("""^[0-9a-f]{40}$""")
    private val hex40Global = JSRegex("""[0-9a-f]{40}""")
    private val base64Blob = JSRegex("""(?=[A-Za-z0-9+/]*[+/])(?=[A-Za-z+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}""")

    /** Returns the detected secret type, or null when clean. */
    fun scan(text: String): String? {
        for ((regex, name) in fixedShapes) if (regex.test(text)) return name
        // Long base64 blob, exempting 40-char lowercase hex digests (git SHAs).
        if (!plainHex40.test(text) && base64Blob.test(hex40Global.replaceAll(text, ""))) return "long base64 secret"
        for ((regex, name) in afterBase64) if (regex.test(text)) return name
        for ((regex, name) in named) if (regex.allGroups(text).any { !looksLikePlaceholderSecret(it) }) return name
        return null
    }

    private val EDGE_QUOTES = JSRegex("""^['"`]+|['"`]+$""")
    private val TEMPLATE = JSRegex("""^(?:<[^<>]*>|\{\{[^{}]*\}\}|\$\{[^{}]*\}|%[^%]*%|__.+__|\$[A-Za-z_][A-Za-z0-9_]*)$""")
    private val MASK = JSRegex("""^(?:[*.]{3,}|[xX]{4,}|0{8,})$""")
    private val ENV_NAME = JSRegex("""^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$""")
    private val WORDS = JSRegex("""^(?:changeme|change[_-]?me|placeholder|redacted|example|dummy|sample|fake|todo|fixme|none|null|undefined|secret|pass|passwd|password|token|apikey|api[_-]?key)$""", caseInsensitive = true)
    private val YOUR = JSRegex("""^(?:your|my|the|some)[_-][a-z0-9_-]*$""", caseInsensitive = true)
    private val GOES_HERE = JSRegex("""[_-]?goes[_-]?here$""", caseInsensitive = true)

    internal fun looksLikePlaceholderSecret(value: String): Boolean {
        val trimmed = EDGE_QUOTES.replaceAll(value.jsTrimmed, "").jsTrimmed
        return trimmed.isEmpty() || TEMPLATE.test(trimmed) || MASK.test(trimmed) || ENV_NAME.test(trimmed) ||
            WORDS.test(trimmed) || YOUR.test(trimmed) || GOES_HERE.test(trimmed)
    }
}
