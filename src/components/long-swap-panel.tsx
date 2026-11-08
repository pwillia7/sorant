"use client";

import { Check, Clock3, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { savedMask, startsFresh, type LongSwapController, type SegmentChoice, type SegmentState } from "@/hooks/use-long-swap";
import { withToken } from "@/lib/client";
import type { Job } from "@/lib/jobs";
import { MUSIC_VIDEO_FRAME_RATES, MUSIC_VIDEO_UPSCALE_SIZES } from "@/lib/music-video/project";
import { segmentFrames, SLICE_FPS } from "@/lib/workflows/slices";
import { BoxPicker, inputVideoUrl } from "./ui/box-picker";
import { Badge, Panel, PanelHeader } from "./ui/panel";
import { Button, buttonClasses, Spinner } from "./ui/button";
import { Segmented } from "./ui/inputs";

/**
 * A long Character swap in progress: its segments, how far the chain has got,
 * and the joined video once there is one. See use-long-swap.ts.
 */

const icon = { className: "size-3 shrink-0 stroke-2", "aria-hidden": true } as const;

function SegmentBadge({ state, job, original }: { state: SegmentState; job: Job | undefined; original: boolean }) {
  if (original && state !== "failed") {
    return state === "done" ? (
      <span title="SAM found no one to replace here, so this stretch is the clip's own footage.">
        <Badge tone="warning">original footage</Badge>
      </span>
    ) : (
      <Badge>
        <LoaderCircle {...icon} className="size-3 shrink-0 stroke-2 motion-safe:animate-spin" /> copying original
      </Badge>
    );
  }
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

type RedoMode = "carry" | "form" | "largest" | "leftmost" | "rightmost" | "box";

const RULES: Array<{ value: RedoMode; label: string }> = [
  { value: "largest", label: "Biggest" },
  { value: "leftmost", label: "Leftmost" },
  { value: "rightmost", label: "Rightmost" },
  { value: "box", label: "Draw a box" },
];

/**
 * Setting up a redo: who the segment follows, and how far the redo reaches.
 * By default it follows whoever the segment before tracked into it — the
 * carried mask — or, for the first, whatever the form says. A rule or a box,
 * drawn on the frame this segment's run starts on, replaces that for it.
 */
function RedoEditor({
  swap,
  index,
  onDone,
}: {
  swap: LongSwapController;
  index: number;
  onDone: () => void;
}) {
  const project = swap.project!;
  const total = project.segments.length;
  const segment = project.segments[index];
  const carried = startsFresh(project, index) ? 0 : segment.history;
  const canCarry = index > 0 && savedMask(swap.segmentJobs[index - 1], carried > 0) !== null;
  const [mode, setMode] = useState<RedoMode>(index === 0 ? "form" : canCarry ? "carry" : "form");
  const [box, setBox] = useState("");
  const clip = String(project.values.source_video ?? "");
  // The frame SAM looks at first in this segment's run: its own start, or the
  // history before it when it carries on.
  const time = (segment.start - carried) / SLICE_FPS;

  const choice: SegmentChoice | undefined =
    mode === "box" ? { box } : mode === "carry" || mode === "form" ? undefined : { pick: mode };
  const ready = mode !== "box" || Boolean(box);
  const send = (onward: boolean) => {
    swap.redo(index, onward, choice);
    onDone();
  };

  const modes: Array<{ value: RedoMode; label: string; title?: string }> = [
    canCarry
      ? {
          value: "carry",
          label: `Same as segment ${index}`,
          title: "Starts from whoever the segment before tracked into this one: the same person, with no fresh pick.",
        }
      : {
          value: "form",
          label: "As in the form",
          title:
            index === 0
              ? "The form's box, or its description and rule."
              : "The form's description and rule. The segment before saved no mask to carry on from.",
        },
    ...RULES,
  ];

  return (
    <section className="mt-4 flex flex-col gap-3 rounded-lg border border-border-default bg-bg-subtle p-3" aria-label={`Redo segment ${index + 1}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg">Redo segment {index + 1}</h3>
        <span className="text-[12px] text-fg-subtle">A new seed; choose who it follows.</span>
      </div>
      <Segmented label="Who it follows" value={mode} onChange={setMode} options={modes} />
      {mode === "box" ? (
        clip ? (
          <BoxPicker
            src={inputVideoUrl(clip)}
            time={time}
            value={box}
            onChange={setBox}
            label={`The frame segment ${index + 1} starts from`}
          />
        ) : (
          <p className="text-[12px] text-danger">The clip this swap was made from is not known, so there is no frame to draw on.</p>
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!ready}
          onClick={() => send(false)}
          title={
            index < total - 1
              ? `Swaps segment ${index + 1} again, carrying on from the one before, then joins again. Segment ${index + 2} still carries on from this one's old frames, so that join can show a jump; from here on avoids it.`
              : `Swaps segment ${index + 1} again, carrying on from the one before, then joins again.`
          }
        >
          Redo segment {index + 1}
        </Button>
        {index < total - 1 ? (
          <Button
            size="sm"
            disabled={!ready}
            onClick={() => send(true)}
            title={`Swaps segment ${index + 1} and the ${total - index - 1} after it again, each carrying on from the one before and following the same person, then joins again.`}
          >
            Redo {index + 1}–{total}
          </Button>
        ) : null}
        <Button size="sm" variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/** "1:05" from seconds. */
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function videoUrl(job: Job | undefined): string | undefined {
  return job?.phase === "done"
    ? job.outputs.find((file) => (file.type || "output") === "output" && /\.(mp4|webm|mov)$/i.test(file.filename))?.url
    : undefined;
}

const FAILED_PHASES = new Set(["error", "cancelled", "unknown"]);

/** "12 min" or "1.5 h": roughly how long an upscale of this many seconds of clip takes. */
function upscaleTime(seconds: number, px: number, multiplier: number): string {
  const size = MUSIC_VIDEO_UPSCALE_SIZES.find((option) => option.px === px) ?? MUSIC_VIDEO_UPSCALE_SIZES[0];
  const rate =
    MUSIC_VIDEO_FRAME_RATES.find((option) => option.multiplier === multiplier) ?? MUSIC_VIDEO_FRAME_RATES[0];
  const hours = (seconds * size.secondsPerSecond * rate.timeFactor[size.px]) / 3600;
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${hours.toFixed(1)} h`;
}

function JoinedVideo({ url, label, download }: { url: string; label?: string; download: string }) {
  return (
    <div className="mb-5">
      {label ? <p className="label-caps mb-1.5 text-fg-muted">{label}</p> : null}
      <video
        src={withToken(url)}
        controls
        playsInline
        preload="metadata"
        className="mx-auto block max-h-[75vh] w-full rounded-lg border border-border-default bg-black object-contain"
      />
      <div className="mt-2 flex gap-2">
        <a href={withToken(url)} download={download} className={buttonClasses({ variant: "secondary", size: "sm" })}>
          Download
        </a>
      </div>
    </div>
  );
}

export function LongSwapPanel({ swap }: { swap: LongSwapController }) {
  const { project, states, segmentJobs, joinJob, upscaleJobs, upscaledJoinJob } = swap;
  const [chosenSize, setChosenSize] = useState<number>(MUSIC_VIDEO_UPSCALE_SIZES[0].px);
  /** The segment whose redo is being set up, if one is. */
  const [redoing, setRedoing] = useState<number | null>(null);
  const [chosenRate, setChosenRate] = useState<number>(MUSIC_VIDEO_FRAME_RATES[0].multiplier);
  /** Each segment's shorter side, by URL, read off its preview as it loads. */
  const [shorterSides, setShorterSides] = useState<Record<string, number>>({});
  if (!project) return null;

  const total = project.segments.length;
  const done = states.filter((state) => state === "done").length;
  const failed = states.some((state) => state === "failed");
  const active = states.some((state) => state === "queued" || state === "running");
  const joined = videoUrl(joinJob);
  const joining = joinJob !== undefined && (joinJob.phase === "queued" || joinJob.phase === "running");
  const joinFailed = joinJob !== undefined && ["error", "cancelled", "unknown"].includes(joinJob.phase);
  const stopped = Boolean(project.paused) || failed;
  const passed = (project.passedThrough ?? []).map((index) => index + 1);

  // The upscale: offered once the swap is joined, at a size that would make
  // the smallest segment bigger — Upscale scales a larger source down.
  const upscaled = videoUrl(upscaledJoinJob);
  const upscalesDone = upscaleJobs.filter((job) => job?.phase === "done").length;
  const upscaleRemaining = upscaleJobs.filter((job) => !job || FAILED_PHASES.has(job.phase)).length;
  const upscaling = upscaleJobs.some((job) => job && (job.phase === "queued" || job.phase === "running"));
  const upscaledJoining =
    upscaledJoinJob !== undefined && (upscaledJoinJob.phase === "queued" || upscaledJoinJob.phase === "running");
  const measured = segmentJobs
    .map((job) => videoUrl(job))
    .flatMap((url) => (url && shorterSides[url] !== undefined ? [shorterSides[url]] : []));
  const smallestSide = measured.length > 0 ? Math.min(...measured) : undefined;
  const enlarges = (px: number) => smallestSide === undefined || px > smallestSide;
  const offered = MUSIC_VIDEO_UPSCALE_SIZES.filter(({ px }) => enlarges(px));
  const upscaleSize = project.upscaleSize ?? (enlarges(chosenSize) ? chosenSize : (offered[0]?.px ?? chosenSize));
  const upscaleRate = project.upscaleFrameRate ?? chosenRate;
  const measure = (url: string, element: HTMLVideoElement) => {
    const side = Math.min(element.videoWidth, element.videoHeight);
    if (side > 0 && shorterSides[url] !== side) setShorterSides((current) => ({ ...current, [url]: side }));
  };
  // Redo waits for the chain and any join to settle, so one is never sent
  // underneath a segment still carrying on from the take it replaces.
  const canRedo = !active && !joining && !upscaling && !upscaledJoining && !swap.sending;
  const showUpscale = Boolean(joined) && swap.canUpscale && !upscaling && !upscaledJoining && !upscaled;

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

      {passed.length > 0 ? (
        <p className="mb-4 rounded-lg border border-warning/40 bg-warning/5 p-3 text-[13px] leading-relaxed text-fg" role="status">
          SAM found no one to replace in segment{passed.length > 1 ? "s" : ""} {passed.join(", ")}, so{" "}
          {passed.length > 1 ? "those stretches use" : "that stretch uses"} the clip&rsquo;s own footage. The swap starts
          fresh from the picture after {passed.length > 1 ? "each" : "it"}.
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
          <Button size="sm" onClick={() => void swap.join()} loading={swap.sending}>
            {joinFailed ? "Join again" : "Join"}
          </Button>
        ) : null}
      </div>

      {joining ? (
        <p className="mb-4 flex items-center gap-2 text-[13px] text-fg-muted" role="status">
          <LoaderCircle {...icon} className="size-3.5 shrink-0 stroke-2 motion-safe:animate-spin" />
          {joinJob?.phase === "queued"
            ? `Join queued${joinJob.queuePosition ? `, ${joinJob.queuePosition} ahead` : ""}…`
            : "Joining the segments…"}
        </p>
      ) : null}

      {upscaled ? (
        <JoinedVideo url={upscaled} label="Upscaled" download="character-swap-upscaled.mp4" />
      ) : null}
      {joined ? (
        <JoinedVideo url={joined} label={upscaled ? "Original" : undefined} download="character-swap.mp4" />
      ) : null}

      {showUpscale ? (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {!project.upscaleSize && offered.length === 0 ? (
            <span className="text-[12px] text-fg-subtle">
              Already {smallestSide} px on its shorter side, so upscaling would not make it any bigger.
            </span>
          ) : upscaleRemaining === 0 ? (
            <Button
              size="sm"
              onClick={() => void swap.joinUpscaled()}
              loading={swap.sending}
              title="Every segment is upscaled. Joins them into the upscaled video again, after the last try failed."
            >
              Join the upscaled segments
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => void swap.upscaleAll(upscaleSize, upscaleRate)}
                loading={swap.sending}
                title={`Upscales every segment to ${upscaleSize} px${upscaleRate > 1 ? ` at ${24 * upscaleRate} fps` : ""} with RTX Video, then joins them into a second video. Roughly ${upscaleTime(project.seconds, upscaleSize, upscaleRate)} for this clip.`}
              >
                {upscaleRemaining < upscaleJobs.length ? `Upscale the ${upscaleRemaining} remaining` : "Upscale the video"}
              </Button>
              {project.upscaleSize ? (
                <span className="text-[12px] text-fg-subtle">
                  at {project.upscaleSize} px{upscaleRate > 1 ? `, ${24 * upscaleRate} fps` : ""}, like the rest
                </span>
              ) : (
                <>
                  <Segmented
                    label="Upscale size"
                    value={upscaleSize}
                    onChange={setChosenSize}
                    options={MUSIC_VIDEO_UPSCALE_SIZES.map(({ px }) => ({
                      value: px,
                      disabled: !enlarges(px),
                      title: enlarges(px) ? undefined : `The segments are already ${smallestSide} px on their shorter side`,
                      label: (
                        <>
                          {px === 2160 ? "4K" : `${px} px`}
                          <span className="ml-1.5 font-normal text-fg-subtle">
                            ~{upscaleTime(project.seconds, px, upscaleRate)}
                          </span>
                        </>
                      ),
                    }))}
                  />
                  <Segmented
                    label="Upscale frame rate"
                    value={upscaleRate}
                    onChange={setChosenRate}
                    options={MUSIC_VIDEO_FRAME_RATES.map(({ multiplier, label }) => ({
                      value: multiplier,
                      label,
                      title:
                        multiplier > 1
                          ? "Makes a new frame between every pair with RIFE, for smoother motion. The sound is unchanged."
                          : "Keeps the swap's own frames.",
                    }))}
                  />
                </>
              )}
            </>
          )}
        </div>
      ) : null}

      {upscaling || upscaledJoining ? (
        <p className="mb-4 flex items-center gap-2 text-[13px] text-fg-muted" role="status">
          <Spinner className="size-3.5" />
          {upscaledJoining
            ? "Joining the upscaled segments…"
            : `Upscaling: ${upscalesDone} of ${upscaleJobs.length} segments`}
        </p>
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
                  onLoadedMetadata={(event) => measure(url, event.currentTarget)}
                  className="aspect-video max-h-40 w-full rounded bg-black object-contain"
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-1">
                <SegmentBadge
                  state={states[index]}
                  job={job}
                  original={project.passedThrough?.includes(index) ?? false}
                />
                {states[index] === "done" && canRedo ? (
                  <Button
                    variant="quiet"
                    size="xs"
                    className="ml-auto"
                    onClick={() => setRedoing(redoing === index ? null : index)}
                    aria-expanded={redoing === index}
                    aria-label={`Redo segment ${index + 1}`}
                    title={`Swap segment ${index + 1} again with a new seed — and choose who it follows.`}
                  >
                    <RotateCcw {...icon} /> Redo
                  </Button>
                ) : null}
                {index > 0 && startsFresh(project, index) && !project.passedThrough?.includes(index) ? (
                  <span
                    className="text-[11px] text-fg-subtle"
                    title="Swapped from the clip and the picture alone, without carrying on from the segment before, to reset drift."
                  >
                    fresh start
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {redoing !== null && redoing < total && canRedo && states[redoing] === "done" ? (
        <RedoEditor
          key={redoing}
          swap={swap}
          index={redoing}
          onDone={() => setRedoing(null)}
        />
      ) : null}
    </Panel>
  );
}
