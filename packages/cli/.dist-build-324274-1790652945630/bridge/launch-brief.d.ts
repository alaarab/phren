import { z } from "zod";
import { type Target } from "./protocol.js";
/**
 * A worker's first prompt carried by its launch instead of typed into a
 * starting pane. The brief is written to a private file on the computer that
 * starts the agent, and the harness gets one short argument pointing at it:
 * `claude "<prompt>"` and `codex "<prompt>"` both open the interactive TUI
 * and submit that prompt themselves, so there is no Enter to lose and no
 * starting pane to wait for. The same id is exported to the agent as
 * `PHREN_DISPATCH_ID`, and its SessionStart and UserPromptSubmit hooks echo
 * it back: the receipt is that echo, not a match on typed text.
 *
 * OpenCode takes its brief over the HTTP API its launched TUI serves
 * (opencode-panes.ts); the file is still written so the arrival is recorded
 * here. Copilot, with no such argument or API, keeps the typed path.
 */
/** A dispatch receipt id or a scheduled run id: what `PHREN_DISPATCH_ID` carries. */
export declare const briefId: z.ZodString;
export declare const launchBriefSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
}, z.core.$strict>;
export type LaunchBrief = z.infer<typeof launchBriefSchema>;
/** The variable a launched agent's hooks read its brief id from. */
export declare const DISPATCH_ID_ENV = "PHREN_DISPATCH_ID";
export declare function briefRoot(): string;
/** The harnesses whose TUI takes a first prompt as an argument, and the
 * arguments that carry it. Claude reads outside its working directory only
 * with permission, so the brief's own folder is added to its tool access;
 * `--add-dir` takes several values, so it comes after the prompt. */
export declare function briefArgs(kind: string, file: string): string[] | undefined;
export declare function launchesWithBrief(kind: string): boolean;
/**
 * The label the dispatcher gave a launched worker, kept beside its brief so
 * this Hook can name the worker's session by it: the harness titles a session
 * after its first prompt, which is only "Read and follow the brief in ...".
 * Undefined for an id this computer wrote no label for (older dispatches).
 */
export declare function briefLabel(id: string): Promise<string | undefined>;
/**
 * Writes the brief (0600, in a 0700 folder of its own) and returns its path.
 * A `label` is written beside it, inside the same folder, so it is published
 * with the brief and never lags it.
 * The folder is filled beside `briefs/` and renamed into place, so a brief
 * folder never exists without its `brief.md`: anything that lists `briefs/`
 * (the arrival route, a test, the owner) sees a whole brief or none. Writing
 * it in place left a moment where the folder was there and the file was not.
 */
export declare function writeLaunchBrief(brief: LaunchBrief, now?: number, label?: string): Promise<string>;
export declare const arrivalSchema: z.ZodObject<{
    started: z.ZodOptional<z.ZodObject<{
        at: z.ZodString;
        target: z.ZodObject<{
            server: z.ZodString;
            workspace: z.ZodString;
            tab: z.ZodString;
            pane: z.ZodString;
            source: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                copilot: "copilot";
                opencode: "opencode";
                phren: "phren";
            }>;
            session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
        }, z.core.$strip>;
    }, z.core.$strict>>;
    accepted: z.ZodOptional<z.ZodObject<{
        at: z.ZodString;
        target: z.ZodObject<{
            server: z.ZodString;
            workspace: z.ZodString;
            tab: z.ZodString;
            pane: z.ZodString;
            source: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                copilot: "copilot";
                opencode: "opencode";
                phren: "phren";
            }>;
            session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
        }, z.core.$strip>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type BriefArrival = z.infer<typeof arrivalSchema>;
/** What the worker's own hooks have said about its brief: `started` at its
 * SessionStart, `accepted` when the brief prompt was submitted. Empty while
 * neither has arrived; undefined when this computer wrote no such brief. */
export declare function briefArrival(id: string): Promise<BriefArrival | undefined>;
/** The brief id in a prompt that points at a brief file, for callbacks that
 * cannot trust their own environment (Codex's shared hook daemon). */
export declare function briefIdInPrompt(prompt: string): string | undefined;
/** Records a worker hook's report about its brief. Only the first of each
 * event counts, and only for a brief this computer wrote. */
export declare function recordBriefArrival(id: string, event: string, target: Target, now?: Date): Promise<void>;
