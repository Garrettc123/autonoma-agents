/**
 * Thrown when a deduction pushes a zero-tolerance org (`BillingCustomer.killJobsOnCreditExhaustion`)
 * from above its credit floor to at-or-below it - the signal a caller uses to kill whatever job
 * caused the deduction, instead of the default "let it finish, floor-clamped" behavior. A plain
 * `Error` subclass with no Temporal dependency: `packages/billing` stays framework-agnostic, and
 * callers that run inside a Temporal activity (e.g. the analysis activities in
 * `apps/workers/diffs`) are responsible for re-wrapping this as an `ApplicationFailure` so the
 * workflow can detect it and settle the run with a distinct reason.
 */
export class CreditsExhaustedError extends Error {
    constructor(
        message: string,
        public readonly organizationId: string,
    ) {
        super(message);
        this.name = "CreditsExhaustedError";
    }
}
