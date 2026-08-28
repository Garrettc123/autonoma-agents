/**
 * The labels and annotations previewkit stamps on every namespace and workload it
 * creates, and the selectors built from them.
 *
 * These exist so nothing has to recognise a preview by the SHAPE OF ITS NAME. The
 * namespace format has changed once already (`preview-{owner}-{repo}-pr-{N}` ->
 * `{owner}-{repo}-{N}-{hash}`, to stop two repos colliding), and every consumer that
 * had hardcoded the old prefix kept compiling while silently matching nothing: the
 * usage meter stopped billing running compute, the reaper stopped reclaiming
 * namespaces AND started marking live environments torn down, and Alloy stopped
 * shipping app logs. A label the deployer writes cannot drift from the deployer.
 */

/** Written by the deployer onto every preview namespace and workload (resource-factory.ts BASE_LABELS). */
export const PREVIEWKIT_MANAGED_BY_LABEL = "previewkit.dev/managed-by";
export const PREVIEWKIT_MANAGED_BY_VALUE = "previewkit";

/** The pull request the namespace serves; `0` is the long-lived main-branch environment. */
export const PREVIEWKIT_PR_NUMBER_LABEL = "previewkit.dev/pr-number";

/** Selects previewkit-managed WORKLOADS - also the central Gatekeeper's TARGET_SELECTOR. */
export const PREVIEWKIT_MANAGED_SELECTOR = `${PREVIEWKIT_MANAGED_BY_LABEL}=${PREVIEWKIT_MANAGED_BY_VALUE}`;

/**
 * Selects preview ENVIRONMENT namespaces, and nothing else.
 *
 * The `pr-number` existence check is load-bearing, not belt-and-braces: the shared edge
 * namespace `system` (Gatekeeper + ingress-nginx, serving the whole fleet) also carries
 * `managed-by=previewkit` but has no pull request behind it, so `managed-by` alone
 * returns a namespace that no environment row accounts for - which a reaper would read
 * as an orphan and delete out from under every preview at once.
 */
export const PREVIEWKIT_ENVIRONMENT_NAMESPACE_SELECTOR = `${PREVIEWKIT_MANAGED_SELECTOR},${PREVIEWKIT_PR_NUMBER_LABEL}`;

/**
 * The last status/phase the deploy pipeline wrote, mirrored onto the namespace itself.
 * The namespace is therefore a recoverable copy of that state when the database row is
 * wrong - which is what the reaper repair script reads.
 */
export const PREVIEWKIT_STATUS_ANNOTATION = "previewkit.dev/status";
export const PREVIEWKIT_PHASE_ANNOTATION = "previewkit.dev/phase";

/** The main-branch environment, which has no pull request to close and is never reclaimed by age. */
export const BASE_PREVIEW_PR_NUMBER = 0;
