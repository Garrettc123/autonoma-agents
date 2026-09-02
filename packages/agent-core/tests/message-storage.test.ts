import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageProvider } from "@autonoma/storage/local";
import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImageStore } from "../src/message-storage/image-store";
import { MessageStorage } from "../src/message-storage/message-storage";
import { storedMessagesSchema } from "../src/message-storage/stored-messages";

/** A minimal in-memory {@link ImageStore}: records every upload and hands back a fake signed URL. */
class FakeImageStore implements ImageStore {
    public readonly objects = new Map<string, { bytes: Buffer; contentType?: string }>();
    public uploadCalls = 0;

    async upload(key: string, data: Buffer, contentType?: string): Promise<void> {
        this.uploadCalls += 1;
        this.objects.set(key, { bytes: data, contentType });
    }

    async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
        return `https://signed.example/${key}?ttl=${expiresInSeconds}`;
    }
}

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]).toString("base64");
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

function conversationWithImages(): ModelMessage[] {
    return [
        { role: "system", content: "You are a helpful agent." },
        {
            role: "user",
            content: [
                { type: "text", text: "What is on this screen?" },
                // Legacy image part with no media type - exercises byte sniffing.
                { type: "image", image: PNG_BASE64 },
            ],
        },
        {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call-1", toolName: "view_frame", input: { region: "top" } }],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "view_frame",
                    output: {
                        type: "content",
                        value: [
                            { type: "text", text: "Here is the frame." },
                            { type: "file", data: { type: "data", data: PNG_BASE64 }, mediaType: "image/png" },
                        ],
                    },
                },
            ],
        },
    ];
}

let store: FakeImageStore;
let storage: MessageStorage;

beforeEach(() => {
    store = new FakeImageStore();
    storage = new MessageStorage({ imageStore: store, keyPrefix: "test/images" });
});

