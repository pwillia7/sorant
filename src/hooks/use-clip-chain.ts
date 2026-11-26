"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobsController } from "@/hooks/use-jobs";
import { clipRef } from "@/hooks/use-long-swap";
import { isSilentClip } from "@/lib/audio-track";
import type { Job, MusicVideoPart, MusicVideoTag } from "@/lib/jobs";
import type { RunModes } from "@/lib/workflows/modes";
import { CHAIN_FPS, chainValue, chainWindows, type ChainWindow } from "@/lib/workflows/chain";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";

/**
 * A Remix of a clip longer than one window, as a chain of runs (chain.ts).
 *
 * Each window is an ordinary run of the workflow with its `segment` param
 * set, so the loader reads only that stretch of the clip. The windows do not
 * depend on one another, so every one is queued as soon as the chain starts —
 * there is no carrying on to wait for — and the multi-scene join lays the
 * takes end to end once the last is done. The project lives in localStorage
 * and its runs are found in the history by their tag, so a closed tab loses
 * nothing: the box keeps working through the queue, and the join is sent
 * when the page next sees every window done.
 *
 * A window that failed is sent again by Resume; a finished one can be redone
 * with a new seed, and the join follows on its own.
 */

const STORAGE_KEY = "sorant-clip-chain";

type SubmitModes = RunModes & { lowVram?: boolean; localDirector?: string; rewriteModel?: string };

export type WindowState = "waiting" | "queued" | "running" | "done" | "failed";

export interface ClipChainProject {
  id: string;
  /** The workflow every window runs. */
  workflowId: string;
  /** The form as it was at Generate, seed fixed, so every window is the same remix. */
  values: Record<string, ParamValue>;
  modes: SubmitModes;
  windows: ChainWindow[];
  /** The clip's length as measured. */
  seconds: number;
  title: string;
  createdAt: number;
  /** Set by Stop: nothing more is sent until Resume. */
  paused?: boolean;
  /** When each redone window was asked for again: takes before it are set aside. */
  redoneAt?: Record<number, number>;
  /** The seed a redone window runs with, in place of the project's. */
  seeds?: Record<number, number>;
}

export interface ClipChainController {
  project: ClipChainProject | null;
  /** Each window's newest take, in clip order. */
  windowJobs: Array<Job | undefined>;
  states: WindowState[];
  joinJob: Job | undefined;
  sending: boolean;
  error: string | null;
  start: (values: Record<string, ParamValue>, modes: SubmitModes) => void;
  resume: () => void;
  stop: () => Promise<void>;
  join: () => Promise<void>;
  /** Remix one finished window again, with a new seed. */
  redo: (index: number) => void;
  clear: () => void;
}

function readProject(): ClipChainProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as ClipChainProject) : null;
    return parsed && Array.isArray(parsed.windows) ? parsed : null;
  } catch {
    return null;
  }
}

function writeProject(project: ClipChainProject | null): void {
  try {
    if (project) localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage full or disabled: the project lives for this tab only.
  }
}

const FAILED = new Set<Job["phase"]>(["error", "cancelled", "unknown"]);

function stateOf(job: Job | undefined): WindowState {
  if (!job) return "waiting";
  if (job.phase === "done") return "done";
  if (FAILED.has(job.phase)) return "failed";
  return job.phase === "running" ? "running" : "queued";
}

