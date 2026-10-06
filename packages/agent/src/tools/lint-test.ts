import * as fs from "fs";
import * as path from "path";

export interface LintTestConfig {
  lintCmd?: string;
  testCmd?: string;
  typecheckCmd?: string;
}

/**
 * Detect a type-check command: a package script named for it, or tsc on a
 * TypeScript project that has it installed. Typing catches what a parse
 * check can't, in seconds, and runs before the (usually slower) tests.
 */
export function detectTypecheckCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      for (const name of ["typecheck", "type-check", "check-types", "tsc"]) {
        if (pkg.scripts?.[name]) return `npm run ${name}`;
      }
    } catch { /* ignore */ }
  }
  if (fs.existsSync(path.join(cwd, "tsconfig.json")) && fs.existsSync(path.join(cwd, "node_modules", ".bin", "tsc"))) {
    return "npx tsc --noEmit";
  }
  if (fs.existsSync(path.join(cwd, "mypy.ini"))) return "mypy .";
  return null;
}

/** Detect test command from project config files. */
export function detectTestCommand(cwd: string): string | null {
  // package.json scripts.test
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1") {
        return "npm test";
      }
    } catch { /* ignore */ }
  }

  // pytest
  if (fs.existsSync(path.join(cwd, "pytest.ini")) ||
      fs.existsSync(path.join(cwd, "pyproject.toml")) ||
      fs.existsSync(path.join(cwd, "setup.cfg"))) {
    return "pytest";
  }

  // cargo test
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return "cargo test";

  // go test
  if (fs.existsSync(path.join(cwd, "go.mod"))) return "go test ./...";

  return null;
}

/** Detect lint command from project config files. */
export function detectLintCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.lint) return "npm run lint";
    } catch { /* ignore */ }
  }

  // biome
  if (fs.existsSync(path.join(cwd, "biome.json")) ||
      fs.existsSync(path.join(cwd, "biome.jsonc"))) {
    return "npx biome check .";
  }

  // eslint
  if (fs.existsSync(path.join(cwd, ".eslintrc.json")) ||
      fs.existsSync(path.join(cwd, ".eslintrc.js")) ||
      fs.existsSync(path.join(cwd, "eslint.config.js")) ||
      fs.existsSync(path.join(cwd, "eslint.config.mjs"))) {
    return "npx eslint .";
  }

  return null;
}
