import type { SecretValues } from "@autonoma/secrets";
import { describeSecretBundle, type SecretBundle } from "@autonoma/utils";
import { type Logger, logger as rootLogger } from "../logger";

/**
 * The values a build reads, from Postgres.
 *
 * Keyed by bundle rather than by any external identifier: that is what the store
 * needs, and it is the only key that cannot resolve to the wrong owner.
 *
 * There is no second store. A bundle Postgres cannot serve is an error, not a
 * reason to look elsewhere - handing a build an empty map bakes an image against
 * absent credentials, which fails far from the cause or, worse, ships.
 */
export class BuildSecretSource {
    private readonly logger: Logger;

    constructor(
        /**
         * Absent when this environment has no CMK to unwrap an encryption key with.
         * A deploy that needs no secrets is unaffected; one that does fails saying so.
         */
        private readonly values?: SecretValues,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /** Every key and value in `bundle`. */
    async forBundle(bundle: SecretBundle): Promise<Record<string, string>> {
        return this.open(bundle);
    }

    /**
     * The values marked build-time, as build args.
     *
     * An empty map is a normal answer - most apps declare none - which is why this
     * does not go through {@link open}: that treats an empty bundle as a failure,
     * correctly, because it is asked for every value an app needs to RUN.
     */
    async forBuild(bundle: SecretBundle): Promise<Record<string, string>> {
        if (this.values == null) {
            throw new Error(
                `Cannot read build-time secrets for ${describeSecretBundle(bundle)}: this environment has no ` +
                    `PREVIEWKIT_SECRETS_CMK configured, so no encryption key can be unwrapped.`,
            );
        }

        const picked = await this.values.getBuildTime(bundle);
        this.logger.info("Read build-time secrets from postgres", {
            extra: { bundle: describeSecretBundle(bundle), keyCount: Object.keys(picked).length },
        });
        return picked;
    }

    private async open(bundle: SecretBundle): Promise<Record<string, string>> {
        const label = describeSecretBundle(bundle);

        if (this.values == null) {
            throw new Error(
                `Cannot read secrets for ${label}: this environment has no PREVIEWKIT_SECRETS_CMK configured, ` +
                    `so no encryption key can be unwrapped.`,
            );
        }

        // Undefined means the bundle holds nothing: values that never landed, or a
        // bundle whose every key was deleted. Nothing can serve the build either way,
        // and failing beats a build that succeeds against no credentials.
        const opened = await this.values.getAll(bundle);
        if (opened == null) {
            throw new Error(`No secret values are stored for ${label}.`);
        }

        this.logger.info("Read secrets from postgres", {
            extra: { bundle: label, keyCount: Object.keys(opened).length },
        });
        return opened;
    }
}
