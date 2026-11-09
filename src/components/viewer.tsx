"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { formatDuration, formatWhen, renderMs, type Job } from "@/lib/jobs";
import { runTimeTitle } from "./ui/run-time";
import { workflowIcon } from "./workflow-icons";

/**
 * One generation, full size: the gallery's tile opened. Built on <dialog>, so
 * Esc, focus containment and the inert page behind come from the platform.
 *
 * The picture leads, and what it is — the prompt, what made it, when — sits
 * under it in reading order. The left and right arrow keys step through the
 * gallery without closing, which is how takes get compared.
 */
export function Viewer({
  job,
  now,
  onClose,
  onStep,
  children,
}: {
  job: Job | null;
  now: number;
  onClose: () => void;
  /** Move to the neighbouring generation, if there is one that way. */
  onStep?: (direction: -1 | 1) => void;
  /** The stage: the media and its actions. */
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = job !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || !onStep) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Arrows belong to a focused video's own scrubber or a text field.
      if (target && /^(VIDEO|AUDIO|INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "ArrowLeft") onStep(-1);
      if (event.key === "ArrowRight") onStep(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onStep]);

  const Icon = job ? workflowIcon(job.workflowId) : null;
  const rendered = job?.phase === "done" ? renderMs(job) : null;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      aria-label={job ? `${job.workflowName}: ${job.prompt.trim() || "generation"}` : "Generation"}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-fg backdrop:bg-black/85
        backdrop:backdrop-blur-sm"
    >
      {job ? (
        <div
          className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-3 py-3 sm:px-6 sm:py-6"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div className="mb-3 flex items-center gap-2">
            {Icon ? <Icon className="size-4 text-white/70" aria-hidden="true" /> : null}
            <span className="text-[13px] font-medium text-white">{job.workflowName}</span>
            <span className="font-mono text-[12px] text-white/50">
              {formatWhen(job.submittedAt, now)}
              {rendered !== null ? <span title={runTimeTitle(job, rendered)}> · took {formatDuration(rendered)}</span> : null}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {onStep ? (
                <>
                  <ViewerButton label="Previous" onClick={() => onStep(-1)}>
                    <ChevronLeft className="size-5" aria-hidden="true" />
                  </ViewerButton>
                  <ViewerButton label="Next" onClick={() => onStep(1)}>
                    <ChevronRight className="size-5" aria-hidden="true" />
                  </ViewerButton>
                </>
              ) : null}
              <ViewerButton label="Close" onClick={onClose}>
                <X className="size-5" aria-hidden="true" />
              </ViewerButton>
            </div>
          </div>

          <div className="rounded-2xl bg-bg p-3 shadow-md sm:p-5">
            {children}
            {job.prompt.trim() ? (
              <p className="mt-5 max-w-3xl whitespace-pre-line border-t border-border-default pt-4 text-[15px] leading-relaxed text-fg">
                {job.prompt.trim()}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

function ViewerButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-9 place-items-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
