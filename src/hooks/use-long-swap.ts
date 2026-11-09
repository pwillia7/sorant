"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobsController } from "@/hooks/use-jobs";
import { api, ApiError, withToken } from "@/lib/client";
import type { Job, JobOutput, MusicVideoPart, MusicVideoTag } from "@/lib/jobs";
import type { RunModes } from "@/lib/workflows/modes";
import {
  CHAIN_OVER_SECONDS,
  chainSegments,
  FRESH_EVERY_PARAM,
  PASS_THROUGH_PARAM,
  segmentFrames,
  shotSegments,
  SLICE_FPS,
  SPLIT_SHOTS_PARAM,
  SLICE_FRAMES,
  type ChainSegment,
} from "@/lib/workflows/slices";
import {
  CARRY_MASK_PREFIX,
  END_MASK_PREFIX,
  PICK_PARAM,
  SUBJECT_BOX_PARAM,
  SUBJECT_MASK_PARAM,
} from "@/lib/workflows/subject-box";
import { defaultValuesFor, type ParamValue, type WorkflowSummary } from "@/lib/workflows/types";

/**
 * A Character swap of a clip too long for one run, as a chain of runs.
 *
 * One run holds the whole clip in the box's RAM (minimax-h3-swap.ts), which a
 * minute at 1 MP does not fit. Past CHAIN_OVER_SECONDS the page sends the clip
 * as segments of one Relay window each, in order: each segment starts from the
 * last 18 frames of the one before's output, so it carries on rather than
 * starting over, the same as the windows inside a single run. When the last
 * is done, the multi-scene join lays them end to end, each with its own
 * stretch of the clip's sound.
 *
 * Because each segment needs the one before's video, the next is sent only
 * once this page sees the last one finish. So the chain moves while the tab is
 * open; closed, it waits, and carries on when the page is opened again. A
 * segment that failed, or was lost to a restart, is sent again by Resume.
 *
 * A segment's runs are found by their history tag, not by an id kept here, so
 * a retry from the history counts as that segment's newest take.
 *
 * Two things break the carry-on on purpose:
 * - **A fresh start** every `freshEvery` segments. Carried on for minutes, the
 *   small errors in each segment compound — the face darkens and gets
 *   grainier, segment on segment — so now and then a segment is swapped from
 *   the clip and the picture alone, with no history, which resets it.
 * - **A pass-through.** A segment where SAM finds no one to replace (the shot
 *   has moved off them) cannot be swapped, so it is sent again as the clip's
 *   own footage and the chain carries on. The segment after it starts fresh.
 *
 * Once joined, the swap can be upscaled the way a music video is: each segment
 * through the Upscale workflow at one size and frame rate, then the upscaled
 * segments joined again — a second video beside the first. Segment by segment
 * because Upscale takes a minute of video at most and a swap runs to eight,
 * and because a failure then costs one segment's upscale, not the lot. The
 * upscales are found by their history tags too, each tied to the take it was
 * made from by `derivedFrom`, so a segment swapped again needs its own again.
 *
 * Any finished segment can be redone, with a new seed: on its own, carrying on
 * from the segment before as it did the first time, or with every segment
 * after it too. On its own leaves the segment after it carrying on from frames
 * that are no longer there, which can show as a jump at that join; from here
 * on costs a run per segment but keeps every join a carry-on. Either way a
 * redo sets the segment's takes aside (`redoneAt`) so the chain sees it as
 * waiting and sends it, and the join follows on its own once all are done.
 *
 * **Who is swapped stays who was swapped.** Each segment runs SAM afresh, and
 * picked by the form's rule alone, a segment could follow someone else — the
 * one now biggest in frame. So each segment saves the person's mask on the
 * frame the next one starts on (the swap graph's `saveMaskForNext`), and the
 * next starts tracking from it (`subject_mask`) instead of picking. The form's
 * box is drawn on the clip's first frame, so it applies to the first segment
 * only. A redo can choose for itself (`choices`): a rule, or a box drawn on
 * that segment's own first frame, in place of carrying on from the one before.
 *
 * **Shots.** A clip cut together from several shots is split at its camera
 * cuts before anything is sent (`planning`; the cuts are found in the browser,
 * scene-cuts.ts). Each shot's first segment starts fresh — the frames and the
 * mask before a cut show another shot, so carrying them over only misleads —
 * and each shot says for itself who to replace (`shotChoices`): the form's
 * rule, another rule, a box drawn on its first frame, or no one, which sends
 * it as the clip's own footage.
 */

