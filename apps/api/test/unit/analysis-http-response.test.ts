import { describe, expect, it } from "vitest";
import { userPromptHttpResponse } from "../../src/analysis/analysis-http-response";

describe("userPromptHttpResponse", () => {
    it("maps a started receipt to 202 with the branch and event", () => {
        expect(userPromptHttpResponse({ status: "started", branchId: "b1", eventId: "e1" })).toEqual({
            status: 202,
            body: { ok: true, status: "started", branchId: "b1", eventId: "e1" },
        });
    });

    it("maps a deferred receipt to 202 (accepted, will run later) and forwards the gate's reason", () => {
        const response = userPromptHttpResponse({
            status: "deferred",
            branchId: "b1",
            eventId: "e1",
            reason: "out_of_credits",
        });
        expect(response.status).toBe(202);
        expect(response.body).toMatchObject({
            ok: true,
            status: "deferred",
            reason: "out_of_credits",
            branchId: "b1",
            eventId: "e1",
        });
        expect(response.body.message).toEqual(expect.stringContaining("credits"));
    });

    it("maps a closed/merged PR refusal to 409", () => {
        expect(userPromptHttpResponse({ status: "refused", reason: "pr_closed" }).status).toBe(409);
        expect(userPromptHttpResponse({ status: "refused", reason: "pr_merged" }).status).toBe(409);
    });

    it("maps an un-onboarded refusal to 422", () => {
        const response = userPromptHttpResponse({ status: "refused", reason: "not_onboarded" });
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({ reason: "not_onboarded" });
    });
});
