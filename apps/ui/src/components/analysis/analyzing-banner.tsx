import { Badge } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { formatRelativeTime } from "lib/format";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The in-flight PR hero: the running checkpoint's analysis-progress state in the verdict banner's shell, so a live
 * run keeps the banner's place instead of a separate layout. Links into the checkpoint's staged view; shown until a
 * run settles a report to lead with.
 */
export function AnalyzingBanner({
  prNumber,
  snapshotId,
  startedAt,
}: {
  prNumber: number;
  snapshotId: string;
  startedAt?: Date;
}) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId }}
      className="group flex flex-col gap-4 border border-border-dim bg-surface-base px-5 py-5 transition-colors hover:border-border-mid hover:bg-surface-raised"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="status-running" className="gap-1 font-mono uppercase tracking-wider">
          <CircleNotchIcon size={12} className="animate-spin" />
          Analyzing
        </Badge>
        {startedAt != null && (
          <span className="font-mono text-2xs text-text-secondary">started {formatRelativeTime(startedAt)}</span>
        )}
      </div>

      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-text-primary">Analyzing your PR...</h2>
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-text-secondary">
          Autonoma is running the analysis pipeline. Open the checkpoint to watch it stage by stage.
          <ArrowRightIcon size={14} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
        </p>
      </div>
    </AppLink>
  );
}
