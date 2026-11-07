"use client";

import {
  Disc3,
  Download,
  Drama,
  FastForward,
  Film,
  ImagePlay,
  RotateCcw,
  Scaling,
  Shuffle,
  SlidersHorizontal,
  Sprout,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { StarIcon } from "@/components/ui/star-icon";
import type { ClipAction, ClipHandoff } from "@/lib/workflows/types";
import type { RecheckStatus } from "@/lib/jobs";

/**
 * The monitor: whichever generation is being viewed, on a screen that stays
 * dark in both themes, because a picture is judged against black.
 *
 * The screen only ever shows state — the picture, the run clock, the reason
 * something stopped. Everything that can be pressed sits on the bar beneath
 * it, in the page's own colours, so a control never has to be legible on two
 * backgrounds and its place does not move between states.
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
  onCheckAgain,
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
  onShowSettings?: () => void;
  /** Run a failed generation again, exactly as it was. */
  onRetry?: (job: Job) => void;
  /** Ask ComfyUI again about a run this device lost track of. */
  onCheckAgain?: () => Promise<Record<string, RecheckStatus> | null>;
  /** Another take of a finished generation: its settings, a new seed. */
  onRerun?: (job: Job) => void;
  retrying?: boolean;
  onToggleFavorite?: (promptId: string) => void;
  /** The hand-off whose copy is in flight, if any. */
  busyAction?: ClipAction | null;
}) {
  if (!job) return <Idle />;

  if (job.phase === "done" && job.outputs.length > 0) {
    return (
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
    );
  }

  if (job.phase === "error") {
    return (
      <Failure
        job={job}
        onShowSettings={onShowSettings}
        onRetry={onRetry ? () => onRetry(job) : undefined}
        onCheckAgain={onCheckAgain}
        retrying={retrying}
      />
    );
  }

  if (job.phase === "queued" || job.phase === "running") {
    return (
      <InFlight
        job={job}
        now={now}
        estimateSeconds={estimateSeconds}
        onCancel={onCancel}
      />
    );
  }

  /*
    Everything else, named or not. A run is only in flight while something
    says it is: a `done` with no outputs, a cancel, a run ComfyUI forgot — all
    of these are over, and drawing them as "Generating" with a live clock left
    one counting for a day.
  */
  return <Closed job={job} onCheckAgain={onCheckAgain} />;
}

