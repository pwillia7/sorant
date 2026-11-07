"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobsController } from "@/hooks/use-jobs";
import type { Job, JobOutput, MusicVideoTag } from "@/lib/jobs";
import type { RunModes } from "@/lib/workflows/modes";
import {
  chainSegments,
  FRESH_EVERY_PARAM,
  PASS_THROUGH_PARAM,
  segmentFrames,
  SLICE_FPS,
  SLICE_FRAMES,
  type ChainSegment,
} from "@/lib/workflows/slices";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";

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
 */

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
  sending: boolean;
  error: string | null;
  start: (values: Record<string, ParamValue>, modes: SubmitModes) => Promise<void>;
  resume: () => void;
  stop: () => Promise<void>;
  join: () => Promise<void>;
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
  if (index === 0) return true;
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

/** A segment as the swap workflow's `segment` param takes it. */
const segmentValue = (segment: ChainSegment, history: number) => `${segment.start}:${segment.frames}:${history}`;

export function useLongSwap({
  workflow,
  stitchWorkflow,
  jobs,
}: {
  workflow: WorkflowSummary | undefined;
  stitchWorkflow: WorkflowSummary | undefined;
  jobs: JobsController;
}): LongSwapController {
  const [project, setProject] = useState<LongSwapProject | null>(() => readProject());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => writeProject(project), [project]);

  const tagFor = useCallback(
    (current: LongSwapProject, part: "scene" | "join", scene?: number): MusicVideoTag => ({
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
    const joins: Job[] = [];
    if (!project) return { segments, joins };
    for (const job of jobs.jobs) {
      const tag = job.musicVideo;
      if (tag?.projectId !== project.id) continue;
      if (tag.part === "join") joins.push(job);
      else if (tag.part === "scene" && tag.scene !== undefined) {
        const list = segments.get(tag.scene) ?? [];
        list.push(job);
        segments.set(tag.scene, list);
      }
    }
    const newest = (a: Job, b: Job) => b.submittedAt - a.submittedAt;
    for (const list of segments.values()) list.sort(newest);
    joins.sort(newest);
    return { segments, joins };
  }, [project, jobs.jobs]);

  const segmentJobs = useMemo(
    () => (project ? project.segments.map((_, index) => runs.segments.get(index)?.[0]) : []),
    [project, runs],
  );
  const states = useMemo(() => segmentJobs.map(stateOf), [segmentJobs]);
  const joinJob = runs.joins[0];

  /**
   * Send one segment, carrying on from the one before's video. Its clip
   * length is the segment's own, so the run's estimate is one window's.
   */
  const submitSegment = useCallback(
    async (current: LongSwapProject, index: number, history: string | null, passThrough = false) => {
      if (!workflow) return null;
      const segment = current.segments[index];
      // A fresh start or a pass-through loads no history, so its source begins
      // at its own first frame rather than `history` frames earlier.
      const carried = history && !passThrough ? segment.history : 0;
      const values: Record<string, ParamValue> = {
        ...current.values,
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
    if (!project || project.paused || !workflow || inFlight.current !== null) return;
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
    const fresh = startsFresh(project, next);
    const history = fresh ? null : clipRef(segmentJobs[next - 1]);
    if (!fresh && !history) {
      setError(`Segment ${next} finished without a saved video to carry on from. Press Resume to swap it again.`);
      return;
    }
    inFlight.current = next;
    setSending(true);
    setError(null);
    void submitSegment(project, next, history)
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
    setProject({
      id: crypto.randomUUID(),
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
      void submitSegment(project, failed, history, passThrough)
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
    sending,
    error,
    start,
    resume,
    stop,
    join,
    clear,
  };
}
