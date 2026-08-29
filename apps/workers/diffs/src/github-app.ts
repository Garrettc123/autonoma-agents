import { type GitHubApp, OctokitGitHubApp } from "@autonoma/github";
import { ensurePem } from "@autonoma/github/schemas";
import { env } from "./env";

let app: GitHubApp | undefined;

/**
 * The worker's GitHub App client, built once from its env credentials. A single instance is load-bearing:
 * `@octokit/app` caches installation tokens per App instance, so constructing a fresh app per call re-mints
 * a token on every GitHub operation.
 */
export function getGitHubApp(): GitHubApp {
    app ??= new OctokitGitHubApp({
        appId: env.GITHUB_APP_ID,
        // Evals run under TESTING=true, which makes createEnv skip the base64PrivateKey transform, so the
        // key may still be base64 here; ensurePem is a no-op on an already-decoded key.
        privateKey: ensurePem(env.GITHUB_APP_PRIVATE_KEY),
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });
    return app;
}
