import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
  buttonVariants,
  cn,
} from "@autonoma/blacklight";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { XIcon } from "@phosphor-icons/react/X";
import { Suspense } from "react";
import { ChatConversation, ChatConversationSkeleton } from "./chat-conversation";

/** PR-chat entry point: a header button opening a right-side drawer with the conversation. */
export function PrChatDrawer({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  return (
    <Drawer side="right">
      <DrawerTrigger className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}>
        <ChatCircleDotsIcon size={14} weight="fill" />
        Ask Autonoma
      </DrawerTrigger>
      <DrawerBackdrop />
      <DrawerContent side="right" className="flex w-[30rem] max-w-[90vw] flex-col gap-0 overflow-hidden p-0 font-sans">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-dim px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <DrawerTitle className="text-sm font-semibold normal-case tracking-normal text-text-primary">
              Ask Autonoma
            </DrawerTitle>
            <DrawerDescription className="truncate font-mono text-3xs uppercase tracking-widest text-text-secondary">
              PR #{prNumber}
            </DrawerDescription>
          </div>
          <DrawerClose
            className="text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Close chat"
          >
            <XIcon size={16} />
          </DrawerClose>
        </header>
        <Suspense fallback={<ChatConversationSkeleton />}>
          <ChatConversation applicationId={applicationId} prNumber={prNumber} />
        </Suspense>
      </DrawerContent>
    </Drawer>
  );
}
