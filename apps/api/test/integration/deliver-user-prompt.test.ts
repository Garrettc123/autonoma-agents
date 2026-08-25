import { AnalysisEventStore } from "@autonoma/analysis";
import type { AnalysisCreditsGateResult, BillingService } from "@autonoma/billing";
import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect, vi } from "vitest";
import { DeliverUserPromptService } from "../../src/analysis/deliver-user-prompt.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const allowGate: Pick<BillingService, "checkAnalysisCreditsGate"> = {
    checkAnalysisCreditsGate: async (): Promise<AnalysisCreditsGateResult> => ({ allowed: true }),
};

const outOfCreditsGate: Pick<BillingService, "checkAnalysisCreditsGate"> = {
    checkAnalysisCreditsGate: async (): Promise<AnalysisCreditsGateResult> => ({
        allowed: false,
        reason: "out_of_credits",
    }),
};

function buildService(
    harness: APITestHarness,
    gate: Pick<BillingService, "checkAnalysisCreditsGate">,
): { service: DeliverUserPromptService; signal: ReturnType<typeof vi.fn> } {
    const signal = vi.fn().mockResolvedValue("analysis-run-workflow-id");
    const service = new DeliverUserPromptService(
        harness.db,
        harness.services.github,
        gate,
        signal,
        new AnalysisEventStore(harness.db),
    );
    return { service, signal };
}

