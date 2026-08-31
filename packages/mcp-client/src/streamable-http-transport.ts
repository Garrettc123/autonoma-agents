import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TokenProvider } from "./token-provider";

interface StreamableHttpTransportOptions {
    /** Full URL of the MCP endpoint, e.g. `https://api.autonoma.app/v1/mcp`. */
    url: URL;
    tokenProvider: TokenProvider;
}

/**
 * The over-the-wire transport, with the bearer token stamped on every request. Uses a `fetch`
 * wrapper rather than static `requestInit.headers` so the token is read fresh per request (a
 * rotating token works without rebuilding) and is never held on a long-lived object. SDK headers
 * are preserved; we only add `authorization`.
 */
export function createStreamableHttpTransport({ url, tokenProvider }: StreamableHttpTransportOptions): Transport {
    const fetchWithAuth: FetchLike = async (input, init) => {
        const token = await tokenProvider.getToken();
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
    };

    return new StreamableHTTPClientTransport(url, { fetch: fetchWithAuth });
}
