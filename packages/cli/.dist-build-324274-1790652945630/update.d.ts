interface UpdateResult {
    ok: boolean;
    message: string;
}
interface RunPhrenUpdateOptions {
    refreshStarter?: boolean;
}
export declare function runPhrenUpdate(opts?: RunPhrenUpdateOptions): Promise<UpdateResult>;
export {};
