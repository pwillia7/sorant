"use client";

import { Check, Clock3, LoaderCircle, X } from "lucide-react";
import type { LongSwapController, SegmentState } from "@/hooks/use-long-swap";
import { withToken } from "@/lib/client";
import type { Job } from "@/lib/jobs";
import { segmentFrames, SLICE_FPS } from "@/lib/workflows/slices";
import { Badge, Panel, PanelHeader } from "./ui/panel";
import { Button, buttonClasses } from "./ui/button";

/**
 * A long Character swap in progress: its segments, how far the chain has got,
 * and the joined video once there is one. See use-long-swap.ts.
 */

const icon = { className: "size-3 shrink-0 stroke-2", "aria-hidden": true } as const;

function SegmentBadge({ state, job }: { state: SegmentState; job: Job | undefined }) {
  switch (state) {
    case "waiting":
      return <Badge>waiting</Badge>;
    case "queued":
      return (
        <Badge>
          <Clock3 {...icon} /> queued{job?.queuePosition ? ` · ${job.queuePosition} ahead` : ""}
        </Badge>
      );
    case "running":
      return (
        <Badge tone="accent">
          <LoaderCircle {...icon} className="size-3 shrink-0 stroke-2 motion-safe:animate-spin" /> swapping
        </Badge>
      );
    case "done":
      return (
        <Badge tone="success">
          <Check {...icon} /> done
        </Badge>
      );
    default:
      return (
        <Badge tone="danger">
          <X {...icon} /> {job?.phase === "cancelled" ? "cancelled" : "failed"}
        </Badge>
      );
  }
}

/** "1:05" from seconds. */
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function videoUrl(job: Job | undefined): string | undefined {
  return job?.phase === "done"
    ? job.outputs.find((file) => (file.type || "output") === "output" && /\.(mp4|webm|mov)$/i.test(file.filename))?.url
    : undefined;
}

export function LongSwapPanel({ swap }: { swap: LongSwapController }) {
  const { project, states, segmentJobs, joinJob } = swap;
  if (!project) return null;

  const total = project.segments.length;
  const done = states.filter((state) => state === "done").length;
  const failed = states.some((state) => state === "failed");
  const active = states.some((state) => state === "queued" || state === "running");
  const joined = videoUrl(joinJob);
  const joining = joinJob !== undefined && (joinJob.phase === "queued" || joinJob.phase === "running");
  const joinFailed = joinJob !== undefined && ["error", "cancelled", "unknown"].includes(joinJob.phase);
  const stopped = Boolean(project.paused) || failed;

  const hint = joined
    ? "Joined, with the clip's own soundtrack."
    : joining
      ? "Every segment is done. Joining them…"
      : stopped && !active
        ? "Stopped. Resume carries on from the first segment that is not done; the finished ones are kept."
        : "Each segment carries on from the last frames of the one before, so the next is sent when this page sees one finish. Keep this tab open; closed, the chain waits and carries on when you come back.";

  return (
    <Panel padded>
      <PanelHeader
        title={`Character swap · ${clock(project.seconds)} in ${total} segments`}
        hint={hint}
        action={
          <Button
            variant="quiet"
            size="xs"
            onClick={swap.clear}
            title="Forget this swap. Its segments and any join stay in the history."
          >
            Start over
          </Button>
        }
      />

      {swap.error ? (
        <p
          className="mb-4 rounded-lg border border-danger/40 bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
          role="alert"
        >
          {swap.error}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="Segments done"
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: `${(done / total) * 100}%` }} />
        </div>
        <span className="text-[12px] tabular-nums text-fg-muted">
          {done} of {total} done
        </span>
        {stopped && done < total ? (
          <Button size="sm" variant="primary" onClick={swap.resume} loading={swap.sending}>
            Resume
          </Button>
        ) : null}
        {!stopped && done < total ? (
          <Button size="sm" onClick={() => void swap.stop()}>
            Stop
          </Button>
        ) : null}
        {done === total && (joinFailed || !joinJob) ? (
          <Button size="sm" onClick={() => void swap.join()}>
            {joinFailed ? "Join again" : "Join"}
          </Button>
        ) : null}
      </div>

      {joined ? (
        <div className="mb-5">
          <video
            src={withToken(joined)}
            controls
            playsInline
            preload="metadata"
            className="mx-auto block max-h-[75vh] w-full rounded-lg border border-border-default bg-black object-contain"
          />
          <div className="mt-2 flex gap-2">
            <a
              href={withToken(joined)}
              download="character-swap.mp4"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Download
            </a>
          </div>
        </div>
      ) : null}

      <ol className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
        {project.segments.map((segment, index) => {
          const job = segmentJobs[index];
          const url = videoUrl(job);
          const end = segment.start + segmentFrames(segment, project.seconds);
          return (
            <li
              key={segment.start}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-default bg-bg-subtle p-2"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-[12px] font-medium text-fg">Segment {index + 1}</span>
                <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
                  {clock(segment.start / SLICE_FPS)}–{clock(end / SLICE_FPS)}
                </span>
              </div>
              {url ? (
                <video
                  src={withToken(url)}
                  muted
                  playsInline
                  preload="metadata"
                  controls
                  className="aspect-video max-h-40 w-full rounded bg-black object-contain"
                />
              ) : null}
              <SegmentBadge state={states[index]} job={job} />
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
