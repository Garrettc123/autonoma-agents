import { describe, expect, it } from "vitest";
import { normalizeProtocolVersion } from "../src/schemas/scenarios";

describe("normalizeProtocolVersion", () => {
    it("maps major-version 2 (string or number) to v2, everything else to v1", () => {
        expect(normalizeProtocolVersion("2.0")).toBe("2.0");
        expect(normalizeProtocolVersion(2.0)).toBe("2.0"); // String(2.0) is "2" - must still resolve v2
        expect(normalizeProtocolVersion("2")).toBe("2.0");
        expect(normalizeProtocolVersion("1.0")).toBe("1.0");
        expect(normalizeProtocolVersion(1)).toBe("1.0");
        expect(normalizeProtocolVersion(undefined)).toBe("1.0");
        expect(normalizeProtocolVersion("3.0")).toBe("1.0");
    });
});
