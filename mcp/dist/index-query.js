import * as path from "path";
import { debugLog } from "./shared.js";
function describeSqlValue(value) {
    if (value === null)
        return "null";
    if (value === undefined)
        return "undefined";
    if (value instanceof Uint8Array)
        return "Uint8Array";
    return typeof value;
}
function expectRowWidth(row, minColumns, context) {
    if (!Array.isArray(row) || row.length < minColumns) {
        throw new Error(`${context}: expected at least ${minColumns} columns, got ${Array.isArray(row) ? row.length : typeof row}`);
    }
}
function normalizeDocSegment(value) {
    return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
function getProjectRoot(phrenPath, project) {
    return path.join(path.resolve(phrenPath), project);
}
export function buildSourceDocKey(project, docPath, phrenPath, fallbackFilename) {
    const normalizedProject = normalizeDocSegment(project);
    const normalizedDocPath = path.resolve(docPath);
    const projectRoot = getProjectRoot(phrenPath, project);
    if (normalizedDocPath.startsWith(projectRoot + path.sep) || normalizedDocPath === projectRoot) {
        const relPath = normalizeDocSegment(path.relative(projectRoot, normalizedDocPath));
        if (relPath)
            return `${normalizedProject}/${relPath}`;
    }
    const fallback = fallbackFilename ?? path.basename(docPath);
    return `${normalizedProject}/${normalizeDocSegment(fallback)}`;
}
export function decodeStringRow(row, width, context) {
    expectRowWidth(row, width, context);
    return row.slice(0, width).map((value, index) => {
        if (typeof value !== "string") {
            throw new Error(`${context}: expected column ${index} to be string, got ${describeSqlValue(value)}`);
        }
        return value;
    });
}
export function decodeFiniteNumber(value, context) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${context}: expected finite number, got ${describeSqlValue(value)}`);
    }
    return value;
}
export function getDocSourceKey(doc, phrenPath) {
    return buildSourceDocKey(doc.project, doc.path, phrenPath, doc.filename);
}
/** Normalize a memory ID to canonical format: `mem:project/path/to/file.md`. */
export function normalizeMemoryId(rawId) {
    let id = decodeURIComponent(rawId).replace(/\\/g, "/");
    if (!id.startsWith("mem:"))
        id = `mem:${id}`;
    return id;
}
export function rowToDoc(row) {
    const [project, filename, type, content, filePath] = decodeStringRow(row, 5, "rowToDoc");
    return { project, filename, type, content, path: filePath };
}
export function rowToDocWithRowid(row) {
    expectRowWidth(row, 6, "rowToDocWithRowid");
    const rowid = decodeFiniteNumber(row[0], "rowToDocWithRowid");
    const [project, filename, type, content, filePath] = decodeStringRow(row.slice(1), 5, "rowToDocWithRowid.doc");
    return {
        rowid,
        doc: { project, filename, type, content, path: filePath },
    };
}
export function queryRows(db, sql, params) {
    try {
        const results = db.exec(sql, params);
        if (!Array.isArray(results) || !results.length || !results[0]?.values?.length)
            return null;
        return results[0].values;
    }
    catch (err) {
        debugLog(`queryRows failed: ${err instanceof Error ? err.message : "unknown error"}`);
        return null;
    }
}
export function queryDocRows(db, sql, params) {
    const raw = queryRows(db, sql, params);
    if (!raw)
        return null;
    return raw.map(rowToDoc);
}
export function queryDocBySourceKey(db, phrenPath, sourceKey) {
    const match = sourceKey.match(/^([^/]+)\/(.+)$/);
    if (!match)
        return null;
    const [, project, rest] = match;
    const filename = rest.includes("/") ? path.basename(rest) : rest;
    const rows = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND filename = ?", [project, filename]);
    if (!rows)
        return null;
    return rows.find((row) => getDocSourceKey(row, phrenPath) === sourceKey) ?? null;
}
export function extractSnippet(content, query, lines = 5) {
    const terms = query.replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
        .replace(/['"]/g, "")
        .split(/\s+/)
        .filter((term) => term.length > 1)
        .map((term) => term.toLowerCase());
    if (terms.length === 0) {
        return content.split("\n").slice(0, lines).join("\n");
    }
    const contentLines = content.split("\n");
    const headingIndices = [];
    for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].trimStart().startsWith("#"))
            headingIndices.push(i);
    }
    function nearestHeadingDist(idx) {
        let min = Infinity;
        for (const headingIndex of headingIndices) {
            const distance = Math.abs(idx - headingIndex);
            if (distance < min)
                min = distance;
        }
        return min;
    }
    function sectionMiddle(idx) {
        let sectionStart = 0;
        let sectionEnd = contentLines.length;
        for (const headingIndex of headingIndices) {
            if (headingIndex <= idx)
                sectionStart = headingIndex;
            else {
                sectionEnd = headingIndex;
                break;
            }
        }
        return (sectionStart + sectionEnd) / 2;
    }
    let bestIdx = 0;
    let bestScore = 0;
    let bestHeadingDist = Infinity;
    let bestMidDist = Infinity;
    for (let i = 0; i < contentLines.length; i++) {
        const lineLower = contentLines[i].toLowerCase();
        let score = 0;
        for (const term of terms) {
            if (lineLower.includes(term))
                score++;
        }
        if (score === 0)
            continue;
        const headingDist = nearestHeadingDist(i);
        const nearHeading = headingDist <= 3;
        const midDist = Math.abs(i - sectionMiddle(i));
        const better = score > bestScore ||
            (score === bestScore && nearHeading && bestHeadingDist > 3) ||
            (score === bestScore && nearHeading === (bestHeadingDist <= 3) && midDist < bestMidDist);
        if (better) {
            bestScore = score;
            bestIdx = i;
            bestHeadingDist = headingDist;
            bestMidDist = midDist;
        }
    }
    const start = Math.max(0, bestIdx - 1);
    const end = Math.min(contentLines.length, bestIdx + lines - 1);
    return contentLines.slice(start, end).join("\n");
}