apiTestSuite({
    name: "DeliverUserPromptService",
    seed: async ({ harness }) => {
        const fakeClient = harness.githubApp.defaultClient;
        fakeClient.addRepository({
            id: 2001,
            name: "prompt-repo",
            fullName: "org/prompt-repo",
            defaultBranch: "main",
            commits: ["initial-sha"],
        });
        for (const prNum of [10, 20, 30, 40, 50]) {
            fakeClient.addPullRequest("org/prompt-repo", {
                number: prNum,
                title: `Test PR #${prNum}`,
                headRef: `feature/branch-${prNum}`,
                baseSha: "initial-sha",
                commits: [`head-sha-${prNum}`],
            });
        }

        const app = await harness.services.applications.createApplication({
            name: "Prompt App",
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
            login: "prompt-org",
            id: 888,
            type: "Organization",
            createdAt: new Date(),
        });

        return { app };
    },
    cases: (test) => {
        test("delivers a message on an idle branch: persists a pending user_prompt event and signals the run", async ({
            harness,
        }) => {
            const { service, signal } = buildService(harness, allowGate);

            const receipt = await service.deliverUserPrompt({
                organizationId: harness.organizationId,
                repoId: 2001,
                prNumber: 10,
                text: "Focus on the checkout flow, I just fixed the tax calculation.",
                author: "conversation-agent",
                source: "mcp",
            });

            expect(receipt.status).toBe("started");
            if (receipt.status !== "started") throw new Error("expected started");

            const events = await harness.db.analysisEvent.findMany({ where: { branchId: receipt.branchId } });
            expect(events).toHaveLength(1);
            expect(events[0]!.type).toBe("user_prompt");
            expect(events[0]!.source).toBe("mcp");
            expect(events[0]!.claimedBySnapshotId).toBeNull();
            expect(events[0]!.payload).toEqual({
                text: "Focus on the checkout flow, I just fixed the tax calculation.",
                author: "conversation-agent",
            });
            expect(signal).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: receipt.branchId, headSha: "head-sha-10" }),
            );
        });

        test("starts a run under activation (requested-like bypass)", async ({ harness }) => {
            const { service, signal } = buildService(harness, allowGate);
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });

            try {
                const receipt = await service.deliverUserPrompt({
                    organizationId: harness.organizationId,
                    repoId: 2001,
                    prNumber: 20,
                    text: "Please re-check the billing page.",
                    author: "plugin",
                    source: "mcp",
                });
                expect(receipt.status).toBe("started");
                expect(signal).toHaveBeenCalledTimes(1);
            } finally {
                await harness.db.organizationSettings.update({
                    where: { organizationId: harness.organizationId },
                    data: { activationEnabled: false },
                });
            }
        });

        test("defers when the org is out of credits: event persisted, no signal, reason out_of_credits", async ({
            harness,
        }) => {
            const { service, signal } = buildService(harness, outOfCreditsGate);

            const receipt = await service.deliverUserPrompt({
                organizationId: harness.organizationId,
                repoId: 2001,
                prNumber: 30,
                text: "Re-run the login flow.",
                author: "plugin",
                source: "http",
            });

            expect(receipt).toMatchObject({ status: "deferred", reason: "out_of_credits" });
            if (receipt.status !== "deferred") throw new Error("expected deferred");
            expect(signal).not.toHaveBeenCalled();

            const events = await harness.db.analysisEvent.findMany({ where: { branchId: receipt.branchId } });
            expect(events).toHaveLength(1);
            expect(events[0]!.type).toBe("user_prompt");
            expect(events[0]!.claimedBySnapshotId).toBeNull();
        });

        test("refuses an un-onboarded application: nothing enqueued, no signal", async ({
            harness,
            seedResult: { app },
        }) => {
            const { service, signal } = buildService(harness, allowGate);
            await harness.db.onboardingState.update({
                where: { applicationId: app.id },
                data: { step: "previewkit_configuring" },
            });

            try {
                const receipt = await service.deliverUserPrompt({
                    organizationId: harness.organizationId,
                    repoId: 2001,
                    prNumber: 40,
                    text: "Cover the onboarding flow.",
                    author: "plugin",
                    source: "mcp",
                });

                expect(receipt).toEqual({ status: "refused", reason: "not_onboarded" });
                expect(signal).not.toHaveBeenCalled();
                const branch = await harness.db.branch.findFirst({
                    where: { applicationId: app.id, prInfo: { prNumber: 40 } },
                    select: { id: true },
                });
                expect(branch).toBeNull();
            } finally {
                await harness.db.onboardingState.update({
                    where: { applicationId: app.id },
                    data: { step: "completed" },
                });
            }
        });

        test("refuses a closed PR with nothing enqueued", async ({ harness, seedResult: { app } }) => {
            const { service, signal } = buildService(harness, allowGate);
            harness.githubApp.defaultClient.setPullRequestState("org/prompt-repo", 50, "closed");

            const receipt = await service.deliverUserPrompt({
                organizationId: harness.organizationId,
                repoId: 2001,
                prNumber: 50,
                text: "Anything at all.",
                author: "plugin",
                source: "mcp",
            });

            expect(receipt).toEqual({ status: "refused", reason: "pr_closed" });
            expect(signal).not.toHaveBeenCalled();
            const branch = await harness.db.branch.findFirst({
                where: { applicationId: app.id, prInfo: { prNumber: 50 } },
                select: { id: true },
            });
            expect(branch).toBeNull();
        });

        test("refuses a merged PR with nothing enqueued", async ({ harness }) => {
            const { service, signal } = buildService(harness, allowGate);
            harness.githubApp.defaultClient.addPullRequest("org/prompt-repo", {
                number: 55,
                title: "Merged PR",
                headRef: "feature/branch-55",
                baseSha: "initial-sha",
                commits: ["head-sha-55"],
                state: "merged",
            });

            const receipt = await service.deliverUserPrompt({
                organizationId: harness.organizationId,
                repoId: 2001,
                prNumber: 55,
                text: "Anything at all.",
                author: "plugin",
                source: "mcp",
            });

            expect(receipt).toEqual({ status: "refused", reason: "pr_merged" });
            expect(signal).not.toHaveBeenCalled();
        });

        test("throws NotFoundError when no application is linked to the repo", async ({ harness }) => {
            const { service } = buildService(harness, allowGate);
            await expect(
                service.deliverUserPrompt({
                    organizationId: harness.organizationId,
                    repoId: 9999,
                    prNumber: 10,
                    text: "Anything.",
                    author: "plugin",
                    source: "mcp",
                }),
            ).rejects.toThrow(NotFoundError);
        });
    },
});
