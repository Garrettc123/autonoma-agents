import type { BillingService } from "@autonoma/billing";
import { computePreviewUsageCost } from "@autonoma/billing";
import { Prisma, type PrismaClient } from "@autonoma/db";
import { Service } from "../service";

export interface BranchAiCostTag {
    tag: string;
    calls: number;
    costMicrodollars: number;
    inputTokens: number;
    outputTokens: number;
}

export interface BranchAiCostSummary {
    totalCalls: number;
    totalCostMicrodollars: number;
    byTag: BranchAiCostTag[];
}

function mergeByTag(tags: readonly BranchAiCostTag[]): BranchAiCostTag[] {
    const byTag = new Map<string, BranchAiCostTag>();

    for (const tag of tags) {
        const existing = byTag.get(tag.tag);
        if (existing == null) {
            byTag.set(tag.tag, tag);
            continue;
        }
        existing.calls += tag.calls;
        existing.costMicrodollars += tag.costMicrodollars;
        existing.inputTokens += tag.inputTokens;
        existing.outputTokens += tag.outputTokens;
    }

    return [...byTag.values()];
}

export interface EnvironmentComputeUsage {
    build: {
        vcpuSeconds: number;
        gbSeconds: number;
        buildCount: number;
        credits: number;
        /**
         * The real USD cost of these builds' actual instances (spot's live price, or the stable
         * on-demand price), decoupled from `credits` above - which is priced at the org's
         * deliberately-fixed `BillingPricing` rate, not what AWS actually charged. Undefined when
         * no build in the window has a recorded real cost yet.
         */
        realCostUsdMicrodollars: number | undefined;
    };
    running: { vcpuSeconds: number; gbSeconds: number; windowCount: number; credits: number };
    /**
     * The org that OWNS this environment, and whose rates the two below are read from - not
     * whichever org the viewing admin happens to be acting as. Any UI that writes a rate back must
     * target this org, or an admin switched into a different org edits the rate they are not looking at.
     */
    organizationId: string;
    organizationName: string;
    creditsPerVcpuHour: number;
    creditsPerGbMemoryHour: number;
}

/** One org's measured compute over the window, repriced at the rates being considered. */
export interface ComputeBillingProjectionRow {
    organizationId: string;
    organizationName: string;
    buildCredits: number;
    runningCredits: number;
    totalCredits: number;
    creditBalance: number;
    creditFloor: number;
    /** Where the balance would land. Below `creditFloor`, so deliberately allowed to go negative. */
    balanceAfter: number;
    /**
     * True when this charge is what CROSSES the org's floor - which blocks it from starting new
     * analysis runs, not just new previews (`checkAnalysisCreditsGate` has no feature flag). These
     * are the orgs to top up before a rate is set, not after.
     *
     * An org already at or below its floor is excluded: it is blocked either way, so counting it
     * would overstate the rate's blast radius. Those rows are still visible - `creditBalance` is
     * already at or under `creditFloor` on them.
     */
    goesUnderwater: boolean;
}

export interface ComputeBillingProjection {
    rows: ComputeBillingProjectionRow[];
    organizationsCharged: number;
    organizationsUnderwater: number;
    totalCredits: number;
    since: Date;
    until: Date;
    creditsPerVcpuHour: number;
    creditsPerGbMemoryHour: number;
}

/**
 * Admin-only visibility into what a branch/environment is actually costing - AI token
 * spend and Previewkit compute usage. Priced through the same functions and pricing
 * table billing itself uses, so this always agrees with (or explains) a future charge
 * rather than being a second, drifting computation.
 */
