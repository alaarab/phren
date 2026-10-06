import { z } from "zod";
import { type Computer } from "./computer-identity.js";
declare const grantAction: z.ZodEnum<{
    dispatch: "dispatch";
    hand_off: "hand_off";
}>;
export declare const grantSchema: z.ZodObject<{
    scope: z.ZodUnion<readonly [z.ZodLiteral<"global">, z.ZodString]>;
    actions: z.ZodArray<z.ZodEnum<{
        dispatch: "dispatch";
        hand_off: "hand_off";
    }>>;
    computers: z.ZodOptional<z.ZodArray<z.ZodString>>;
    until: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type Grant = z.infer<typeof grantSchema>;
export declare function listGrants(root?: string): Promise<Grant[]>;
export interface GrantQuery {
    action: z.infer<typeof grantAction>;
    project?: string;
    computer?: string;
    /** The computers this Hook knows, so a grant naming any alias of `computer` matches. */
    computers?: readonly Computer[];
}
/** Most specific matching grant wins. A grant's computers may be any name the
 * destination answers to (see `computer-identity.ts`). A computers-restricted grant never
 * covers an unresolved destination: `anywhere` may pick a peer outside the
 * list, and a local hand-off never goes to one of them. */
export declare function matchGrant(grants: Grant[], query: GrantQuery, now?: number): Grant | undefined;
/** matchGrant over the stored grants; the known computers are read once, and
 * only when a grant restricts computers. */
export declare function findGrant(query: Omit<GrantQuery, "computers">, root?: string): Promise<Grant | undefined>;
/** Grants as listed to people: computers by canonical name. The file is left as written. */
export declare function listNamedGrants(root?: string): Promise<Grant[]>;
export declare function grantLabel(grant: Grant): string;
export declare function addGrant(input: unknown, root?: string): Promise<Grant>;
/** Write a grant from an approval card answer: already listed is success. */
export declare function ensureGrant(input: unknown, root?: string): Promise<Grant>;
export declare function removeGrant(input: unknown, root?: string): Promise<Grant>;
export {};
