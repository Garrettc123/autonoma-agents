import { integrationTestSuite } from "@autonoma/integration-test";
import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import type { SecretBundle } from "@autonoma/utils";
import { expect } from "vitest";
import { BuildSecretSource } from "../../src/secrets/build-secret-source";
import { PreviewkitTestHarness } from "./harness";

integrationTestSuite<PreviewkitTestHarness, undefined>({
    name: "BuildSecretSource",
    createHarness: () => PreviewkitTestHarness.create(),
    seed: async () => undefined,
    cases: (test) => {
        /**
         * An Application, plus a sealed bundle under it when `sealed` names any keys.
         * A value given as a tuple states its build-time flag; a bare string takes the
         * store's default, which is build-time - so a test that cares about a
         * runtime-only value has to say `[value, false]` rather than rely on the plain
         * form.
         */
        async function bundleWith(
            harness: PreviewkitTestHarness,
            sealed: Record<string, string | [string, boolean]>,
        ): Promise<SecretBundle> {
            const { organizationId } = await harness.createOrganization();
            const application = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId,
                    architecture: "WEB",
                },
            });
            const bundle: SecretBundle = { kind: "app", applicationId: application.id, appName: "web" };
            if (Object.keys(sealed).length > 0) {
                // Sealing binds the app row, so "web" has to exist in the topology.
                await harness.db.previewkitApp.create({
                    data: {
                        config: { create: { applicationId: application.id } },
                        position: 0,
                        name: "web",
                        repository: "acme/web",
                        path: ".",
                        port: 3000,
                        resourcesTier: "medium",
                    },
                });
                const provider = new FakeKeyProvider();
                await mintSecretKey({ db: harness.db, provider, keyId: "1" });
                await new SecretValues(harness.db, new SecretKeys(harness.db, provider)).put(
                    bundle,
                    Object.entries(sealed).map(([key, entry]) =>
                        typeof entry === "string"
                            ? { key, value: entry }
                            : { key, value: entry[0], buildTime: entry[1] },
                    ),
                );
            }
            return bundle;
        }

        function source(harness: PreviewkitTestHarness): BuildSecretSource {
            return new BuildSecretSource(
                new SecretValues(harness.db, new SecretKeys(harness.db, new FakeKeyProvider())),
            );
        }

        test("reads the sealed values out of Postgres", async ({ harness }) => {
            const bundle = await bundleWith(harness, {
                DATABASE_URL: "postgres://sealed",
                API_KEY: "sk_live",
            });

            expect(await source(harness).forBundle(bundle)).toEqual({
                DATABASE_URL: "postgres://sealed",
                API_KEY: "sk_live",
            });
        });

        test("passes only the build-time values as build args", async ({ harness }) => {
            const bundle = await bundleWith(harness, { WANTED: ["yes", true], OTHER: ["no", false] });

            expect(await source(harness).forBuild(bundle)).toEqual({ WANTED: "yes" });
        });

        test("answers empty for a bundle whose values are all runtime-only", async ({ harness }) => {
            // Unlike forBundle, this is the common case rather than a failure: most apps
            // need nothing at build time, so there is nothing to distinguish it from.
            const bundle = await bundleWith(harness, { RUNTIME_ONLY: ["no", false] });

            expect(await source(harness).forBuild(bundle)).toEqual({});
        });

        test("fails rather than answering empty for a bundle holding nothing", async ({ harness }) => {
            // Reachable two ways: values that never landed, or a bundle whose every key
            // was deleted. There is no second store to ask either way, and a build that
            // succeeds against no credentials is worse than one that stops.
            const bundle = await bundleWith(harness, {});

            await expect(source(harness).forBundle(bundle)).rejects.toThrow(/No secret values are stored/);
        });

        test("fails clearly when the environment has no encryption key configured", async ({ harness }) => {
            const bundle = await bundleWith(harness, { API_KEY: "sk_live" });

            await expect(new BuildSecretSource().forBundle(bundle)).rejects.toThrow(/PREVIEWKIT_SECRETS_CMK/);
        });
    },
});
