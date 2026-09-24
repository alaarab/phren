import Foundation

/// Transcription of `scanForSecrets` (packages/cli/src/content/secrets.ts).
/// The app refuses to commit any text the CLI itself would have rejected —
/// and, as there, a hit discards the whole text rather than redacting it, so
/// the name-based rules at the end skip values that are plainly placeholders.
public enum SecretScanner {
    /// Unambiguous credential shapes, in secrets.ts order. A documented
    /// example key is still a key, so none of these consult the placeholder
    /// check.
    private static let fixedShapes: [(JSRegex, String)] = [
        (JSRegex(#"AKIA[0-9A-Z]{16}"#), "AWS access key"),
        (JSRegex(#"(?:aws[_-]?secret|AWS_SECRET)[_-]?(?:access[_-]?)?key[_-]?(?:id)?['":\s]+[A-Za-z0-9/+=]{40}"#, caseInsensitive: true), "AWS secret access key"),
        (JSRegex(#"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#), "JWT token"),
        // Fixed-prefix credentials sit above the generic base64 rule so the
        // message names what to strip.
        (JSRegex(#"github_pat_[A-Za-z0-9_]{22,}"#), "GitHub fine-grained token"),
        (JSRegex(#"\bAIza[0-9A-Za-z_-]{35}\b"#), "Google API key"),
        (JSRegex(#"https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+"#), "Slack webhook URL"),
    ]
    private static let afterBase64: [(JSRegex, String)] = [
        (JSRegex(#"(mongodb|postgres|mysql|redis)://[^@\s]+:[^@\s]+@"#, caseInsensitive: true), "connection string with credentials"),
        // Bare `BEGIN PRIVATE KEY` (PKCS#8) is the most common header of all.
        (JSRegex(#"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"#), "SSH private key"),
        (JSRegex(#"sk-ant-api\d{2}-[A-Za-z0-9_\-]{10,}"#), "Anthropic API key"),
        (JSRegex(#"sk-proj-[A-Za-z0-9_\-]{30,}"#), "OpenAI API key"),
        (JSRegex(#"ghp_[A-Za-z0-9]{36}"#), "GitHub personal access token"),
        (JSRegex(#"gho_[A-Za-z0-9]{36}"#), "GitHub OAuth token"),
        (JSRegex(#"gh[pousr]_[A-Za-z0-9]{36}"#), "GitHub token"),
        (JSRegex(#"xoxb-[0-9]+-[A-Za-z0-9-]+"#), "Slack bot token"),
        (JSRegex(#"xoxp-[0-9]+-[A-Za-z0-9-]+"#), "Slack user token"),
        (JSRegex(#"sk_live_[A-Za-z0-9]{24,}"#), "Stripe secret key"),
        (JSRegex(#"pk_live_[A-Za-z0-9]{24,}"#), "Stripe publishable key"),
        (JSRegex(#"npm_[A-Za-z0-9]{36}"#), "npm access token"),
        (JSRegex(#""private_key_id"\s*:\s*"[^"]{20,}""#), "GCP service account key"),
    ]

    /// Name-based rules: a match is inferred from a *name* plus a long value,
    /// so each skips values that are template markers. Capture group 1 is the
    /// value.
    private static let named: [(JSRegex, String)] = [
        (JSRegex(#"\bhttps?://[^/\s:@]+:([^/\s:@]+)@[^\s]+"#, caseInsensitive: true), "URL with embedded credentials"),
        (JSRegex(#"\bauthorization['"]?\s*[=:]\s*['"]?\s*bearer\s+([A-Za-z0-9\-._~+/]{20,}=*)"#, caseInsensitive: true), "bearer token"),
        (JSRegex(#"_auth(?:Token)?\s*=\s*['"]?([A-Za-z0-9\-._~+/]{16,}=*)"#, caseInsensitive: true), "registry auth token"),
        (JSRegex(#"['"]?(?:api_?key|secret|token|password)['"]?\s*[=:]\s*['"]?([a-zA-Z0-9_\-.]{20,})"#, caseInsensitive: true), "API key or secret"),
    ]

    private static let plainHex40 = JSRegex(#"^[0-9a-f]{40}$"#)
    private static let hex40Global = JSRegex(#"[0-9a-f]{40}"#)
    /// secrets.ts: the run must carry a `+` or `/` *and* a digit. 40 random
    /// base64 characters lack a digit ~0.1% of the time; a slash-joined path
    /// or identifier chain (`/Projects/AbletonExtensions/critic/mudpie`)
    /// never has one, and that shape was being refused as a credential.
    private static let base64Blob = JSRegex(#"(?=[A-Za-z0-9+/]*[+/])(?=[A-Za-z+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}"#)

    /// Returns the detected secret type, or nil when clean.
    public static func scan(_ text: String) -> String? {
        for (regex, name) in fixedShapes where regex.test(text) { return name }
        // Long base64 blob, exempting 40-char lowercase hex digests (git SHAs).
        if !plainHex40.test(text), base64Blob.test(hex40Global.replaceAll(text, with: "")) {
            return "long base64 secret"
        }
        for (regex, name) in afterBase64 where regex.test(text) { return name }
        for (regex, name) in named where firstRealSecretValue(text, regex) != nil { return name }
        return nil
    }

    /// The first captured value that is not a placeholder, or nil when every
    /// match is a template marker.
    private static func firstRealSecretValue(_ text: String, _ regex: JSRegex) -> String? {
        regex.allGroups(text).first { !looksLikePlaceholderSecret($0) }
    }

    /// Whether a value captured by a name-based rule is obviously a stand-in
    /// rather than a credential: `<TOKEN>`, `{{token}}`, `${TOKEN}`, `$TOKEN`,
    /// `%TOKEN%`, `__TOKEN__`, masked runs, SCREAMING_SNAKE identifiers, and
    /// whole-value placeholder words. Only whole values count —
    /// `TESTONLYFAKEKEY0000001` contains "FAKE" but is still treated as a
    /// secret.
    static func looksLikePlaceholderSecret(_ value: String) -> Bool {
        let trimmed = JSRegex(#"^['"`]+|['"`]+$"#).replaceAll(value.jsTrimmed, with: "").jsTrimmed
        if trimmed.isEmpty { return true }
        if JSRegex(#"^(?:<[^<>]*>|\{\{[^{}]*\}\}|\$\{[^{}]*\}|%[^%]*%|__.+__|\$[A-Za-z_][A-Za-z0-9_]*)$"#).test(trimmed) { return true }
        if JSRegex(#"^(?:[*.]{3,}|[xX]{4,}|0{8,})$"#).test(trimmed) { return true }
        if JSRegex(#"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$"#).test(trimmed) { return true }
        if JSRegex(#"^(?:changeme|change[_-]?me|placeholder|redacted|example|dummy|sample|fake|todo|fixme|none|null|undefined|secret|pass|passwd|password|token|apikey|api[_-]?key)$"#, caseInsensitive: true).test(trimmed) { return true }
        if JSRegex(#"^(?:your|my|the|some)[_-][a-z0-9_-]*$"#, caseInsensitive: true).test(trimmed) { return true }
        if JSRegex(#"[_-]?goes[_-]?here$"#, caseInsensitive: true).test(trimmed) { return true }
        return false
    }
}
