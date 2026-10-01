/**
 * Images in a prompt: a path to a png, jpeg, webp or gif in the message
 * (typed, or dropped onto the terminal, which pastes the path, quoted or with
 * escaped spaces) is attached to the message as the image itself, on a model
 * that can see. Terminals don't pass clipboard image data to a program, so a
 * dropped or typed path is how an image gets in, as in Claude Code.
 */
import * as fs from "fs";
import * as path from "path";
import type { ContentBlock, ImageBlock } from "./providers/types.js";

/** Anthropic rejects images over 5MB; the other providers are in the same range. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;

const MEDIA_TYPES: Record<string, ImageBlock["source"]["media_type"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Candidate paths: quoted, backslash-escaped spaces, or plain, with an image extension. */
const PATH_RE = /'([^']+\.(?:png|jpe?g|webp|gif))'|"([^"]+\.(?:png|jpe?g|webp|gif))"|((?:[^\s'"\\]|\\ )+\.(?:png|jpe?g|webp|gif))/gi;

export interface AttachedImages {
  content: string | ContentBlock[];
  attached: string[];
  /** Paths that looked like images but were skipped, with why. */
  skipped: string[];
}

/** The message with any image paths in it attached as images. */
export function attachImages(text: string, cwd: string): AttachedImages {
  const attached: string[] = [];
  const skipped: string[] = [];
  const images: ContentBlock[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const raw = (match[1] ?? match[2] ?? match[3]).replace(/\\ /g, " ");
    const file = path.resolve(cwd, raw.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (attached.includes(file)) continue;
    let size: number;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue; // not a file here: just text
    }
    if (images.length >= MAX_IMAGES) { skipped.push(`${raw} (more than ${MAX_IMAGES} images)`); continue; }
    if (size > MAX_IMAGE_BYTES) { skipped.push(`${raw} (over 5MB)`); continue; }
    images.push({
      type: "image",
      source: { type: "base64", media_type: MEDIA_TYPES[path.extname(file).toLowerCase()], data: fs.readFileSync(file).toString("base64") },
    });
    attached.push(file);
  }
  return images.length === 0 ? { content: text, attached, skipped } : { content: [{ type: "text", text }, ...images], attached, skipped };
}
