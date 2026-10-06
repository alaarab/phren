// RC regression source only. UNRUN: no SDK, SSH, service or provider process.
import { generateKeyPairSync, createHash, sign, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireOwnerControl } from "./owner-controls.js";

let root: string, sshDirectory: string;
beforeEach(async () => { root = await mkdtemp("/tmp/phren-owner-control-"); sshDirectory = path.join(root, "ssh"); await mkdir(sshDirectory); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function request(comment = "phren-iphone") {
  const keys = generateKeyPairSync("ed25519"), raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]).toString("base64");
  await writeFile(path.join(sshDirectory, "authorized_keys"), `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${wire} ${comment}\n`, { mode: 0o600 });
  const data = { expectedLeaseId: "40000000-0000-4000-8000-000000000001" }, time = String(Date.now()), nonce = randomUUID(), route = "/v1/harness/lease/revoke";
  // Independent wire fixture: no signing/canonicalization helper from production supplies the signature.
  const digest = createHash("sha256").update('{"expectedLeaseId":"40000000-0000-4000-8000-000000000001"}').digest("hex");
  const signature = sign(null, Buffer.from(["phren-owner-v1", time, nonce, "POST", route, digest].join("\n")), keys.privateKey).toString("base64");
  return { data, route, headers: { "x-phren-owner-key": wire, "x-phren-owner-time": time, "x-phren-owner-nonce": nonce, "x-phren-owner-signature": signature } };
}
it("accepts a paired owner proof once and persists replay protection across independent calls", async () => {
  const value = await request();
  await requireOwnerControl(value.headers, "POST", value.route, value.data, root, sshDirectory);
  expect(JSON.parse(await readFile(path.join(root, "harness", "owner-nonces.json"), "utf8"))[value.headers["x-phren-owner-nonce"]]).toEqual(expect.any(Number));
  await expect(requireOwnerControl(value.headers, "POST", value.route, value.data, root, sshDirectory)).rejects.toThrow("already used");
});
it("refuses an enrolled computer key even with a cryptographically valid signature", async () => {
  const value = await request("phren-computer:peer");
  await expect(requireOwnerControl(value.headers, "POST", value.route, value.data, root, sshDirectory)).rejects.toThrow("invalid or the paired key was revoked");
});
it("binds owner proof to the route and body and rechecks key revocation", async () => {
  const value = await request();
  await expect(requireOwnerControl(value.headers, "POST", "/v1/harness/lease/takeover", value.data, root, sshDirectory)).rejects.toThrow("invalid");
  await expect(requireOwnerControl(value.headers, "POST", value.route, { expectedLeaseId: randomUUID() }, root, sshDirectory)).rejects.toThrow("invalid");
  await writeFile(path.join(sshDirectory, "authorized_keys"), "", { mode: 0o600 });
  await expect(requireOwnerControl(value.headers, "POST", value.route, value.data, root, sshDirectory)).rejects.toThrow("revoked");
});