describe("MessageStorage.toStored", () => {
    it("lifts every inline image to a ref and leaves no bytes inline", async () => {
        const stored = await storage.toStored(conversationWithImages());

        const serialized = JSON.stringify(stored);
        expect(serialized).not.toContain(PNG_BASE64);
        expect(serialized).toContain("image-ref");

        const userImage = arrayContent(stored[1])[1];
        expect(userImage).toMatchObject({ type: "image-ref", mediaType: "image/png" });

        const toolResult = arrayContent(stored[3])[0];
        expect(toolResult).toMatchObject({ type: "tool-result", toolName: "view_frame" });
    });

    it("keeps text, tool-call, and tool-result text parts inline and intact", async () => {
        const stored = await storage.toStored(conversationWithImages());

        expect(stored[0]).toEqual({ role: "system", content: "You are a helpful agent." });
        expect(arrayContent(stored[1])[0]).toEqual({ type: "text", text: "What is on this screen?" });
        expect(arrayContent(stored[2])[0]).toEqual({
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "view_frame",
            input: { region: "top" },
        });
    });

    it("dedupes identical images to one content-addressed object", async () => {
        // The same PNG appears twice (user prompt + tool result).
        const stored = await storage.toStored(conversationWithImages());

        const userKey = refKey(arrayContent(stored[1])[1]);
        const toolItems = toolResultContent(arrayContent(stored[3])[0]);
        const frameKey = refKey(toolItems[1]);

        expect(userKey).toBe(frameKey);
        expect(store.objects.size).toBe(1);
        expect(userKey).toMatch(/^test\/images\/[0-9a-f]{64}$/);
    });

    it("passes URL image parts through without uploading", async () => {
        const stored = await storage.toStored([
            {
                role: "user",
                content: [
                    { type: "file", data: { type: "url", url: "https://cdn.example/a.png" }, mediaType: "image/png" },
                ],
            },
        ]);

        expect(store.uploadCalls).toBe(0);
        expect(arrayContent(stored[0])[0]).toEqual({
            type: "file",
            data: { type: "url", url: "https://cdn.example/a.png" },
            mediaType: "image/png",
        });
    });

    it("leaves non-image files inline", async () => {
        await storage.toStored([
            {
                role: "user",
                content: [{ type: "file", data: { type: "data", data: JPEG_BASE64 }, mediaType: "application/pdf" }],
            },
        ]);

        expect(store.uploadCalls).toBe(0);
    });

    it("normalizes inline non-image bytes to base64 so the stored form is JSON-safe", async () => {
        const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
        const stored = await storage.toStored([
            {
                role: "user",
                content: [{ type: "file", data: { type: "data", data: pdfBytes }, mediaType: "application/pdf" }],
            },
        ]);

        expect(store.uploadCalls).toBe(0);
        // No raw byte-array object (`{"0":37,...}`) leaks into the DB JSON.
        expect(JSON.stringify(stored)).not.toContain('"0":37');
        const data = arrayContent(stored[0])[0].data;
        if (!isRecord(data)) throw new Error("expected file data object");
        expect(data.data).toBe(Buffer.from(pdfBytes).toString("base64"));
    });

    it("stores distinct images as separate content-addressed objects", async () => {
        const stored = await storage.toStored([
            {
                role: "user",
                content: [
                    { type: "image", image: PNG_BASE64 },
                    // No media type - sniffed as JPEG from its magic bytes.
                    { type: "image", image: JPEG_BASE64 },
                ],
            },
        ]);

        const pngKey = refKey(arrayContent(stored[0])[0]);
        const jpegRef = arrayContent(stored[0])[1];
        expect(jpegRef).toMatchObject({ type: "image-ref", mediaType: "image/jpeg" });
        expect(pngKey).not.toBe(refKey(jpegRef));
        expect(store.objects.size).toBe(2);
        expect(store.uploadCalls).toBe(2);
    });

    it("sniffs a media-type-less WebP via its RIFF/WEBP markers", async () => {
        // "RIFF" <4-byte length> "WEBP" - the length bytes are wildcards in the signature.
        const webpBase64 = Buffer.from([
            0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        ]).toString("base64");
        const stored = await storage.toStored([{ role: "user", content: [{ type: "image", image: webpBase64 }] }]);

        expect(arrayContent(stored[0])[0]).toMatchObject({ type: "image-ref", mediaType: "image/webp" });
    });

    it("lifts an image whose bytes are a Uint8Array, not a base64 string", async () => {
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const stored = await storage.toStored([{ role: "user", content: [{ type: "image", image: pngBytes }] }]);

        expect(store.uploadCalls).toBe(1);
        expect(arrayContent(stored[0])[0]).toMatchObject({ type: "image-ref", mediaType: "image/png" });
    });

    it("passes an image part carrying a URL or data-URL string through without uploading or crashing", async () => {
        const stored = await storage.toStored([
            {
                role: "user",
                content: [
                    { type: "image", image: "https://cdn.example/a.png", mediaType: "image/png" },
                    { type: "image", image: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" },
                ],
            },
        ]);

        expect(store.uploadCalls).toBe(0);
        expect(arrayContent(stored[0])[0]).toEqual({
            type: "image",
            image: "https://cdn.example/a.png",
            mediaType: "image/png",
        });
        expect(arrayContent(stored[0])[1]).toEqual({
            type: "image",
            image: "data:image/png;base64,iVBORw0KGgo=",
            mediaType: "image/png",
        });
    });

    it("produces a stable content-addressed key across independent instances", async () => {
        const message: ModelMessage = { role: "user", content: [{ type: "image", image: PNG_BASE64 }] };

        const first = await storage.toStored([message]);
        const other = new MessageStorage({ imageStore: new FakeImageStore(), keyPrefix: "test/images" });
        const second = await other.toStored([message]);

        expect(refKey(arrayContent(first[0])[0])).toBe(refKey(arrayContent(second[0])[0]));
    });

    it("round-trips an empty conversation", async () => {
        expect(await storage.toStored([])).toEqual([]);
        expect(await storage.fromStored([])).toEqual([]);
    });
});

describe("MessageStorage.fromStored", () => {
    it("rehydrates refs into presigned-URL file parts", async () => {
        const stored = await storage.toStored(conversationWithImages());
        const messages = await storage.fromStored(stored);

        const userImage = arrayContent(messages[1])[1];
        expect(userImage).toMatchObject({ type: "file", mediaType: "image/png" });
        expect(fileUrl(userImage)).toContain("https://signed.example/test/images/");
    });

    it("round-trips a conversation with tool calls semantically intact", async () => {
        const original = conversationWithImages();
        const messages = await storage.fromStored(await storage.toStored(original));

        // Non-image parts survive byte-for-byte.
        expect(messages[0]).toEqual(original[0]);
        expect(arrayContent(messages[1])[0]).toEqual({ type: "text", text: "What is on this screen?" });
        expect(arrayContent(messages[2])[0]).toMatchObject({
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "view_frame",
            input: { region: "top" },
        });

        // The frame inside the tool result comes back as a usable image part.
        const frame = toolResultContent(arrayContent(messages[3])[0])[1];
        expect(frame).toMatchObject({ type: "file", mediaType: "image/png" });
        expect(toolResultContent(arrayContent(messages[3])[0])[0]).toEqual({
            type: "text",
            text: "Here is the frame.",
        });
    });

    it("rejects stored JSON that does not match the schema", async () => {
        expect(() => storedMessagesSchema.parse([{ role: "wizard", content: "hi" }])).toThrow();
        expect(() => storedMessagesSchema.parse([{ role: "user" }])).toThrow();
    });

    it("rehydrates a hand-authored stored document (not produced by toStored)", async () => {
        const messages = await storage.fromStored([
            {
                role: "user",
                content: [
                    { type: "text", text: "hi" },
                    { type: "image-ref", key: "test/images/deadbeef", mediaType: "image/png" },
                ],
            },
        ]);

        expect(arrayContent(messages[0])[0]).toEqual({ type: "text", text: "hi" });
        const image = arrayContent(messages[0])[1];
        expect(image).toMatchObject({ type: "file", mediaType: "image/png" });
        expect(fileUrl(image)).toContain("https://signed.example/test/images/deadbeef");
    });

    it("mints signed URLs with the configured TTL", async () => {
        const custom = new MessageStorage({ imageStore: store, keyPrefix: "test/images", signedUrlTtlSeconds: 42 });
        const stored = await custom.toStored([{ role: "user", content: [{ type: "image", image: PNG_BASE64 }] }]);

        const messages = await custom.fromStored(stored);
        expect(fileUrl(arrayContent(messages[0])[0])).toContain("ttl=42");
    });

    // Exercises the real @autonoma/storage provider (no fake), pinning the ImageStore contract so a
    // StorageProvider change breaks here, not at the host's wiring.
    it("round-trips through the real LocalStorageProvider", async () => {
        const local = new LocalStorageProvider(mkdtempSync(join(tmpdir(), "msg-store-")));
        const withLocal = new MessageStorage({ imageStore: local, keyPrefix: "chat/images" });

        const stored = await withLocal.toStored([{ role: "user", content: [{ type: "image", image: PNG_BASE64 }] }]);
        const messages = await withLocal.fromStored(stored);

        const image = arrayContent(messages[0])[0];
        expect(image).toMatchObject({ type: "file", mediaType: "image/png" });
        expect(fileUrl(image)).toMatch(/^file:\/\//);
    });
});

function arrayContent(message: unknown): Array<Record<string, unknown>> {
    if (!isRecord(message)) throw new Error("expected a message object");
    const content = message.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    return content.map((part) => {
        if (!isRecord(part)) throw new Error("expected a part object");
        return part;
    });
}

function toolResultContent(part: Record<string, unknown>): Array<Record<string, unknown>> {
    const output = part.output;
    if (!isRecord(output) || !Array.isArray(output.value)) throw new Error("expected tool-result content output");
    return output.value.map((item) => {
        if (!isRecord(item)) throw new Error("expected a content item object");
        return item;
    });
}

function refKey(part: Record<string, unknown>): string {
    const key = part.key;
    if (typeof key !== "string") throw new Error("expected an image-ref key");
    return key;
}

function fileUrl(part: Record<string, unknown>): string {
    const data = part.data;
    if (!isRecord(data) || !(data.url instanceof URL)) throw new Error("expected a file url part");
    return data.url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}
