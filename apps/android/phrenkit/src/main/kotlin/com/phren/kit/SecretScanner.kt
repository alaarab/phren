package com.phren.kit

/**
 * Transcription of `scanForSecrets` (packages/cli/src/content/dedup.ts:479).
 * The app refuses to commit any text the CLI itself would have rejected.
 */
object SecretScanner {
    private val checks: List<Pair<JSRegex, String>> = listOf(
        JSRegex("""AKIA[0-9A-Z]{16}""") to "AWS access key",
        JSRegex("""(?:aws[_-]?secret|AWS_SECRET)[_-]?(?:access[_-]?)?key[_-]?(?:id)?['":\s]+[A-Za-z0-9/+=]{40}""", caseInsensitive = true) to "AWS secret access key",
        JSRegex("""eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+""") to "JWT token",
        JSRegex("""(mongodb|postgres|mysql|redis)://[^@\s]+:[^@\s]+@""", caseInsensitive = true) to "connection string with credentials",
        JSRegex("""-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----""") to "SSH private key",
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
        JSRegex("""['"]?(api_?key|secret|token|password)['"]?\s*[=:]\s*['"]?[a-zA-Z0-9_\-\.]{20,}""", caseInsensitive = true) to "API key or secret",
    )

    private val plainHex40 = JSRegex("""^[0-9a-f]{40}$""")
    private val hex40Global = JSRegex("""[0-9a-f]{40}""")
    private val base64Blob = JSRegex("""(?=[A-Za-z0-9+/]*[+/][A-Za-z0-9+/]*)[A-Za-z0-9+/]{40,}={0,2}""")

    /** Returns the detected secret type, or null when clean. */
    fun scan(text: String): String? {
        checks.forEachIndexed { index, (regex, label) ->
            if (index == 3) {
                // dedup.ts: long base64 blob check (between JWT and connection
                // strings), exempting 40-char lowercase hex digests (git SHAs).
                if (!plainHex40.test(text) && base64Blob.test(hex40Global.replaceAll(text, ""))) {
                    return "long base64 secret"
                }
            }
            if (regex.test(text)) return label
        }
        return null
    }
}
