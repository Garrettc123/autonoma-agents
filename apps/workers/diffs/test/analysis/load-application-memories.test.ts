import { expect } from "vitest";
import { loadEnabledApplicationMemories } from "../../src/analysis/load-application-memories";
import { diffJobContextSuite } from "../harness";

diffJobContextSuite({
    name: "loadEnabledApplicationMemories",
    cases: (test) => {
        test("returns only the enabled memories, in slug order, with content", async ({ harness, seedResult }) => {
            const organizationId = seedResult.organizationId;
            // A fresh application per test: the suite seeds one app for the whole suite, so isolating here
            // keeps one test's memory rows out of another's read.
            const applicationId = await harness.createApp(organizationId);
            await harness.db.applicationMemory.createMany({
                data: [
                    {
                        applicationId,
                        organizationId,
                        slug: "zebra-first-by-slug",
                        title: "Zebra",
                        description: "Sorts last alphabetically but is enabled.",
                        content: "Zebra content.",
                    },
                    {
                        applicationId,
                        organizationId,
                        slug: "alpha-enabled",
                        title: "Alpha",
                        description: "Comes first by slug.",
                        content: "Alpha content.",
                    },
                    {
                        applicationId,
                        organizationId,
                        slug: "mid-disabled",
                        title: "Disabled",
                        description: "Switched off in SQL, so invisible to the pipeline.",
                        content: "Disabled content.",
                        enabled: false,
                    },
                ],
            });

            const memories = await loadEnabledApplicationMemories(applicationId, harness.db);

            expect(memories).toEqual([
                {
                    slug: "alpha-enabled",
                    title: "Alpha",
                    description: "Comes first by slug.",
                    content: "Alpha content.",
                },
                {
                    slug: "zebra-first-by-slug",
                    title: "Zebra",
                    description: "Sorts last alphabetically but is enabled.",
                    content: "Zebra content.",
                },
            ]);
        });

        test("returns an empty list for an application with no enabled memories", async ({ harness, seedResult }) => {
            const organizationId = seedResult.organizationId;
            const applicationId = await harness.createApp(organizationId);
            await harness.db.applicationMemory.create({
                data: {
                    applicationId,
                    organizationId,
                    slug: "only-one-and-off",
                    title: "Off",
                    description: "The single memory is disabled.",
                    content: "Off content.",
                    enabled: false,
                },
            });

            expect(await loadEnabledApplicationMemories(applicationId, harness.db)).toEqual([]);
        });
    },
});
