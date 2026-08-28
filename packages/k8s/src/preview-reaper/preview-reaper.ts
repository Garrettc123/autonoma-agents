import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import { BASE_PREVIEW_PR_NUMBER } from "../previewkit-labels";
import type { PreviewNamespaces } from "./preview-namespaces";

/** How long a preview namespace lives before the sweep reclaims it. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Guard on the one destructive write this sweep makes without evidence: marking a row
// torn down because its namespace was absent from `list()`. That branch trusts the
// listing completely, so a listing that under-reports - a wrong selector, a labelling
// regression, a partially-failed API call - reads as "the whole fleet vanished" and
// stamps every live environment. Past this share of live rows going missing at once, the
// listing is likelier to be broken than the fleet, so the sweep refuses to mark and
// raises instead. Age-based reaping of what it CAN see still runs: that path has a
// namespace in hand and is safe either way.
const MAX_MISSING_SHARE = 0.2;
// Below this many live rows, one absent namespace is a large share by arithmetic alone
// (a 3-environment dev database), so the share test only starts applying here.
const MISSING_SHARE_MIN_ROWS = 10;

export interface ReapOutcome {
    /** Rows the database called live whose namespace was already gone. Bookkeeping only. */
    markedGone: number;
    /** Namespaces past the TTL, deleted and marked in the same pass. */
    reaped: number;
    /** Namespaces past the TTL with no live row left to mark - deleted, nothing to record. */
    deletedWithoutRow: number;
    /** Live rows whose namespace is present and inside the TTL. Left alone. */
    healthy: number;
    /** True when the divergence guard tripped and no row was marked gone this run. */
    markGoneSkipped: boolean;
}

export interface ReapOptions {
    /** Report what would happen and write nothing. */
    dryRun?: boolean;
}

/**
 * Reconciles preview environments against the cluster that actually holds them.
 *
 * These two used to be managed by different things that never spoke: a shell
 * CronJob deleted any preview namespace older than a week, straight through
 * kubectl, while only the `pull_request.closed` webhook ever set `tornDownAt`. A
 * namespace reclaimed by age left its row saying `ready` forever - 814 of 1,438
 * live-looking rows had no namespace behind them, 423 of those still claiming
 * `ready`, which is what the dashboard and the usage meter were reading.
 *
 * One pass now owns both sides, so a namespace cannot go without its row being
 * told. The TTL is unchanged: this makes the database honest about the policy
 * rather than changing it.
 */
export class PreviewReaper {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly namespaces: PreviewNamespaces,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async run(now: Date, options: ReapOptions = {}): Promise<ReapOutcome> {
        const dryRun = options.dryRun === true;
        this.logger.info("Reconciling preview environments against the cluster", { extra: { dryRun } });

        const [live, present] = await Promise.all([
            this.db.previewkitEnvironment.findMany({
                where: { tornDownAt: null },
                select: { id: true, namespace: true },
            }),
            this.namespaces.list(),
        ]);

        const byName = new Map(present.map((namespace) => [namespace.name, namespace]));
        const liveNamespaces = new Set(live.map((environment) => environment.namespace));
        const outcome: ReapOutcome = {
            markedGone: 0,
            reaped: 0,
            deletedWithoutRow: 0,
            healthy: 0,
            markGoneSkipped: false,
        };
        const goneIds: string[] = [];

        const missing = live.filter((environment) => !byName.has(environment.namespace)).length;
        const markGoneAllowed = this.isMissingShareCredible(missing, live.length, present.length);
        outcome.markGoneSkipped = !markGoneAllowed;

        for (const environment of live) {
            const namespace = byName.get(environment.namespace);

            if (namespace == null) {
                // The namespace is already gone - by the old cron, by hand, or with the
                // cluster. Nothing to delete; the row is simply wrong. Collected rather
                // than written one at a time: the first run has ~800 of these, and they
                // are independent rows the database can settle in one statement.
                if (!markGoneAllowed) continue;
                outcome.markedGone += 1;
                goneIds.push(environment.id);
                continue;
            }
            if (!this.isExpired(namespace.createdAt, namespace.prNumber, now)) {
                outcome.healthy += 1;
                continue;
            }

            // Delete BEFORE marking: a mark that lands without the delete leaves a
            // namespace nothing will ever look at again, while a delete whose mark
            // fails is picked up as `markedGone` on the next pass.
            outcome.reaped += 1;
            if (dryRun) continue;
            await this.namespaces.delete(namespace.name);
            await this.markTornDown(environment.id);
        }

        // Namespaces the rows no longer account for. The old cron deleted purely by
        // age and so collected these too; without this the replacement would leave
        // them running forever.
        for (const namespace of present) {
            if (liveNamespaces.has(namespace.name)) continue;
            if (!this.isExpired(namespace.createdAt, namespace.prNumber, now)) continue;

            outcome.deletedWithoutRow += 1;
            if (!dryRun) await this.namespaces.delete(namespace.name);
        }

        if (goneIds.length > 0 && !dryRun) await this.markManyTornDown(goneIds);

        this.logger.info("Preview environment reconciliation complete", { extra: { ...outcome, dryRun } });
        return outcome;
    }

    /**
     * Whether the listing can be trusted enough to mark rows torn down. See
     * {@link MAX_MISSING_SHARE}; an empty listing against a non-empty database is always
     * refused, since that is the exact shape of a broken selector.
     */
    private isMissingShareCredible(missing: number, liveCount: number, presentCount: number): boolean {
        if (missing === 0) return true;
        // Checked before the share test AND before the empty-listing test: at this size any
        // share is uninformative, and a single environment that genuinely went away leaves a
        // legitimately empty listing.
        if (liveCount < MISSING_SHARE_MIN_ROWS) return true;

        if (presentCount === 0) {
            this.logger.error(
                "Preview namespace listing came back empty while environments are live; refusing to mark any row torn down",
                new Error("Empty preview namespace listing"),
                { extra: { liveCount, missing } },
            );
            return false;
        }

        if (missing / liveCount <= MAX_MISSING_SHARE) return true;

        this.logger.error(
            "Too many live environments missing from the preview namespace listing; refusing to mark any row torn down",
            new Error("Implausible preview namespace listing"),
            { extra: { liveCount, presentCount, missing, share: missing / liveCount, threshold: MAX_MISSING_SHARE } },
        );
        return false;
    }

    /**
     * The main-branch environment is permanent: it has no pull request to close, so age is
     * not evidence of anything. Read from the namespace's own `pr-number` label rather than
     * its name, which has already changed format once and took this guard with it.
     */
    private isExpired(createdAt: Date, prNumber: number, now: Date): boolean {
        if (prNumber === BASE_PREVIEW_PR_NUMBER) return false;
        return now.getTime() - createdAt.getTime() > MAX_AGE_MS;
    }

    /**
     * `tornDownAt: null` is in the filter as well as the id: a row something else
     * tore down while this sweep was running has a truer timestamp than the one
     * here, and must not be overwritten with a later one.
     */
    private async markManyTornDown(ids: readonly string[]): Promise<void> {
        await this.db.previewkitEnvironment.updateMany({
            where: { id: { in: [...ids] }, tornDownAt: null },
            data: { status: "torn_down", phase: "torn_down", tornDownAt: new Date() },
        });
    }

    private async markTornDown(id: string): Promise<void> {
        await this.db.previewkitEnvironment.update({
            where: { id },
            data: { status: "torn_down", phase: "torn_down", tornDownAt: new Date() },
        });
    }
}
