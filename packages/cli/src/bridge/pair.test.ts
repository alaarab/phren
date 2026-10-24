import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { keyFingerprint, newPairingCode, normalizeCode, pairingCheckCode, pairingProof, pairingURL, printableName, startPairing } from "./pair.js";

let root: string, publicKey: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-pair-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "phone", "-f", path.join(root, "phone")]);
  publicKey = (await readFile(path.join(root, "phone.pub"), "utf8")).trim().split(" ").slice(0, 2).join(" ");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const post = (port: number, body: unknown) => fetch(`http://127.0.0.1:${port}/v1/pair`, { method: "POST", body: JSON.stringify(body) });

it("authorizes the phone's key once it proves the code, and proves the host back", async () => {
  const code = "ABC234", fingerprint = keyFingerprint(publicKey)!;
  const session = await startPairing({ code, user: "me", sshPort: 22, fingerprint, name: "box", port: 0, sshDirectory: path.join(root, ".ssh") });
  const wrong = await post(session.port, { v: 1, publicKey, proof: pairingProof("ZZZ999", "phone", publicKey) });
  expect(wrong.status).toBe(403);
  const ok = await post(session.port, { v: 1, publicKey, proof: pairingProof("abc-234", "phone", publicKey), name: "Sam's iPhone" });
  expect(ok.status).toBe(200);
  const answer = await ok.json() as { proof: string; fingerprint: string; user: string };
  expect(answer).toMatchObject({ user: "me", fingerprint });
  expect(answer.proof).toBe(pairingProof(code, "computer", fingerprint, publicKey));
  await expect(session.done).resolves.toMatchObject({ device: "ios", name: "Sam's iPhone" });
  const keys = await readFile(path.join(root, ".ssh", "authorized_keys"), "utf8");
  expect(keys).toBe(`restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ${publicKey} phren-iphone\n`);
});

it("closes after five wrong codes and rejects keys that are not ed25519", async () => {
  const session = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory: path.join(root, ".ssh") });
  const failed = session.done.catch((error: Error) => error.message);
  expect((await post(session.port, { v: 1, publicKey: "ssh-rsa AAAA", proof: "x" })).status).toBe(400);
  for (let i = 0; i < 5; i++) await post(session.port, { v: 1, publicKey, proof: "wrong" });
  expect(await failed).toMatch(/Too many wrong pairing codes/);
});

it("makes unambiguous codes and a phren:// link with everything the phone needs", () => {
  for (let i = 0; i < 50; i++) expect(newPairingCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  expect(normalizeCode("abc-234")).toBe("ABC234");
  const url = new URL(pairingURL({ hosts: ["box.tail.ts.net", "100.64.0.1"], port: 47291, user: "me", sshPort: 22, fingerprint: "SHA256:x", code: "ABC234", name: "box" }));
  expect(url.protocol).toBe("phren:");
  expect(Object.fromEntries(url.searchParams)).toEqual({ v: "1", h: "box.tail.ts.net,100.64.0.1", p: "47291", u: "me", s: "22", c: "ABC234", n: "box", fp: "SHA256:x" });
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
  const noTerminal = await startPairing({ code: "ABC234", user: "me", sshPort: 22, name: "box", port: 0, sshDirectory });
  expect((await post(noTerminal.port, { v: 1, publicKey, proof: pairingProof("ABC234", "phone", publicKey), typed: true })).status).toBe(403);
  noTerminal.close();
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
