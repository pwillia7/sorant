import { Timer } from "lucide-react";
import { formatDuration, queueMs, renderMs, type Job } from "@/lib/jobs";

/**
 * How long something took to render, small and quiet beside what it made.
 * Render time only: a wait in the queue is time spent on something else, so
 * it goes in the tooltip, not the number.
 */
export function RunTime({ ms, title, suffix }: { ms: number; title: string; suffix?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-fg-subtle"
      title={title}
    >
      <Timer className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">Took </span>
      {formatDuration(ms)}
      {suffix ? ` ${suffix}` : null}
    </span>
  );
}

/** A finished job's render time; nothing when it was never seen running. */
export function JobRunTime({ job }: { job: Job | undefined }) {
  const ms = job?.phase === "done" ? renderMs(job) : null;
  if (ms === null || !job) return null;
  return <RunTime ms={ms} title={runTimeTitle(job, ms)} />;
}

export function runTimeTitle(job: Job, ms: number): string {
  const waited = queueMs(job);
  return `Took ${formatDuration(ms)} to render${waited !== null && waited >= 5000 ? `, after ${formatDuration(waited)} in the queue` : ""}.`;
}
