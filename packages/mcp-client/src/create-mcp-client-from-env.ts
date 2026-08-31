import { createMcpClient } from "./create-mcp-client";
import { env } from "./env";
import { McpConfigError } from "./errors";
import type { McpClient } from "./mcp-client";
import { StaticTokenProvider } from "./static-token-provider";

/**
 * Build an `McpClient` from env (`AUTONOMA_API_URL` + `AUTONOMA_API_TOKEN`) with a static service key.
 * Throws if either is unset. For a rotating or per-user credential, inject a `TokenProvider` via
 * `createMcpClient` instead.
 */
export function createMcpClientFromEnv(): McpClient {
    if (env.AUTONOMA_API_URL == null) throw new McpConfigError("AUTONOMA_API_URL is required to build an MCP client");
    if (env.AUTONOMA_API_TOKEN == null)
        throw new McpConfigError("AUTONOMA_API_TOKEN is required to build an MCP client");

    return createMcpClient({
        baseUrl: env.AUTONOMA_API_URL,
        tokenProvider: new StaticTokenProvider(env.AUTONOMA_API_TOKEN),
        timeoutMs: env.MCP_CLIENT_TIMEOUT_MS,
    });
}
