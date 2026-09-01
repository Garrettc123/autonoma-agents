import { analytics } from "@autonoma/analytics";
import type { ScenarioInstance } from "@autonoma/db";
import { extendObservabilityContext, type Logger } from "@autonoma/logger";
import { mapSdkFailureToVerdict } from "@autonoma/types";
import * as Sentry from "@sentry/node";

/** PostHog event for a failed scenario provisioning, segmented by protocol + mechanism + verdict. */
const SCENARIO_PROVISION_FAILED_EVENT = "scenario.provision_failed";
const ORGANIZATION_GROUP = "organization";
/** Leads the Sentry fingerprint so scenario failures form their own recognizable issue family. */
const SCENARIO_FAILURE_FINGERPRINT = "scenario-provision-failed";

/**
 * Record a failed scenario provisioning (`up` or `down`) as observability that segments v1 vs v2
 * and names the cause:
 *
 * - Tags the async scope with the app's protocol + ids, so the activity interceptor's Sentry issue
 *   (opened when this activity re-throws) is filterable by `protocolVersion` and no longer collapses
 *   every failure into one undifferentiated bucket. scenarioUp/Down take `entityId`, which the
 *   interceptor does not auto-resolve, so nothing else populates the app context here.
 * - Writes an enriched error log carrying the SdkFailure mechanism (`failureKind`/`sdkStatus`/`sdkCode`)
 *   and the coverage-plane `verdict`.
 * - Emits a PostHog event for failure-rate dashboards/alerts (v1 vs v2, by cause).
 *
 * Never throws - the caller still surfaces the failure to Temporal.
 */
export function recordScenarioProvisionFailure(params: {
    instance: ScenarioInstance;
    phase: "up" | "down";
    logger: Logger;
}): void {
    const { instance, phase, logger } = params;
    const protocolVersion = instance.protocolVersion ?? undefined;
    const failure = instance.lastError?.failure;
    const failureKind = failure?.kind;
    const sdkStatus = failure?.kind === "http" ? failure.status : undefined;
    const sdkCode = failure?.kind === "http" ? failure.code : undefined;
    const verdict = failure != null ? mapSdkFailureToVerdict(failure) : undefined;

    extendObservabilityContext({
        application:
            protocolVersion != null
                ? { applicationId: instance.applicationId, protocolVersion }
                : { applicationId: instance.applicationId },
        organization: { organizationId: instance.organizationId },
    });

    // Split the one throw-site bucket into recognizable, self-describing Sentry issues: one per
    // phase x protocol x verdict (e.g. "scenario-provision-failed / up / 2.0 / scenario_issue"),
    // instead of every scenario failure grouping under a single stacktrace. Set on the current scope
    // so the interceptor's captureException (a forked child scope) inherits it when this activity
    // re-throws. Sentry is prod-gated, so this no-ops locally.
    Sentry.getCurrentScope().setFingerprint([
        SCENARIO_FAILURE_FINGERPRINT,
        phase,
        protocolVersion ?? "unknown",
        verdict ?? "unclassified",
    ]);

    logger.error(
        `Scenario ${phase} provisioning failed (protocol ${protocolVersion ?? "unknown"}, ${verdict ?? "unclassified"})`,
        {
            extra: {
                instanceId: instance.id,
                scenarioId: instance.scenarioId,
                protocolVersion,
                phase,
                failureKind,
                sdkStatus,
                sdkCode,
                verdict,
                message: instance.lastError?.message,
            },
        },
    );

    analytics.capture(
        instance.applicationId,
        SCENARIO_PROVISION_FAILED_EVENT,
        {
            organizationId: instance.organizationId,
            applicationId: instance.applicationId,
            scenarioId: instance.scenarioId,
            protocolVersion,
            phase,
            failureKind,
            sdkStatus,
            sdkCode,
            verdict,
        },
        { [ORGANIZATION_GROUP]: instance.organizationId },
    );
}
