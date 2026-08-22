import type { SecretSummary } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { computeSecretStatus } from "../../src/previewkit/previewkit-secret-status.service";

/** A stored-secret summary; the value/length are opaque to these tests. */
function stored(key: string, buildTime = false, maskedLength = 8): SecretSummary {
    return { key, maskedLength, buildTime, updatedAt: new Date("2026-07-08T00:00:00.000Z") };
}

describe("computeSecretStatus", () => {
    it("reports each stored secret's build-time-ness, sorted by key", () => {
        const status = computeSecretStatus([stored("SESSION_SECRET", false, 16), stored("API_KEY", true, 32)]);

        expect(status).toEqual([
            { key: "API_KEY", present: true, maskedLength: 32, fingerprint: undefined, buildTime: true },
            { key: "SESSION_SECRET", present: true, maskedLength: 16, fingerprint: undefined, buildTime: false },
        ]);
    });

    /**
     * The flag lives on the value, so a key the build needs but nobody has supplied
     * has no row and cannot be reported. This is the diagnostic the previous model
     * had and this one does not; the test states it so the loss stays deliberate
     * rather than being rediscovered as a bug.
     */
    it("cannot report a build-time key that has no stored value", () => {
        expect(computeSecretStatus([])).toEqual([]);
    });

    it("never exposes a value - only presence, masked length, fingerprint, and build-time-ness", () => {
        const [entry] = computeSecretStatus([stored("TOKEN", true, 40)]);
        expect(Object.keys(entry ?? {})).toEqual(["key", "present", "maskedLength", "fingerprint", "buildTime"]);
    });

    it("carries the fingerprint of a stored secret so a value can be compared without exposure", () => {
        const summary: SecretSummary = {
            key: "TOKEN",
            maskedLength: 40,
            buildTime: false,
            updatedAt: new Date(),
            fingerprint: "abc123def456",
        };
        const [entry] = computeSecretStatus([summary]);
        expect(entry?.fingerprint).toBe("abc123def456");
    });
});
