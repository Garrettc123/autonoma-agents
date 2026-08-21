import { type GitHubApp, OctokitGitHubApp } from "@autonoma/github";
import { env } from "./env";

declare global {
    // eslint-disable-next-line no-var
    var __generalGitHubApp: GitHubApp | undefined;
}

/**
 * The worker's GitHub App client, built from its env credentials. Reads a `globalThis` override first so integration
 * tests can substitute a `FakeGitHubApp` without a network - the same seam `@autonoma/db` uses for `globalThis.prisma`.
 */
export function getGitHubApp(): GitHubApp {
    globalThis.__generalGitHubApp ??= new OctokitGitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });
    return globalThis.__generalGitHubApp;
}
