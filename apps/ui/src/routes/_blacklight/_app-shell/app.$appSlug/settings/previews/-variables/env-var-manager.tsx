import { Button, Input } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
import {
  NEW_VARIABLE_BUILD_TIME,
  envRow,
  envRowsFromDotenv,
  fieldIssueKey,
  type AppDraft,
  type DraftIssues,
  type ServiceDraft,
} from "../../../../../onboarding/-components/previewkit/topology-draft";
import { InjectedBlock } from "./injected-block";
import { PasteEnvDialog } from "./paste-env-dialog";
import { VariableEditor } from "./variable-editor";
import { VariableList } from "./variable-list";
import {
  applyVariable,
  bindTargets,
  injectedVars,
  removeVariable,
  variableViews,
  type VariableForm,
} from "./variable-model";

const SECRETS_DOCS_URL = "https://docs.autonoma.app/preview-environments/secrets/";

interface EnvVarManagerProps {
  app: AppDraft;
  /** Managed services in the topology - the connection targets. */
  services: ServiceDraft[];
  /** Real (non-starter) apps - also connection targets ({{app.url}}). */
  deployableApps: AppDraft[];
  issues: DraftIssues;
  updateApp: (id: number, patch: Partial<AppDraft>) => void;
}

/**
 * Unified per-app variable manager: a list split into Connections + Secrets, with
 * a focused editor that expands inline beneath the selected row. Every variable
 * injects at runtime; build time is an opt-in flag; connections wire to a service/app.
 */
export function EnvVarManager({ app, services, deployableApps, issues, updateApp }: EnvVarManagerProps) {
  const targets = bindTargets(services, deployableApps);
  const variables = variableViews(app, targets);
  const injected = injectedVars(app.primary);

  // The editor expands inline under the selected row; nothing is expanded until the user picks a row or adds
  // one, so a collapsed list is the resting state.
  const [editingId, setEditingId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  const editingView = variables.find((v) => v.row.id === editingId);

  const query = search.trim().toLowerCase();
  const visible = query === "" ? variables : variables.filter((v) => v.key.toLowerCase().includes(query));
  const envIssue =
    issues.fieldErrors.get(fieldIssueKey(app.id, "env"))?.[0] ??
    issues.fieldWarnings.get(fieldIssueKey(app.id, "env"))?.[0];

  const isBlank = (view: (typeof variables)[number] | undefined) =>
    view != null && view.key === "" && view.row.value === "";

  function handleChange(form: VariableForm) {
    if (editingView == null) return;
    updateApp(app.id, applyVariable(app, editingView.row.id, form).patch);
  }

  // Drop a still-blank row before leaving it, so an abandoned "Add variable" leaves nothing behind.
  function discardBlankEditing() {
    if (isBlank(editingView) && editingView != null) {
      updateApp(app.id, removeVariable(app, editingView.row.id));
    }
  }

  function selectVariable(rowId: number) {
    if (editingId === rowId) {
      discardBlankEditing();
      setEditingId(undefined);
      return;
    }
    discardBlankEditing();
    setEditingId(rowId);
  }

  function addVariable() {
    const base =
      isBlank(editingView) && editingView != null ? app.env.filter((row) => row.id !== editingView.row.id) : app.env;
    const blank = envRow("", "", true, "new", NEW_VARIABLE_BUILD_TIME);
    updateApp(app.id, { env: [...base, blank] });
    setEditingId(blank.id);
  }

  function importDotenv(entries: Array<{ key: string; value: string }>) {
    if (entries.length === 0) return;
    updateApp(app.id, { env: envRowsFromDotenv(app.env, entries) });
  }

  function deleteVariable(rowId: number) {
    updateApp(app.id, removeVariable(app, rowId));
    if (editingId === rowId) setEditingId(undefined);
  }

  function handleDelete() {
    if (editingView == null) return;
    deleteVariable(editingView.row.id);
  }

  return (
    <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0">
        <p className="flex items-center gap-2 font-mono text-2xs font-bold uppercase tracking-wider text-text-secondary">
          <span className="size-1.5 bg-primary" />
          Environment variables
        </p>
        <span className="border border-border-mid px-1.5 py-0.5 font-mono text-3xs text-text-secondary">
          {variables.length}
        </span>
        <a
          href={SECRETS_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-3xs text-primary-ink underline underline-offset-2"
        >
          Learn more
          <ArrowSquareOutIcon size={11} />
        </a>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <MagnifyingGlassIcon
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              aria-label="Search variables"
              className="h-8 w-36 pl-7 text-2xs sm:w-44"
            />
          </div>
          <PasteEnvDialog onImport={importDotenv} />
          <Button variant="cta" size="sm" className="gap-1" onClick={addVariable}>
            <PlusIcon size={12} weight="bold" />
            Add variable
          </Button>
        </div>
      </div>

      <InjectedBlock vars={injected} />

      {variables.length === 0 ? (
        <div className="flex items-center justify-center border border-border-dim px-6 py-14 text-center lg:min-h-0 lg:flex-1">
          <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">No variables yet</p>
        </div>
      ) : (
        <VariableList
          visible={visible}
          selectedRowId={editingId}
          searching={query !== ""}
          onSelect={selectVariable}
          onDelete={deleteVariable}
          renderEditor={(variable) => (
            <div className="border-l-2 border-l-primary bg-surface-base">
              <VariableEditor
                key={variable.row.id}
                app={app}
                view={variable}
                targets={targets}
                onChange={handleChange}
                onDelete={handleDelete}
              />
            </div>
          )}
        />
      )}

      {envIssue != null ? <p className="text-2xs text-status-critical lg:shrink-0">{envIssue}</p> : undefined}
    </div>
  );
}
