import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseApplication } from "lib/storybook/base-fixtures";
import { trpcHandler } from "lib/storybook/trpc-handler";
import { Suspense } from "react";
import {
  TestUserButton,
  TestUserButtonSkeleton,
} from "routes/_blacklight/_app-shell/app.$appSlug/pull-requests/-components/preview/test-user-button";
import { userEvent, within } from "storybook/test";

const ENVIRONMENT_ID = "env_fixture_01";
const PREVIEW_URL = "https://web-app.preview-2624.internal";
const INSTANCE_ID = "c7822314-579b-4337-ab92-73043bed0c1e";

/**
 * A provisioned test user showing the email + password mode. The email is a full instance-scoped
 * address (`admin-<uuid>@…`) that wraps to three lines - the case that used to overflow the fixed-height
 * value box. The card is what the "Test user details" dialog renders once a user is active.
 */
const meta = {
  title: "Components/TestUserCredentials",
  component: TestUserButton,
  parameters: {
    msw: {
      handlers: [
        trpcHandler({
          deployments: {
            testUserOptions: {
              applicationId: baseApplication.id,
              applicationName: baseApplication.name,
              scenarios: [{ id: "scenario_default", name: "standard" }],
              appUrls: [{ appName: "web-app", url: PREVIEW_URL }],
              suggestedSdkUrl: PREVIEW_URL,
              previewUrl: PREVIEW_URL,
              disabledReason: undefined,
            },
            testUserProvision: {
              instanceId: INSTANCE_ID,
              auth: {
                credentials: {
                  email: `admin-${INSTANCE_ID}@test.centinel.app`,
                  password: "A!89ff0510a22962e0b96b538fd81734bc",
                },
              },
              refs: {},
              refsToken: undefined,
              resolvedVariables: {},
            },
          },
        }),
      ],
    },
  },
  decorators: [
    // The button reads its options with a suspense query, so every real call site wraps it too.
    (Story) => (
      <div className="flex min-h-96 justify-center bg-surface-void p-14">
        <Suspense fallback={<TestUserButtonSkeleton />}>
          <Story />
        </Suspense>
      </div>
    ),
  ],
} satisfies Meta<typeof TestUserButton>;

export default meta;
type Story = StoryObj<typeof meta>;

// The body lives in a dialog, so the story opens it and provisions before the card exists. The
// queries run against the document rather than the canvas because the dialog portals out of the root.
export const Active: Story = {
  args: { applicationId: baseApplication.id, environmentId: ENVIRONMENT_ID },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: /create test user/i }));
    const dialog = within(document.body);
    await userEvent.click(await dialog.findByRole("button", { name: /provision user/i }));
    await dialog.findByRole("button", { name: /tear down/i });
  },
};
