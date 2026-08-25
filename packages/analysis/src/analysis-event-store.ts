import { type Prisma, type PrismaClient, PullRequestCacheState, SnapshotStatus } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type AnalysisEventBody,
    analysisEventBodySchema,
    type AnalysisEventSource,
    analysisEventSourceSchema,
} from "@autonoma/types";

/**
 * A claim is "live" while its snapshot is still in flight (`processing`) or is the branch's settled active suite
 * (`active`). Any other terminal - `superseded`, `cancelled`, `failed` - means the claiming run's work was thrown
 * away (a terminated run executes no cleanup code), so its events return to pending for a successor to steal.
 *
 * Derived as the complement of the live set over the whole {@link SnapshotStatus} enum rather than hardcoded, so a
 * new status can never silently land in the reclaimable bucket without a deliberate choice here.
 */
const LIVE_CLAIM_STATUSES: ReadonlySet<SnapshotStatus> = new Set([SnapshotStatus.processing, SnapshotStatus.active]);
const RECLAIMABLE_CLAIM_STATUSES: SnapshotStatus[] = Object.values(SnapshotStatus).filter(
    (status) => !LIVE_CLAIM_STATUSES.has(status),
);

/**
 * PR states that mean the branch is done and will never run again, so a pending event on it is dead weight every
 * reader must skip - otherwise a credit top-up re-pokes a closed PR forever, and a stale event holds the
 * already-analyzed skip open forever. A `draft` PR is deliberately NOT here: it is temporary, and its events stay
 * eligible for when it reopens. A branch with no PR row at all (main) is always eligible, and an absent `prState`
 * fails open, so only these two terminal states exclude a branch.
 */
const TERMINAL_PR_STATES: PullRequestCacheState[] = [PullRequestCacheState.closed, PullRequestCacheState.merged];

export interface EnqueueAnalysisEventInput {
    branchId: string;
    organizationId: string;
    /** Which producer path this event came in through. */
    source: AnalysisEventSource;
    /** The typed event body (`type` + its payload); re-validated at this boundary before it becomes a row. */
    event: AnalysisEventBody;
}

/**
 * One `analysis_event` row, decoded: its metadata plus the discriminated `type`/`payload` body, so a reader that
 * narrows on `type` gets the payload's precise shape.
 */
export type AnalysisEventRecord = AnalysisEventBody & {
    id: string;
    branchId: string;
    organizationId: string;
    source: AnalysisEventSource;
    createdAt: Date;
    /** The snapshot whose run has claimed this event; absent while pending. */
    claimedBySnapshotId?: string;
};

type AnalysisEventRow = {
    id: string;
    branchId: string;
    organizationId: string;
    type: string;
    source: string;
    payload: Prisma.JsonValue;
    createdAt: Date;
    claimedBySnapshotId: string | null;
};

/**
 * The analysis inbox's sole reader and writer. Producers {@link enqueue} events (in-transaction with their own
 * writes); a run {@link claimPending}s the branch's pending events in the same transaction that opens its
 * snapshot, and reads them back with {@link listForSnapshot}.
 *
 * `analysis_event` has no status column: "is this event handled" is answered by {@link pendingWhere} - the claim
 * FK plus the claiming snapshot's status - and lives only here. No code outside this store touches
 * `claimedBySnapshotId`.
 */
export class AnalysisEventStore {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Insert one event for a branch. Pass `tx` to commit the event with the producer's other writes, so a poke can
     * never race ahead of a not-yet-committed event.
     */
    public async enqueue(input: EnqueueAnalysisEventInput, tx?: Prisma.TransactionClient): Promise<{ id: string }> {
        const body = analysisEventBodySchema.parse(input.event);
        const source = analysisEventSourceSchema.parse(input.source);
        this.logger.info("Enqueuing analysis event", {
            branch: { branchId: input.branchId },
            extra: { type: body.type, source },
        });

        const client = tx ?? this.db;
        const created = await client.analysisEvent.create({
            data: {
                branchId: input.branchId,
                organizationId: input.organizationId,
                type: body.type,
                source,
                payload: body.payload,
            },
            select: { id: true },
        });
        this.logger.info("Analysis event enqueued", {
            branch: { branchId: input.branchId },
            extra: { id: created.id },
        });
        return created;
    }

