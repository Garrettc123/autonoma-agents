import type { BranchTriggerBlockReason, PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

/**
 * Stamps a branch as blocked so the PR list and PR overview tab can tell "blocked" apart from "never
 * triggered" - a credits-declined previewkit deploy, a declined PR analysis run, and a mid-run kill
 * for a zero-tolerance org's credit exhaustion all reach this, since none of them create any row
 * (BranchSnapshot/PreviewkitEnvironment) the UI would otherwise read from. Best-effort: this is a UI
 * nicety layered on top of an already-working gate/comment/error flow, so a failure here must never
 * surface to the caller.
 */
export async function recordBranchTriggerBlocked(
    db: PrismaClient,
    branchId: string,
    reason: BranchTriggerBlockReason,
): Promise<void> {
    const logger = rootLogger.child({ name: "recordBranchTriggerBlocked" });
    try {
        await db.branch.update({
            where: { id: branchId },
            data: { lastBlockedReason: reason, lastBlockedAt: new Date() },
        });
    } catch (err) {
        logger.warn("Failed to record branch trigger block", { branchId, reason, err });
    }
}

/**
 * Clears a branch's last-blocked state once a new trigger actually clears the credits gate, so a
 * resolved block never lingers as a stale "insufficient credits" message. `updateMany` makes this a
 * safe no-op when nothing was set - no pre-read needed. Best-effort, same rationale as above.
 */
export async function clearBranchTriggerBlock(db: PrismaClient, branchId: string): Promise<void> {
    const logger = rootLogger.child({ name: "clearBranchTriggerBlock" });
    try {
        await db.branch.updateMany({
            where: { id: branchId, lastBlockedReason: { not: null } },
            data: { lastBlockedReason: null, lastBlockedAt: null },
        });
    } catch (err) {
        logger.warn("Failed to clear branch trigger block", { branchId, err });
    }
}
