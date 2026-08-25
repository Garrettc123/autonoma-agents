import { logger as rootLogger } from "@autonoma/logger";
import type { HasPendingAnalysisEventsInput, HasPendingAnalysisEventsOutput } from "@autonoma/workflow/activities";
import { getAnalysisEventStore } from "../../services";

/** The drain-loop predicate: whether the branch's inbox holds a pending event on a still-live PR. */
export async function hasPendingAnalysisEvents(
    input: HasPendingAnalysisEventsInput,
): Promise<HasPendingAnalysisEventsOutput> {
    const logger = rootLogger.child({ name: "hasPendingAnalysisEvents" });
    const hasPending = await getAnalysisEventStore().hasPending(input.branchId);
    logger.info("Checked the inbox for pending events", {
        branch: { branchId: input.branchId },
        extra: { hasPending },
    });
    return { hasPending };
}