    /**
     * Whether the branch has any pending event on a still-live PR - the standing-reason-to-run predicate behind
     * the already-analyzed skip. Terminal-PR events are invisible here for the same reason the re-poke skips them:
     * a branch that can never run again must not hold the skip open.
     */
    public async hasPending(branchId: string): Promise<boolean> {
        const row = await this.db.analysisEvent.findFirst({
            where: { AND: [this.pendingWhere(branchId), { branch: this.liveBranchWhere() }] },
            select: { id: true },
        });
        return row != null;
    }

    /**
     * Claim every pending event on the branch for the opening snapshot, in the caller's transaction - the atomic
     * companion to `openSnapshot`, wired through its `onOpened` hook. Returns how many events were claimed.
     *
     * Stealable by construction: the {@link pendingWhere} predicate matches both unclaimed events and events whose
     * previous claimant ended `superseded`/`cancelled`/`failed`, so a superseded run's events flow to its
     * successor and a failed run's events return for the next trigger, with no explicit release step.
     */
    public async claimPending(tx: Prisma.TransactionClient, branchId: string, snapshotId: string): Promise<number> {
        this.logger.info("Claiming pending analysis events", { branch: { branchId }, snapshot: { snapshotId } });
        const { count } = await tx.analysisEvent.updateMany({
            where: this.pendingWhere(branchId),
            data: { claimedBySnapshotId: snapshotId },
        });
        this.logger.info("Pending analysis events claimed", {
            branch: { branchId },
            snapshot: { snapshotId },
            extra: { count },
        });
        return count;
    }

    /** The events a snapshot's run claimed, oldest first - what that run analyzed. Empty for an unknown snapshot. */
    public async listForSnapshot(snapshotId: string): Promise<AnalysisEventRecord[]> {
        this.logger.info("Listing analysis events for snapshot", { snapshot: { snapshotId } });
        const rows = await this.db.analysisEvent.findMany({
            where: { claimedBySnapshotId: snapshotId },
            orderBy: { createdAt: "asc" },
        });
        return rows.map((row) => this.toRecord(row));
    }

    /**
     * The one place "is this event pending" is expressed: unclaimed, or claimed by a same-branch snapshot whose run
     * was thrown away (a reclaimable status). Every read and the claim update share it, so the derived handled-ness
     * can never disagree between them.
     */
    private pendingWhere(branchId: string): Prisma.AnalysisEventWhereInput {
        return { branchId, OR: this.pendingClause() };
    }

    /**
     * Scopes an event query to branches that can still run. Main (no PR row) and open PRs stay; only a closed or
     * merged PR is excluded. The NULL `prState` arm is load-bearing, not decoration: a just-pushed branch has a cold
     * cache, and SQL's NULL-hostile `NOT IN` would silently treat it as dead - it must fail open instead (the run
     * re-checks liveness anyway).
     */
    private liveBranchWhere(): Prisma.BranchWhereInput {
        return {
            OR: [
                { prInfo: { is: null } },
                { prInfo: { prState: null } },
                { prInfo: { prState: { notIn: TERMINAL_PR_STATES } } },
            ],
        };
    }

    /** The pending disjunction on its own - unclaimed, or claimed by a thrown-away run - to compose under any scope. */
    private pendingClause(): Prisma.AnalysisEventWhereInput[] {
        return [
            { claimedBySnapshotId: null },
            { claimedBySnapshot: { is: { status: { in: RECLAIMABLE_CLAIM_STATUSES } } } },
        ];
    }

    private toRecord(row: AnalysisEventRow): AnalysisEventRecord {
        const body = analysisEventBodySchema.parse({ type: row.type, payload: row.payload });
        return {
            ...body,
            id: row.id,
            branchId: row.branchId,
            organizationId: row.organizationId,
            source: analysisEventSourceSchema.parse(row.source),
            createdAt: row.createdAt,
            claimedBySnapshotId: row.claimedBySnapshotId ?? undefined,
        };
    }
}
