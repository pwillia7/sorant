"use client";

import { Check, Clock3, LoaderCircle, RotateCcw, Scissors, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { savedMask, shotEndOf, startsFresh, type LongSwapController, type SegmentChoice, type SegmentState } from "@/hooks/use-long-swap";
import { withToken } from "@/lib/client";
import { formatDuration, totalRenderMs, type Job } from "@/lib/jobs";
import { MUSIC_VIDEO_FRAME_RATES, MUSIC_VIDEO_UPSCALE_SIZES } from "@/lib/music-video/project";
import { frameSeekTime } from "@/lib/scene-cuts";
import { CHAIN_HISTORY, MAX_SEGMENTS, segmentFrames, SLICE_FPS, splitRange } from "@/lib/workflows/slices";
import type { ParamValue } from "@/lib/workflows/types";
import { ShotPlanner } from "./shot-planner";
import { MAX_CHECK_SECONDS, PICK_PARAM, SUBJECT_BOX_PARAM } from "@/lib/workflows/subject-box";
import { BoxPicker, inputVideoUrl } from "./ui/box-picker";
import { ClipPlayer, type ClipItem } from "./ui/clip-player";
import { JobRunTime, RunTime } from "./ui/run-time";
import { MaskCheck } from "./ui/mask-check";
import { Badge, Panel, PanelHeader } from "./ui/panel";
import { Button, buttonClasses, Spinner } from "./ui/button";
import { Segmented, Slider } from "./ui/inputs";

/**
 * A long Character swap in progress: its segments, how far the chain has got,
 * and the joined video once there is one. See use-long-swap.ts.
 */

const icon = { className: "size-3 shrink-0 stroke-2", "aria-hidden": true } as const;

function SegmentBadge({
  state,
  job,
  original,
  chosen,
}: {
  state: SegmentState;
  job: Job | undefined;
  original: boolean;
  /** Left as it is because its shot was set to no one, rather than SAM finding no one. */
  chosen?: boolean;
}) {
  if (original && state !== "failed") {
    return state === "done" ? (
      <span
        title={
          chosen
            ? "Set to no one, so this stretch is the clip's own footage."
            : "SAM found no one to replace here, so this stretch is the clip's own footage."
        }
      >
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

type RedoMode = "carry" | "form" | "largest" | "leftmost" | "rightmost" | "box" | "original";

const RULES: Array<{ value: RedoMode; label: string; title?: string }> = [
  { value: "largest", label: "Biggest" },
  { value: "leftmost", label: "Leftmost" },
  { value: "rightmost", label: "Rightmost" },
  { value: "box", label: "Point them out" },
  {
    value: "original",
    label: "No one",
    title: "Swaps no one: this stretch is the clip's own footage, as with a shot set to no one. What comes after it starts fresh.",
  },
];

/** "If SAM loses them", short, for a segment of its own. Its help is the form's. */
const LOST_OPTIONS: Array<{ value: string; label: string; title: string }> = [
  {
    value: "leave",
    label: "Leave as they are",
    title: "Frames where the track drops keep the clip's own footage, and the swap picks them up again when they come back.",
  },
  {
    value: "recover",
    label: "Find them again",
    title: "Each lost frame looks again by the description and rule, with no memory of who you pointed out. In a crowd that can swap someone else for those frames.",
  },
  {
    value: "stop",
    label: "Stop with an error",
    title: "Fails the run, naming the frames where the track dropped.",
  },
];

/**
 * Who a segment follows when nothing is chosen for it and nothing is carried,
 * as use-long-swap.ts's `subjectValues` works it out: a shot's own choice, or
 * the form's box on the first segment only, or the form's rule.
 */
function planned(project: LongSwapController["project"] & object, index: number): Record<string, string> {
  if (index === 0 || project.segments[index]?.cut) {
    const shot = project.shotChoices?.[index];
    if (shot?.box) return { [SUBJECT_BOX_PARAM]: shot.box };
    if (shot?.pick) return { [PICK_PARAM]: shot.pick, [SUBJECT_BOX_PARAM]: "" };
    if (index === 0) return {};
  }
  return { [SUBJECT_BOX_PARAM]: "" };
}

/** One part's choices in a redo: who it follows, and what happens where SAM loses them. */
interface PartState {
  mode: RedoMode;
  box: string;
  lost: string;
}

const choiceOf = (part: PartState): SegmentChoice => {
  if (part.mode === "original") return { original: true };
  if (part.mode === "box") return { box: part.box, lostFrames: part.lost };
  if (part.mode === "carry" || part.mode === "form") return { lostFrames: part.lost };
  return { pick: part.mode, lostFrames: part.lost };
};

/**
 * One part of a redo: who it follows, drawn on the frame its run starts on,
 * what happens where SAM loses them, and the check of both.
 */
function PartControls({
  name,
  part,
  onChange,
  modes,
  clip,
  time,
  values,
  checkSeconds,
}: {
  /** "segment 4", "before the cut": what the box picker's frame is of. */
  name: string;
  part: PartState;
  onChange: (next: PartState) => void;
  modes: Array<{ value: RedoMode; label: string; title?: string }>;
  clip: string;
  /** The frame SAM looks at first in this part's run, in seconds. */
  time: number;
  /** The swap's values with what "As in the form"/"As planned" means here laid over them. */
  values: Record<string, ParamValue>;
  checkSeconds: number;
}) {
  return (
    <>
      <Segmented label={`Who ${name} follows`} value={part.mode} onChange={(mode) => onChange({ ...part, mode })} options={modes} />
      {part.mode === "box" ? (
        clip ? (
          <BoxPicker
            src={inputVideoUrl(clip)}
            time={time}
            value={part.box}
            onChange={(box) => onChange({ ...part, box })}
            label={`The frame ${name} starts from`}
          />
        ) : (
          <p className="text-[12px] text-danger">The clip this swap was made from is not known, so there is no frame to draw on.</p>
        )
      ) : null}
      {part.mode === "original" ? (
        <p className="text-[12px] text-fg-subtle">Sent as the clip&rsquo;s own footage, with no one swapped.</p>
      ) : null}
      <div className={`flex flex-wrap items-center gap-2 ${part.mode === "original" ? "hidden" : ""}`}>
        <span className="text-[12px] text-fg-muted">If SAM loses them</span>
        <Segmented
          label={`If SAM loses them in ${name}`}
          value={part.lost}
          onChange={(lost) => onChange({ ...part, lost })}
          options={LOST_OPTIONS}
        />
      </div>
      {part.mode !== "carry" && part.mode !== "original" && clip ? (
        <MaskCheck
          values={{
            ...values,
            lost_frames: part.lost,
            ...(part.mode === "box"
              ? { [SUBJECT_BOX_PARAM]: part.box }
              : part.mode === "form"
                ? {}
                : { [PICK_PARAM]: part.mode, [SUBJECT_BOX_PARAM]: "" }),
          }}
          start={time}
          seconds={Math.min(MAX_CHECK_SECONDS, checkSeconds)}
          disabled={part.mode === "box" && !part.box}
        />
      ) : null}
    </>
  );
}

/** The clip's frame at `frame` on the 24 fps grid, small, to place a cut by. */
function FramePreview({ src, frame }: { src: string; frame: number }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current) video.current.currentTime = frameSeekTime(frame);
  }, [frame]);
  return (
    <video
      ref={video}
      src={src}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = frameSeekTime(frame);
      }}
      className="aspect-video w-full max-w-sm rounded border border-border-default bg-black object-contain"
    />
  );
}

