import type { ApplicationMemory } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildClassifierPrompt } from "../src/analysis/classify/prompt";
import type { ClassifierInput } from "../src/analysis/classify/types";
import { Codebase } from "../src/codebase";
import { whiteScreenshot } from "./screenshot-fixture";

const memories: ApplicationMemory[] = [
    {
        slug: "checkout-toast-is-transient",
        title: "Checkout success toast is transient",
        description: "The green 'Order placed' toast disappears after ~3s.",
        content: "After a successful checkout the toast auto-dismisses. Its absence later is not a failure.",
    },
];

function makeClassifierInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
    return {
        appSlug: "acme-bank",
        target: { kind: "main_branch", branchName: "main" },
        test: { slug: "checkout", plan: "Buy something.", affectedReason: "The checkout page changed." },
        provision: { status: "ready", detail: "Auth and data were seeded." },
        diffSummary: "1 file changed",
        memories: [],
        codebase: new Codebase(process.cwd()),
        baseSha: "aaaa",
        headSha: "bbbb",
        run: {
            success: true,
            finishReason: "success",
            stepCount: 0,
            steps: [],
            startEpoch: 0,
            endEpoch: 1,
            inspectableSteps: [],
        },
        screenshotLoader: { loadScreenshot: () => whiteScreenshot() },
        loadBaseline: async () => "(no prior runs)",
        ...overrides,
    };
}

describe("buildClassifierPrompt - app memories", () => {
    it("injects the App memories index, its framing, and the read_memory instruction when memories exist", () => {
        const prompt = buildClassifierPrompt({ input: makeClassifierInput({ memories }) });

        expect(prompt).toContain("## App memories");
        expect(prompt).toContain("EXPECTED to behave");
        expect(prompt).toContain("checkout-toast-is-transient - Checkout success toast is transient");
        expect(prompt).toContain("read_memory");
        // Only the one-line index entry leaks - the full content stays behind the tool.
        expect(prompt).not.toContain("auto-dismisses");
    });

    it("renders no App memories section when the application has no memories", () => {
        const prompt = buildClassifierPrompt({ input: makeClassifierInput({ memories: [] }) });

        expect(prompt).not.toContain("## App memories");
        expect(prompt).not.toContain("read_memory");
    });
});
