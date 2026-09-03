import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { dashboardFixtures } from "lib/storybook/dashboard-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";
import { expect, userEvent, waitFor, within } from "storybook/test";

const PRICING_SYNCED_AT = new Date("2026-08-25T03:00:00.000Z");

/** What AWS actually charges, as the weekly pricing-drift job records it. Cost, not price. */
const PRICING_REFERENCE: RouterOutputs["admin"]["billing"]["getComputePricingReference"] = [
  {
    pool: "buildkit",
    usdPerVcpuHour: 0.02772,
    usdPerGbHour: 0.00315,
    spotFraction: 0.62,
    sampleSize: 148,
    updatedAt: PRICING_SYNCED_AT,
  },
  {
    pool: "previewkit",
    usdPerVcpuHour: 0.03465,
    usdPerGbHour: 0.0039375,
    spotFraction: null,
    sampleSize: null,
    updatedAt: PRICING_SYNCED_AT,
  },
];

/**
 * A month of real fleet usage repriced at the 1.5x default. Two orgs comfortably above their
 * floor, one the charge would push under it - the case the whole screen exists to surface before
 * a price is set, since the deduction itself has no dry-run mode.
 */
const PROJECTION: RouterOutputs["admin"]["usage"]["computeBillingProjection"] = {
  rows: [
    {
      organizationId: "org_northwind",
      organizationName: "Northwind Logistics",
      buildCredits: 48_210,
      runningCredits: 121_880,
      totalCredits: 170_090,
      totalUsd: 113.39,
      creditBalance: 1_240_000,
      creditFloor: 0,
      unlimitedCredits: false,
      balanceAfter: 1_069_910,
      goesUnderwater: false,
    },
    {
      organizationId: "org_alinea",
      organizationName: "Alinea Health",
      buildCredits: 22_940,
      runningCredits: 61_305,
      totalCredits: 84_245,
      totalUsd: 56.16,
      creditBalance: 430_000,
      creditFloor: 0,
      unlimitedCredits: false,
      balanceAfter: 345_755,
      goesUnderwater: false,
    },
    {
      organizationId: "org_eonrides",
      organizationName: "Eon Rides",
      buildCredits: 9_870,
      runningCredits: 31_402,
      totalCredits: 41_272,
      totalUsd: 27.51,
      creditBalance: 18_500,
      creditFloor: 0,
      unlimitedCredits: false,
      balanceAfter: -22_772,
      goesUnderwater: true,
    },
  ],
  organizationsCharged: 3,
  organizationsUnderwater: 1,
  totalCredits: 295_607,
  totalUsd: 197.06,
  since: new Date("2026-07-28T00:00:00.000Z"),
  until: new Date("2026-08-27T23:59:59.999Z"),
  usdPerVcpuHour: 0.051975,
  usdPerGbHour: 0.005906,
};

/**
 * Staff-only what-if for previewkit compute pricing. Reads only: it reprices usage already
 * recorded, at prices that are never saved, so a price can be sized - and the orgs it would push
 * below their floor found - before anyone sets one.
 */
const meta = {
  title: "Pages/AdminComputeBilling",
  component: PageStory,
  parameters: {
    pageStory: true,
    layout: "fullscreen",
    msw: {
      handlers: appShellHandlers(
        {
          ...dashboardFixtures,
          admin: {
            billing: { getComputePricingReference: PRICING_REFERENCE },
            usage: { computeBillingProjection: PROJECTION },
          },
        },
        { role: "admin" },
      ),
    },
  },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

// Not app-scoped: the route hangs off the app-shell layout directly, not /app/$appSlug/admin.
const PATH = "/admin/compute-billing";

/**
 * The screen as it opens: AWS cost per pool, each with the 1.5x figure the fleet default uses and
 * a button that fills the form with it, and empty USD-per-hour inputs. Nothing has been projected
 * yet - the query does not fire until an admin asks.
 */
export const Form: Story = {
  args: { path: PATH },
};

/**
 * The result, reached the way an admin reaches it. The projection query is gated on the form being
 * submitted, so this clicks through rather than pre-seeding state that does not exist until then.
 */
export const Projected: Story = {
  args: { path: PATH },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const vcpu = await canvas.findByLabelText(/USD \/ vCPU-hour/i, undefined, { timeout: 15_000 });
    const gb = await canvas.findByLabelText(/USD \/ GB-hour/i);

    await userEvent.type(vcpu, "0.051975");
    await userEvent.type(gb, "0.005906");
    await userEvent.click(canvas.getByLabelText("run-compute-projection"));

    await waitFor(() => expect(canvas.getByText(/Orgs pushed below floor/i)).toBeInTheDocument());
  },
};
