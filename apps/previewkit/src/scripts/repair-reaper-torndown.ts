import { db, PreviewkitStatus } from "@autonoma/db";
import { makeKubeConfig } from "@autonoma/k8s";
import { ClusterPreviewNamespaces } from "@autonoma/k8s/preview-reaper";

/**
 * Restores environment rows the reaper wrongly marked torn down.
 *
 * The reaper compared every live row against a namespace listing that only matched the
 * RETIRED `preview-*` name format, so every environment on the current
 * `{owner}-{repo}-{N}-{hash}` format missed the lookup, fell into the "namespace is gone"
 * branch, and was stamped `torn_down` while its namespace was alive and serving. The
 * selector is fixed, but the rows it already wrote are still wrong - and they are what
 * the dashboard, the readiness waits and the usage meter read, so a live preview reads as
 * dead and its running compute is never metered.
 *
 * `markTornDown` overwrote status/phase without keeping the old value, so the row cannot
 * recover on its own. The cluster can: the deployer mirrors its last status and phase onto
 * the namespace (`previewkit.dev/status` / `previewkit.dev/phase`), so a namespace that
 * still exists carries the state its row should have had.
 *
 * Only touches rows whose namespace is STILL PRESENT. A row whose namespace is genuinely
 * gone was marked correctly, whatever the reason, and is left exactly as it is.
 *
 * Dry-run by default; pass `--apply` to write. Needs kubectl pointed at the PREVIEW
 * cluster and DATABASE_URL pointed at that environment's database.
 */

/** The value the reaper wrote, and therefore the only status worth reconsidering. */
const WRONGLY_WRITTEN_STATUS = PreviewkitStatus.torn_down;

interface RepairCounts {
    candidates: number;
    repaired: number;
    skippedNoAnnotation: number;
    skippedUnknownStatus: number;
    skippedStillTornDown: number;
}

function isPreviewkitStatus(value: string): value is PreviewkitStatus {
    return Object.values(PreviewkitStatus).some((status) => status === value);
}

async function main(): Promise<RepairCounts> {
    const apply = process.argv.includes("--apply");
    const namespaces = await new ClusterPreviewNamespaces(makeKubeConfig()).list();
    const byName = new Map(namespaces.map((namespace) => [namespace.name, namespace]));

    // Every torn-down row, then narrowed to those whose namespace is still up. Filtering in
    // memory rather than in SQL because the cluster is the authority on which of them exist.
    const tornDown = await db.previewkitEnvironment.findMany({
        where: { tornDownAt: { not: null }, status: WRONGLY_WRITTEN_STATUS },
        select: { id: true, namespace: true, prNumber: true, repoFullName: true },
    });

    const counts: RepairCounts = {
        candidates: 0,
        repaired: 0,
        skippedNoAnnotation: 0,
        skippedUnknownStatus: 0,
        skippedStillTornDown: 0,
    };

    for (const environment of tornDown) {
        const namespace = byName.get(environment.namespace);
        if (namespace == null) continue;
        counts.candidates += 1;

        const status = namespace.status;
        if (status == null) {
            // Deployed before the deployer mirrored its status. Nothing to restore it from,
            // and guessing `ready` for a preview that may genuinely have failed would be
            // worse than leaving an operator to look at it.
            counts.skippedNoAnnotation += 1;
            console.warn(`skip ${environment.namespace}: namespace carries no status annotation`);
            continue;
        }
        if (!isPreviewkitStatus(status)) {
            counts.skippedUnknownStatus += 1;
            console.warn(`skip ${environment.namespace}: unrecognised status annotation "${status}"`);
            continue;
        }
        if (status === PreviewkitStatus.torn_down) {
            // The namespace agrees the environment is down (a teardown that deleted the row's
            // namespace is still in progress). The row was right.
            counts.skippedStillTornDown += 1;
            continue;
        }

        console.log(
            `${apply ? "repair" : "would repair"} ${environment.repoFullName}#${environment.prNumber} ` +
                `(${environment.namespace}): torn_down -> ${status}`,
        );
        counts.repaired += 1;
        if (!apply) continue;

        await db.previewkitEnvironment.update({
            where: { id: environment.id },
            data: { status, phase: namespace.phase ?? status, tornDownAt: null },
        });
    }

    return counts;
}

main()
    .then((counts) => {
        const mode = process.argv.includes("--apply") ? "applied" : "dry run";
        console.log(`\nReaper repair complete (${mode}): ${JSON.stringify(counts)}`);
        if (!process.argv.includes("--apply")) console.log("Re-run with --apply to write these changes.");
    })
    .catch((err) => {
        console.error("Reaper repair failed", err);
        process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
