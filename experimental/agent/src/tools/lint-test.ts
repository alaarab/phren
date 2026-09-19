import * as fs from "fs";
import * as path from "path";

export interface LintTestConfig {
  lintCmd?: string;
  testCmd?: string;
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
