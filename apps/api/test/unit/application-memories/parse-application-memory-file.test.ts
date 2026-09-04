import { describe, expect, it } from "vitest";
import { parseApplicationMemoryFile } from "../../../src/application-memories/parse-application-memory-file";

const TOAST = `---
title: Checkout toast is transient
description: Read when a success toast disappeared before you could verify it.
---
The checkout success toast auto-dismisses after about three seconds.

## What to do

Seeing it vanish before an assertion is expected behavior, not a bug.
`;

describe("parseApplicationMemoryFile", () => {
    it("takes the slug from the file name, the title and description from the frontmatter, and the body as content", () => {
        expect(parseApplicationMemoryFile("checkout-toast-is-transient.md", TOAST)).toEqual({
            slug: "checkout-toast-is-transient",
            title: "Checkout toast is transient",
            description: "Read when a success toast disappeared before you could verify it.",
            content:
                "The checkout success toast auto-dismisses after about three seconds.\n\n" +
                "## What to do\n\n" +
                "Seeing it vanish before an assertion is expected behavior, not a bug.",
        });
    });

    it("rejects a file name that is not already a slug and says what to rename it to", () => {
        expect(() => parseApplicationMemoryFile("Checkout Toast.md", TOAST)).toThrow(/rename it to checkout-toast\.md/);
    });

    it("rejects a file without frontmatter", () => {
        expect(() => parseApplicationMemoryFile("toast.md", "Just a body.\n")).toThrow(
            /must start with YAML frontmatter/,
        );
    });

    it("rejects a frontmatter key it does not know, rather than silently dropping a typo", () => {
        expect(() =>
            parseApplicationMemoryFile("toast.md", "---\ntitle: Toast\ndescripton: Read when.\n---\nBody.\n"),
        ).toThrow(/toast\.md: .*descripton/);
    });

    it("rejects a memory without a description, because the index has nothing to disclose", () => {
        expect(() => parseApplicationMemoryFile("toast.md", "---\ntitle: Toast\n---\nBody.\n")).toThrow(
            /toast\.md: description/,
        );
    });

    it("rejects a memory with nothing below the frontmatter", () => {
        expect(() =>
            parseApplicationMemoryFile("toast.md", "---\ntitle: Toast\ndescription: Read when.\n---\n\n"),
        ).toThrow(/toast\.md: content/);
    });
});
