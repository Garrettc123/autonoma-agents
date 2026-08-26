import { Badge, cn, stepInstruction } from "@autonoma/blacklight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { NavigableLightbox, type NavigableStep } from "components/screenshot-lightbox";
import { useState } from "react";
import type { FindingDetailGeneration, FindingDetailStep } from "./finding-drawer-types";

/**
 * The run's steps as a lean list: each step is one row (order / instruction / interaction) with a picture icon
 * that opens the frame spotlight at that step, so the frames never take column space. A failed step keeps its
 * error inline - that text has no home in an image-only spotlight - and a still-running generation shows a
 * spinner row at the end. `framed` draws the card border; drop it when a tab panel already frames the list.
 */
export function FindingStepsList({
  generation,
  framed = true,
}: {
  generation: FindingDetailGeneration;
  framed?: boolean;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number>();
  const lightboxSteps: NavigableStep[] = generation.steps.flatMap((step) => {
    const src = step.screenshotBefore ?? step.screenshotAfter;
    if (src == null) return [];
    return [
      {
        src,
        alt: `Step ${step.order}`,
        points: step.overlayPoints ?? [],
        stepNumber: step.order,
        description: stepInstruction({ interaction: step.interaction, params: step.params }),
      },
    ];
  });
  const lightboxIndexByOrder = new Map(lightboxSteps.map((step, index) => [step.stepNumber, index]));

  if (generation.steps.length === 0) {
    return (
      <p className="rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
        {generation.status === "running" || generation.status === "queued" || generation.status === "pending"
          ? "Waiting for the first step."
          : "No steps were persisted for this run."}
      </p>
    );
  }

  return (
    <>
      <ol
        className={cn(
          "divide-y divide-border-dim",
          framed && "overflow-hidden rounded-lg border border-border-dim bg-surface-base",
        )}
      >
        {generation.steps.map((step) => (
          <StepRow
            key={step.order}
            step={step}
            onOpenFrame={
              lightboxIndexByOrder.has(step.order)
                ? () => setLightboxIndex(lightboxIndexByOrder.get(step.order))
                : undefined
            }
          />
        ))}
        {generation.status === "running" && (
          <li className="flex items-center gap-2 px-3 py-3 text-xs text-status-warn">
            <CircleNotchIcon size={13} className="animate-spin" /> Running - deciding the next step
          </li>
        )}
      </ol>
      <NavigableLightbox
        steps={lightboxSteps}
        activeIndex={lightboxIndex}
        onClose={() => setLightboxIndex(undefined)}
        onNavigate={setLightboxIndex}
      />
    </>
  );
}

function StepRow({ step, onOpenFrame }: { step: FindingDetailStep; onOpenFrame?: () => void }) {
  const failed = step.status === "failed";
  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {failed ? (
          <XCircleIcon size={15} className="shrink-0 text-status-critical" />
        ) : (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border-mid font-mono text-4xs text-text-secondary">
            {step.order}
          </span>
        )}
        <span className={cn("min-w-0 flex-1 truncate text-sm", failed ? "text-status-critical" : "text-text-primary")}>
          {stepInstruction({ interaction: step.interaction, params: step.params })}
        </span>
        <Badge variant="ghost" className="shrink-0 font-mono text-4xs uppercase">
          {step.interaction}
        </Badge>
        {onOpenFrame != null && (
          <button
            type="button"
            onClick={onOpenFrame}
            aria-label={`Open frame for step ${step.order}`}
            className="shrink-0 text-text-secondary transition-colors hover:text-text-primary"
          >
            <ImageIcon size={15} />
          </button>
        )}
      </div>
      {failed && step.error != null && (
        <p className="mx-3 mb-2.5 rounded-md border border-status-critical/30 bg-status-critical/5 px-2 py-1 text-xs text-status-critical">
          {step.errorName != null ? `${step.errorName}: ` : ""}
          {step.error}
        </p>
      )}
    </li>
  );
}