/**
 * Setting up a redo: who the segment follows, what happens where SAM loses
 * them, and how far the redo reaches. By default it follows whoever the
 * segment before tracked into it — the carried mask — or, for the first,
 * whatever the form says. A rule or a box, drawn on the frame this segment's
 * run starts on, replaces that for it.
 *
 * A cut splits the segment in two, each part with its own choices: for when
 * SAM picks the wrong person, or loses them, part-way through.
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
  const canCarry =
    index > 0 && !segment.cut && !segment.fresh && savedMask(swap.segmentJobs[index - 1], carried > 0) !== null;
  const lost = project.lostFrames?.[index] ?? String(project.values.lost_frames ?? "leave");
  const [part, setPart] = useState<PartState>({
    mode: index === 0 ? "form" : canCarry ? "carry" : "form",
    box: "",
    lost,
  });
  const clip = String(project.values.source_video ?? "");
  // The frame SAM looks at first in this segment's run: its own start, or the
  // history before it when it carries on.
  const time = carried === 0 && segment.startTime !== undefined ? segment.startTime : (segment.start - carried) / SLICE_FPS;
  const frames = segmentFrames(segment, project.seconds);

  // The cut, when one is being added.
  const range = total < MAX_SEGMENTS ? splitRange(segment, project.seconds) : null;
  const [cutting, setCutting] = useState(false);
  const [at, setAt] = useState(() => (range ? Math.round((range[0] + range[1]) / 2) : 0));
  const [keep, setKeep] = useState(false);
  const [fresh, setFresh] = useState(false);
  // Pointing them out is what a cut is usually for.
  const [after, setAfter] = useState<PartState>({ mode: "box", box: "", lost });
  // Nothing to carry on from a part left as the clip's own footage.
  const split = cutting && range ? { at, keep, fresh: fresh || keep || part.mode === "original" } : null;
  // "Same as before the cut" means nothing once nothing is carried across it,
  // and "As in the form" is what stands in for it there.
  const afterPart: PartState =
    split?.fresh && after.mode === "carry"
      ? { ...after, mode: "form" }
      : !split?.fresh && after.mode === "form"
        ? { ...after, mode: "carry" }
        : after;
  const afterHistory = split?.fresh ? 0 : CHAIN_HISTORY;
  const afterTime = (at - afterHistory) / SLICE_FPS;

  const ready = (split?.keep || part.mode !== "box" || Boolean(part.box)) && (!split || afterPart.mode !== "box" || Boolean(afterPart.box));
  // How far a redo has to reach for no segment after it to carry on from
  // frames that are gone: to the next cut or fresh start.
  const end = shotEndOf(project, index);
  const send = (through: number) => {
    swap.redo(
      index,
      through,
      choiceOf(part),
      split ? { ...split, after: choiceOf(afterPart) } : undefined,
    );
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
          label: segment.cut ? "As planned" : "As in the form",
          title: segment.cut
            ? "As this shot was set before the swap started: its box or rule, or the form's."
            : index === 0
              ? "The form's box, or its description and rule."
              : segment.fresh
                ? "The form's description and rule. This part starts at a cut added on a redo, so nothing is carried into it."
                : "The form's description and rule. The segment before saved no mask to carry on from.",
        },
    ...RULES,
  ];
  const afterModes: Array<{ value: RedoMode; label: string; title?: string }> = [
    split?.fresh
      ? { value: "form", label: "As in the form", title: "The form's description and rule, on the first frame after the cut." }
      : {
          value: "carry",
          label: "Same as before the cut",
          title: "Starts from whoever the part before the cut tracked into this one: the same person, with no fresh pick.",
        },
    ...RULES,
  ];

  const n = index + 1;
  const primaryLabel = split
    ? end === index + 1
      ? split.keep
        ? `Cut, and swap after it`
        : `Cut, and redo both parts`
      : `Cut, and redo to segment ${end}`
    : end === index + 1
      ? `Redo segment ${n}`
      : `Redo segments ${n}–${end}`;

  return (
    <section className="mt-4 flex flex-col gap-3 rounded-lg border border-border-default bg-bg-subtle p-3" aria-label={`Redo segment ${n}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg">Redo segment {n}</h3>
        <span className="text-[12px] text-fg-subtle">
          A new seed; choose who it follows, or cut it in two where SAM goes wrong.
        </span>
      </div>

      {split ? <p className="label-caps text-fg-muted">Before the cut</p> : null}
      {split?.keep ? (
        <p className="text-[12px] text-fg-subtle">Kept as it is: its take is trimmed to end at the cut.</p>
      ) : (
        <PartControls
          name={split ? "the part before the cut" : `segment ${n}`}
          part={part}
          onChange={setPart}
          modes={modes}
          clip={clip}
          time={time}
          values={{ ...project.values, ...(part.mode === "form" ? planned(project, index) : {}) }}
          checkSeconds={((split ? at - segment.start : frames) + carried) / SLICE_FPS}
        />
      )}

      {range ? (
        cutting ? (
          <div className="flex flex-col gap-3 border-t border-border-default pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={`cut-${index}`} className="text-[13px] font-medium text-fg">
                <Scissors {...icon} className="mr-1.5 inline size-3.5 stroke-2" />
                Cut at {clock(at / SLICE_FPS)}
                <span className="ml-1.5 font-mono text-[11px] font-normal tabular-nums text-fg-subtle">
                  {((at - segment.start) / SLICE_FPS).toFixed(2)} s in
                </span>
              </label>
              <Button size="xs" variant="quiet" onClick={() => setCutting(false)}>
                No cut
              </Button>
            </div>
            <Slider id={`cut-${index}`} value={at} onChange={setAt} min={range[0]} max={range[1]} />
            {clip ? <FramePreview src={inputVideoUrl(clip)} frame={at} /> : null}
            <p className="text-[12px] text-fg-subtle">
              The first frame after the cut. Put it just before SAM goes wrong — where the person turns away, someone
              walks in front, or the wrong person is picked up.
            </p>
            <Segmented
              label="The part before the cut"
              value={keep}
              onChange={setKeep}
              options={[
                {
                  value: false,
                  label: "Swap it again",
                  title: "Redoes the part before the cut too, with the choices above.",
                },
                {
                  value: true,
                  label: "Keep it as it is",
                  title:
                    "Keeps this segment's take up to the cut and swaps only after it. Saves a run, but the part after starts fresh, so the cut can show a jump.",
                },
              ]}
            />
            {!keep && part.mode !== "original" ? (
              <Segmented
                label="The part after the cut"
                value={fresh}
                onChange={setFresh}
                options={[
                  {
                    value: false,
                    label: "Carries on",
                    title: "Continues from the last frames of the part before, so the cut does not show.",
                  },
                  {
                    value: true,
                    label: "Starts fresh",
                    title:
                      "Starts over from the clip and the picture, with nothing carried across. For a camera cut the finder missed.",
                  },
                ]}
              />
            ) : null}
            <p className="label-caps text-fg-muted">After the cut</p>
            <PartControls
              name="the part after the cut"
              part={afterPart}
              onChange={setAfter}
              modes={afterModes}
              clip={clip}
              time={afterTime}
              values={{ ...project.values, [SUBJECT_BOX_PARAM]: "" }}
              checkSeconds={(segment.start + frames - at + afterHistory) / SLICE_FPS}
            />
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setCutting(true)}
              title="Cut this segment in two, and choose who each part follows and what happens where SAM loses them."
            >
              <Scissors {...icon} /> Add a cut
            </Button>
          </div>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!ready}
          onClick={() => send(end)}
          title={
            end === index + 1
              ? index < total - 1
                ? `Swaps segment ${n} again, then joins again. Segment ${index + 2} starts fresh, without carrying on from this one, so the join shows no jump.`
                : `Swaps segment ${n} again, then joins again.`
              : `Swaps segments ${n} to ${end} again, each carrying on from the one before, then joins again. ${end < total ? `Segment ${end + 1} starts fresh, so nothing is left carrying on from the old take and there is no jump.` : "They run to the end of the clip, so there is no jump."}`
          }
        >
          {primaryLabel}
        </Button>
        {end > index + 1 ? (
          <Button
            size="sm"
            variant="quiet"
            disabled={!ready}
            onClick={() => send(index + 1)}
            title={`Swaps only segment ${n}${split ? ", cut in two," : ""} again. Segment ${index + 2} still carries on from this one's old frames, so that join can show a jump.`}
          >
            Only segment {n}
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

function JoinedVideo({
  url,
  label,
  download,
  took,
}: {
  url: string;
  label?: string;
  download: string;
  /** Render time of every take in it and the join, when all are known. */
  took?: number | null;
}) {
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
      <div className="mt-2 flex items-center gap-2">
        <a href={withToken(url)} download={download} className={buttonClasses({ variant: "secondary", size: "sm" })}>
          Download
        </a>
        {took != null ? (
          <span className="ml-auto">
            <RunTime
              ms={took}
              suffix="in all"
              title={`${formatDuration(took)}: the render time of every run that made this video, added up. Waiting in the queue is not counted.`}
            />
          </span>
        ) : null}
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

  if (project.planning) {
    return (
      <Panel padded>
        <PanelHeader
          title={`Character swap · ${clock(project.seconds)} · shots`}
          hint="Nothing has been sent yet."
        />
        <ShotPlanner swap={swap} />
        {swap.error ? (
          <p className="mt-3 rounded-lg border border-danger/40 bg-danger/5 p-3 text-[13px] text-danger" role="alert">
            {swap.error}
          </p>
        ) : null}
      </Panel>
    );
  }

  const total = project.segments.length;
  /** What the large viewer steps through: every segment with a clip. */
  const segmentClips: ClipItem[] = project.segments.flatMap((segment, index) => {
    const url = videoUrl(segmentJobs[index]);
    if (!url) return [];
    const end = segment.start + segmentFrames(segment, project.seconds);
    return [
      {
        url: withToken(url),
        title: `Segment ${index + 1}`,
        subtitle: `${clock(segment.start / SLICE_FPS)}–${clock(end / SLICE_FPS)}`,
        download: `segment-${index + 1}.mp4`,
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
  const passed = (project.passedThrough ?? [])
    .filter((index) => !project.shotChoices?.[index]?.original)
    .map((index) => index + 1);
  const shots = project.cuts ? project.cuts.length + 1 : 0;

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
        title={`Character swap · ${clock(project.seconds)} in ${shots > 1 ? `${shots} shots, ` : ""}${total} segments`}
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
        <JoinedVideo
          url={upscaled}
          label="Upscaled"
          download="character-swap-upscaled.mp4"
          took={totalRenderMs([...segmentJobs, joinJob, ...upscaleJobs, upscaledJoinJob])}
        />
      ) : null}
      {joined ? (
        <JoinedVideo
          url={joined}
          label={upscaled ? "Original" : undefined}
          download="character-swap.mp4"
          took={totalRenderMs([...segmentJobs, joinJob])}
        />
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

      <ol className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
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
                <ClipPlayer
                  item={segmentClips.find((clip) => clip.url === withToken(url)) ?? { url: withToken(url), title: `Segment ${index + 1}` }}
                  siblings={segmentClips}
                  onLoadedMetadata={(event) => measure(url, event.currentTarget)}
                  className="aspect-video w-full rounded"
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-1">
                <SegmentBadge
                  state={states[index]}
                  job={job}
                  original={project.passedThrough?.includes(index) ?? false}
                  chosen={project.shotChoices?.[index]?.original}
                />
                {states[index] === "done" ? <JobRunTime job={job} /> : null}
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
                {segment.cut && !project.passedThrough?.includes(index) ? (
                  <span className="text-[11px] text-fg-subtle" title="The first segment after a camera cut: swapped fresh.">
                    new shot
                  </span>
                ) : segment.fresh && !project.passedThrough?.includes(index) ? (
                  <span className="text-[11px] text-fg-subtle" title="Starts at a cut added on a redo: swapped fresh, with its own pick.">
                    added cut
                  </span>
                ) : index > 0 && startsFresh(project, index) && !project.passedThrough?.includes(index) ? (
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
