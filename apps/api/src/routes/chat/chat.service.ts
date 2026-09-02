import { ConflictError, NotFoundError } from "@autonoma/errors";
import type { ChatForwardDecision, ChatForwardOffer, ChatSession, ChatToolActivity, ChatTurn } from "@autonoma/types";
import { Service } from "../service";

// Stub timings (the real agent is 10-30s); short enough that the poll loop is demoable.
export const THINK_MS = 3500;
export const FORWARD_MS = 1500;

/** Message substrings that make the agent offer a forward. */
const DISPUTE_MARKERS = ["false positive", "not a bug", "isn't a bug", "wrong", "disagree", "dispute", "incorrect"];

/** Canned reply, computed at send and revealed once the turn finishes thinking. */
interface CraftedReply {
    answer: string;
    activity: ChatToolActivity[];
    offer?: ChatForwardOffer;
}

/** Internal turn record; `confirmedAt` never reaches the wire. */
interface StoredTurn {
    id: string;
    prompt: string;
    createdAt: Date;
    status: ChatTurn["status"];
    reply: CraftedReply;
    forward?: { offer: ChatForwardOffer; confirmedAt?: Date };
}

interface StoredSession {
    id: string;
    applicationId: string;
    prNumber: number;
    status: ChatSession["status"];
    createdAt: Date;
    turns: StoredTurn[];
}

/**
 * Stubbed in-memory PR-chat backend - the four-method seam a real agent/host will implement, with canned,
 * time-resolved replies so the UI runs before one exists. In-memory (lost on restart) and `openSession`
 * creates-on-read: both fine for a stub, both the durable host's job later.
 */
export class ChatService extends Service {
    private readonly sessionsByOrg = new Map<string, Map<string, StoredSession>>();
    private turnCounter = 0;

    // Injected clock so the time-driven state is deterministic in tests; wall clock in prod.
    constructor(private readonly now: () => number = Date.now) {
        super();
    }

    /** Get-or-create the PR session, turns advanced to now. */
    openSession(organizationId: string, applicationId: string, prNumber: number): ChatSession {
        this.logger.info("Opening chat session", { organizationId, applicationId, extra: { prNumber } });
        const session = this.ensureSession(organizationId, applicationId, prNumber);
        const view = this.materializeSession(session);
        this.logger.info("Opened chat session", {
            organizationId,
            applicationId,
            extra: { prNumber, turns: view.turns.length },
        });
        return view;
    }

    /** Append the message as a new thinking turn. */
    sendTurn(organizationId: string, sessionId: string, message: string): ChatTurn {
        this.logger.info("Sending chat turn", { organizationId, extra: { sessionId, length: message.length } });
        const session = this.requireSession(organizationId, sessionId);
        if (session.status === "closed") throw new ConflictError("This conversation is closed");

        this.turnCounter += 1;
        const turn: StoredTurn = {
            id: `turn_${this.turnCounter}`,
            prompt: message,
            createdAt: new Date(this.now()),
            status: "thinking",
            reply: craftReply(message),
        };
        session.turns.push(turn);
        this.logger.info("Sent chat turn", { organizationId, extra: { sessionId, turnId: turn.id } });
        return this.materializeTurn(turn);
    }

    // Unlogged on purpose: polled every few seconds, so entry/exit logs would flood Sentry.
    /** Current state of one turn - the UI's poll target. */
    pollTurn(organizationId: string, sessionId: string, turnId: string): ChatTurn {
        const session = this.requireSession(organizationId, sessionId);
        const turn = session.turns.find((t) => t.id === turnId);
        if (turn == null) throw new NotFoundError("Turn not found");
        return this.materializeTurn(turn);
    }

    /** Confirm or dismiss the forward offer; the receipt follows on a later poll. */
    resolveForward(
        organizationId: string,
        sessionId: string,
        turnId: string,
        offerId: string,
        decision: ChatForwardDecision,
    ): ChatTurn {
        this.logger.info("Resolving chat forward offer", { organizationId, extra: { sessionId, turnId, decision } });
        const session = this.requireSession(organizationId, sessionId);
        const turn = session.turns.find((t) => t.id === turnId);
        if (turn == null) throw new NotFoundError("Turn not found");
        this.advance(turn);

        const forward = turn.forward;
        if (forward == null || forward.offer.id !== offerId) throw new NotFoundError("Forward offer not found");
        if (forward.offer.status !== "pending") return this.materializeTurn(turn);

        if (decision === "confirm") {
            forward.offer.status = "confirmed";
            forward.confirmedAt = new Date(this.now());
        } else {
            forward.offer.status = "dismissed";
        }
        this.logger.info("Resolved chat forward offer", {
            organizationId,
            extra: { sessionId, turnId, status: forward.offer.status },
        });
        return this.materializeTurn(turn);
    }

    private ensureSession(organizationId: string, applicationId: string, prNumber: number): StoredSession {
        const sessionId = sessionIdFor(applicationId, prNumber);
        const orgSessions = this.orgSessions(organizationId);
        const existing = orgSessions.get(sessionId);
        if (existing != null) return existing;

        const created: StoredSession = {
            id: sessionId,
            applicationId,
            prNumber,
            status: "open",
            createdAt: new Date(this.now()),
            turns: [],
        };
        orgSessions.set(sessionId, created);
        return created;
    }

