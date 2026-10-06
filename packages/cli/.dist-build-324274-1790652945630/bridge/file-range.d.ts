export declare const MAX_FILE_RANGE: number;
export declare function fileContentType(file: string): string;
export declare function rangeInteger(value: string | null, fallback: number): number;
/** Roots are selected by the server, never supplied unchecked by the phone.
 * A zero length request checks existence and metadata without reading bytes.
 * Reject every symlink component, matching the repository browser policy. */
export declare function readFileRange(root: string, requested: string, offset: number, length: number, expectedVersion?: string): Promise<{
    path: string;
    offset: number;
    length: number;
    total: number;
    contentType: string;
    version: string;
    eof: boolean;
    data: string;
}>;
