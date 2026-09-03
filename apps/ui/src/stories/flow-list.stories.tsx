import type { AnalysisFlow, AnalysisTestRun } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AnalysisFlowList } from "components/analysis/flow-list";

// Flows sized to the width of the real PR-page panel, with the first title long enough to wrap - the case that used
// to push the owner badge onto its own line. The owner now stays pinned top-right regardless of title length.
const flows: AnalysisFlow[] = [
  {
    title: "Partner reservation creation across location-first and unlimited-mile subscription coverage",
    detail:
      "Location-first, new-customer, custom/unlimited-mile, and subscription reservation coverage could not complete because fixtures lacked the expected car, unique customer/insurance state, or EVFMC-gated option.",
    status: "unverified",
    owner: "client",
    passedCount: 0,
    gapCount: 5,
    bugCount: 0,
    checkedThisRunCount: 5,
    testSlugs: ["res-location", "res-new-customer", "res-unlimited", "res-subscription", "res-evfmc"],
  },
  {
    title: "Partner payout details",
    detail: "The partner reached Payouts but the seeded account had no payout period to filter or open.",
    status: "unverified",
    owner: "client",
    passedCount: 0,
    gapCount: 1,
    bugCount: 0,
    checkedThisRunCount: 1,
    testSlugs: ["payout-details"],
  },
  {
    title: "Fleet maintenance blocking",
    detail: "One export check timed out on our runner while the rest of the maintenance flow held up.",
    status: "partial",
    owner: "autonoma",
    passedCount: 3,
    gapCount: 1,
    bugCount: 0,
    checkedThisRunCount: 4,
    testSlugs: ["maint-list", "maint-block", "maint-history", "maint-export"],
  },
  {
    title: "Renter trip extension",
    detail: "The renter extended an active trip and the updated return date was confirmed end to end.",
    status: "verified",
    owner: "none",
    passedCount: 2,
    gapCount: 0,
    bugCount: 0,
    checkedThisRunCount: 2,
    testSlugs: ["trip-extend", "trip-confirm"],
  },
];

// The branch's last-known verdict per test - the same cumulative map the flow counts derive from. Every flow's slugs
// resolve here (in production a flow is always a subset of this map), so each flow renders its findings disclosure.
function testRun(slug: string, category: string): AnalysisTestRun {
  return { id: slug, testCase: { name: `${slug}.md`, slug }, category };
}

const testRuns: AnalysisTestRun[] = [
  testRun("res-location", "environment_failure"),
  testRun("res-new-customer", "environment_failure"),
  testRun("res-unlimited", "scenario_issue"),
  testRun("res-subscription", "scenario_issue"),
  testRun("res-evfmc", "environment_failure"),
  testRun("payout-details", "scenario_issue"),
  testRun("maint-list", "passed"),
  testRun("maint-block", "passed"),
  testRun("maint-history", "passed"),
  testRun("maint-export", "engine_artifact"),
  testRun("trip-extend", "passed"),
  testRun("trip-confirm", "passed"),
];

const meta = {
  title: "Components/AnalysisFlowList",
  component: AnalysisFlowList,
  decorators: [
    (Story) => (
      <div className="max-w-2xl bg-surface-void p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AnalysisFlowList>;
export default meta;

type Story = StoryObj<typeof meta>;

export const LongTitle: Story = { args: { flows, testRuns } };
