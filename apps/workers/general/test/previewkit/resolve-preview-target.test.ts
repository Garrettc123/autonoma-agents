import { ApplicationArchitecture, createClient, type PrismaClient } from "@autonoma/db";
import { FakeGitHubApp, FakeGitHubInstallationClient } from "@autonoma/github";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { resolvePreviewTarget } from "../../src/activities/previewkit/resolve-preview-target";

// The activity reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma). Point it at
// this suite's container so it and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

/** Monotonic counter for unique names across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

interface BaseSeedOptions {
    /** Where onboarding is parked. `completed` means the app is live. */
    step: "previewkit_configuring" | "completed";
    /** The branch the base preview is pinned to, or undefined to follow the trunk. */
    previewDeployRef?: string;
}

interface SeedOptions {
    /** How the app gets its previews. `previewkit` is the path that owns a target. */
    previewEnvironmentMode: "previewkit" | "existing_deploys";
    /** Where onboarding is parked. `completed` means the app is live. */
    step: "previewkit_configuring" | "completed";
    /** A base-preview pin, to prove it does NOT reach this app's pull requests. */
    previewDeployRef?: string;
}

class PreviewTargetHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        public readonly github: FakeGitHubInstallationClient,
    ) {}

    static async create(): Promise<PreviewTargetHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        // The activity resolves the live head through the GitHub app; the override lets it read this fake instead
        // of reaching the network, and the seeds below register the repo/PR/branch each case queries.
        const github = new FakeGitHubInstallationClient();
        globalThis.__generalGitHubApp = new FakeGitHubApp(github);
        return new PreviewTargetHarness(db, github);
    }

    async beforeAll() {}
    async afterAll() {
        globalThis.__generalGitHubApp = undefined;
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /**
     * A PR branch on a repo-linked application, plus an existing preview environment for that repo.
     *
     * The environment is what lets `resolveRepoFullName` answer from the database instead of reaching GitHub, which
     * is the only thing in this activity that would need a network.
     */
    async seedPrBranch(options: SeedOptions): Promise<string> {
        const n = next();
        const githubRepositoryId = 900_000 + n;
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
                githubRepositoryId,
                previewDeployRef: options.previewDeployRef,
                onboardingState: {
                    create: {
                        step: options.step,
                        previewEnvironmentMode: options.previewEnvironmentMode,
                        completedAt: options.step === "completed" ? new Date() : undefined,
                    },
                },
            },
        });
        const branch = await this.db.branch.create({
            data: {
                name: `feature/${n}`,
                applicationId: app.id,
                organizationId: org.id,
                prInfo: { create: { applicationId: app.id, prNumber: n + 1, prState: "open" } },
            },
        });

        await this.db.previewkitEnvironment.create({
            data: {
                namespace: `preview-${n}`,
                repoFullName: `acme/repo-${n}`,
                prNumber: n + 1,
                headSha: `head-${n}`,
                headRef: `feature/${n}`,
                organizationId: org.id,
                githubRepositoryId,
                status: "ready",
            },
        });

        await this.seedInstallation(org.id, n);
        this.github.addRepository({
            id: githubRepositoryId,
            name: `repo-${n}`,
            fullName: `acme/repo-${n}`,
            defaultBranch: "main",
            commits: [`base-${n}`],
        });
        this.github.addPullRequest(`acme/repo-${n}`, {
            number: n + 1,
            title: `PR ${n}`,
            headRef: `feature/${n}`,
            baseSha: `base-${n}`,
            commits: [`live-head-${n}`],
        });

        return branch.id;
    }

    /** The installation the activity looks up before it can authenticate as the org to read the head. */
    private async seedInstallation(organizationId: string, n: number): Promise<void> {
        await this.db.gitHubInstallation.create({
            data: {
                organizationId,
                installationId: n + 1,
                accountLogin: `org-${n}`,
                accountId: n + 1,
                accountType: "Organization",
            },
        });
    }

    /**
     * The BASE environment: a branch with no pull request, on an app whose base preview is pinned
     * to an integration branch. The Branch record stays the trunk on purpose - that is the split
     * this fixture exists to exercise.
     */
    async seedBaseBranch(options: BaseSeedOptions): Promise<{ branchId: string; trunkName: string }> {
        const n = next();
        const githubRepositoryId = 900_000 + n;
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
                githubRepositoryId,
                previewDeployRef: options.previewDeployRef,
                onboardingState: {
                    create: {
                        step: options.step,
                        previewEnvironmentMode: "previewkit",
                        completedAt: options.step === "completed" ? new Date() : undefined,
                    },
                },
            },
        });
        const trunkName = `main-${n}`;
        const branch = await this.db.branch.create({
            data: { name: trunkName, applicationId: app.id, organizationId: org.id },
        });

        await this.db.previewkitEnvironment.create({
            data: {
                namespace: `preview-${n}`,
                repoFullName: `acme/repo-${n}`,
                prNumber: 0,
                headSha: `head-${n}`,
                headRef: trunkName,
                organizationId: org.id,
                githubRepositoryId,
                status: "ready",
            },
        });

        await this.seedInstallation(org.id, n);
        // The base environment resolves its head via `getBranchHead(headRef)`; making that ref the repo's default
        // branch is what lets the fake answer it, whether the run pinned a deploy ref or fell back to the trunk.
        this.github.addRepository({
            id: githubRepositoryId,
            name: `repo-${n}`,
            fullName: `acme/repo-${n}`,
            defaultBranch: options.previewDeployRef ?? trunkName,
            commits: [`base-${n}`],
        });

        return { branchId: branch.id, trunkName };
    }
}