/** How a redone segment picks who to replace, in place of the carried mask. */
export interface SegmentChoice {
  /** The rule, as the form's "If several match" takes it. */
  pick?: string;
  /** A box drawn on the segment's first frame (subject-box.ts). */
  box?: string;
}

/** Who a shot replaces: the form's rule when neither is set. */
export interface ShotChoice extends SegmentChoice {
  /** No one: the shot is sent as the clip's own footage. */
  original?: boolean;
}

const STORAGE_KEY = "sorant-long-swap";

export interface LongSwapProject {
  id: string;
  /** The form as it was at Generate, seed fixed, so every segment is the same swap. */
  values: Record<string, ParamValue>;
  modes: SubmitModes;
  segments: ChainSegment[];
  /** The clip's length as measured. */
  seconds: number;
  /** For the history entry's heading. */
  title: string;
  createdAt: number;
  /** Set by Stop: no more segments are sent until Resume. */
  paused?: boolean;
  /** Start a segment without history every this many segments; 0 or absent, never. */
  freshEvery?: number;
  /** Segments sent as the clip's own footage, because SAM found no one in them. */
  passedThrough?: number[];
  /**
   * The shorter side the segments are upscaled to, set when the first upscale
   * is sent: one size for all of them, or the join has two to reconcile.
   */
  upscaleSize?: number;
  /** The frame-rate multiplier the segments are upscaled with, fixed with the size. */
  upscaleFrameRate?: number;
  /** Set once someone asks for the upscaled video; the join of it follows on its own. */
  upscaleRequested?: boolean;
  /**
   * The upscales the upscaled join last went ahead with on its own, as their
   * prompt ids in order. Once per set: a join that failed is offered again
   * rather than sent again, since one that took ComfyUI down would do so every
   * time the page came back.
   */
  upscaledJoinTried?: string;
  /**
   * When each redone segment was asked for again: a take submitted before it
   * is set aside, so the chain sees the segment as waiting and sends it.
   */
  redoneAt?: Record<number, number>;
  /** The seed each redone segment runs with in place of the swap's own. */
  seeds?: Record<number, number>;
  /** How a redone segment picks who to replace, where it was told. */
  choices?: Record<number, SegmentChoice>;
  /**
   * Set while the clip's shots are being found and chosen for: nothing is
   * sent until `plan` clears it.
   */
  planning?: boolean;
  /** Where each shot after the first starts, in frames at 24 fps, once planned. */
  cuts?: number[];
  /**
   * Who each shot replaces, by the index of its first segment; `original` on
   * every segment of a shot sent as the clip's own footage.
   */
  shotChoices?: Record<number, ShotChoice>;
}

type SubmitModes = RunModes & { lowVram?: boolean; localDirector?: string; rewriteModel?: string };

export type SegmentState = "waiting" | "queued" | "running" | "done" | "failed";

export interface LongSwapController {
  project: LongSwapProject | null;
  /** Each segment's newest take, in clip order. */
  segmentJobs: Array<Job | undefined>;
  states: SegmentState[];
  /** The newest join, if one has been sent. */
  joinJob: Job | undefined;
  /** Each segment's upscale of its current take, where it has one. */
  upscaleJobs: Array<Job | undefined>;
  /** The newest join of the upscaled segments, if one has been sent. */
  upscaledJoinJob: Job | undefined;
  /** Whether the Upscale workflow is there to send segments to. */
  canUpscale: boolean;
  sending: boolean;
  error: string | null;
  start: (values: Record<string, ParamValue>, modes: SubmitModes) => Promise<void>;
  resume: () => void;
  stop: () => Promise<void>;
  join: () => Promise<void>;
  /**
   * Upscale every segment without a good upscale of its current take, then
   * join them. The size and rate are the project's once the first has gone.
   */
  upscaleAll: (size: number, frameRate: number) => Promise<void>;
  /** Join the upscaled segments; on its own once they are all done, this is for after that failed. */
  joinUpscaled: () => Promise<void>;
  /**
   * Swap a finished segment again with a new seed — on its own, or with every
   * segment after it (`onward`) so each still carries on from the one before.
   */
  redo: (index: number, onward: boolean, choice?: SegmentChoice) => void;
  /**
   * End planning: split the clip at these cuts, with who each shot replaces,
   * and start sending. A clip short enough for one run with no cuts in it is
   * sent as that one run instead, and the project closes.
   */
  plan: (cuts: number[], shots: ShotChoice[]) => Promise<void>;
  clear: () => void;
}

