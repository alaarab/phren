/**
 * CLI: phren graph [--project <name>] [--limit <n>]
 * Displays the fragment knowledge graph as a table.
 */
export declare function handleGraphRead(args: string[]): Promise<void>;
/**
 * CLI: phren graph link <project> <finding_text> <fragment_name>
 * Links a finding to a fragment manually.
 */
export declare function handleGraphLink(args: string[]): Promise<void>;
/**
 * CLI: phren graph <subcommand>
 * Routes graph subcommands.
 */
export declare function handleGraphNamespace(args: string[]): Promise<void>;
