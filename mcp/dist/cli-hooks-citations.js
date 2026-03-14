import { parseCitationComment, validateFindingCitation, } from "./content-citation.js";
import { capCache } from "./shared.js";
// ── Citation validation ──────────────────────────────────────────────────────
const citationValidCache = new Map();
export function clearCitationValidCache() {
    citationValidCache.clear();
}
export function parseCitations(text) {
    const results = [];
    let m;
    const citeRe = /<!--\s*phren:cite\s+(\{[\s\S]*?\})\s*-->/g;
    while ((m = citeRe.exec(text)) !== null) {
        const parsed = parseCitationComment(m[0]);
        if (parsed)
            results.push({ citation: parsed });
    }
    return results;
}
export function validateCitation(citation) {
    const key = JSON.stringify(citation.citation);
    if (citationValidCache.has(key))
        return citationValidCache.get(key);
    let valid = false;
    if (citation.citation) {
        valid = validateFindingCitation(citation.citation);
    }
    citationValidCache.set(key, valid);
    capCache(citationValidCache);
    return valid;
}
export function annotateStale(snippet) {
    const citations = parseCitations(snippet);
    if (citations.length === 0)
        return snippet;
    const annotations = [];
    for (const c of citations) {
        if (!validateCitation(c)) {
            annotations.push("[citation stale]");
        }
    }
    if (annotations.length === 0)
        return snippet;
    return snippet + " " + annotations.join(" ");
}
