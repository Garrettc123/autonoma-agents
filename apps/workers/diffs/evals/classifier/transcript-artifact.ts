import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelMessage } from "@autonoma/ai";
import { logger as rootLogger } from "@autonoma/logger";

/** A `data:` URL shorter than this is a real (tiny) value worth keeping; longer is an inlined image to elide. */
const DATA_URL_ELIDE_THRESHOLD = 256;

/**
 * Anything outside a flat filename slug. Case names are kebab slugs today, but a `/` would imply a nested path
 * under `dir` that {@link writeClassifierTranscript}'s `mkdirSync(dir)` never created (ENOENT) - or, worse, one
 * that escapes it. Collapsing to a dash keeps the transcript a single flat file inside `dir`.
 */
const FILENAME_UNSAFE = /[^A-Za-z0-9._-]/g;

/**
 * Persist one classification's full model conversation to a debug artifact under `dir`, with binary image
 * payloads replaced by `[binary N bytes]` so the file stays a readable text transcript instead of megabytes
 * of base64. Returns the path written. The transcript is what makes a verdict's *reasoning* - every tool call,
 * tool result, and reasoning turn - recoverable after the run, which the scored result JSON does not carry.
 */
export async function writeClassifierTranscript(opts: {
    dir: string;
    caseName: string;
    conversation: ModelMessage[];
}): Promise<string> {
    const logger = rootLogger.child({ name: "writeClassifierTranscript" });
    const { dir, caseName, conversation } = opts;

    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${caseName.replace(FILENAME_UNSAFE, "-")}.json`);
    await writeFile(file, JSON.stringify(conversation, elideBinary, 2));

    logger.info("Wrote classifier transcript", { extra: { file, messages: conversation.length } });
    return file;
}

/**
 * A JSON replacer that swaps binary image data for a short placeholder. It has to catch three encodings a
 * `ModelMessage` image can arrive in: a typed array (the attached screenshot bytes), a Buffer once its own
 * `toJSON` has turned it into `{ type: "Buffer", data: [...] }`, and an inlined `data:` URL string.
 */
function elideBinary(_key: string, value: unknown): unknown {
    if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
    if (isBufferJson(value)) return `[binary ${value.data.length} bytes]`;
    if (typeof value === "string" && value.startsWith("data:") && value.length > DATA_URL_ELIDE_THRESHOLD) {
        return `[data-url ${value.length} chars]`;
    }
    return value;
}

function isBufferJson(value: unknown): value is { type: "Buffer"; data: number[] } {
    return (
        typeof value === "object" &&
        value != null &&
        "type" in value &&
        value.type === "Buffer" &&
        "data" in value &&
        Array.isArray(value.data)
    );
}
