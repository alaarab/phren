import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { seedBigStore } from "./big-store-fixture.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG_ROOT = path.resolve(dirname, "..");
const REPO_ROOT = path.resolve(CLI_PKG_ROOT, "../..");
const CLI_PATH = path.join(CLI_PKG_ROOT, "dist", "index.js");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GEN_LOOKUPS = path.join(dirname, "gen-lookups.ts");
const START_TIMEOUT_MS = 25_000;
const ACTOR = "playwright-admin";

export interface BigStoreHarness {
  rootDir: string;
  phrenDir: string;
  publicUrl: string;
  secureUrl: string;
  authToken: string;
  /** Run real search_knowledge calls to generate authentic lookup events. */
  runSearches: (mode?: "all" | "one", index?: number) => void;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function ensureCliBuilt(): void {
  if (fs.existsSync(CLI_PATH)) return;
  execFileSync("pnpm", ["--filter", "@phren/cli", "build"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
}

function isolatedEnv(rootDir: string): { homeDir: string; phrenDir: string; env: NodeJS.ProcessEnv } {
  const homeDir = path.join(rootDir, "home");
  const phrenDir = path.join(homeDir, ".phren");
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    homeDir,
    phrenDir,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PHREN_PATH: phrenDir, PHREN_PROFILE: "work", PHREN_ACTOR: ACTOR },
  };
}

function startWebUi(cwd: string, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcessWithoutNullStreams; publicUrl: string; secureUrl: string; out: () => string; err: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "web-ui", "--no-open", "--port=0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timeout = setTimeout(() => { cleanup(); child.kill("SIGKILL"); reject(new Error(`web-ui start timeout\nstdout:\n${out}\nstderr:\n${err}`)); }, START_TIMEOUT_MS);
    const maybe = () => {
      const pub = out.match(/^phren web-ui running at (.+)$/m);
      const sec = out.match(/^secure session URL: (.+)$/m) || err.match(/^open: (.+)$/m);
      if (!pub || !sec) return;
      cleanup();
      resolve({ child, publicUrl: pub[1].trim(), secureUrl: sec[1].trim(), out: () => out, err: () => err });
    };
    const onOut = (c: Buffer) => { out += c.toString(); maybe(); };
    const onErr = (c: Buffer) => { err += c.toString(); maybe(); };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`web-ui exited early (code=${code})\nstdout:\n${out}\nstderr:\n${err}`)); };
    const cleanup = () => { clearTimeout(timeout); child.stdout.off("data", onOut); child.stderr.off("data", onErr); child.off("exit", onExit); };
    child.stdout.on("data", onOut);
    child.stderr.on("data", onErr);
    child.once("exit", onExit);
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("close", () => { clearTimeout(t); resolve(); });
    child.kill("SIGTERM");
  });
}

export async function createBigStoreHarness(): Promise<BigStoreHarness> {
  ensureCliBuilt();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-bigstore-"));
  const workDir = path.join(rootDir, "work");
  fs.mkdirSync(path.join(workDir, ".git"), { recursive: true });

  const { phrenDir, env } = isolatedEnv(rootDir);
  execFileSync(process.execPath, [CLI_PATH, "init", "-y", "--profile", "work"], { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });

  // Replace the default profile/projects with a big cross-linked store.
  seedBigStore(phrenDir, "work");

  const runSearches = (mode: "all" | "one" = "all", index = 0): void => {
    execFileSync(TSX_BIN, [GEN_LOOKUPS, phrenDir, mode, String(index)], { cwd: CLI_PKG_ROOT, env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  };

  const started = await startWebUi(workDir, env);
  const secure = new URL(started.secureUrl);
  const authToken = secure.searchParams.get("_auth");
  if (!authToken) { await stopProcess(started.child); throw new Error(`no auth token\nstdout:\n${started.out()}\nstderr:\n${started.err()}`); }

  return {
    rootDir,
    phrenDir,
    publicUrl: started.publicUrl,
    secureUrl: started.secureUrl,
    authToken,
    runSearches,
    stop: async () => { await stopProcess(started.child); },
    cleanup: async () => { await stopProcess(started.child); fs.rmSync(rootDir, { recursive: true, force: true }); },
  };
}
