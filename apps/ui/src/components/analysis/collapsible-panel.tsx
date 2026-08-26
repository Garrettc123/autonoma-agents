import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import type { ReactNode } from "react";

/**
 * A `Panel` whose body is hidden behind its header until the reader opens it - the disclosure the PR overview uses to
 * demote a secondary surface (the full report prose, the tests-run list) beneath the verdict and issues that lead the
 * page. Native `<details>`, so it needs no state and works before hydration; an optional `· N` count rides beside the
 * title, and `bodyClassName` lets a caller drop the default `PanelBody` padding for a flush list.
 */
export function CollapsiblePanel({
  title,
  count,
  bodyClassName,
  children,
}: {
  title: string;
  count?: number;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <Panel>
      <details className="group">
        <summary className="cursor-pointer list-none">
          <PanelHeader className="transition-colors hover:bg-surface-raised">
            <div className="flex items-center gap-2">
              <PanelTitle>{title}</PanelTitle>
              {count != null && <span className="font-mono text-2xs text-text-secondary">· {count}</span>}
            </div>
            <CaretRightIcon size={12} className="text-text-secondary transition-transform group-open:rotate-90" />
          </PanelHeader>
        </summary>
        <PanelBody className={bodyClassName}>{children}</PanelBody>
      </details>
    </Panel>
  );
}