function readProject(): LongSwapProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as LongSwapProject) : null;
    // A project from the earlier, unchained form has `slices`, not `segments`.
    return parsed && Array.isArray(parsed.segments) ? parsed : null;
  } catch {
    return null;
  }
}

function writeProject(project: LongSwapProject | null): void {
  try {
    if (project) localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage full or disabled: the project lives for this tab only.
  }
}

const FAILED = new Set<Job["phase"]>(["error", "cancelled", "unknown"]);

/** Relay's error when the first frame has no one matching "Who to replace". */
const NO_SUBJECT = /SAM found no subject/i;

/** Whether a segment's newest take failed because there was no one to swap. */
export function foundNoOne(job: Job | undefined): boolean {
  return job?.phase === "error" && NO_SUBJECT.test(job.error ?? "");
}

/** Segments per fresh start, from the form's seconds; 0 for never. */
function freshEveryOf(values: Record<string, ParamValue>): number {
  const seconds = Number(values[FRESH_EVERY_PARAM] ?? 0);
  if (!(seconds > 0)) return 0;
  return Math.max(2, Math.round((seconds * SLICE_FPS) / (SLICE_FRAMES - 1)));
}

/**
 * Whether a segment starts without history: the first, one after a
 * pass-through, and every `freshEvery`th.
 */
export function startsFresh(project: LongSwapProject, index: number): boolean {
  if (index === 0 || project.segments[index]?.cut) return true;
  if (project.passedThrough?.includes(index - 1)) return true;
  return Boolean(project.freshEvery && index % project.freshEvery === 0);
}

function stateOf(job: Job | undefined): SegmentState {
  if (!job) return "waiting";
  if (job.phase === "done") return "done";
  if (FAILED.has(job.phase)) return "failed";
  return job.phase === "running" ? "running" : "queued";
}

/** The video a segment saved, as LoadVideo names a file in the output folder. */
export function clipRef(job: Job | undefined): string | null {
  const saved: JobOutput | undefined =
    job?.phase === "done"
      ? job.outputs.find(
          (file) => (file.type || "output") === "output" && /\.(mp4|webm|mov|mkv)$/i.test(file.filename),
        )
      : undefined;
  if (!saved) return null;
  const path = saved.subfolder ? `${saved.subfolder}/${saved.filename}` : saved.filename;
  return `${path} [output]`;
}

/**
 * The upscale's copy of a segment with its sound. VHS writes a silent file and
 * an "-audio" one beside it; the join keeps each segment's own stretch of the
 * clip's sound, so it reads the one with it.
 */
const SOUNDTRACKED = /^(.+_\d{5,})-audio(\.[a-z0-9]+)$/i;
function soundtrackedRef(job: Job | undefined): string | null {
  const saved =
    job?.phase === "done"
      ? job.outputs.find((file) => (file.type || "output") === "output" && SOUNDTRACKED.test(file.filename))
      : undefined;
  if (!saved) return clipRef(job);
  const path = saved.subfolder ? `${saved.subfolder}/${saved.filename}` : saved.filename;
  return `${path} [output]`;
}

/**
 * The mask a finished segment saved for the next one, as LoadImage names a
 * file in the output folder: the frame the next starts on when it carries on,
 * or its own last frame when the next starts fresh.
 */
export function savedMask(job: Job | undefined, carriesOn: boolean): string | null {
  const saved = savedMaskFile(job, carriesOn);
  return saved ? `${saved.subfolder}/${saved.filename} [output]` : null;
}

function savedMaskFile(job: Job | undefined, carriesOn: boolean): JobOutput | undefined {
  if (job?.phase !== "done") return undefined;
  const prefix = carriesOn ? CARRY_MASK_PREFIX : END_MASK_PREFIX;
  const [folder, name] = prefix.split("/");
  return job.outputs.find(
    (file) =>
      (file.type || "output") === "output" &&
      file.subfolder === folder &&
      file.filename.startsWith(`${name}_`) &&
      file.filename.endsWith(".png"),
  );
}

/**
 * Whether a saved mask has no one in it: the hand-off frame fell where the
 * person was lost and left so ("Leave those frames as they are"). Tracking
 * from it would follow no one, so the next segment picks by the rule instead.
 * Unreadable counts as not empty — the run then says what is wrong itself.
 */
