import { describe, expect, it } from "vitest";
import { isColdStartFailure, mapSdkFailureToVerdict } from "../src/sdk-failure";

describe("mapSdkFailureToVerdict", () => {
    it("maps transport-plane failures to environment_failure", () => {
        expect(mapSdkFailureToVerdict({ kind: "unreachable" })).toBe("environment_failure");
        expect(mapSdkFailureToVerdict({ kind: "timed_out" })).toBe("environment_failure");
    });

    it("maps a malformed 2xx body to scenario_issue - the SDK answered, but non-conformant", () => {
        expect(mapSdkFailureToVerdict({ kind: "bad_response" })).toBe("scenario_issue");
    });

    it("routes an http failure by whether the SDK handler answered (a code) or an ingress did (no code)", () => {
        // Gateway / missing endpoint: the environment, no handler code in the body.
        for (const status of [502, 503, 504, 404, 500]) {
            expect(mapSdkFailureToVerdict({ kind: "http", status })).toBe("environment_failure");
        }
        // The customer's handler answered with a structured error - the scenario/contract plane.
        expect(mapSdkFailureToVerdict({ kind: "http", status: 500, code: "INTERNAL_ERROR" })).toBe("scenario_issue");
        expect(mapSdkFailureToVerdict({ kind: "http", status: 400, code: "UNKNOWN_ENVIRONMENT" })).toBe(
            "scenario_issue",
        );
        expect(mapSdkFailureToVerdict({ kind: "http", status: 403, code: "INVALID_REFS_TOKEN" })).toBe(
            "scenario_issue",
        );
        // An unrecognized code from a custom SDK still means the handler answered.
        expect(mapSdkFailureToVerdict({ kind: "http", status: 422, code: "SOME_CUSTOM_CODE" })).toBe("scenario_issue");
    });

    it("overrides the two codes whose ownership breaks the has-code rule", () => {
        // We sent a request the SDK could not parse - our bug, not the customer's.
        expect(mapSdkFailureToVerdict({ kind: "http", status: 400, code: "INVALID_BODY" })).toBe("engine_artifact");
        expect(
            mapSdkFailureToVerdict({
                kind: "http",
                status: 400,
                code: "INVALID_BODY",
                detail: "Invalid request body: cycle detected in _alias/_ref graph: Task -> Project",
            }),
        ).toBe("engine_artifact");
        // Shared-secret drift - almost always our managed secret, so undecided rather than the customer's.
        expect(mapSdkFailureToVerdict({ kind: "http", status: 401, code: "INVALID_SIGNATURE" })).toBe(
            "environment_failure",
        );
    });

    it("routes the SDK's missing-factory rejection to scenario_issue despite its INVALID_BODY code", () => {
        // The request was well-formed; the customer's handler lacks a factory the recipe names. Both SDK languages
        // file it under INVALID_BODY, so only the detail tells it apart from a body we malformed.
        expect(
            mapSdkFailureToVerdict({
                kind: "http",
                status: 400,
                code: "INVALID_BODY",
                detail: 'Invalid request body: no factory registered for model "issue_subtasks". Register one with `defineFactory(...)` and add it to HandlerConfig.factories.',
            }),
        ).toBe("scenario_issue");
        expect(
            mapSdkFailureToVerdict({
                kind: "http",
                status: 400,
                code: "INVALID_BODY",
                detail: 'Invalid body: no factory registered for model "agentRegistration". Register one with `define_factory(...)` and add it to HandlerConfig.factories.',
            }),
        ).toBe("scenario_issue");
    });
});

describe("isColdStartFailure", () => {
    it("treats a connection-level drop or a gateway 502/503/504 as a cold start", () => {
        expect(isColdStartFailure({ kind: "unreachable" })).toBe(true);
        for (const status of [502, 503, 504]) {
            expect(isColdStartFailure({ kind: "http", status })).toBe(true);
        }
    });

    it("does not treat a timeout, a bad response, or any other status as a cold start", () => {
        // A timeout burns the full budget - more likely a hung endpoint than a cold one - so retrying it is wasteful.
        expect(isColdStartFailure({ kind: "timed_out" })).toBe(false);
        expect(isColdStartFailure({ kind: "bad_response" })).toBe(false);
        for (const status of [404, 500, 400, 200]) {
            expect(isColdStartFailure({ kind: "http", status })).toBe(false);
        }
    });
});
