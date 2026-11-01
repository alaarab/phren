/**
 * Direct contract tests for content/secrets.ts.
 *
 * The shapes already pinned in __tests__/secret-scan-precision.test.ts (AWS
 * access key, JWT, GitHub classic PAT, Google, Slack webhook, long base64,
 * private-key headers, Anthropic, and the URL / bearer / registry / generic
 * name rules) and the placeholder rules are not repeated here. This file
 * covers the remaining credential kinds the detector claims, the redaction
 * output, near-misses that must stay clean, and multi-secret priority.
 *
 * Fixtures are assembled at runtime so static secret scanners and GitHub push
 * protection do not flag this file. None of them are real credentials.
 */
import { describe, expect, it } from "vitest";
import { redactSecretsForLog, scanForSecrets } from "./secrets.js";

// Canonical AWS documentation example key, not a live credential.
const AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
const AWS_ACCESS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GH_SUFFIX = ["0123456789abcdef", "ABCDEFGHIJKLMNOP", "qrst"].join("");
const GH_OAUTH = ["gho", GH_SUFFIX].join("_");
const GH_SERVER = ["ghs", GH_SUFFIX].join("_");
const GH_USER = ["ghu", GH_SUFFIX].join("_");
const GH_REFRESH = ["ghr", GH_SUFFIX].join("_");
const OPENAI_KEY = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"].join("-");
const STRIPE_KEY = "aBcD3fGh1JkLmN0pQrStUvWx";
const STRIPE_SECRET = ["sk", "live", STRIPE_KEY].join("_");
const STRIPE_PUBLISHABLE = ["pk", "live", STRIPE_KEY].join("_");
const NPM_TOKEN = "aBcD3fGh1JkLmN0pQrStUvWxYz0123456789";
const NPM_KEY = ["npm", NPM_TOKEN].join("_");
const GENERIC_VALUE = "aBcD3fGh1JkLmN0pQrStUvWxYz012345";
const SLACK_BOT = ["xoxb", "123456789012", "abcDEF123456ghiJKL"].join("-");
const SLACK_USER = ["xoxp", "123456789012", "abcDEF123456ghiJKL"].join("-");
const BEARER_VALUE = "aBcDeF0123456789ghIjKlMnOpQrStUv";
const INLINE_CRED_URL = ["https://user", "pw@host/path"].join(":");
const MYSQL_URL = ["mysql://user", "pass@host:3306/db"].join(":");
const REDIS_URL = ["redis://default", "hunter2@cache:6379/0"].join(":");

describe("scanForSecrets — credential kinds", () => {
  it.each([
    ["AWS secret key in an env assignment", `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, "AWS secret access key"],
    ["AWS secret key in a spaced config assignment", `aws_secret_access_key = "${AWS_SECRET}"`, "AWS secret access key"],
    ["OpenAI project key", `OPENAI_API_KEY=${OPENAI_KEY}`, "OpenAI API key"],
    ["GitHub OAuth token", `token ${GH_OAUTH}`, "GitHub OAuth token"],
    ["GitHub server-to-server token", `token ${GH_SERVER}`, "GitHub token"],
    ["GitHub user token", `token ${GH_USER}`, "GitHub token"],
    ["GitHub refresh token", `token ${GH_REFRESH}`, "GitHub token"],
    ["Slack bot token", SLACK_BOT, "Slack bot token"],
    ["Slack user token", SLACK_USER, "Slack user token"],
    ["Stripe live secret key", STRIPE_SECRET, "Stripe secret key"],
    ["Stripe live publishable key", STRIPE_PUBLISHABLE, "Stripe publishable key"],
    ["npm access token", NPM_KEY, "npm access token"],
    ["GCP service-account private key id", `{"private_key_id": "${GENERIC_VALUE}"}`, "GCP service account key"],
    ["MySQL URL with credentials", MYSQL_URL, "connection string with credentials"],
    ["Redis URL with credentials", REDIS_URL, "connection string with credentials"],
  ])("flags %s", (_label, text, expected) => {
    expect(scanForSecrets(text)).toBe(expected);
  });
});

describe("scanForSecrets — near misses that must stay clean", () => {
  it.each([
    ["a UUID", "123e4567-e89b-12d3-a456-426614174000"],
    ["a SHA-256 hex digest", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["prose that mentions a token", "Rotate the token before the next deploy and never log it"],
    ["prose that mentions a password", "The password belongs in the keychain, not the repo"],
    ["a URL without inline credentials", "https://github.com/acme/repo.git"],
    ["a secret name with no assigned value", "The api_key setting is read from the environment"],
  ])("does not flag %s", (_label, text) => {
    expect(scanForSecrets(text)).toBeNull();
  });
});

describe("scanForSecrets — multiple secrets in one text", () => {
  it("names the high-confidence AWS key even when a generic secret appears first", () => {
    expect(scanForSecrets(`api_key = ${GENERIC_VALUE} and ${AWS_ACCESS_KEY}`)).toBe("AWS access key");
  });

  it("names the embedded-credential URL when a bearer header appears too", () => {
    expect(
      scanForSecrets(`Authorization: Bearer ${BEARER_VALUE} then ${INLINE_CRED_URL}`),
    ).toBe("URL with embedded credentials");
  });
});

describe("redactSecretsForLog", () => {
  it("returns clean diagnostics unchanged", () => {
    const text = "PostToolUse: ./check.sh exited 1: command not found";
    expect(redactSecretsForLog(text)).toBe(text);
  });

  it("withholds the whole diagnostic and names the credential", () => {
    expect(redactSecretsForLog(`curl failed for ${AWS_ACCESS_KEY}`)).toBe(
      "[redacted: withheld, contained AWS access key]",
    );
  });

  it("emits no part of the original text", () => {
    const out = redactSecretsForLog(`leaked ${AWS_ACCESS_KEY} in stderr`);
    expect(out).not.toContain(AWS_ACCESS_KEY);
    expect(out).not.toContain("leaked");
  });

  it("names the highest-priority credential in multi-secret text", () => {
    expect(redactSecretsForLog(`token = ${GENERIC_VALUE} and ${AWS_ACCESS_KEY}`)).toBe(
      "[redacted: withheld, contained AWS access key]",
    );
  });

  it("leaves a placeholder-only diagnostic intact", () => {
    const text = 'config uses api_key = "YOUR_API_KEY_HERE"';
    expect(redactSecretsForLog(text)).toBe(text);
  });
});
