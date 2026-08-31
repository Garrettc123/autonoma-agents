import { afterAll, describe, expect, it } from "vitest";
import { createMcpClient } from "../src/create-mcp-client";
import type { McpClient } from "../src/mcp-client";
import { StaticTokenProvider } from "../src/static-token-provider";

/**
 * Opt-in smoke test against the REAL `/v1/mcp` - the only test that proves the real handshake, auth,
 * and result shape (the other suites use a fake server). Skipped unless `AUTONOMA_API_URL` and
 * `AUTONOMA_API_TOKEN` are set, so it never runs in CI. Read-only (`listTools`); mutates nothing.
 *
 *   AUTONOMA_API_URL=https://api.autonoma.app AUTONOMA_API_TOKEN=<org-key> \
 *     pnpm --filter @autonoma/mcp-client test mcp-client-live
 */

const baseUrl = process.env["AUTONOMA_API_URL"];
const token = process.env["AUTONOMA_API_TOKEN"];
const configured = baseUrl != null && token != null;

let client: McpClient | undefined;

afterAll(async () => {
    await client?.close();
});

describe.skipIf(!configured)("McpClient against the live MCP server", () => {
    it("authenticates and lists the server's tools", async () => {
        if (baseUrl == null || token == null) throw new Error("unreachable: guarded by skipIf");
        client = createMcpClient({ baseUrl, tokenProvider: new StaticTokenProvider(token) });

        const tools = await client.listTools();
        // eslint-disable-next-line no-console
        console.log(`Live MCP server exposed ${tools.length} tools:`, tools.join(", "));

        expect(tools.length).toBeGreaterThan(0);
    });
});