async function maskIsEmpty(file: JobOutput): Promise<boolean> {
  try {
    const image = new Image();
    image.src = withToken(file.url);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth / 4));
    canvas.height = Math.max(1, Math.round(image.naturalHeight / 4));
    const context = canvas.getContext("2d");
    if (!context) return false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) if (data[i] > 127) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Who a segment replaces, as the swap's params take it. A redo's own choice
 * first; then, after the first segment, the person as the segment before
 * tracked them; the first segment uses the form's box or rule.
 */
function subjectValues(
  project: LongSwapProject,
  index: number,
  carriesOn: boolean,
  previous: Job | undefined,
): Record<string, ParamValue> {
  const choice = project.choices?.[index];
  if (choice?.box) return { [SUBJECT_BOX_PARAM]: choice.box, [SUBJECT_MASK_PARAM]: "" };
  if (choice?.pick) return { [PICK_PARAM]: choice.pick, [SUBJECT_BOX_PARAM]: "", [SUBJECT_MASK_PARAM]: "" };
  if (index === 0 || project.segments[index]?.cut) {
    // A shot's own choice, or the form's rule. The form's box was drawn on the
    // clip's first frame, so it is the first shot's alone.
    const shot = project.shotChoices?.[index];
    if (shot?.box) return { [SUBJECT_BOX_PARAM]: shot.box, [SUBJECT_MASK_PARAM]: "" };
    if (shot?.pick) return { [PICK_PARAM]: shot.pick, [SUBJECT_BOX_PARAM]: "", [SUBJECT_MASK_PARAM]: "" };
    return index === 0 ? { [SUBJECT_MASK_PARAM]: "" } : { [SUBJECT_BOX_PARAM]: "", [SUBJECT_MASK_PARAM]: "" };
  }
  // The form's box was drawn on the clip's first frame, which is not this one.
  // With no saved mask (the segment before was the clip's own footage, or ran
  // before masks were saved), the form's rule picks.
  return { [SUBJECT_BOX_PARAM]: "", [SUBJECT_MASK_PARAM]: savedMask(previous, carriesOn) ?? "" };
}

/** Whether the mask `subjectValues` would carry into this segment is empty. */
async function carriesNoOne(
  project: LongSwapProject,
  index: number,
  carriesOn: boolean,
  previous: Job | undefined,
): Promise<boolean> {
  if (index === 0 || project.segments[index]?.cut) return false;
  if (project.choices?.[index]?.box || project.choices?.[index]?.pick) return false;
  const file = savedMaskFile(previous, carriesOn);
  return file ? maskIsEmpty(file) : false;
}

/** A segment as the swap workflow's `segment` param takes it. */
const segmentValue = (segment: ChainSegment, history: number) => `${segment.start}:${segment.frames}:${history}`;

