export declare function updateFileChecksums(phrenPath: string, profileName?: string): {
    updated: number;
    files: string[];
};
export declare function verifyFileChecksums(phrenPath: string): Array<{
    file: string;
    status: "ok" | "mismatch" | "missing";
}>;
