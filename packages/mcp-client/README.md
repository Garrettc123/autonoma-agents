# @autonoma/mcp-client

A small, typed client for calling **Autonoma's own MCP server** (`/v1/mcp`) from our services. It owns one authenticated MCP connection, calls tools, and returns Zod-validated results or typed errors. It is the foundation for the out-of-process PR-steering chat agent, which talks to the backend as an MCP client rather than re-implementing those calls.

The package depends only on the MCP SDK, Zod, `@autonoma/logger`, and `@autonoma/errors` - **not** on `apps/api` - so `packages/steering` and other callers can consume it freely.

## Exports

| Export                     | Description                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `McpClient`                | The client: owns one connection, `callTool(name, args, schema)`, `listTools()`, `close()`.    |
| `createMcpClient`          | Build a client over HTTP from a base URL + a `TokenProvider`.                                  |
| `createMcpClientFromEnv`   | Build a client from `AUTONOMA_API_URL` + `AUTONOMA_API_TOKEN` (static service key).            |
| `TokenProvider`            | Interface supplying the bearer credential, read fresh per request.                            |
| `StaticTokenProvider`      | A `TokenProvider` that always presents the same key.                                          |
| `createStreamableHttpTransport` | The default transport factory (Streamable HTTP + bearer injection). Rarely needed directly. |
| `McpClientError` (+ subtypes) | The typed error hierarchy - see below.                                                      |

`@autonoma/mcp-client/env` exposes the validated environment config.

## Usage

```ts
import { createMcpClient, StaticTokenProvider, McpAuthError } from "@autonoma/mcp-client";
import { z } from "zod";

const client = createMcpClient({
    baseUrl: "https://api.autonoma.app",
    tokenProvider: new StaticTokenProvider(serviceKey),
});

const sendResult = z.object({ status: z.enum(["started", "deferred", "refused"]), message: z.string() });

try {
    const result = await client.callTool(
        "send_analysis_message",
        { repoFullName: "acme/web", prNumber: 42, message: "Focus on the checkout flow" },
        sendResult,
    );
    console.log(result.status); // typed and validated at runtime
} finally {
    await client.close();
}
```

The connection opens lazily on the first call and is reused across calls - a long-lived caller (a chat session) constructs one `McpClient` and reuses it, then `close()`s it when the session ends.

## Errors

Every failure is a subclass of `McpClientError`, so a caller can branch with one `instanceof` and narrow:

| Error                | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `McpConfigError`     | The client was misconfigured (e.g. a required env var is unset).          |
| `McpConnectionError` | Could not reach the server, or a non-auth transport error.                |
| `McpAuthError`       | The server rejected the credential (HTTP 401).                            |
| `McpToolError`       | The tool ran but reported a failure (`isError: true`); carries its text.  |
| `McpResultError`     | The tool succeeded but its payload was missing, non-JSON, or off-schema.  |

Some tools report "nothing to act on yet" as a **success** payload rather than a thrown error - the server's `unavailableResult` shape, `{ status: "unavailable", reason }`, with no `isError`. For a tool that emits it, model that branch in your `resultSchema` (e.g. a discriminated union on `status`) so it validates instead of surfacing as an `McpResultError`.

## Auth / identity

The client presents an injected bearer credential (`TokenProvider`), which the server verifies via `verifyApiKey` and scopes to the key's organization. The token is read **fresh per request**, so a rotating credential works without reconnecting.

Which identity a caller presents - a per-org service key vs. an acting-user token - is a product decision deferred to the caller: inject the appropriate `TokenProvider`. `createMcpClientFromEnv` wires the static-service-key case.

## Configuration

| Variable                | Required | Description                                             |
| ----------------------- | -------- | ------------------------------------------------------- |
| `AUTONOMA_API_URL`      | for `createMcpClientFromEnv` | API base URL; `/v1/mcp` is appended. |
| `AUTONOMA_API_TOKEN`    | for `createMcpClientFromEnv` | Bearer service key.                  |
| `MCP_CLIENT_TIMEOUT_MS` | no       | Per-request deadline. Defaults to 30000.               |

## Testing

- `test/mcp-client.test.ts` - wrapper logic (result parsing, schema validation, tool-error mapping) over an in-memory transport against a fake server that reproduces the real result envelope.
- `test/mcp-client-http.test.ts` - the auth + HTTP transport + parsing boundary, end to end: the real `StreamableHTTPClientTransport` against a minimal SDK-based HTTP server that checks the bearer token. This proves the risky integration boundary without depending on `apps/api` or a database (the client has neither).

```bash
pnpm --filter @autonoma/mcp-client test
```
