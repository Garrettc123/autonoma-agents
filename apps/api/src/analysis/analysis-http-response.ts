import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
    DeliverUserPromptDeferralReason,
    DeliverUserPromptReceipt,
    DeliverUserPromptRefusal,
} from "./deliver-user-prompt.service";
import { describeDeferralReason, describeRefusal } from "./user-prompt-outcomes";

export interface UserPromptHttpResponse {
    /** Typed as Hono's status so the route can pass it straight to `ctx.json` with no assertion. */
    status: ContentfulStatusCode;
    body: Record<string, unknown>;
}

/** A dead PR is a conflict (409); an un-onboarded app is an unprocessable precondition (422). */
function refusalStatus(reason: DeliverUserPromptRefusal): 409 | 422 {
    switch (reason) {
        case "pr_closed":
        case "pr_merged":
            return 409;
        case "not_onboarded":
            return 422;
    }
}

function refusalMessage(reason: DeliverUserPromptRefusal): string {
    const clause = describeRefusal(reason, { pullRequest: "The pull request", application: "The application" });
    return `${clause}; nothing was enqueued.`;
}

function deferralMessage(reason: DeliverUserPromptDeferralReason): string {
    return `The message was recorded; ${describeDeferralReason(reason)}, so it will be addressed by this PR's next run.`;
}

export function userPromptHttpResponse(receipt: DeliverUserPromptReceipt): UserPromptHttpResponse {
    switch (receipt.status) {
        case "started":
            return {
                status: 202,
                body: { ok: true, status: "started", branchId: receipt.branchId, eventId: receipt.eventId },
            };
        case "deferred":
            return {
                status: 202,
                body: {
                    ok: true,
                    status: "deferred",
                    reason: receipt.reason,
                    message: deferralMessage(receipt.reason),
                    branchId: receipt.branchId,
                    eventId: receipt.eventId,
                },
            };
        case "refused":
            return {
                status: refusalStatus(receipt.reason),
                body: { error: refusalMessage(receipt.reason), reason: receipt.reason },
            };
    }
}
