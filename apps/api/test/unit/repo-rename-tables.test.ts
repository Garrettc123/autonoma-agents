import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_NAME_BACKFILL_MODELS } from "../../src/github/repo-rename.service";

const SCHEMA_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/db/prisma/schema.prisma",
);

/** Every Prisma model declaring a `repoFullName` field, read straight from the schema. */
function modelsWithRepoFullName(schema: string): string[] {
    const models: string[] = [];
    let current: string | undefined;

    for (const line of schema.split("\n")) {
        const modelStart = /^model (\w+) \{/.exec(line);
        if (modelStart?.[1] != null) {
            current = modelStart[1];
            continue;
        }
        if (line === "}") {
            current = undefined;
            continue;
        }
        if (current != null && /^\s*repoFullName\s/.test(line)) {
            models.push(current);
        }
    }

    return models;
}

/** Prisma exposes `model GitHubPrComment` on the client as `gitHubPrComment` - only the first letter changes. */
function toClientKey(modelName: string): string {
    return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

describe("repo rename backfill coverage", () => {
    it("covers every model that denormalizes repoFullName", () => {
        const schema = readFileSync(SCHEMA_PATH, "utf8");
        const expected = modelsWithRepoFullName(schema).map(toClientKey).sort();

        // Guards against silent rot: a new table with a repoFullName that nobody adds to the service
        // keeps working right up until a repo is renamed, then strands its rows under the dead name.
        expect([...REPO_NAME_BACKFILL_MODELS].sort()).toEqual(expected);
    });

    it("finds the models it is meant to be reading", () => {
        const schema = readFileSync(SCHEMA_PATH, "utf8");

        // If the schema ever moves or the parser stops matching, the assertion above would pass
        // vacuously by comparing two empty lists.
        expect(modelsWithRepoFullName(schema).length).toBeGreaterThan(0);
    });
});
