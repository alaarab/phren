export declare function setModuleEnabled(store: string, name: string, value: boolean, profile?: string): void;
/** Freeze legacy surfaces before runtime defaults can change an existing install. */
export declare function migrateModules(store: string, hookInstalled?: boolean): void;
export declare function initializeModules(store: string): void;
/**
 * `phren pair` and `phren bridge install` are how a person asks for the Hook,
 * so they turn its module on instead of refusing. Returns true when this
 * call enabled it. Without a store there is nothing to record; the Hook's
 * legacy default already allows it there.
 */
export declare function enableHookForPhone(store: string): boolean;
