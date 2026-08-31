import type { TokenProvider } from "./token-provider";

/** A `TokenProvider` that always presents the same key - the common case for a long-lived service key. */
export class StaticTokenProvider implements TokenProvider {
    constructor(private readonly token: string) {}

    getToken(): string {
        return this.token;
    }
}
