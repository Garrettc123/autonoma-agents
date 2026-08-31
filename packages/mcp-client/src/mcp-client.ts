import { causeMessage } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { McpAuthError, McpClientError, McpConnectionError, McpResultError, McpToolError } from "./errors";

const DEFAULT_TIMEOUT_MS = 30_000;
const CLIENT_NAME = "autonoma-mcp-client";
const CLIENT_VERSION = "0.0.1";
const HTTP_UNAUTHORIZED = 401;

/**
 * The slice of a tool result we read. Validated with Zod because `callTool`'s declared content type
 * erases to `unknown` (a third-party SDK boundary); we only rely on text blocks plus `isError`.
 */
const CALL_TOOL_ENVELOPE = z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    isError: z.boolean().optional(),
});
type CallToolEnvelope = z.infer<typeof CALL_TOOL_ENVELOPE>;

interface McpClientConfig {
    /**
     * Builds the transport per connection - injected so tests use an in-memory pair, production uses
     * Streamable HTTP. Must return a FRESH transport each call: a closed one can't be reused, so a
     * singleton would break reconnect-after-close.
     */
    transportFactory: () => Transport;
    /** Per-request deadline for connect and each tool call. Defaults to 30s. */
    timeoutMs?: number;
    logger?: Logger;
}

/**
 * A typed client over Autonoma's MCP server (`/v1/mcp`): owns one long-lived connection (reused
 * across a chat session's turns), presents an injected bearer credential, and turns each tool call
 * into a Zod-validated value or a typed error.
 *
 * The surface is generic - `callTool(name, args, schema)`, not a wrapper per tool - because the tool
 * schemas live in `apps/api`, which this package must not depend on; the caller owns each schema.
 */
export class McpClient {
    private readonly logger: Logger;
    private readonly timeoutMs: number;
    private client?: Client;
    private connecting?: Promise<Client>;

    constructor(private readonly config: McpClientConfig) {
        this.logger = (config.logger ?? rootLogger).child({ name: this.constructor.name });
        this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /**
     * Open the connection. Idempotent; called automatically by `callTool`/`listTools`. Public only so
     * a caller can front-load the handshake (and surface an auth failure) before its first real call.
     */
    public async connect(): Promise<void> {
        await this.ensureConnected();
    }

    /**
     * Call a tool and return its payload validated against `resultSchema` (the server carries it as a
     * JSON text block, so `T` is real at runtime, not a cast).
     *
     * Throws `McpToolError` (tool reported failure), `McpResultError` (payload missing/non-JSON/off-schema),
     * or `McpAuthError`/`McpConnectionError` (transport). Note some tools report "nothing yet" as a
     * SUCCESS payload (`{ status: "unavailable", reason }`, no `isError`) - model that in `resultSchema`.
     */
    public async callTool<T>(name: string, args: Record<string, unknown>, resultSchema: z.ZodType<T>): Promise<T> {
        const client = await this.ensureConnected();
        this.logger.info("Calling MCP tool", { extra: { tool: name } });

        let result: unknown;
        try {
            result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
        } catch (err) {
            this.logger.error("MCP tool call failed at the transport", toError(err), { extra: { tool: name } });
            throw this.mapTransportError(err);
        }

        return this.parseResult(name, result, resultSchema);
    }

    /** List the tool names the server exposes. Useful as a connectivity/auth smoke check. */
    public async listTools(): Promise<string[]> {
        const client = await this.ensureConnected();
        this.logger.info("Listing MCP tools");
        try {
            const { tools } = await client.listTools(undefined, { timeout: this.timeoutMs });
            this.logger.info("Listed MCP tools", { extra: { count: tools.length } });
            return tools.map((tool) => tool.name);
        } catch (err) {
            this.logger.error("MCP listTools failed at the transport", toError(err));
            throw this.mapTransportError(err);
        }
    }

    /** Close the connection and release the transport. Idempotent; safe to call in a `finally`. */
    public async close(): Promise<void> {
        // A connect may still be in flight; wait for it to settle first, otherwise the handshake
        // completes after this returns and leaves a live connection the caller believed was closed.
        if (this.connecting != null) await this.connecting.catch(() => undefined);
        if (this.client == null) return;
        this.logger.info("Closing MCP client");
        try {
            await this.client.close();
        } catch (err) {
            this.logger.warn("Error while closing MCP client", { extra: { err: causeMessage(err) } });
        } finally {
            this.client = undefined;
        }
    }

    private async ensureConnected(): Promise<Client> {
        if (this.client != null) return this.client;
        // Memoize the in-flight handshake so concurrent first calls share one connection instead of
        // each leaking its own transport. Cleared once settled so a later call can reconnect.
        this.connecting ??= this.openConnection();
        try {
            this.client = await this.connecting;
            return this.client;
        } finally {
            this.connecting = undefined;
        }
    }

    private async openConnection(): Promise<Client> {
        this.logger.info("Connecting to MCP server");
        const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
        try {
            await client.connect(this.config.transportFactory(), { timeout: this.timeoutMs });
        } catch (err) {
            this.logger.error("Failed to connect to MCP server", toError(err));
            throw this.mapTransportError(err);
        }
        this.logger.info("Connected to MCP server");
        return client;
    }

    private parseResult<T>(name: string, rawResult: unknown, resultSchema: z.ZodType<T>): T {
        const parsedEnvelope = CALL_TOOL_ENVELOPE.safeParse(rawResult);
        if (!parsedEnvelope.success) {
            throw new McpResultError(name, "the server returned an unrecognized result envelope", {
                cause: parsedEnvelope.error,
            });
        }
        const envelope = parsedEnvelope.data;

        if (envelope.isError === true) {
            const message = firstText(envelope) ?? "unknown tool error";
            this.logger.warn("MCP tool returned an error result", { extra: { tool: name, message } });
            throw new McpToolError(name, message);
        }

        const text = firstText(envelope);
        if (text == null) throw new McpResultError(name, "no text content block in the result");

        const payload = parseJson(text);
        if (!payload.ok) throw new McpResultError(name, "result text was not valid JSON", { cause: payload.error });

        const validated = resultSchema.safeParse(payload.value);
        if (!validated.success) {
            this.logger.warn("MCP tool result failed schema validation", {
                extra: { tool: name, issues: validated.error.issues },
            });
            throw new McpResultError(
                name,
                `result did not match the expected schema: ${z.prettifyError(validated.error)}`,
            );
        }

        this.logger.info("MCP tool call succeeded", { extra: { tool: name } });
        return validated.data;
    }

    private mapTransportError(err: unknown): McpClientError {
        if (err instanceof McpClientError) return err;
        // Only 401 is singled out: the server rejects every bad credential with 401, so anything else
        // (403, other status, network failure) is a connection error.
        if (err instanceof StreamableHTTPError && err.code === HTTP_UNAUTHORIZED) return new McpAuthError();
        return new McpConnectionError(err);
    }
}

/** The text of the first text content block, if any. */
function firstText(envelope: CallToolEnvelope): string | undefined {
    for (const block of envelope.content) {
        if (block.type === "text" && block.text != null) return block.text;
    }
    return undefined;
}

type JsonParse = { ok: true; value: unknown } | { ok: false; error: unknown };

function parseJson(text: string): JsonParse {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (error) {
        return { ok: false, error };
    }
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(causeMessage(err));
}
