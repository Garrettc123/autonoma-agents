import { z } from "zod";

/** Max message length. */
export const CHAT_MESSAGE_MAX_LENGTH = 4000;

export const ChatSessionStatusSchema = z.enum(["open", "closed"]);
export type ChatSessionStatus = z.infer<typeof ChatSessionStatusSchema>;

export const ChatTurnStatusSchema = z.enum(["thinking", "complete", "failed"]);
export type ChatTurnStatus = z.infer<typeof ChatTurnStatusSchema>;

/** A "what the agent did" breadcrumb, e.g. "Reading the code". Display only. */
export const ChatToolActivitySchema = z.object({
    id: z.string(),
    label: z.string(),
});
export type ChatToolActivity = z.infer<typeof ChatToolActivitySchema>;

/** Outcome of a confirmed forward. Only `delivered` reads as "sent". */
export const ChatForwardReceiptStateSchema = z.enum(["delivered", "deferred", "declined", "failed"]);
export type ChatForwardReceiptState = z.infer<typeof ChatForwardReceiptStateSchema>;

export const ChatForwardReceiptSchema = z.object({
    state: ChatForwardReceiptStateSchema,
    /** User-facing one-liner shown on the receipt card. */
    detail: z.string(),
    /** Ticket/queue id, when the forward produced one. */
    reference: z.string().optional(),
    resolvedAt: z.date(),
});
export type ChatForwardReceipt = z.infer<typeof ChatForwardReceiptSchema>;

export const ChatForwardOfferStatusSchema = z.enum(["pending", "confirmed", "dismissed"]);
export type ChatForwardOfferStatus = z.infer<typeof ChatForwardOfferStatusSchema>;

/**
 * The offer -> confirm -> receipt handshake as one entity: `pending`, `confirmed` (a `receipt` follows), or
 * `dismissed` (no receipt). Kept flat rather than a status-discriminated union - the poll/autoscroll helpers read
 * `status`/`receipt` in one expression, which a union would force to re-narrow per hop. Backend enforces: a
 * receipt exists only on a confirmed offer.
 */
export const ChatForwardOfferSchema = z.object({
    id: z.string(),
    /** What would be forwarded. */
    subject: z.string(),
    /** Shown as the card body. */
    rationale: z.string(),
    /** Affirmative action label, e.g. "Forward for review". */
    confirmLabel: z.string(),
    status: ChatForwardOfferStatusSchema,
    receipt: ChatForwardReceiptSchema.optional(),
});
export type ChatForwardOffer = z.infer<typeof ChatForwardOfferSchema>;

/**
 * One exchange the UI renders, agent-neutral: `thinking` -> `complete` (`answer` markdown) or `failed` (`error`);
 * a disputed finding carries a `forwardOffer`. Flat for the same reason as {@link ChatForwardOfferSchema};
 * the backend enforces that the fields match the status.
 */
export const ChatTurnSchema = z.object({
    id: z.string(),
    prompt: z.string(),
    status: ChatTurnStatusSchema,
    answer: z.string().optional(),
    activity: z.array(ChatToolActivitySchema),
    forwardOffer: ChatForwardOfferSchema.optional(),
    error: z.string().optional(),
    createdAt: z.date(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

/** A conversation about one PR's tests. `closed` is read-only. `turns` are oldest-first. */
export const ChatSessionSchema = z.object({
    id: z.string(),
    applicationId: z.string(),
    prNumber: z.number().int(),
    status: ChatSessionStatusSchema,
    turns: z.array(ChatTurnSchema),
    createdAt: z.date(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const OpenChatSessionInputSchema = z.object({
    applicationId: z.string(),
    prNumber: z.number().int(),
});
export type OpenChatSessionInput = z.infer<typeof OpenChatSessionInputSchema>;

export const SendChatTurnInputSchema = z.object({
    sessionId: z.string(),
    message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
});
export type SendChatTurnInput = z.infer<typeof SendChatTurnInputSchema>;

export const PollChatTurnInputSchema = z.object({
    sessionId: z.string(),
    turnId: z.string(),
});
export type PollChatTurnInput = z.infer<typeof PollChatTurnInputSchema>;

export const ChatForwardDecisionSchema = z.enum(["confirm", "dismiss"]);
export type ChatForwardDecision = z.infer<typeof ChatForwardDecisionSchema>;

export const ResolveChatForwardInputSchema = z.object({
    sessionId: z.string(),
    turnId: z.string(),
    offerId: z.string(),
    decision: ChatForwardDecisionSchema,
});
export type ResolveChatForwardInput = z.infer<typeof ResolveChatForwardInputSchema>;
