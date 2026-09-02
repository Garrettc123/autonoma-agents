import { AnalysisEventStore } from "@autonoma/analysis";
import type { AnalysisCreditsGateResult } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { ApplicationArchitecture, TriggerSource } from "@autonoma/db";
import { expect, vi } from "vitest";
import { AnalysisTrigger } from "../../src/analysis/trigger/analysis-trigger";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const allowGate = { checkAnalysisCreditsGate: async (): Promise<AnalysisCreditsGateResult> => ({ allowed: true }) };
const denyGate = {
    checkAnalysisCreditsGate: async (): Promise<AnalysisCreditsGateResult> => ({
        allowed: false,
        reason: "out_of_credits",
    }),
};

/** An `AnalysisTrigger` over the harness with a controllable credits gate and a spy starter returning a workflow id. */
function makeTrigger(
    harness: APITestHarness,
    gate: { checkAnalysisCreditsGate: (organizationId: string) => Promise<AnalysisCreditsGateResult> } = allowGate,
): { trigger: AnalysisTrigger; startAnalysisRun: ReturnType<typeof vi.fn> } {
    const startAnalysisRun = vi.fn().mockResolvedValue("wf-1");
    const trigger = new AnalysisTrigger(
        harness.db,
        harness.services.github,
        gate,
        startAnalysisRun,
        new AnalysisEventStore(harness.db),
    );
    return { trigger, startAnalysisRun };
}

/** Open the run a workflow would have opened for this head, so the attach path has something to attach to. */
async function openRunFor(db: PrismaClient, branchId: string, headSha: string): Promise<void> {
    const snapshot = await db.branchSnapshot.create({
        data: { branchId, status: "processing", source: TriggerSource.WEBHOOK, headSha },
        select: { id: true },
    });
    await db.branch.update({ where: { id: branchId }, data: { pendingSnapshotId: snapshot.id } });
}

