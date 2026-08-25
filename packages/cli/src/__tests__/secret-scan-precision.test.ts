/**
 * scanForSecrets is a *gate*, not a scrubber: a hit discards the whole finding
 * and tells the user to strip it by hand. So the two failure modes are not
 * symmetric — a miss leaks a credential into a store that may be pushed to a
 * git remote, but a false positive silently costs the user knowledge they
 * meant to keep. These tests pin both directions.
 *
 * Fixtures are assembled at runtime so static secret scanners do not flag this
 * file. None of them are real credentials.
 */
import { describe, expect, it } from "vitest";
import { scanForSecrets, looksLikePlaceholderSecret } from "../content/dedup.js";

describe("scanForSecrets — shapes that were previously missed", () => {
  it("flags a bare PKCS#8 private key header", () => {
    // The alternation was RSA|EC|OPENSSH, so the most common header of all —
    // what `openssl genpkey` and every GCP service-account .pem emit — passed.
    expect(scanForSecrets("-----BEGIN PRIVATE KEY-----")).toBe("SSH private key");
  });

  it("still flags the labelled private key headers", () => {
    for (const label of ["RSA", "EC", "OPENSSH", "DSA", "ENCRYPTED"]) {
      expect(scanForSecrets(`-----BEGIN ${label} PRIVATE KEY-----`)).toBe("SSH private key");
    }
  });

  it("flags a GitHub fine-grained PAT", () => {
    const pat = "github_pat_" + "11ABCDEFG0" + "abcdefghijklmnopqrstuvwxyz012345";
    expect(scanForSecrets(`use ${pat} for the API`)).toBe("GitHub fine-grained token");
  });

  it("flags a Google API key", () => {
    const key = "AIza" + "SyD-0123456789abcdefghijklmnopqrstu";
    expect(scanForSecrets(`maps key ${key}`)).toBe("Google API key");
  });

  it("flags a Slack webhook URL", () => {
    const url = "https://hooks.slack.com/services/" + "T00000000/B00000000/abcdefghijklmnopqrstuvwx";
    expect(scanForSecrets(`post to ${url}`)).toBe("Slack webhook URL");
  });

  it("flags an https URL with embedded credentials", () => {
    // The old rule only covered mongodb/postgres/mysql/redis, so the form that
    // actually appears in captured git remotes and curl output went through.
    const url = "https://" + "octocat:ghs_aBcDeF0123456789xyz@github.com/acme/repo.git";
    expect(scanForSecrets(`remote is ${url}`)).toBe("URL with embedded credentials");
  });

  it("flags an Authorization: Bearer header", () => {
    const header = "Authorization: Bearer " + "aBcDeF0123456789ghIjKlMnOpQrStUv";
    expect(scanForSecrets(`curl -H "${header}" https://api.example.com`)).toBe("bearer token");
  });

  it("flags a registry auth token line", () => {
    const line = "//npm.pkg.github.com/:_authToken=" + "ghs0123456789abcdefXYZ";
    expect(scanForSecrets(line)).toBe("registry auth token");
  });

  it("still flags everything it flagged before", () => {
    expect(scanForSecrets("key is " + "AKIA" + "IOSFODNN7EXAMPLE")).toBe("AWS access key");
    expect(scanForSecrets("token: " + "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def-ghi")).toBe("JWT token");
    expect(scanForSecrets("ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe("GitHub personal access token");
    expect(scanForSecrets("mongodb://" + "admin:password123@host:27017/db")).toBe("connection string with credentials");
    expect(scanForSecrets("sk-ant-api03-" + "abcdefghij1234567890")).toBe("Anthropic API key");
  });
});

describe("scanForSecrets — precision on template markers", () => {
  // The store contains an auto-captured finding quoting phren's own web-UI
  // source, including `_authToken = '__PHRE…'`. Tool-output capture routinely
  // reaches into credential-shaped code that holds no credential, and the
  // name-based rules fire on shape alone.

  it("does not discard a finding over a __TEMPLATE__ marker", () => {
    expect(scanForSecrets("the injected line is _authToken = '__PHREN_NPM_TOKEN__'")).toBeNull();
  });

  it("does not discard a finding over a SCREAMING_SNAKE stand-in", () => {
    expect(scanForSecrets('config uses api_key = "YOUR_API_KEY_HERE"')).toBeNull();
    expect(scanForSecrets("set token: PHREN_EMBEDDING_API_KEY when using a cloud endpoint")).toBeNull();
  });

  it("does not discard a finding over shell interpolation", () => {
    expect(scanForSecrets('run with Authorization: Bearer $GITHUB_TOKEN please')).toBeNull();
    expect(scanForSecrets("remote https://" + "user:${GH_PAT}@github.com/acme/repo")).toBeNull();
  });

  it("does not discard a finding over an angle-bracket or mustache placeholder", () => {
    expect(scanForSecrets("set token=<your-token-here> in the config")).toBeNull();
    expect(scanForSecrets('api_key: "{{ vault_api_key_value }}"')).toBeNull();
  });

  it("does not discard a finding over a masked value", () => {
    expect(scanForSecrets('log shows password = "xxxxxxxxxxxxxxxxxxxxxxxx"')).toBeNull();
    expect(scanForSecrets("token: ************************")).toBeNull();
  });

  it("does not discard ordinary prose or code", () => {
    expect(scanForSecrets("Always use parameterized queries for SQL")).toBeNull();
    expect(scanForSecrets("The build system uses webpack 5")).toBeNull();
    expect(scanForSecrets("This is a normal finding about Redis caching")).toBeNull();
    expect(scanForSecrets("")).toBeNull();
    expect(scanForSecrets("Prefer /Users/alice/Sites/phren over a relative path")).toBeNull();
    expect(scanForSecrets("git commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a is the fix")).toBeNull();
  });

  it("does not discard slash-joined identifier chains as base64", () => {
    // A 40+ char run of letters and slashes with no digit is prose naming
    // functions, not an encoded credential. This exact shape was rejected.
    expect(
      scanForSecrets("addFindingToFile/addFindingsToFile/upsertCanonical resolve across stores"),
    ).toBeNull();
    expect(scanForSecrets("packages/cli/src/content/learning and friends were updated")).toBeNull();
  });

  it("still flags a digit-bearing base64 blob", () => {
    // Assembled at runtime; not a real credential.
    const blob = "dGhpc0lzQV9mYWtlU2VjcmV0QmxvYjEyMzQ1Njc4" + "OTBhYmNkZWZnaA/+" + "==";
    expect(scanForSecrets(`the dump contained ${blob}`)).toBe("long base64 secret");
  });

  it("a placeholder next to a real secret still fails closed", () => {
    const real = "api_key = " + "aBcD3fGh1JkLmN0pQrStUvWxYz012345";
    expect(scanForSecrets(`token = "<placeholder>" and ${real}`)).toBe("API key or secret");
  });

  it("does not treat a real-looking value as a placeholder just because it contains a word", () => {
    // "TESTONLYFAKEKEY0000001" contains FAKE but is not itself a placeholder.
    expect(scanForSecrets('api_key = "sk_live_' + 'TESTONLYFAKEKEY0000001"')).toBe("API key or secret");
  });
});

describe("looksLikePlaceholderSecret", () => {
  it("recognizes template forms", () => {
    for (const v of [
      "<token>",
      "{{ api_key }}",
      "${GITHUB_TOKEN}",
      "%API_KEY%",
      "__PHREN_NPM_TOKEN__",
      "$GH_PAT",
      "YOUR_API_KEY_HERE",
      "xxxxxxxx",
      "************",
      "00000000",
      "changeme",
      "REDACTED",
      "your-token",
      "api_key_goes_here",
      "''",
      "   ",
    ]) {
      expect(looksLikePlaceholderSecret(v), v).toBe(true);
    }
  });

  it("does not recognize credential-shaped values", () => {
    for (const v of [
      "aBcD3fGh1JkLmN0pQrStUvWxYz012345",
      "sk_live_TESTONLYFAKEKEY0000001",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      "password123",
      "hunter2",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      expect(looksLikePlaceholderSecret(v), v).toBe(false);
    }
  });

  it("strips surrounding quotes before judging", () => {
    expect(looksLikePlaceholderSecret("'__TEMPLATE__'")).toBe(true);
    expect(looksLikePlaceholderSecret('"aBcD3fGh1JkLmN0pQrStUvWxYz012345"')).toBe(false);
  });
});
