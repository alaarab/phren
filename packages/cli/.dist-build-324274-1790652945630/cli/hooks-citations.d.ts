import { type FindingCitation } from "../content/citation.js";
export declare function clearCitationValidCache(): void;
export interface ParsedCitation {
    citation?: FindingCitation;
}
export declare function parseCitations(text: string): ParsedCitation[];
export declare function validateCitation(citation: ParsedCitation): boolean;
export declare function annotateStale(snippet: string): string;
