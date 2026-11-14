import { expect, it } from "vitest";
import { secretName, secretPatch } from "./changes.js";

it("withholds diffs of credential files the phone has no business showing", () => {
  for (const name of [".env", ".env.local", "prod.env", "AuthKey_ABC123.p8", "release.jks", "app.keystore", "id_ecdsa", "id_ed25519_dispatch",
    "credentials", ".git-credentials", ".credentials", ".pgpass", "prod.tfvars", "kubeconfig", "server.key", "dir/.npmrc"]) {
    expect(secretName(name), name).toBe(true);
  }
  for (const name of ["id_ed25519.pub", "id_ed25519_dispatch.pub", "environment.ts", "keys.swift", "README.md", "package-lock.json"]) {
    expect(secretName(name), name).toBe(false);
  }
});

it("withholds a patch that carries a credential in an ordinary file", () => {
  const diff = (line: string) => `diff --git a/config.ts b/config.ts\n@@ -1 +1 @@\n-export const x = 1;\n+${line}\n`;
  expect(secretPatch(diff(`const key = "${"AKIA"}ABCDEFGHIJKLMNOP";`))).toBe(true);
  expect(secretPatch(diff(`const pem = "-----BEGIN ${"PRIVATE"} KEY-----";`))).toBe(true);
  expect(secretPatch(diff(`const url = "https://bob:${"s3cretValue99"}@git.example.com/repo";`))).toBe(true);
  expect(secretPatch(diff("export const x = 2;"))).toBe(false);
  // A lockfile's integrity hashes are long base64, not credentials.
  expect(secretPatch(diff(`"integrity": "sha512-${"q".repeat(30)}+${"Z9".repeat(30)}/w=="`))).toBe(false);
});
