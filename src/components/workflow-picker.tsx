"use client";

import { AlertTriangle, ChevronDown, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import type { CompatReport, WorkflowCompat } from "@/lib/compat";
import { formatEstimate, runEstimate } from "@/lib/workflows/estimate";
import type { WorkflowSummary } from "@/lib/workflows/types";
import { WORKFLOW_GROUPS, workflowIcon } from "./workflow-icons";

interface ListProps {
  workflows: WorkflowSummary[];
  /**
   * Which workflows are in turbo, and which switches are on — for the estimate
   * only. The switches live in the composer, but they change what a run costs,
   * so the number beside each workflow has to follow them.
   */
  turbo: Record<string, boolean>;
  patches: Record<string, string[]>;
  /**
   * What the ComfyUI machine is missing, per workflow — null until it has been
   * asked. Marked rather than disabled: the check can be wrong about a machine
   * mid-restart, and a run says for certain.
   */
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
      short: group.short,
      items: group.ids
        .map((id) => workflows.find((workflow) => workflow.id === id))
        .filter((workflow): workflow is WorkflowSummary => Boolean(workflow)),
    })),
    {
      title: "More",
      short: "More",
      items: workflows.filter((workflow) => !listed.has(workflow.id)),
    },
  ].filter((section) => section.items.length > 0);
}

/**
 * The rail down the left edge: every workflow, always on screen, so changing
 * what is being made is one click from anywhere rather than a list to open.
 *
 * Two densities. Below xl it is the icons alone, each named by its tooltip and
 * its accessible name, which leaves the monitor the width; from xl the names
 * and estimates are there too. Radio semantics, so it is announced as one
 * choice among a set.
 */
export function WorkflowRail(props: ListProps) {
  const { workflows, turbo, patches, compat, selectedId, onSelect } = props;
  const sections = sectionsOf(workflows);

  return (
    <nav aria-label="Workflows" className="no-scrollbar flex h-full flex-col overflow-y-auto py-3">
      <div role="radiogroup" aria-label="Workflow" className="flex flex-col gap-4">
        {sections.map((section) => (
          <div key={section.title} className="flex flex-col">
            <p
              className="label-caps mb-1 px-3 text-center text-fg-subtle xl:px-4 xl:text-left"
              title={section.title}
            >
              <span className="xl:hidden" aria-hidden="true">
                {section.short === "From a clip" ? "Clip" : section.short === "Long form" ? "Long" : section.short}
              </span>
              <span className="hidden xl:inline">{section.short}</span>
            </p>
            {section.items.map((workflow) => {
              const selected = workflow.id === selectedId;
              const estimate = runEstimate(workflow, turbo[workflow.id], patches[workflow.id]);
              const status = compat?.workflows[workflow.id];
              const blocked = (status?.blocking.length ?? 0) > 0;
              const Icon = workflowIcon(workflow.id);
              return (
                <button
                  key={workflow.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${workflow.name}${blocked ? " — missing parts on your ComfyUI" : ""}`}
                  title={`${workflow.name} — ${workflow.description}`}
                  onClick={() => onSelect(workflow.id)}
                  className={`group relative flex min-h-10 w-full items-center justify-center gap-2.5 px-3 py-1.5
                    text-left transition-colors xl:justify-start xl:px-4
                    ${selected ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg"}`}
                >
                  {/* The selection mark: a lit bar on the rail's edge. */}
                  <span
                    aria-hidden="true"
                    className={`absolute inset-y-1 left-0 w-[3px] transition-colors ${
                      selected ? "bg-accent" : "bg-transparent"
                    }`}
                  />
                  <Icon
                    aria-hidden="true"
                    className={`size-[18px] shrink-0 ${selected ? "text-accent" : ""}`}
                  />
                  <span className="hidden min-w-0 flex-1 truncate text-[13px] font-medium xl:block">
                    {workflow.name}
                  </span>
                  {estimate ? (
                    <span className="hidden shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle xl:block">
                      {formatEstimate(estimate)}
                    </span>
                  ) : null}
                  {blocked ? (
                    <span
                      aria-hidden="true"
                      className="absolute right-2 top-1.5 size-1.5 rounded-full bg-warning xl:static xl:size-1.5"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

/**
 * The phone's way in: the current workflow as the composer's title, which
 * opens the whole list in a sheet. The list there carries descriptions, since
 * a phone has no tooltips to carry them instead.
 */
export function WorkflowSwitcher(props: ListProps) {
  const { workflows, turbo, patches, compat, selectedId, onSelect } = props;
  const [open, setOpen] = useState(false);
  const current = workflows.find((workflow) => workflow.id === selectedId);
  const sections = sectionsOf(workflows);
  const Icon = current ? workflowIcon(current.id) : undefined;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex w-full items-center gap-3 rounded-md border border-border-strong bg-raised px-3 py-2.5 text-left"
      >
        {Icon ? <Icon aria-hidden="true" className="size-5 shrink-0 text-accent" /> : null}
        <span className="min-w-0 flex-1">
          <span className="label-caps block text-fg-subtle">Workflow</span>
          <span className="block truncate text-[15px] font-semibold text-fg">
            {current?.name ?? "Choose a workflow"}
          </span>
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Workflows">
        <div role="radiogroup" aria-label="Workflow" className="-mx-2 flex flex-col gap-4">
          {sections.map((section) => (
            <div key={section.title} className="flex flex-col gap-0.5">
              <p className="label-caps px-2 pb-1 text-fg-subtle">{section.title}</p>
              {section.items.map((workflow) => {
                const selected = workflow.id === selectedId;
                const estimate = runEstimate(workflow, turbo[workflow.id], patches[workflow.id]);
                const RowIcon = workflowIcon(workflow.id);
                return (
                  <button
                    key={workflow.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      onSelect(workflow.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-start gap-3 rounded-md px-2 py-2.5 text-left transition-colors
                      ${selected ? "bg-accent-subtle" : "hover:bg-surface-hover"}`}
                  >
                    <RowIcon
                      aria-hidden="true"
                      className={`mt-0.5 size-[18px] shrink-0 ${selected ? "text-accent" : "text-fg-muted"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate text-[14px] font-semibold text-fg">{workflow.name}</span>
                        {estimate ? (
                          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                            ~{formatEstimate(estimate)}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-fg-muted">
                        {workflow.description}
                      </span>
                      <MachineNote status={compat?.workflows[workflow.id]} />
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}

/** A workflow's icon at title size, for the composer's heading. */
export function WorkflowMark({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-md border border-accent/40 bg-accent-subtle text-accent"
    >
      <Icon className="size-5" />
    </span>
  );
}

/**
 * What the ComfyUI machine lacks for this workflow, and the fix — said before
 * Generate rather than after a failed run. A problem with the graph every run
 * uses comes first in the warning colour; one that only stops a mode (Turbo, a
 * patch) is quieter, since the workflow still runs without it.
 */
export function MachineNote({
  status,
  className = "",
}: {
  status: WorkflowCompat | undefined;
  className?: string;
}) {
  if (!status) return null;
  const { blocking, modes } = status;
  if (blocking.length === 0 && modes.length === 0) return null;

  const names = (list: { name: string }[]) =>
    list.length > 2
      ? `${list
          .slice(0, 2)
          .map((p) => p.name)
          .join(", ")} and ${list.length - 2} more`
      : list.map((p) => p.name).join(", ");

  return (
    <div className={`mt-2 flex flex-col gap-1 text-[12px] leading-relaxed ${className}`}>
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
