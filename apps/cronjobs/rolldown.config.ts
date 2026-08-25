import { readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "rolldown";

// Bundle each cronjob entrypoint and its npm/workspace deps into a single minified
// ESM file so the runtime image ships `dist/*.js` instead of the whole monorepo
// `node_modules` + tsx. Only node builtins stay external.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

const SCRIPTS_DIR = "scripts";

// `dist/<name>.js` for the three jobs whose bundle name predates their directory name; every
// CronJob manifest's `command:` names the bundle, so renaming these would break the deployed jobs.
const BUNDLE_NAME_OVERRIDES: Record<string, string> = {
    "vercel-billing-invoicer": "billing-invoicer",
    "vercel-usage-reporter": "usage-reporter",
    "preview-usage-meter": "usage-meter",
};

/**
 * Every `scripts/<job>/index.ts`, discovered rather than hand-listed: a job whose entry is missing
 * here builds into an image that silently lacks it, and its CronJob then crashloops on a `dist/`
 * file that was never produced. Adding the directory is enough.
 */
function jobEntrypoints(): Record<string, string> {
    const entries = readdirSync(SCRIPTS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const bundleName = BUNDLE_NAME_OVERRIDES[entry.name] ?? entry.name;
            return [bundleName, `${SCRIPTS_DIR}/${entry.name}/index.ts`] as const;
        });
    return Object.fromEntries(entries);
}

export default defineConfig({
    input: jobEntrypoints(),
    output: {
        dir: "dist",
        format: "esm",
        sourcemap: true,
        entryFileNames: "[name].js",
        minify: true,
    },
    platform: "node",
    external: nodeBuiltins,
});
