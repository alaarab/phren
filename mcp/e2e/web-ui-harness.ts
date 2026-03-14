import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(REPO_ROOT, "mcp", "dist", "index.js");
const START_TIMEOUT_MS = 20_000;
const FALLBACK_ACTOR = "playwright-admin";

interface StartedWebUi {
  child: ChildProcessWithoutNullStreams;
  publicUrl: string;
  secureUrl: string;
  stdout: () => string;
  stderr: () => string;
}

export interface WebUiHarness {
  rootDir: string;
  homeDir: string;
  phrenDir: string;
  repoADir: string;
  repoBDir: string;
  publicUrl: string;
  secureUrl: string;
  authToken: string;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function ensureCliBuilt(): void {
  if (fs.existsSync(CLI_PATH)) return;
  execFileSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeIsolatedEnv(rootDir: string): { homeDir: string; phrenDir: string; env: NodeJS.ProcessEnv } {
  const homeDir = path.join(rootDir, "home");
  const phrenDir = path.join(homeDir, ".phren");
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    homeDir,
    phrenDir,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PHREN_PATH: phrenDir,
      PHREN_PROFILE: "work",
      PHREN_ACTOR: FALLBACK_ACTOR,
    },
  };
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function seedHookFixtures(phrenDir: string, homeDir: string): void {
  writeFile(
    path.join(homeDir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo claude-stop" }] }],
      },
    }, null, 2) + "\n",
  );
  writeFile(
    path.join(phrenDir, "codex.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ type: "command", command: "echo codex-prompt" }],
      },
    }, null, 2) + "\n",
  );
}

function seedSkillFixture(phrenDir: string): void {
  writeFile(
    path.join(phrenDir, "global", "skills", "browser-checks.md"),
    [
      "---",
      "description: Browser web-ui smoke skill",
      "command: /browser-checks",
      "---",
      "",
      "# Browser E2E Smoke",
      "",
      "Use this skill to validate the browser web-ui smoke flow.",
      "",
    ].join("\n"),
  );
}

function seedProjectFixtures(phrenDir: string): void {
  writeFile(
    path.join(phrenDir, ".governance", "access-control.json"),
    JSON.stringify({
      admins: [FALLBACK_ACTOR, os.userInfo().username],
      maintainers: [],
      contributors: [],
      viewers: [],
    }, null, 2) + "\n",
  );

  writeFile(
    path.join(phrenDir, "repo-a", "summary.md"),
    "# repo-a\n\nRepo A summary for browser smoke coverage.\n",
  );
  writeFile(
    path.join(phrenDir, "repo-a", "FINDINGS.md"),
    [
      "# repo-a FINDINGS",
      "",
      "## 2026-03-10",
      "",
      "- [pattern] Browser smoke finding",
      "- [decision] Web UI should launch from an isolated test store",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(phrenDir, "repo-a", "tasks.md"),
    [
      "# repo-a task",
      "",
      "## Queue",
      "",
      "- [ ] Queue browser task",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(phrenDir, "repo-a", "CLAUDE.md"),
    "# repo-a\n\nRepo A instructions for browser smoke coverage.\n",
  );
  writeFile(
    path.join(phrenDir, "repo-a", "reference", "browser.md"),
    "# Browser Reference\n\nBrowser reference doc.\n",
  );
  writeFile(
    path.join(phrenDir, "repo-a", "reference", "topics", "general.md"),
    "# General\n\nGeneral topic reference.\n",
  );
  writeFile(
    path.join(phrenDir, "repo-a", "review.md"),
    [
      "# repo-a Review Queue",
      "",
      "## Review",
      "",
      "- [2026-03-10] Review me first [confidence 0.90]",
      "",
    ].join("\n"),
  );

  writeFile(
    path.join(phrenDir, "repo-b", "summary.md"),
    "# repo-b\n\nRepo B summary for project browsing coverage.\n",
  );
  writeFile(
    path.join(phrenDir, "repo-b", "FINDINGS.md"),
    [
      "# repo-b FINDINGS",
      "",
      "## 2026-03-10",
      "",
      "- [pitfall] Secondary project keeps graph filters populated",
      "",
    ].join("\n"),
  );
}

function startWebUi(cwd: string, env: NodeJS.ProcessEnv): Promise<StartedWebUi> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "web-ui", "--no-open", "--port=0"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanupListeners();
      void stopProcess(child).finally(() => {
        reject(new Error(`Timed out starting web-ui.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
    }, START_TIMEOUT_MS);

    const maybeResolve = () => {
      const publicMatch = stdout.match(/^phren web-ui running at (.+)$/m);
      const secureMatch = stdout.match(/^secure session URL: (.+)$/m);
      if (!publicMatch || !secureMatch) return;
      cleanupListeners();
      resolve({
        child,
        publicUrl: publicMatch[1].trim(),
        secureUrl: secureMatch[1].trim(),
        stdout: () => stdout,
        stderr: () => stderr,
      });
    };

    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      maybeResolve();
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupListeners();
      reject(new Error(`web-ui exited early (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };

    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function createWebUiHarness(): Promise<WebUiHarness> {
  ensureCliBuilt();

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-playwright-"));
  const repoADir = path.join(rootDir, "repo-a");
  const repoBDir = path.join(rootDir, "repo-b");
  fs.mkdirSync(path.join(repoADir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoBDir, ".git"), { recursive: true });

  const { homeDir, phrenDir, env } = makeIsolatedEnv(rootDir);
  runCli(["init", "-y", "--profile", "work"], repoADir, env);
  runCli(["add", repoBDir], repoADir, env);

  seedHookFixtures(phrenDir, homeDir);
  seedSkillFixture(phrenDir);
  seedProjectFixtures(phrenDir);

  const started = await startWebUi(repoADir, env);
  const secure = new URL(started.secureUrl);
  const authToken = secure.searchParams.get("_auth");
  if (!authToken) {
    await stopProcess(started.child);
    throw new Error(`web-ui did not expose an auth token.\nstdout:\n${started.stdout()}\nstderr:\n${started.stderr()}`);
  }

  return {
    rootDir,
    homeDir,
    phrenDir,
    repoADir,
    repoBDir,
    publicUrl: started.publicUrl,
    secureUrl: started.secureUrl,
    authToken,
    stop: async () => {
      await stopProcess(started.child);
    },
    cleanup: async () => {
      await stopProcess(started.child);
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
