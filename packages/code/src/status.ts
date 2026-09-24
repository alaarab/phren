import {
  codeDatabasePath,
  counts,
  languageFileCounts,
  lastIndexedAt,
  openCodeDatabase,
  symbolKindCounts,
  topSymbolsByUsage,
} from "./store.js";

/** Read-only summary of a project's code index, for `phren code status`. */

export interface CodeLanguageCount {
  language: string;
  files: number;
}

export interface CodeStatus {
  project: string;
  databasePath: string;
  available: boolean;
  files: number;
  symbols: number;
  references: number;
  lastIndexedAt: number | null;
  languages: CodeLanguageCount[];
  kinds: Array<{ kind: string; symbols: number }>;
  top: Array<{ name: string; file: string; kind: string; uses: number }>;
}

export async function codeIndexStatus(store: string, project: string, top = 10): Promise<CodeStatus> {
  const databasePath = codeDatabasePath(store, project);
  const database = await openCodeDatabase(store, project, false);
  if (!database) {
    return {
      project,
      databasePath,
      available: false,
      files: 0,
      symbols: 0,
      references: 0,
      lastIndexedAt: null,
      languages: [],
      kinds: [],
      top: [],
    };
  }
  const { db } = database;
  const totals = counts(db);
  const status: CodeStatus = {
    project,
    databasePath,
    available: true,
    files: totals.files,
    symbols: totals.symbols,
    references: totals.references,
    lastIndexedAt: lastIndexedAt(db),
    languages: languageFileCounts(db),
    kinds: symbolKindCounts(db),
    top: topSymbolsByUsage(db, top),
  };
  database.close();
  return status;
}
