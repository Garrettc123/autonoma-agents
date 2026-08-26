import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";

const LOOSE_LIST_CONTENT = `Following the directive to focus on the custom card color creation flow and potential backend persistence issues, I have performed the following actions:

1. **Test Impact Analysis**:
    - Marked \`create-card-with-custom-color-md-338cb3f8\` as affected, as it is the primary test for the flow mentioned in the directive.
    - Marked \`create-physical-card-md\` and \`create-virtual-card-md\` as they verify card creation counts which the directive identifies as a key verification point.
    - Marked journeys \`internal-transfer-and-card-creation-md\` and \`notifications-and-physical-card-creation-md\` as they exercise the card issuance flow in a broader context.

2. **Test Gap Detection & Creation**:
    - Authored \`create-virtual-card-with-custom-color-persistence.md\` to verify that a new virtual card (with custom color 'Violet') correctly updates the active card count and, crucially, persists that update after a page refresh.
    - Authored \`create-physical-card-with-custom-color-persistence.md\` to verify the same for physical cards (with custom color 'Gold').

3. **Findings**:
    - The current frontend implementation in \`components/new-card-dialog.tsx\` still uses a \`setTimeout\` to simulate an API call, and \`app/page.tsx\` only updates local state upon success.
    - Since card color is not currently displayed in the dashboard list, verification of "color persistence" is primarily through ensuring the creation itself persists.

No merge conflicts were identified for this run.`;

const meta = {
  title: "Components/ReasoningMarkdown",
  component: ReasoningMarkdown,
} satisfies Meta<typeof ReasoningMarkdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LooseList: Story = {
  args: { content: LOOSE_LIST_CONTENT },
  decorators: [
    (Story) => (
      <div className="max-w-4xl bg-surface-void p-10">
        <Story />
      </div>
    ),
  ],
};
