import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * A stand-in for Autonoma's MCP server, reproducing its result envelope (JSON text block on success,
 * `isError: true` on failure - see `apps/api/src/mcp/tool-result.ts`). Enough tools to cover every
 * branch of the client's result handling; SDK-only, so both the in-memory and HTTP tests reuse it.
 */
export function buildFakeMcpServer(): McpServer {
    const server = new McpServer({ name: "fake-autonoma", version: "0.0.0" });

    server.registerTool(
        "echo_status",
        { description: "Return a JSON payload echoing the input.", inputSchema: { prNumber: z.number() } },
        ({ prNumber }) => ({
            content: [{ type: "text", text: JSON.stringify({ status: "started", prNumber }) }],
        }),
    );

    server.registerTool("always_fails", { description: "Return an error result." }, () => ({
        content: [{ type: "text", text: "the tool exploded" }],
        isError: true,
    }));

    server.registerTool("not_json", { description: "Return a non-JSON text block." }, () => ({
        content: [{ type: "text", text: "this is not json {" }],
    }));

    return server;
}
