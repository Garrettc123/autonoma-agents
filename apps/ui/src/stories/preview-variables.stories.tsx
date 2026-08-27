import { authoringPreviewConfigSchema, previewConfigSchema, zodIssuesToConfigIssues } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { userEvent, within } from "storybook/test";
import { EnvVarManager } from "../routes/_blacklight/_app-shell/app.$appSlug/settings/previews/-variables/env-var-manager";
import {
  documentFromDraft,
  draftFromConfig,
  emptyDraftIssues,
  mapIssuesToDraft,
  withSecretRows,
  type AppDraft,
  type DraftIssues,
} from "../routes/_blacklight/onboarding/-components/previewkit/topology-draft";

// Secrets live outside the config document, so it carries only their keys - the
// editor merges them in as write-only rows with an empty value.
const STORED_SECRETS = [
  { key: "STRIPE_SECRET_KEY", buildTime: false },
  { key: "RESEND_API_KEY", buildTime: true },
];

/** A saved config for the ordinary shape: one Next.js web app wired to a Postgres service. */
const savedConfig = previewConfigSchema.parse({
  version: 2,
  apps: [
    {
      name: "web",
      repository: "acme/storefront",
      path: ".",
      port: 3000,
      primary: true,
      build: {
        framework: "runtime",
        runtime: "node",
        version: "22",
        build_script: "pnpm install --frozen-lockfile\npnpm run build",
        entrypoint: "pnpm start",
        build_context: "root",
      },
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}", build_time: true }],
    },
  ],
  services: [{ name: "db", recipe: "postgres", version: "16" }],
});

const baseDraft = draftFromConfig(savedConfig, [{ repo: "acme/storefront", primary: true }], "saved");

/** The saved app plus the masked secret rows the editor merges in from the store. */
const webApp: AppDraft = {
  ...baseDraft.apps[0]!,
  env: withSecretRows(baseDraft.apps[0]!.env, STORED_SECRETS),
};

/**
 * The editor opens in a slide-over when a row is clicked, so a story that shows the
 * editor moves its row to the front (so it's the first thing in the list) and clicks
 * it from a `play` function.
 */
function frontmost(app: AppDraft, key: string): AppDraft {
  const selected = app.env.find((row) => row.key === key);
  if (selected == null) return app;
  return { ...app, env: [selected, ...app.env.filter((row) => row.id !== selected.id)] };
}

/** Clicks the named variable row to open its editor slide-over. */
function openRow(key: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await userEvent.click(await within(canvasElement).findByText(key));
  };
}

/**
 * Runs the draft through the real validation pipeline - compile, parse against the
 * authoring contract, map the Zod issues onto draft fields - so the story shows the
 * messages the editor actually renders rather than a hand-written copy of them.
 */
function issuesFor(app: AppDraft): DraftIssues {
  const compiled = documentFromDraft({ ...baseDraft, apps: [app] });
  const parsed = authoringPreviewConfigSchema.safeParse(compiled.document);
  if (parsed.success) return emptyDraftIssues();
  return mapIssuesToDraft(zodIssuesToConfigIssues(parsed.error), compiled.indexToDraftId);
}

function VariablesEditor({ initial }: { initial: AppDraft }) {
  const [app, setApp] = useState(initial);
  return (
    <EnvVarManager
      app={app}
      services={baseDraft.services}
      deployableApps={[app]}
      issues={issuesFor(app)}
      updateApp={(_id, patch) => setApp((current) => ({ ...current, ...patch }))}
    />
  );
}

const meta = {
  title: "Onboarding/PreviewVariables",
  component: VariablesEditor,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-5xl bg-surface-void p-14">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VariablesEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The list an app ends up with: a `DATABASE_URL` connection wired to the Postgres
 * service (also passed to the image build, hence the Build chip) and two secrets.
 * The drawer holds a stored secret, whose value the store never returns - it renders as
 * `•••••• (set)` with the only edit that exists for it, Replace value.
 */
/** The resting state: connections and secrets in one full-width list, no editor open. */
export const List: Story = {
  args: { initial: webApp },
};

export const SecretSelected: Story = {
  args: { initial: frontmost(webApp, "STRIPE_SECRET_KEY") },
  play: openRow("STRIPE_SECRET_KEY"),
};

/**
 * The same list with the connection's editor open: source Connection, value
 * `{{db.url}}`, and the live "Fills in at deploy" block naming what the token
 * becomes on the preview - the service's connection string.
 */
export const ConnectionSelected: Story = {
  args: { initial: frontmost(webApp, "DATABASE_URL") },
  play: openRow("DATABASE_URL"),
};

/**
 * A secret the image build needs too - a Next.js build that prerenders pages
 * against Stripe can't wait for runtime injection. The Injection block spells out
 * that runtime is always on and the build-time switch is the opt-in.
 */
export const BuildTimeInjection: Story = {
  args: {
    initial: frontmost(
      {
        ...webApp,
        env: webApp.env.map((row) => (row.key === "STRIPE_SECRET_KEY" ? { ...row, buildTime: true } : row)),
      },
      "STRIPE_SECRET_KEY",
    ),
  },
  play: openRow("STRIPE_SECRET_KEY"),
};
