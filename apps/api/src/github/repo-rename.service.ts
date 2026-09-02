import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";

/**
 * Only the fields the backfill needs, parsed defensively from the raw GitHub `repository` webhook.
 * `changes.repository.name.from` is the bare old NAME, not a full name: a rename never moves the repo
 * between accounts (that is `repository.transferred`, a separate event), so the owner in the payload is
 * still the owner it had before, and the old full name is that owner joined to the old name.
 */
const repositoryRenamedEventSchema = z.object({
    repository: z.object({
        id: z.number(),
        full_name: z.string().min(1),
        owner: z.object({ login: z.string().min(1) }),
    }),
    changes: z.object({
        repository: z.object({
            name: z.object({ from: z.string().min(1) }),
        }),
    }),
});

/** Moves one table's rows from the old repo full name to the new one, returning how many it moved. */
type RepoNameBackfill = (tx: Prisma.TransactionClient, from: string, to: string) => Promise<{ count: number }>;

/**
 * Every table that denormalizes a repo's full name, keyed by its Prisma model name. Written by hand
 * because a typed `updateMany` needs a concrete delegate, but deliberately NOT trusted to stay complete:
 * `repo-rename-tables.test.ts` derives the same set from schema.prisma and fails when a model gains a
 * `repoFullName` without being added here. A missing entry throws nothing at runtime - it just leaves
 * that table's rows stranded under a name nothing will ever look up again, which is the exact failure
 * this service exists to prevent.
 */
const REPO_NAME_BACKFILLS = {
    branchContributor: (tx, from, to) =>
        tx.branchContributor.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
    bugFixOutcome: (tx, from, to) =>
        tx.bugFixOutcome.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
    findingFalsePositiveCandidate: (tx, from, to) =>
        tx.findingFalsePositiveCandidate.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
    gitHubCheckRun: (tx, from, to) =>
        tx.gitHubCheckRun.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
    gitHubPrComment: (tx, from, to) =>
        tx.gitHubPrComment.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
    previewkitBuildCircuit: (tx, from, to) =>
        tx.previewkitBuildCircuit.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
    previewkitEnvironment: (tx, from, to) =>
        tx.previewkitEnvironment.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
    skipRecord: (tx, from, to) =>
        tx.skipRecord.updateMany({ where: { repoFullName: from }, data: { repoFullName: to } }),
} satisfies Record<string, RepoNameBackfill>;

/** The Prisma model names this service keeps in sync, for the schema-completeness guard test. */
export const REPO_NAME_BACKFILL_MODELS: readonly string[] = Object.keys(REPO_NAME_BACKFILLS);

/**
 * Keeps the denormalized `repoFullName` columns correct when a repository is renamed on GitHub.
 *
 * `githubRepositoryId` is the stable identity, but eight tables store the full name instead - several
 * keyed on it uniquely - so before this existed a rename silently orphaned every one of their rows.
 * Nothing errored: the PR-comment store simply looked up the old name, found nothing, and posted a
 * SECOND comment on a PR that already had one; the preview build circuit forgot an app's failure
 * streak; contributor attribution and skip records restarted from empty.
 */
export class RepoRenameService {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Rewrite every denormalized copy of the repo's old full name to its new one.
     *
     * Rows are matched by full name alone rather than scoped to the webhook's organization: a GitHub
     * full name is globally unique, and two Autonoma orgs may both track one repo. Each org's
     * installation receives its own delivery, so a global rewrite makes the first delivery fix
     * everything and every later one a no-op, instead of each fixing only its own slice.
     */
    async backfillFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = repositoryRenamedEventSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("repository.renamed webhook missing expected fields; skipping backfill", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }

        const { repository, changes } = parsed.data;
        const to = repository.full_name;
        const from = `${repository.owner.login}/${changes.repository.name.from}`;

        if (from === to) {
            this.logger.info("repository.renamed reported an unchanged full name; nothing to backfill", {
                organizationId,
                extra: { repoFullName: to, githubRepositoryId: repository.id },
            });
            return;
        }

        this.logger.info("Backfilling denormalized repo names after rename", {
            organizationId,
            extra: { from, to, githubRepositoryId: repository.id },
        });

        // One transaction so a unique-constraint collision (a name that some older repo's rows still
        // occupy) leaves every table untouched rather than half-migrated. Sequential inside it: these
        // share one connection, so a Promise.all would buy no real concurrency.
        const { moved, canonical } = await this.db.$transaction(async (tx) => {
            const counts: Record<string, number> = {};
            for (const [model, backfill] of Object.entries(REPO_NAME_BACKFILLS)) {
                const { count } = await backfill(tx, from, to);
                if (count > 0) counts[model] = count;
            }
            const outcome = await renameCanonicalRow(tx, from, to, repository.id);
            return { moved: counts, canonical: outcome };
        });

        this.logger.info("Backfilled denormalized repo names after rename", {
            organizationId,
            extra: { from, to, githubRepositoryId: repository.id, moved, canonical },
        });
    }
}

/** What happened to the canonical `GitHubRepository` row, for the log line. */
type CanonicalOutcome = "renamed" | "created" | "unchanged";

/**
 * Point the canonical `GitHubRepository` row at the new name.
 *
 * Renamed IN PLACE, never deleted and recreated: the tables carrying `repoFullName` are migrating onto
 * this row's `id`, so replacing the row would orphan every reference the moment those foreign keys
 * exist - reintroducing, against a different column, the exact bug this service was written to fix.
 *
 * Resolved by numeric id first, since that is the one identifier a rename cannot change, falling back
 * to the old name for a row seeded before any id was known (seven of the eight tables store no id, so
 * most seeded rows start with `githubId` null).
 */
async function renameCanonicalRow(
    tx: Prisma.TransactionClient,
    from: string,
    to: string,
    githubId: number,
): Promise<CanonicalOutcome> {
    const existing =
        (await tx.gitHubRepository.findUnique({ where: { githubId } })) ??
        (await tx.gitHubRepository.findUnique({ where: { fullName: from } }));

    if (existing == null) {
        // No row under either identifier: a repo we have stored nothing about yet, or one whose
        // rename we are seeing before anything else touched it.
        await tx.gitHubRepository.upsert({
            where: { fullName: to },
            create: { fullName: to, githubId },
            update: { githubId },
        });
        return "created";
    }

    if (existing.fullName === to && existing.githubId === githubId) return "unchanged";

    // A distinct row already holding `to` makes this throw, rolling the whole transaction back. That
    // needs the new name to be one we have seen before - a rename onto a previously-used name - and is
    // deliberately left loud rather than resolved by deleting somebody's row, matching how a collision
    // on the eight tables above behaves.
    await tx.gitHubRepository.update({ where: { id: existing.id }, data: { fullName: to, githubId } });
    return "renamed";
}
