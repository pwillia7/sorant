"use client";

import { LoaderCircle, RotateCcw } from "lucide-react";
import { windowFrames, type ClipChainController } from "@/hooks/use-clip-chain";
import { withToken } from "@/lib/client";
import { totalRenderMs } from "@/lib/jobs";
import { CHAIN_FPS } from "@/lib/workflows/chain";
import { clock, JoinedVideo, SegmentBadge, videoUrl } from "./long-swap-panel";
import { ClipPlayer, type ClipItem } from "./ui/clip-player";
import { JobRunTime } from "./ui/run-time";
import { Panel, PanelHeader } from "./ui/panel";
import { Button } from "./ui/button";

/**
 * A long Remix in progress: its parts, how many are done, and the joined
 * video once there is one. See use-clip-chain.ts.
 */

const icon = { className: "size-3 shrink-0 stroke-2", "aria-hidden": true } as const;

export function ClipChainPanel({ chain }: { chain: ClipChainController }) {
  const { project, states, windowJobs, joinJob } = chain;
  if (!project) return null;

  const total = project.windows.length;
  const span = (index: number) => {
    const start = project.windows[index].start;
    return [start / CHAIN_FPS, (start + windowFrames(project, index)) / CHAIN_FPS] as const;
  };
  const clips: ClipItem[] = project.windows.flatMap((_, index) => {
    const url = videoUrl(windowJobs[index]);
    if (!url) return [];
    const [from, to] = span(index);
    return [
      {
        url: withToken(url),
        title: `Part ${index + 1}`,
        subtitle: `${clock(from)}–${clock(to)}`,
        download: `remix-part-${index + 1}.mp4`,
      },
    ];
  });
  const done = states.filter((state) => state === "done").length;
  const failed = states.some((state) => state === "failed");
  const active = states.some((state) => state === "queued" || state === "running");
  const joined = videoUrl(joinJob);
  const joining = joinJob !== undefined && (joinJob.phase === "queued" || joinJob.phase === "running");
  const joinFailed = joinJob !== undefined && ["error", "cancelled", "unknown"].includes(joinJob.phase);
  const stopped = Boolean(project.paused) || failed;

  const hint = joined
    ? "Joined. Redo any part with a new seed and it is joined again on its own."
    : joining
      ? "Every part is done. Joining them…"
      : stopped && !active
        ? "Stopped. Resume sends the parts that are not done; the finished ones are kept."
        : "Every part is queued at once and remixed on its own, then joined. Closing this tab does not stop the queue; the join is sent when the page next sees every part done.";

  return (
    <Panel padded>
      <PanelHeader
        title={`Remix · ${clock(project.seconds)} in ${total} parts`}
        hint={hint}
        action={
          <Button
            variant="quiet"
            size="xs"
            onClick={chain.clear}
            title="Forget this remix. Its parts and any join stay in the history."
          >
            Start over
          </Button>
        }
      />

      {chain.error ? (
        <p
          className="mb-4 rounded-lg border border-danger/40 bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
          role="alert"
        >
          {chain.error}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="Parts done"
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: `${(done / total) * 100}%` }} />
        </div>
        <span className="text-[12px] tabular-nums text-fg-muted">
          {done} of {total} done
        </span>
        {stopped && done < total ? (
          <Button size="sm" variant="primary" onClick={chain.resume} loading={chain.sending}>
            Resume
          </Button>
        ) : null}
        {!stopped && done < total ? (
          <Button size="sm" onClick={() => void chain.stop()}>
            Stop
          </Button>
        ) : null}
        {done === total && (joinFailed || !joinJob) ? (
          <Button size="sm" onClick={() => void chain.join()} loading={chain.sending}>
            {joinFailed ? "Join again" : "Join"}
          </Button>
        ) : null}
      </div>

      {joining ? (
        <p className="mb-4 flex items-center gap-2 text-[13px] text-fg-muted" role="status">
          <LoaderCircle {...icon} className="size-3.5 shrink-0 stroke-2 motion-safe:animate-spin" />
          {joinJob?.phase === "queued"
            ? `Join queued${joinJob.queuePosition ? `, ${joinJob.queuePosition} ahead` : ""}…`
            : "Joining the parts…"}
        </p>
      ) : null}

      {joined ? (
        <JoinedVideo url={joined} download="remix.mp4" took={totalRenderMs([...windowJobs, joinJob])} />
      ) : null}

      <ol className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
        {project.windows.map((window, index) => {
          const job = windowJobs[index];
          const url = videoUrl(job);
          const [from, to] = span(index);
          return (
            <li
              key={window.start}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-default bg-bg-subtle p-2"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-[12px] font-medium text-fg">Part {index + 1}</span>
                <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
                  {clock(from)}–{clock(to)}
                </span>
              </div>
              {url ? (
                <ClipPlayer
                  item={clips.find((clip) => clip.url === withToken(url)) ?? { url: withToken(url), title: `Part ${index + 1}` }}
                  siblings={clips}
                  className="aspect-video w-full rounded"
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-1">
                <SegmentBadge state={states[index]} job={job} original={false} running="remixing" />
                {states[index] === "done" ? <JobRunTime job={job} /> : null}
                {states[index] === "done" && !joining && !chain.sending ? (
                  <Button
                    variant="quiet"
                    size="xs"
                    className="ml-auto"
                    onClick={() => chain.redo(index)}
                    aria-label={`Redo part ${index + 1}`}
                    title={`Remix part ${index + 1} again with a new seed. The parts are joined again once it is done.`}
                  >
                    <RotateCcw {...icon} /> Redo
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
