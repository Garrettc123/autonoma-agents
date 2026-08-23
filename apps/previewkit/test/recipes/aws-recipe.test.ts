import { previewConfigSchema } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/schema";
import { AwsRecipe } from "../../src/recipes/aws-recipe";

const baseService = (options: Record<string, unknown>): ServiceConfig => ({
    name: "aws",
    recipe: "aws",
    options,
    resources: { tier: "standard", cpu: "100m", memory: "1Gi" },
});

function servicesEnv(recipe: AwsRecipe, config: ServiceConfig): string | undefined {
    const container = recipe.generate(config, "ns").deployments[0]?.spec?.template?.spec?.containers?.[0];
    return container?.env?.find((entry) => entry.name === "SERVICES")?.value;
}

describe("AwsRecipe", () => {
    const recipe = new AwsRecipe();

    it("enables exactly the services options turns on", () => {
        expect(servicesEnv(recipe, baseService({ s3: true, sqs: true }))).toBe("s3,sqs");
        expect(servicesEnv(recipe, baseService({ sns: true }))).toBe("sns");
    });

    it("refuses a config with nothing enabled rather than starting an empty stack", () => {
        expect(() => recipe.generate(baseService({}), "ns")).toThrow(/options\.s3/);
    });

    /**
     * The flags used to sit at the service's top level and production still holds
     * documents (resolvedConfig snapshots) written that way. The schema folds them
     * into options on parse, so the recipe - which only reads options - must see a
     * legacy document exactly as it saw it before the move.
     */
    it("deploys a legacy document whose flags are top-level", () => {
        const config = previewConfigSchema.parse({
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000 }],
            services: [{ name: "aws", recipe: "aws", s3: true, sqs: true, sns: true, options: { queues: ["q1"] } }],
        });
        const service = config.services[0]!;

        expect(servicesEnv(recipe, service)).toBe("s3,sqs,sns");
    });
});
