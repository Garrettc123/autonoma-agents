import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect } from "vitest";
import { ApplicationMemoriesUpserter } from "../../src/application-memories/application-memories-upserter";
import { parseApplicationMemoryFile } from "../../src/application-memories/parse-application-memory-file";
import { apiTestSuite } from "../api-test";

const FIRST_RUN = [
    parseApplicationMemoryFile(
        "checkout-toast-is-transient.md",
        `---
title: Checkout toast is transient
description: Read when a success toast disappeared before you could verify it.
---
The toast auto-dismisses after about three seconds.
`,
    ),
    parseApplicationMemoryFile(
        "dashboard-skeletons.md",
        `---
title: Dashboard loads with skeletons
description: Read when the dashboard shows grey placeholder blocks.
---
Grey blocks are loading skeletons; wait for them to resolve.
`,
    ),
];

/** The same two files after an author edited both bodies and renamed the first memory's title. */
const SECOND_RUN = [
    parseApplicationMemoryFile(
        "checkout-toast-is-transient.md",
        `---
title: Checkout toast disappears quickly
description: Read when a success toast disappeared before you could verify it, or never showed.
---
The toast auto-dismisses after about three seconds. It is easy to miss on a slow preview.
`,
    ),
    parseApplicationMemoryFile(
        "dashboard-skeletons.md",
        `---
title: Dashboard loads with skeletons
description: Read when the dashboard shows grey placeholder blocks.
---
Grey blocks are loading skeletons; wait for them to resolve. The balance card shows them longest.
`,
    ),
];

apiTestSuite({
    name: "application memories upserter",
    seed: async ({ harness }) => {
        const [app, otherApp] = await Promise.all([
            harness.services.applications.createApplication({
                name: "Remembered App",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            }),
            harness.services.applications.createApplication({
                name: "Other App",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://other.example.com",
                file: "s3://bucket/default-file.png",
            }),
        ]);
        return { app, otherApp };
    },
    cases: (test) => {
        test("a second run over edited files updates the same rows instead of adding new ones", async ({
            harness,
            seedResult: { app },
        }) => {
            const upserter = new ApplicationMemoriesUpserter(harness.db);

            const first = await upserter.upsert(app.id, FIRST_RUN);
            expect(first.created).toEqual(["checkout-toast-is-transient", "dashboard-skeletons"]);
            expect(first.updated).toEqual([]);
            const before = await harness.db.applicationMemory.findMany({
                where: { applicationId: app.id },
                orderBy: { slug: "asc" },
            });
            expect(before).toHaveLength(2);
            expect(before.every((row) => row.organizationId === harness.organizationId)).toBe(true);
            expect(before.every((row) => row.enabled)).toBe(true);

            const second = await upserter.upsert(app.id, SECOND_RUN);
            expect(second.created).toEqual([]);
            expect(second.updated).toEqual(["checkout-toast-is-transient", "dashboard-skeletons"]);

            const after = await harness.db.applicationMemory.findMany({
                where: { applicationId: app.id },
                orderBy: { slug: "asc" },
            });
            expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
            expect(after.map((row) => row.slug)).toEqual(before.map((row) => row.slug));

            const [toast, skeletons] = after;
            expect(toast?.title).toBe("Checkout toast disappears quickly");
            expect(toast?.description).toContain("or never showed");
            expect(toast?.content).toContain("easy to miss on a slow preview");
            expect(skeletons?.content).toContain("The balance card shows them longest");
        });

        test("a memory switched off in SQL stays off when the files are re-applied", async ({
            harness,
            seedResult: { app },
        }) => {
            const upserter = new ApplicationMemoriesUpserter(harness.db);
            await upserter.upsert(app.id, FIRST_RUN);
            await harness.db.applicationMemory.updateMany({
                where: { applicationId: app.id },
                data: { enabled: false },
            });

            await upserter.upsert(app.id, SECOND_RUN);

            const rows = await harness.db.applicationMemory.findMany({ where: { applicationId: app.id } });
            expect(rows).toHaveLength(2);
            expect(rows.every((row) => !row.enabled)).toBe(true);
        });

        test("the same slug on two applications are two memories", async ({
            harness,
            seedResult: { app, otherApp },
        }) => {
            const upserter = new ApplicationMemoriesUpserter(harness.db);

            await upserter.upsert(app.id, FIRST_RUN);
            const result = await upserter.upsert(otherApp.id, FIRST_RUN);

            expect(result.created).toEqual(["checkout-toast-is-transient", "dashboard-skeletons"]);
            const rows = await harness.db.applicationMemory.findMany({
                where: { slug: "checkout-toast-is-transient", applicationId: { in: [app.id, otherApp.id] } },
            });
            expect(rows).toHaveLength(2);
        });

        test("an unknown application writes nothing", async ({ harness }) => {
            const upserter = new ApplicationMemoriesUpserter(harness.db);

            await expect(upserter.upsert("does-not-exist", FIRST_RUN)).rejects.toThrow(NotFoundError);
            expect(await harness.db.applicationMemory.count({ where: { applicationId: "does-not-exist" } })).toBe(0);
        });
    },
});