integrationTestSuite({
    name: "resolvePreviewTarget (the run's view of who owns the preview)",
    createHarness: () => PreviewTargetHarness.create(),
    cases: (test) => {
        // The regression this file exists for: the previewkit exit used to omit `onboardingComplete`, so the
        // workflow's `=== false` check never fired and every PR took the `onboarding_incomplete` build exemption.
        test("reports an unfinished onboarding on the previewkit path", async ({ harness }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "previewkit",
                step: "previewkit_configuring",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target).toBeDefined();
            expect(resolved.onboardingComplete).toBe(false);
        });

        test("reports a finished onboarding on the previewkit path", async ({ harness }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "previewkit",
                step: "completed",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target).toBeDefined();
            expect(resolved.onboardingComplete).toBe(true);
        });

        // The whole point of resolving at open time: the run analyzes the branch's CURRENT head, not the possibly
        // stale one its trigger carried - and the same sha lands on the target the build is keyed to.
        test("resolves the live PR head, not the trigger's, onto both the output and the target", async ({
            harness,
        }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "previewkit",
                step: "completed",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "stale-trigger-head" });

            expect(resolved.headSha).toMatch(/^live-head-\d+$/);
            expect(resolved.target?.headSha).toBe(resolved.headSha);
        });

        test("reports onboarding on the customer-deployed path, where the run owns no preview", async ({ harness }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "existing_deploys",
                step: "previewkit_configuring",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target).toBeUndefined();
            expect(resolved.onboardingComplete).toBe(false);
        });

        // The Branch record names the app's TRUNK by design - setDeployBranch keeps it that way so
        // suite lineage and every "main" label stay meaningful - so it is not the ref the base
        // environment deploys. Reading it here would pair the trunk's name with the requested
        // deploy's sha.
        test("the base environment deploys the pinned deploy ref, not the trunk record", async ({ harness }) => {
            const { branchId } = await harness.seedBaseBranch({
                step: "previewkit_configuring",
                previewDeployRef: "autonoma-integration",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target?.prNumber).toBe(0);
            expect(resolved.target?.headRef).toBe("autonoma-integration");
        });

        test("the base environment follows the trunk when nothing is pinned", async ({ harness }) => {
            const { branchId, trunkName } = await harness.seedBaseBranch({ step: "previewkit_configuring" });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target?.headRef).toBe(trunkName);
        });

        // A pull request has its own head; the pin belongs to environment 0 alone and must not leak
        // onto every PR preview the app builds.
        test("a pull request keeps its own branch even when a deploy ref is pinned", async ({ harness }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "previewkit",
                step: "completed",
                previewDeployRef: "autonoma-integration",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target?.prNumber).not.toBe(0);
            expect(resolved.target?.headRef).not.toBe("autonoma-integration");
        });
    },
});
