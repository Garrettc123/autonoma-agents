import { randomBytes } from "node:crypto";
import matter from "@11ty/gray-matter";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import { reconcileTestPlanScenarios, type ScenarioManager, type ScenarioRecipeStore } from "@autonoma/scenario";
import { BranchAlreadyOpenError, type OpenSnapshot, TestSuiteStore } from "@autonoma/test-suite";
import {
    type SetupEventBody,
    type UpdateSetupBody,
    type UploadArtifactsBody,
    type UploadScenarioRecipeVersionsBody,
    FileDataSchema,
    hasGoneLive,
    TestCaseFrontmatterSchema,
    TOTAL_SETUP_STEPS,
} from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import type { OnboardingManager } from "../routes/onboarding/onboarding-manager";
import { isStepAtOrPast } from "../routes/onboarding/onboarding-step-order";

const log = logger.child({ name: "ApplicationSetupService" });

function buildArtifactPath(file: { name: string; folder?: string }) {
    return file.folder != null ? `${file.folder}/${file.name}` : file.name;
}

const SCENARIO_RECIPES_ARTIFACT_PATH = "autonoma/scenario-recipes.json";

type SetupWithBranch = {
    id: string;
    applicationId: string;
    protocolVersion: string;
    application: {
        mainBranch: {
            id: string;
            activeSnapshot: { id: string } | null;
            pendingSnapshot: { id: string } | null;
        } | null;
    };
};

export class ApplicationSetupService {
    private readonly suite: TestSuiteStore;

    constructor(
        private readonly db: PrismaClient,
        private readonly onboardingManager: OnboardingManager,
        private readonly recipeStore: ScenarioRecipeStore,
        private readonly scenarioManager: ScenarioManager,
    ) {
        this.suite = new TestSuiteStore(db);
    }

    async createSetup(userId: string, organizationId: string, applicationId: string, repoName?: string) {
        const setup = await this.db.$transaction(async (tx) => {
            const app = await tx.application.findUnique({ where: { id: applicationId, organizationId } });
            if (app == null) throw new NotFoundError("Application not found");

            if (repoName != null) {
                const uniqueName = await this.resolveUniqueName(tx, repoName, organizationId);
                await tx.application.update({
                    where: { id: applicationId },
                    data: { name: uniqueName, slug: toSlug(uniqueName) },
                });
            }

            return tx.applicationSetup.create({
                data: {
                    applicationId,
                    organizationId,
                    userId,
                    totalSteps: TOTAL_SETUP_STEPS,
                },
            });
        });

        log.info("Created application setup", { setupId: setup.id, applicationId });
        return { id: setup.id, applicationId };
    }

    private async resolveUniqueName(
        tx: Prisma.TransactionClient,
        name: string,
        organizationId: string,
    ): Promise<string> {
        const existing = await tx.application.findUnique({
            where: { name_organizationId: { name, organizationId } },
            select: { id: true },
        });
        if (existing == null) return name;

        const suffix = randomBytes(6).toString("hex");
        const uniqueName = `${name}-${suffix}`;
        log.info("Application name conflict, appending suffix", { originalName: name, uniqueName });
        return uniqueName;
    }

