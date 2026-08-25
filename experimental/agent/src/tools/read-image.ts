import * as fs from "fs";
import * as path from "path";
import type { AgentTool, AgentToolImage } from "./types.js";
import type { LlmProvider } from "../providers/types.js";
import { modelSupportsVision } from "../models.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";

/** Anthropic rejects images over 5MB; the other providers are in the same range. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MEDIA_TYPES: Record<string, AgentToolImage["media_type"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Read an image file into the conversation. Registered only for vision-capable
 * models, and re-checked at execute time — registration-time gating is a
 * schema decision, not enforcement.
 */
export function createReadImageTool(provider: LlmProvider): AgentTool {
  return {
    name: "read_image",
    description:
      "Read an image file (png, jpeg, webp, gif) so you can see its contents. " +
      "Use for screenshots, diagrams, and design assets. Maximum size 5MB.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the image file" },
      },
      required: ["path"],
    },
    async execute(input) {
      const filePath = String(input.path ?? "");
      if (!filePath) return { output: "Missing required parameter: path", is_error: true };

      if (!modelSupportsVision(provider.name, provider.model ?? "")) {
        return {
          output: `The active model (${provider.model ?? provider.name}) does not accept image input.`,
          is_error: true,
        };
      }

      const resolved = path.resolve(filePath);
      const sensitive = checkSensitivePath(resolved);
      if (sensitive.sensitive) {
        return { output: `Access denied: ${sensitive.reason}`, is_error: true };
      }
      const sandboxResult = validatePath(filePath, process.cwd(), []);
      if (!sandboxResult.ok) {
        return { output: `Path outside sandbox: ${sandboxResult.error}`, is_error: true };
      }

      const mediaType = MEDIA_TYPES[path.extname(filePath).toLowerCase()];
      if (!mediaType) {
        return {
          output: `Unsupported image type "${path.extname(filePath)}". Supported: png, jpeg, webp, gif.`,
          is_error: true,
        };
      }

      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(filePath);
      } catch (err: unknown) {
        return { output: `Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }

      if (bytes.length > MAX_IMAGE_BYTES) {
        return {
          output: `Image is ${(bytes.length / 1024 / 1024).toFixed(1)}MB (limit 5MB). Downscale it first, e.g. with sips/magick.`,
          is_error: true,
        };
      }

      return {
        output: `Read ${path.basename(filePath)} (${mediaType}, ${(bytes.length / 1024).toFixed(0)}KB).`,
        images: [{ media_type: mediaType, data: bytes.toString("base64") }],
      };
    },
  };
}
