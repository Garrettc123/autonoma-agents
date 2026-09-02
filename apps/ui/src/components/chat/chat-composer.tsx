import { Button, Textarea } from "@autonoma/blacklight";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import { useState } from "react";

/** Chat input: Enter sends, Shift+Enter for a newline. Locked while a turn is in flight. */
export function ChatComposer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (message: string) => Promise<boolean>;
  disabled: boolean;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const canSend = !disabled && trimmed.length > 0;

  // Clear only on success, so a failed send keeps the text for retry.
  async function submit() {
    if (!canSend) return;
    const sent = await onSend(trimmed);
    if (sent) setValue("");
  }

  return (
    <div className="shrink-0 border-t border-border-dim bg-surface-base p-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          className="max-h-40 min-h-10 flex-1 resize-none font-sans text-sm"
          aria-label="Ask Autonoma about this pull request"
        />
        <Button
          size="icon-sm"
          variant="accent"
          disabled={!canSend}
          onClick={() => void submit()}
          aria-label="Send message"
        >
          <PaperPlaneRightIcon size={15} weight="fill" />
        </Button>
      </div>
    </div>
  );
}