    async addEvent(setupId: string, organizationId: string, event: SetupEventBody) {
        let setupCompleted = false;
        let applicationId: string | undefined;

        await this.db.$transaction(async (tx) => {
            const found = await tx.applicationSetup.findUnique({
                where: { id: setupId, organizationId },
                select: { id: true, applicationId: true },
            });
            if (found == null) throw new NotFoundError("Application setup not found");

            applicationId = found.applicationId;

            await tx.applicationSetupEvent.create({
                data: {
                    setupId,
                    type: event.type,
                    data: event.data as Record<string, unknown>,
                },
            });

            if (event.type === "step.started") {
                await tx.applicationSetup.update({
                    where: { id: setupId },
                    data: { currentStep: event.data.step },
                });
            }

            if (event.type === "step.completed" && event.data.step === TOTAL_SETUP_STEPS - 1) {
                await tx.applicationSetup.update({
                    where: { id: setupId },
                    data: { status: "completed", completedAt: new Date() },
                });
                setupCompleted = true;
            }

            if (event.type === "error") {
                await tx.applicationSetup.update({
                    where: { id: setupId },
                    data: { status: "failed", errorMessage: event.data.message },
                });
            }

            return found;
        });

        if (setupCompleted && applicationId != null) {
            await this.activateSnapshotAfterSetupCompletion(setupId, applicationId, organizationId);
        }

        log.info("Added setup event", { setupId, type: event.type });
    }

    async updateSetup(setupId: string, organizationId: string, body: UpdateSetupBody) {
        let setupCompleted = false;
        let applicationId: string | undefined;

        await this.db.$transaction(async (tx) => {
            const setup = await tx.applicationSetup.findUnique({ where: { id: setupId, organizationId } });
            if (setup == null) throw new NotFoundError("Application setup not found");
            applicationId = setup.applicationId;

            const data: Prisma.ApplicationSetupUpdateInput = {
                name: body.name,
                protocolVersion: body.protocolVersion,
            };
            const protocolChanged = body.protocolVersion != null && body.protocolVersion !== setup.protocolVersion;
            if (protocolChanged && body.status == null) {
                data.status = "running";
                data.completedAt = null;
                data.errorMessage = null;
            }
            if (body.status === "completed") {
                data.status = "completed";
                data.completedAt = new Date();
                setupCompleted = true;
            }
            if (body.status === "partial_failure") {
                data.status = "partial_failure";
                data.errorMessage = body.errorMessage;
                data.completedAt = null;
            }
            if (body.status === "failed") {
                data.status = "failed";
                data.errorMessage = body.errorMessage;
                data.completedAt = null;
            }

            await tx.applicationSetup.update({
                where: { id: setupId },
                data,
            });
            // Mirror the planner's declared protocol onto the app: `Application.protocolVersion` is the
            // single source of truth the wire + every v1/v2 gate read. The setup row keeps its own copy
            // (it drives `setupCompleted`), but nothing downstream reads it as the live flag.
            if (body.protocolVersion != null) {
                await tx.application.update({
                    where: { id: setup.applicationId },
                    data: { protocolVersion: body.protocolVersion },
                });
            }
            if (protocolChanged) {
                await tx.onboardingState.updateMany({
                    where: { applicationId: setup.applicationId },
                    data: {
                        lastDiscoveredAt: null,
                        lastDiscoveredModels: null,
                        lastDiscoveryError: null,
                        discoveringStartedAt: null,
                        dryRunPassedAt: null,
                    },
                });
            }
        });

        if (setupCompleted && applicationId != null) {
            await this.activateSnapshotAfterSetupCompletion(setupId, applicationId, organizationId);
        }

        log.info("Updated application setup", { setupId, ...body });
    }

