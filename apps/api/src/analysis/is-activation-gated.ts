import type { PrismaClient } from "@autonoma/db";

/**
 * Whether the org is migrated to activation, where an automatic analysis run is suppressed and a run starts only on
 * an explicit request. The one place both producers and the credit-top-up sweeper read this, so "wake the workflow"
 * and "may an automatic run proceed" cannot disagree.
 */
export async function isActivationGated(db: PrismaClient, organizationId: string): Promise<boolean> {
    const settings = await db.organizationSettings.findUnique({
        where: { organizationId },
        select: { activationEnabled: true },
    });
    return settings?.activationEnabled === true;
}
