export interface ToolMetadata {
    name: string;
    title?: string;
    description: string;
    module: string;
    category: string;
}
export declare function getRegisteredTools(): ToolMetadata[];
export declare function getToolCount(): number;
export declare function getToolsByCategory(): Array<{
    category: string;
    tools: ToolMetadata[];
}>;
export declare function renderToolCatalogMarkdown(allowed?: ReadonlySet<string>): string;
