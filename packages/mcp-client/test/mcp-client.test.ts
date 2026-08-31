import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpResultError, McpToolError } from "../src/errors";
import { McpClient } from "../src/mcp-client";
import { buildFakeMcpServer } from "./fake-mcp-server";

/**
 * Wrapper-logic tests over an in-memory transport. These prove result parsing, schema validation,
 * and tool-error mapping without a network; the HTTP transport and the auth path are proven
 * separately in `mcp-client-http.test.ts`.
 */

const statusSchema = z.object({ status: z.string(), prNumber: z.number() });

let server: McpServer | undefined;
let client: McpClient | undefined;

async function connectedClient(): Promise<McpClient> {
    server = buildFakeMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ transportFactory: () => clientTransport });
    await Promise.all([server.connect(serverTransport), mcpClient.connect()]);
    client = mcpClient;
    return mcpClient;
}

afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
});

describe("McpClient", () => {
    it("returns a validated payload for a successful tool call", async () => {
        const mcp = await connectedClient();

        const result = await mcp.callTool("echo_status", { prNumber: 42 }, statusSchema);

        expect(result).toEqual({ status: "started", prNumber: 42 });
    });

    it("lists the server's tools", async () => {
        const mcp = await connectedClient();

        const tools = await mcp.listTools();

        expect(tools).toContain("echo_status");
        expect(tools).toContain("always_fails");
    });

    it("throws McpToolError carrying the tool's message when the tool reports a failure", async () => {
        const mcp = await connectedClient();

        await expect(mcp.callTool("always_fails", {}, z.object({}))).rejects.toThrowError(McpToolError);
        await expect(mcp.callTool("always_fails", {}, z.object({}))).rejects.toThrow("the tool exploded");
    });

    it("throws McpResultError when the payload is not valid JSON", async () => {
        const mcp = await connectedClient();

        await expect(mcp.callTool("not_json", {}, z.object({}))).rejects.toThrowError(McpResultError);
    });

    it("throws McpResultError when the payload does not match the schema", async () => {
        const mcp = await connectedClient();
        const wrongSchema = z.object({ status: z.number() });

        await expect(mcp.callTool("echo_status", { prNumber: 1 }, wrongSchema)).rejects.toThrowError(McpResultError);
    });

    it("connect is idempotent", async () => {
        const mcp = await connectedClient();

        await expect(mcp.connect()).resolves.toBeUndefined();
    });

    it("opens a single connection when the first calls race", async () => {
        server = buildFakeMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        let transportBuilds = 0;
        const mcp = new McpClient({
            transportFactory: () => {
                transportBuilds++;
                return clientTransport;
            },
        });
        await server.connect(serverTransport);
        client = mcp;

        await Promise.all([mcp.connect(), mcp.connect(), mcp.listTools()]);

        expect(transportBuilds).toBe(1);
    });

    it("tears down the connection an in-flight connect opens, even when close races it", async () => {
        let builds = 0;
        const servers: McpServer[] = [];
        const mcp = new McpClient({
            transportFactory: () => {
                builds++;
                const fake = buildFakeMcpServer();
                servers.push(fake);
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                void fake.connect(serverTransport);
                return clientTransport;
            },
        });
        client = mcp;

        const connecting = mcp.connect();
        await mcp.close();
        await connecting;

        // Had close let the raced connection survive, this call would reuse it (builds stays 1).
        // Because close tore it down, the client must open a fresh connection instead.
        const result = await mcp.callTool("echo_status", { prNumber: 5 }, statusSchema);

        expect(result).toEqual({ status: "started", prNumber: 5 });
        expect(builds).toBe(2);

        await Promise.all(servers.map((fake) => fake.close()));
    });
});
