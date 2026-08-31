import { McpClient } from "./mcp-client";
import { createStreamableHttpTransport } from "./streamable-http-transport";
import type { TokenProvider } from "./token-provider";

/** Path the MCP server is mounted at, relative to the API base URL. Matches `apps/api` (`/v1/mcp`). */
const MCP_PATH = "/v1/mcp";

interface CreateMcpClientOptions {
    /** API base URL, e.g. `https://api.autonoma.app`. The MCP path is appended. */
    baseUrl: string;
    tokenProvider: TokenProvider;
    timeoutMs?: number;
}

/** Build an `McpClient` that talks to Autonoma's MCP server over HTTP with the given credential. */
export function createMcpClient({ baseUrl, tokenProvider, timeoutMs }: CreateMcpClientOptions): McpClient {
    const url = new URL(MCP_PATH, baseUrl);
    return new McpClient({
        transportFactory: () => createStreamableHttpTransport({ url, tokenProvider }),
        timeoutMs,
    });
}
