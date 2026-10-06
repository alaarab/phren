/**
 * Config resolver — turns the 3-level precedence chain (default → global/profile
 * → project) into a uniform, per-field view that every surface renders the same.
 *
 * `buildConfigView` is consumed by the `get_config` MCP tool, `phren config show`,
 * the Web UI settings tab, and the VS Code settings webview, so the "where did
 * this value come from" answer is computed in exactly one place.
 */
import * as fs from "fs";
import * as path from "path";
import { getIndexPolicy } from "../governance/policy.js";
import { getProjectConfigOverrides } from "../governance/policy.js";
import { getActiveProfileDefaults } from "../profile-store.js";
import { readGovernanceInstallPreferences } from "../init/preferences.js";
import { readProjectConfig } from "../project-config.js";
import { isRecord } from "../shared.js";
import { allConfigFields, getConfigField } from "./schema.js";
/** Structural equality good enough for config values (scalars + flat arrays). */
function valuesEqual(a, b) {
    if (a === b)
        return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    return false;
}
/**
 * Resolve one field from a precedence-ordered list of levels that actually set
 * it. `levels` must be ordered highest-precedence first and must NOT include the
 * default tier — the default is appended here.
 *
 * Redundant levels are collapsed: a level whose value equals the value of the
 * level below it is a no-op (e.g. a global policy file that merely mirrors the
 * defaults), so the source reflects the first level that genuinely changes the
 * value — never a level that just restates what it would already be.
 */
