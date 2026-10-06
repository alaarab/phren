import { type AccountRef } from "./claude-accounts.js";
export declare const paneAccountKey: (server: string, pane: unknown) => string;
/** The account a pane was launched with (`default` or a slug). */
export declare function recordPaneAccount(paneKey: string, accountId: string, terminal?: string): void;
/** A Claude transcript path the pane's session is known to use. */
export declare function notePaneTranscript(paneKey: string, file: unknown, terminal?: string): void;
/** The pane's account: from its transcript when known, else the recorded launch. */
export declare function paneAccount(paneKey: string, terminal?: string): AccountRef | undefined;
