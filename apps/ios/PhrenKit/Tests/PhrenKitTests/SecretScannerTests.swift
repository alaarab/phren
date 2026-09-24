import XCTest
@testable import PhrenKit

/// Mirrors packages/cli/src/__tests__/secret-scan-precision.test.ts so the
/// app refuses exactly what the CLI refuses. Fixtures are assembled at runtime
/// so static scanners do not flag this file; none are real credentials.
final class SecretScannerTests: XCTestCase {
    func testShapesTheCliAdded() {
        XCTAssertEqual(SecretScanner.scan("-----BEGIN PRIVATE KEY-----"), "SSH private key")
        for label in ["RSA", "EC", "OPENSSH", "DSA", "ENCRYPTED"] {
            XCTAssertEqual(SecretScanner.scan("-----BEGIN \(label) PRIVATE KEY-----"), "SSH private key")
        }
        let pat = "github_pat_" + "11ABCDEFG0" + "abcdefghijklmnopqrstuvwxyz012345"
        XCTAssertEqual(SecretScanner.scan("use \(pat) for the API"), "GitHub fine-grained token")
        let key = "AIza" + "SyD-0123456789abcdefghijklmnopqrstu"
        XCTAssertEqual(SecretScanner.scan("maps key \(key)"), "Google API key")
        let hook = "https://hooks.slack.com/services/" + "T00000000/B00000000/abcdefghijklmnopqrstuvwx"
        XCTAssertEqual(SecretScanner.scan("post to \(hook)"), "Slack webhook URL")
        let remote = "https://" + "octocat:ghs_aBcDeF0123456789xyz@github.com/acme/repo.git"
        XCTAssertEqual(SecretScanner.scan("remote is \(remote)"), "URL with embedded credentials")
        let header = "Authorization: Bearer " + "aBcDeF0123456789ghIjKlMnOpQrStUv"
        XCTAssertEqual(SecretScanner.scan("curl -H \"\(header)\" https://api.example.com"), "bearer token")
        XCTAssertEqual(SecretScanner.scan("//npm.pkg.github.com/:_authToken=" + "ghs0123456789abcdefXYZ"), "registry auth token")
    }

    func testEverythingItFlaggedBefore() {
        XCTAssertEqual(SecretScanner.scan("key is " + "AKIA" + "IOSFODNN7EXAMPLE"), "AWS access key")
        XCTAssertEqual(SecretScanner.scan("token: " + "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def-ghi"), "JWT token")
        XCTAssertEqual(SecretScanner.scan("ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"), "GitHub personal access token")
        XCTAssertEqual(SecretScanner.scan("mongodb://" + "admin:password123@host:27017/db"), "connection string with credentials")
        XCTAssertEqual(SecretScanner.scan("sk-ant-api03-" + "abcdefghij1234567890"), "Anthropic API key")
        let blob = "dGhpc0lzQV9mYWtlU2VjcmV0QmxvYjEyMzQ1Njc4" + "OTBhYmNkZWZnaA/+" + "=="
        XCTAssertEqual(SecretScanner.scan("the dump contained \(blob)"), "long base64 secret")
    }

    func testPlaceholdersDoNotDiscardText() {
        XCTAssertNil(SecretScanner.scan("the injected line is _authToken = '__PHREN_NPM_TOKEN__'"))
        XCTAssertNil(SecretScanner.scan("config uses api_key = \"YOUR_API_KEY_HERE\""))
        XCTAssertNil(SecretScanner.scan("set token: PHREN_EMBEDDING_API_KEY when using a cloud endpoint"))
        XCTAssertNil(SecretScanner.scan("run with Authorization: Bearer $GITHUB_TOKEN please"))
        XCTAssertNil(SecretScanner.scan("remote https://" + "user:${GH_PAT}@github.com/acme/repo"))
        XCTAssertNil(SecretScanner.scan("set token=<your-token-here> in the config"))
        XCTAssertNil(SecretScanner.scan("api_key: \"{{ vault_api_key_value }}\""))
        XCTAssertNil(SecretScanner.scan("log shows password = \"xxxxxxxxxxxxxxxxxxxxxxxx\""))
        XCTAssertNil(SecretScanner.scan("token: ************************"))
    }

    func testOrdinaryProsePathsAndShasPass() {
        XCTAssertNil(SecretScanner.scan("Always use parameterized queries for SQL"))
        XCTAssertNil(SecretScanner.scan("This is a normal finding about Redis caching"))
        XCTAssertNil(SecretScanner.scan(""))
        XCTAssertNil(SecretScanner.scan("Prefer /Users/alice/Sites/phren over a relative path"))
        XCTAssertNil(SecretScanner.scan("git commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a is the fix"))
        // The skill-move regression: a slash-joined path with no digit.
        XCTAssertNil(SecretScanner.scan("Run it from /Projects/AbletonExtensions/critic/mudpie before recording."))
        XCTAssertNil(SecretScanner.scan("addFindingToFile/addFindingsToFile/upsertCanonical resolve across stores"))
        XCTAssertNil(SecretScanner.scan("packages/cli/src/content/learning and friends were updated"))
    }

    func testPlaceholderNextToARealSecretStillFailsClosed() {
        let real = "api_key = " + "aBcD3fGh1JkLmN0pQrStUvWxYz012345"
        XCTAssertEqual(SecretScanner.scan("token = \"<placeholder>\" and \(real)"), "API key or secret")
        XCTAssertEqual(SecretScanner.scan("api_key = \"sk_live_" + "TESTONLYFAKEKEY0000001\""), "API key or secret")
    }

    func testPlaceholderRecognition() {
        for value in ["<token>", "{{ api_key }}", "${GITHUB_TOKEN}", "%API_KEY%", "__PHREN_NPM_TOKEN__", "$GH_PAT",
                      "YOUR_API_KEY_HERE", "xxxxxxxx", "************", "00000000", "changeme", "REDACTED",
                      "your-token", "api_key_goes_here", "''", "   ", "'__TEMPLATE__'"] {
            XCTAssertTrue(SecretScanner.looksLikePlaceholderSecret(value), value)
        }
        for value in ["aBcD3fGh1JkLmN0pQrStUvWxYz012345", "sk_live_TESTONLYFAKEKEY0000001",
                      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", "password123", "hunter2", "AKIAIOSFODNN7EXAMPLE",
                      "\"aBcD3fGh1JkLmN0pQrStUvWxYz012345\""] {
            XCTAssertFalse(SecretScanner.looksLikePlaceholderSecret(value), value)
        }
    }
}
