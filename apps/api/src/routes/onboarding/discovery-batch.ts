/**
 * Whether a v2 scenario belongs to the discovery batch the given onboarding recorded. An explicit
 * key (`Scenario.discoveryId === OnboardingState.lastDiscoveryId`) replaces the earlier exact-Date
 * equality join; a scenario with no id, or an onboarding that has not discovered, is never in-batch.
 */
export function isInDiscoveryBatch(
    scenario: { discoveryId: string | null },
    lastDiscoveryId: string | undefined,
): boolean {
    return lastDiscoveryId != null && scenario.discoveryId === lastDiscoveryId;
}
