/**
 * Kernel-level write fence for shell commands.
 *
 * Linux uses bubblewrap (`bwrap`): the whole filesystem is read-only except the
 * workspace root, the allowed paths, and tmp. macOS uses `sandbox-exec` with a
 * Seatbelt profile that allows reads and confines writes to the same roots.
 * Either way the fence is enforced by the kernel, so it holds for every child
 * process the command spawns, not just the ones the in-process checks can see.
 * Writable roots derive from the SAME PermissionConfig fields as the in-process
 * path sandbox, so the two layers cannot drift apart.
 *
 * Modes:
 *   off     — never wrap.
 *   auto    — wrap when a backend works; otherwise run unconfined with a
 *             one-time notice. On macOS the Seatbelt backend is opt-in via
 *             PHREN_AGENT_MACOS_SANDBOX=1 (sandbox-exec is deprecated and its
 *             profiles are easy to get subtly wrong); without it auto degrades
 *             visibly with the same notice as before.
 *   require — fail closed: no working backend ⇒ the command errors.
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
let seatbeltProbeResult: boolean | null = null;
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

export function isSeatbeltAvailable(): boolean {
  if (!seatbeltEnabled()) return false;
  if (seatbeltProbeResult !== null) return seatbeltProbeResult;
  try {
    execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)", "true"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    seatbeltProbeResult = true;
  } catch {
    seatbeltProbeResult = false;
  }
  return seatbeltProbeResult;
}

function seatbeltEnabled(): boolean {
  return process.platform === "darwin" && process.env.PHREN_AGENT_MACOS_SANDBOX === "1";
}

export function isKernelSandboxAvailable(): boolean {
  return isBwrapAvailable() || isSeatbeltAvailable();
}

/** Test hook: clear the cached probe + shown notices. */
export function _resetSandboxProbe(): void {
  probeResult = null;
  seatbeltProbeResult = null;
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

function sbplQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSeatbeltProfile(writableRoots: string[]): string {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const root of writableRoots) {
    const real = realpathOrNull(root);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    rules.push(`(subpath ${sbplQuote(real)})`);
  }
  rules.push(`(literal "/dev/null")`);
  rules.push(`(literal "/dev/stdout")`);
  rules.push(`(literal "/dev/stderr")`);
  rules.push(`(literal "/dev/tty")`);
  rules.push(`(subpath "/dev/fd")`);
  rules.push(`(subpath "/private/tmp")`);
  rules.push(`(subpath "/private/var/tmp")`);
  rules.push(`(subpath "/private/var/folders")`);

  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${rules.join(" ")})`,
  ].join("\n");
}

export function buildSeatbeltArgv(argv: string[], writableRoots: string[]): string[] {
  return ["sandbox-exec", "-p", buildSeatbeltProfile(writableRoots), ...argv];
}

/**
 * Decide how to run a shell argv under the given sandbox mode.
 * Throws SandboxRequiredError only in `require` mode with no working backend.
 */
export function wrapWithSandbox(argv: string[], opts: WrapOptions): SandboxDecision {
  if (opts.mode === "off") {
    return { argv, sandboxed: false };
  }

  const writable = [opts.workspaceRoot, os.tmpdir(), ...(opts.extraWritable ?? [])];

  if (isBwrapAvailable()) {
    return { argv: buildBwrapArgv(argv, writable), sandboxed: true };
  }

  if (isSeatbeltAvailable()) {
    return { argv: buildSeatbeltArgv(argv, writable), sandboxed: true };
  }

  if (opts.mode === "require") {
    throw new SandboxRequiredError(
      process.platform === "linux"
        ? "bwrap (bubblewrap) is not available or cannot confine on this system."
        : process.platform === "darwin"
          ? "macOS Seatbelt (sandbox-exec) is not enabled; set PHREN_AGENT_MACOS_SANDBOX=1 to use it."
          : `kernel sandboxing is not supported on ${process.platform} yet.`,
    );
  }

  // auto: degrade with a one-time notice
  const key = "sandbox-unavailable";
  if (!noticesShown.has(key)) {
    noticesShown.add(key);
    const reason = process.platform === "linux"
      ? "bwrap not found — install bubblewrap to confine shell commands"
      : process.platform === "darwin"
        ? "no kernel sandbox on darwin (set PHREN_AGENT_MACOS_SANDBOX=1 for the Seatbelt backend)"
        : `no kernel sandbox on ${process.platform}`;
    return { argv, sandboxed: false, notice: `[sandbox: running unconfined — ${reason}; --sandbox off silences this]` };
  }
  return { argv, sandboxed: false };
}

// ── Denial classification ────────────────────────────────────────────────────

const DENIAL_RE = /read-only file system|operation not permitted/i;

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
