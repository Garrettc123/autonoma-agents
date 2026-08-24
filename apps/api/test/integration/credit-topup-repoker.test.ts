import { AnalysisEventStore } from "@autonoma/analysis";
import type { AnalysisCreditsGateResult } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { expect, vi } from "vitest";
import { AnalysisCreditTopUpRepoker } from "../../src/analysis/credit-topup-repoker";
import { apiTestSuite } from "../api-test";

const allowGate = { checkAnalysisCreditsGate: async (): Promise<AnalysisCreditsGateResult> => ({ allowed: true }) };
const denyGate = {
    checkAnalysisCreditsGate: async (): Promise<AnalysisCreditsGateResult> => ({
        allowed: false,
        reason: "out_of_credits",
    }),
};

let seq = 0;

/** A fresh org/app/branch, optionally activation-gated, optionally carrying one pending commit event. */
async function seedBranch(
    db: PrismaClient,
    events: AnalysisEventStore,
    options: { pendingHead?: string; activationGated?: boolean } = {},
): Promise<{ organizationId: string; branchId: string }> {
    const n = seq++;
    const org = await db.organization.create({
        data: { name: `Repoke Org ${n}`, slug: `repoke-org-${n}-${Date.now()}` },
    });
    const app = await db.application.create({
        data: { name: `App ${n}`, slug: `repoke-app-${n}-${Date.now()}`, organizationId: org.id, architecture: "WEB" },
    });
    const branch = await db.branch.create({
        data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
    });
    if (options.activationGated === true) {
        await db.organizationSettings.create({ data: { organizationId: org.id, activationEnabled: true } });
    }
    if (options.pendingHead != null) {
        await events.enqueue({
            branchId: branch.id,
            organizationId: org.id,
            source: "webhook",
            event: { type: "commits_pushed", payload: { headSha: options.pendingHead } },
        });
    }
    return { organizationId: org.id, branchId: branch.id };
}

apiTestSuite({
    name: "AnalysisCreditTopUpRepoker",
    cases: (test) => {
        test("re-pokes only the branches that have a pending event, on their newest head", async ({ harness }) => {
            const events = new AnalysisEventStore(harness.db);
            const startAnalysisRun = vi.fn().mockResolvedValue(undefined);
            const { organizationId, branchId } = await seedBranch(harness.db, events, { pendingHead: "head-pending" });
            // A second branch in the same org with nothing pending must not be poked.
            const app = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { applicationId: true },
            });
            const idleBranch = await harness.db.branch.create({
                data: { name: "feature/idle", applicationId: app.applicationId, organizationId },
                select: { id: true },
            });

            const repoker = new AnalysisCreditTopUpRepoker({
                db: harness.db,
                events,
                billingService: allowGate,
                startAnalysisRun,
            });
            await repoker.repokeOrganization(organizationId);

            expect(startAnalysisRun).toHaveBeenCalledTimes(1);
            expect(startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId, headSha: "head-pending" }),
            );
            expect(startAnalysisRun).not.toHaveBeenCalledWith(expect.objectContaining({ branchId: idleBranch.id }));
        });

        test("does not re-poke when the organization is still out of credits", async ({ harness }) => {
            const events = new AnalysisEventStore(harness.db);
            const startAnalysisRun = vi.fn().mockResolvedValue(undefined);
            const { organizationId } = await seedBranch(harness.db, events, { pendingHead: "head-a" });

            const repoker = new AnalysisCreditTopUpRepoker({
                db: harness.db,
                events,
                billingService: denyGate,
                startAnalysisRun,
            });
            await repoker.repokeOrganization(organizationId);

            expect(startAnalysisRun).not.toHaveBeenCalled();
        });

        // Activation-gated events wait for an explicit request, never a top-up, so the sweeper leaves them pending.
        test("does not re-poke an activation-gated organization", async ({ harness }) => {
            const events = new AnalysisEventStore(harness.db);
            const startAnalysisRun = vi.fn().mockResolvedValue(undefined);
            const { organizationId } = await seedBranch(harness.db, events, {
                pendingHead: "head-a",
                activationGated: true,
            });

            const repoker = new AnalysisCreditTopUpRepoker({
                db: harness.db,
                events,
                billingService: allowGate,
                startAnalysisRun,
            });
            await repoker.repokeOrganization(organizationId);

            expect(startAnalysisRun).not.toHaveBeenCalled();
        });
    },
});
