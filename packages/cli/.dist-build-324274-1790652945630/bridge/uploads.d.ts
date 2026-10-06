export declare function imageBytes(bytes: Buffer): boolean;
export declare const IMAGE_NAME: RegExp;
/** Stores a file the phone sent under uploads/<session>/. A name with an
 * image extension must hold image bytes; anything else is kept as-is. */
export declare function saveUpload(session: string, name: string, bytes: Buffer): Promise<string>;
/** What the phone has put in one folder, newest first. */
export declare function listUploads(session: string): Promise<{
    name: string;
    path: string;
    size: number;
    modified: string;
}[]>;
/** The bytes of one image the phone put under uploads/, by the absolute
 * path the transcript names. Served only when the path resolves (through
 * any link) to a regular file inside the uploads folder whose bytes are
 * an image; anything else — outside, traversal, a note — is 404. */
export declare function uploadImage(requested: string): Promise<Buffer>;
/** A file the phone uploaded for this conversation, by the path `/v1/upload`
 * returned: it must resolve to a regular file inside uploads/<session>/. */
export declare function sessionUpload(session: string, requested: string): Promise<string>;
