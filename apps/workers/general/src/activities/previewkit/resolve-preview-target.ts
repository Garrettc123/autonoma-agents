import { db } from "@autonoma/db";
import type { GitHubInstallationClient } from "@autonoma/github";
import { hasGoneLive } from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import { autonomaHostsPreviews } from "@autonoma/scenario";
import type { ResolvePreviewTargetInput, ResolvePreviewTargetOutput } from "@autonoma/workflow/activities";
import { getGitHubApp } from "../../github-app";

const logger = rootLogger.child({ name: "resolvePreviewTarget" });

/** PR numbers start at 1, so 0 is the main branch's stable non-PR environment. */
const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

/**
 * Who owns a branch's preview is a fact about the APPLICATION, not about whichever trigger started the run - which
 * is what lets a push, a `/start analysis` comment and a label all be the same call.
 */
export async function resolvePreviewTarget(input: ResolvePreviewTargetInput): Promise<ResolvePreviewTargetOutput> {
    const { branchId } = input;
    logger.info("Resolving whether this run owns a preview", { branch: { branchId } });

    const branch = await db.branch.findUnique({
        where: { id: branchId },
        select: {
            name: true,
            deploymentId: true,
            deployment: { select: { headSha: true } },
            prInfo: { select: { prNumber: true } },
            application: {
                select: {
                    organizationId: true,
                    githubRepositoryId: true,
                    previewDeployRef: true,
                    onboardingState: { select: { previewEnvironmentMode: true, step: true } },
                },
            },
        },
    });

    const application = branch?.application;
    if (branch == null || application == null) {
        logger.info("No application for this branch; the run owns no preview", { branch: { branchId } });
        return { hasRecordedPreview: false };
    }

    const hasRecordedPreview = branch.deploymentId != null;
    const organizationId = application.organizationId;
    // Read once here rather than in the workflow: this query already joins the onboarding row, so
    // asking for the step costs nothing, and a second activity to fetch it would be a round trip
    // for a column we already had in hand.
    const onboardingComplete = hasGoneLive(application.onboardingState?.step);
    if (!autonomaHostsPreviews(application.onboardingState?.previewEnvironmentMode)) {
        // The head to analyze is the one the customer actually deployed - only their deployment record knows it,
        // so it is the coordinate here, not the live GitHub head (which their preview may not yet be running).
        logger.info("The customer deploys this preview; the run is analysis only", {
            branch: { branchId },
            extra: { mode: application.onboardingState?.previewEnvironmentMode, hasRecordedPreview },
        });
        return {
            organizationId,
            hasRecordedPreview,
            onboardingComplete,
            headSha: branch.deployment?.headSha ?? undefined,
        };
    }
    if (application.githubRepositoryId == null) {
        logger.warn("Application is previewkit-managed but linked to no repository; cannot build a preview", {
            branch: { branchId },
        });
        return { organizationId, hasRecordedPreview, onboardingComplete };
    }

    const client = await getInstallationClient(organizationId);
    if (client == null) return { organizationId, hasRecordedPreview, onboardingComplete };

    const repoFullName = await resolveRepoFullName(client, organizationId, application.githubRepositoryId);
    if (repoFullName == null) return { organizationId, hasRecordedPreview, onboardingComplete };

    const prNumber = branch.prInfo?.prNumber ?? MAIN_BRANCH_ENVIRONMENT_NUMBER;
    // The base environment follows the app's pinned deploy ref, which is deliberately NOT the
    // Branch record: that record is the app's trunk identity and drives suite lineage and every
    // "main" label in the product, so pointing it at an integration branch would redefine what
    // main means (see setDeployBranch). Taking the ref from the record instead handed the builder
    // the trunk's NAME with the integration branch's SHA - a mismatched pair, and the wrong branch
    // for the deploy that was asked for. A PR environment has its own head and never consults this.
    const headRef =
        prNumber === MAIN_BRANCH_ENVIRONMENT_NUMBER ? (application.previewDeployRef ?? branch.name) : branch.name;
    // Resolved live so a deferred, days-later run builds the branch's CURRENT head, not the stale sha its
    // trigger carried. The build, the Job spec and the tarball fetch are all pinned to this one sha end to end.
    const headSha = await resolveLiveHead(client, application.githubRepositoryId, prNumber, headRef);

    logger.info("This run owns a previewkit preview", {
        organization: { organizationId },
        branch: { branchId },
        preview: { repo: repoFullName, headRef },
        extra: { pr: prNumber, headSha },
    });

    return {
        organizationId,
        hasRecordedPreview,
        onboardingComplete,
        headSha,
        target: {
            repoFullName,
            prNumber,
            organizationId,
            githubRepositoryId: application.githubRepositoryId,
            headSha,
            headRef,
            branchId,
        },
    };
}

/** The installation's GitHub client, or undefined when the org has no installation to authenticate as. */
async function getInstallationClient(organizationId: string): Promise<GitHubInstallationClient | undefined> {
    const installation = await db.gitHubInstallation.findUnique({
        where: { organizationId },
        select: { installationId: true },
    });
    if (installation == null) {
        logger.warn("Organization has no GitHub installation; cannot resolve the head or repository", {
            organization: { organizationId },
        });
        return undefined;
    }

    return getGitHubApp().getInstallationClient(installation.installationId);
}

/**
 * Resolved from GitHub rather than stored: `githubRepositoryId` is the stable identity and a repo can be renamed,
 * so a persisted name would go quietly stale. The previewkit environment cache answers without a call when it can.
 */
async function resolveRepoFullName(
    client: GitHubInstallationClient,
    organizationId: string,
    githubRepositoryId: number,
): Promise<string | undefined> {
    const known = await db.previewkitEnvironment.findFirst({
        where: { organizationId, githubRepositoryId },
        select: { repoFullName: true },
        orderBy: { createdAt: "desc" },
    });
    if (known != null) return known.repoFullName;

    const repo = await client.getRepository(githubRepositoryId);
    return repo.fullName;
}

/** The branch's current head: the PR's live head for a PR environment, the deploy ref's head for main. */
async function resolveLiveHead(
    client: GitHubInstallationClient,
    githubRepositoryId: number,
    prNumber: number,
    headRef: string,
): Promise<string> {
    if (prNumber === MAIN_BRANCH_ENVIRONMENT_NUMBER) return client.getBranchHead(githubRepositoryId, headRef);
    const pullRequest = await client.getPullRequest(githubRepositoryId, prNumber);
    return pullRequest.headSha;
}
