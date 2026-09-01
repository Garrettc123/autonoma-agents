import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";

/** Link tests uploaded before discovery to the thin scenario registry by their stable name. */
export async function reconcileTestPlanScenarios(
    db: PrismaClient,
    applicationId: string,
    scenarioNames: string[],
    logger: Logger,
): Promise<number> {
    if (scenarioNames.length === 0) return 0;

    const linked = await db.$transaction(async (tx) => {
        const scenarios = await tx.scenario.findMany({
            where: { applicationId, name: { in: scenarioNames } },
            select: { id: true, name: true },
        });

        let count = 0;
        for (const scenario of scenarios) {
            const result = await tx.testPlan.updateMany({
                where: {
                    scenarioId: null,
                    scenarioName: scenario.name,
                    testCase: { applicationId },
                },
                data: { scenarioId: scenario.id },
            });
            count += result.count;
        }
        return count;
    });

    logger.info("Reconciled test plans with discovered scenarios", {
        applicationId,
        extra: { scenarioCount: scenarioNames.length, linked },
    });
    return linked;
}
