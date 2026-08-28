import { CreditTransactionType, type PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { BillingPricingService } from "./billing-pricing.service";
import { computePreviewUsageMicroCredits } from "./billing-utils";
import { deductCreditsFloored } from "./credits-deduction";

/**
 * Deducts one previewkit app build's measured compute (vCPU-seconds/GB-seconds), at the org's flat
 * per-hour prices - same pricing function `deductCreditsForPreviewUsage` uses for running instances,
 * just for build compute instead. Floors at the org's `creditFloor` rather than requiring
 * sufficiency, same as every other usage-based deduction. Idempotent on `appBuildId` (one deduction
 * per build, however many times the caller retries recording its usage).
 *
 * A standalone function rather than a `CreditsService` method: `apps/previewkit`'s runner doesn't
 * have a fully-wired `CreditsService` (no `AutoTopUpService`/`VercelOverageService` there), so this
 * only needs a bare `PrismaClient` plus the pricing lookup, mirroring how `persistAiCosts` deducts
 * AI cost without needing a full `CreditsService` either.
 */
export async function deductCreditsForBuildUsage(
    db: PrismaClient,
    organizationId: string,
    appBuildId: string,
    vcpuSeconds: number,
    gbSeconds: number,
    logger: Logger,
): Promise<void> {
    const pricing = await new BillingPricingService(db).getOrCreatePricing(organizationId);
    const costMicroCredits = computePreviewUsageMicroCredits(vcpuSeconds, gbSeconds, pricing);

    if (costMicroCredits == null) {
        logger.warn("Skipping build usage deduction - organization has no usable credits-per-USD rate", {
            organizationId,
            extra: { appBuildId, vcpuSeconds, gbSeconds },
        });
        return;
    }

    if (costMicroCredits <= 0) {
        logger.info("Skipping build usage deduction for non-positive cost", {
            organizationId,
            extra: { appBuildId, vcpuSeconds, gbSeconds, costMicroCredits },
        });
        return;
    }

    await deductCreditsFloored(
        db,
        {
            organizationId,
            transactionId: `ctr_build_${appBuildId}`,
            transactionType: CreditTransactionType.PREVIEW_BUILD_CONSUMPTION,
            costMicroCredits,
            fkColumn: { name: "previewkit_app_build_id", value: appBuildId },
        },
        logger,
    );
}
