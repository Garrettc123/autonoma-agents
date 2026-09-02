import type { ChatForwardOffer, ChatSession, ChatTurn } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrChatDrawer } from "components/chat/pr-chat-drawer";
import { trpcHandler } from "lib/storybook/trpc-handler";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { userEvent, within } from "storybook/test";

const FIXTURE_EPOCH = new Date("2026-01-01T11:24:00.000Z");
const APP_ID = "app_fixture_01";
const PR_NUMBER = 482;
const SESSION_ID = `chat_${APP_ID}_pr${PR_NUMBER}`;

const DEFAULT_ACTIVITY = [
  { id: "act_report", label: "Reading the analysis report" },
  { id: "act_run", label: "Reviewing the run steps" },
  { id: "act_code", label: "Reading the changed code" },
];

const WHY_FAILING_ANSWER = [
  "The one blocking issue on this PR is **checkout-place-order**: with a valid saved card and a complete",
  "shipping address, every field validated but the Place order button stayed disabled, so the run could never",
  "submit the order.",
  "",
  "The root cause looks like the submit handler reading a `formValid` flag computed once on mount and never",
  "recomputed after the async address-validation promise resolves.",
].join(" ");

const COVERAGE_ANSWER = [
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
  "The reworked submit path is covered by the guest-checkout flow.",
].join("\n");

const DISPUTE_ANSWER = [
  "Thanks for flagging that. I re-read the run for **checkout-place-order** and I can see why you'd push back:",
  "the button was `aria-disabled` at the moment we asserted, but that could be a timing artifact in the harness",
  "rather than a real defect.",
  "",
  "I can't overrule the finding on my own - but I can forward it to a human reviewer with the run steps and the",
  "screenshot attached, and they'll re-triage it.",
].join(" ");

const PENDING_OFFER: ChatForwardOffer = {
  id: "offer_place_order",
  subject: "False-positive dispute: Place order button never enables",
  rationale:
    "Forward this finding to the analysis review queue with the run steps and evidence, so a reviewer can confirm whether it is a real bug or a harness artifact.",
  confirmLabel: "Forward for review",
  status: "pending",
};

function turn(overrides: Partial<ChatTurn> & Pick<ChatTurn, "id" | "prompt">): ChatTurn {
  return {
    status: "complete",
    activity: DEFAULT_ACTIVITY,
    createdAt: FIXTURE_EPOCH,
    ...overrides,
  };
}

function session(turns: ChatTurn[], status: ChatSession["status"] = "open"): ChatSession {
  return { id: SESSION_ID, applicationId: APP_ID, prNumber: PR_NUMBER, status, turns, createdAt: FIXTURE_EPOCH };
}

const CONVERSATION_TURNS: ChatTurn[] = [
  turn({ id: "turn_1", prompt: "Why is this PR failing?", answer: WHY_FAILING_ANSWER }),
  turn({ id: "turn_2", prompt: "What did you test on this PR?", answer: COVERAGE_ANSWER }),
];

const DISPUTE_TURN: ChatTurn = turn({
  id: "turn_dispute",
  prompt: "I think the Place order finding is a false positive.",
  answer: DISPUTE_ANSWER,
  forwardOffer: PENDING_OFFER,
});

const DELIVERED_TURN: ChatTurn = turn({
  id: "turn_dispute",
  prompt: "I think the Place order finding is a false positive.",
  answer: DISPUTE_ANSWER,
  forwardOffer: {
    ...PENDING_OFFER,
    status: "confirmed",
    receipt: {
      state: "delivered",
      detail: "Forwarded to the analysis review queue. A reviewer will re-triage this finding.",
      reference: "REV-RDER",
      resolvedAt: FIXTURE_EPOCH,
    },
  },
});

const THINKING_TURN: ChatTurn = turn({
  id: "turn_thinking",
  prompt: "Can you walk me through the checkout failure?",
  status: "thinking",
  answer: undefined,
});

// The stub replies canned data so a viewer can actually send a message in Storybook; screenshots use the static
// session fixtures above.
const INTERACTIVE_REPLY: ChatTurn = turn({
  id: "turn_reply",
  prompt: "Tell me more",
  answer: WHY_FAILING_ANSWER,
});

function chatFixtures(chat: NonNullable<TrpcFixtures["chat"]>): TrpcFixtures {
  return { chat };
}

const meta = {
  title: "Components/PrChatPanel",
  component: PrChatDrawer,
  args: { applicationId: APP_ID, prNumber: PR_NUMBER },
} satisfies Meta<typeof PrChatDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

// Storybook mounts the drawer content only once opened, so every story clicks the trigger before capture.
async function openDrawer(canvasElement: HTMLElement) {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: /ask autonoma/i }));
}

/** The initial state: a prompt to ask something, with three openers. */
export const Empty: Story = {
  parameters: {
    msw: { handlers: [trpcHandler(chatFixtures({ openSession: session([]), sendTurn: INTERACTIVE_REPLY }))] },
  },
  play: async ({ canvasElement }) => {
    await openDrawer(canvasElement);
    await within(document.body).findByText(/ask autonoma about this pr/i);
  },
};

/** A running conversation: two exchanges, the agent's answers rendered as markdown. */
export const Conversation: Story = {
  parameters: {
    msw: {
      handlers: [trpcHandler(chatFixtures({ openSession: session(CONVERSATION_TURNS), sendTurn: INTERACTIVE_REPLY }))],
    },
  },
  play: async ({ canvasElement }) => {
    await openDrawer(canvasElement);
    await within(document.body).findByText(/blocking issue on this PR/i);
  },
};

/** The forward affordance: the engineer disputed a finding, and the agent offers to forward it for review. */
export const ForwardOffer: Story = {
  parameters: {
    msw: {
      handlers: [trpcHandler(chatFixtures({ openSession: session([DISPUTE_TURN]), resolveForward: DELIVERED_TURN }))],
    },
  },
  play: async ({ canvasElement }) => {
    await openDrawer(canvasElement);
    await within(document.body).findByRole("button", { name: /forward for review/i });
  },
};

/** The receipt after a confirmed forward: delivered, with its review reference - the only state that reads as sent. */
export const ForwardReceipt: Story = {
  parameters: { msw: { handlers: [trpcHandler(chatFixtures({ openSession: session([DELIVERED_TURN]) }))] } },
  play: async ({ canvasElement }) => {
    await openDrawer(canvasElement);
    await within(document.body).findByText(/forwarded for review/i);
  },
};

/** A turn in flight: the "thinking" state with its compact tool activity, composer locked. */
export const Thinking: Story = {
  parameters: {
    msw: { handlers: [trpcHandler(chatFixtures({ openSession: session([THINKING_TURN]), pollTurn: THINKING_TURN }))] },
  },
  play: async ({ canvasElement }) => {
    await openDrawer(canvasElement);
    await within(document.body).findByText(/thinking/i);
  },
};

/** A closed conversation: history stays readable, the composer is replaced by a read-only note. */
export const Closed: Story = {
  parameters: {
    msw: { handlers: [trpcHandler(chatFixtures({ openSession: session(CONVERSATION_TURNS, "closed") }))] },
  },
  play: async ({ canvasElement }) => {
    await openDrawer(canvasElement);
    await within(document.body).findByText(/conversation is closed/i);
  },
};
