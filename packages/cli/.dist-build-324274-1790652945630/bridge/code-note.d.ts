import { z } from "zod";
import { type Json } from "./protocol.js";
export declare const codeNoteSchema: z.ZodObject<{
    store: z.ZodOptional<z.ZodString>;
    project: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    symbol: z.ZodOptional<z.ZodString>;
    file: z.ZodString;
    line: z.ZodNumber;
    text: z.ZodString;
    target: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
        session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
    }, z.core.$strict>, z.ZodObject<{
        harness: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            opencode: "opencode";
        }>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export type CodeNote = z.infer<typeof codeNoteSchema>;
export type CodeNoteDelivery = (note: CodeNote, brief: string) => Promise<Json>;
export declare function saveCodeNote(store: string, input: unknown, deliver?: CodeNoteDelivery): Promise<Json>;
