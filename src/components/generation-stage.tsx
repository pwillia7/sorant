"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Badge, Dot } from "@/components/ui/panel";
import { Button, buttonClasses } from "@/components/ui/button";
import { withToken } from "@/lib/client";
import {
  clockMs,
  formatDuration,
  isAudioOnly,
  isImageOnly,
  isFavorite,
  type Job,
} from "@/lib/jobs";
import { RerunIcon } from "@/components/ui/rerun-icon";
import { StarIcon } from "@/components/ui/star-icon";
import type { ClipAction, ClipHandoff } from "@/lib/workflows/types";

/**
 * The canvas: whichever generation is being viewed. Progress while it runs,
 * the video once it lands, or the reason it did not.
 */
export function GenerationStage({
  job,
  now,
  estimateSeconds,
  onCancel,
  onReuseSeed,
  clipActions,
  onClipAction,
  onShowSettings,
  onToggleFavorite,
  onRetry,
  onRerun,
  retrying,
  busyAction = null,
}: {
  job: Job | null;
  /** Ticking clock, so the elapsed timer advances between poll results. */
  now: number;
  /** Learned from this device's history; falls back to the workflow's guess. */
  estimateSeconds: number | null;
  onCancel: (promptId: string) => void;
  onReuseSeed?: (seed: number) => void;
  /**
   * Which hand-offs a registered workflow actually offers, in the order they
   * should appear. Empty when none does, which is what removes the buttons.
   */
  clipActions?: readonly ClipHandoff[];
  onClipAction?: (job: Job, action: ClipAction) => void;
  /** Opens the record of what this generation was run with. */
  onShowSettings?: () => void;
  /**
   * Run a failed generation again as it was. Absent where there is nothing to
   * run it with — a workflow since unregistered — which is what takes the
   * button off rather than leaving one that cannot work.
   */
  onRetry?: (job: Job) => void;
  /**
   * Run a finished generation again: its settings back in the form, a new
   * seed, submitted. Absent on the same grounds as `onRetry`.
   */
  onRerun?: (job: Job) => void;
  /** A submission is in flight, so the retry waits rather than doubling it. */
  retrying?: boolean;
  /**
   * Marks this result as one to keep. Offered here as well as on the history
   * row because the moment to decide is usually the moment it lands, and that
   * is what the stage is showing.
   */
  onToggleFavorite?: (promptId: string) => void;
  /** The hand-off whose copy into ComfyUI's input directory is in flight. */
  busyAction?: ClipAction | null;
}) {
  return (
    <div className="flex min-h-[320px] flex-col sm:min-h-[420px]">
      {!job ? (
        <Empty />
      ) : job.phase === "done" && job.outputs.length > 0 ? (
        <Result
          job={job}
          onReuseSeed={onReuseSeed}
          clipActions={clipActions}
          onClipAction={onClipAction}
          onShowSettings={onShowSettings}
          onToggleFavorite={onToggleFavorite}
          onRerun={onRerun ? () => onRerun(job) : undefined}
          rerunning={retrying}
          busyAction={busyAction}
        />
      ) : job.phase === "error" ? (
        <Failure
          job={job}
          onShowSettings={onShowSettings}
          onRetry={onRetry ? () => onRetry(job) : undefined}
          retrying={retrying}
        />
      ) : job.phase === "queued" || job.phase === "running" ? (
        <InFlight
          job={job}
          now={now}
          estimateSeconds={estimateSeconds}
          onCancel={onCancel}
        />
      ) : (
        /*
          Everything else, named or not.
          
          This used to be the other way round — in-flight was the fallback, and
          any state the branches above did not name was drawn as a run still
          going: "Generating", a progress curve, a live timer counting from
          whenever it was submitted, and a Cancel button for a job nothing was
          working on. A `done` whose outputs are empty lands exactly there, and
          nothing ever reaps it: `expireStale` only reconsiders a job that is
          queued or running, so it sat at "Generating" for as long as the
          history kept it. One had been counting for twenty-four hours.

          A run is only in flight while something says it is. Anything else is
          over, whatever it is, and Closed says so.
        */
        <Closed job={job} />
      )}
    </div>
  );
}

