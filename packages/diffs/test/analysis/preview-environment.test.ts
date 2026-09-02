import { describe, expect, it } from "vitest";
import { PreviewEnvironment } from "../../src/analysis/preview/preview-environment";

function secretsWith(values: Record<string, string>) {
    return {
        getEnvVarNames: async () => Object.keys(values),
        getEnvValues: async () => values,
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

describe("PreviewEnvironment.runScript", () => {
    it("surfaces the connection caveat on FAILURE, so an absent per-PR DATABASE_URL is not read as 'record missing'", async () => {
        const env = new PreviewEnvironment(secretsWith({}), "app-1", ["DATABASE_URL"]);
        // Mirror the real scripts: read DATABASE_URL and, as pg does with no URL, fail to connect to localhost.
        const script =
            'if (process.env.DATABASE_URL == null) { console.error("connect ECONNREFUSED ::1:5432"); process.exit(1); }';

        const error = await env.runScript({ script }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect(messageOf(error)).toContain("DATABASE_URL");
        expect(messageOf(error)).toContain("NOT available here");
        expect(messageOf(error)).toContain("ECONNREFUSED");
    });

    it("prepends the caveat to SUCCESSFUL output when a connection var is absent here", async () => {
        const env = new PreviewEnvironment(secretsWith({}), "app-1", ["DATABASE_URL"]);

        const output = await env.runScript({ script: 'console.log("row-found");' });

        expect(output).toContain("Environment caveat");
        expect(output).toContain("row-found");
    });

    it("leaves a genuine failure untouched when there is no connection gap", async () => {
        const env = new PreviewEnvironment(secretsWith({ DATABASE_URL: "postgres://x" }), "app-1", []);
        const script = 'console.error("SyntaxError: bad import"); process.exit(1);';

        const error = await env.runScript({ script }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect(messageOf(error)).toContain("SyntaxError: bad import");
        expect(messageOf(error)).not.toContain("Environment caveat");
    });
});