export function useLongSwap({
  workflow,
  stitchWorkflow,
  upscaleWorkflow,
  jobs,
}: {
  workflow: WorkflowSummary | undefined;
  stitchWorkflow: WorkflowSummary | undefined;
  /** Whichever workflow the Upscale button sends a clip to. */
  upscaleWorkflow: WorkflowSummary | undefined;
  jobs: JobsController;
}): LongSwapController {
  const [project, setProject] = useState<LongSwapProject | null>(() => readProject());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => writeProject(project), [project]);

  const tagFor = useCallback(
    (current: LongSwapProject, part: MusicVideoPart, scene?: number): MusicVideoTag => ({
      projectId: current.id,
      part,
      scene,
      title: current.title,
      scenes: current.segments.length,
      kind: "swap",
    }),
    [],
  );

  /** Each segment's runs newest first, and the joins, from the history's tags. */
  const runs = useMemo(() => {
    const segments = new Map<number, Job[]>();
    const upscales = new Map<number, Job[]>();
    const joins: Job[] = [];
    const upscaledJoins: Job[] = [];
    if (!project) return { segments, upscales, joins, upscaledJoins };
    const add = (map: Map<number, Job[]>, index: number, job: Job) => {
      const list = map.get(index) ?? [];
      list.push(job);
      map.set(index, list);
    };
    for (const job of jobs.jobs) {
      const tag = job.musicVideo;
      if (tag?.projectId !== project.id) continue;
      if (tag.part === "join") joins.push(job);
      else if (tag.part === "upscaled-join") upscaledJoins.push(job);
      else if (tag.part === "scene" && tag.scene !== undefined) add(segments, tag.scene, job);
      else if (tag.part === "upscale" && tag.scene !== undefined) add(upscales, tag.scene, job);
    }
    const newest = (a: Job, b: Job) => b.submittedAt - a.submittedAt;
    for (const list of [...segments.values(), ...upscales.values()]) list.sort(newest);
    joins.sort(newest);
    upscaledJoins.sort(newest);
    return { segments, upscales, joins, upscaledJoins };
  }, [project, jobs.jobs]);

  // A segment's newest take, unless it was redone since: then it is waiting.
  const segmentJobs = useMemo(
    () =>
      project
        ? project.segments.map((_, index) => {
            const take = runs.segments.get(index)?.[0];
            const redone = project.redoneAt?.[index];
            return take && redone !== undefined && take.submittedAt < redone ? undefined : take;
          })
        : [],
    [project, runs],
  );
  const states = useMemo(() => segmentJobs.map(stateOf), [segmentJobs]);
  // A join of takes since replaced is not this swap's any more; the chain
  // joins again once the redone segments are done.
  const newestTake = segmentJobs.every(Boolean) ? Math.max(...segmentJobs.map((job) => job!.submittedAt)) : Infinity;
  const joinJob = runs.joins[0] && runs.joins[0].submittedAt >= newestTake ? runs.joins[0] : undefined;
  // An upscale counts for a segment only while the take it was made from is
  // still that segment's newest.
  const upscaleJobs = useMemo(
    () =>
      segmentJobs.map((take, index) =>
        take ? runs.upscales.get(index)?.find((job) => job.derivedFrom === take.promptId) : undefined,
      ),
    [segmentJobs, runs],
  );
  // Likewise an upscaled join of upscales that no longer match the takes.
  const newestUpscale = upscaleJobs.every(Boolean)
    ? Math.max(...upscaleJobs.map((job) => job!.submittedAt))
    : Infinity;
  const upscaledJoinJob =
    runs.upscaledJoins[0] && runs.upscaledJoins[0].submittedAt >= newestUpscale ? runs.upscaledJoins[0] : undefined;

  /**
   * Send one segment, carrying on from the one before's video. Its clip
   * length is the segment's own, so the run's estimate is one window's.
   */
  const submitSegment = useCallback(
    async (
      current: LongSwapProject,
      index: number,
      history: string | null,
      passThrough = false,
      /** The segment before's finished take, for the mask it saved. */
      previous?: Job,
    ) => {
      if (!workflow) return null;
      const segment = current.segments[index];
      // A fresh start or a pass-through loads no history, so its source begins
      // at its own first frame rather than `history` frames earlier.
      const carried = history && !passThrough ? segment.history : 0;
      const values: Record<string, ParamValue> = {
        ...current.values,
        ...(passThrough ? {} : subjectValues(current, index, carried > 0, previous)),
        ...(!passThrough && (await carriesNoOne(current, index, carried > 0, previous))
          ? { [SUBJECT_MASK_PARAM]: "" }
          : {}),
        seed: current.seeds?.[index] ?? current.values.seed,
        segment: segmentValue(segment, carried),
        history_clip: carried ? history! : "",
        [PASS_THROUGH_PARAM]: passThrough ? "1" : "",
        clip_seconds: (carried + segmentFrames(segment, current.seconds)) / SLICE_FPS,
      };
      return jobs.submit(workflow, values, {
        ...current.modes,
        musicVideo: tagFor(current, "scene", index),
      });
    },
    [workflow, jobs, tagFor],
  );

  // The chain: whenever nothing is in flight, send the first segment without a
  // finished take, once the one before it has one. Guarded by the index being
  // sent, so a re-render while a submit is pending does not send it twice.
  const inFlight = useRef<number | null>(null);
  useEffect(() => {
    if (!project || project.paused || project.planning || !workflow || inFlight.current !== null) return;
    const next = states.findIndex((state) => state !== "done");
    if (next === -1) return;
    // No one to swap in this stretch: send it as the clip's own footage, once.
    if (foundNoOne(segmentJobs[next]) && !project.passedThrough?.includes(next)) {
      const passed = { ...project, passedThrough: [...(project.passedThrough ?? []), next] };
      inFlight.current = next;
      setSending(true);
      setError(null);
      setProject(passed);
      void submitSegment(passed, next, null, true)
        .then((promptId) => {
          if (!promptId) {
            setError(`Segment ${next + 1} could not be sent as the original footage. Press Resume to try again.`);
            setProject((current) => (current ? { ...current, paused: true } : current));
          }
        })
        .finally(() => {
          inFlight.current = null;
          setSending(false);
        });
      return;
    }
    if (states[next] !== "waiting") return; // queued, running, or failed (Resume)
    // A shot chosen to be left as it is, or a stretch already found to have
    // no one in it.
    const original = project.passedThrough?.includes(next) ?? false;
    const fresh = startsFresh(project, next);
    const history = fresh || original ? null : clipRef(segmentJobs[next - 1]);
    if (!fresh && !original && !history) {
      setError(`Segment ${next} finished without a saved video to carry on from. Press Resume to swap it again.`);
      return;
    }
    inFlight.current = next;
    setSending(true);
    setError(null);
    void submitSegment(project, next, history, original, segmentJobs[next - 1])
      .then((promptId) => {
        if (!promptId) {
          setError(`Segment ${next + 1} was refused. See the message above, then press Resume.`);
          setProject((current) => (current ? { ...current, paused: true } : current));
        }
      })
      .finally(() => {
        inFlight.current = null;
        setSending(false);
      });
  }, [project, workflow, states, segmentJobs, submitSegment]);

  const start = useCallback(async (values: Record<string, ParamValue>, modes: SubmitModes) => {
    const seconds = Number(values.clip_seconds);
    if (!(seconds > 0)) {
      setError("The clip's length is not known yet. Wait for its preview to load, then try again.");
      return;
    }
    // One seed for every segment, fixed now, so a random seed does not give
    // each segment a different swap.
    const seed = Number(values.seed);
    const who = String(values.prompt ?? "").trim();
    const character = String(values.character ?? "").trim();
    setError(null);
    // Split at the camera cuts unless the form says not to: the panel finds
    // them and the chain waits for `plan`.
    const split = values[SPLIT_SHOTS_PARAM] !== false;
    setProject({
      id: crypto.randomUUID(),
      planning: split || undefined,
      freshEvery: freshEveryOf(values),
      values: {
        ...values,
        seed: Number.isInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2 ** 31),
      },
      modes,
      segments: chainSegments(seconds),
      seconds,
      title: [who, character].filter(Boolean).join(" → ") || "Character swap",
      createdAt: Date.now(),
    });
  }, []);

  /**
   * Carry on: un-pause, and send a failed or lost segment again. The segments
   * after it are sent by the chain as each one finishes.
   */
  const resume = useCallback(() => {
    if (!project) return;
    setError(null);
    const failed = states.findIndex((state) => state === "failed");
    const firstUndone = states.findIndex((state) => state !== "done");
    setProject({ ...project, paused: false });
    // No one to swap there: the chain sends it as the original footage itself.
    if (failed !== -1 && foundNoOne(segmentJobs[failed]) && !project.passedThrough?.includes(failed)) return;
    if (failed !== -1 && failed === firstUndone) {
      const passThrough = project.passedThrough?.includes(failed) ?? false;
      const history = passThrough || startsFresh(project, failed) ? null : clipRef(segmentJobs[failed - 1]);
      inFlight.current = failed;
      setSending(true);
      void submitSegment(project, failed, history, passThrough, segmentJobs[failed - 1])
        .then((promptId) => {
          if (!promptId) setError(`Segment ${failed + 1} was refused. See the message above.`);
        })
        .finally(() => {
          inFlight.current = null;
          setSending(false);
        });
    }
  }, [project, states, segmentJobs, submitSegment]);

  /** Cancel the segment in flight and send no more until Resume. */
  const stop = useCallback(async () => {
    if (!project) return;
    setProject({ ...project, paused: true });
    const active = segmentJobs.find((job) => job && (job.phase === "queued" || job.phase === "running"));
    if (active) await jobs.cancel(active.promptId);
  }, [project, segmentJobs, jobs]);

  const join = useCallback(async () => {
    if (!project) return;
    if (!stitchWorkflow) {
      setError("The join workflow is not available, so the segments cannot be joined here.");
      return;
    }
    const clips = segmentJobs.map((job, index) => {
      const file = clipRef(job);
      const frames = segmentFrames(project.segments[index], project.seconds);
      return file ? { file, seconds: frames / SLICE_FPS } : null;
    });
    if (clips.some((clip) => clip === null)) {
      setError("Every segment needs a finished take before they can be joined.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const promptId = await jobs.submit(
        stitchWorkflow,
        { scenes: JSON.stringify(clips), prompt: `Character swap: ${project.title}` },
        { derivedFrom: segmentJobs[0]?.promptId, musicVideo: tagFor(project, "join") },
      );
      if (!promptId) setError("The join was refused. See the message above.");
    } finally {
      setSending(false);
    }
  }, [project, stitchWorkflow, segmentJobs, jobs, tagFor]);

  // Join on its own once every segment is done, once per set of takes.
  const joinedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project || !stitchWorkflow || segmentJobs.length === 0) return;
    if (!segmentJobs.every((job) => job?.phase === "done")) return;
    const takes = segmentJobs.map((job) => job!.promptId).join(",");
    const newestTake = Math.max(...segmentJobs.map((job) => job!.submittedAt));
    const joined = joinJob !== undefined && joinJob.submittedAt >= newestTake;
    if (joined || joinedFor.current === takes) return;
    joinedFor.current = takes;
    void join();
  }, [project, stitchWorkflow, segmentJobs, joinJob, join]);

  /**
   * Send every segment without a good upscale to the Upscale workflow, at its
   * defaults bar the size and frame rate. One after another into the queue;
   * the join follows on its own once they are all done.
   */
  const upscaleAll = useCallback(
    async (size: number, frameRate: number) => {
      if (!project || !upscaleWorkflow) return;
      if (!segmentJobs.every((job) => job?.phase === "done")) {
        setError("Every segment needs a finished take before it can be upscaled.");
        return;
      }
      const current: LongSwapProject = {
        ...project,
        upscaleRequested: true,
        upscaleSize: project.upscaleSize ?? size,
        upscaleFrameRate: project.upscaleFrameRate ?? frameRate,
      };
      setProject(current);
      setError(null);
      setSending(true);
      try {
        for (let index = 0; index < segmentJobs.length; index += 1) {
          const existing = upscaleJobs[index];
          if (existing && !FAILED.has(existing.phase)) continue;
          const take = segmentJobs[index]!;
          const output = take.outputs.find(
            (file) => (file.type || "output") === "output" && /\.(mp4|webm|mov|mkv)$/i.test(file.filename),
          );
          if (!output) {
            setError(`Segment ${index + 1} has no saved video to upscale.`);
            return;
          }
          // Into ComfyUI's input folder, where the upscale's loader reads — the
          // same copy the Upscale button makes.
          const { ref } = await api<{ ref: string }>("/api/remix", {
            method: "POST",
            body: JSON.stringify({ filename: output.filename, subfolder: output.subfolder, type: output.type }),
          });
          const promptId = await jobs.submit(
            upscaleWorkflow,
            {
              ...defaultValuesFor(upscaleWorkflow),
              source_video: ref,
              shorter_side: current.upscaleSize!,
              frame_rate: String(current.upscaleFrameRate ?? 1),
            },
            { derivedFrom: take.promptId, musicVideo: tagFor(current, "upscale", index) },
          );
          if (!promptId) return;
        }
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : "A segment could not be sent to the upscale.");
      } finally {
        setSending(false);
      }
    },
    [project, upscaleWorkflow, segmentJobs, upscaleJobs, jobs, tagFor],
  );

  const allUpscaled = upscaleJobs.length > 0 && upscaleJobs.every((job) => job?.phase === "done");
  const upscaleSet = upscaleJobs.map((job) => job?.promptId ?? "").join(",");
  const joiningUpscaled = useRef(false);
  const sendUpscaledJoin = useCallback(async () => {
    if (!project || !stitchWorkflow || !allUpscaled || joiningUpscaled.current) return;
    const clips = upscaleJobs.map((job, index) => {
      const file = soundtrackedRef(job);
      const frames = segmentFrames(project.segments[index], project.seconds);
      // By time, so a segment at 48 fps trims the same as at 24.
      return file ? { file, seconds: frames / SLICE_FPS } : null;
    });
    if (clips.some((clip) => clip === null)) {
      setError("Every segment needs a finished upscale before they can be joined.");
      return;
    }
    joiningUpscaled.current = true;
    setProject((previous) => (previous ? { ...previous, upscaledJoinTried: upscaleSet } : previous));
    setError(null);
    try {
      const promptId = await jobs.submit(
        stitchWorkflow,
        { scenes: JSON.stringify(clips), prompt: `Character swap, upscaled: ${project.title}` },
        { derivedFrom: segmentJobs[0]?.promptId, musicVideo: tagFor(project, "upscaled-join") },
      );
      if (!promptId) setError("The join of the upscaled segments was refused. See the message above.");
    } finally {
      joiningUpscaled.current = false;
    }
  }, [project, stitchWorkflow, allUpscaled, upscaleJobs, upscaleSet, segmentJobs, jobs, tagFor]);

  // Join the upscales on their own once they are all done, once per set.
  useEffect(() => {
    if (!project?.upscaleRequested || !allUpscaled) return;
    const joined =
      upscaledJoinJob !== undefined &&
      upscaledJoinJob.submittedAt >= Math.max(...upscaleJobs.map((job) => job!.submittedAt));
    if (joined || project.upscaledJoinTried === upscaleSet) return;
    void sendUpscaledJoin();
  }, [project, allUpscaled, upscaleJobs, upscaleSet, upscaledJoinJob, sendUpscaledJoin]);

  const joinUpscaled = useCallback(async () => {
    await sendUpscaledJoin();
  }, [sendUpscaledJoin]);

  const redo = useCallback(
    (index: number, onward: boolean, choice?: SegmentChoice) => {
      if (!project) return;
      const at = Date.now();
      const redone = project.segments
        .map((_, i) => i)
        .filter((i) => (onward ? i >= index : i === index));
      const redoneAt = { ...project.redoneAt };
      const seeds = { ...project.seeds };
      const choices = { ...project.choices };
      for (const i of redone) {
        redoneAt[i] = at;
        seeds[i] = Math.floor(Math.random() * 2 ** 31);
        // Those after the first carry on from it, whatever they were told before.
        delete choices[i];
      }
      if (choice && (choice.box || choice.pick)) choices[index] = choice;
      // A shot left as it is, redone: swapped after all, by the form's rule
      // unless told otherwise.
      else if (project.shotChoices?.[index]?.original) choices[index] = { pick: String(project.values[PICK_PARAM] ?? "largest") };
      setError(null);
      setProject({
        ...project,
        paused: false,
        redoneAt,
        seeds,
        choices,
        // Tried for a swap again: if SAM still finds no one, it passes through
        // again. A shot chosen to be left as it is stays so, unless it is the
        // one being redone.
        passedThrough: project.passedThrough?.filter(
          (i) => !redone.includes(i) || (i !== index && project.shotChoices?.[i]?.original),
        ),
      });
    },
    [project],
  );

  const plan = useCallback(
    async (cuts: number[], shots: ShotChoice[]) => {
      if (!project || !workflow) return;
      setError(null);
      if (cuts.length === 0 && project.seconds <= CHAIN_OVER_SECONDS) {
        // One shot, short enough for one run: an ordinary run, as it would
        // have been without the split.
        const shot = shots[0] ?? {};
        setSending(true);
        try {
          const promptId = await jobs.submit(
            workflow,
            {
              ...project.values,
              ...(shot.box ? { [SUBJECT_BOX_PARAM]: shot.box } : {}),
              ...(shot.pick ? { [PICK_PARAM]: shot.pick, [SUBJECT_BOX_PARAM]: "" } : {}),
            },
            project.modes,
          );
          if (promptId) setProject(null);
          else setError("The swap was refused. See the message above.");
        } finally {
          setSending(false);
        }
        return;
      }
      const segments = shotSegments(project.seconds, cuts);
      const firsts = segments.flatMap((segment, index) => (index === 0 || segment.cut ? [index] : []));
      const shotChoices: Record<number, ShotChoice> = {};
      const originals: number[] = [];
      firsts.forEach((first, shot) => {
        const choice = shots[shot] ?? {};
        const end = firsts[shot + 1] ?? segments.length;
        if (choice.original) {
          for (let index = first; index < end; index += 1) {
            shotChoices[index] = { original: true };
            originals.push(index);
          }
        } else if (choice.box || choice.pick) {
          shotChoices[first] = choice.box ? { box: choice.box } : { pick: choice.pick };
        }
      });
      if (originals.length === segments.length) {
        setError("Every shot is set to be left as it is, so there is no one to swap.");
        return;
      }
      setProject({
        ...project,
        planning: undefined,
        cuts,
        segments,
        shotChoices,
        passedThrough: originals,
      });
    },
    [project, workflow, jobs],
  );

  const clear = useCallback(() => {
    setProject(null);
    setError(null);
    joinedFor.current = null;
  }, []);

  return {
    project,
    segmentJobs,
    states,
    joinJob,
    upscaleJobs,
    upscaledJoinJob,
    canUpscale: upscaleWorkflow !== undefined && stitchWorkflow !== undefined,
    sending,
    error,
    start,
    resume,
    stop,
    join,
    upscaleAll,
    joinUpscaled,
    redo,
    plan,
    clear,
  };
}
