export declare const CODE_PACKAGE_HINT = "phren code needs @phren/code: run phren modules enable code";
type CodePackage = typeof import("@phren/code");
/** Where the loaded copy came from: an explicit directory, a resolver step or
 * the bare specifier "@phren/code". Undefined until a load succeeds. */
export declare function loadedFrom(): string | undefined;
/** Resolution order for the optional package. First success wins and is remembered. */
export declare function loadCodePackage(store?: string): Promise<CodePackage | undefined>;
export declare function requireCodePackage(store?: string): Promise<CodePackage>;
export declare function codePackageHint(store?: string): string;
/**
 * Make @phren/code available to this store. A workspace checkout links its own
 * package; otherwise npm installs into the store's runtime packages, which the
 * Hook can resolve without a global npm.
 */
export declare function installCodePackage(store: string): Promise<CodePackage>;
export declare function copyCodeSkill(store: string, code: CodePackage): void;
export {};