apiTestSuite({
    name: "AnalysisTrigger.deliver",
    seed: async ({ harness }) => {
        const fakeClient = harness.githubApp.defaultClient;
        fakeClient.addRepository({
            id: 2001,
            name: "trig-repo",
            fullName: "org/trig-repo",
            defaultBranch: "main",
            commits: ["initial-sha"],
        });
        for (const prNum of [10, 20, 30, 40, 50, 60, 61, 62, 70]) {
            fakeClient.addPullRequest("org/trig-repo", {
                number: prNum,
                title: `PR #${prNum}`,
                headRef: `feature/branch-${prNum}`,
                baseSha: "initial-sha",
                commits: [`head-sha-${prNum}`],
            });
        }
        const app = await harness.services.applications.createApplication({
            name: "Trigger App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });
        await harness.db.application.update({ where: { id: app.id }, data: { githubRepositoryId: 2001 } });
        await harness.db.onboardingState.update({
            where: { applicationId: app.id },
            data: { step: "completed" },
        });
        await harness.services.github.handleInstallation(44444, harness.organizationId, {
            login: "trig-org",
            id: 888,
            type: "Organization",
            createdAt: new Date(),
        });
        return { app };
    },
    cases: (test) => {
        test("started: a new PR head opens a run and returns the branch", async ({ harness }) => {
            const { trigger, startAnalysisRun } = makeTrigger(harness);
            const receipt = await trigger.deliver({
                organizationId: harness.organizationId,
                locator: { kind: "pr", repoId: 2001, prNumber: 10 },
                kind: "push",
                source: "webhook",
                requested: false,
                deployment: { url: "https://preview.example.com" },
            });

            expect(receipt.status).toBe("started");
            if (receipt.status !== "started") throw new Error("unreachable");
            expect(receipt.branchId).toBeDefined();
            expect(receipt.workflowId).toBe("wf-1");
            expect(startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: receipt.branchId, headSha: "head-sha-10" }),
            );
            const branch = await harness.db.branch.findUniqueOrThrow({ where: { id: receipt.branchId } });
            expect(branch.deploymentId).not.toBeNull();
        });

        test("skipped(not_gone_live): an un-live app refuses before a branch exists", async ({
            harness,
            seedResult: { app },
        }) => {
            await harness.db.onboardingState.update({
                where: { applicationId: app.id },
                data: { step: "previewkit_configuring" },
            });
            const { trigger, startAnalysisRun } = makeTrigger(harness);
            try {
                const receipt = await trigger.deliver({
                    organizationId: harness.organizationId,
                    locator: { kind: "pr", repoId: 2001, prNumber: 20 },
                    kind: "push",
                    source: "webhook",
                    requested: false,
                });
                expect(receipt).toEqual({ status: "skipped", reason: "not_gone_live" });
                expect(startAnalysisRun).not.toHaveBeenCalled();
                const branch = await harness.db.branch.findFirst({
                    where: { applicationId: app.id, prInfo: { prNumber: 20 } },
                });
                expect(branch).toBeNull();
            } finally {
                await harness.db.onboardingState.update({
                    where: { applicationId: app.id },
                    data: { step: "completed" },
                });
            }
        });

        test("attached: a second requested delivery joins the in-flight run for the same head", async ({ harness }) => {
            const { trigger } = makeTrigger(harness);
            const request = {
                organizationId: harness.organizationId,
                locator: { kind: "pr", repoId: 2001, prNumber: 30 },
                kind: "explicit_request",
                source: "webhook",
                requested: true,
                deployment: { url: "https://preview.example.com" },
            } as const;
            const first = await trigger.deliver(request);
            expect(first.status).toBe("started");
            if (first.status !== "started") throw new Error("unreachable");
            await openRunFor(harness.db, first.branchId, "head-sha-30");

            const second = await trigger.deliver(request);
            expect(second).toEqual({ status: "attached", branchId: first.branchId });
        });

        test("deferred(activation_gated): activation persists the event and starts no run", async ({ harness }) => {
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });
            const { trigger, startAnalysisRun } = makeTrigger(harness);
            try {
                const receipt = await trigger.deliver({
                    organizationId: harness.organizationId,
                    locator: { kind: "pr", repoId: 2001, prNumber: 40 },
                    kind: "push",
                    source: "webhook",
                    requested: false,
                    deployment: { url: "https://preview.example.com" },
                });
                expect(receipt.status).toBe("deferred");
                if (receipt.status !== "deferred") throw new Error("unreachable");
                expect(receipt.reason).toBe("activation_gated");
                expect(startAnalysisRun).not.toHaveBeenCalled();
                const events = await harness.db.analysisEvent.findMany({ where: { branchId: receipt.branchId } });
                expect(events).toHaveLength(1);
            } finally {
                await harness.db.organizationSettings.update({
                    where: { organizationId: harness.organizationId },
                    data: { activationEnabled: false },
                });
            }
        });

        // Out of credits returns a receipt (never throws): the event persists so a top-up can re-poke, and the
        // deployment coordinate is recorded before the gate.
        test("deferred(out_of_credits_analysis): persists the event, records the block, starts no run", async ({
            harness,
            seedResult: { app },
        }) => {
            const { trigger, startAnalysisRun } = makeTrigger(harness, denyGate);
            const receipt = await trigger.deliver({
                organizationId: harness.organizationId,
                locator: { kind: "pr", repoId: 2001, prNumber: 50 },
                kind: "push",
                source: "webhook",
                requested: false,
                deployment: { url: "https://preview.example.com" },
            });

            expect(receipt.status).toBe("deferred");
            if (receipt.status !== "deferred") throw new Error("unreachable");
            expect(receipt.reason).toBe("out_of_credits_analysis");
            expect(startAnalysisRun).not.toHaveBeenCalled();
            const branch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: app.id, prInfo: { prNumber: 50 } },
                select: { id: true, lastBlockedReason: true, deployment: { select: { headSha: true } } },
            });
            expect(branch.lastBlockedReason).toBe("insufficient_credits");
            expect(branch.deployment?.headSha).toBe("head-sha-50");
            const events = await harness.db.analysisEvent.findMany({ where: { branchId: branch.id } });
            expect(events).toHaveLength(1);
        });

        test("refused(no_application_linked): an unlinked repo names no run", async ({ harness }) => {
            const { trigger } = makeTrigger(harness);
            const receipt = await trigger.deliver({
                organizationId: harness.organizationId,
                locator: { kind: "pr", repoId: 9999, prNumber: 10 },
                kind: "push",
                source: "webhook",
                requested: false,
            });
            expect(receipt).toEqual({ status: "refused", reason: "no_application_linked" });
        });

        test("refused(unsupported_ref): a ref that is neither trunk nor a PR", async ({ harness }) => {
            const { trigger } = makeTrigger(harness);
            const receipt = await trigger.deliver({
                organizationId: harness.organizationId,
                locator: { kind: "ref", repoId: 2001, githubRef: "feature/random" },
                kind: "push",
                source: "webhook",
                requested: false,
            });
            expect(receipt).toEqual({ status: "refused", reason: "unsupported_ref" });
        });

        test("started: a main push opens a baseline run even under activation", async ({
            harness,
            seedResult: { app },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/trig-repo", "main", "main-head-1");
            const mainBranch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: app.id, mainInfo: { isNot: null } },
                select: { id: true, activeSnapshotId: true },
            });
            await harness.db.branchSnapshot.update({
                where: { id: mainBranch.activeSnapshotId! },
                data: { headSha: "previous-main-sha" },
            });
            const { trigger, startAnalysisRun } = makeTrigger(harness);
            const receipt = await trigger.deliver({
                organizationId: harness.organizationId,
                locator: { kind: "main", repoId: 2001 },
                kind: "push",
                source: "webhook",
                requested: false,
            });
            expect(receipt.status).toBe("started");
            expect(startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: mainBranch.id, headSha: "main-head-1" }),
            );
        });

        // The baseline snapshot is established at go-live, so a not-live main push has no base to diff against:
        // it skips (carrying its branch) and enqueues nothing.
        test("skipped(not_gone_live): a main push while the app is still being set up", async ({
            harness,
            seedResult: { app },
        }) => {
            const mainBranch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: app.id, mainInfo: { isNot: null } },
                select: { id: true },
            });
            await harness.db.analysisEvent.deleteMany({ where: { branchId: mainBranch.id } });
            await harness.db.onboardingState.update({
                where: { applicationId: app.id },
                data: { step: "previewkit_configuring" },
            });
            const { trigger, startAnalysisRun } = makeTrigger(harness);
            try {
                const receipt = await trigger.deliver({
                    organizationId: harness.organizationId,
                    locator: { kind: "main", repoId: 2001 },
                    kind: "push",
                    source: "webhook",
                    requested: false,
                });
                expect(receipt).toEqual({ status: "skipped", reason: "not_gone_live", branchId: mainBranch.id });
                expect(startAnalysisRun).not.toHaveBeenCalled();
                const events = await harness.db.analysisEvent.findMany({ where: { branchId: mainBranch.id } });
                expect(events).toHaveLength(0);
            } finally {
                await harness.db.onboardingState.update({
                    where: { applicationId: app.id },
                    data: { step: "completed" },
                });
            }
        });

        // The base-not-trunk gate is absolute: it refuses even an explicit request, before a branch is created.
        test("refused(base_not_trunk): an off-trunk PR under an enforcing org", async ({
            harness,
            seedResult: { app },
        }) => {
            await harness.db.mainBranchInfo.update({
                where: { applicationId: app.id },
                data: { githubRef: "develop" },
            });
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, enforceBaseTrunkGate: true },
                update: { enforceBaseTrunkGate: true },
            });
            const { trigger, startAnalysisRun } = makeTrigger(harness);
            try {
                const receipt = await trigger.deliver({
                    organizationId: harness.organizationId,
                    locator: { kind: "pr", repoId: 2001, prNumber: 70 },
                    kind: "explicit_request",
                    source: "webhook",
                    requested: true,
                });
                expect(receipt).toEqual({ status: "refused", reason: "base_not_trunk" });
                expect(startAnalysisRun).not.toHaveBeenCalled();
                const branch = await harness.db.branch.findFirst({
                    where: { applicationId: app.id, prInfo: { prNumber: 70 } },
                });
                expect(branch).toBeNull();
            } finally {
                await harness.db.mainBranchInfo.update({
                    where: { applicationId: app.id },
                    data: { githubRef: "main" },
                });
                await harness.db.organizationSettings.update({
                    where: { organizationId: harness.organizationId },
                    data: { enforceBaseTrunkGate: false },
                });
            }
        });

        test("skipped(already_analyzed): a re-delivered webhook for an unchanged head", async ({
            harness,
            seedResult: { app },
        }) => {
            const branch = await harness.db.branch.create({
                data: {
                    name: "feature/branch-61",
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    prInfo: { create: { applicationId: app.id, prNumber: 61 } },
                },
                select: { id: true },
            });
            const analyzed = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, status: "active", source: TriggerSource.WEBHOOK, headSha: "head-sha-61" },
                select: { id: true },
            });
            await harness.db.branch.update({ where: { id: branch.id }, data: { activeSnapshotId: analyzed.id } });
            const { trigger, startAnalysisRun } = makeTrigger(harness);

            const receipt = await trigger.deliver({
                organizationId: harness.organizationId,
                locator: { kind: "pr", repoId: 2001, prNumber: 61 },
                kind: "explicit_request",
                source: "webhook",
                requested: true,
            });

            expect(receipt).toEqual({ status: "skipped", reason: "already_analyzed", branchId: branch.id });
            expect(startAnalysisRun).not.toHaveBeenCalled();
        });

        // The credits block lifecycle: a deferred out-of-credits push records the block; a later delivery once
        // credits are restored starts the run and clears it.
        test("out-of-credits records a block that a restored balance clears on the next delivery", async ({
            harness,
            seedResult: { app },
        }) => {
            const dbBalanceGate = {
                checkAnalysisCreditsGate: async (organizationId: string) => {
                    const customer = await harness.db.billingCustomer.findUnique({
                        where: { organizationId },
                        select: { creditBalance: true, creditFloor: true },
                    });
                    const balance = customer?.creditBalance ?? 0;
                    const floor = customer?.creditFloor ?? 0;
                    return balance <= floor
                        ? { allowed: false as const, reason: "out_of_credits" as const }
                        : { allowed: true as const };
                },
            };
            const { trigger } = makeTrigger(harness, dbBalanceGate);
            await harness.db.billingCustomer.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, creditBalance: 0, creditFloor: 0 },
                update: { creditBalance: 0, creditFloor: 0 },
            });

            const occurrence = {
                organizationId: harness.organizationId,
                locator: { kind: "pr", repoId: 2001, prNumber: 62 },
                kind: "push",
                source: "webhook",
                requested: false,
            } as const;

            const deferred = await trigger.deliver(occurrence);
            expect(deferred).toMatchObject({ status: "deferred", reason: "out_of_credits_analysis" });
            const blocked = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: app.id, prInfo: { prNumber: 62 } },
                select: { id: true, lastBlockedReason: true },
            });
            expect(blocked.lastBlockedReason).toBe("insufficient_credits");

            await harness.db.billingCustomer.update({
                where: { organizationId: harness.organizationId },
                data: { creditBalance: 1000 },
            });

            const started = await trigger.deliver(occurrence);
            expect(started).toEqual({ status: "started", branchId: blocked.id, workflowId: "wf-1" });
            const cleared = await harness.db.branch.findUniqueOrThrow({
                where: { id: blocked.id },
                select: { lastBlockedReason: true, lastBlockedAt: true },
            });
            expect(cleared.lastBlockedReason).toBeNull();
            expect(cleared.lastBlockedAt).toBeNull();
        });
    },
});
