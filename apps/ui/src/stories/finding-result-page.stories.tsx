import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, completedOnboardingState } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

/** The app-scoped test-result page's tRPC payload, typed against the router output the fixture is checked against. */
type FindingDetailFixture = NonNullable<NonNullable<TrpcFixtures["branches"]>["analysisFindingDetail"]>;

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const RUN_STARTED_AT = new Date("2026-01-01T11:18:00.000Z");
const RUN_AT = new Date("2026-01-01T11:24:00.000Z");

// A deterministic, network-free run frame: a mock checkout with a disabled "Place order" button, so the media rail
// and the step spotlight render without a real capture.
const MOCK_SCREENSHOT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='820' viewBox='0 0 1200 820'>
    <rect width='1200' height='820' fill='#f5f6f8'/>
    <rect width='1200' height='48' fill='#e6e8ec'/>
    <rect x='360' y='150' width='480' height='520' rx='12' fill='#ffffff' stroke='#e2e5ea'/>
    <text x='400' y='214' font-family='sans-serif' font-size='24' font-weight='600' fill='#1f2430'>Checkout</text>
    <rect x='400' y='274' width='400' height='40' rx='8' fill='#f0f2f5' stroke='#d7dbe2'/>
    <rect x='400' y='356' width='400' height='40' rx='8' fill='#f0f2f5' stroke='#d7dbe2'/>
    <rect x='400' y='474' width='400' height='48' rx='8' fill='#c7ccd6'/>
    <text x='600' y='504' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='600' fill='#8a90a0'>Place order</text>
  </svg>`,
)}`;

