import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reh = vi.hoisted(() => ({
  installIntoReh: vi.fn(async () => true),
  uninstallFromReh: vi.fn(async () => {}),
  rehExtensionsDir: vi.fn(() => ""),
  isRehRunning: vi.fn(() => false),
}));
vi.mock("./reh.js", () => reh);

import { ExtensionError, classify, installFromOpenVsx, listExtensions, setEnabled, uninstall, unzipSizeGuard } from "./extensions.js";

let dir: string;
const saved = process.env.PHREN_DESKTOP_EXTENSIONS;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "desktop-ext-"));
  process.env.PHREN_DESKTOP_EXTENSIONS = dir;
  reh.installIntoReh.mockClear();
  reh.uninstallFromReh.mockClear();
  reh.isRehRunning.mockReturnValue(false);
});
afterEach(async () => {
  process.env.PHREN_DESKTOP_EXTENSIONS = saved;
  await rm(dir, { recursive: true, force: true });
});

function makeVsix(files: Record<string, string>): { bytes: Uint8Array; sha256: string } {
  const zippable: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) zippable[path] = new TextEncoder().encode(text);
  const bytes = zipSync(zippable);
  const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  return { bytes, sha256 };
}

type FakeRoute = { json?: unknown; bytes?: Uint8Array; status?: number };

function fakeFetch(routes: Record<string, FakeRoute>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const route = routes[String(input)];
    if (!route) return new Response("not found", { status: 404 });
    if (route.bytes) return new Response(route.bytes, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("classify", () => {
  it("reads browser, main and neither", () => {
    expect(classify({})).toBe("declarative");
    expect(classify({ main: "./out/extension.js" })).toBe("node");
    expect(classify({ browser: "./out/web.js" })).toBe("web");
    expect(classify({ main: "./n.js", browser: "./w.js" })).toBe("web");
  });
});

describe("installFromOpenVsx", () => {
  const META = "https://open-vsx.org/api/acme/theme/latest";
  const DOWNLOAD = "https://open-vsx.org/api/acme/theme/download";
  const packageJson = JSON.stringify({
    name: "theme",
    publisher: "acme",
    displayName: "Acme Theme",
    version: "1.0.0",
    contributes: { themes: [{ id: "acme-dark", label: "Acme Dark" }] },
  });

  const SHA_URL = "https://open-vsx.org/api/acme/theme/1.0.0/file/acme.theme-1.0.0.sha256";
  function serverWith(sha256: string, files: Record<string, string>) {
    const vsix = makeVsix(files);
    return fakeFetch({
      // Like Open VSX: files.sha256 links to a text file holding the digest.
      [META]: { json: { version: "1.0.0", files: { download: DOWNLOAD, sha256: SHA_URL } } },
      [DOWNLOAD]: { bytes: vsix.bytes },
      [SHA_URL]: { bytes: new TextEncoder().encode(`${sha256}  acme.theme-1.0.0.vsix\n`) },
    });
  }

  it("installs a VSIX, lists it as declarative with its files, then uninstalls", async () => {
    const files = {
      "extension/package.json": packageJson,
      "extension/themes/t.json": "{}",
      "extension.vsixmanifest": "<xml/>",
    };
    const vsix = makeVsix(files);
    const fetchImpl = serverWith(vsix.sha256, files);

    const ext = await installFromOpenVsx("acme", "theme", fetchImpl);
    expect(ext.id).toBe("acme.theme");
    expect(ext.version).toBe("1.0.0");
    expect(ext.kind).toBe("declarative");
    expect(ext.enabled).toBe(true);

    const list = await listExtensions();
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe("Acme Theme");
    expect(list[0].files.sort()).toEqual(["package.json", "themes/t.json"]);

    await uninstall("acme.theme");
    expect(await listExtensions()).toEqual([]);
  });

  it("refuses a download whose sha256 does not match", async () => {
    const vsix = makeVsix({ "extension/package.json": packageJson });
    const fetchImpl = serverWith("0".repeat(64), { "extension/package.json": packageJson });
    await expect(installFromOpenVsx("acme", "theme", fetchImpl)).rejects.toThrow(/checksum/);
    expect(await listExtensions()).toEqual([]);
  });

  it("refuses a zip entry that escapes extension/", async () => {
    const files = { "extension/package.json": packageJson, "extension/../evil": "boom" };
    const vsix = makeVsix(files);
    const fetchImpl = serverWith(vsix.sha256, files);
    await expect(installFromOpenVsx("acme", "theme", fetchImpl)).rejects.toThrow(/unsafe/);
    expect(await listExtensions()).toEqual([]);
  });

  it("rejects a bad namespace", async () => {
    await expect(installFromOpenVsx("../etc", "theme", fakeFetch({}))).rejects.toThrow(/Invalid/);
  });
});

describe("unzipSizeGuard", () => {
  it("refuses an entry larger than 50 MB with a 413", () => {
    const check = unzipSizeGuard();
    try {
      check({ name: "big.bin", originalSize: 51 * 1024 * 1024 });
      throw new Error("expected the guard to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionError);
      expect((err as ExtensionError).status).toBe(413);
      expect((err as Error).message).toMatch(/50 MB/);
    }
  });

  it("refuses a running total larger than 200 MB", () => {
    const check = unzipSizeGuard();
    for (let i = 0; i < 4; i++) check({ name: `f${i}`, originalSize: 45 * 1024 * 1024 });
    expect(() => check({ name: "f4", originalSize: 45 * 1024 * 1024 })).toThrow(/200 MB/);
  });
});

describe("Node extensions and the REH", () => {
  it("installs a Node extension into the host and removes it when disabled", async () => {
    const packageJson = JSON.stringify({ name: "lsp", publisher: "acme", version: "1.0.0", main: "./out/extension.js" });
    const files = { "extension/package.json": packageJson };
    const vsix = makeVsix(files);
    const fetchImpl = fakeFetch({
      "https://open-vsx.org/api/acme/lsp/latest": { json: { version: "1.0.0", verified: true, files: {
        download: "https://open-vsx.org/api/acme/lsp/download",
        sha256: "https://open-vsx.org/api/acme/lsp/file/acme.lsp-1.0.0.sha256",
      } } },
      "https://open-vsx.org/api/acme/lsp/download": { bytes: vsix.bytes },
      "https://open-vsx.org/api/acme/lsp/file/acme.lsp-1.0.0.sha256": { bytes: new TextEncoder().encode(`${vsix.sha256}  acme.lsp.vsix\n`) },
    });

    const ext = await installFromOpenVsx("acme", "lsp", fetchImpl);
    expect(ext.kind).toBe("node");
    expect(ext.publisherVerified).toBe(true);
    expect(reh.installIntoReh).toHaveBeenCalledTimes(1);

    reh.isRehRunning.mockReturnValue(true);
    const updated = await setEnabled("acme.lsp", false);
    expect(reh.uninstallFromReh).toHaveBeenCalledWith("acme.lsp");
    expect(updated.enabled).toBe(false);
    expect(updated.restartRequired).toBe(true);
  });
});
