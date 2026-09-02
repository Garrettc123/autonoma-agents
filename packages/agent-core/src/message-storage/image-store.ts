/**
 * The two blob-store operations this seam needs. `@autonoma/storage`'s `S3Storage` satisfies it
 * structurally (its `Buffer` arg is a `Uint8Array`), so the host injects the real client and a test
 * injects a fake - keeping the AWS SDK out of `@autonoma/agent-core`.
 */
export interface ImageStore {
    /**
     * Upload `data` under `key`. The seam's ref is `key` itself, so any return value is ignored -
     * `Promise<unknown>` lets a store that returns a locator (`S3Storage`, `LocalStorageProvider`) fit.
     */
    upload(key: string, data: Uint8Array, contentType?: string): Promise<unknown>;

    /** Mint a presigned read URL for `key`, valid for `expiresInSeconds`. */
    getSignedUrl(key: string, expiresInSeconds: number, responseContentType?: string): Promise<string>;
}
