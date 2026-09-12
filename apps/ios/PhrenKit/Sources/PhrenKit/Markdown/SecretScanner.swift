import Foundation

/// Transcription of `scanForSecrets` (packages/cli/src/content/dedup.ts:479).
/// The app refuses to commit any text the CLI itself would have rejected.
public enum SecretScanner {
    private static let checks: [(JSRegex, String)] = [
        (JSRegex(#"AKIA[0-9A-Z]{16}"#), "AWS access key"),
        (JSRegex(#"(?:aws[_-]?secret|AWS_SECRET)[_-]?(?:access[_-]?)?key[_-]?(?:id)?['":\s]+[A-Za-z0-9/+=]{40}"#, caseInsensitive: true), "AWS secret access key"),
        (JSRegex(#"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#), "JWT token"),
        (JSRegex(#"(mongodb|postgres|mysql|redis)://[^@\s]+:[^@\s]+@"#, caseInsensitive: true), "connection string with credentials"),
        (JSRegex(#"-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----"#), "SSH private key"),
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
        (JSRegex(#"['"]?(api_?key|secret|token|password)['"]?\s*[=:]\s*['"]?[a-zA-Z0-9_\-\.]{20,}"#, caseInsensitive: true), "API key or secret"),
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
        // Ordered as secrets.ts — the base64 check sits between JWT and
        // connection strings there.
        for (index, check) in checks.enumerated() {
            if index == 3 {
                // secrets.ts: long base64 blob check, exempting 40-char
                // lowercase hex digests (git commit SHAs).
                if !plainHex40.test(text), base64Blob.test(hex40Global.replaceAll(text, with: "")) {
                    return "long base64 secret"
                }
            }
            if check.0.test(text) { return check.1 }
        }
        return nil
    }
}
