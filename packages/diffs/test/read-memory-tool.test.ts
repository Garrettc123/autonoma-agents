import type { ApplicationMemory } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { ReadMemoryTool, buildReadMemoryTools } from "../src/agents/tools/lookup/read-memory-tool";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeDiffsLoop } from "./test-loops";

const memories: ApplicationMemory[] = [
    {
        slug: "checkout-toast-is-transient",
        title: "Checkout success toast is transient",
        description: "The green 'Order placed' toast disappears after ~3s.",
        content: "After a successful checkout the toast auto-dismisses. Its absence later is not a failure.",
    },
    {
        slug: "login-otp-optional",
        title: "OTP step is optional in staging",
        description: "Staging skips the one-time-password screen.",
        content: "In staging the login flow goes straight to the dashboard; do not wait for an OTP field.",
    },
];

type ReadResult = { title: string; content: string };

// The tool reads off its own constructor-held list, so any loop satisfies the executeTool plumbing.
const anyLoop = makeDiffsLoop();

describe("read_memory tool", () => {
    it("returns the title and full content for a known slug", async () => {
        const tool = new ReadMemoryTool(memories, "ClassifierAgent");

        const result = await executeTool<ToolEnvelope<ReadResult>>(
            tool,
            { slug: "checkout-toast-is-transient" },
            anyLoop,
        );

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.result).toEqual({
            title: "Checkout success toast is transient",
            content: "After a successful checkout the toast auto-dismisses. Its absence later is not a failure.",
        });
    });

    it("fails through the error channel with a fix suggestion for an unknown slug", async () => {
        const tool = new ReadMemoryTool(memories, "ClassifierAgent");

        const result = await executeTool<ToolEnvelope<ReadResult>>(tool, { slug: "made-up" }, anyLoop);

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("made-up");
        expect(result.error).toContain("not found");
        expect(result.fixSuggestion).toContain("App memories");
    });
});

describe("buildReadMemoryTools gating", () => {
    it("registers the read_memory tool when the application has enabled memories", () => {
        const tools = buildReadMemoryTools(memories, "ClassifierAgent");

        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("read_memory");
    });

    it("registers no tool when there are no memories, so the tool set is unchanged", () => {
        expect(buildReadMemoryTools([], "ClassifierAgent")).toHaveLength(0);
    });
});
