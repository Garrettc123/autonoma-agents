import type { CostRecord } from "@autonoma/ai";
import { CreditTransactionType, type PrismaClient } from "@autonoma/db";
import { getObservabilityContext, type Logger } from "@autonoma/logger";
import { BillingPricingService } from "./billing-pricing.service";
import { usdToCreditCost } from "./billing-utils";
import { deductCreditsFloored } from "./credits-deduction";
import { CreditsExhaustedError } from "./credits-exhausted-error";

const MICRODOLLARS_PER_USD = 1_000_000;

/** Exactly one of these identifies which entity a batch of AI calls' cost belongs to. */
export interface AiCostAnchor {
    generationId?: string;
    investigationSnapshotId?: string;
}

/**
 * Persist a batch of metered AI-call cost records as `AiCostRecord` rows, stamped with the
 * caller's org - resolved from the ambient observability context (bound by the Temporal
 * activity interceptor whenever the activity's input carries a
 * `snapshotId`/`testGenerationId`/`generationId`), never passed as a parameter here. This is
 * what makes org attribution transparent to a new job: call this with a `CostCollector`'s
 * records and an anchor, and the org is stamped correctly with no org to resolve.
 *
 * Also deducts the batch's total cost from the org's balance (floored at their `creditFloor`,
 * never blocking) - see `deductCreditsForAiCost` below.
 */
export async function persistAiCosts(
    db: PrismaClient,
    records: readonly CostRecord[],
    anchor: AiCostAnchor,
    logger: Logger,
): Promise<void> {
    if (records.length === 0) return;

    const organizationId = getObservabilityContext().organization?.organizationId;
    if (organizationId == null) {
        logger.warn("No organizationId in observability context - skipping AI cost persistence", {
            extra: { anchor },
        });
        return;
    }

    const createdRecords = await db.aiCostRecord.createManyAndReturn({
        data: records.map((record) => ({
            ...anchor,
            organizationId,
            model: record.model,
            tag: record.tag,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            reasoningTokens: record.reasoningTokens,
            cacheReadTokens: record.cacheReadTokens,
            costMicrodollars: record.costMicrodollars,
        })),
        select: { id: true },
    });

    const costMicrodollars = records.reduce((sum, record) => sum + record.costMicrodollars, 0);
    logger.info("Persisted AI costs", { extra: { count: records.length, costMicrodollars, anchor } });

    await deductCreditsForAiCost(
        db,
        organizationId,
        createdRecords.map((record) => record.id),
        costMicrodollars,
        logger,
    );
}

/**
 * Deducts one batch's total AI cost, converted to credits by `usdToCreditCost` - the same rate
 * top-ups are priced at, shared with `deductCreditsForLlmProxy`. Best-effort: not every
 * `persistAiCosts` call site wraps it in its own `.catch`, so a throw here would fail a whole
 * Temporal activity over a billing side-effect - a silently-missed deduction is an acceptable,
 * recoverable gap for what is otherwise a recording-only cost.
 *
 * Idempotent on the batch's own (sorted) first created row id, which only guards a repeat of this
 * exact call. It deliberately does NOT key off the anchor (`generationId`/`investigationSnapshotId`):
 * a Temporal retry re-runs the AI calls and really does spend the money again, so its fresh batch is
 * new spend to charge, not a duplicate of the previous attempt to suppress.
 *
 * Best-effort covers deduction *failures* only. A deduction that SUCCEEDS and in doing so crosses a
 * zero-tolerance org's floor throws {@link CreditsExhaustedError}, deliberately outside the
 * try/catch: that is a business signal, not a billing hiccup, and the calling activity rethrows it
 * (wrapped as an `ApplicationFailure`) so the workflow can kill the run rather than let it finish.
 */
async function deductCreditsForAiCost(
    db: PrismaClient,
    organizationId: string,
    aiCostRecordIds: string[],
    costMicrodollars: number,
    logger: Logger,
): Promise<void> {
    if (costMicrodollars <= 0) return;
    const [firstId] = [...aiCostRecordIds].sort();
    if (firstId == null) return;

    let crossedIntoExhaustion = false;
    try {
        const pricing = await new BillingPricingService(db).getOrCreatePricing(organizationId);
        const cost = usdToCreditCost(costMicrodollars / MICRODOLLARS_PER_USD, pricing);
        if (cost == null) {
            logger.warn("Organization has no usable credits-per-USD rate or markup, skipping AI cost deduction", {
                extra: {
                    organizationId,
                    creditsPerTopup: pricing.creditsPerTopup,
                    stripeTopupAmountCents: pricing.stripeTopupAmountCents,
                    meteredMarkupBps: pricing.meteredMarkupBps,
                    costMicrodollars,
                },
            });
            return;
        }

        const result = await deductCreditsFloored(
            db,
            {
                organizationId,
                transactionId: `ctr_ai_${firstId}`,
                transactionType: CreditTransactionType.AI_COST_CONSUMPTION,
                cost,
                fkColumn: { name: "ai_cost_record_id", value: firstId },
            },
            logger,
        );
        crossedIntoExhaustion = result.crossedIntoExhaustion;
    } catch (err) {
        logger.warn("Failed to deduct AI cost credits, continuing without deduction", {
            extra: { organizationId, aiCostRecordIds, costMicrodollars, err },
        });
        return;
    }

    if (crossedIntoExhaustion) {
        logger.warn("Organization crossed its zero-tolerance credit floor mid-run", {
            extra: { organizationId, aiCostRecordIds },
        });
        throw new CreditsExhaustedError("Organization ran out of credits mid-run", organizationId);
    }
}
