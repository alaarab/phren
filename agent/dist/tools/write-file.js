import * as fs from "fs";
import * as path from "path";
export const writeFileTool = {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    input_schema: {
        type: "object",
        properties: {
            path: { type: "string", description: "File path to write." },
            content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
    },
    async execute(input) {
        const filePath = input.path;
        const content = input.content;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return { output: `Wrote ${content.length} bytes to ${filePath}` };
    },
};
