import type { DeliverUserPromptDeferralReason, DeliverUserPromptRefusal } from "./deliver-user-prompt.service";

/** How to name the branch's PR and its app in a refusal sentence - each surface supplies its own phrasing. */
export interface RefusalSubject {
    /** The PR as a sentence subject, e.g. "The pull request" or "acme/web PR 42". */
    pullRequest: string;
    /** The app as a sentence subject, e.g. "The application" or "acme/web". */
    application: string;
}

/**
 * Why a delivered message could not start a run now, as a clause that completes "the message was recorded; <clause>,
 * so it waits for the next run". The single source both the HTTP response and the MCP tool frame in their own
 * envelope, so the two surfaces can never drift on what a deferral reason means.
 */
export function describeDeferralReason(reason: DeliverUserPromptDeferralReason): string {
    switch (reason) {
        case "activation_gated":
            return "this organization runs analysis only on an explicit request";
        case "out_of_credits":
            return "the organization is out of analysis credits";
    }
}

/**
 * Why a delivered message was refused outright, as a full predicate about `subject` (the PR or the app, whichever the
 * reason is about, named by the caller). The single source both the HTTP response and the MCP tool frame in their own
 * envelope, so the two surfaces can never drift on what a refusal reason means.
 */
export function describeRefusal(reason: DeliverUserPromptRefusal, subject: RefusalSubject): string {
    switch (reason) {
        case "pr_closed":
            return `${subject.pullRequest} is closed, so its branch will not run again`;
        case "pr_merged":
            return `${subject.pullRequest} is merged, so its branch will not run again`;
        case "not_onboarded":
            return `${subject.application} has not finished onboarding, so there is no test suite to direct`;
    }
}
