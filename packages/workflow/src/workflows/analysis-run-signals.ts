import { defineSignal } from "@temporalio/workflow";

/**
 * Nudges a running analysis run to re-check its inbox. Argument-free: the inbox is the source of truth for what is
 * pending, so the signal only says "something changed, look again" and the run reads the events itself.
 */
export const analysisInboxSignal = defineSignal("analysisInbox");
