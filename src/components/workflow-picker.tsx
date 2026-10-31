"use client";

import { ChevronsUpDown, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CompatReport, WorkflowCompat } from "@/lib/compat";
import type { WorkflowSummary } from "@/lib/workflows/types";
import { WORKFLOW_GROUPS, workflowIcon } from "./workflow-icons";

/**
 * The predetermined workflow list. Radio semantics rather than buttons so
 * arrow keys move between options the way a grouped choice should.
 */
export function WorkflowPicker({
  workflows,
  turbo,
  patches,
  compat,
  selectedId,
  onSelect,
  disabled,
}: {
  workflows: WorkflowSummary[];
  /**
   * Which workflows are in turbo. The switch lives in the settings panel, but
   * the mode changes what a run costs, so the estimate on the card has to
   * follow it — otherwise picking a workflow tells you the wrong number about
   * the mode you left it in.
   */
  turbo: Record<string, boolean>;
  /**
   * The same for the single-node switches, by id — for the estimate only. They
   * carry no badge: three of them alongside Turbo overran the card and pushed
   * the name out of it, and unlike Turbo none of them changes what any control
   * on the next screen means, so the switch itself is the only place they need
   * to be visible.
   */
  patches: Record<string, string[]>;
  /**
   * What the ComfyUI machine is missing, per workflow — null until it has been
   * asked. Shown on the card rather than by disabling it: the check can be
   * wrong about a machine mid-restart, and a run says for certain.
   */
  compat: CompatReport | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  /**
   * Collapsed once a workflow is chosen, which is immediately and for the rest
   * of the session.
   *
   * The list is six cards carrying a description each, and it sits above the
   * form in the column the form is in — so left open it is most of a screen of
   * navigation scrolled past on the way to the controls, every visit, to reach
   * the one thing on it that has changed: nothing. Open is still the state for
   * a first look, and for whenever the choice is actually being made.
   */
  const [open, setOpen] = useState(!selectedId);

  /**
   * Reopening when the choice goes away, and closing when it arrives — which is
   * what the hand-off buttons do: pressing Remix on a finished clip picks a
   * workflow from the other side of the page, and the list has no reason to be
   * standing open afterwards.
   */
  const previous = useRef(selectedId);
  useEffect(() => {
    if (previous.current !== selectedId) {
      previous.current = selectedId;
      if (selectedId) setOpen(false);
    }
  }, [selectedId]);

  const current = workflows.find((workflow) => workflow.id === selectedId);

  if (!open && current) {
    const Icon = workflowIcon(current.id);
    return (
      <div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="group flex w-full items-center gap-3 rounded-lg border border-border-default
            bg-bg-subtle p-2.5 text-left transition-colors duration-150
            hover:border-border-strong hover:bg-surface-hover
            disabled:pointer-events-none disabled:opacity-50"
        >
          <WorkflowGlyph icon={Icon} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
              {current.name}
            </span>
            <span className="block truncate text-[12px] text-fg-muted">{current.description}</span>
          </span>
          <span className="shrink-0 text-[12px] text-fg-subtle group-hover:text-fg-muted">
            Change
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
        </button>
        <MachineNote status={compat?.workflows[current.id]} className="px-3" />
      </div>
    );
  }

  // By what someone is trying to do, so the choice is narrowed before a
  // description has been read. See WORKFLOW_GROUPS.
  const listed = new Set(WORKFLOW_GROUPS.flatMap((group) => group.ids));
  const sections = [
    ...WORKFLOW_GROUPS.map((group) => ({
      title: group.title,
      items: group.ids
        .map((id) => workflows.find((workflow) => workflow.id === id))
        .filter((workflow): workflow is WorkflowSummary => Boolean(workflow)),
    })),
    { title: "More", items: workflows.filter((workflow) => !listed.has(workflow.id)) },
  ].filter((section) => section.items.length > 0);

  return (
    <div role="radiogroup" aria-label="Workflow" className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-1.5">
          <p className="px-1 text-[12px] font-medium text-fg-muted">{section.title}</p>
          <div className="grid gap-1">
            {section.items.map((workflow) => {
              const selected = workflow.id === selectedId;
              const estimate = estimateFor(workflow, turbo[workflow.id], patches[workflow.id]);
              return (
                <button
                  key={workflow.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => onSelect(workflow.id)}
                  className={`group flex w-full min-w-0 items-start gap-2.5 rounded-lg border p-2.5 text-left
                    transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50
                    ${
                      selected
                        ? "border-accent bg-accent-subtle/40"
                        : "border-transparent hover:border-border-default hover:bg-surface-hover"
                    }`}
                >
                  <WorkflowGlyph icon={workflowIcon(workflow.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      {/* min-w-0 and truncate so a long name gives way rather
                          than widening the row past the card. */}
                      <span className="min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
                        {workflow.name}
                      </span>
                      {estimate ? (
                        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                          ~{formatEstimate(estimate)}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-fg-muted">
                      {workflow.description}
                    </span>
                    <MachineNote status={compat?.workflows[workflow.id]} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A workflow's icon on its tile, the same everywhere a workflow is picked. */
function WorkflowGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent"
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  );
}

/**
 * Roughly how long a run of this workflow takes in the modes it is in: the
 * last switch with an estimate of its own, then Turbo's, then the plain one.
 */
export function estimateFor(
  workflow: WorkflowSummary,
  turbo: boolean | undefined,
  on: string[] | undefined,
): number | undefined {
  const isTurbo = Boolean(turbo) && Boolean(workflow.turbo);
  return (
    workflow.patches
      .filter((patch) => (on ?? []).includes(patch.id))
      .map((patch) => patch.estimatedSeconds)
      .findLast((seconds) => seconds !== undefined) ??
    (isTurbo ? workflow.turbo?.estimatedSeconds : undefined) ??
    workflow.estimatedSeconds
  );
}

/**
 * What the ComfyUI machine lacks for this workflow, and the fix — on the card,
 * because a phone has no tooltip and the point is to say it before Generate.
 * A problem with the graph every run uses comes first and in the warning
 * colour; one that only stops a mode (Turbo, a patch) is quieter, since the
 * workflow still runs without it.
 */
function MachineNote({
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
      ? `${list.slice(0, 2).map((p) => p.name).join(", ")} and ${list.length - 2} more`
      : list.map((p) => p.name).join(", ");

  return (
    <div className={`mt-1.5 text-[12px] leading-relaxed ${className}`}>
      {blocking.length > 0 ? (
        <p className="text-warning">
          Your ComfyUI is missing {names(blocking)}. {blocking[0].fix}
        </p>
      ) : null}
      {modes.map(({ mode, problems }) => (
        <p key={mode} className="text-fg-subtle">
          {mode.charAt(0).toUpperCase() + mode.slice(1)} won’t run here: missing{" "}
          {names(problems)}. {problems[0].fix}
        </p>
      ))}
    </div>
  );
}

export function formatEstimate(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}
