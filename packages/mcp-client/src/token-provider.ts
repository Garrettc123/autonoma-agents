/**
 * Supplies the bearer credential, read fresh per request. Injected so the caller picks the identity
 * (per-org service key vs. rotating acting-user token), and a refreshing token works without reconnecting.
 */
export interface TokenProvider {
    getToken(): string | Promise<string>;
}
