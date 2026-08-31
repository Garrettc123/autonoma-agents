import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpClient } from "../src/create-mcp-client";
import { McpAuthError, McpToolError } from "../src/errors";
import type { McpClient } from "../src/mcp-client";
import { StaticTokenProvider } from "../src/static-token-provider";
import { buildFakeMcpServer } from "./fake-mcp-server";

/**
 * The auth + HTTP transport + parsing boundary, proven over a real socket. A minimal stateless
 * MCP-over-HTTP server (fresh server per request, as `apps/api` does) checks the bearer token; the
 * real `StreamableHTTPClientTransport` drives it - exercising header injection, the 401 path, and
 * envelope parsing without depending on `apps/api` or a database.
 */

const VALID_TOKEN = "test-service-key";
const statusSchema = z.object({ status: z.string(), prNumber: z.number() });

let httpServer: Server;
let baseUrl: string;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${VALID_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
    }

    const body = await readJsonBody(req);
    const server = buildFakeMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
}

function clientWithToken(token: string): McpClient {
    return createMcpClient({ baseUrl, tokenProvider: new StaticTokenProvider(token) });
}

beforeAll(async () => {
    httpServer = createServer((req, res) => {
        void handle(req, res).catch((err) => {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(err));
        });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo = getAddress(httpServer);
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => httpServer.close((err) => (err != null ? reject(err) : resolve())));
});

describe("McpClient over HTTP", () => {
    it("authenticates and returns a validated tool result", async () => {
        const client = clientWithToken(VALID_TOKEN);
        try {
            const result = await client.callTool("echo_status", { prNumber: 7 }, statusSchema);
            expect(result).toEqual({ status: "started", prNumber: 7 });
        } finally {
            await client.close();
        }
    });

    it("throws McpAuthError when the credential is rejected (401)", async () => {
        const client = clientWithToken("wrong-token");
        try {
            await expect(client.callTool("echo_status", { prNumber: 1 }, statusSchema)).rejects.toThrowError(
                McpAuthError,
            );
        } finally {
            await client.close();
        }
    });

    it("maps a tool failure to McpToolError over the wire", async () => {
        const client = clientWithToken(VALID_TOKEN);
        try {
            await expect(client.callTool("always_fails", {}, z.object({}))).rejects.toThrowError(McpToolError);
        } finally {
            await client.close();
        }
    });
});

function getAddress(server: Server): AddressInfo {
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("expected a TCP address");
    return address;
}