    /**
     * Activate the pending snapshot a setup just produced. Finish setup (SDK +
     * CLI artifact upload) creates the snapshot the artifact upload produces, so
     * it must be activated now. Both completion paths reach this: the planner's
     * final `step.completed` event and the admin manual upload's
     * `PATCH {status:"completed"}`.
     *
     * The pending snapshot is a staging mutex for *updating* an already-live
     * suite: an update lands as pending and goes live with the preview. But the
     * branch's FIRST suite has nothing to stage against - with replay removed the
     * uploaded tests are immediately usable, so it must be activated on upload.
     * Otherwise a successful upload leaves the Tests page (which reads the active
     * snapshot) showing an empty suite. The uploaded tests are not run here and
     * activation does not advance onboarding, so it is safe before the preview is
     * verified.
     *
     * Finish setup and onboarding's "Go live" are independent signals and nothing
     * enforces their order, so we can land here before `goLive` was ever clicked.
     * A verified preview is all that stands between the app and live, so from there we
     * go live ourselves (advancing the state machine and activating) rather than
     * depend on a manual click the user may never make. Activation is idempotent,
     * so a double signal is harmless.
     */
    private async activateSnapshotAfterSetupCompletion(
        setupId: string,
        applicationId: string,
        organizationId: string,
    ): Promise<void> {
        const onboardingState = await this.onboardingManager.getState(applicationId);
        const step = onboardingState.step;

        if (hasGoneLive(step)) {
            await this.onboardingManager.activatePendingSnapshot(applicationId, organizationId);
            log.info("Activated pending snapshot after setup completion", { setupId, applicationId });
            return;
        }

        // `preview_verified` (or a legacy `diff_trigger`) means the preview is verified, which is
        // now all that stands between the app and live. Optimistic on purpose: the preview was
        // verified once, and re-checking it here would let a rebuild in flight strand a finished
        // setup with its suite staged and nothing to retry it.
        if (isStepAtOrPast(step, "preview_verified")) {
            log.info("Setup completed and preview verified - going live to activate snapshot", {
                setupId,
                applicationId,
                step,
            });
            await this.onboardingManager.goLive(applicationId, organizationId);
            return;
        }

        // Before the preview is verified: activate only the branch's first usable
        // suite. A later upload is an update and stays staged in the pending
        // snapshot until the preview is verified and the app goes live.
        if (await this.isFirstUsableSuite(applicationId, organizationId)) {
            log.info("Activating first uploaded suite before preview verification", {
                setupId,
                applicationId,
                step,
            });
            await this.onboardingManager.activatePendingSnapshot(applicationId, organizationId);
            return;
        }

        log.info("Setup completed - staging suite update in pending snapshot until go-live", {
            setupId,
            applicationId,
            step,
        });
    }

