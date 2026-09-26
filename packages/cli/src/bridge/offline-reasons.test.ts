import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookRequest } from "./client.js";
import { enrollComputer } from "./computers.js";
import { herdrSocketError } from "./herdr.js";
import { peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, errorCode, withErrorCode } from "./protocol.js";

// Offline reasons travel as a stable `code` beside the `error` text, so the
// phone can say why a computer is unreachable without matching sentences.

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("offline reason codes", () => {
  it("names each way Herdr's socket can fail", () => {
    expect(errorCode(herdrSocketError(errno("ENOENT")))).toBe("herdr-not-running");
    expect(errorCode(herdrSocketError(errno("ECONNREFUSED")))).toBe("herdr-stale-socket");
    expect(errorCode(herdrSocketError(errno("EACCES")))).toBe("herdr-permission");
    expect(errorCode(herdrSocketError(errno("EPERM")))).toBe("herdr-permission");
    expect(errorCode(herdrSocketError(new Error("odd")))).toBe("herdr-unreachable");
    expect(herdrSocketError(errno("ENOENT")).message).toBe("Herdr is not reachable on this computer (ENOENT: Herdr is not running).");
  });

  it("keeps a code already given and refuses malformed ones", () => {
    const coded = new BridgeError(504, "Herdr did not answer.", { code: "herdr-timeout" });
    expect(withErrorCode(coded, "peer-timeout")).toBe(coded);
    const plain = withErrorCode(new BridgeError(504, "Hook did not confirm the request.", { hint: 1 }), "peer-timeout");
    expect(plain).toMatchObject({ status: 504, message: "Hook did not confirm the request.", details: { hint: 1, code: "peer-timeout" } });
    expect(errorCode(new BridgeError(503, "x", { code: "Not A Code" }))).toBeUndefined();
    expect(errorCode(new Error("x"))).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("codes across a Hook connection", () => {
  let root: string;
  let server: Server | undefined;
  const originalHome = process.env.PHREN_BRIDGE_HOME, originalPath = process.env.PATH;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-offline-")); process.env.PHREN_BRIDGE_HOME = root; });
  afterEach(async () => {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined;
    if (originalHome === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = originalHome;
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  });

  it("carries a remote Hook's code on with its error text", async () => {
    const socket = path.join(root, "hook.sock");
    let body: Record<string, unknown> = {};
    server = createServer((_request, response) => { response.statusCode = 503; response.end(JSON.stringify(body)); });
    await new Promise<void>(resolve => server!.listen(socket, resolve));
    body = { error: "Herdr is not reachable on this computer (ENOENT: Herdr is not running).", code: "herdr-not-running" };
    const error = await hookRequest("/v1/workspaces", undefined, { socketPath: socket }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ status: 503, message: body.error, details: { code: "herdr-not-running" } });
    body = { error: "Odd.", code: "<script>" };
    expect(errorCode(await hookRequest("/v1/workspaces", undefined, { socketPath: socket }).catch((caught: unknown) => caught))).toBeUndefined();
  });

  async function peerWithFakeSSH(stderr: string): Promise<HookPeer> {
    const line = await enrollComputer("Desk", root);
    const bin = path.join(root, "bin"), ssh = path.join(bin, "ssh");
    await rm(bin, { recursive: true, force: true });
    await mkdir(bin);
    await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit 255\n`);
    await chmod(ssh, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    return { name: "Desk", address: "desk.example", username: "sam", port: 22, hostKey: /ssh-ed25519 \S+/.exec(line)![0], server: "default" };
  }

  it("says whether a peer is offline, has not enrolled this key, or changed its host key", async () => {
    const offline = await peerRequest(await peerWithFakeSSH("ssh: connect to host desk.example port 22: Connection refused"), "/v1/health").catch((caught: unknown) => caught);
    expect(offline).toMatchObject({ status: 503, details: { code: "peer-offline" } });
    expect((offline as Error).message).toContain("Connection refused");
    const denied = await peerRequest(await peerWithFakeSSH("sam@desk.example: Permission denied (publickey)."), "/v1/health").catch((caught: unknown) => caught);
    expect(denied).toMatchObject({ status: 403, details: { code: "peer-key-not-enrolled" } });
    const pin = await peerRequest(await peerWithFakeSSH("Host key verification failed."), "/v1/health").catch((caught: unknown) => caught);
    expect(pin).toMatchObject({ status: 403, details: { code: "peer-host-key-mismatch" } });
  });

  it("asks for enrollment when this computer has no dispatch key", async () => {
    const peer = { name: "Desk", address: "desk.example", username: "sam", port: 22, hostKey: "ssh-ed25519 AAAA", server: "default" } as HookPeer;
    await expect(peerRequest(peer, "/v1/health")).rejects.toMatchObject({ status: 409, details: { code: "dispatch-key-missing" } });
  });
});
