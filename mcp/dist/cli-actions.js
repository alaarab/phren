import * as fs from "fs";
import * as path from "path";
import { runtimeFile, getPhrenPath, getProjectDirs } from "./shared.js";
import { recordFeedback, flushEntryScores, getWorkflowPolicy, } from "./shared-governance.js";
import { upsertCanonical } from "./shared-content.js";
import { errorMessage, isValidProjectName } from "./utils.js";
import { addFinding as addFindingCore } from "./core-finding.js";
import { runDoctor } from "./link.js";
import { startWebUi } from "./memory-ui.js";
import { startShell } from "./shell.js";
import { runPhrenUpdate } from "./update.js";
import { readRuntimeHealth, readReviewQueue, readReviewQueueAcrossProjects } from "./data-access.js";
import { runSearch, runFragmentSearch, parseFragmentSearchArgs, runRelatedDocs, parseRelatedDocsArgs } from "./cli-search.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { getProjectConsolidationStatus, CONSOLIDATION_ENTRY_THRESHOLD } from "./content-validate.js";
import { listAllSessions } from "./mcp-session.js";
export async function handleSearch(opts, profile) {
    const result = await runSearch(opts, getPhrenPath(), profile);
    if (result.lines.length > 0) {
        console.log(result.lines.join("\n"));
    }
    if (result.exitCode !== 0)
        process.exit(result.exitCode);
}
export async function handleFragmentSearch(args, profile) {
    const opts = parseFragmentSearchArgs(args);
    if (!opts)
        return;
    const result = await runFragmentSearch(opts.query, getPhrenPath(), profile, opts);
    if (result.lines.length > 0) {
        console.log(result.lines.join("\n"));
    }
    if (result.exitCode !== 0)
        process.exit(result.exitCode);
}
export async function handleRelatedDocs(args, profile) {
    const opts = parseRelatedDocsArgs(args);
    if (!opts)
        return;
    const result = await runRelatedDocs(opts.entity, getPhrenPath(), profile, opts);
    if (result.lines.length > 0) {
        console.log(result.lines.join("\n"));
    }
    if (result.exitCode !== 0)
        process.exit(result.exitCode);
}
export async function handleAddFinding(project, learning) {
    if (!project || !learning) {
        console.error('Usage: phren add-finding <project> "<insight>"');
        process.exit(1);
    }
    try {
        const result = addFindingCore(getPhrenPath(), project, learning);
        if (!result.ok) {
            console.error(result.message);
            process.exit(1);
        }
        console.log(result.message);
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}
export async function handlePinCanonical(project, memory) {
    if (!project || !memory) {
        console.error('Usage: phren pin <project> "<truth>"');
        process.exit(1);
    }
    const result = upsertCanonical(getPhrenPath(), project, memory);
    console.log(result.ok ? result.data : result.error);
}
export async function handleDoctor(args) {
    const profile = resolveRuntimeProfile(getPhrenPath());
    const fix = args.includes("--fix");
    const checkData = args.includes("--check-data");
    const agentsOnly = args.includes("--agents");
    const parityCheck = args.includes("--parity");
    if (parityCheck) {
        const { ALL_MANIFESTS, ACTION_KEYS } = await import("./capabilities/index.js");
        const gaps = [];
        for (const key of ACTION_KEYS) {
            for (const manifest of ALL_MANIFESTS) {
                const entry = manifest.actions[key];
                if (!entry.implemented) {
                    gaps.push({ action: key, surface: manifest.surface, reason: entry.reason || "unknown" });
                }
            }
        }
        const byAction = new Map();
        for (const gap of gaps) {
            const arr = byAction.get(gap.action) || [];
            arr.push({ surface: gap.surface, reason: gap.reason });
            byAction.set(gap.action, arr);
        }
        const total = ACTION_KEYS.length;
        const implemented = new Map();
        for (const manifest of ALL_MANIFESTS) {
            let count = 0;
            for (const key of ACTION_KEYS) {
                if (manifest.actions[key].implemented)
                    count++;
            }
            implemented.set(manifest.surface, count);
        }
        console.log(`phren doctor --parity: ${total} actions across ${ALL_MANIFESTS.length} surfaces\n`);
        for (const manifest of ALL_MANIFESTS) {
            const count = implemented.get(manifest.surface) || 0;
            console.log(`  ${manifest.surface}: ${count}/${total} implemented (${Math.round(100 * count / total)}%)`);
        }
        if (byAction.size > 0) {
            console.log(`\nGaps (${gaps.length} total):`);
            for (const [action, entries] of byAction) {
                const surfaces = entries.map((e) => e.surface).join(", ");
                console.log(`  ${action}: missing in ${surfaces}`);
            }
        }
        else {
            console.log("\nNo gaps — full parity across all surfaces.");
        }
        process.exit(0);
    }
    const result = await runDoctor(getPhrenPath(), fix, checkData);
    if (agentsOnly) {
        const agentChecks = result.checks.filter((check) => check.name.includes("cursor") || check.name.includes("copilot") || check.name.includes("codex") || check.name.includes("windsurf"));
        console.log(`phren doctor --agents: ${agentChecks.every((check) => check.ok) ? "all configured" : "some not configured"}`);
        for (const check of agentChecks) {
            console.log(`- ${check.ok ? "ok" : "not configured"} ${check.name}: ${check.detail}`);
        }
        if (agentChecks.length === 0) {
            console.log("No agent integrations detected. Run `phren init` to configure.");
        }
        process.exit(agentChecks.every((check) => check.ok) ? 0 : 1);
    }
    console.log(`phren doctor: ${result.ok ? "ok" : "issues found"}`);
    if (result.machine)
        console.log(`machine: ${result.machine}`);
    if (result.profile)
        console.log(`profile: ${result.profile}`);
    console.log(`tasks: ${getWorkflowPolicy(getPhrenPath()).taskMode} mode`);
    const renderCheckState = (check) => {
        if (check.name === "git-remote" &&
            check.ok &&
            /no remote configured|local-only/i.test(check.detail)) {
            return "info";
        }
        return check.ok ? "ok" : "fail";
    };
    for (const check of result.checks) {
        console.log(`- ${renderCheckState(check)} ${check.name}: ${check.detail}`);
    }
    try {
        const missFile = runtimeFile(getPhrenPath(), "search-misses.jsonl");
        if (fs.existsSync(missFile)) {
            const lines = fs.readFileSync(missFile, "utf8").split("\n").filter(Boolean);
            if (lines.length > 0) {
                const tokenCounts = new Map();
                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        const tokens = entry.query.toLowerCase().split(/\s+/).filter((token) => token.length > 2);
                        for (const token of tokens) {
                            tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
                        }
                    }
                    catch (err) {
                        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                            process.stderr.write(`[phren] doctor searchMissParse: ${errorMessage(err)}\n`);
                    }
                }
                const topMisses = [...tokenCounts.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10);
                if (topMisses.length > 0) {
                    console.log(`\nSearch miss patterns (${lines.length} zero-result queries):`);
                    for (const [token, count] of topMisses) {
                        console.log(`  ${token}: ${count} miss(es)`);
                    }
                }
            }
        }
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] doctor searchMissAnalysis: ${errorMessage(err)}\n`);
    }
    try {
        const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl, getEmbeddingModel } = await import("./shared-ollama.js");
        const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
        const { listIndexedDocumentPaths } = await import("./shared-index.js");
        const ollamaUrl = getOllamaUrl();
        if (!ollamaUrl) {
            console.log("- ok  semantic-search: disabled (optional; enable for fuzzy/paraphrase-heavy retrieval)");
        }
        else {
            const available = await checkOllamaAvailable();
            if (!available) {
                console.log(`- warn semantic-search: Ollama not running at ${ollamaUrl} (start Ollama or set PHREN_OLLAMA_URL=off to disable)`);
            }
            else {
                const model = getEmbeddingModel();
                const modelReady = await checkModelAvailable();
                if (!modelReady) {
                    console.log(`- warn semantic-search: model ${model} not pulled (run: ollama pull ${model})`);
                }
                else {
                    const phrenPath = getPhrenPath();
                    const cache = getEmbeddingCache(phrenPath);
                    await cache.load().catch(() => { });
                    const allPaths = listIndexedDocumentPaths(phrenPath, profile || undefined);
                    const coverage = cache.coverage(allPaths);
                    console.log(`- ok  semantic-search: ${model} ready, ${formatEmbeddingCoverage(coverage)}`);
                }
            }
        }
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] doctor ollamaStatus: ${errorMessage(err)}\n`);
    }
    process.exit(result.ok ? 0 : 1);
}
export async function handleStatus() {
    const phrenPath = getPhrenPath();
    const profile = resolveRuntimeProfile(phrenPath);
    const runtime = readRuntimeHealth(phrenPath);
    console.log("phren status");
    console.log(`last auto-save: ${runtime.lastAutoSave?.status || "n/a"}${runtime.lastAutoSave?.at ? ` @ ${runtime.lastAutoSave.at}` : ""}`);
    console.log(`last pull: ${runtime.lastSync?.lastPullStatus || "n/a"}${runtime.lastSync?.lastPullAt ? ` @ ${runtime.lastSync.lastPullAt}` : ""}`);
    console.log(`last push: ${runtime.lastSync?.lastPushStatus || "n/a"}${runtime.lastSync?.lastPushAt ? ` @ ${runtime.lastSync.lastPushAt}` : ""}`);
    console.log(`unsynced commits: ${runtime.lastSync?.unsyncedCommits ?? 0}`);
    if (runtime.lastSync?.lastPushDetail)
        console.log(`push detail: ${runtime.lastSync.lastPushDetail}`);
    try {
        const { getOllamaUrl, checkOllamaAvailable, checkModelAvailable, getEmbeddingModel } = await import("./shared-ollama.js");
        const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
        const { listIndexedDocumentPaths } = await import("./shared-index.js");
        const ollamaUrl = getOllamaUrl();
        if (!ollamaUrl) {
            console.log("semantic-search: disabled (optional)");
            return;
        }
        const available = await checkOllamaAvailable();
        if (!available) {
            console.log(`semantic-search: offline (${ollamaUrl})`);
            return;
        }
        const model = getEmbeddingModel();
        const modelReady = await checkModelAvailable();
        if (!modelReady) {
            console.log(`semantic-search: model missing (${model})`);
            return;
        }
        const cache = getEmbeddingCache(phrenPath);
        await cache.load().catch(() => { });
        const coverage = cache.coverage(listIndexedDocumentPaths(phrenPath, profile || undefined));
        console.log(`semantic-search: ${model} ready, ${formatEmbeddingCoverage(coverage)}`);
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] handleStatus semanticSearch: ${errorMessage(err)}\n`);
    }
}
export async function handleQualityFeedback(args) {
    const key = args.find((arg) => arg.startsWith("--key="))?.slice("--key=".length);
    const feedback = args.find((arg) => arg.startsWith("--type="))?.slice("--type=".length);
    if (!key || !feedback || !["helpful", "reprompt", "regression"].includes(feedback)) {
        console.error("Usage: phren quality-feedback --key=<entry-key> --type=helpful|reprompt|regression");
        process.exit(1);
    }
    recordFeedback(getPhrenPath(), key, feedback);
    flushEntryScores(getPhrenPath());
    console.log(`Recorded feedback: ${feedback} for ${key}`);
}
export async function handleMemoryUi(args) {
    const portArg = args.find((arg) => arg.startsWith("--port="));
    const noOpen = args.includes("--no-open");
    const port = portArg ? Number.parseInt(portArg.slice("--port=".length), 10) : 3499;
    const safePort = Number.isNaN(port) ? 3499 : port;
    await startWebUi(getPhrenPath(), safePort, resolveRuntimeProfile(getPhrenPath()), {
        autoOpen: !noOpen,
        allowPortFallback: !portArg,
    });
}
export async function handleShell(args, profile) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log("Usage: phren shell");
        console.log("Interactive shell with views for Projects, Task, Findings, Review Queue, Skills, Hooks, Machines/Profiles, and Health.");
        return;
    }
    await startShell(getPhrenPath(), profile);
}
export async function handleUpdate(args) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log("Usage: phren update [--refresh-starter]");
        console.log("Updates phren to the latest version (local git clone when available, otherwise npm global package).");
        console.log("Pass --refresh-starter to refresh global starter assets in the same flow.");
        return;
    }
    const result = await runPhrenUpdate({ refreshStarter: args.includes("--refresh-starter") });
    console.log(result.message);
    if (!result.ok) {
        process.exitCode = 1;
    }
}
export async function handleReview(args) {
    const phrenPath = getPhrenPath();
    const profile = resolveRuntimeProfile(phrenPath);
    const project = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
    if (project) {
        if (!isValidProjectName(project)) {
            console.error(`Invalid project name: "${project}".`);
            process.exit(1);
        }
        const result = readReviewQueue(phrenPath, project);
        if (!result.ok) {
            console.error(result.error ?? "Failed to read review queue.");
            process.exit(1);
        }
        const items = result.data;
        if (items.length === 0) {
            console.log(`No items in review queue for "${project}".`);
            return;
        }
        console.log(`Review queue: ${project} (${items.length} item(s))\n`);
        for (const item of items) {
            const conf = item.confidence !== undefined ? ` [conf: ${item.confidence.toFixed(2)}]` : "";
            const risky = item.risky ? " ⚠" : "";
            console.log(`  [${item.section}] ${item.date}  ${item.text}${conf}${risky}`);
        }
    }
    else {
        const result = readReviewQueueAcrossProjects(phrenPath, profile);
        if (!result.ok) {
            console.error(result.error ?? "Failed to read review queue.");
            process.exit(1);
        }
        const items = result.data;
        if (items.length === 0) {
            console.log("No items in review queue.");
            return;
        }
        console.log(`Review queue: ${items.length} item(s) across all projects\n`);
        let lastProject = "";
        for (const item of items) {
            if (item.project !== lastProject) {
                console.log(`\n## ${item.project}`);
                lastProject = item.project;
            }
            const conf = item.confidence !== undefined ? ` [conf: ${item.confidence.toFixed(2)}]` : "";
            const risky = item.risky ? " ⚠" : "";
            console.log(`  [${item.section}] ${item.date}  ${item.text}${conf}${risky}`);
        }
    }
}
export async function handleConsolidationStatus(args) {
    const phrenPath = getPhrenPath();
    const profile = resolveRuntimeProfile(phrenPath);
    const project = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
    const projectDirs = project
        ? (() => {
            if (!isValidProjectName(project))
                return null;
            const dir = path.join(phrenPath, project);
            return fs.existsSync(dir) ? [dir] : [];
        })()
        : getProjectDirs(phrenPath, profile);
    if (projectDirs === null) {
        console.error(`Invalid project name: "${project}".`);
        process.exit(1);
    }
    if (project && projectDirs.length === 0) {
        console.error(`Project "${project}" not found.`);
        process.exit(1);
    }
    const results = [];
    for (const dir of projectDirs) {
        const status = getProjectConsolidationStatus(dir);
        if (!status)
            continue;
        results.push({ ...status, threshold: CONSOLIDATION_ENTRY_THRESHOLD });
    }
    if (results.length === 0) {
        console.log("No FINDINGS.md files found.");
        return;
    }
    console.log("Consolidation status:\n");
    for (const r of results) {
        const last = r.lastConsolidated ? r.lastConsolidated : "never consolidated";
        const rec = r.recommended ? "  → consolidation recommended" : "";
        console.log(`  ${r.project}: ${r.entriesSince}/${r.threshold} entries since ${last}${rec}`);
    }
}
export function handleSessionContext() {
    const phrenPath = getPhrenPath();
    const sessions = listAllSessions(phrenPath, 10);
    const active = sessions.find((s) => s.status === "active");
    if (!active) {
        console.log("No active session. Call session_start (or use hooks) to begin a session.");
        return;
    }
    console.log(`Session:         ${active.sessionId.slice(0, 8)}`);
    console.log(`Project:         ${active.project ?? "none"}`);
    if (active.agentScope)
        console.log(`Agent scope:     ${active.agentScope}`);
    console.log(`Started:         ${active.startedAt.slice(0, 16).replace("T", " ")}`);
    console.log(`Duration:        ~${active.durationMins ?? 0} min`);
    console.log(`Findings added:  ${active.findingsAdded}`);
    console.log(`Tasks completed: ${active.tasksCompleted}`);
    if (active.summary)
        console.log(`Prior summary:   ${active.summary}`);
}
