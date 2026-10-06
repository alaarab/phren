/** Read-only browsing beneath a root selected and verified by the server. */
export declare function browseFiles(root: string, relative: string): Promise<{
    path: string;
    kind: string;
    truncated: boolean;
    entries: {
        name: string;
        path: string;
        kind: string;
    }[];
    size?: undefined;
    data?: undefined;
} | {
    truncated?: undefined;
    entries?: undefined;
    path: string;
    kind: string;
    size: number;
    data: string;
}>;
