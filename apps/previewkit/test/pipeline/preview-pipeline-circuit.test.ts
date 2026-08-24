import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildCircuitChecker, BuildCircuitDecision } from "../../src/pipeline/build-circuit-breaker";
import { PreviewPipeline } from "../../src/pipeline/preview-pipeline";

vi.mock("@autonoma/db", () => ({
    db: {
        application: {
            findUnique: vi.fn(async () => ({ id: "app_1", onboardingState: { step: "completed" } })),
        },
    },
    Prisma: { DbNull: null },
}));

vi.mock("../../src/config/load-config", () => ({
    loadConfig: vi.fn(async () => ({
        version: 2,
        apps: [{ name: "web", repository: "acme/web", port: 3000 }],
        services: [],
        hooks: { pre_deploy: [], post_deploy: [] },
    })),
}));

vi.mock("../../src/env", () => ({
    env: { APP_URL: "https://app.example.com", GITHUB_COMMENT_ASSET_BASE_URL: undefined, BYPASS_TOKEN_KEY: "test-key" },
}));

vi.mock("../../src/db", () => ({
    recordEnvironmentCreated: vi.fn().mockResolvedValue(undefined),
}));

const NAMESPACE = "preview-acme-web-pr-7";

function buildPipeline(buildCircuit: BuildCircuitChecker) {
    const provider = { setCommitStatus: vi.fn().mockResolvedValue(undefined) };
    const deployer = { ensureNamespace: vi.fn().mockResolvedValue(NAMESPACE) };
    const pipeline = new PreviewPipeline({
        provider: provider as never,
        builder: {} as never,
        deployer: deployer as never,
        buildSecrets: {} as never,
        registryUrl: "registry.example.com",
        dockerHubMirror: "",
        npmRegistryMirror: "",
        buildCircuit,
    });
    return { pipeline, provider, deployer, buildCircuit };
}

function decisionChecker(decision: BuildCircuitDecision): BuildCircuitChecker {
    return { evaluate: vi.fn(async () => decision) };
}

function target(prNumber: number) {
    return {
        prNumber,
        repoFullName: "acme/web",
        organizationId: "org_1",
        githubRepositoryId: 123,
        headSha: "abc1234def5678",
        headRef: "feature/login",
    };
}

describe("PreviewPipeline.prepare build-circuit gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("short-circuits before the namespace and surfaces the paused status when the circuit is open", async () => {
        const { pipeline, provider, deployer } = buildPipeline(
            decisionChecker({
                blocked: true,
                maxFailures: 5,
                trippedApps: [{ appName: "web", consecutiveFailures: 5, since: new Date() }],
            }),
        );

        const result = await pipeline.prepare(target(7));

        expect(result).toEqual({ kind: "circuit_open", trippedApps: ["web"] });
        // Never provisions a namespace (and so never a build node).
        expect(deployer.ensureNamespace).not.toHaveBeenCalled();
        // Customer-facing surface: a clear "paused" failure status on the commit.
        expect(provider.setCommitStatus).toHaveBeenCalledWith(
            "acme/web",
            "abc1234def5678",
            "failure",
            expect.stringContaining("paused after 5 consecutive failures"),
        );
    });

    it("does not touch the commit status for a non-live application, but still short-circuits", async () => {
        const { db } = await import("@autonoma/db");
        vi.mocked(db.application.findUnique).mockResolvedValueOnce({
            id: "app_1",
            onboardingState: { step: "previewkit_configuring" },
        });
        const { pipeline, provider } = buildPipeline(
            decisionChecker({
                blocked: true,
                maxFailures: 5,
                trippedApps: [{ appName: "web", consecutiveFailures: 5, since: new Date() }],
            }),
        );

        const result = await pipeline.prepare(target(7));

        expect(result).toMatchObject({ kind: "circuit_open" });
        expect(provider.setCommitStatus).not.toHaveBeenCalled();
    });

    it("proceeds normally (creates the namespace) when the circuit is closed", async () => {
        const { pipeline, deployer } = buildPipeline(decisionChecker({ blocked: false }));

        const result = await pipeline.prepare(target(7));

        expect(result).toMatchObject({ kind: "prepared", namespace: NAMESPACE });
        expect(deployer.ensureNamespace).toHaveBeenCalledTimes(1);
    });

    it("fails open: a throwing breaker lets the build proceed (namespace still created)", async () => {
        const throwingCircuit: BuildCircuitChecker = {
            evaluate: vi.fn(async () => {
                throw new Error("transient DB error");
            }),
        };
        const { pipeline, deployer } = buildPipeline(throwingCircuit);

        const result = await pipeline.prepare(target(7));

        expect(result).toMatchObject({ kind: "prepared", namespace: NAMESPACE });
        expect(deployer.ensureNamespace).toHaveBeenCalledTimes(1);
    });
});