function Frame({
  children,
  dashed = false,
}: {
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-4 rounded-xl
        bg-bg-subtle p-6 text-center sm:p-8 ${
          dashed
            ? "border border-dashed border-border-strong"
            : "border border-border-default"
        }`}
    >
      {children}
    </div>
  );
}

function Empty() {
  return (
    <Frame dashed>
      <svg
        viewBox="0 0 24 24"
        className="size-8 text-fg-subtle"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="2.5"
          y="5.5"
          width="19"
          height="13"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path
          d="M10 9.5l4.5 2.5L10 14.5v-5Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      <div>
        <p className="text-sm font-medium text-fg">Nothing generated yet</p>
        <p className="mx-auto mt-1 max-w-xs text-[13px] leading-relaxed text-fg-subtle">
          Pick a workflow, write a prompt, and generate. You can queue more than
          one — they run in order.
        </p>
      </div>
    </Frame>
  );
}

const PHASE_COPY: Record<string, { label: string; detail: string }> = {
  queued: { label: "Queued", detail: "Waiting for the GPU to free up." },
  running: { label: "Generating", detail: "Sampling frames. This is the slow part." },
};

function InFlight({
  job,
  now,
  estimateSeconds,
  onCancel,
}: {
  job: Job;
  now: number;
  estimateSeconds: number | null;
  onCancel: (promptId: string) => void;
}) {
  // Only queued and running reach here now, so the lookup cannot miss — but a
  // fallback that says "Generating" about an unknown state is how the branch
  // above went wrong, so this one names what it actually has.
  const copy =
    // The music video's planning run writes text and samples nothing.
    job.workflowId === "music-video" && job.phase === "running"
      ? { label: "Planning", detail: "Writing a scene for every cut in the song." }
      : job.workflowId === "multi-scene" && job.phase === "running"
        ? { label: "Planning", detail: "Writing the story out scene by scene." }
        : (PHASE_COPY[job.phase] ?? PHASE_COPY.queued);
  // Waiting time while it waits, render time once it renders — the clock
  // restarts at the seam rather than running on from submit. See `clockMs`.
  const elapsedMs = clockMs(job, now);

  // Progress is measured from when rendering began, not when the job was
  // accepted — otherwise time spent queued behind other jobs would show up as
  // progress that has not happened.
  const renderingMs = job.startedAt ? now - job.startedAt : 0;
  const renderingSeconds = renderingMs / 1000;

  // ComfyUI publishes no step-level progress over HTTP, so this is a curve
  // against the expected duration. It eases toward 95% and never claims to be
  // finished, because it does not actually know.
  const fraction =
    job.startedAt && estimateSeconds
      ? Math.min(0.95, 1 - Math.exp(-renderingSeconds / (estimateSeconds * 0.55)))
      : null;

  const remainingSeconds =
    job.startedAt && estimateSeconds
      ? Math.max(0, Math.round(estimateSeconds - renderingSeconds))
      : null;

  return (
    <Frame>
      <div className="w-full max-w-sm">
        <div className="mb-3 flex items-center justify-center gap-2">
          <Dot tone="accent" pulse />
          <span className="text-sm font-medium text-fg">{copy.label}</span>
          <span className="font-mono text-[13px] tabular-nums text-fg-muted">
            {elapsedMs === null ? "" : formatDuration(elapsedMs)}
          </span>
        </div>

        <div className="relative h-1 w-full overflow-hidden rounded-full bg-track">
          {fraction === null ? (
            <div className="sweep absolute inset-0" />
          ) : (
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
              style={{ width: `${fraction * 100}%` }}
            />
          )}
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-fg-subtle">
          {job.queuePosition !== null && job.queuePosition > 0
            ? `${job.queuePosition} job${job.queuePosition === 1 ? "" : "s"} ahead of this one.`
            : copy.detail}
        </p>

        {remainingSeconds !== null ? (
          <p className="mt-1 text-[12px] text-fg-subtle">
            {remainingSeconds > 0
              ? `About ${formatDuration(remainingSeconds * 1000)} left, going on previous runs.`
              : "Taking longer than previous runs."}
          </p>
        ) : null}

        <div className="mt-5">
          <Button size="sm" variant="danger" onClick={() => onCancel(job.promptId)}>
            Cancel
          </Button>
        </div>
      </div>
    </Frame>
  );
}

function Failure({
  job,
  onShowSettings,
  onRetry,
  retrying,
}: {
  job: Job;
  onShowSettings?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <Frame>
      <div className="w-full max-w-md">
        <div className="mb-3 flex items-center justify-center gap-2">
          <Dot tone="danger" />
          <span className="text-sm font-medium text-fg">Generation failed</span>
        </div>
        <p className="text-[13px] leading-relaxed text-fg-muted">{job.error}</p>
        {/* The two things worth reaching from here, and in this order: run it
            again, since a good share of failures are the box rather than the
            run; and what it was run with, which is the first question when it
            was not. The history row offers the same retry, but this is the
            screen a failure lands you on, and sending someone back to the list
            to press the button they are looking at is not offering it. */}
        {onRetry || onShowSettings ? (
          <div className="mt-5 flex items-center justify-center gap-2">
            {onRetry ? (
              <Button size="sm" onClick={onRetry} disabled={retrying}>
                {retrying ? "Submitting…" : "Try again"}
              </Button>
            ) : null}
            {onShowSettings ? (
              <Button size="sm" variant="quiet" onClick={onShowSettings}>
                View settings
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Frame>
  );
}

function Closed({ job }: { job: Job }) {
  // `done` reaching here means the run finished and left nothing behind — the
  // branch above takes every done job that has an output. Worth its own words:
  // "no longer tracked" would be wrong about a job ComfyUI finished, and
  // silence would leave the panel looking broken.
  const empty = job.phase === "done";
  return (
    <Frame dashed>
      <div className="flex items-center gap-2">
        <Dot tone="warning" />
        <span className="text-sm font-medium text-fg">
          {job.phase === "cancelled"
            ? "Cancelled"
            : empty
              ? "Nothing came back"
              : "No longer tracked"}
        </span>
      </div>
      {job.phase === "unknown" ? (
        <p className="mx-auto max-w-xs text-[13px] leading-relaxed text-fg-subtle">
          ComfyUI no longer has a record of this job. It was probably restarted
          since.
        </p>
      ) : null}
      {empty ? (
        <p className="mx-auto max-w-xs text-[13px] leading-relaxed text-fg-subtle">
          The run finished without saving a file. If the output directory has
          been cleared since, that is where it went.
        </p>
      ) : null}
    </Frame>
  );
}

/**
 * What can be fed back into another workflow as a clip. A still goes to the
 * hand-offs that take one — see `isImageOnly` — and never to these.
 *
 * There is no audio twin of this: `isAudioOnly` already answers that question
 * off the same filename, and two lists of extensions that had to agree would
 * eventually stop agreeing.
 */
const REUSABLE_VIDEO = /\.(mp4|webm|mkv|mov|m4v)$/i;


/**
 * The label and icon for each hand-off. Keyed by action so the buttons are
 * rendered from whatever the registry offers rather than written out one by
 * one — registering a workflow for a new action is all it takes to get one.
 */
const CLIP_BUTTONS: Record<
  ClipAction,
  { label: string; title: string; icon: React.ReactNode }
> = {
  remix: {
    label: "Remix",
    title: "Rebuild this clip into a new take",
    icon: (
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
        <path
          d="M10 2.5l2 2-2 2M6 13.5l-2-2 2-2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 4.5H6a2.5 2.5 0 0 0-2.5 2.5M4 11.5h6A2.5 2.5 0 0 0 12.5 9"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  extend: {
    label: "Extend",
    title: "Carry on from where this clip ends",
    icon: (
      // The clip, then the seam it continues past.
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
        <rect
          x="2"
          y="4"
          width="6"
          height="8"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M9.5 8h4M12 6l2 2-2 2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  upscale: {
    label: "Upscale",
    title: "Make this clip larger and sharper",
    icon: (
      // A small frame, and the corner it is pulled out to.
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
        <rect
          x="2"
          y="8"
          width="6"
          height="6"
          rx="1.2"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M9 7l4.5-4.5M10 2.5h3.5V6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  musicvideo: {
    label: "Music video",
    title: "Make a whole music video to this track, scene by scene",
    icon: (
      // A strip of three frames.
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
        <rect x="1.5" y="4" width="13" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6 4v8M10 4v8" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  animate: {
    label: "Animate",
    title: "Make a video that starts on this picture",
    icon: (
      // A frame, and the play mark it is set going by.
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6.5 6v4l3.5-2-3.5-2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    ),
  },
  illustrate: {
    label: "Create video",
    title: "Build a video around this track",
    icon: (
      // A note, and the frame it is being carried into.
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
        <path
          d="M5.5 10V3.5l4-.75V9"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="4.25" cy="10.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
        <rect
          x="8.5"
          y="8.5"
          width="6"
          height="5"
          rx="1.2"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
    ),
  },
};

function Result({
  job,
  onReuseSeed,
  clipActions,
  onClipAction,
  onShowSettings,
  onToggleFavorite,
  onRerun,
  rerunning,
  busyAction,
}: {
  job: Job;
  onReuseSeed?: (seed: number) => void;
  clipActions?: readonly ClipHandoff[];
  onClipAction?: (job: Job, action: ClipAction) => void;
  onShowSettings?: () => void;
  onToggleFavorite?: (promptId: string) => void;
  onRerun?: () => void;
  rerunning?: boolean;
  busyAction?: ClipAction | null;
}) {
  const [primary, ...rest] = job.outputs;
  const seed = job.resolved?.seed;
  const src = withToken(primary.url);
  /**
   * Which hand-offs this particular result can go to.
   *
   * The kind decides *which* buttons appear, not merely whether any do: a
   * finished video is something to remix or extend, a finished track is
   * something to build a video around, and offering either set on the other
   * would send a file to a loader that cannot read it. Asked of the file rather
   * than of the workflow, on the same grounds as `isAudioOnly` — the file is
   * what has to be readable at the other end.
   */
  const offered = onClipAction
    ? (clipActions ?? []).filter(({ accepts }) =>
        accepts === "audio"
          ? isAudioOnly(job)
          : accepts === "image"
            ? isImageOnly(job)
            : REUSABLE_VIDEO.test(primary.filename),
      )
    : [];
  const favorite = isFavorite(job);
  const took =
    job.completedAt !== undefined
      ? formatDuration(job.completedAt - job.submittedAt)
      : null;

  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const compact = useCompactRow(rowRef, measureRef);

  /**
   * The result's buttons, labelled or as icons alone. Icons alone keep their
   * label for screen readers and as a tooltip, so nothing is lost but width.
   */
  const actions = (iconsOnly: boolean) => {
    const size = iconsOnly ? "icon-sm" : "sm";
    const label = (text: string) => (
      <span className={iconsOnly ? "sr-only" : undefined}>{text}</span>
    );
    return (
      <>
        {onToggleFavorite ? (
          <Button
            size={size}
            // The colour rides on the icon rather than on the button, because
            // an accent utility in `className` and the variant's own text
            // colour are the same specificity — which one won would come down
            // to the order Tailwind happened to emit them in.
            variant={favorite ? "secondary" : "quiet"}
            onClick={() => onToggleFavorite(job.promptId)}
            aria-pressed={favorite}
            title={
              favorite
                ? "Remove from favorites"
                : "Keep this at the top of the history"
            }
            className="shrink-0"
            icon={
              <StarIcon
                filled={favorite}
                className={`size-3.5 ${favorite ? "text-accent" : ""}`}
              />
            }
          >
            {label(favorite ? "Favorited" : "Favorite")}
          </Button>
        ) : null}
        {onShowSettings ? (
          <Button
            size={size}
            variant="quiet"
            onClick={onShowSettings}
            title="What this was run with"
            className="shrink-0"
            icon={<SettingsIcon />}
          >
            {label("Settings")}
          </Button>
        ) : null}
        {typeof seed === "number" && onReuseSeed ? (
          <Button
            size={size}
            variant="quiet"
            onClick={() => onReuseSeed(seed)}
            title="Put this seed in the form, to get this take again"
            className="shrink-0"
            icon={<SeedIcon />}
          >
            {label("Reuse seed")}
          </Button>
        ) : null}
        {onRerun ? (
          <Button
            size={size}
            variant="secondary"
            onClick={onRerun}
            disabled={rerunning}
            title="Load these settings and run them again with a new seed"
            className="shrink-0"
            icon={<RerunIcon className="size-3.5" />}
          >
            {label("Rerun")}
          </Button>
        ) : null}
        {offered.map(({ action }) => {
          const button = CLIP_BUTTONS[action];
          return (
            <Button
              key={action}
              size={size}
              variant="secondary"
              loading={busyAction === action}
              // One copy at a time: both buttons move the same bytes out of
              // ComfyUI's output directory, and the second would land on a
              // form the first is still filling in.
              disabled={busyAction !== null && busyAction !== action}
              onClick={() => onClipAction?.(job, action)}
              title={button.title}
              className="shrink-0"
              icon={button.icon}
            >
              {label(button.label)}
            </Button>
          );
        })}
        {/* An anchor, not a button: `download` is what saves the file, and
            there is no way to keep that on a <button>. Borrowing the button
            recipe keeps it from drifting out of step with the row. */}
        <a
          href={src}
          download={primary.filename}
          title="Download"
          className={buttonClasses({
            variant: "secondary",
            size,
            className: "shrink-0",
          })}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
            <path
              d="M8 2v8m0 0L5 7m3 3l3-3M3 13h10"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          {label("Download")}
        </a>
      </>
    );
  };

  return (
    <div className="flex flex-1 flex-col gap-3">
      {isAudioOnly(job) ? (
        // A player and the filename, on the panel's own background rather than
        // the black a video sits on — there is nothing to letterbox.
        <div
          className="flex flex-col gap-3 rounded-xl border border-border-default
            bg-bg-subtle p-4"
        >
          <p className="truncate font-mono text-[12px] text-fg-muted">
            {primary.filename}
          </p>
          <audio key={src} src={src} controls className="w-full" />
        </div>
      ) : isImageOnly(job) ? (
        <div className="overflow-hidden rounded-xl border border-border-default bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={src}
            src={src}
            alt={job.prompt.trim() || job.workflowName}
            className="mx-auto block max-h-[60vh] w-auto max-w-full bg-black object-contain"
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border-default bg-black">
          {/*
            Silent workflows autoplay on a loop, which is the nicer preview.
            Audio workflows must not: autoplay is only allowed while muted, so
            looping it muted would hide the soundtrack entirely.
          */}
          <video
            key={src}
            src={src}
            controls
            autoPlay={!job.hasAudio}
            loop={!job.hasAudio}
            muted={!job.hasAudio}
            playsInline
            className="block max-h-[60vh] w-full bg-black"
          />
        </div>
      )}

      {/* The badges and the buttons share a line while they fit, and the
          buttons drop beneath as a whole when they do not — never one button
          at a time. See `useCompactRow` for how the buttons themselves stay on
          one line. */}
      <div ref={rowRef} className="relative flex flex-wrap items-center gap-2">
        <Badge tone="success">
          <Dot tone="success" /> Done
        </Badge>
        {took ? <Badge mono>{took}</Badge> : null}
        {typeof seed === "number" ? <Badge mono>seed {seed}</Badge> : null}

        <div
          className={`ml-auto flex max-w-full items-center overflow-x-auto
            ${compact ? "gap-1.5" : "gap-2"}`}
        >
          {actions(compact)}
        </div>

        {/* The same buttons with their labels, laid out but never seen or
            reached, so there is always a width to compare against — the row
            on screen cannot say how wide its labels would be while it is
            showing icons. */}
        <div
          inert
          aria-hidden="true"
          // Clipped to nothing, so its width can never widen the page.
          className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
        >
          <div ref={measureRef} className="flex w-max items-center gap-2">
            {actions(false)}
          </div>
        </div>
      </div>

      {rest.length > 0 ? (
        <p className="text-[12px] text-fg-subtle">
          Also produced{" "}
          {rest.map((file, index) => (
            <span key={file.url}>
              {index > 0 ? ", " : ""}
              <a
                href={withToken(file.url)}
                download={file.filename}
                className="font-mono text-accent hover:underline"
              >
                {file.filename}
              </a>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether the result's buttons have to drop their labels to stay on one line.
 *
 * Measured rather than set at a breakpoint: how many buttons there are depends
 * on the result (a track has no Remix, a video has three hand-offs), and the
 * stage's width depends on the window and the column beside it, so no single
 * width is right. The labelled set is laid out off-screen for the comparison;
 * it fits if it is no wider than the row it would sit in, on a line of its own.
 *
 * A layout effect and a ResizeObserver both settle before paint, so the row is
 * never seen wrapped and then corrected.
 */
function useCompactRow(
  rowRef: RefObject<HTMLDivElement | null>,
  measureRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const check = () => setCompact(measure.scrollWidth > row.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    // The labelled set changes width on its own too — "Favorite" becomes
    // "Favorited", a hand-off gains a spinner.
    observer.observe(measure);
    return () => observer.disconnect();
  }, [rowRef, measureRef]);
  return compact;
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="10" cy="4.5" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="11.5" r="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** A sprout — the seed, grown into the take it made. */
function SeedIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M8 14V8M8 8C8 5 6 3.5 3 3.5c0 3 2 4.5 5 4.5ZM8 9.5c0-2.5 1.8-4 4.5-4 0 2.5-1.8 4-4.5 4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
