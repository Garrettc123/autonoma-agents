import { modelMessageSchema, type ModelMessage } from "ai";
import { z } from "zod";
import { getDefaultLogger, type Logger } from "../logger";
import type { ImageStore } from "./image-store";
import { storedMessagesSchema, type StoredMessages } from "./stored-messages";

const DEFAULT_KEY_PREFIX = "agent-messages/images";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const DEFAULT_IMAGE_MEDIA_TYPE = "image/png";

/** A string starting with one of these is a URL reference, not inline base64. */
const URL_LIKE_PREFIXES = ["http://", "https://", "data:"];

/** Magic bytes to label an image that arrived without a media type. `undefined` = wildcard byte. */
const IMAGE_SIGNATURES: ReadonlyArray<{ mediaType: string; magic: readonly (number | undefined)[] }> = [
    { mediaType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
    { mediaType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
    { mediaType: "image/gif", magic: [0x47, 0x49, 0x46] },
    {
        mediaType: "image/webp",
        magic: [0x52, 0x49, 0x46, 0x46, undefined, undefined, undefined, undefined, 0x57, 0x45, 0x42, 0x50],
    },
];

interface InlineImageBytes {
    bytes: Uint8Array;
    mediaType: string;
}

interface ImageRef {
    type: "image-ref";
    key: string;
    mediaType: string;
}

/** A rehydrated image. The URL must be a `URL` instance - the SDK's runtime schema rejects a string. */
interface UrlFilePart {
    type: "file";
    data: { type: "url"; url: URL };
    mediaType: string;
}

export interface MessageStorageConfig {
    /** Where image bytes are parked and read back from. */
    imageStore: ImageStore;
    /** Prefix for content-addressed image keys. Defaults to `agent-messages/images`. */
    keyPrefix?: string;
    /** TTL for the presigned URLs `fromStored` mints. Defaults to one hour. */
    signedUrlTtlSeconds?: number;
    /** Defaults to the process-wide default logger. */
    logger?: Logger;
}

/**
 * Translates between the AI SDK's `ModelMessage[]` and a storable form: `toStored` lifts inline images
 * into blob storage and leaves an `image-ref`; `fromStored` resolves each ref back to a presigned-URL
 * file part. Text and tool parts stay JSON-inline. Both are recursive walks, so an image is caught
 * wherever it sits (prompt, assistant part, or nested in a tool result).
 *
 * `fromStored` output is request-scoped: the presigned URLs expire, so send it to the model right away
 * and never persist it.
 */
export class MessageStorage {
    private readonly logger: Logger;
    private readonly imageStore: ImageStore;
    private readonly keyPrefix: string;
    private readonly signedUrlTtlSeconds: number;

    constructor({ imageStore, keyPrefix, signedUrlTtlSeconds, logger }: MessageStorageConfig) {
        this.imageStore = imageStore;
        this.keyPrefix = keyPrefix ?? DEFAULT_KEY_PREFIX;
        this.signedUrlTtlSeconds = signedUrlTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
        this.logger = (logger ?? getDefaultLogger()).child({ name: this.constructor.name });
    }

    /** Replace every inline image with a stored ref, keeping all other parts inline. */
    public async toStored(messages: ModelMessage[]): Promise<StoredMessages> {
        this.logger.info("Translating messages to stored form", { messageCount: messages.length });

        const lifted = await Promise.all(messages.map((message) => this.liftNode(message)));
        const stored = storedMessagesSchema.parse(lifted);

        this.logger.info("Messages translated to stored form", { messageCount: stored.length });
        return stored;
    }

    /** Resolve every stored ref back into an image part the model can consume. */
    public async fromStored(stored: StoredMessages): Promise<ModelMessage[]> {
        // Parse defensively: typed by contract, but it comes from DB JSON that can drift.
        const parsed = storedMessagesSchema.parse(stored);
        this.logger.info("Resolving stored messages", { messageCount: parsed.length });

        const rehydrated = await Promise.all(parsed.map((message) => this.rehydrateNode(message)));
        // The SDK schema re-types the tree to `ModelMessage[]` (no cast) and drops anything it doesn't model.
        const messages = z.array(modelMessageSchema).parse(rehydrated);

        this.logger.info("Stored messages resolved", { messageCount: messages.length });
        return messages;
    }

    private async liftNode(node: unknown): Promise<unknown> {
        if (Array.isArray(node)) return Promise.all(node.map((item) => this.liftNode(item)));

        const image = inlineImageBytes(node, this.logger);
        if (image != null) return this.upload(image);

        // Non-image binary stays inline, but raw bytes don't survive JSON, so base64 them.
        if (!isPlainObject(node)) return toSerializableLeaf(node);

        const entries = await Promise.all(
            Object.entries(node).map(
                async ([key, value]): Promise<[string, unknown]> => [key, await this.liftNode(value)],
            ),
        );
        return Object.fromEntries(entries);
    }

    private async rehydrateNode(node: unknown): Promise<unknown> {
        if (Array.isArray(node)) return Promise.all(node.map((item) => this.rehydrateNode(item)));

        if (isImageRef(node)) return this.resolve(node);

        if (!isPlainObject(node)) return node;

        const entries = await Promise.all(
            Object.entries(node).map(
                async ([key, value]): Promise<[string, unknown]> => [key, await this.rehydrateNode(value)],
            ),
        );
        return Object.fromEntries(entries);
    }

    private async upload({ bytes, mediaType }: InlineImageBytes): Promise<ImageRef> {
        // Content-addressed key: an identical screenshot dedupes to one object.
        const key = `${this.keyPrefix}/${await sha256Hex(bytes)}`;
        await this.imageStore.upload(key, bytes, mediaType);

        this.logger.info("Lifted inline image to store", { key, mediaType, byteLength: bytes.length });
        return { type: "image-ref", key, mediaType };
    }

    private async resolve({ key, mediaType }: ImageRef): Promise<UrlFilePart> {
        const url = await this.imageStore.getSignedUrl(key, this.signedUrlTtlSeconds, mediaType);
        this.logger.info("Resolved image ref to signed url", { key, mediaType });

        return { type: "file", data: { type: "url", url: new URL(url) }, mediaType };
    }
}

function inlineImageBytes(node: unknown, logger: Logger): InlineImageBytes | undefined {
    if (!isPlainObject(node)) return undefined;

    if (node.type === "image") {
        const bytes = toBytes(node.image, logger);
        if (bytes == null) return undefined;
        const mediaType = typeof node.mediaType === "string" ? node.mediaType : sniffImageMediaType(bytes);
        return { bytes, mediaType };
    }

    if (node.type === "file") {
        const mediaType = typeof node.mediaType === "string" ? node.mediaType : undefined;
        if (mediaType == null || !isImageMediaType(mediaType)) return undefined;
        const bytes = fileDataBytes(node.data, logger);
        if (bytes == null) return undefined;
        return { bytes, mediaType };
    }

    return undefined;
}

/** Bytes only. A URL, provider reference, or inline-text file carries nothing to lift. */
function fileDataBytes(data: unknown, logger: Logger): Uint8Array | undefined {
    if (isPlainObject(data)) return data.type === "data" ? toBytes(data.data, logger) : undefined;
    return toBytes(data, logger);
}

/** Normalize the SDK's `DataContent` (base64 | Uint8Array | ArrayBuffer | Buffer) to bytes. */
function toBytes(data: unknown, logger: Logger): Uint8Array | undefined {
    if (typeof data === "string") return stringToBytes(data, logger);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return undefined;
}

/**
 * Base64 string to bytes. A URL/data-URL string is a reference, not bytes, so it passes through
 * untouched (a proper `{ type: "url" }` part is the caller's job). Any other undecodable string is
 * logged and skipped rather than crashing the whole conversation.
 */
function stringToBytes(value: string, logger: Logger): Uint8Array | undefined {
    if (isUrlLike(value)) return undefined;
    try {
        return base64ToBytes(value);
    } catch (err) {
        logger.warn("Skipping an image part with undecodable inline data", { err });
        return undefined;
    }
}

function isUrlLike(value: string): boolean {
    return URL_LIKE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

// Only for the rare non-image inline-binary leaf; not meant for large blobs (images go to S3).
function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** Make a leaf JSON-safe: binary becomes base64, everything else passes through. */
function toSerializableLeaf(node: unknown): unknown {
    if (node instanceof Uint8Array) return bytesToBase64(node);
    if (node instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(node));
    return node;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    // Copy so the buffer is ArrayBuffer-backed: `digest` rejects a SharedArrayBuffer-backed view.
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sniffImageMediaType(bytes: Uint8Array): string {
    for (const { mediaType, magic } of IMAGE_SIGNATURES) {
        if (magic.every((byte, index) => byte === undefined || bytes[index] === byte)) return mediaType;
    }
    return DEFAULT_IMAGE_MEDIA_TYPE;
}

function isImageMediaType(mediaType: string): boolean {
    return mediaType === "image" || mediaType.startsWith("image/");
}

function isImageRef(node: unknown): node is ImageRef {
    return (
        isPlainObject(node) &&
        node.type === "image-ref" &&
        typeof node.key === "string" &&
        typeof node.mediaType === "string"
    );
}

/** A JSON object - not an array, and not a boxed value (`Uint8Array`, `URL`, ...) we must not walk into. */
function isPlainObject(node: unknown): node is Record<string, unknown> {
    if (typeof node !== "object" || node == null) return false;
    const proto = Object.getPrototypeOf(node);
    return proto === Object.prototype || proto === null;
}
