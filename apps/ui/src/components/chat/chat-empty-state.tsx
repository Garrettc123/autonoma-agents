import { SparkleIcon } from "@phosphor-icons/react/Sparkle";

// The three things the chat is for: a failure, coverage, and disputing a finding.
const SUGGESTIONS = [
  "Why is this PR failing?",
  "What did you test on this PR?",
  "I think the Place order finding is a false positive.",
];

export function ChatEmptyState({ onPick }: { onPick: (message: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <SparkleIcon size={22} weight="fill" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-text-primary">Ask Autonoma about this PR</p>
        <p className="text-2xs leading-relaxed text-text-secondary">
          Grounded in this pull request's analysis and code. Ask why a check failed, what was covered, or push back on a
          finding.
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="w-full rounded-md border border-border-dim bg-surface-base px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:border-border-mid hover:text-text-primary"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