/** The dark screen every state is drawn on. */
function Screen({
  children,
  tally,
  clock,
  footer,
  idle = false,
}: {
  children: ReactNode;
  /** Top-left: what the screen is showing, with its lamp. */
  tally?: ReactNode;
  /** Top-right: a time, set in the mono face. */
  clock?: ReactNode;
  /** Pinned to the screen's lower edge — the progress line. */
  footer?: ReactNode;
  idle?: boolean;
}) {
  return (
    <div
      className={`relative flex aspect-video max-h-[62vh] min-h-[220px] w-full flex-col overflow-hidden
        rounded-lg border border-black/40 text-screen-fg shadow-md
        ${idle ? "screen-idle" : "bg-screen"}`}
    >
      {tally || clock ? (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2">{tally}</span>
          <span className="font-mono text-[12px] tabular-nums text-screen-muted">{clock}</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center sm:p-10">
        {children}
      </div>
      {footer}
    </div>
  );
}

/** A lamp and a word: the screen's own status, top-left. */
function Tally({ tone, pulse = false, children }: {
  tone: "live" | "idle" | "fault" | "warn";
  pulse?: boolean;
  children: ReactNode;
}) {
  const lamp = {
    live: "bg-accent shadow-[0_0_10px_var(--accent)]",
    idle: "bg-screen-muted",
    fault: "bg-[#ff6b62] shadow-[0_0_10px_#ff6b62]",
    warn: "bg-[#e9c55a]",
  }[tone];
  return (
    <>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${lamp} ${pulse ? "breathe" : ""}`} />
      <span className="label-caps text-screen-fg">{children}</span>
    </>
  );
}

/** The strip under the screen. Every state's controls live here. */
function Transport({ children, meta }: { children?: ReactNode; meta?: ReactNode }) {
  if (!children && !meta) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
      {meta ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{meta}</div> : null}
      {children ? <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div> : null}
    </div>
  );
}

/** A label and a value in the transport's meta line. */
function Readout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="label-caps text-fg-subtle">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-fg">{children}</span>
    </span>
  );
}

/** hh:mm:ss, the way a deck counts. */
function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function Idle() {
  return (
    <div className="flex flex-col">
      <Screen idle tally={<Tally tone="idle">Standby</Tally>}>
        <Film className="size-7 stroke-[1.25] text-screen-muted" aria-hidden="true" />
        <p className="mt-4 text-[15px] font-medium text-screen-fg">Nothing generated yet</p>
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-screen-muted">
          Write a prompt and generate. Queue as many as you like — they run in order
          on your machine, and keep running if you close the tab.
        </p>
      </Screen>
    </div>
  );
}

const PHASE_COPY: Record<string, { label: string; detail: string }> = {
  queued: { label: "Queued", detail: "Waiting for the GPU to free up." },
  running: { label: "Generating", detail: "Sampling frames. This is the slow part." },
};

/**
 * In progress. The clock counts from when it was submitted while queued and
 * from when the GPU started once it runs — the same number the library shows.
 * The bar is an estimate from previous runs, so it eases towards 95% rather
 * than claiming to know when it finishes, and sweeps when there is nothing to
 * go on.
 */
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
  const copy =
    job.workflowId === "music-video" && job.phase === "running"
      ? { label: "Planning", detail: "Writing a scene for every cut in the song." }
      : job.workflowId === "multi-scene" && job.phase === "running"
        ? { label: "Planning", detail: "Writing the story out scene by scene." }
        : (PHASE_COPY[job.phase] ?? PHASE_COPY.queued);

  const elapsedMs = clockMs(job, now);
  const renderingSeconds = job.startedAt ? (now - job.startedAt) / 1000 : 0;
  const fraction =
    job.startedAt && estimateSeconds
      ? Math.min(0.95, 1 - Math.exp(-renderingSeconds / (estimateSeconds * 0.55)))
      : null;
  const remainingSeconds =
    job.startedAt && estimateSeconds
      ? Math.max(0, Math.round(estimateSeconds - renderingSeconds))
      : null;

  return (
    <div className="flex flex-col">
      <Screen
        tally={
          <Tally tone={job.phase === "running" ? "live" : "idle"} pulse={job.phase === "running"}>
            {copy.label}
          </Tally>
        }
        clock={job.workflowName}
        footer={
          <div className="relative h-1 w-full overflow-hidden bg-white/10">
            {fraction === null ? (
              <div className="sweep absolute inset-0" />
            ) : (
              <div
                className="h-full bg-accent transition-[width] duration-500 ease-out"
                style={{ width: `${fraction * 100}%` }}
              />
            )}
          </div>
        }
      >
        <p
          className="display-tight font-mono text-[40px] font-medium leading-none tabular-nums text-screen-fg sm:text-[56px]"
          aria-label={elapsedMs === null ? undefined : `${formatDuration(elapsedMs)} elapsed`}
        >
          {elapsedMs === null ? "--:--:--" : timecode(elapsedMs)}
        </p>
        <p className="mt-4 max-w-sm text-[13px] leading-relaxed text-screen-muted" aria-live="polite">
          {job.queuePosition !== null && job.queuePosition > 0
            ? `${job.queuePosition} job${job.queuePosition === 1 ? "" : "s"} ahead of this one.`
            : copy.detail}
        </p>
        {job.prompt.trim() ? (
          <p className="mt-3 line-clamp-2 max-w-md text-[12px] italic leading-relaxed text-screen-muted/80">
            “{job.prompt.trim()}”
          </p>
        ) : null}
      </Screen>
      <Transport
        meta={
          remainingSeconds !== null ? (
            <span className="text-[12px] text-fg-muted">
              {remainingSeconds > 0
                ? `About ${formatDuration(remainingSeconds * 1000)} left, going on previous runs.`
                : "Taking longer than previous runs."}
            </span>
          ) : null
        }
      >
        <Button size="sm" variant="danger" onClick={() => onCancel(job.promptId)}>
          Cancel
        </Button>
      </Transport>
    </div>
  );
}

function Failure({
  job,
  onShowSettings,
  onRetry,
  onCheckAgain,
  retrying,
}: {
  job: Job;
  onShowSettings?: () => void;
  onRetry?: () => void;
  onCheckAgain?: () => Promise<Record<string, RecheckStatus> | null>;
  retrying?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex flex-col">
      <Screen tally={<Tally tone="fault">Failed</Tally>} clock={job.workflowName}>
        <p className="text-[15px] font-medium text-screen-fg">This generation did not finish</p>
        <p className="mt-2 max-w-md whitespace-pre-line text-[13px] leading-relaxed text-screen-muted">
          {job.error}
        </p>
        {note ? <p className="mt-3 max-w-md text-[12px] text-screen-muted">{note}</p> : null}
      </Screen>
      {/* Retry first — a good share of failures are the box rather than the
          run — then what it ran with, the first question when it was not. A
          run this device lost contact with is asked about before either, since
          it usually finished and Try again would render it from scratch. */}
      <Transport>
        {onCheckAgain ? <CheckAgain job={job} onCheck={onCheckAgain} onNote={setNote} /> : null}
        {onShowSettings ? (
          <Button size="sm" variant="quiet" onClick={onShowSettings} icon={<SlidersHorizontal {...ICON} />}>
            View settings
          </Button>
        ) : null}
        {onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry} disabled={retrying} icon={<RotateCcw {...ICON} />}>
            {retrying ? "Submitting…" : "Try again"}
          </Button>
        ) : null}
      </Transport>
    </div>
  );
}

/**
 * Asks ComfyUI about a run this device stopped hearing from, and says what it
 * found when the answer changes nothing — the job itself updates the rest.
 */
function CheckAgain({
  job,
  onCheck,
  onNote,
}: {
  job: Job;
  onCheck: () => Promise<Record<string, RecheckStatus> | null>;
  onNote: (note: string | null) => void;
}) {
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    onNote(null);
    const statuses = await onCheck();
    setChecking(false);
    if (statuses === null) {
      onNote("Could not reach ComfyUI. Check the connection and try again.");
    } else if (!statuses[job.promptId] || statuses[job.promptId].state === "unknown") {
      onNote("ComfyUI has no record of this run — it was probably restarted since.");
    }
  };

  return (
    <Button size="sm" variant="primary" onClick={() => void check()} disabled={checking}>
      {checking ? "Checking…" : "Check again"}
    </Button>
  );
}

function Closed({
  job,
  onCheckAgain,
}: {
  job: Job;
  onCheckAgain?: () => Promise<Record<string, RecheckStatus> | null>;
}) {
  const [note, setNote] = useState<string | null>(null);
  const empty = job.phase === "done";
  return (
    <div className="flex flex-col">
      <Screen
        tally={
          <Tally tone="warn">
            {job.phase === "cancelled" ? "Cancelled" : empty ? "No output" : "Lost"}
          </Tally>
        }
        clock={job.workflowName}
      >
        <p className="text-[15px] font-medium text-screen-fg">
          {job.phase === "cancelled"
            ? "Cancelled"
            : empty
              ? "Nothing came back"
              : "No longer tracked"}
        </p>
        <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-screen-muted">
          {job.phase === "unknown"
            ? "ComfyUI no longer has a record of this job. It was probably restarted since."
            : empty
              ? "The run finished without saving a file. If the output directory has been cleared since, that is where it went."
              : "This run was stopped before it finished."}
        </p>
        {note ? <p className="mt-3 max-w-md text-[12px] text-screen-muted">{note}</p> : null}
      </Screen>
      {onCheckAgain ? (
        <Transport>
          <CheckAgain job={job} onCheck={onCheckAgain} onNote={setNote} />
        </Transport>
      ) : null}
    </div>
  );
}

/** Extensions a LoadVideo node will accept, so we only offer a hand-off that can work. */
const REUSABLE_VIDEO = /\.(mp4|webm|mkv|mov|m4v)$/i;

const ICON = { className: "size-3.5 shrink-0", "aria-hidden": true } as const;

const CLIP_BUTTONS: Record<ClipAction, { label: string; title: string; icon: ReactNode }> = {
  remix: { label: "Remix", title: "Rebuild this clip into a new take", icon: <Shuffle {...ICON} /> },
  swap: {
    label: "Swap",
    title: "Put a character from a picture in place of someone in this clip",
    icon: <Drama {...ICON} />,
  },
  extend: { label: "Extend", title: "Carry on from where this clip ends", icon: <FastForward {...ICON} /> },
  upscale: { label: "Upscale", title: "Make this clip larger and sharper", icon: <Scaling {...ICON} /> },
  musicvideo: {
    label: "Music video",
    title: "Make a whole music video to this track, scene by scene",
    icon: <Disc3 {...ICON} />,
  },
  animate: { label: "Animate", title: "Make a video that starts on this picture", icon: <ImagePlay {...ICON} /> },
  illustrate: { label: "Create video", title: "Build a video around this track", icon: <Film {...ICON} /> },
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
  const audio = isAudioOnly(job);
  const still = isImageOnly(job);

  // Each hand-off takes one kind of file: a clip's on a video, a track's on a
  // track, a picture's on a still. Read off the destination's declaration.
  const offered = onClipAction
    ? (clipActions ?? []).filter(({ accepts }) =>
        accepts === "audio" ? audio : accepts === "image" ? still : REUSABLE_VIDEO.test(primary.filename),
      )
    : [];

  const favorite = isFavorite(job);
  const took = job.completedAt !== undefined ? formatDuration(job.completedAt - job.submittedAt) : null;

  // The actions keep their labels while they fit and fall back to icons as a
  // set when they do not, measured against an invisible labelled copy.
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const compact = useCompactRow(rowRef, measureRef);

  const actions = (iconsOnly: boolean) => {
    const size = iconsOnly ? "icon-sm" : "sm";
    const label = (text: string) => <span className={iconsOnly ? "sr-only" : undefined}>{text}</span>;
    return (
      <>
        {onToggleFavorite ? (
          <Button
            size={size}
            variant="quiet"
            onClick={() => onToggleFavorite(job.promptId)}
            aria-pressed={favorite}
            title={favorite ? "Remove from favorites" : "Keep this at the top of the library"}
            className="shrink-0"
            icon={<StarIcon filled={favorite} className={`size-3.5 ${favorite ? "text-accent" : ""}`} />}
          >
            {label(favorite ? "Favorited" : "Favorite")}
          </Button>
        ) : null}
        {onShowSettings ? (
          <Button
            size={size}
            variant="quiet"
            onClick={onShowSettings}
            title="See what this was run with, and load it into the form"
            className="shrink-0"
            icon={<SlidersHorizontal {...ICON} />}
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
            icon={<Sprout {...ICON} />}
          >
            {label("Reuse seed")}
          </Button>
        ) : null}
        {onRerun ? (
          <Button
            size={size}
            variant="quiet"
            onClick={onRerun}
            disabled={rerunning}
            title="Load these settings and run them again with a new seed"
            className="shrink-0"
            icon={<RotateCcw {...ICON} />}
          >
            {label("Rerun")}
          </Button>
        ) : null}
        {/* An anchor: `download` is what saves the file. The one primary —
            keeping the file is what a finished result is for. */}
        <a
          href={src}
          download={primary.filename}
          title="Download"
          className={buttonClasses({ variant: "primary", size, className: "shrink-0" })}
        >
          <Download {...ICON} />
          {label("Download")}
        </a>
      </>
    );
  };

  return (
    <div className="flex flex-col">
      {audio ? (
        <Screen tally={<Tally tone="idle">Track</Tally>} clock={job.workflowName}>
          <Disc3 className="size-10 stroke-[1.25] text-screen-muted" aria-hidden="true" />
          {job.prompt.trim() ? (
            <p className="mt-4 line-clamp-3 max-w-md text-[13px] leading-relaxed text-screen-muted">
              {job.prompt.trim()}
            </p>
          ) : null}
          <audio key={src} src={src} controls className="mt-6 w-full max-w-lg" />
        </Screen>
      ) : (
        <div className="relative overflow-hidden rounded-lg border border-black/40 bg-screen shadow-md">
          {still ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={src}
              src={src}
              alt={job.prompt.trim() || job.workflowName}
              className="mx-auto block max-h-[62vh] w-auto max-w-full object-contain"
            />
          ) : (
            /*
              Silent workflows autoplay on a loop, which is the nicer preview.
              Audio workflows must not: autoplay is only allowed while muted,
              so looping it muted would hide the soundtrack entirely.
            */
            <video
              key={src}
              src={src}
              controls
              autoPlay={!job.hasAudio}
              loop={!job.hasAudio}
              muted={!job.hasAudio}
              playsInline
              className="block max-h-[62vh] w-full bg-screen"
            />
          )}
        </div>
      )}

      <div ref={rowRef} className="relative flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
            <span className="label-caps text-success">Done</span>
          </span>
          {took ? <Readout label="Took">{took}</Readout> : null}
          {typeof seed === "number" ? <Readout label="Seed">{seed}</Readout> : null}
        </div>
        <div className={`ml-auto flex max-w-full items-center overflow-x-auto ${compact ? "gap-1.5" : "gap-2"}`}>
          {actions(compact)}
        </div>
        <div
          inert
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
        >
          <div ref={measureRef} className="flex w-max items-center gap-2">
            {actions(false)}
          </div>
        </div>
      </div>

      {offered.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border-default bg-surface px-3 py-2.5">
          <span className="label-caps mr-1 text-fg-subtle">
            Next, from this {audio ? "track" : still ? "picture" : "clip"}
          </span>
          {offered.map(({ action }) => {
            const button = CLIP_BUTTONS[action];
            return (
              <Button
                key={action}
                size="sm"
                variant="secondary"
                loading={busyAction === action}
                disabled={busyAction !== null && busyAction !== action}
                onClick={() => onClipAction?.(job, action)}
                title={button.title}
                className="shrink-0"
                icon={button.icon}
              >
                {button.label}
              </Button>
            );
          })}
        </div>
      ) : null}

      {/* Upscale and similar leave secondary files beside the main one. */}
      {rest.length > 0 ? (
        <p className="mt-2 text-[12px] text-fg-subtle">
          Also produced{" "}
          {rest.map((file, index) => (
            <span key={file.url}>
              {index > 0 ? ", " : ""}
              <a href={withToken(file.url)} download={file.filename} className="font-mono text-accent hover:underline">
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
 * Whether the action buttons need to drop to icons: true once their labelled
 * width (measured off-screen) is wider than the row has to give.
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
    observer.observe(measure);
    return () => observer.disconnect();
  }, [rowRef, measureRef]);
  return compact;
}
