import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { isActivationGated } from "./is-activation-gated";

/**
 * Why the gate declined to poke now:
 * - `activation_gated`: the org runs only on an explicit request; the event waits for that request to claim it.
 * - `out_of_credits`: the org is at its credit floor; the event waits until its balance clears the floor.
 */
export type AnalysisPokeDeferralReason = "activation_gated" | "out_of_credits";

/** Whether a push may wake the analysis workflow now, or must persist as a pending event and wait. */
export type AnalysisPokeDecision = { poke: true } | { poke: false; reason: AnalysisPokeDeferralReason };

export interface AnalysisPokeGateDeps {
    db: PrismaClient;
    billingService: Pick<BillingService, "checkAnalysisCreditsGate">;
}

export interface AnalysisPokeContext {
    organizationId: string;
    /** An explicit request (label/comment/UI/MCP) bypasses activation, but still respects the credit floor. */
    requested: boolean;
    /** A per-app opt-in that lets an automatic preview-ready run through under activation. */
    autoRunOnReady: boolean;
}

/**
 * The one poke-eligibility predicate, shared by every producer and the credit-top-up sweeper (which calls it with
 * `requested`/`autoRunOnReady` false). Activation is checked before credits so an activation-gated org's deferred
 * events wait for its explicit request rather than for a top-up that would never poke them.
 */
export async function analysisPokeGate(
    deps: AnalysisPokeGateDeps,
    { organizationId, requested, autoRunOnReady }: AnalysisPokeContext,
): Promise<AnalysisPokeDecision> {
    const activationBypassed = requested || autoRunOnReady;
    if (!activationBypassed && (await isActivationGated(deps.db, organizationId))) {
        return { poke: false, reason: "activation_gated" };
    }

    const gate = await deps.billingService.checkAnalysisCreditsGate(organizationId);
    if (!gate.allowed) return { poke: false, reason: "out_of_credits" };

    return { poke: true };
}
