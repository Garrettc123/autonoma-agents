import { describe, expect, it } from "vitest";
import { AUTONOMA_MANAGED_ENV_VARS, PREVIEWKIT_BUILTIN_ENV_VARS } from "./previewkit-builtins";
import { previewkitOperationSchema } from "./previewkit-operations";
import { SecretItemSchema } from "./secrets";

describe("SecretItemSchema reserved keys", () => {
    it("accepts a normal key", () => {
        const result = SecretItemSchema.safeParse({ key: "STRIPE_API_KEY", value: "sk_live_x" });
        expect(result.success).toBe(true);
    });

    it("rejects every reserved built-in key with an explanatory message", () => {
        for (const { key } of PREVIEWKIT_BUILTIN_ENV_VARS) {
            const result = SecretItemSchema.safeParse({ key, value: "x" });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0]?.message).toBe(
                    `${key} is a reserved built-in variable and cannot be set.`,
                );
            }
        }
    });

    it("rejects every Autonoma-managed secret key with an explanatory message", () => {
        for (const { key } of AUTONOMA_MANAGED_ENV_VARS) {
            const result = SecretItemSchema.safeParse({ key, value: "x" });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0]?.message).toBe(
                    `${key} is a secret managed by Autonoma and cannot be set.`,
                );
            }
        }
    });
});

/**
 * The operation list is a second write path onto the same table. It used to validate
 * its key with a bare `min(1)` and its value with a bare `z.string()`, so everything
 * the single-secret surface rejects went through it - these assert the two agree.
 */
describe("setSecret operation validation", () => {
    function setSecret(fields: Record<string, unknown>) {
        return previewkitOperationSchema.safeParse({ op: "setSecret", app: "web", ...fields });
    }

    it("accepts a normal key and value", () => {
        expect(setSecret({ key: "STRIPE_API_KEY", value: "sk_live_x" }).success).toBe(true);
    });

    it("rejects an empty value", () => {
        // A stored empty string injects as `KEY=`, which reads as set and carries nothing.
        expect(setSecret({ key: "STRIPE_API_KEY", value: "" }).success).toBe(false);
    });

    it("rejects a key that is not a valid env var name", () => {
        expect(setSecret({ key: "not-an-env-var", value: "x" }).success).toBe(false);
        expect(setSecret({ key: "1LEADING_DIGIT", value: "x" }).success).toBe(false);
    });

    it("rejects every Autonoma-managed secret key", () => {
        // Overwriting the shared secret 401s every signed SDK call, and does so far from
        // the write that caused it.
        for (const { key } of AUTONOMA_MANAGED_ENV_VARS) {
            expect(setSecret({ key, value: "x" }).success).toBe(false);
        }
    });

    it("rejects every reserved built-in key", () => {
        for (const { key } of PREVIEWKIT_BUILTIN_ENV_VARS) {
            expect(setSecret({ key, value: "x" }).success).toBe(false);
        }
    });

    /** Removal keeps format-only checks, matching DeleteSecretInputSchema. */
    it("allows deleting a managed key that somehow got stored", () => {
        const key = AUTONOMA_MANAGED_ENV_VARS[0]!.key;
        expect(previewkitOperationSchema.safeParse({ op: "deleteSecret", app: "web", key }).success).toBe(true);
    });
});
