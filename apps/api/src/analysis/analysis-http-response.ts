import type {
    DeliverUserPromptDeferralReason,
    DeliverUserPromptReceipt,
    DeliverUserPromptRefusal,
} from "./deliver-user-prompt.service";

export interface UserPromptHttpResponse {
    status: 202 | 409 | 422;
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
    switch (reason) {
        case "pr_closed":
            return "The pull request is closed, so its branch will not run again; nothing was enqueued.";
        case "pr_merged":
            return "The pull request is merged, so its branch will not run again; nothing was enqueued.";
        case "not_onboarded":
            return "The application has not finished onboarding, so there is no test suite to direct.";
    }
}

function deferralMessage(reason: DeliverUserPromptDeferralReason): string {
    switch (reason) {
        case "activation_gated":
            return "The message was recorded; the organization runs analysis only on an explicit request, so it will be addressed by this PR's next run.";
        case "out_of_credits":
            return "The message was recorded; the organization is out of analysis credits, so it will be addressed by this PR's next run once credits are restored.";
    }
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