    /**
     * True when this upload produced the branch's first usable suite: there is a
     * pending snapshot to activate and no live suite yet (the active snapshot is
     * absent or still the empty onboarding placeholder, with zero test-case
     * assignments). Only the first suite activates immediately; later uploads stage
     * into the pending snapshot and go live with the preview.
     */
    private async isFirstUsableSuite(applicationId: string, organizationId: string): Promise<boolean> {
        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { mainBranch: { select: { activeSnapshotId: true, pendingSnapshotId: true } } },
        });
        const branch = app?.mainBranch;
        if (branch?.pendingSnapshotId == null) return false;
        if (branch.activeSnapshotId == null) return true;

        const activeTestCount = await this.db.testCaseAssignment.count({
            where: { snapshotId: branch.activeSnapshotId },
        });
        return activeTestCount === 0;
    }

    async uploadArtifacts(setupId: string, organizationId: string, body: UploadArtifactsBody) {
        const setup = await this.getSetupWithBranch(setupId, organizationId);
        const branchId = setup.application.mainBranch?.id;
        if (branchId == null) throw new Error("Application has no main branch");
        this.assertNoScenarioRecipesInArtifacts(body.artifacts ?? []);

        const snapshot = await this.openSuite(branchId, organizationId);
        await this.applyTests(
            snapshot,
            body.testCases ?? [],
            setup.applicationId,
            organizationId,
            setup.protocolVersion,
        );
        await this.createFileEvents(setupId, body);
        if (body.commitSha != null) {
            await this.recordCommit(branchId, body.commitSha);
        }

        await this.activateSnapshotAfterSetupCompletion(setupId, setup.applicationId, organizationId);

        log.info("Uploaded artifacts", {
            setupId,
            testCases: body.testCases?.length ?? 0,
            artifacts: body.artifacts?.length ?? 0,
        });
    }

    /**
     * Stamps the commit the artifacts were generated from onto the pending
     * snapshot the upload just opened (head_sha), mirroring how the GitHub
     * diff flow records commits. Once that snapshot activates it becomes the
     * branch's active snapshot, so its head_sha is the branch's handled commit.
     */
    private async recordCommit(branchId: string, commitSha: string) {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: { pendingSnapshotId: true },
        });

        if (branch?.pendingSnapshotId == null) {
            log.warn("No pending snapshot to record commit on", { extra: { branchId, commitSha } });
            return;
        }

        await this.db.branchSnapshot.update({
            where: { id: branch.pendingSnapshotId },
            data: { headSha: commitSha },
        });

        log.info("Recorded commit for uploaded artifacts", {
            extra: { branchId, commitSha, pendingSnapshotId: branch.pendingSnapshotId },
        });
    }

    async listScenariosForSetup(setupId: string, organizationId: string) {
        const setup = await this.getSetupWithBranch(setupId, organizationId);
        const scenarios = await this.db.scenario.findMany({
            where: { applicationId: setup.applicationId },
            orderBy: { name: "asc" },
            select: {
                id: true,
                name: true,
                isDisabled: true,
                activeRecipeVersionId: true,
            },
        });
        return {
            scenarios: scenarios.map((s) => ({
                id: s.id,
                name: s.name,
                isDisabled: s.isDisabled,
                hasActiveRecipe: s.activeRecipeVersionId != null,
            })),
        };
    }

    async listScenariosForApplication(applicationId: string, organizationId: string) {
        const application = await this.db.application.findFirst({
            where: { OR: [{ id: applicationId }, { slug: applicationId }], organizationId },
            select: { id: true },
        });
        if (application == null) throw new NotFoundError("Application not found");
        const scenarios = await this.db.scenario.findMany({
            where: { applicationId: application.id },
            orderBy: { name: "asc" },
            select: { id: true, name: true, isDisabled: true, activeRecipeVersionId: true },
        });
        return {
            scenarios: scenarios.map((s) => ({
                id: s.id,
                name: s.name,
                isDisabled: s.isDisabled,
                hasActiveRecipe: s.activeRecipeVersionId != null,
            })),
        };
    }

    async getTestSuiteForApplication(applicationId: string, organizationId: string) {
        const application = await this.db.application.findFirst({
            where: { OR: [{ id: applicationId }, { slug: applicationId }], organizationId },
            select: {
                mainBranch: {
                    select: {
                        pendingSnapshot: { select: { id: true } },
                        activeSnapshot: { select: { id: true } },
                    },
                },
            },
        });
        const branch = application?.mainBranch;
        const snapshotId = branch?.pendingSnapshot?.id ?? branch?.activeSnapshot?.id;
        if (snapshotId == null) return { tests: [] };

        const suite = await this.suite.read(snapshotId);
        return {
            tests: suite.testCases
                .filter((tc) => tc.plan != null)
                .map((tc) => ({ id: tc.id, name: tc.name, slug: tc.slug, prompt: tc.plan!.prompt })),
        };
    }

    async uploadScenarioRecipeVersions(
        setupId: string,
        organizationId: string,
        body: UploadScenarioRecipeVersionsBody,
    ) {
        const setup = await this.getSetupWithBranch(setupId, organizationId);
        const result = await this.ingestScenarioRecipesForSetup(setup, body);

        await reconcileTestPlanScenarios(
            this.db,
            setup.applicationId,
            result.scenarios.map((scenario) => scenario.name),
            log,
        );

        return {
            ok: true as const,
            scenarioCount: result.scenarioCount,
            scenarios: result.scenarios,
        };
    }

    private async getSetupWithBranch(setupId: string, organizationId: string): Promise<SetupWithBranch> {
        const setup = await this.db.applicationSetup.findFirst({
            where: { id: setupId, organizationId },
            select: {
                id: true,
                applicationId: true,
                protocolVersion: true,
                application: {
                    select: {
                        mainBranch: {
                            select: {
                                id: true,
                                activeSnapshot: { select: { id: true } },
                                pendingSnapshot: { select: { id: true } },
                            },
                        },
                    },
                },
            },
        });
        if (setup == null) throw new NotFoundError("Application setup not found");
        return setup;
    }

    /**
     * The snapshot an upload writes into: a fresh edit snapshot on the branch, or the one already open on it.
     *
     * An upload is not a session the user drives, so it adopts whatever is open rather than refusing - a retried
     * or resumed upload must land in the same snapshot as the first attempt, and the idempotency filter in
     * {@link applyTests} is what keeps it from duplicating tests.
     */
    private async openSuite(branchId: string, organizationId: string): Promise<OpenSnapshot> {
        try {
            return await this.suite.openEditSnapshot({ branchId, organizationId });
        } catch (err) {
            if (!(err instanceof BranchAlreadyOpenError)) {
                throw err;
            }

            log.info("Snapshot already open on the branch, writing into it", { branchId });
            return this.suite.reopen(err.pendingSnapshotId, { organizationId });
        }
    }

    private async applyTests(
        snapshot: OpenSnapshot,
        testCases: NonNullable<UploadArtifactsBody["testCases"]>,
        applicationId: string,
        organizationId: string,
        protocolVersion: string,
    ): Promise<void> {
        const scenarios = await this.db.scenario.findMany({
            where: { applicationId },
            select: { id: true, name: true, activeRecipeVersionId: true },
        });
        const scenarioByName = new Map(scenarios.map((s) => [s.name, s]));

        // Match existing test identities by folder + filename. An identical retry is a
        // no-op; changed content mints a new plan on the open snapshot so a v1 -> v2
        // migration can replace frontmatter without forking the test case identity.
        const incomingNames = testCases.map((tc) => tc.name);
        const existingTestCases = await this.db.testCase.findMany({
            where: { applicationId, name: { in: incomingNames } },
            select: { id: true, name: true, folder: { select: { name: true } } },
        });
        const existingByKey = new Map(existingTestCases.map((test) => [`${test.folder.name}::${test.name}`, test]));
        const assignments = await this.db.testCaseAssignment.findMany({
            where: { snapshotId: snapshot.snapshotId, testCaseId: { in: existingTestCases.map((test) => test.id) } },
            select: {
                testCaseId: true,
                plan: { select: { prompt: true, scenarioId: true, scenarioName: true } },
            },
        });
        const assignmentByTestCase = new Map(assignments.map((assignment) => [assignment.testCaseId, assignment]));

        const folderCache = new Map<string, string>();
        const processedKeys = new Set<string>();

        for (const testCase of testCases) {
            const folderName = testCase.folder ?? "default";
            const dedupeKey = `${folderName}::${testCase.name}`;
            if (processedKeys.has(dedupeKey)) continue;
            processedKeys.add(dedupeKey);

            const { data, content: plan } = matter(testCase.content);
            const frontmatter = TestCaseFrontmatterSchema.parse(data);
            const scenarioName = frontmatter.scenario;

            let scenarioId: string | undefined;
            if (scenarioName != null) {
                const scenario = scenarioByName.get(scenarioName);
                if (scenario == null) {
                    const context = { testCase: testCase.name, scenarioName, applicationId };
                    if (protocolVersion === "2.0") {
                        log.info("Deferring test scenario binding until SDK discovery", context);
                    } else {
                        log.warn(
                            "Test references unknown scenario - scenario recipes must be uploaded before tests",
                            context,
                        );
                    }
                } else {
                    scenarioId = scenario.id;
                    if (protocolVersion === "1.0" && scenario.activeRecipeVersionId == null) {
                        log.warn("Scenario has no active recipe version", {
                            testCase: testCase.name,
                            scenarioName,
                            scenarioId,
                        });
                    }
                }
            }

            const existing = existingByKey.get(dedupeKey);
            if (existing != null) {
                const assignment = assignmentByTestCase.get(existing.id);
                const unchanged =
                    assignment?.plan?.prompt === plan.trim() &&
                    assignment.plan.scenarioId === (scenarioId ?? null) &&
                    assignment.plan.scenarioName === (scenarioName ?? null);
                if (unchanged) {
                    log.info("Skipping unchanged test case (idempotent re-upload)", {
                        name: testCase.name,
                        folder: folderName,
                        applicationId,
                    });
                    continue;
                }

                if (assignment == null) {
                    await snapshot.adoptTest({
                        testCaseId: existing.id,
                        plan: plan.trim(),
                        scenarioId,
                        scenarioName,
                    });
                } else {
                    await snapshot.revisePlan({
                        testCaseId: existing.id,
                        plan: plan.trim(),
                        scenarioId,
                        scenarioName,
                    });
                }
                log.info("Updated existing test case plan from artifact upload", {
                    name: testCase.name,
                    folder: folderName,
                    applicationId,
                });
                continue;
            }

            const folderId = await this.findOrCreateFolder(applicationId, organizationId, folderName, folderCache);

            await snapshot.addTest({
                name: testCase.name,
                description: frontmatter.description,
                plan: plan.trim(),
                folderId,
                scenarioId,
                scenarioName,
            });
        }
    }

    private async findOrCreateFolder(
        applicationId: string,
        organizationId: string,
        folderName: string,
        cache: Map<string, string>,
    ): Promise<string> {
        const cached = cache.get(folderName);
        if (cached != null) return cached;

        const folderId = await this.db.$transaction(async (tx) => {
            const existing = await tx.folder.findFirst({
                where: { applicationId, name: folderName, parentId: null },
                select: { id: true },
            });

            if (existing != null) return existing.id;

            const created = await tx.folder.create({
                data: { name: folderName, applicationId, organizationId },
                select: { id: true },
            });
            log.info("Created folder for test case upload", { folderName, folderId: created.id, applicationId });
            return created.id;
        });

        cache.set(folderName, folderId);
        return folderId;
    }

    private async createFileEvents(setupId: string, body: UploadArtifactsBody): Promise<void> {
        const fileEvents: Array<{ type: "file.created"; data: { filePath: string } }> = [
            ...(body.testCases ?? []).map((testCase) => ({
                type: "file.created" as const,
                data: {
                    filePath:
                        testCase.folder != null
                            ? `autonoma/qa-tests/${testCase.folder}/${testCase.name}`
                            : `autonoma/qa-tests/${testCase.name}`,
                },
            })),
            ...(body.artifacts ?? []).map((artifact) => ({
                type: "file.created" as const,
                data: { filePath: buildArtifactPath(artifact) },
            })),
        ];

        if (fileEvents.length === 0) {
            return;
        }

        // Idempotency: skip file events already recorded for this setup so a re-upload
        // (the `upload` CLI command / a retried run) does not append duplicates.
        const existing = await this.db.applicationSetupEvent.findMany({
            where: { setupId, type: "file.created" },
            select: { data: true },
        });
        const existingPaths = new Set(
            existing.flatMap((event) => {
                const parsed = FileDataSchema.safeParse(event.data);
                return parsed.success ? [parsed.data.filePath] : [];
            }),
        );

        const newEvents = fileEvents.filter((event) => !existingPaths.has(event.data.filePath));
        if (newEvents.length === 0) {
            return;
        }

        await this.db.applicationSetupEvent.createMany({
            data: newEvents.map((event) => ({
                setupId,
                type: event.type,
                data: { filePath: event.data.filePath },
            })),
        });
    }

    private async ingestScenarioRecipesForSetup(
        setup: SetupWithBranch,
        body: UploadScenarioRecipeVersionsBody,
    ): Promise<{ scenarioCount: number; scenarios: Array<{ id: string; name: string; recipeVersionId: string }> }> {
        const snapshotId = setup.application.mainBranch?.activeSnapshot?.id;
        if (snapshotId == null) {
            throw new BadRequestError("Application main branch has no active snapshot");
        }

        const knownModels = await this.discoverKnownModels(setup.applicationId);

        const result = await this.recipeStore.replaceScenarioRecipes({
            snapshotId,
            applicationId: setup.applicationId,
            recipesFile: body,
            knownModels,
        });
        log.info("Ingested scenario recipes", {
            setupId: setup.id,
            snapshotId,
            applicationId: setup.applicationId,
            scenarioCount: result.scenarioCount,
        });

        const pendingSnapshotId = setup.application.mainBranch?.pendingSnapshot?.id;
        if (pendingSnapshotId != null && pendingSnapshotId !== snapshotId) {
            log.info("Replicating scenario recipes to pending snapshot", {
                setupId: setup.id,
                activeSnapshotId: snapshotId,
                pendingSnapshotId,
            });
            await this.recipeStore.replaceScenarioRecipes({
                snapshotId: pendingSnapshotId,
                applicationId: setup.applicationId,
                recipesFile: body,
                knownModels,
            });

            await this.db.$transaction(
                result.scenarios.map((s) =>
                    this.db.scenario.update({
                        where: { id: s.id },
                        data: { activeRecipeVersionId: s.recipeVersionId },
                    }),
                ),
            );
        }

        return result;
    }

    /**
     * The models the application's SDK endpoint says it can build, so a recipe naming one it cannot is
     * rejected at upload rather than 400ing once per test at provisioning time.
     *
     * Best-effort by design: an endpoint that is not deployed yet, has no deployment row, or is simply
     * unreachable is the normal state during onboarding, and rejecting an upload for that would block a
     * customer from ever seeding their first recipe. A failure here therefore returns undefined - the
     * model check is skipped, and the recipe still goes through every check that needs no network.
     */
    private async discoverKnownModels(applicationId: string): Promise<ReadonlySet<string> | undefined> {
        const deployment = await this.db.branchDeployment.findFirst({
            where: { branch: { applicationId }, webhookUrl: { not: null } },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (deployment == null) {
            log.info("No deployment with an SDK endpoint - skipping the recipe model check", { applicationId });
            return undefined;
        }

        try {
            const response = await this.scenarioManager.discover(applicationId, deployment.id);
            // An endpoint advertising nothing is indistinguishable from a broken one, and reading it as
            // "can build nothing" would reject every recipe - so it counts as no answer, not an empty one.
            // A v2 endpoint carries no `schema` at all; same handling - there is no recipe model check for it.
            const discoveredModels = response.schema?.models ?? [];
            if (discoveredModels.length === 0) {
                log.warn("Discover advertised no models - skipping the recipe model check", { applicationId });
                return undefined;
            }
            const models = new Set(discoveredModels.map((model) => model.name));
            log.info("Discovered SDK models for the recipe model check", {
                applicationId,
                extra: { deploymentId: deployment.id, modelCount: models.size },
            });
            return models;
        } catch (err) {
            log.warn("Discover failed - skipping the recipe model check", {
                applicationId,
                extra: { deploymentId: deployment.id },
                err,
            });
            return undefined;
        }
    }

    private assertNoScenarioRecipesInArtifacts(artifacts: NonNullable<UploadArtifactsBody["artifacts"]>) {
        const scenarioRecipeArtifact = artifacts.find(
            (artifact) => buildArtifactPath(artifact) === SCENARIO_RECIPES_ARTIFACT_PATH,
        );
        if (scenarioRecipeArtifact == null) {
            return;
        }
        throw new BadRequestError(
            "SCENARIO_RECIPES_MUST_USE_VERSIONED_ENDPOINT: upload scenario recipes through /scenario-recipe-versions instead of /artifacts",
        );
    }
}