export class UsageService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly billing: BillingService,
    ) {
        super();
    }

    async branchAiCost(branchId: string): Promise<BranchAiCostSummary> {
        this.logger.info("Loading branch AI cost summary", { branchId });

        // Each `AiCostRecord` carries exactly one of these two anchors, so a single `OR` across both
        // relations would be correct - but Postgres's planner can't turn that `OR` into a combined
        // bitmap index scan across two different FK indexes: it falls back to a sequential scan of
        // the whole table (confirmed via EXPLAIN ANALYZE - ~10s over 4M+ rows, vs. ~6ms per anchor
        // when queried separately). Running the anchors as independent queries lets each one hit its
        // own index, and since the anchors are mutually exclusive the result sets never overlap -
        // summing them by tag is safe.
        const [byGeneration, byInvestigation] = await Promise.all([
            this.groupByTag({ generation: { snapshot: { branchId } } }),
            this.groupByTag({ investigationSnapshot: { branchId } }),
        ]);

        const byTag = mergeByTag([...byGeneration, ...byInvestigation]).sort(
            (a, b) => b.costMicrodollars - a.costMicrodollars,
        );

        this.logger.info("Loaded branch AI cost summary", { branchId, tags: byTag.length });

        return {
            totalCalls: byTag.reduce((sum, tag) => sum + tag.calls, 0),
            totalCostMicrodollars: byTag.reduce((sum, tag) => sum + tag.costMicrodollars, 0),
            byTag,
        };
    }

    private async groupByTag(where: Prisma.AiCostRecordWhereInput): Promise<BranchAiCostTag[]> {
        const rows = await this.db.aiCostRecord.groupBy({
            by: ["tag"],
            where,
            _count: { _all: true },
            _sum: { costMicrodollars: true, inputTokens: true, outputTokens: true },
        });

        return rows.map((row) => ({
            tag: row.tag,
            calls: row._count._all,
            costMicrodollars: row._sum.costMicrodollars ?? 0,
            inputTokens: row._sum.inputTokens ?? 0,
            outputTokens: row._sum.outputTokens ?? 0,
        }));
    }

    async environmentComputeUsage(environmentId: string): Promise<EnvironmentComputeUsage> {
        this.logger.info("Loading environment compute usage", { environmentId });

        const environment = await this.db.previewkitEnvironment.findUniqueOrThrow({
            where: { id: environmentId },
            select: { organizationId: true, organization: { select: { name: true } } },
        });

        const [buildUsage, runningUsage, pricing] = await Promise.all([
            this.db.previewkitAppBuildUsage.aggregate({
                where: { appBuild: { build: { environmentId } } },
                _count: { _all: true },
                _sum: { vcpuSeconds: true, gbSeconds: true, realCostUsdMicrodollars: true },
            }),
            this.db.previewkitUsageWindow.aggregate({
                where: { environmentId },
                _count: { _all: true },
                _sum: { vcpuSeconds: true, gbSeconds: true },
            }),
            this.billing.getPricing(environment.organizationId),
        ]);

        const buildVcpuSeconds = buildUsage._sum.vcpuSeconds ?? 0;
        const buildGbSeconds = buildUsage._sum.gbSeconds ?? 0;
        const runningVcpuSeconds = runningUsage._sum.vcpuSeconds ?? 0;
        const runningGbSeconds = runningUsage._sum.gbSeconds ?? 0;

        this.logger.info("Loaded environment compute usage", {
            environmentId,
            buildCount: buildUsage._count._all,
            windowCount: runningUsage._count._all,
        });

        return {
            build: {
                vcpuSeconds: buildVcpuSeconds,
                gbSeconds: buildGbSeconds,
                buildCount: buildUsage._count._all,
                credits: computePreviewUsageCost(buildVcpuSeconds, buildGbSeconds, pricing),
                realCostUsdMicrodollars: buildUsage._sum.realCostUsdMicrodollars ?? undefined,
            },
            running: {
                vcpuSeconds: runningVcpuSeconds,
                gbSeconds: runningGbSeconds,
                windowCount: runningUsage._count._all,
                credits: computePreviewUsageCost(runningVcpuSeconds, runningGbSeconds, pricing),
            },
            organizationId: environment.organizationId,
            organizationName: environment.organization.name,
            creditsPerVcpuHour: pricing.creditsPerVcpuHour,
            creditsPerGbMemoryHour: pricing.creditsPerGbMemoryHour,
        };
    }

    /**
     * What every org WOULD have been charged for compute over a window, at rates that are passed
     * in rather than read from `BillingPricing`. Compute is metered unconditionally today and only
     * priced at 0, so this is how a rate is chosen and its blast radius measured before it is set -
     * the deductions themselves have no dry-run mode and no feature flag in front of them.
     *
     * Reads only. The per-org credit totals come from `creditsByOrg`, which reprices in SQL rather
     * than through `computePreviewUsageCost` - see the note there, and the test that pins the two
     * formulas together. `balanceAfter` is deliberately NOT clamped the way the real deduction
     * clamps at `creditFloor`, so it shows how far past the floor a rate would reach.
     */
    async computeBillingProjection(input: {
        creditsPerVcpuHour: number;
        creditsPerGbMemoryHour: number;
        since: Date;
        until: Date;
    }): Promise<ComputeBillingProjection> {
        const { creditsPerVcpuHour, creditsPerGbMemoryHour, since, until } = input;
        this.logger.info("Projecting compute billing", {
            extra: { creditsPerVcpuHour, creditsPerGbMemoryHour, since, until },
        });

        const [buildRows, runningRows] = await Promise.all([
            this.creditsByOrg("previewkit_app_build_usage", input),
            this.creditsByOrg("previewkit_usage_window", input),
        ]);

        const organizationIds = [...new Set([...buildRows, ...runningRows].map((row) => row.organizationId))];
        if (organizationIds.length === 0) {
            this.logger.info("Projected compute billing - no measured usage in window");
            return {
                rows: [],
                organizationsCharged: 0,
                organizationsUnderwater: 0,
                totalCredits: 0,
                since,
                until,
                creditsPerVcpuHour,
                creditsPerGbMemoryHour,
            };
        }

        const [organizations, customers] = await Promise.all([
            this.db.organization.findMany({
                where: { id: { in: organizationIds } },
                select: { id: true, name: true },
            }),
            this.db.billingCustomer.findMany({
                where: { organizationId: { in: organizationIds } },
                select: { organizationId: true, creditBalance: true, creditFloor: true },
            }),
        ]);

        const nameByOrg = new Map(organizations.map((org) => [org.id, org.name]));
        const customerByOrg = new Map(customers.map((customer) => [customer.organizationId, customer]));
        const buildCreditsByOrg = new Map(buildRows.map((row) => [row.organizationId, row.credits]));
        const runningCreditsByOrg = new Map(runningRows.map((row) => [row.organizationId, row.credits]));

        const rows: ComputeBillingProjectionRow[] = organizationIds.map((organizationId) => {
            const buildCredits = buildCreditsByOrg.get(organizationId) ?? 0;
            const runningCredits = runningCreditsByOrg.get(organizationId) ?? 0;
            const totalCredits = buildCredits + runningCredits;
            const customer = customerByOrg.get(organizationId);
            const creditBalance = customer?.creditBalance ?? 0;
            const creditFloor = customer?.creditFloor ?? 0;
            const balanceAfter = creditBalance - totalCredits;
            const wasAboveFloor = creditBalance > creditFloor;

            return {
                organizationId,
                organizationName: nameByOrg.get(organizationId) ?? organizationId,
                buildCredits,
                runningCredits,
                totalCredits,
                creditBalance,
                creditFloor,
                balanceAfter,
                goesUnderwater: totalCredits > 0 && wasAboveFloor && balanceAfter <= creditFloor,
            };
        });

        rows.sort((a, b) => b.totalCredits - a.totalCredits);
        const charged = rows.filter((row) => row.totalCredits > 0);
        const projection: ComputeBillingProjection = {
            rows,
            organizationsCharged: charged.length,
            organizationsUnderwater: rows.filter((row) => row.goesUnderwater).length,
            totalCredits: rows.reduce((sum, row) => sum + row.totalCredits, 0),
            since,
            until,
            creditsPerVcpuHour,
            creditsPerGbMemoryHour,
        };

        this.logger.info("Projected compute billing", {
            extra: {
                organizationsCharged: projection.organizationsCharged,
                organizationsUnderwater: projection.organizationsUnderwater,
                totalCredits: projection.totalCredits,
            },
        });
        return projection;
    }

    /**
     * Per-org credits for one usage table, rounded the way the real deduction rounds.
     *
     * The rounding is why this is raw SQL and not a `groupBy` with `_sum`. Each row is charged
     * `max(1, ceil(cost))` INDIVIDUALLY, so an org with hundreds of near-idle 15-minute windows
     * pays one credit for each of them - summing the seconds first and rounding once reports a
     * fraction of the real bill, which would defeat the point of projecting it. Rows costing
     * nothing are skipped here exactly as `deductCreditsForPreviewUsage` skips them.
     *
     * That makes the cost expression below a hand-maintained copy of `computePreviewUsageCost` -
     * SQL cannot call it. `admin-compute-billing-projection.test.ts` pins the two together over a
     * fixture set, so changing one without the other fails rather than silently reporting a bill
     * the deduction would never charge.
     *
     * Neither table indexes `created_at` (both only index `organizationId`), so a wide window is a
     * sequential scan that grows with the table. Acceptable for an on-demand admin projection; add
     * the index if this ever runs on a schedule.
     */
    private async creditsByOrg(
        table: "previewkit_app_build_usage" | "previewkit_usage_window",
        rate: { creditsPerVcpuHour: number; creditsPerGbMemoryHour: number; since: Date; until: Date },
    ): Promise<Array<{ organizationId: string; credits: number }>> {
        const cost = Prisma.sql`
            (vcpu_seconds / 3600.0) * ${rate.creditsPerVcpuHour}
                + (gb_seconds / 3600.0) * ${rate.creditsPerGbMemoryHour}
        `;
        // The table name cannot be a bind parameter, and the union type above is the only thing
        // that reaches this - no caller-supplied string ever becomes an identifier here.
        const from =
            table === "previewkit_app_build_usage"
                ? Prisma.sql`previewkit_app_build_usage`
                : Prisma.sql`previewkit_usage_window`;

        const rows = await this.db.$queryRaw<Array<{ organization_id: string; credits: bigint }>>`
            SELECT organization_id, SUM(GREATEST(1, CEIL(${cost})))::bigint AS credits
            FROM ${from}
            WHERE created_at >= ${rate.since}
              AND created_at <= ${rate.until}
              AND ${cost} > 0
            GROUP BY organization_id
        `;

        return rows.map((row) => ({ organizationId: row.organization_id, credits: Number(row.credits) }));
    }
}
