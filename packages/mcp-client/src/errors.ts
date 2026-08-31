import { causeMessage } from "@autonoma/errors";

/**
 * The error hierarchy the client throws. One base so a caller can catch every failure with a single
 * `instanceof McpClientError` and narrow from there. Grouped in one file like `@autonoma/errors`.
 */
export class McpClientError extends Error {}

/** The client was misconfigured before it could run - e.g. a required environment value is unset. */
export class McpConfigError extends McpClientError {}

/** The MCP server could not be reached, or returned a non-auth transport error. */
export class McpConnectionError extends McpClientError {
    constructor(cause: unknown) {
        super(`Failed to reach the MCP server: ${causeMessage(cause)}`, { cause });
    }
}

/** The MCP server rejected the presented credential (HTTP 401). */
export class McpAuthError extends McpClientError {
    constructor(message = "The MCP server rejected the credential (401)") {
        super(message);
    }
}

/** A tool ran to completion but reported a failure (`isError: true`); `message` is the tool's own text. */
export class McpToolError extends McpClientError {
    constructor(
        public readonly toolName: string,
        message: string,
    ) {
        super(`MCP tool "${toolName}" reported an error: ${message}`);
    }
}

/** A tool succeeded but its result could not be read: no text content, invalid JSON, or a schema mismatch. */
export class McpResultError extends McpClientError {
    constructor(
        public readonly toolName: string,
        reason: string,
        options?: { cause?: unknown },
    ) {
        super(`MCP tool "${toolName}" returned an unreadable result: ${reason}`, { cause: options?.cause });
    }
}
