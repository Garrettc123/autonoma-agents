/**
 * Whether a caught error is "the file isn't there" rather than a real failure.
 *
 * The distinction matters wherever an absent file is an expected state - a
 * first-run config, a marker a background agent has not written yet. Logging
 * that absence is worse than not logging it: it costs a record (with a stack
 * describing `fs/promises` internals) per attempt, and it makes the errors that
 * DO need attention - EACCES, ENOTDIR, ENOSPC - indistinguishable from the
 * normal case. Gate the breadcrumb on this and the log regains its signal.
 */
export function isMissingFile(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "ENOENT";
}
