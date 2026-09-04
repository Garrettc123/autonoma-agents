import { describe, expect, it } from "vitest";
import { renderApplicationMemoryIndex } from "./application-memory-index";

const TOAST = {
    slug: "checkout-toast-is-transient",
    title: "Checkout toast is transient",
    description: "Read when a success toast disappeared before you could verify it.",
};
const SKELETON = {
    slug: "dashboard-loads-with-skeletons",
    title: "Dashboard loads with skeletons",
    description: "Read when the dashboard shows grey placeholder blocks.",
};

describe("renderApplicationMemoryIndex", () => {
    it("lists each memory as `slug - title: description`", () => {
        const index = renderApplicationMemoryIndex([TOAST, SKELETON]);

        expect(index).toContain(`- ${TOAST.slug} - ${TOAST.title}: ${TOAST.description}`);
        expect(index).toContain(`- ${SKELETON.slug} - ${SKELETON.title}: ${SKELETON.description}`);
    });

    it("renders no section at all for no memories - the control arm must see the prompt it sees today", () => {
        expect(renderApplicationMemoryIndex([])).toBeUndefined();
    });

    it("is stable across input order, so two runs over the same rows produce the same prompt", () => {
        const forward = renderApplicationMemoryIndex([TOAST, SKELETON]);
        const reversed = renderApplicationMemoryIndex([SKELETON, TOAST]);

        expect(reversed).toBe(forward);
        expect(forward?.indexOf(TOAST.slug)).toBeLessThan(forward?.indexOf(SKELETON.slug) ?? -1);
    });
});
