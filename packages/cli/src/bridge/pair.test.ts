import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { keyFingerprint, newPairingCode, normalizeCode, pairingProof, pairingURL, startPairing } from "./pair.js";

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
  const ok = await post(session.port, { v: 1, publicKey, proof: pairingProof("abc-234", "phone", publicKey), name: "Ala's iPhone" });
  expect(ok.status).toBe(200);
  const answer = await ok.json() as { proof: string; fingerprint: string; user: string };
  expect(answer).toMatchObject({ user: "me", fingerprint });
  expect(answer.proof).toBe(pairingProof(code, "computer", fingerprint, publicKey));
  await expect(session.done).resolves.toMatchObject({ device: "ios", name: "Ala's iPhone" });
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
