import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { dashboardFixtures } from "lib/storybook/dashboard-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";

type OrganizationRow = RouterOutputs["admin"]["listOrganizations"]["items"][number];

/**
 * The organization tab is the only place in the product that shows which organizations are
 * billing-exempt, so the fixture carries one that is - an enterprise account whose usage is
 * recorded and never charged - alongside ordinary organizations that pay per use.
 */
const ORGANIZATIONS: OrganizationRow[] = [
  {
    id: "org_northwind",
    name: "Northwind Logistics",
    slug: "northwind-logistics",
    domain: "northwind.com",
    createdAt: new Date("2026-02-11T09:20:00.000Z"),
    memberCount: 34,
    applicationCount: 6,
    unlimitedCredits: true,
  },
  {
    id: "org_alinea",
    name: "Alinea Health",
    slug: "alinea-health",
    domain: "alineahealth.io",
    createdAt: new Date("2026-04-02T14:05:00.000Z"),
    memberCount: 12,
    applicationCount: 3,
    unlimitedCredits: false,
  },
  {
    id: "org_eonrides",
    name: "Eon Rides",
    slug: "eon-rides",
    domain: "eonrides.co",
    createdAt: new Date("2026-06-19T11:48:00.000Z"),
    memberCount: 5,
    applicationCount: 1,
    unlimitedCredits: false,
  },
  {
    id: "org_pressline",
    name: "Pressline Media",
    slug: "pressline-media",
    domain: undefined,
    createdAt: new Date("2026-07-30T16:31:00.000Z"),
    memberCount: 2,
    applicationCount: 1,
    unlimitedCredits: false,
  },
];

const ORGANIZATION_LIST: RouterOutputs["admin"]["listOrganizations"] = {
  items: ORGANIZATIONS,
  page: 1,
  pageSize: 20,
  total: ORGANIZATIONS.length,
  totalPages: 1,
};

/**
 * Staff-only organization directory: search, switch into an account to debug it, and set the one
 * piece of billing state that has no other home in the product - whether an organization is billed
 * for what it uses at all.
 */
const meta = {
  title: "Pages/AdminOrganizations",
  component: PageStory,
  parameters: {
    pageStory: true,
    layout: "fullscreen",
    msw: {
      handlers: appShellHandlers(
        {
          ...dashboardFixtures,
          admin: { listOrganizations: ORGANIZATION_LIST },
        },
        { role: "admin" },
      ),
    },
  },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

// Not app-scoped: the route hangs off the app-shell layout directly, not /app/$appSlug/admin.
const PATH = "/admin";

/**
 * The directory as it opens. Northwind carries the badge and its switch is on: every credits gate
 * passes for it and no charge moves its balance, while its usage still lands on the ledger. The
 * switch is the whole control - there is no automatic "this account is enterprise" detection, so an
 * exemption exists only because someone deliberately granted it here.
 */
export const Default: Story = {
  args: { path: PATH },
};