const findingDetail: FindingDetailFixture = {
  findingId: "checkout-place-order",
  snapshotId: "snap_pr482_auth_01",
  testCase: {
    id: "tc_checkout-place-order",
    name: "checkout-place-order.md",
    slug: "checkout-place-order",
    description: "A signed-in customer with a saved card completes checkout from the cart page.",
  },
  origin: "pre_existing",
  selfHealed: false,
  contained: false,
  issueId: "issue_place_order",
  issueTitle: "Place order button never enables on checkout",
  prNumber: 482,
  iterations: [
    {
      id: "cls_1",
      number: 1,
      generationId: "gen_checkout-place-order",
      category: "client_bug",
      headline: "Place order button never enables on the checkout page",
      createdAt: RUN_AT,
    },
  ],
  classification: {
    number: 1,
    category: "client_bug",
    confidence: "high",
    headline: "Place order button never enables on the checkout page",
    createdAt: RUN_AT,
    expectedBehavior: "With a valid saved card and a complete shipping address, the Place order button enables.",
    actualBehavior: "Every field validated but the Place order button stayed disabled.",
    whatHappened:
      "The run filled the card and address, both validated, yet the Place order button never left its disabled " +
      "state, so checkout could not complete.",
    remediation:
      "Recompute form validity after the address-validation promise settles, or gate the button on the validated " +
      "address flag instead of the stale mount-time value.",
    rootCause:
      "The submit handler reads a `formValid` flag that is computed once on mount and never recomputed after the " +
      "async address-validation promise resolves.",
    observedAppIssues:
      "The mini-cart badge briefly showed the wrong item count while the address validated, then corrected " +
      "itself - unrelated to this test's failure but worth a look.",
    evidence: [
      { source: "run", detail: "The Place order button kept aria-disabled after all fields were valid." },
      {
        source: "screenshot",
        detail: "Final frame shows every field green with the button still greyed out.",
        frameUrl: MOCK_SCREENSHOT,
      },
      {
        source: "code",
        detail: "The submit handler never re-reads validity once address validation resolves.",
        file: "src/checkout/PlaceOrder.tsx",
        lines: "42-58",
        snippet:
          "const onSubmit = () => {\n  if (!formValid) return; // stale: captured at mount\n  placeOrder(cart);\n};",
      },
      {
        source: "diff",
        detail: "This PR moved address validation behind a promise but left the submit guard synchronous.",
        file: "src/checkout/useAddressValidation.ts",
        lines: "12-20",
      },
      { source: "run", detail: "No console error fired; the button simply never received an enabled state." },
    ],
    keyScreenshotUrl: MOCK_SCREENSHOT,
  },
  generation: {
    id: "gen_checkout-place-order",
    status: "success",
    startedAt: RUN_STARTED_AT,
    completedAt: RUN_AT,
    videoUrl: "https://assets.autonoma.app/test-generation/demo/video.webm",
    steps: [
      {
        order: 1,
        interaction: "navigate",
        params: { url: "https://app.acme.example.com/cart" },
        status: "success",
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 2,
        interaction: "click",
        params: { description: "the Checkout button" },
        status: "success",
        overlayPoints: [{ x: 620, y: 512, role: "click" }],
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 3,
        interaction: "type",
        params: { text: "1 Market St, San Francisco, CA", description: "the shipping address field" },
        status: "success",
        overlayPoints: [{ x: 600, y: 376, role: "click" }],
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 4,
        interaction: "type",
        params: { text: "Ada Lovelace", description: "the cardholder name field" },
        status: "success",
        overlayPoints: [{ x: 600, y: 420, role: "click" }],
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 5,
        interaction: "click",
        params: { description: "the saved Visa ending in 4242" },
        status: "success",
        overlayPoints: [{ x: 480, y: 512, role: "click" }],
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 6,
        interaction: "assert",
        params: { instruction: "the shipping address shows a green validated check" },
        status: "success",
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 7,
        interaction: "scroll",
        params: { description: "down to the order summary" },
        status: "success",
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 8,
        interaction: "assert",
        params: { instruction: "the order total reads $128.40" },
        status: "success",
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 9,
        interaction: "click",
        params: { description: "the Place order button" },
        status: "success",
        overlayPoints: [{ x: 600, y: 498, role: "click" }],
        screenshotBefore: MOCK_SCREENSHOT,
      },
      {
        order: 10,
        interaction: "assert",
        params: { instruction: "the Place order button is enabled" },
        status: "failed",
        error: "The Place order button kept aria-disabled after every field was valid.",
        errorName: "VerificationError",
        screenshotBefore: MOCK_SCREENSHOT,
      },
    ],
  },
  plan: [
    "**Intent**: Verify the customer can place an order and reach a paid confirmation.",
    "",
    "**Preconditions**",
    "",
    "- A signed-in customer with a saved Visa ending in `4242`.",
    "- The cart is empty at the start of the run.",
    "- The `checkout.v2` flag is enabled for this account.",
    "",
    "**Steps**",
    "",
    "1. Add the **Trailblazer backpack** to the cart.",
    "2. Open the mini-cart and confirm the item count reads **1**.",
    "3. Click **Proceed to checkout**.",
    "4. Type `1 Market St, San Francisco, CA` into the shipping address field.",
    "5. Wait for the address to show a green **Validated** check.",
    "6. Type `Ada Lovelace` into the cardholder name field.",
    "7. Select the saved Visa ending in `4242`.",
    "8. Scroll to the order summary and confirm the total reads **$128.40**.",
    "9. Click **Place order**.",
    "10. Assert the confirmation page shows the order number and a **Paid** badge.",
    "",
    "**Teardown**",
    "",
    "- Cancel the created order via the admin API so the run is repeatable.",
    "- Clear the cart cookie.",
  ].join("\n"),
};

// The `app.$appSlug` layout loader resolves the main branch and reads the onboarding state on every page under it.
const fixtures: TrpcFixtures = {
  onboarding: { getState: completedOnboardingState() },
  branches: {
    detailByName: {
      id: baseApplication.mainBranchId ?? "branch_fixture_01",
      name: "main",
      pendingSnapshotId: null,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      activeSnapshot: {
        id: "snapshot_main_01",
        status: "active",
        createdAt: FIXTURE_EPOCH,
        source: "MANUAL",
        testCaseAssignments: [],
      },
    },
    analysisFindingDetail: findingDetail,
  },
};

const meta = {
  title: "Pages/FindingResultPage",
  component: PageStory,
  parameters: { pageStory: true, msw: { handlers: appShellHandlers(fixtures) } },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The app-scoped test-result page: the verdict story in the main column, a sticky rail carrying the run recording
 * and a lean Steps / Plan tabbed panel, with the failed assertion inline. Keyed by finding id, no snapshot chrome.
 */
export const ClientBug: Story = {
  args: { path: `/app/${baseApplication.slug}/findings/checkout-place-order` },
};

/** The rail's Steps tab: each frame-backed step is a full-width clickable row with a zoom affordance that opens the
 * navigable frame gallery. Shot with a row hovered to show the click target. */
export const StepsTab: Story = {
  args: { path: `/app/${baseApplication.slug}/findings/checkout-place-order?tab=steps` },
};
