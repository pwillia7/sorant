"use client";

import { AlertTriangle, ChevronDown, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CompatReport, WorkflowCompat } from "@/lib/compat";
import { formatEstimate, runEstimate } from "@/lib/workflows/estimate";
import type { WorkflowSummary } from "@/lib/workflows/types";
import { WORKFLOW_GROUPS, workflowIcon } from "./workflow-icons";

interface ListProps {
  workflows: WorkflowSummary[];
  /** Which workflows are in turbo and which switches are on: the estimates follow them. */
  turbo: Record<string, boolean>;
  patches: Record<string, string[]>;
  /** What the ComfyUI machine is missing, per workflow — null until asked. */
  compat: CompatReport | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** The registry, sectioned by what someone is trying to do. */
function sectionsOf(workflows: WorkflowSummary[]) {
  const listed = new Set(WORKFLOW_GROUPS.flatMap((group) => group.ids));
  return [
    ...WORKFLOW_GROUPS.map((group) => ({
      title: group.title,
      items: group.ids
        .map((id) => workflows.find((workflow) => workflow.id === id))
        .filter((workflow): workflow is WorkflowSummary => Boolean(workflow)),
    })),
    { title: "More", items: workflows.filter((workflow) => !listed.has(workflow.id)) },
  ].filter((section) => section.items.length > 0);
}

/**
 * Every workflow as a card: its icon, its name, what it does, how long it
 * takes here. The gallery's empty state and the dock's menu are both this —
 * the first question on an empty page is the same one the menu asks.
 */
export function WorkflowCards({
  workflows,
  turbo,
  patches,
  compat,
  selectedId,
  onSelect,
  dense = false,
}: ListProps & { dense?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Workflow" className="flex flex-col gap-7">
      {sectionsOf(workflows).map((section) => (
        <section key={section.title}>
          <h3 className="label-caps mb-2.5 text-fg-subtle">{section.title}</h3>
          <div className={`grid gap-2 ${dense ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-4"}`}>
            {section.items.map((workflow) => {
              const selected = workflow.id === selectedId;
              const estimate = runEstimate(workflow, turbo[workflow.id], patches[workflow.id]);
              const Icon = workflowIcon(workflow.id);
              return (
                <button
                  key={workflow.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onSelect(workflow.id)}
                  className={`flex min-h-24 flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition-colors
                    ${
                      selected
                        ? "border-accent bg-accent-subtle"
                        : "border-border-default bg-surface hover:border-border-strong hover:bg-surface-hover"
                    }`}
                >
                  <span className="flex w-full items-center gap-2">
                    <Icon aria-hidden="true" className={`size-5 shrink-0 ${selected ? "text-accent" : "text-fg-muted"}`} />
                    {estimate ? (
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-fg-subtle">
                        ~{formatEstimate(estimate)}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[14px] font-semibold leading-tight text-fg">{workflow.name}</span>
                  <span className="text-[12px] leading-snug text-fg-muted">{workflow.description}</span>
                  <MachineNote status={compat?.workflows[workflow.id]} short />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The dock's workflow button and the menu it opens: the same cards, in a
 * dialog over the gallery.
 */
export function WorkflowMenu(props: ListProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange, ...list } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const current = list.workflows.find((workflow) => workflow.id === list.selectedId);
  const Icon = current ? workflowIcon(current.id) : null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-haspopup="dialog"
        title="Choose what to make"
        className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border-strong bg-surface pl-2.5 pr-2
          text-[13px] font-semibold text-fg transition-colors hover:bg-surface-hover"
      >
        {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0 text-accent" /> : null}
        <span className="truncate">{current?.name ?? "Choose"}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
      </button>

      <dialog
        ref={ref}
        onClose={() => onOpenChange(false)}
        onClick={(event) => {
          if (event.target === ref.current) onOpenChange(false);
        }}
        aria-label="What do you want to make?"
        className="m-0 mt-auto max-h-[88dvh] w-full max-w-none rounded-t-2xl border border-border-strong bg-bg p-0 text-fg
          shadow-md backdrop:bg-black/70 sm:m-auto sm:w-[min(64rem,calc(100vw-2rem))] sm:rounded-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border-default px-5 py-4">
          <h2 className="display-tight text-[20px] font-semibold">What do you want to make?</h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="ml-auto grid size-8 place-items-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="max-h-[calc(88dvh-4rem)] overflow-y-auto p-5">
          <WorkflowCards
            {...list}
            onSelect={(id) => {
              list.onSelect(id);
              onOpenChange(false);
            }}
          />
        </div>
      </dialog>
    </>
  );
}

/**
 * What the ComfyUI machine lacks for a workflow, and the fix — said before
 * Generate rather than after a failed run. `short` keeps a card to the
 * headline; the settings panel gives the whole of it.
 */
export function MachineNote({
  status,
  short = false,
  className = "",
}: {
  status: WorkflowCompat | undefined;
  short?: boolean;
  className?: string;
}) {
  if (!status) return null;
  const { blocking, modes } = status;
  if (blocking.length === 0 && (short || modes.length === 0)) return null;

  const names = (list: { name: string }[]) =>
    list.length > 2
      ? `${list
          .slice(0, 2)
          .map((p) => p.name)
          .join(", ")} and ${list.length - 2} more`
      : list.map((p) => p.name).join(", ");

  if (short) {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-warning">
        <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
        Missing parts on your ComfyUI
      </span>
    );
  }

  return (
    <div className={`flex flex-col gap-1 text-[12px] leading-relaxed ${className}`}>
      {blocking.length > 0 ? (
        <p className="flex gap-1.5 text-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Your ComfyUI is missing {names(blocking)}. {blocking[0].fix}
          </span>
        </p>
      ) : null}
      {modes.map(({ mode, problems }) => (
        <p key={mode} className="text-fg-subtle">
          {mode.charAt(0).toUpperCase() + mode.slice(1)} won’t run here: missing {names(problems)}.{" "}
          {problems[0].fix}
        </p>
      ))}
    </div>
  );
}
