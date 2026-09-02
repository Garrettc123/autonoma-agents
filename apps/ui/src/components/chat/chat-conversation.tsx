import { Skeleton } from "@autonoma/blacklight";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { isChatTurnLive, useChatSession, useChatTurn, useSendChatTurn } from "lib/query/chat.queries";
import { useEffect, useRef } from "react";
import { ChatComposer } from "./chat-composer";
import { ChatEmptyState } from "./chat-empty-state";
import { ChatTurnView } from "./chat-turn";

// How close to the bottom counts as "pinned"; only then does new content autoscroll.
const AUTOSCROLL_THRESHOLD_PX = 80;

/**
 * The conversation body: the turn list (read straight from the session cache), plus the composer - locked while
 * the latest turn is in flight, swapped for a read-only note once the session is closed.
 */
export function ChatConversation({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  const { data: session } = useChatSession(applicationId, prNumber);
  const sendTurn = useSendChatTurn(applicationId, prNumber);

  // Latest turn drives the composer lock; shares the last bubble's poll query (same key dedupes).
  const lastSeed = session.turns.at(-1);
  const lastTurn = useChatTurn(session.id, lastSeed?.id, lastSeed);
  const waiting = sendTurn.isPending || isChatTurnLive(lastTurn.data);
  const isClosed = session.status === "closed";

  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new content only while parked at the bottom; starts pinned, unpins on scroll-up.
  const pinnedToBottomRef = useRef(true);
  const scrollSignature = `${session.turns.length}:${lastTurn.data?.status}:${lastTurn.data?.forwardOffer?.status}:${lastTurn.data?.forwardOffer?.receipt?.state}`;
  useEffect(() => {
    const element = scrollRef.current;
    if (element != null && pinnedToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [scrollSignature]);

  function handleScroll() {
    const element = scrollRef.current;
    if (element == null) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom <= AUTOSCROLL_THRESHOLD_PX;
  }

  function handleSend(message: string): Promise<boolean> {
    // Resolve, never reject, so the composer needs no catch; useAPIMutation shows the error toast.
    return new Promise((resolve) => {
      sendTurn.mutate(
        { sessionId: session.id, message },
        { onSuccess: () => resolve(true), onError: () => resolve(false) },
      );
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {session.turns.length === 0 ? (
          <ChatEmptyState onPick={handleSend} />
        ) : (
          session.turns.map((turn) => <ChatTurnView key={turn.id} sessionId={session.id} seed={turn} />)
        )}
      </div>
      {isClosed ? (
        <ClosedNote />
      ) : (
        <ChatComposer
          onSend={handleSend}
          disabled={waiting}
          placeholder={waiting ? "Autonoma is thinking..." : "Ask about this PR's tests..."}
        />
      )}
    </div>
  );
}

function ClosedNote() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border-dim bg-surface-base px-4 py-3 text-2xs text-text-secondary">
      <LockSimpleIcon size={13} />
      This conversation is closed - the PR's run has settled.
    </div>
  );
}

export function ChatConversationSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <Skeleton className="h-10 w-2/3 self-end" />
      <Skeleton className="h-24 w-11/12" />
      <Skeleton className="h-10 w-1/2 self-end" />
      <Skeleton className="h-16 w-10/12" />
    </div>
  );
}
