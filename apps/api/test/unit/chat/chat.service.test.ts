import { ConflictError, NotFoundError } from "@autonoma/errors";
import { describe, expect, it } from "vitest";
import { ChatService, FORWARD_MS, THINK_MS } from "../../../src/routes/chat/chat.service";

const ORG = "org_alpha";
const OTHER_ORG = "org_beta";
const APP = "app_1";
const PR = 42;
const QUESTION = "Why is this PR failing?";
const DISPUTE = "I think the Place order finding is a false positive.";

/** A ChatService driving off a hand-cranked clock, so the thinking/receipt timers resolve deterministically. */
function withClock(start = 0) {
    let ms = start;
    return {
        service: new ChatService(() => ms),
        advance(delta: number) {
            ms += delta;
        },
    };
}

/** Send a dispute, let it finish thinking, and return the completed turn's ids plus the pending offer id. */
function disputeTurn() {
    const clock = withClock();
    const session = clock.service.openSession(ORG, APP, PR);
    const turn = clock.service.sendTurn(ORG, session.id, DISPUTE);
    clock.advance(THINK_MS);
    const offered = clock.service.pollTurn(ORG, session.id, turn.id);
    return { ...clock, sessionId: session.id, turnId: turn.id, offerId: offered.forwardOffer?.id ?? "" };
}

describe("ChatService", () => {
    describe("openSession", () => {
        it("is get-or-create: the same (org, app, pr) resolves to one persistent session", () => {
            const { service } = withClock();
            const first = service.openSession(ORG, APP, PR);
            service.sendTurn(ORG, first.id, QUESTION);

            const second = service.openSession(ORG, APP, PR);
            expect(second.id).toBe(first.id);
            // The turn sent between the two opens survived, so the second call got the existing session, not a fresh one.
            expect(second.turns).toHaveLength(1);
        });

        it("isolates sessions by organization", () => {
            const { service } = withClock();
            const mine = service.openSession(ORG, APP, PR);
            service.sendTurn(ORG, mine.id, QUESTION);

            const theirs = service.openSession(OTHER_ORG, APP, PR);
            expect(theirs.turns).toHaveLength(0);
        });
    });

    describe("sendTurn", () => {
        it("appends a thinking turn that echoes the prompt", () => {
            const { service } = withClock();
            const session = service.openSession(ORG, APP, PR);

            const turn = service.sendTurn(ORG, session.id, QUESTION);
            expect(turn.status).toBe("thinking");
            expect(turn.prompt).toBe(QUESTION);
            expect(turn.answer).toBeUndefined();
            expect(service.openSession(ORG, APP, PR).turns).toHaveLength(1);
        });

        it("rejects a turn sent on a closed conversation with a ConflictError", () => {
            const { service } = withClock();
            const session = service.openSession(ORG, APP, PR);
            // The stub has no public close path yet (the durable host will add one). Reach into the store to put the
            // session in the state the guard defends, then assert the guard - the throw is the observable behavior.
            const stored = service["sessionsByOrg"].get(ORG)?.get(session.id);
            if (stored != null) stored.status = "closed";

            expect(() => service.sendTurn(ORG, session.id, QUESTION)).toThrow(ConflictError);
        });

        it("throws NotFoundError for an unknown session", () => {
            const { service } = withClock();
            expect(() => service.sendTurn(ORG, "chat_missing", QUESTION)).toThrow(NotFoundError);
        });
    });

    describe("clock-driven replies", () => {
        it("keeps a turn thinking until THINK_MS, then completes with an answer", () => {
            const { service, advance } = withClock();
            const session = service.openSession(ORG, APP, PR);
            const turn = service.sendTurn(ORG, session.id, QUESTION);

            advance(THINK_MS - 1);
            expect(service.pollTurn(ORG, session.id, turn.id).status).toBe("thinking");

            advance(1);
            const done = service.pollTurn(ORG, session.id, turn.id);
            expect(done.status).toBe("complete");
            expect(done.answer).toBeTruthy();
        });

        it("delivers a receipt FORWARD_MS after a forward is confirmed", () => {
            const { service, advance } = withClock();
            const session = service.openSession(ORG, APP, PR);
            const turn = service.sendTurn(ORG, session.id, DISPUTE);

            advance(THINK_MS);
            const offered = service.pollTurn(ORG, session.id, turn.id);
            expect(offered.forwardOffer?.status).toBe("pending");
            const offerId = offered.forwardOffer?.id ?? "";

            const confirmed = service.resolveForward(ORG, session.id, turn.id, offerId, "confirm");
            expect(confirmed.forwardOffer?.status).toBe("confirmed");
            expect(confirmed.forwardOffer?.receipt).toBeUndefined();

            advance(FORWARD_MS - 1);
            expect(service.pollTurn(ORG, session.id, turn.id).forwardOffer?.receipt).toBeUndefined();

            advance(1);
            const receipt = service.pollTurn(ORG, session.id, turn.id).forwardOffer?.receipt;
            expect(receipt?.state).toBe("delivered");
            expect(receipt?.reference).toMatch(/^REV-/);
        });
    });

    describe("resolveForward", () => {
        it("dismiss marks the offer dismissed and never produces a receipt", () => {
            const t = disputeTurn();
            const dismissed = t.service.resolveForward(ORG, t.sessionId, t.turnId, t.offerId, "dismiss");
            expect(dismissed.forwardOffer?.status).toBe("dismissed");

            t.advance(FORWARD_MS * 10);
            expect(t.service.pollTurn(ORG, t.sessionId, t.turnId).forwardOffer?.receipt).toBeUndefined();
        });

        it("is a no-op on an already-resolved offer", () => {
            const t = disputeTurn();
            t.service.resolveForward(ORG, t.sessionId, t.turnId, t.offerId, "confirm");

            const second = t.service.resolveForward(ORG, t.sessionId, t.turnId, t.offerId, "dismiss");
            expect(second.forwardOffer?.status).toBe("confirmed");
        });

        it("throws NotFoundError for an unknown turn or offer", () => {
            const t = disputeTurn();
            expect(() => t.service.resolveForward(ORG, t.sessionId, "turn_999", t.offerId, "confirm")).toThrow(
                NotFoundError,
            );
            expect(() => t.service.resolveForward(ORG, t.sessionId, t.turnId, "offer_999", "confirm")).toThrow(
                NotFoundError,
            );
        });
    });

    describe("reply crafting", () => {
        it("attaches a forward offer only when the message disputes a finding", () => {
            const { service, advance } = withClock();
            const session = service.openSession(ORG, APP, PR);
            const question = service.sendTurn(ORG, session.id, QUESTION);
            const dispute = service.sendTurn(ORG, session.id, DISPUTE);

            advance(THINK_MS);
            expect(service.pollTurn(ORG, session.id, question.id).forwardOffer).toBeUndefined();
            expect(service.pollTurn(ORG, session.id, dispute.id).forwardOffer?.status).toBe("pending");
        });
    });
});
