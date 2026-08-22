import { type PrismaClient, previewkitConfigRowsInclude } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { documentFromPreviewkitConfigRows, type SecretSummary, trustedPreviewConfigSchema } from "@autonoma/types";
import type { PreviewkitSecretsService } from "./previewkit-secrets.service";

/** Health of one secret key for one app: present in the bundle and/or declared as a build secret. */
export interface SecretStatusEntry {
    key: string;
    /** A value is registered in AWS Secrets Manager for this key. */
    present: boolean;
    /** Masked length (never the value); present only when the key exists. */
    maskedLength?: number;
    /**
     * Non-reversible fingerprint (first 12 hex of SHA-256 of the value) for checking
     * whether the set value matches one you hold, without exposing it. Present only
     * when the key exists. Recompute as `sha256(value).hex.slice(0, 12)` to compare.
     */
    fingerprint?: string;
    /** The build gets this value as a build arg, on top of the runtime environment. */
    buildTime: boolean;
}

/** One topology-wired env var: a non-secret value that is a template resolved at deploy time. */
export interface ConnectionEntry {
    key: string;
    /** Template value (e.g. "{{db.url}}"); non-secret, resolved from the topology at deploy - shown as-is. */
    value: string;
    /** Also passed as a Docker build arg (needed at build time, not just runtime). */
    buildTime: boolean;
}

export interface AppSecretStatus {
    appName: string;
    /**
     * The env-var surface for this app, so an agent sees the variables it may need to
     * change: `connections` are topology-wired vars (non-secret template values, shown
     * as-is); `secrets` are the values that are set, with masked length and build-time-
     * ness but never a value.
     *
     * Complete only in what EXISTS. A variable the app needs and nobody has set has no
     * row to report, so absence here is not evidence the app does not need it.
     */
    connections: ConnectionEntry[];
    secrets: SecretStatusEntry[];
}

export interface SecretStatusResult {
    applicationId: string;
    /** False when the application has no saved preview config yet (apps is then empty). */
    configured: boolean;
    apps: AppSecretStatus[];
}

/**
 * The registered keys for one app, sorted, with presence and build-time-ness but
 * never a value.
 *
 * Every entry is `present: true` - the flag lives on the stored value, so a key
 * the build needs but nobody has supplied has no row and cannot appear here. The
 * field stays because callers read it, and because that is the shape to fill in if
 * a valueless declaration ever becomes representable again.
 */
export function computeSecretStatus(present: SecretSummary[]): SecretStatusEntry[] {
    return [...present]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((summary) => ({
            key: summary.key,
            present: true,
            maskedLength: summary.maskedLength,
            fingerprint: summary.fingerprint,
            buildTime: summary.buildTime,
        }));
}

/**
 * Reports, per app of an application's active preview config, which secret keys
 * are registered and which of them the build gets as build args - without ever
 * reading a value. Backs the MCP `get_secret_status` tool so a client's agent can
 * see the env-var surface and fix it, never the value.
 *
 * The config supplies the app LIST and their connections; the secret rows supply
 * everything about the secrets themselves, build-time-ness included. Nothing here
 * can report a key the build needs but nobody has set: that requires a
 * declaration independent of a value, which the model no longer has.
 */
export class PreviewkitSecretStatusService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly secrets: PreviewkitSecretsService,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async status(applicationId: string, organizationId: string): Promise<SecretStatusResult> {
        this.logger.info("Computing secret status", { applicationId, organizationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { previewkitConfig: { include: previewkitConfigRowsInclude } },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const stored = application.previewkitConfig;
        if (stored == null) {
            return { applicationId, configured: false, apps: [] };
        }

        const parsed = trustedPreviewConfigSchema.safeParse(documentFromPreviewkitConfigRows(stored));
        if (!parsed.success) {
            return { applicationId, configured: false, apps: [] };
        }

        const apps: AppSecretStatus[] = [];
        for (const app of parsed.data.apps) {
            const present = await this.secrets.list(applicationId, app.name, organizationId);
            const secrets = computeSecretStatus(present);
            const connections = app.connections.map((connection) => ({
                key: connection.key,
                value: connection.value,
                buildTime: connection.build_time,
            }));
            apps.push({
                appName: app.name,
                connections,
                secrets,
            });
        }

        this.logger.info("Secret status computed", { applicationId, extra: { appCount: apps.length } });
        return { applicationId, configured: true, apps };
    }
}
