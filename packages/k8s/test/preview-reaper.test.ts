import { createClient, type PrismaClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import type { PreviewNamespace, PreviewNamespaces } from "../src/preview-reaper";
import { PreviewReaper } from "../src/preview-reaper";

const NOW = new Date("2026-08-19T12:00:00Z");
const FRESH = new Date("2026-08-18T12:00:00Z");
const ANCIENT = new Date("2026-07-01T12:00:00Z");

/**
 * A preview namespace as the cluster would report it. `prNumber` comes from the
 * `previewkit.dev/pr-number` label in real life, which is what makes the name
 * irrelevant to every rule below.
 */
function ns(name: string, createdAt: Date, prNumber = 7): PreviewNamespace {
    return { name, createdAt, prNumber };
}

/** A stand-in cluster. Real Postgres, faked Kubernetes - the rules under test are about rows. */
class FakeNamespaces implements PreviewNamespaces {
    readonly deleted: string[] = [];

    constructor(private namespaces: PreviewNamespace[]) {}

    async list(): Promise<PreviewNamespace[]> {
        return this.namespaces;
    }

    async delete(name: string): Promise<void> {
        this.deleted.push(name);
        this.namespaces = this.namespaces.filter((namespace) => namespace.name !== name);
    }
}

class ReaperHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<ReaperHarness> {
        return new ReaperHarness(createClient(await createTestDatabase()));
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {
        await this.db.$executeRawUnsafe('TRUNCATE TABLE "organization" CASCADE');
    }
    async afterEach() {}

    async seedEnvironment(namespace: string): Promise<string> {
        const org = await this.db.organization.create({
            data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
        });
        const environment = await this.db.previewkitEnvironment.create({
            data: {
                organizationId: org.id,
                namespace,
                repoFullName: "acme/web",
                prNumber: Math.floor(Math.random() * 100_000),
                headSha: "sha",
                headRef: "branch",
                status: "ready",
            },
        });
        return environment.id;
    }

    async statusOf(id: string) {
        return await this.db.previewkitEnvironment.findUniqueOrThrow({
            where: { id },
            select: { status: true, tornDownAt: true },
        });
    }
}

integrationTestSuite({
    name: "PreviewReaper",
    createHarness: () => ReaperHarness.create(),
    cases: (test) => {
        /**
         * The 814 rows this job exists for: the namespace went without anything
         * telling the row, so it has been claiming `ready` ever since.
         */
        test("marks a row whose namespace is already gone, and deletes nothing", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-1");
            const cluster = new FakeNamespaces([]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.markedGone).toBe(1);
            expect(cluster.deleted).toEqual([]);
            const after = await harness.statusOf(id);
            expect(after.status).toBe("torn_down");
            expect(after.tornDownAt).not.toBeNull();
        });

        test("reaps a namespace past the TTL and marks its row in the same pass", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-2");
            const cluster = new FakeNamespaces([ns("preview-acme-web-pr-2", ANCIENT)]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.reaped).toBe(1);
            expect(cluster.deleted).toEqual(["preview-acme-web-pr-2"]);
            expect((await harness.statusOf(id)).status).toBe("torn_down");
        });

        test("leaves a namespace inside the TTL completely alone", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-3");
            const cluster = new FakeNamespaces([ns("preview-acme-web-pr-3", FRESH)]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome).toMatchObject({ healthy: 1, reaped: 0, markedGone: 0 });
            expect(cluster.deleted).toEqual([]);
            expect((await harness.statusOf(id)).status).toBe("ready");
        });

        /**
         * The base preview has no pull request to close, so age is not a reason to take it.
         * Pinned against the CURRENT namespace format, because the guard used to read
         * `name.endsWith("-pr-0")` - which every base preview stopped matching the moment the
         * format became `{owner}-{repo}-{N}-{hash}`, leaving 69 permanent main-branch
         * environments one working namespace listing away from being deleted by age.
         */
        test("never reaps the base preview, however old, whatever its name looks like", async ({ harness }) => {
            const hashed = "acme-web-0-c6156866caa8da6f";
            const id = await harness.seedEnvironment(hashed);
            const cluster = new FakeNamespaces([ns(hashed, ANCIENT, 0)]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.reaped).toBe(0);
            expect(cluster.deleted).toEqual([]);
            expect((await harness.statusOf(id)).status).toBe("ready");
        });

        /** Same rule, reached through a row nothing accounts for - the other call site of isExpired. */
        test("never deletes an unaccounted base preview namespace by age", async ({ harness }) => {
            const cluster = new FakeNamespaces([ns("acme-orphan-0-1f8ef054c9024424", ANCIENT, 0)]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.deletedWithoutRow).toBe(0);
            expect(cluster.deleted).toEqual([]);
        });

        /** A namespace in the current hashed format is reaped by age exactly like any other. */
        test("reaps a hashed-format namespace past the TTL", async ({ harness }) => {
            const hashed = "acme-web-259-c6156866caa8da6f";
            const id = await harness.seedEnvironment(hashed);
            const cluster = new FakeNamespaces([ns(hashed, ANCIENT, 259)]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.reaped).toBe(1);
            expect(cluster.deleted).toEqual([hashed]);
            expect((await harness.statusOf(id)).status).toBe("torn_down");
        });

        /**
         * The shell cron deleted by age alone, so it also collected namespaces no row
         * accounted for. Without this the replacement would leave them running.
         */
        test("deletes an expired namespace that no live row accounts for", async ({ harness }) => {
            const cluster = new FakeNamespaces([ns("preview-orphan-pr-9", ANCIENT)]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.deletedWithoutRow).toBe(1);
            expect(cluster.deleted).toEqual(["preview-orphan-pr-9"]);
        });

        test("a dry run reports the same work and performs none of it", async ({ harness }) => {
            const gone = await harness.seedEnvironment("preview-acme-web-pr-4");
            const expired = await harness.seedEnvironment("preview-acme-web-pr-5");
            const cluster = new FakeNamespaces([
                ns("preview-acme-web-pr-5", ANCIENT),
                ns("preview-orphan-pr-6", ANCIENT),
            ]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW, { dryRun: true });

            expect(outcome).toMatchObject({ markedGone: 1, reaped: 1, deletedWithoutRow: 1 });
            expect(cluster.deleted).toEqual([]);
            expect((await harness.statusOf(gone)).status).toBe("ready");
            expect((await harness.statusOf(expired)).status).toBe("ready");
        });

        /**
         * The failure this guard exists for: a listing that under-reports (a selector matching a
         * retired namespace format) makes every live environment look gone, and the mark-gone
         * branch stamps all of them `torn_down` while they are serving traffic.
         */
        test("refuses to mark anything gone when most live rows are missing from the listing", async ({ harness }) => {
            const ids = await Promise.all(
                Array.from({ length: 12 }, (_, index) => harness.seedEnvironment(`acme-web-${index}-abcdef0123456789`)),
            );
            // Only one of the twelve is visible: 92% missing, far past the threshold.
            const cluster = new FakeNamespaces([ns("acme-web-0-abcdef0123456789", FRESH)]);

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome.markGoneSkipped).toBe(true);
            expect(outcome.markedGone).toBe(0);
            const statuses = await Promise.all(ids.map((id) => harness.statusOf(id)));
            expect(statuses.every((status) => status.status === "ready")).toBe(true);
            expect(statuses.every((status) => status.tornDownAt === null)).toBe(true);
        });

        /** An empty listing against a populated database is the same failure at its extreme. */
        test("refuses to mark anything gone when the listing is empty", async ({ harness }) => {
            const ids = await Promise.all(
                Array.from({ length: 10 }, (_, index) =>
                    harness.seedEnvironment(`acme-empty-${index}-abcdef0123456789`),
                ),
            );

            const outcome = await new PreviewReaper(harness.db, new FakeNamespaces([])).run(NOW);

            expect(outcome).toMatchObject({ markGoneSkipped: true, markedGone: 0 });
            const statuses = await Promise.all(ids.map((id) => harness.statusOf(id)));
            expect(statuses.every((status) => status.status === "ready")).toBe(true);
        });

        /**
         * The guard must not swallow the job's actual purpose. A believable number of genuinely
         * departed namespaces still gets marked.
         */
        test("still marks gone rows when the share missing is believable", async ({ harness }) => {
            const present = await Promise.all(
                Array.from({ length: 10 }, (_, index) =>
                    harness.seedEnvironment(`acme-live-${index}-abcdef0123456789`),
                ),
            );
            const gone = await harness.seedEnvironment("acme-departed-99-abcdef0123456789");
            const cluster = new FakeNamespaces(
                present.map((_, index) => ns(`acme-live-${index}-abcdef0123456789`, FRESH)),
            );

            const outcome = await new PreviewReaper(harness.db, cluster).run(NOW);

            expect(outcome).toMatchObject({ markGoneSkipped: false, markedGone: 1, healthy: 10 });
            expect((await harness.statusOf(gone)).status).toBe("torn_down");
        });

        test("an already torn-down row is not looked at again", async ({ harness }) => {
            const id = await harness.seedEnvironment("preview-acme-web-pr-7");
            await harness.db.previewkitEnvironment.update({
                where: { id },
                data: { status: "torn_down", tornDownAt: new Date() },
            });

            const outcome = await new PreviewReaper(harness.db, new FakeNamespaces([])).run(NOW);

            expect(outcome).toMatchObject({ markedGone: 0, reaped: 0, healthy: 0 });
        });
    },
});
