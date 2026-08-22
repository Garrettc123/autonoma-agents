import { z } from "zod";
import { isManagedPreviewkitEnvKey, isReservedPreviewkitEnvKey } from "./previewkit-builtins";

const SECRET_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Mirrors the k8sNameRegex in apps/previewkit/src/config/schema.ts. Secret
// bundles are scoped to the same app names that appear in the preview config.
const APP_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const SecretKeySchema = z
    .string()
    .min(1)
    .max(256)
    .regex(
        SECRET_KEY_REGEX,
        "Keys must start with a letter or underscore and contain only letters, numbers, and underscores",
    );

export const AppNameSchema = z
    .string()
    .min(2)
    .max(63)
    .regex(APP_NAME_REGEX, "App name must be lowercase alphanumeric with hyphens (Kubernetes label-compatible)");

/**
 * A key a USER may set: a valid env-var name that is neither a Previewkit built-in
 * nor an Autonoma-managed secret.
 *
 * Exported so every write path asks the same question. Previewkit injects the
 * built-ins and owns the managed secrets, so letting one be overwritten does not
 * fail loudly - it 401s every signed SDK call afterwards, far from the write.
 */
export const SettableSecretKeySchema = SecretKeySchema.superRefine((key, ctx) => {
    if (isReservedPreviewkitEnvKey(key)) {
        ctx.addIssue({
            code: "custom",
            message: `${key} is a reserved built-in variable and cannot be set.`,
        });
    } else if (isManagedPreviewkitEnvKey(key)) {
        ctx.addIssue({
            code: "custom",
            message: `${key} is a secret managed by Autonoma and cannot be set.`,
        });
    }
});

/**
 * A secret value. Empty is rejected: a stored empty string injects as `KEY=`, which
 * satisfies a "is it set?" check while carrying nothing, so it fails further from the
 * cause than an absent key would.
 */
export const SecretValueSchema = z.string().min(1).max(65536);

export const SecretItemSchema = z.object({
    key: SettableSecretKeySchema,
    value: SecretValueSchema,
    /**
     * Whether the build gets this value as a Docker build arg, on top of the runtime
     * environment. Omitted leaves an existing key's setting alone rather than clearing
     * it, so a caller sending only a new value cannot turn it off by accident; a key
     * that does not exist yet defaults to build-time, because a build that cannot see
     * a value it needs fails obscurely. Pass `false` for a value the image must not
     * carry.
     */
    buildTime: z.boolean().optional(),
});
export type SecretItem = z.infer<typeof SecretItemSchema>;

export const ListSecretAppsInputSchema = z.object({
    applicationId: z.string(),
});
export type ListSecretAppsInput = z.infer<typeof ListSecretAppsInputSchema>;

export const ListSecretsInputSchema = z.object({
    applicationId: z.string(),
    appName: AppNameSchema,
});
export type ListSecretsInput = z.infer<typeof ListSecretsInputSchema>;

export const UpsertSecretsInputSchema = z.object({
    applicationId: z.string(),
    appName: AppNameSchema,
    items: z.array(SecretItemSchema).min(1).max(200),
});
export type UpsertSecretsInput = z.infer<typeof UpsertSecretsInputSchema>;

export const SetSecretBuildTimeInputSchema = z.object({
    applicationId: z.string(),
    appName: AppNameSchema,
    key: SecretKeySchema,
    buildTime: z.boolean(),
});
export type SetSecretBuildTimeInput = z.infer<typeof SetSecretBuildTimeInputSchema>;

export const DeleteSecretInputSchema = z.object({
    applicationId: z.string(),
    appName: AppNameSchema,
    key: SecretKeySchema,
});
export type DeleteSecretInput = z.infer<typeof DeleteSecretInputSchema>;

export type SecretSummary = {
    key: string;
    maskedLength: number;
    updatedAt: Date;
    /** Whether the build gets this value as a build arg, not just the running app. */
    buildTime: boolean;
    /**
     * The first 12 hex chars of SHA-256 of the value - a non-reversible fingerprint
     * for checking whether a value MATCHES a candidate you already hold, without
     * exposing the value. Recompute it as `sha256(value).hex.slice(0, 12)` and
     * compare. Undefined when the value is unavailable.
     */
    fingerprint?: string;
};

// Per-app secret changes batched alongside a preview-config save, so the editor
// can persist envs (config revision) and secrets (AWS Secrets Manager) in one
// "Save config" call. `upserts` reuse SecretItemSchema (reserved keys rejected);
// `deletes` are keys removed from the app's bundle.
export const PreviewkitConfigAppSecretsSchema = z.object({
    appName: AppNameSchema,
    upserts: z.array(SecretItemSchema).max(200).default([]),
    deletes: z.array(SecretKeySchema).max(200).default([]),
    /**
     * Keys whose build-time flag alone changed. Separate from `upserts` because the
     * editor holds no value for an already-stored secret, so it cannot express the
     * change as a write of the whole item.
     */
    buildTimeChanges: z
        .array(z.object({ key: SecretKeySchema, buildTime: z.boolean() }))
        .max(200)
        .default([]),
});
export type PreviewkitConfigAppSecrets = z.infer<typeof PreviewkitConfigAppSecretsSchema>;

export const PreviewkitConfigSecretsSchema = z.array(PreviewkitConfigAppSecretsSchema).max(50);
export type PreviewkitConfigSecrets = z.infer<typeof PreviewkitConfigSecretsSchema>;
