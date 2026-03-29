import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
/** Detect test command from project config files. */
export function detectTestCommand(cwd) {
    // package.json scripts.test
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            if (pkg.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1") {
                return "npm test";
            }
        }
        catch { /* ignore */ }
    }
    // pytest
    if (fs.existsSync(path.join(cwd, "pytest.ini")) ||
        fs.existsSync(path.join(cwd, "pyproject.toml")) ||
        fs.existsSync(path.join(cwd, "setup.cfg"))) {
        return "pytest";
    }
    // cargo test
    if (fs.existsSync(path.join(cwd, "Cargo.toml")))
        return "cargo test";
    // go test
    if (fs.existsSync(path.join(cwd, "go.mod")))
        return "go test ./...";
    return null;
}
/** Detect lint command from project config files. */
export function detectLintCommand(cwd) {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            if (pkg.scripts?.lint)
                return "npm run lint";
        }
        catch { /* ignore */ }
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
/** Run a command and return pass/fail + output. */
export function runPostEditCheck(command, cwd) {
    try {
        const output = execFileSync("bash", ["-c", command], {
            cwd,
            encoding: "utf-8",
            timeout: 60_000,
            maxBuffer: 200_000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { passed: true, output: output.trim() || "(passed)" };
    }
    catch (err) {
        if (err && typeof err === "object" && "stdout" in err) {
            const e = err;
            const combined = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
            return { passed: false, output: combined || "Check failed" };
        }
        return { passed: false, output: err instanceof Error ? err.message : String(err) };
    }
}
