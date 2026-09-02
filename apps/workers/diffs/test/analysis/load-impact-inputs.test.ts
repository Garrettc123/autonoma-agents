import type { MergeContextInfo } from "@autonoma/diffs";
import { TestSuiteStore } from "@autonoma/test-suite";
import { expect } from "vitest";
import { loadImpactInputs } from "../../src/analysis/load-impact-inputs";
import { EMPTY_MERGE_FLOW_RESULT, type MergeFlowResult } from "../../src/analysis/merge-flow";
import { diffJobContextSuite } from "../harness";

let seq = 0;
const uniq = () => `${(seq += 1)}-${Math.floor(performance.now())}`;

diffJobContextSuite({
    name: "loadImpactInputs",
    cases: (test) => {
        test("assembles the agent input from the snapshot's suite and flows", async ({ harness, seedResult }) => {
            const { db } = harness;
            const { organizationId, applicationId } = seedResult;
            const store = new TestSuiteStore(db);
            const suffix = uniq();

            const branch = await db.branch.create({
                data: { name: `branch-${suffix}`, organizationId, applicationId },
            });
            const folder = await db.folder.create({
                data: { name: `Checkout ${suffix}`, applicationId, organizationId },
            });
            const snapshot = await store.openSnapshot({
                branchId: branch.id,
                headSha: `head-${suffix}`,
                source: { noPriorSnapshot: { baseSha: `base-${suffix}` } },
                trigger: "WEBHOOK",
            });
            const login = await snapshot.addTest({
                folderId: folder.id,
                name: "Login",
                description: "Log in",
                plan: "Open login",
            });
            const checkout = await snapshot.addTest({
                folderId: folder.id,
                name: "Checkout",
                description: "Buy",
                plan: "Open checkout",
            });
            const suite = await snapshot.read();

            const inputs = await loadImpactInputs({
                snapshotId: snapshot.snapshotId,
                suite,
                merge: EMPTY_MERGE_FLOW_RESULT,
                events: [],
                client: db,
            });

            expect(inputs.headSha).toBe(`head-${suffix}`);
            expect(inputs.baseSha).toBe(`base-${suffix}`);
            expect(new Set(inputs.existingTests.map((t) => t.slug))).toEqual(new Set([login.slug, checkout.slug]));
            expect(inputs.flowIndex.getFlow(folder.name)?.id).toBe(folder.id);
            expect(inputs.branchHistory?.openIssues).toEqual([]);
            expect(inputs.branchHistory?.priorReports).toEqual([]);
            expect(inputs.merges).toEqual([]);
        });

        test("withholds a merge-imported test from the agent's list and carries the merge context", async ({
            harness,
            seedResult,
        }) => {
            const { db } = harness;
            const { organizationId, applicationId } = seedResult;
            const store = new TestSuiteStore(db);
            const suffix = uniq();

            const branch = await db.branch.create({
                data: { name: `branch-${suffix}`, organizationId, applicationId },
            });
            const folder = await db.folder.create({
                data: { name: `Flow ${suffix}`, applicationId, organizationId },
            });
            const snapshot = await store.openSnapshot({
                branchId: branch.id,
                headSha: `head-${suffix}`,
                source: { noPriorSnapshot: { baseSha: `base-${suffix}` } },
                trigger: "WEBHOOK",
            });
            const imported = await snapshot.addTest({
                folderId: folder.id,
                name: "Imported",
                description: "x",
                plan: "p",
            });
            const kept = await snapshot.addTest({ folderId: folder.id, name: "Kept", description: "y", plan: "q" });
            const suite = await snapshot.read();

            const merges: MergeContextInfo[] = [
                { prNumber: 42, sourceBranchName: "feat/x", sourceSnapshotId: "snap-x", mergeCommitSha: "merge-sha" },
            ];
            const merge: MergeFlowResult = {
                merges,
                preClassifiedConflicts: [],
                imports: [{ slug: imported.slug, testCaseId: imported.testCaseId, reason: "imported from PR" }],
                removedSlugs: [],
            };

            const inputs = await loadImpactInputs({
                snapshotId: snapshot.snapshotId,
                suite,
                merge,
                events: [],
                client: db,
            });

            const slugs = inputs.existingTests.map((t) => t.slug);
            expect(slugs).toContain(kept.slug);
            expect(slugs).not.toContain(imported.slug);
            expect(inputs.merges).toEqual(merges);
        });
    },
});
