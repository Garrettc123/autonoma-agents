import { AnalysisEventStore } from "@autonoma/analysis";
import { type BillingService, type CreditsGrantedHook, createBillingService } from "@autonoma/billing";
import { type PrismaClient, db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type AnalysisRunWorkflowInput, triggerAnalysisRun } from "@autonoma/workflow";
import { analysisPokeGate } from "./analysis-poke-gate";

interface AnalysisCreditTopUpRepokerDeps {
    db: PrismaClient;
    events: AnalysisEventStore;
    billingService: Pick<BillingService, "checkAnalysisCreditsGate">;
    startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<unknown>;
}

/**
 * Drains the inbox on a credit top-up: re-pokes the analysis runs an org deferred while out of credits. The billing
 * service fires this after a grant; it is the sweeper half of the shared {@link analysisPokeGate} - a producer defers
 * exactly the branches this later re-pokes, so "we cannot run now" and "we can run now" are decided the same way.
 */
export class AnalysisCreditTopUpRepoker {
    private readonly logger: Logger;
    private readonly db: PrismaClient;
    private readonly events: AnalysisEventStore;
    private readonly billingService: Pick<BillingService, "checkAnalysisCreditsGate">;
    private readonly startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<unknown>;

    constructor(deps: AnalysisCreditTopUpRepokerDeps) {
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.db = deps.db;
        this.events = deps.events;
        this.billingService = deps.billingService;
        this.startAnalysisRun = deps.startAnalysisRun;
    }

    /**
     * Start one run per branch that has a pending event, on that branch's newest pending head; the run claims the
     * pending events when it opens its snapshot. A no-op when the org still cannot run automatically (activation-gated,
     * or the balance is still at the floor), so a partial top-up that clears nothing pokes nothing.
     */
    public async repokeOrganization(organizationId: string): Promise<void> {
        this.logger.info("Re-poking deferred analysis after a credit change", { organization: { organizationId } });

        const decision = await analysisPokeGate(
            { db: this.db, billingService: this.billingService },
            { organizationId, requested: false, autoRunOnReady: false },
        );
        if (!decision.poke) {
            this.logger.info("Not re-poking: the organization cannot run an automatic analysis yet", {
                organization: { organizationId },
                extra: { reason: decision.reason },
            });
            return;
        }

        const pending = await this.events.listPendingBranchHeads(organizationId);
        if (pending.length === 0) {
            this.logger.info("No branches with pending events; nothing to re-poke", {
                organization: { organizationId },
            });
            return;
        }

        this.logger.info("Re-poking branches with pending events", {
            organization: { organizationId },
            extra: { branchCount: pending.length },
        });

        // Independent per-branch triggers: settle all so one branch's failure cannot strand the rest.
        const results = await Promise.allSettled(
            pending.map((head) =>
                this.startAnalysisRun({ branchId: head.branchId, headSha: head.headSha, baseSha: head.baseSha }),
            ),
        );
        for (const [index, result] of results.entries()) {
            if (result.status === "rejected") {
                this.logger.error("Failed to re-poke a branch after credit top-up", {
                    branch: { branchId: pending[index]?.branchId },
                    organization: { organizationId },
                    err: result.reason,
                });
            }
        }
        this.logger.info("Re-poke complete", {
            organization: { organizationId },
            extra: { branchCount: pending.length },
        });
    }
}

let repokerSingleton: AnalysisCreditTopUpRepoker | undefined;

/** The process-wide re-poker over the shared db client and Temporal trigger, constructed once. */
export function getAnalysisCreditTopUpRepoker(): AnalysisCreditTopUpRepoker {
    if (repokerSingleton == null) {
        repokerSingleton = new AnalysisCreditTopUpRepoker({
            db,
            events: new AnalysisEventStore(db),
            billingService: createBillingService(db),
            startAnalysisRun: triggerAnalysisRun,
        });
    }
    return repokerSingleton;
}

/** The billing `onCreditsGranted` hook wired to the re-poker - shared by every credit-grant webhook seam. */
export const repokeAnalysisOnCreditsGranted: CreditsGrantedHook = (organizationId) =>
    getAnalysisCreditTopUpRepoker().repokeOrganization(organizationId);
