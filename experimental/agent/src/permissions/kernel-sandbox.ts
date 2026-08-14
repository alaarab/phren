/**
 * Kernel-level write fence for shell commands (Linux, bubblewrap).
 *
 * Wraps shell argv in `bwrap` so the whole filesystem is read-only except the
 * workspace root, the allowed paths, and tmp — enforced by the kernel, so it
 * holds for every child process the command spawns, not just the ones the
 * in-process checks can see. Writable roots derive from the SAME
 * PermissionConfig fields as the in-process path sandbox, so the two layers
 * cannot drift apart.
 *
 * Modes:
 *   off     — never wrap.
 *   auto    — wrap when bwrap works; otherwise run unconfined with a one-time
 *             notice (non-Linux always falls here).
 *   require — fail closed: no working bwrap ⇒ the command errors.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";

export type SandboxMode = "off" | "auto" | "require";

export class SandboxRequiredError extends Error {
  constructor(reason: string) {
    super(`--sandbox require: ${reason}`);
  }
}

export interface SandboxDecision {
  argv: string[];
  sandboxed: boolean;
  /** One-time notice for the user (auto mode degrading), if any. */
  notice?: string;
}

export function parseSandboxMode(raw: string | undefined): SandboxMode | null {
  if (raw === "off" || raw === "auto" || raw === "require") return raw;
  return null;
}

// ── Availability probe (functional, cached) ──────────────────────────────────

let probeResult: boolean | null = null;
const noticesShown = new Set<string>();

/** True when bwrap exists AND can actually confine (a real `bwrap ... true`). */
export function isBwrapAvailable(): boolean {
  if (probeResult !== null) return probeResult;
  if (process.platform !== "linux") {
    probeResult = false;
    return false;
  }
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent", "--", "true"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    probeResult = true;
  } catch {
    probeResult = false;
  }
  return probeResult;
}

/** Test hook: clear the cached probe + shown notices. */
export function _resetSandboxProbe(): void {
  probeResult = null;
  noticesShown.clear();
}

// ── Argv wrapping ────────────────────────────────────────────────────────────

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Build the bwrap argv prefix for the given writable roots. */
export function buildBwrapArgv(argv: string[], writableRoots: string[]): string[] {
  const wrapped = [
    "bwrap",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
  ];

  const seen = new Set<string>();
  for (const root of writableRoots) {
    const real = realpathOrNull(root);
    if (!real || seen.has(real)) continue;
    // Exactly /tmp is already the writable tmpfs. Paths UNDER /tmp still need
    // a bind — the tmpfs would otherwise shadow their real contents.
    if (real === "/tmp") continue;
    seen.add(real);
    wrapped.push("--bind", real, real);
  }

  wrapped.push("--die-with-parent", "--");
  return [...wrapped, ...argv];
}

export interface WrapOptions {
  mode: SandboxMode;
  workspaceRoot: string;
  extraWritable?: string[];
}

/**
 * Decide how to run a shell argv under the given sandbox mode.
 * Throws SandboxRequiredError only in `require` mode with no working bwrap.
 */
export function wrapWithSandbox(argv: string[], opts: WrapOptions): SandboxDecision {
  if (opts.mode === "off") {
    return { argv, sandboxed: false };
  }

  const available = isBwrapAvailable();
  if (!available) {
    if (opts.mode === "require") {
      throw new SandboxRequiredError(
        process.platform === "linux"
          ? "bwrap (bubblewrap) is not available or cannot confine on this system."
          : `kernel sandboxing is not supported on ${process.platform} yet.`,
      );
    }
    // auto: degrade with a one-time notice
    const key = "sandbox-unavailable";
    if (!noticesShown.has(key)) {
      noticesShown.add(key);
      const reason = process.platform === "linux"
        ? "bwrap not found — install bubblewrap to confine shell commands"
        : `no kernel sandbox on ${process.platform}`;
      return { argv, sandboxed: false, notice: `[sandbox: running unconfined — ${reason}; --sandbox off silences this]` };
    }
    return { argv, sandboxed: false };
  }

  const writable = [opts.workspaceRoot, os.tmpdir(), ...(opts.extraWritable ?? [])];
  return { argv: buildBwrapArgv(argv, writable), sandboxed: true };
}

// ── Denial classification ────────────────────────────────────────────────────

const DENIAL_RE = /read-only file system/i;

/**
 * When a sandboxed command fails with a write-fence error, return an
 * annotation explaining WHY so the model redirects instead of retrying.
 */
export function classifySandboxDenial(stderr: string, workspaceRoot: string): string | null {
  if (!DENIAL_RE.test(stderr)) return null;
  return (
    `\n[sandbox] Write blocked: the filesystem is read-only outside ${workspaceRoot} under --sandbox. ` +
    "Write inside the workspace, or the user can rerun with --sandbox off."
  );
}
