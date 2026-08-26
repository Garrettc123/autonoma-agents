/** Where fixture repo ids start. High enough to never look like a hand-written id in a failing assertion. */
const FIRST_REPO_ID = 500_000;

let lastRepoId = FIRST_REPO_ID - 1;

/**
 * A GitHub repository id no other fixture in this test run holds.
 *
 * Every suite forks its own database and its own single organization, so a counter is unique by
 * construction - while a random draw collides on Application's
 * (organizationId, githubRepositoryId) unique index often enough to flake CI.
 */
export function nextRepoId(): number {
    lastRepoId += 1;
    return lastRepoId;
}
