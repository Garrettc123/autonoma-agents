import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerTrigger,
  buttonVariants,
  cn,
} from "@autonoma/blacklight";
import type { AnalysisFindingView, ResolvedEvidenceAsset } from "@autonoma/types";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { XIcon } from "@phosphor-icons/react/X";
import { AnalysisReportProse } from "components/analysis/report-prose";

/**
 * The "Full report" button and the right-side drawer it opens - the only home of the Reporter's holistic prose on the
 * PR overview. The trigger renders in the verdict banner header (passed as the banner's report-action slot) and the
 * drawer holds the report body, so the banner itself never has to know about report bodies. Inside, the report's
 * inline issue/finding/evidence tokens resolve exactly as they do on the snapshot page.
 */
export function ReportDrawer({
  markdown,
  evidence,
  prNumber,
  findings,
  issueIds,
}: {
  markdown: string;
  evidence: ResolvedEvidenceAsset[];
  prNumber: number;
  findings: AnalysisFindingView[];
  /** The ids of issues this PR knows about, so a report token to a real issue links and a fabricated one stays text. */
  issueIds: ReadonlySet<string>;
}) {
  return (
    <Drawer side="right">
      {/* Style the trigger's own native button rather than render={<Button>}: Button is itself a Base UI button, so
          nesting it inside DrawerTrigger (also one) double-nests button primitives, which Base UI warns about. */}
      <DrawerTrigger className={cn(buttonVariants({ variant: "outline", size: "xs" }), "gap-1.5")}>
        <FileTextIcon size={14} />
        Full report
      </DrawerTrigger>
      <DrawerBackdrop />
      {/* outline-none: the focused popup would otherwise draw the global accent (lime) focus outline on its own
          edges - the inner close button and links keep their own focus rings, so the panel needs none. */}
      <DrawerContent
        side="right"
        className="flex w-168 max-w-[90vw] flex-col gap-0 overflow-hidden p-0 font-sans outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-dim px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">Full report</h2>
          <DrawerClose className="text-text-secondary transition-colors hover:text-text-primary" aria-label="Close">
            <XIcon size={16} />
          </DrawerClose>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <AnalysisReportProse
            markdown={markdown}
            evidence={evidence}
            prNumber={prNumber}
            findings={findings}
            issueIds={issueIds}
            variant="bare"
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
