"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRuntimeConfig = resolveRuntimeConfig;
exports.pathExists = pathExists;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const PACKAGE_NAMES = ["@alaarab/cortex", "cortex"];
const MCP_ENTRYPOINT_RELATIVE_PATH = path.join("mcp", "dist", "index.js");
function resolveRuntimeConfig(config) {
    const nodePath = normalizeCommandPath(config.get("nodePath", "node")) ?? "node";
    const configuredMcpServerPath = normalizeConfiguredPath(config.get("mcpServerPath", ""));
    const storePath = normalizeConfiguredPath(config.get("storePath", "")) ?? path.join(os.homedir(), ".cortex");
    if (configuredMcpServerPath) {
        return {
            configuredMcpServerPath,
            mcpServerPath: configuredMcpServerPath,
            nodePath,
            storePath,
        };
    }
    const detectedMcpServerPath = detectMcpServerPath();
    return {
        detectedMcpServerPath,
        mcpServerPath: detectedMcpServerPath,
        nodePath,
        storePath,
    };
}
function pathExists(targetPath) {
    return Boolean(targetPath && fs.existsSync(targetPath));
}
function detectMcpServerPath() {
    const candidates = new Set();
    const envCandidate = normalizeConfiguredPath(process.env.CORTEX_MCP_SERVER_PATH);
    if (envCandidate) {
        candidates.add(envCandidate);
    }
    const globalNodeModules = runCommand("npm", ["root", "-g"]);
    if (globalNodeModules) {
        for (const packageName of PACKAGE_NAMES) {
            candidates.add(path.join(globalNodeModules, packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
        }
    }
    const cortexBinaryPath = runCommand("which", ["cortex"]);
    if (cortexBinaryPath) {
        const resolvedBinaryPath = safeRealpath(cortexBinaryPath);
        const prefixPath = path.resolve(path.dirname(resolvedBinaryPath), "..");
        for (const packageName of PACKAGE_NAMES) {
            candidates.add(path.join(prefixPath, "lib", "node_modules", packageName, MCP_ENTRYPOINT_RELATIVE_PATH));
        }
    }
    candidates.add(path.resolve(__dirname, "..", "..", "mcp", "dist", "index.js"));
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
function normalizeConfiguredPath(rawPath) {
    if (!rawPath) {
        return undefined;
    }
    const trimmed = rawPath.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed === "~") {
        return os.homedir();
    }
    if (trimmed.startsWith("~/")) {
        return path.join(os.homedir(), trimmed.slice(2));
    }
    return path.resolve(trimmed);
}
function normalizeCommandPath(rawPath) {
    if (!rawPath) {
        return undefined;
    }
    const trimmed = rawPath.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.includes("/") || trimmed.includes("\\")) {
        return normalizeConfiguredPath(trimmed);
    }
    return trimmed;
}
function safeRealpath(targetPath) {
    try {
        return fs.realpathSync(targetPath);
    }
    catch {
        return targetPath;
    }
}
function runCommand(command, args) {
    try {
        const result = (0, child_process_1.spawnSync)(command, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        if (result.status !== 0) {
            return undefined;
        }
        const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
        return stdout || undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=runtimeConfig.js.map