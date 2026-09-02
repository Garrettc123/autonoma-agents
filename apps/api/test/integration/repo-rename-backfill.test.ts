import { randomBytes } from "node:crypto";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { RepoRenameService } from "../../src/github/repo-rename.service";
import { OnboardingTestHarness } from "../onboarding/onboarding-harness";

const OLD_NAME = "acme/old-web";
const NEW_NAME = "acme/new-web";
const PR_NUMBER = 42;

/** The `repository.renamed` payload GitHub delivers, narrowed to what the service reads. */
function renamedPayload(from: string, to: string, githubId = 555): Record<string, unknown> {
    const [owner, name] = to.split("/");
    return {
        repository: { id: githubId, full_name: to, owner: { login: owner } },
        changes: { repository: { name: { from: from.split("/")[1] } } },
        // Present on the real payload and ignored by the service; included so the fixture stays honest.
        action: "renamed",
        installation: { id: 999 },
        name,
    };
}

integrationTestSuite({
    name: "RepoRenameService",
    createHarness: () => OnboardingTestHarness.create(),
    cases: (test) => {
        test("moves every denormalized repo name from the old full name to the new one", async ({ harness }) => {
            const suffix = randomBytes(4).toString("hex");
            const org = await harness.db.organization.create({
                data: { name: `Rename Org ${suffix}`, slug: `rename-org-${suffix}` },
            });

            await harness.db.gitHubPrComment.create({
                data: { repoFullName: OLD_NAME, prNumber: PR_NUMBER, kind: "pr", commentId: "c1" },
            });
            await harness.db.gitHubCheckRun.create({
                data: { repoFullName: OLD_NAME, prNumber: PR_NUMBER, headSha: "abc123", checkRunId: "77" },
            });
            await harness.db.branchContributor.create({
                data: {
                    organizationId: org.id,
                    repoFullName: OLD_NAME,
                    prNumber: PR_NUMBER,
                    contributorKey: "octocat",
                    login: "octocat",
                },
            });
            await harness.db.skipRecord.create({
                data: {
                    organizationId: org.id,
                    repoFullName: OLD_NAME,
                    prNumber: PR_NUMBER,
                    headSha: "abc123",
                    actorLogin: "octocat",
                    openBugCount: 0,
                    openFindingIds: [],
                },
            });
            await harness.db.bugFixOutcome.create({
                data: {
                    organizationId: org.id,
                    repoFullName: OLD_NAME,
                    prNumber: PR_NUMBER,
                    branchId: `branch-${suffix}`,
                    outcome: "fixed_before_merge",
                },
            });
            await harness.db.findingFalsePositiveCandidate.create({
                data: {
                    organizationId: org.id,
                    repoFullName: OLD_NAME,
                    prNumber: PR_NUMBER,
                    snapshotId: `snapshot-${suffix}`,
                    findingKey: "finding-1",
                    source: "skip_reason",
                    reportedBy: "octocat",
                },
            });
            await harness.db.previewkitBuildCircuit.create({
                data: { organizationId: org.id, repoFullName: OLD_NAME, appName: "web", consecutiveFailures: 3 },
            });
            await harness.db.previewkitEnvironment.create({
                data: {
                    organizationId: org.id,
                    namespace: `acme-old-web-${PR_NUMBER}-${suffix}`,
                    repoFullName: OLD_NAME,
                    prNumber: PR_NUMBER,
                    headSha: "abc123",
                    headRef: "feature",
                },
            });

            const service = new RepoRenameService(harness.db);
            await service.backfillFromWebhook(org.id, renamedPayload(OLD_NAME, NEW_NAME));

            // The PR-comment row is the one that caused a visible duplicate comment when it went stale,
            // so assert on identity rather than just a count.
            const comment = await harness.db.gitHubPrComment.findUnique({
                where: { repoFullName_prNumber_kind: { repoFullName: NEW_NAME, prNumber: PR_NUMBER, kind: "pr" } },
            });
            expect(comment?.commentId).toBe("c1");

            const circuit = await harness.db.previewkitBuildCircuit.findUnique({
                where: {
                    organizationId_repoFullName_appName: {
                        organizationId: org.id,
                        repoFullName: NEW_NAME,
                        appName: "web",
                    },
                },
            });
            expect(circuit?.consecutiveFailures).toBe(3);

            expect(await harness.db.gitHubCheckRun.count({ where: { repoFullName: NEW_NAME } })).toBe(1);
            expect(await harness.db.branchContributor.count({ where: { repoFullName: NEW_NAME } })).toBe(1);
            expect(await harness.db.skipRecord.count({ where: { repoFullName: NEW_NAME } })).toBe(1);
            expect(await harness.db.bugFixOutcome.count({ where: { repoFullName: NEW_NAME } })).toBe(1);
            expect(await harness.db.findingFalsePositiveCandidate.count({ where: { repoFullName: NEW_NAME } })).toBe(1);
            expect(await harness.db.previewkitEnvironment.count({ where: { repoFullName: NEW_NAME } })).toBe(1);

            // Nothing may be left behind under the dead name.
            expect(await harness.db.gitHubPrComment.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
            expect(await harness.db.gitHubCheckRun.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
            expect(await harness.db.branchContributor.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
            expect(await harness.db.skipRecord.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
            expect(await harness.db.bugFixOutcome.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
            expect(await harness.db.findingFalsePositiveCandidate.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
            expect(await harness.db.previewkitBuildCircuit.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
            expect(await harness.db.previewkitEnvironment.count({ where: { repoFullName: OLD_NAME } })).toBe(0);
        });

        test("leaves another repository's rows alone", async ({ harness }) => {
            const suffix = randomBytes(4).toString("hex");
            const bystander = `acme/untouched-${suffix}`;
            await harness.db.gitHubCheckRun.create({
                data: { repoFullName: bystander, prNumber: 1, headSha: `sha-${suffix}`, checkRunId: "1" },
            });

            const service = new RepoRenameService(harness.db);
            await service.backfillFromWebhook("org-irrelevant", renamedPayload("acme/some-old", "acme/some-new"));

            expect(await harness.db.gitHubCheckRun.count({ where: { repoFullName: bystander } })).toBe(1);
        });

        test("ignores a payload that is not a rename instead of throwing", async ({ harness }) => {
            const service = new RepoRenameService(harness.db);

            // A `repository` event with no `changes` block (e.g. `edited`) must be a no-op, not a crash:
            // the webhook dispatcher treats a throw as a failed delivery.
            await expect(
                service.backfillFromWebhook("org-irrelevant", { repository: { id: 1 } }),
            ).resolves.toBeUndefined();
        });

        test("renames the canonical repository row in place, keeping its id", async ({ harness }) => {
            const suffix = randomBytes(4).toString("hex");
            const from = `acme/canon-old-${suffix}`;
            const to = `acme/canon-new-${suffix}`;
            const githubId = 700000 + Math.floor(parseInt(suffix, 16) % 90000);

            const before = await harness.db.gitHubRepository.create({ data: { fullName: from } });

            const service = new RepoRenameService(harness.db);
            await service.backfillFromWebhook("org-irrelevant", renamedPayload(from, to, githubId));

            // The id must survive: the tables carrying repoFullName are migrating onto it, so replacing
            // the row instead of renaming it would orphan every future foreign key.
            const after = await harness.db.gitHubRepository.findUnique({ where: { fullName: to } });
            expect(after?.id).toBe(before.id);
            expect(after?.githubId).toBe(githubId);
            expect(await harness.db.gitHubRepository.count({ where: { fullName: from } })).toBe(0);
        });

        test("creates the canonical row when the repository is unknown", async ({ harness }) => {
            const suffix = randomBytes(4).toString("hex");
            const to = `acme/brand-new-${suffix}`;
            const githubId = 800000 + Math.floor(parseInt(suffix, 16) % 90000);

            const service = new RepoRenameService(harness.db);
            await service.backfillFromWebhook(
                "org-irrelevant",
                renamedPayload(`acme/never-seen-${suffix}`, to, githubId),
            );

            const row = await harness.db.gitHubRepository.findUnique({ where: { fullName: to } });
            expect(row?.githubId).toBe(githubId);
        });

        test("is idempotent when GitHub redelivers the same rename", async ({ harness }) => {
            const suffix = randomBytes(4).toString("hex");
            const from = `acme/redeliver-old-${suffix}`;
            const to = `acme/redeliver-new-${suffix}`;
            const githubId = 900000 + Math.floor(parseInt(suffix, 16) % 90000);

            const service = new RepoRenameService(harness.db);
            const payload = renamedPayload(from, to, githubId);

            await service.backfillFromWebhook("org-irrelevant", payload);
            const first = await harness.db.gitHubRepository.findUnique({ where: { fullName: to } });

            // A redelivery finds nothing under the old name, so it has to resolve the row by numeric id
            // instead - otherwise it would create a second row for the same repository.
            await service.backfillFromWebhook("org-irrelevant", payload);

            expect(await harness.db.gitHubRepository.count({ where: { githubId } })).toBe(1);
            const second = await harness.db.gitHubRepository.findUnique({ where: { fullName: to } });
            expect(second?.id).toBe(first?.id);
        });
    },
});