export function resolveConfigField(key, def, levels) {
    const chain = [...levels, { tier: "default", value: def }];
    const value = chain[0].value;
    // The source is the highest level whose value differs from the level below it.
    let sourceIdx = chain.length - 1; // default, unless something overrides it
    for (let i = 0; i < chain.length - 1; i++) {
        if (!valuesEqual(chain[i].value, chain[i + 1].value)) {
            sourceIdx = i;
            break;
        }
    }
    const winner = chain[sourceIdx];
    const inherited = chain[sourceIdx + 1] ?? { tier: "default", value: def };
    const source = winner.tier === "project" ? "project" : winner.tier === "default" ? "default" : "global";
    return {
        key,
        value,
        source,
        inheritedValue: inherited.value,
        ...(winner.path ? { sourcePath: winner.path } : {}),
    };
}
function readRawJson(file) {
    try {
        if (!fs.existsSync(file))
            return {};
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
/** A nested-path getter that returns `undefined` for any missing segment. */
function dig(obj, ...segments) {
    let cur = obj;
    for (const seg of segments) {
        if (!isRecord(cur))
            return undefined;
        cur = cur[seg];
    }
    return cur;
}
/** Push a level only when the value is actually set (not undefined/null). */
function pushIfSet(levels, tier, value, path) {
    if (value !== undefined && value !== null)
        levels.push({ tier, value, path });
}
/**
 * Build the full resolved config view for a scope. When `project` is given, the
 * view reflects that project's merged config with override provenance; otherwise
 * it reflects the global defaults.
 *
 * Note: the `topic` domain is project-specific and stored separately — it is not
 * included here; use the `get_config` topic branch for that.
 */
export function buildConfigView(phrenPath, project) {
    const configDir = path.join(phrenPath, ".config");
    const retentionPath = path.join(configDir, "retention-policy.json");
    const workflowPath = path.join(configDir, "workflow-policy.json");
    const indexPath = path.join(configDir, "index-policy.json");
    const accessPath = path.join(configDir, "access-control.json");
    const proactivityPath = path.join(configDir, "install-preferences.json");
    const rawRetention = readRawJson(retentionPath);
    const rawWorkflow = readRawJson(workflowPath);
    const rawAccess = readRawJson(accessPath);
    const govPrefs = readGovernanceInstallPreferences(phrenPath);
    const indexPolicy = getIndexPolicy(phrenPath);
    let profileDefaults;
    try {
        profileDefaults = getActiveProfileDefaults(phrenPath);
    }
    catch {
        profileDefaults = undefined;
    }
    const overrides = project ? getProjectConfigOverrides(phrenPath, project) : null;
    const projectAccess = project ? readProjectConfig(phrenPath, project).access : undefined;
    const projectConfigPath = project
        ? path.join(phrenPath, project, "phren.project.yaml")
        : undefined;
    const fields = {};
    // ── proactivity ────────────────────────────────────────────────────────────
    const proactivityKeyMap = {
        "proactivity.base": "proactivity",
        "proactivity.findings": "proactivityFindings",
        "proactivity.tasks": "proactivityTask",
    };
    const baseLevels = [];
    pushIfSet(baseLevels, "project", overrides?.proactivity, projectConfigPath);
    pushIfSet(baseLevels, "profile", profileDefaults?.proactivity);
    pushIfSet(baseLevels, "global", govPrefs.proactivity, proactivityPath);
    const baseResolved = resolveConfigField("proactivity.base", "high", baseLevels);
    fields["proactivity.base"] = baseResolved;
    for (const key of ["proactivity.findings", "proactivity.tasks"]) {
        const ovKey = proactivityKeyMap[key];
        const levels = [];
        pushIfSet(levels, "project", overrides?.[ovKey], projectConfigPath);
        pushIfSet(levels, "profile", profileDefaults?.[ovKey]);
        pushIfSet(levels, "global", govPrefs[ovKey], proactivityPath);
        if (levels.length === 0) {
            // No own override at any level: inherit the resolved base verbatim.
            fields[key] = {
                key,
                value: baseResolved.value,
                source: baseResolved.source,
                inheritedValue: baseResolved.value,
                ...(baseResolved.sourcePath ? { sourcePath: baseResolved.sourcePath } : {}),
            };
        }
        else {
            // Resolve against the base value, so a findings/tasks override only counts
            // as a source when it genuinely diverges from the inherited base level.
            fields[key] = resolveConfigField(key, baseResolved.value, levels);
        }
    }
    // ── findingSensitivity & taskMode (live in workflow-policy.json) ────────────
    const fsLevels = [];
    pushIfSet(fsLevels, "project", overrides?.findingSensitivity, projectConfigPath);
    pushIfSet(fsLevels, "profile", profileDefaults?.findingSensitivity);
    pushIfSet(fsLevels, "global", rawWorkflow.findingSensitivity, workflowPath);
    fields.findingSensitivity = resolveConfigField("findingSensitivity", getConfigField("findingSensitivity")?.default, fsLevels);
    const tmLevels = [];
    pushIfSet(tmLevels, "project", overrides?.taskMode, projectConfigPath);
    pushIfSet(tmLevels, "profile", profileDefaults?.taskMode);
    pushIfSet(tmLevels, "global", rawWorkflow.taskMode, workflowPath);
    fields.taskMode = resolveConfigField("taskMode", getConfigField("taskMode")?.default, tmLevels);
    // ── retention ──────────────────────────────────────────────────────────────
    const retentionScalars = [
        ["retention.ttlDays", "ttlDays"],
        ["retention.retentionDays", "retentionDays"],
        ["retention.autoAcceptThreshold", "autoAcceptThreshold"],
        ["retention.minInjectConfidence", "minInjectConfidence"],
    ];
    for (const [fieldKey, prop] of retentionScalars) {
        const levels = [];
        pushIfSet(levels, "project", dig(overrides?.retentionPolicy, prop), projectConfigPath);
        pushIfSet(levels, "profile", dig(profileDefaults?.retentionPolicy, prop));
        pushIfSet(levels, "global", rawRetention[prop], retentionPath);
        fields[fieldKey] = resolveConfigField(fieldKey, getConfigField(fieldKey)?.default, levels);
    }
    for (const milestone of ["d30", "d60", "d90", "d120"]) {
        const fieldKey = `retention.decay.${milestone}`;
        const levels = [];
        pushIfSet(levels, "project", dig(overrides?.retentionPolicy, "decay", milestone), projectConfigPath);
        pushIfSet(levels, "profile", dig(profileDefaults?.retentionPolicy, "decay", milestone));
        pushIfSet(levels, "global", dig(rawRetention, "decay", milestone), retentionPath);
        fields[fieldKey] = resolveConfigField(fieldKey, getConfigField(fieldKey)?.default, levels);
    }
    // ── workflow ───────────────────────────────────────────────────────────────
    const lctLevels = [];
    pushIfSet(lctLevels, "project", dig(overrides?.workflowPolicy, "lowConfidenceThreshold"), projectConfigPath);
    pushIfSet(lctLevels, "profile", dig(profileDefaults?.workflowPolicy, "lowConfidenceThreshold"));
    pushIfSet(lctLevels, "global", rawWorkflow.lowConfidenceThreshold, workflowPath);
    fields["workflow.lowConfidenceThreshold"] = resolveConfigField("workflow.lowConfidenceThreshold", getConfigField("workflow.lowConfidenceThreshold")?.default, lctLevels);
    const rsLevels = [];
    const projectRisky = dig(overrides?.workflowPolicy, "riskySections");
    pushIfSet(rsLevels, "project", Array.isArray(projectRisky) && projectRisky.length ? projectRisky : undefined, projectConfigPath);
    const profileRisky = dig(profileDefaults?.workflowPolicy, "riskySections");
    pushIfSet(rsLevels, "profile", Array.isArray(profileRisky) && profileRisky.length ? profileRisky : undefined);
    const globalRisky = rawWorkflow.riskySections;
    pushIfSet(rsLevels, "global", Array.isArray(globalRisky) && globalRisky.length ? globalRisky : undefined, workflowPath);
    fields["workflow.riskySections"] = resolveConfigField("workflow.riskySections", getConfigField("workflow.riskySections")?.default, rsLevels);
    // ── index (global-only) ────────────────────────────────────────────────────
    const rawIndex = readRawJson(indexPath);
    for (const [fieldKey, prop] of [
        ["index.includeGlobs", "includeGlobs"],
        ["index.excludeGlobs", "excludeGlobs"],
        ["index.includeHidden", "includeHidden"],
    ]) {
        const levels = [];
        pushIfSet(levels, "global", rawIndex[prop], indexPath);
        const resolved = resolveConfigField(fieldKey, getConfigField(fieldKey)?.default, levels);
        // Always report the normalized effective value for index.
        fields[fieldKey] = { ...resolved, value: indexPolicy[prop] };
    }
    // ── access ─────────────────────────────────────────────────────────────────
    for (const [fieldKey, role] of [
        ["access.admins", "admins"],
        ["access.contributors", "contributors"],
        ["access.readers", "readers"],
    ]) {
        const globalList = Array.isArray(rawAccess[role]) ? rawAccess[role] : undefined;
        const projectList = Array.isArray(dig(projectAccess, role))
            ? dig(projectAccess, role)
            : undefined;
        const levels = [];
        pushIfSet(levels, "project", projectList && projectList.length ? projectList : undefined, projectConfigPath);
        pushIfSet(levels, "global", globalList && globalList.length ? globalList : undefined, accessPath);
        // Effective value is the union of every level that contributes.
        const union = [...new Set([...(globalList ?? []), ...(projectList ?? [])])];
        const resolved = resolveConfigField(fieldKey, [], levels);
        fields[fieldKey] = { ...resolved, value: union };
    }
    return {
        scope: project ? "project" : "global",
        ...(project ? { project } : {}),
        fields,
    };
}
/** Field keys belonging to a domain, in schema order. Excludes `topic`. */
export function fieldKeysForDomain(domain) {
    return allConfigFields()
        .filter((f) => f.domain === domain && f.domain !== "topic")
        .map((f) => f.key);
}