    private requireSession(organizationId: string, sessionId: string): StoredSession {
        const session = this.orgSessions(organizationId).get(sessionId);
        if (session == null) throw new NotFoundError("Chat session not found");
        return session;
    }

    private orgSessions(organizationId: string): Map<string, StoredSession> {
        const existing = this.sessionsByOrg.get(organizationId);
        if (existing != null) return existing;
        const created = new Map<string, StoredSession>();
        this.sessionsByOrg.set(organizationId, created);
        return created;
    }

    private materializeSession(session: StoredSession): ChatSession {
        return {
            id: session.id,
            applicationId: session.applicationId,
            prNumber: session.prNumber,
            status: session.status,
            createdAt: session.createdAt,
            turns: session.turns.map((turn) => this.materializeTurn(turn)),
        };
    }

    /** Advance the clock-driven state, then project to the wire shape. */
    private materializeTurn(turn: StoredTurn): ChatTurn {
        this.advance(turn);
        return {
            id: turn.id,
            prompt: turn.prompt,
            status: turn.status,
            answer: turn.status === "complete" ? turn.reply.answer : undefined,
            activity: turn.reply.activity,
            forwardOffer: turn.forward?.offer,
            createdAt: turn.createdAt,
        };
    }

    // Clock-driven: thinking -> complete after THINK_MS, confirmed -> delivered after FORWARD_MS. Lazy on read so
    // a receipt's timestamp stays stable across polls.
    private advance(turn: StoredTurn): void {
        const now = this.now();
        if (turn.status === "thinking" && now - turn.createdAt.getTime() >= THINK_MS) {
            turn.status = "complete";
            if (turn.reply.offer != null) turn.forward = { offer: turn.reply.offer };
        }

        const forward = turn.forward;
        const forwardLanded =
            forward?.offer.status === "confirmed" &&
            forward.offer.receipt == null &&
            forward.confirmedAt != null &&
            now - forward.confirmedAt.getTime() >= FORWARD_MS;
        if (forward != null && forwardLanded) {
            forward.offer.receipt = {
                state: "delivered",
                detail: "Forwarded to the analysis review queue. A reviewer will re-triage this finding.",
                reference: `REV-${forward.offer.id.slice(-4).toUpperCase()}`,
                resolvedAt: new Date(this.now()),
            };
        }
    }
}

function sessionIdFor(applicationId: string, prNumber: number): string {
    return `chat_${applicationId}_pr${prNumber}`;
}

/** Canned replies - the only piece a real agent replaces. */
function craftReply(message: string): CraftedReply {
    const activity: ChatToolActivity[] = [
        { id: "act_report", label: "Reading the analysis report" },
        { id: "act_run", label: "Reviewing the run steps" },
        { id: "act_code", label: "Reading the changed code" },
    ];

    const normalized = message.toLowerCase();
    const isDispute = DISPUTE_MARKERS.some((marker) => normalized.includes(marker));
    if (isDispute) {
        return {
            activity,
            answer: [
                "Thanks for flagging that. I re-read the run for **checkout-place-order** and I can see why you'd push",
                "back: the button was `aria-disabled` at the moment we asserted, but that could be a timing artifact in",
                "the harness rather than a real defect.",
                "",
                "I can't overrule the finding on my own - but I can forward it to a human reviewer with the run steps and",
                "the screenshot attached, and they'll re-triage it.",
            ].join(" "),
            offer: {
                id: "offer_place_order",
                subject: "False-positive dispute: Place order button never enables",
                rationale:
                    "Forward this finding to the analysis review queue with the run steps and evidence, so a reviewer can confirm whether it is a real bug or a harness artifact.",
                confirmLabel: "Forward for review",
                status: "pending",
            },
        };
    }

    if (normalized.includes("coverage") || normalized.includes("what did you test") || normalized.includes("cover")) {
        return {
            activity,
            answer: [
                "## Coverage on this PR",
                "",
                "This run exercised five flows:",
                "",
                "- **Guest checkout** - verified end to end",
                "- **Cart badge counter** - verified",
                "- **Add to cart** - verified",
                "- **Coupon codes** - not run (the coupon fixtures were never seeded)",
                "- **Payment iframe** - could not load in the harness",
                "",
                "The reworked submit path is covered by the guest-checkout flow. If you want the coupon path covered,",
                "say so and I'll author a test for it on the next run.",
            ].join("\n"),
        };
    }

    return {
        activity,
        answer: [
            "The one blocking issue on this PR is **checkout-place-order**: with a valid saved card and a complete",
            "shipping address, every field validated but the Place order button stayed disabled, so the run could",
            "never submit the order.",
            "",
            "The root cause looks like the submit handler reading a `formValid` flag computed once on mount and never",
            "recomputed after the async address-validation promise resolves. Recomputing validity when that promise",
            "settles should fix it.",
            "",
            "Ask me to dig into any specific finding, or tell me if you think one is a false positive.",
        ].join("\n"),
    };
}
