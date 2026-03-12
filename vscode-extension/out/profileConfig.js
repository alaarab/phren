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
exports.machineIdPath = machineIdPath;
exports.defaultMachineName = defaultMachineName;
exports.readMachineName = readMachineName;
exports.writeMachineName = writeMachineName;
exports.machinesConfigPath = machinesConfigPath;
exports.listProfileConfigs = listProfileConfigs;
exports.readMachinesMap = readMachinesMap;
exports.setMachineProfile = setMachineProfile;
exports.readDeviceContext = readDeviceContext;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const HOME_CORTEX_DIR = path.join(os.homedir(), ".cortex");
const MACHINE_ID_PATH = path.join(HOME_CORTEX_DIR, ".machine-id");
const CONTEXT_PATH = path.join(os.homedir(), ".cortex-context.md");
function machineIdPath() {
    return MACHINE_ID_PATH;
}
function defaultMachineName() {
    if (process.env.WSL_DISTRO_NAME && process.env.COMPUTERNAME) {
        return process.env.COMPUTERNAME.toLowerCase();
    }
    return os.hostname();
}
function readMachineName() {
    try {
        if (fs.existsSync(MACHINE_ID_PATH)) {
            const persisted = fs.readFileSync(MACHINE_ID_PATH, "utf8").trim();
            if (persisted) {
                return persisted;
            }
        }
    }
    catch {
        // Fall back to the OS hostname.
    }
    return defaultMachineName();
}
function writeMachineName(machine) {
    const normalized = machine.trim();
    if (!normalized) {
        throw new Error("Machine name cannot be empty.");
    }
    fs.mkdirSync(path.dirname(MACHINE_ID_PATH), { recursive: true });
    atomicWriteText(MACHINE_ID_PATH, `${normalized}\n`);
}
function machinesConfigPath(storePath) {
    return path.join(storePath, "machines.yaml");
}
function listProfileConfigs(storePath) {
    const profilesDir = path.join(storePath, "profiles");
    if (!fs.existsSync(profilesDir)) {
        return [];
    }
    const files = fs.readdirSync(profilesDir)
        .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
        .sort((a, b) => a.localeCompare(b));
    return files.map((fileName) => {
        const file = path.join(profilesDir, fileName);
        const raw = safeReadText(file);
        const name = firstScalar(raw, "name") ?? fileName.replace(/\.ya?ml$/i, "");
        const description = firstScalar(raw, "description");
        const projects = parseProjects(raw);
        return { name, file, description, projects };
    });
}
function readMachinesMap(storePath) {
    const file = machinesConfigPath(storePath);
    if (!fs.existsSync(file)) {
        return {};
    }
    const raw = safeReadText(file);
    const entries = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const match = line.match(/^\s*([^:#]+?)\s*:\s*(.+?)\s*$/);
        if (!match) {
            continue;
        }
        const machine = cleanScalar(match[1]);
        const profile = cleanScalar(match[2]);
        if (machine && profile) {
            entries[machine] = profile;
        }
    }
    return entries;
}
function setMachineProfile(storePath, machine, profile) {
    const normalizedMachine = machine.trim();
    const normalizedProfile = profile.trim();
    if (!normalizedMachine || !normalizedProfile) {
        throw new Error("Both machine name and profile name are required.");
    }
    const profiles = listProfileConfigs(storePath);
    if (!profiles.some((entry) => entry.name === normalizedProfile)) {
        throw new Error(`Profile "${normalizedProfile}" does not exist in ${path.join(storePath, "profiles")}.`);
    }
    const machinesPath = machinesConfigPath(storePath);
    const existing = fs.existsSync(machinesPath) ? safeReadText(machinesPath) : "";
    const header = leadingCommentBlock(existing);
    const mappings = readMachinesMap(storePath);
    mappings[normalizedMachine] = normalizedProfile;
    const body = Object.entries(mappings)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([mappedMachine, mappedProfile]) => `${mappedMachine}: ${mappedProfile}`)
        .join("\n");
    const nextContent = `${header}${body}${body ? "\n" : ""}`;
    fs.mkdirSync(path.dirname(machinesPath), { recursive: true });
    atomicWriteText(machinesPath, nextContent || "# machine-name: profile-name\n");
    return machinesPath;
}
function readDeviceContext(storePath) {
    const machine = readMachineName();
    const machines = readMachinesMap(storePath);
    const profiles = listProfileConfigs(storePath);
    const mappedProfile = machines[machine] ?? "";
    const profile = profiles.some((entry) => entry.name === mappedProfile) ? mappedProfile : "";
    const activeProjects = new Set();
    const activeProfile = profiles.find((entry) => entry.name === profile);
    if (activeProfile) {
        for (const project of activeProfile.projects) {
            activeProjects.add(project.toLowerCase());
        }
    }
    const contextContent = safeReadText(CONTEXT_PATH);
    if (activeProjects.size === 0) {
        const activeMatch = contextContent.match(/^Active projects?:\s*(.+)/mi);
        if (activeMatch) {
            for (const name of activeMatch[1].split(",").map((value) => value.trim()).filter(Boolean)) {
                activeProjects.add(name.toLowerCase());
            }
        }
    }
    const fallbackProfile = contextContent.match(/^Profile:\s*(.+)/m)?.[1]?.trim() ?? "";
    const lastSync = contextContent.match(/^Last synced?:\s*(.+)/mi)?.[1]?.trim() ?? "";
    return {
        profile: profile || fallbackProfile,
        activeProjects,
        machine,
        lastSync,
    };
}
function atomicWriteText(filePath, content) {
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
}
function safeReadText(filePath) {
    try {
        return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    }
    catch {
        return "";
    }
}
function firstScalar(raw, key) {
    const match = raw.match(new RegExp(`^${escapeRegex(key)}:\\s*(.+)\\s*$`, "m"));
    return match ? cleanScalar(match[1]) : undefined;
}
function parseProjects(raw) {
    const projects = [];
    const lines = raw.split(/\r?\n/);
    let inProjects = false;
    for (const line of lines) {
        if (!inProjects) {
            const inlineMatch = line.match(/^projects:\s*\[(.*)\]\s*$/);
            if (inlineMatch) {
                return inlineMatch[1]
                    .split(",")
                    .map((value) => cleanScalar(value))
                    .filter(Boolean);
            }
            if (/^projects:\s*$/.test(line.trim())) {
                inProjects = true;
            }
            continue;
        }
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const itemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
        if (itemMatch) {
            const project = cleanScalar(itemMatch[1]);
            if (project) {
                projects.push(project);
            }
            continue;
        }
        if (/^\S/.test(line)) {
            break;
        }
    }
    return projects;
}
function leadingCommentBlock(raw) {
    const lines = raw.split(/\r?\n/);
    const prefix = [];
    for (const line of lines) {
        if (line.trim() === "" || line.trim().startsWith("#")) {
            prefix.push(line);
            continue;
        }
        break;
    }
    return prefix.length > 0 ? `${prefix.join("\n")}\n` : "";
}
function cleanScalar(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=profileConfig.js.map