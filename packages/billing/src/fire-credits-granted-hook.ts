import type { Logger } from "@autonoma/logger";
import type { CreditsGrantedHook } from "./types";

/**
 * Fire the credits-granted hook best-effort: the grant has already committed, so a failed re-poke must be logged,
 * never propagated. Shared by every path that grants credits (top-ups, subscription grants, promo redemptions), so
 * "a grant re-pokes deferred analysis" holds no matter which one added the credits.
 */
export async function fireCreditsGrantedHook(
    hook: CreditsGrantedHook | undefined,
    organizationId: string,
    logger: Logger,
): Promise<void> {
    if (hook == null) return;
    try {
        await hook(organizationId);
    } catch (error) {
        logger.error("onCreditsGranted hook failed", { organizationId, error: String(error) });
    }
}
