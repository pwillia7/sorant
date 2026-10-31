"use client";

import { ChevronRight, Gauge } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";
import { formatEstimate } from "@/lib/workflows/estimate";

/**
 * How a run is made — Turbo, the model switches, steps, seed — folded into
 * one row under the rest of the form, with what is set showing on the row.
 *
 * These are the controls touched least and explained most: the Speed
 * explainer alone was the first thing on every workflow's screen, ahead of
 * the prompt. Folded, they keep their state visible (the row names it, and so
 * does the summary by Generate), which is what makes hiding them safe.
 */
export function QualityFold({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-7 rounded-lg border border-border-default">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="quality-and-speed"
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left
          transition-colors hover:bg-surface-hover"
      >
        <Gauge aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
        <span className="text-[13px] font-medium text-fg">Quality &amp; speed</span>
        <span className="ml-auto min-w-0 truncate text-[12px] text-fg-subtle">{summary}</span>
        <ChevronRight
          aria-hidden="true"
          className={`size-3.5 shrink-0 text-fg-subtle transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div id="quality-and-speed" className="border-t border-border-default p-3 pt-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One line saying what Generate is about to run: its length, shape and size,
 * the speed it runs at, and roughly how long it takes. Read off the form's
 * own values by id, so a workflow without one of them just says less.
 */
export function runSummary(
  workflow: WorkflowSummary,
  values: Record<string, ParamValue>,
  { turbo, estimate }: { turbo: boolean; estimate?: number },
): string {
  const parts: string[] = [];
  const number = (id: string) => {
    const value = Number(values[id] ?? workflow.params.find((param) => param.id === id && "default" in param)?.default);
    return Number.isFinite(value) && workflow.params.some((param) => param.id === id) ? value : undefined;
  };
  const sceneCount = number("scene_count");
  if (sceneCount !== undefined) parts.push(`${sceneCount} scenes`);
  const duration = number("duration");
  if (duration !== undefined) parts.push(`${duration} s`);
  const aspect = workflow.params.find((param) => param.id === "aspect_ratio");
  if (aspect?.type === "select") {
    const value = String(values.aspect_ratio ?? aspect.default);
    const label = aspect.options.find((option) => option.value === value)?.label ?? value;
    // "9:16 (Portrait Widescreen)" says it in its first word.
    parts.push(label.split(" ")[0]);
  }
  const megapixels = number("megapixels");
  if (megapixels !== undefined) parts.push(`${megapixels} MP`);
  if (turbo) parts.push("Turbo");
  if (estimate) parts.push(`about ${formatEstimate(estimate)}`);
  return parts.join(" · ");
}
