import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { keyFingerprint, newPairingCode, normalizeCode, pairingCheckCode, pairingProof, pairingURL, printableName, scanProof, startPairing } from "./pair.js";

let root: string, publicKey: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-pair-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "phone", "-f", path.join(root, "phone")]);
  publicKey = (await readFile(path.join(root, "phone.pub"), "utf8")).trim().split(" ").slice(0, 2).join(" ");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const post = (port: number, body: unknown) => fetch(`http://127.0.0.1:${port}/v1/pair`, { method: "POST", body: JSON.stringify(body) });

it("authorizes the phone's key once it proves the scanned code and secret, and proves the host back", async () => {
  const code = "ABC234", scanSecret = "c2Nhbi1zZWNyZXQ", fingerprint = keyFingerprint(publicKey)!;
  const session = await startPairing({ code, scanSecret, user: "me", sshPort: 22, fingerprint, name: "box", port: 0, sshDirectory: path.join(root, ".ssh") });
  const wrong = await post(session.port, { v: 1, publicKey, proof: scanProof(code, "another-secret", "phone", publicKey) });
  expect(wrong.status).toBe(403);
  const ok = await post(session.port, { v: 1, publicKey, proof: scanProof("abc-234", scanSecret, "phone", publicKey), name: "Sam's iPhone" });
  expect(ok.status).toBe(200);
  const answer = await ok.json() as { proof: string; fingerprint: string; user: string };
  expect(answer).toMatchObject({ user: "me", fingerprint });
  expect(answer.proof).toBe(scanProof(code, scanSecret, "computer", fingerprint, publicKey));
  await expect(session.done).resolves.toMatchObject({ device: "ios", name: "Sam's iPhone" });
  const keys = await readFile(path.join(root, ".ssh", "authorized_keys"), "utf8");
  expect(keys).toBe(`restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ${publicKey} phren-iphone\n`);
});

it("the code alone never authorizes a key unless the computer allows it, whatever the request says", async () => {
  const sshDirectory = path.join(root, ".ssh");
  const asked: unknown[] = [];
  const session = await startPairing({ code: "ABC234", scanSecret: "c2Nhbi1zZWNyZXQ", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory,
    approve: async phone => { asked.push(phone); return false; } });
  // Someone who recovered the code from a captured request, saying nothing about having typed it.
  for (const typed of [undefined, false]) {
    const response = await post(session.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), typed });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toMatch(/Update the app, or choose Enter code/);
  }
  expect(asked).toEqual([]);
  await expect(readFile(path.join(sshDirectory, "authorized_keys"), "utf8")).rejects.toThrow();
  // A valid code is not a wrong one: these do not count towards turning typed pairing off.
  for (let i = 0; i < 5; i++) await post(session.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey) });
  expect((await post(session.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), typed: true })).status).toBe(403);
  expect(asked).toHaveLength(1);
  session.close();
  await expect(session.done).rejects.toThrow("Pairing cancelled.");
});

it("five wrong codes turn typed pairing off but cannot cancel pairing: a phone that scans still pairs", async () => {
  const sshDirectory = path.join(root, ".ssh"), secret = "c2Nhbi1zZWNyZXQtMQ";
  const asked: unknown[] = []; let typedOff = 0;
  const session = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory, scanSecret: secret,
    approve: async phone => { asked.push(phone); return true; }, onTypedOff: () => { typedOff++; } });
  expect((await post(session.port, { v: 1, publicKey: "ssh-rsa AAAA", proof: "x" })).status).toBe(400);
  for (let i = 0; i < 8; i++) expect((await post(session.port, { v: 1, publicKey, proof: "wrong" })).status).toBe(403);
  expect(typedOff).toBe(1);
  // The right code, typed, is now refused without asking anyone at the computer.
  const typed = await post(session.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), typed: true });
  expect(typed.status).toBe(403);
  expect((await typed.json() as { error: string }).error).toMatch(/Too many wrong codes/);
  expect(asked).toEqual([]);
  // The scan secret cannot be guessed, so the session is still open for it.
  expect((await post(session.port, { v: 1, publicKey, proof: scanProof("ABC234", secret, "phone", publicKey) })).status).toBe(200);
  expect((await session.done).publicKey).toBe(publicKey);
  expect(await readFile(path.join(sshDirectory, "authorized_keys"), "utf8")).toContain(publicKey);
});

it("refuses a web page's request without counting it as a wrong code", async () => {
  const sshDirectory = path.join(root, ".ssh");
  const asked: unknown[] = [];
  const session = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory, approve: async phone => { asked.push(phone); return true; } });
  const fromPage = (headers: Record<string, string>, proof: string) => fetch(`http://127.0.0.1:${session.port}/v1/pair`, { method: "POST", headers, body: JSON.stringify({ v: 1, publicKey, proof, typed: true }) });
  for (let i = 0; i < 8; i++) expect((await fromPage({ Origin: "https://evil.example" }, "wrong")).status).toBe(403);
  // Even with the right code a page pairs nothing.
  expect((await fromPage({ "Sec-Fetch-Site": "cross-site" }, pairingProof("ABC234", "phone", publicKey))).status).toBe(403);
  expect(asked).toEqual([]);
  // None of that counted: the phone still pairs by typing the code.
  expect((await post(session.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), typed: true })).status).toBe(200);
  expect(asked).toHaveLength(1);
  await session.done;
});

