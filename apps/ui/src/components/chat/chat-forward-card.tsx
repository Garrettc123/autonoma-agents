import { Button, cn } from "@autonoma/blacklight";
import type { ChatForwardOffer, ChatForwardReceipt, ChatForwardReceiptState } from "@autonoma/types";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/ArrowBendUpRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import type { Icon } from "@phosphor-icons/react/lib";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useResolveChatForward } from "lib/query/chat.queries";
import type { ReactNode } from "react";

/** The forward handshake as one card: pending (confirm/dismiss), forwarding, resolved receipt, or dismissed. */
export function ChatForwardCard({
  sessionId,
  turnId,
  offer,
}: {
  sessionId: string;
  turnId: string;
  offer: ChatForwardOffer;
}) {
  const resolve = useResolveChatForward(sessionId);

  if (offer.status === "dismissed") {
    return (
      <ForwardNote
        className="border-border-dim bg-surface-base text-text-secondary"
        icon={<XCircleIcon size={14} />}
        text="You dismissed this. Nothing was forwarded."
      />
    );
  }

  if (offer.receipt != null) {
    return <ForwardReceiptCard subject={offer.subject} receipt={offer.receipt} />;
  }

  if (offer.status === "confirmed") {
    return (
      <ForwardNote
        className="border-primary/40 bg-primary/5 text-text-secondary"
        icon={<CircleNotchIcon size={14} className="animate-spin" />}
        text="Forwarding for review..."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-primary/40 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-primary">
        <ArrowBendUpRightIcon size={15} weight="bold" />
        <span className="text-2xs font-semibold uppercase tracking-widest">Forward for review</span>
      </div>
      <p className="text-xs font-medium text-text-primary">{offer.subject}</p>
      <p className="text-xs leading-relaxed text-text-secondary">{offer.rationale}</p>
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="accent"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ sessionId, turnId, offerId: offer.id, decision: "confirm" })}
        >
          {offer.confirmLabel}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ sessionId, turnId, offerId: offer.id, decision: "dismiss" })}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

interface ReceiptPresentation {
  label: string;
  icon: Icon;
  className: string;
  iconClassName: string;
}

// Only `delivered` styles as success; keyed off the union so a new state can't render as delivered.
const RECEIPT_PRESENTATION: Record<ChatForwardReceiptState, ReceiptPresentation> = {
  delivered: {
    label: "Forwarded for review",
    icon: CheckCircleIcon,
    className: "border-status-success/40 bg-status-success/5",
    iconClassName: "text-status-success",
  },
  deferred: {
    label: "Queued for review",
    icon: WarningCircleIcon,
    className: "border-status-warn/40 bg-status-warn/5",
    iconClassName: "text-status-warn",
  },
  declined: {
    label: "Not accepted",
    icon: XCircleIcon,
    className: "border-border-mid bg-surface-base",
    iconClassName: "text-text-secondary",
  },
  failed: {
    label: "Failed to forward",
    icon: WarningCircleIcon,
    className: "border-status-critical/40 bg-status-critical/5",
    iconClassName: "text-status-critical",
  },
};

function ForwardReceiptCard({ subject, receipt }: { subject: string; receipt: ChatForwardReceipt }) {
  const presentation = RECEIPT_PRESENTATION[receipt.state];
  const StatusIcon = presentation.icon;

  return (
    <div className={cn("flex flex-col gap-2 rounded-md border p-3", presentation.className)}>
      <div className={cn("flex items-center gap-2", presentation.iconClassName)}>
        <StatusIcon size={15} weight="fill" />
        <span className="text-2xs font-semibold uppercase tracking-widest">{presentation.label}</span>
        {receipt.reference != null && (
          <span className="ml-auto font-mono text-3xs text-text-secondary">{receipt.reference}</span>
        )}
      </div>
      <p className="text-xs font-medium text-text-primary">{subject}</p>
      <p className="text-xs leading-relaxed text-text-secondary">{receipt.detail}</p>
    </div>
  );
}

function ForwardNote({ className, icon, text }: { className: string; icon: ReactNode; text: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-2xs", className)}>
      {icon}
      <span>{text}</span>
    </div>
  );
}
