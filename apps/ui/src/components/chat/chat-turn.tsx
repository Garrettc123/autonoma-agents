import type { ChatToolActivity, ChatTurn } from "@autonoma/types";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import { useChatTurn } from "lib/query/chat.queries";
import { ChatForwardCard } from "./chat-forward-card";

/** One exchange: prompt bubble + agent reply, kept live by its own poll. */
export function ChatTurnView({ sessionId, seed }: { sessionId: string; seed: ChatTurn }) {
  const { data } = useChatTurn(sessionId, seed.id, seed);
  const turn = data ?? seed;

  return (
    <div className="flex flex-col gap-2">
      <UserBubble text={turn.prompt} />
      <AgentTurn sessionId={sessionId} turn={turn} />
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-md rounded-br-sm bg-primary/15 px-3 py-2 text-sm text-text-primary">
        {text}
      </div>
    </div>
  );
}

function AgentTurn({ sessionId, turn }: { sessionId: string; turn: ChatTurn }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="max-w-[92%] rounded-md rounded-bl-sm border border-border-dim bg-surface-base px-3 py-2.5">
        {turn.status === "thinking" ? (
          <AgentThinking activity={turn.activity} />
        ) : turn.status === "failed" ? (
          <AgentError message={turn.error} />
        ) : (
          <ReasoningMarkdown content={turn.answer ?? ""} />
        )}
      </div>
      {turn.status === "complete" && turn.forwardOffer != null && (
        <div className="max-w-[92%]">
          <ChatForwardCard sessionId={sessionId} turnId={turn.id} offer={turn.forwardOffer} />
        </div>
      )}
    </div>
  );
}

function AgentThinking({ activity }: { activity: ChatToolActivity[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-text-secondary">
        <ThinkingDots />
        <span className="text-2xs">Thinking...</span>
      </div>
      {activity.length > 0 && (
        <ul className="flex flex-col gap-1">
          {activity.map((item) => (
            <li key={item.id} className="flex items-center gap-1.5 font-mono text-3xs text-text-secondary">
              <span className="size-1 rounded-full bg-text-secondary" />
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="flex items-center gap-0.5">
      <span className="size-1.5 animate-pulse rounded-full bg-text-secondary" />
      <span className="size-1.5 animate-pulse rounded-full bg-text-secondary [animation-delay:150ms]" />
      <span className="size-1.5 animate-pulse rounded-full bg-text-secondary [animation-delay:300ms]" />
    </span>
  );
}

function AgentError({ message }: { message: string | undefined }) {
  return (
    <div className="flex items-start gap-2 text-status-critical">
      <WarningCircleIcon size={15} className="mt-0.5 shrink-0" />
      <span className="text-xs">{message ?? "Something went wrong producing this answer. Try asking again."}</span>
    </div>
  );
}