/** How many frames a window delivers, the last one to the end of the clip. */
export function windowFrames(project: Pick<ClipChainProject, "windows" | "seconds">, index: number): number {
  const window = project.windows[index];
  if (index < project.windows.length - 1) return window.frames;
  return Math.max(1, Math.round(project.seconds * CHAIN_FPS) - window.start);
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

export function useClipChain({
  workflow,
  stitchWorkflow,
  jobs,
}: {
  workflow: WorkflowSummary | undefined;
  stitchWorkflow: WorkflowSummary | undefined;
  jobs: JobsController;
}): ClipChainController {
  const [project, setProject] = useState<ClipChainProject | null>(() => readProject());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => writeProject(project), [project]);
  // The project as it is now, for the send loop: Stop pressed while windows
  // are still being queued ends the loop at the next one.
  const live = useRef(project);
  useEffect(() => {
    live.current = project;
  }, [project]);
  const chain = workflow?.chain;

  const tagFor = useCallback(
    (current: ClipChainProject, part: MusicVideoPart, index?: number): MusicVideoTag => ({
      projectId: current.id,
      part,
      scene: index,
      title: current.title,
      scenes: current.windows.length,
      kind: "remix",
    }),
    [],
  );

  const runs = useMemo(() => {
    const windows = new Map<number, Job[]>();
    const joins: Job[] = [];
    if (!project) return { windows, joins };
    for (const job of jobs.jobs) {
      const tag = job.musicVideo;
      if (tag?.projectId !== project.id) continue;
      if (tag.part === "join") joins.push(job);
      else if (tag.part === "scene" && tag.scene !== undefined) {
        windows.set(tag.scene, [...(windows.get(tag.scene) ?? []), job]);
      }
    }
    const newest = (a: Job, b: Job) => b.submittedAt - a.submittedAt;
    for (const list of windows.values()) list.sort(newest);
    joins.sort(newest);
    return { windows, joins };
  }, [project, jobs.jobs]);

  const windowJobs = useMemo(
    () =>
      project
        ? project.windows.map((_, index) => {
            const take = runs.windows.get(index)?.[0];
            const redone = project.redoneAt?.[index];
            return take && redone !== undefined && take.submittedAt < redone ? undefined : take;
          })
        : [],
    [project, runs],
  );
  const states = useMemo(() => windowJobs.map(stateOf), [windowJobs]);
  const newestTake = windowJobs.every(Boolean) ? Math.max(...windowJobs.map((job) => job!.submittedAt)) : Infinity;
  const joinJob = runs.joins[0] && runs.joins[0].submittedAt >= newestTake ? runs.joins[0] : undefined;

  const submitWindow = useCallback(
    (current: ClipChainProject, index: number) => {
      if (!workflow || !chain) return Promise.resolve(null);
      return jobs.submit(
        workflow,
        {
          ...current.values,
          seed: current.seeds?.[index] ?? current.values.seed,
          [chain.segmentParam]: chainValue(current.windows, index),
          // What the director is told the clip runs: this window's length.
          [chain.lengthParam]: windowFrames(current, index) / CHAIN_FPS,
        },
        { ...current.modes, musicVideo: tagFor(current, "scene", index) },
      );
    },
    [workflow, chain, jobs, tagFor],
  );

  // Send every window that has no take, in order, one submit at a time. The
  // ref holds the windows sent but not yet in the history, so a re-render
  // in between does not send one twice.
  const pending = useRef<Set<number>>(new Set());
  const busy = useRef(false);
  useEffect(() => {
    if (!project || project.paused || !workflow || busy.current) return;
    for (const index of [...pending.current]) if (windowJobs[index]) pending.current.delete(index);
    const waiting = states.flatMap((state, index) =>
      state === "waiting" && !pending.current.has(index) ? [index] : [],
    );
    if (waiting.length === 0) return;
    busy.current = true;
    setSending(true);
    setError(null);
    void (async () => {
      try {
        for (const index of waiting) {
          if (live.current?.id !== project.id || live.current.paused) return;
          pending.current.add(index);
          const promptId = await submitWindow(project, index);
          if (!promptId) {
            pending.current.delete(index);
            setError(`Part ${index + 1} was refused. See the message above, then press Resume.`);
            setProject((current) => (current ? { ...current, paused: true } : current));
            return;
          }
        }
      } finally {
        busy.current = false;
        setSending(false);
      }
    })();
  }, [project, workflow, states, windowJobs, submitWindow]);

  const start = useCallback(
    (values: Record<string, ParamValue>, modes: SubmitModes) => {
      if (!workflow || !chain) return;
      const seconds = Number(values[chain.lengthParam]);
      if (!(seconds > 0)) {
        setError("The clip's length is not known yet. Wait for its preview to load, then try again.");
        return;
      }
      const seed = Number(values.seed);
      const prompt = String(values.prompt ?? "").trim();
      setError(null);
      pending.current.clear();
      setProject({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        // One seed for every window, fixed now, so a random seed does not
        // make each part a different remix.
        values: { ...values, seed: Number.isInteger(seed) && seed >= 0 ? seed : randomSeed() },
        modes,
        windows: chainWindows(seconds),
        seconds,
        title: prompt ? prompt.slice(0, 80) : "Remix",
        createdAt: Date.now(),
      });
    },
    [workflow, chain],
  );

  /** Un-pause, and send every failed window again. */
  const resume = useCallback(() => {
    if (!project) return;
    setError(null);
    const now = Date.now();
    const redoneAt = { ...project.redoneAt };
    states.forEach((state, index) => {
      if (state === "failed") redoneAt[index] = now;
    });
    setProject({ ...project, paused: false, redoneAt });
  }, [project, states]);

  /** Cancel every window still queued or running and send no more until Resume. */
  const stop = useCallback(async () => {
    if (!project) return;
    setProject({ ...project, paused: true });
    for (const job of windowJobs) {
      if (job && (job.phase === "queued" || job.phase === "running")) await jobs.cancel(job.promptId);
    }
  }, [project, windowJobs, jobs]);

  const redo = useCallback(
    (index: number) => {
      if (!project) return;
      setProject({
        ...project,
        paused: false,
        redoneAt: { ...project.redoneAt, [index]: Date.now() },
        seeds: { ...project.seeds, [index]: randomSeed() },
      });
    },
    [project],
  );

  const join = useCallback(async () => {
    if (!project || !chain) return;
    if (!stitchWorkflow) {
      setError("The join workflow is not available, so the parts cannot be joined here.");
      return;
    }
    const source = String(project.values[chain.clipParam] ?? "");
    const sound = chain.keepsClipSound;
    const keepsClip =
      sound !== undefined && String(project.values[sound.param] ?? sound.fallback) === sound.value;
    const soundtrack = keepsClip && source && !isSilentClip(source) ? source : "";
    const clips = windowJobs.map((job, index) => {
      const file = clipRef(job);
      if (!file) return null;
      // A take on H3's grid can run a frame or two past its window; the join
      // keeps the window, so the next part starts where this one should end.
      const planned = windowFrames(project, index) / CHAIN_FPS;
      const saved = job?.outputs.find((output) => clipRef(job)?.endsWith(`${output.filename} [output]`));
      const measured = saved?.metadata?.duration;
      const seconds = typeof measured === "number" && measured > 0 ? Math.min(measured, planned) : planned;
      return soundtrack ? { file, seconds, from: project.windows[index].start / CHAIN_FPS } : { file, seconds };
    });
    if (clips.some((clip) => clip === null)) {
      setError("Every part needs a finished take before they can be joined.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const promptId = await jobs.submit(
        stitchWorkflow,
        { scenes: JSON.stringify(clips), soundtrack, prompt: `Remix: ${project.title}` },
        { derivedFrom: windowJobs[0]?.promptId, musicVideo: tagFor(project, "join") },
      );
      if (!promptId) setError("The join was refused. See the message above.");
    } finally {
      setSending(false);
    }
  }, [project, chain, stitchWorkflow, windowJobs, jobs, tagFor]);

  // Join on its own once every window is done, once per set of takes.
  const joinedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project || !stitchWorkflow || windowJobs.length === 0) return;
    if (!windowJobs.every((job) => job?.phase === "done")) return;
    const takes = windowJobs.map((job) => job!.promptId).join(",");
    if (joinJob || joinedFor.current === takes) return;
    joinedFor.current = takes;
    void join();
  }, [project, stitchWorkflow, windowJobs, joinJob, join]);

  const clear = useCallback(() => {
    pending.current.clear();
    setProject(null);
    setError(null);
  }, []);

  return { project, windowJobs, states, joinJob, sending, error, start, resume, stop, join, redo, clear };
}
