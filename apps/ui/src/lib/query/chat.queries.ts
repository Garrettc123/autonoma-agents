import type { ChatTurn } from "@autonoma/types";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

const TURN_POLL_MS = 2500;
// Placeholder id for the empty-conversation case; the query stays disabled and never fires.
const NO_TURN = "__none__";

/** A turn polls while thinking, or while a confirmed forward has no receipt yet. */
export function isChatTurnLive(turn: ChatTurn | undefined): boolean {
    if (turn == null) return false;
    if (turn.status === "thinking") return true;
    const offer = turn.forwardOffer;
    return offer != null && offer.status === "confirmed" && offer.receipt == null;
}

/** Get-or-create the PR conversation and hydrate its history. */
export function useChatSession(applicationId: string, prNumber: number) {
    return useSuspenseQuery(trpc.chat.openSession.queryOptions({ applicationId, prNumber }));
}

/** One turn's live state, seeded from the session so settled turns never poll. Same key dedupes the parent's read. */
export function useChatTurn(sessionId: string, turnId: string | undefined, seed?: ChatTurn) {
    return useQuery({
        ...trpc.chat.pollTurn.queryOptions({ sessionId, turnId: turnId ?? NO_TURN }),
        enabled: turnId != null,
        initialData: seed,
        staleTime: Infinity,
        refetchInterval: (query) => (isChatTurnLive(query.state.data) ? TURN_POLL_MS : false),
        refetchIntervalInBackground: true,
    });
}

export function useSendChatTurn(applicationId: string, prNumber: number) {
    const queryClient = useQueryClient();
    return useAPIMutation(
        trpc.chat.sendTurn.mutationOptions({
            // Append to the session cache (single source of truth); the turn's own poll then drives it to complete.
            onSuccess: (turn) => {
                queryClient.setQueryData(trpc.chat.openSession.queryKey({ applicationId, prNumber }), (prev) =>
                    prev == null ? prev : { ...prev, turns: [...prev.turns, turn] },
                );
            },
        }),
    );
}

export function useResolveChatForward(sessionId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation(
        trpc.chat.resolveForward.mutationOptions({
            // onSuccess (onSettled's data is undefined on failure): flip the offer now; a confirmed one polls on for its receipt.
            onSuccess: (turn) => {
                queryClient.setQueryData(trpc.chat.pollTurn.queryKey({ sessionId, turnId: turn.id }), turn);
            },
        }),
    );
}
