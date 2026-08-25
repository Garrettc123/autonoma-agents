import { builtinModules } from "node:module";
import { defineConfig } from "rolldown";

// Bundle the watcher and its npm/workspace deps into a single minified ESM file so the runtime
// image ships `dist/index.js` instead of the whole monorepo `node_modules` + tsx. Only node
// builtins stay external.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
    input: { index: "src/index.ts" },
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
