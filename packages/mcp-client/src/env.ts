import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * All optional so importing this package never fails a host that does not use the client;
 * `createMcpClientFromEnv` enforces presence. Names reuse the CLI's (`apps/cli/src/env.ts`).
 */
export const env = createEnv({
    server: {
        AUTONOMA_API_URL: z.url().optional(),
        AUTONOMA_API_TOKEN: z.string().min(1).optional(),
        MCP_CLIENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env["VITEST"] != null,
});
