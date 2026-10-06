/** Concrete Host aliases from an ssh config: no patterns, no Git hosting services. */
export declare function sshConfigHosts(text: string): string[];
export interface ReachableComputer {
    host: string;
    computerId: string;
    user: string;
    client?: string;
}
/** Hosts from ~/.ssh/config and the store's machines.yaml that answer over ssh,
 * run Phren Hook and are not this computer or an already linked peer. */
export declare function discoverComputers(options?: {
    sshConfig?: string;
    store?: string | null;
}): Promise<{
    reachable: ReachableComputer[];
    checked: string[];
}>;
export interface LinkResult {
    name: string;
    as: string;
    local: {
        added: boolean;
    };
    remote: {
        added: boolean;
        reachable: boolean;
        error?: string;
    };
    reachable: boolean;
    error?: string;
}
/**
 * Links this computer and `host` in both directions over the owner's existing
 * ssh login: each side's dispatch key is enrolled on the other, and each
 * side's ed25519 host key is read over that login (never keyscanned) and
 * pinned in the other's hooks.yaml. Both sides then check the link.
 */
export declare function linkComputer(host: string, options?: {
    name?: string;
    as?: string;
    backAddress?: string;
}): Promise<LinkResult>;
/** The receiving half of a link: pin the caller in hooks.yaml, then dial it back. */
export declare function addPeerFromLink(input: string): Promise<{
    added: boolean;
    reachable: boolean;
    error?: string;
}>;