it("makes unambiguous codes and a phren:// link with everything the phone needs", () => {
  for (let i = 0; i < 50; i++) expect(newPairingCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  expect(normalizeCode("abc-234")).toBe("ABC234");
  const url = new URL(pairingURL({ hosts: ["box.tail.ts.net", "100.64.0.1"], port: 47291, user: "me", sshPort: 22, fingerprint: "SHA256:x", code: "ABC234", name: "box", secret: "c2Nhbi1zZWNyZXQ" }));
  expect(url.protocol).toBe("phren:");
  expect(Object.fromEntries(url.searchParams)).toEqual({ v: "1", h: "box.tail.ts.net,100.64.0.1", p: "47291", u: "me", s: "22", c: "ABC234", n: "box", fp: "SHA256:x", k: "c2Nhbi1zZWNyZXQ" });
});

it("scan proofs match the values the phone apps test against", () => {
  // The same reference values as PhonePairingTests.testAScannedOfferProvesTheQRSecretFirst (phren-apps).
  expect(scanProof("abc-234", "c2Nhbi1zZWNyZXQtMQ", "phone", "ssh-ed25519 AAAAC3Nza")).toBe("-ZKA4yPv_PzFFQ9lg5y6KX3RTJbbjrq2XfUJwZNnOMQ");
  expect(scanProof("ABC234", "c2Nhbi1zZWNyZXQtMQ", "computer", "SHA256:x", "ssh-ed25519 AAAAC3Nza")).toBe("hn-F9hPdTf0FeuACnfJiznw_wlo2ZkaDaABYLVXUxfc");
});

it("the typed-code check is the host key fingerprint's first eight characters", () => {
  expect(pairingCheckCode("SHA256:AbCdEfGh1234567890abcdefghijklmnopqrstuvw")).toBe("AbCd EfGh");
  expect(pairingCheckCode(undefined)).toBeNull();
  expect(pairingCheckCode("MD5:ab:cd")).toBeNull();
  expect(pairingCheckCode("SHA256:abc")).toBeNull();
});

it("a phone that typed the code is authorized only once the computer allows it", async () => {
  const sshDirectory = path.join(root, ".ssh");
  const asked: unknown[] = [];
  const denied = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory,
    approve: async phone => { asked.push(phone); return false; } });
  const refused = await post(denied.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), name: "Sam's iPhone", typed: true });
  expect(refused.status).toBe(403);
  expect(asked).toEqual([{ device: "ios", name: "Sam's iPhone", check: pairingCheckCode(keyFingerprint(publicKey)) }]);
  await expect(readFile(path.join(sshDirectory, "authorized_keys"), "utf8")).rejects.toThrow();
  denied.close();
  await expect(denied.done).rejects.toThrow("Pairing cancelled.");
  const noTerminal = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory });
  expect((await post(noTerminal.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), typed: true })).status).toBe(403);
  noTerminal.close();
  await expect(noTerminal.done).rejects.toThrow("Pairing cancelled.");
  const allowed = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory, approve: async () => true });
  expect((await post(allowed.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), typed: true })).status).toBe(200);
  await expect(allowed.done).resolves.toMatchObject({ device: "ios" });
});

it("asks about typed phones one at a time, each answer for its own phone", async () => {
  const sshDirectory = path.join(root, ".ssh");
  let open = 0, most = 0;
  const answers = [true, false];
  const asked: (string | undefined)[] = [];
  const session = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory,
    approve: async phone => {
      open++; most = Math.max(most, open); asked.push(phone.name);
      await new Promise(done => setTimeout(done, 20));
      open--; return answers.shift() ?? false;
    } });
  const body = (name: string) => ({ v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), name, typed: true });
  const [first, second] = await Promise.all([post(session.port, body("A")), post(session.port, body("B"))]);
  expect(most).toBe(1);
  // Once one phone is allowed the other is never asked about, however long the key write takes.
  expect(asked).toHaveLength(1);
  // The first answer allows one phone and pairing ends; the other gets nothing.
  expect([first.status, second.status].sort()).toEqual([200, 410]);
  const keys = await readFile(path.join(sshDirectory, "authorized_keys"), "utf8");
  expect(keys.trim().split("\n")).toHaveLength(1);
});

it("prints a phone's name without terminal escapes that could forge the check", () => {
  expect(printableName("Sam's iPhone\u001b[8m Check: AAAA BBBB\r\nAllow")).toBe("Sam's iPhone[8m Check: AAAA BBBBAllow");
  expect(printableName("ok\u202Eevil")).toBe("okevil");
  expect(printableName("x".repeat(200))).toHaveLength(80);
});
