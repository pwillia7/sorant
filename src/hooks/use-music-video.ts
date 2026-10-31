"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobsController } from "@/hooks/use-jobs";
import { api, ApiError, getToken } from "@/lib/client";
import {
  isActive,
  lostTrackOf,
  type Job,
  type JobOutput,
  type MusicVideoPart,
  type MusicVideoTag,
} from "@/lib/jobs";
import { analyseSong } from "@/lib/music-video/beats";
import {
  lostScenes,
  lostUpscales,
  recoverScenes,
  recoverUpscales,
} from "@/lib/music-video/recover";
import {
  composeLook,
  outlined,
  outlineShot,
  parsePlan,
  readShots,
  sceneHasReferences,
  sceneList,
  sceneValues,
  shotRequest,
  storySceneList,
  type MusicVideoProject,
  type ProjectScene,
  type SceneReference,
  type SceneVoice,
  type VoiceOpener,
} from "@/lib/music-video/project";
import {
  CAST_BRIEF,
  INSTRUMENTAL_PARAM,
  keptFrames,
  MUSIC_VIDEO_PICTURES,
  PLAN_BRIEF,
  splitSong,
  STORY_SCENE_SECONDS,
  storyWindows,
  type PlannedKind,
} from "@/lib/music-video/scenes";
import { FPS } from "@/lib/workflows/minimax-common";
import type { RunModes } from "@/lib/workflows/modes";
import { defaultValuesFor, type ParamValue, type WorkflowSummary } from "@/lib/workflows/types";

/**
 * The music video, from a song in the form to a finished file.
 *
 * Four steps, each waiting on the one before: cut the song (here, in the
 * browser), plan the scenes (a run of the plan graph), render them (one
 * Reference to Video job each, all queued at once — they do not depend on each
 * other), and join them (a run of the stitch graph). The scenes, the plan and
 * the stitch are jobs
 * like any other, so their progress, their history entries and the box's queue
 * are the job list's business; this only remembers which jobs belong to which
 * scene, and moves the project along as they finish.
 *
 * One project at a time, kept in localStorage so a reload part-way through a
 * long render finds it again. Starting a new plan replaces it — the old scenes
 * stay in the history.
 */

/** Where each kind keeps its project: one of each at a time. */
const STORAGE_KEYS: Record<PlannedKind, string> = {
  music: "sorant-music-video",
  story: "sorant-multi-scene",
};

export type MusicVideoStep =
  | "idle"
  | "cutting"
  | "planning"
  | "planned"
  | "rendering"
  | "rendered"
  | "stitching"
  | "done";

export interface MusicVideoController {
  /** Which planned video this is, before there is a project to say. */
  kind: PlannedKind;
  project: MusicVideoProject | null;
  step: MusicVideoStep;
  error: string | null;
  /** Each scene's job, where it has one. */
  jobFor: (scene: ProjectScene) => Job | undefined;
  /** Cut the song and ask for a plan. */
  plan: () => Promise<void>;
  editShot: (index: number, shot: string) => void;
  /** Change a scene's outline line. Its shot changes only when rewritten. */
  editOutline: (
    index: number,
    patch: Partial<Pick<ProjectScene, "place" | "happens" | "sings" | "lines">>,
  ) => void;
  /** Write one scene's shot again from its outline line. */
  rewriteShot: (index: number) => Promise<void>;
  editLook: (look: string) => void;
  /**
   * Give a scene pictures of its own, or with none, put it back on the
   * video's. Read when the scene is next sent, like every other edit. Takes
   * an update of the scene's current pictures as well, for edits that can
   * land together: two pictures found missing on the box in one render.
   */
  editReferences: (
    index: number,
    references:
      | SceneReference[]
      | undefined
      | ((current: SceneReference[] | undefined) => SceneReference[] | undefined),
  ) => void;
  /**
   * A multi-scene video's: give a scene voices of its own, or with none, put
   * it back on the video's. An update as well, as for the pictures.
   */
  editVoices: (
    index: number,
    voices:
      | SceneVoice[]
      | undefined
      | ((current: SceneVoice[] | undefined) => SceneVoice[] | undefined),
  ) => void;
  /** Which voice's speaker opens a scene; with none, it is read off the lines. */
  editOpener: (index: number, opener: VoiceOpener | undefined) => void;
  /** A multi-scene video's: how long a scene runs. The scenes after it move along. */
  editLength: (index: number, seconds: number) => void;
  /** Queue every scene that has no job, or whose job failed. */
  renderAll: () => Promise<void>;
  /** The finished video, once the stitch has run. */
  final: Job | undefined;
  /** The upscaled version, once every scene has been upscaled and rejoined. */
  upscaledFinal: Job | undefined;
  /** Each scene's upscale job, where it has one. */
  upscaleFor: (scene: ProjectScene) => Job | undefined;
  /** How far the upscale has got: scenes done, and whether it is running. */
  upscale: { done: number; active: boolean; joining: boolean };
  /**
   * Upscale every scene that has no upscale yet, then join the upscaled clips.
   * The size is the shorter side, and only the first call's counts: see
   * `upscaleSize` on the project.
   */
  upscaleAll: (size: number, frameRate: number) => Promise<void>;
  /**
   * Join the upscaled scenes. It happens on its own once every scene is
   * upscaled; this is for after that join failed.
   */
  joinUpscaled: () => Promise<void>;
  /**
   * Render another take of a scene, on a fresh seed, and use it. The earlier
   * takes are kept to pick from: see `takesFor`.
   */
  redo: (index: number) => Promise<void>;
  /**
   * Every take of a scene worth offering, oldest first: the finished ones, and
   * whichever the scene is using or still has in the queue.
   */
  takesFor: (index: number) => Job[];
  /** Use an earlier (or later) take of a scene instead of the one it has. */
  pickTake: (index: number, promptId: string) => void;
  stitch: () => Promise<void>;
  /**
   * How many scenes and upscales this device lost track of — abandoned when
   * the server went quiet, or forgotten by a ComfyUI restart — and so may have
   * clips on the box.
   */
  lostCount: number;
  /** Whether `recover` is looking. */
  recovering: boolean;
  /** Look on the box for the lost clips. See `recoverScenes` and `recoverUpscales`. */
  recover: () => Promise<void>;
  /** What the last `recover` found, to say so. */
  recoveryNote: string | null;
  clear: () => void;
  dismissError: () => void;
}

interface Options {
  /** Which planned video this is. Each keeps its own project. */
  kind: PlannedKind;
  workflow: WorkflowSummary | undefined;
  sceneWorkflow: WorkflowSummary | undefined;
  /** What a scene with nothing to build from runs as. See `scenes.bare`. */
  bareSceneWorkflow?: WorkflowSummary;
  stitchWorkflow: WorkflowSummary | undefined;
  upscaleWorkflow: WorkflowSummary | undefined;
  values: Record<string, ParamValue>;
  modes: RunModes & { lowVram?: boolean; localDirector?: string; rewriteModel?: string };
  jobs: JobsController;
  /** Whether ComfyUI is answering, so lost upscales can be sent again. */
  online: boolean;
}

function readProject(kind: PlannedKind): MusicVideoProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[kind]);
    return raw ? (JSON.parse(raw) as MusicVideoProject) : null;
  } catch {
    return null;
  }
}

function writeProject(kind: PlannedKind, project: MusicVideoProject | null): void {
  try {
    if (project) localStorage.setItem(STORAGE_KEYS[kind], JSON.stringify(project));
    else localStorage.removeItem(STORAGE_KEYS[kind]);
  } catch {
    // Storage full or disabled: the project lives for this tab only.
  }
}

/** The gateway's own "try again" answers, as the director node reports them. */
const TRANSIENT = /AI Gateway request failed \(HTTP (429|5\d\d)\)/;
const MAX_RETRIES = 2;

/**
 * The video a job saved, not a preview of what it read: a run that loads clips
 * reports each loader's input too. See collectOutputs.
 */
const savedVideo = (job: Job | undefined) =>
  job?.phase === "done"
    ? job.outputs.find(
        (file) => (file.type || "output") === "output" && /\.(mp4|webm|mov|mkv)$/i.test(file.filename),
      )
    : undefined;

/**
 * The copy of a clip a join reads. The song replaces every scene's own sound,
 * but trimming a scene to its window re-encodes the sound it has, and FFmpeg's
 * AAC encoder can abort on a soundtrack it decoded without complaint — taking
 * ComfyUI down with it, every time the join is sent (one 4K upscale of 13,
 * 2026-10-30). VHS keeps the silent file beside each "-audio" one it writes,
 * so an upscale is joined from that and has no sound to re-encode.
 */
const SOUNDTRACKED = /^(.+_\d{5,})-audio(\.[a-z0-9]+)$/i;
const silentCopy = (output: JobOutput): JobOutput => ({
  ...output,
  filename: output.filename.replace(SOUNDTRACKED, "$1$2"),
});

/**
 * The copy of a clip with its sound, for a multi-scene video, whose join
 * keeps every scene's own. An upscale reports the silent file and the one
 * with sound; a scene's own run, only the one.
 */
const soundtracked = (job: Job | undefined): JobOutput | undefined =>
  job?.phase === "done"
    ? (job.outputs.find(
        (file) => (file.type || "output") === "output" && SOUNDTRACKED.test(file.filename),
      ) ?? savedVideo(job))
    : undefined;

/** What a run of this project is tagged with in the history. See `Job.musicVideo`. */
const tagFor = (
  project: MusicVideoProject,
  part: MusicVideoPart,
  scene?: number,
): MusicVideoTag => ({
  projectId: project.id,
  part,
  scene,
  title: String(project.values.prompt ?? "").trim() || undefined,
  scenes: project.scenes.length,
  ...(project.kind === "story" ? { kind: "story" as const } : {}),
});

/**
 * A story's scenes laid end to end again from their lengths, after the plan
 * gave them theirs or someone changed one.
 */
function retimed(scenes: ProjectScene[]): ProjectScene[] {
  const windows = storyWindows(scenes.map((scene) => scene.seconds));
  return scenes.map((scene, index) => ({ ...scene, ...windows[index] }));
}

const failed = (job: Job | undefined) =>
  job !== undefined && ["error", "cancelled", "unknown"].includes(job.phase);

export function useMusicVideo({
  kind,
  workflow,
  sceneWorkflow,
  bareSceneWorkflow,
  stitchWorkflow,
  upscaleWorkflow,
  values,
  modes,
  jobs,
  online,
}: Options): MusicVideoController {
  const [project, setProject] = useState<MusicVideoProject | null>(() => readProject(kind));
  const [busy, setBusy] = useState<"cutting" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => writeProject(kind, project), [kind, project]);

  // Runs this project submitted before runs were tagged with it, found by the
  // ids it kept. A redo it has since replaced is no longer among them; the
  // history still files that one with the video, through what it was made from.
  const { tagMusicVideo } = jobs;
  useEffect(() => {
    if (!project) return;
    const tags: Record<string, MusicVideoTag> = {};
    if (project.planPromptId) tags[project.planPromptId] = tagFor(project, "plan");
    if (project.stitchPromptId) tags[project.stitchPromptId] = tagFor(project, "join");
    if (project.upscaledStitchPromptId) {
      tags[project.upscaledStitchPromptId] = tagFor(project, "upscaled-join");
    }
    project.scenes.forEach((scene, index) => {
      if (scene.promptId) tags[scene.promptId] = tagFor(project, "scene", index);
      if (scene.upscalePromptId) {
        tags[scene.upscalePromptId] = tagFor(project, "upscale", index);
      }
    });
    tagMusicVideo(tags);
  }, [project, tagMusicVideo]);

  const byId = useMemo(
    () => new Map(jobs.jobs.map((job) => [job.promptId, job])),
    [jobs.jobs],
  );
  const jobFor = useCallback(
    (scene: ProjectScene) => (scene.promptId ? byId.get(scene.promptId) : undefined),
    [byId],
  );
  const upscaleFor = useCallback(
    (scene: ProjectScene) =>
      scene.upscalePromptId ? byId.get(scene.upscalePromptId) : undefined,
    [byId],
  );

  /** This project's runs of one part for one scene, oldest first. */
  const partRuns = useCallback(
    (part: MusicVideoPart, index: number) =>
      project
        ? jobs.jobs
            .filter(
              (job) =>
                job.musicVideo?.projectId === project.id &&
                job.musicVideo.part === part &&
                job.musicVideo.scene === index,
            )
            .sort((a, b) => a.submittedAt - b.submittedAt)
        : [],
    [project, jobs.jobs],
  );

  // Read off the history rather than kept on the project: every scene run is
  // tagged with its scene, so a take retried from the history is one too.
  const takesFor = useCallback(
    (index: number) => {
      const using = project?.scenes[index]?.promptId;
      return partRuns("scene", index).filter(
        (job) => job.phase === "done" || job.promptId === using || isActive(job),
      );
    },
    [project, partRuns],
  );

  const pickTake = useCallback(
    (index: number, promptId: string) => {
      if (!project || project.scenes[index]?.promptId === promptId) return;
      // An upscale made of this take before, if one is still good, so going
      // back to a take does not mean upscaling it again.
      const upscale = partRuns("upscale", index)
        .filter((job) => job.derivedFrom === promptId && !failed(job))
        .at(-1);
      setProject({
        ...project,
        // Both joins were of the take being put down.
        stitchPromptId: undefined,
        upscaledStitchPromptId: undefined,
        scenes: project.scenes.map((scene, i) =>
          i === index
            ? { ...scene, promptId, upscalePromptId: upscale?.promptId }
            : scene,
        ),
      });
    },
    [project, partRuns],
  );

  // The plan arriving. Read off the plan job's brief, which is the planner's
  // outline, and folded into the scenes — once, since every edit after that
  // is the user's. The shots are written from it next, below.
  const planJob = project?.planPromptId ? byId.get(project.planPromptId) : undefined;
  const shotsJob = project?.shotsPromptId ? byId.get(project.shotsPromptId) : undefined;
  useEffect(() => {
    if (!project || !planJob) return;
    if (project.scenes.some((scene) => scene.shot || outlined(scene))) return;
    if (planJob.phase === "done") {
      const briefs = planJob.briefs ?? {};
      const reply = briefs[PLAN_BRIEF] ?? Object.values(briefs)[0] ?? "";
      const plan = parsePlan(reply, project.scenes.length);
      const look = composeLook(briefs[CAST_BRIEF], plan.look, project.values, MUSIC_VIDEO_PICTURES);
      // The plan is a step, not a result: it has no file, and a history entry
      // that never shows anything is clutter.
      jobs.remove(planJob.promptId);

      // A plan with its shots already in it — the shape the planner wrote
      // before shots were their own step — needs nothing more.
      if (plan.shots.some((shot) => shot)) {
        setProject({
          ...project,
          look,
          scenes: project.scenes.map((scene, index) => ({ ...scene, shot: plan.shots[index] })),
        });
        return;
      }
      // Finished but unreadable would otherwise read as still planning, for
      // ever: the step waits for a scene with a shot.
      if (!plan.outline.some(outlined)) {
        setError("The plan came back in a form that could not be read. Plan it again.");
        setProject({ ...project, planPromptId: undefined });
        return;
      }
      const scenes = project.scenes.map((scene, index) => ({
        ...scene,
        ...plan.outline[index],
        // An instrumental is told to the planner, and held here too: it
        // cannot hear the song, and its guess is what this switch overrules.
        ...(project.values[INSTRUMENTAL_PARAM] === true ? { sings: false } : {}),
        // And a story with the dialogue off, for one stray line.
        ...(project.kind === "story" && project.values.dialogue === false ? { lines: "" } : {}),
      }));
      setProject({
        ...project,
        look,
        concept: plan.concept,
        // A story's scenes are as long as the planner made them.
        scenes: project.kind === "story" ? retimed(scenes) : scenes,
      });
    } else if (failed(planJob)) {
      setError(planJob.error ?? "The plan did not come back. Try again.");
      setProject({ ...project, planPromptId: undefined });
    }
  }, [project, planJob, jobs]);

  /** One run of the plan graph that writes shots from the outline: all of them, or one. */
  const submitShots = useCallback(
    (current: MusicVideoProject, rewrite?: { scene: number; take: number }) =>
      workflow
        ? jobs.submit(
            workflow,
            {
              ...current.values,
              prompt:
                String(current.values.prompt ?? "").trim() ||
                (current.kind === "story" ? "A short story told in a few scenes." : "A performance video for this song."),
              scene_list:
                current.kind === "story" ? storySceneList(current.scenes.length) : sceneList(current.scenes),
              scene_outline: shotRequest(current, rewrite),
            },
            {
              localDirector: modes.localDirector,
              rewriteModel: modes.rewriteModel,
              musicVideo: tagFor(current, "plan"),
            },
          )
        : Promise.resolve(null),
    [workflow, jobs, modes.localDirector, modes.rewriteModel],
  );

  // An outline with no shots and nothing writing them: send it to be written.
  // Its own step rather than part of the plan's arrival, so a reload between
  // the two — the outline kept, the submission lost — picks up here.
  const shotsAskedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project || project.shotsPromptId || !workflow) return;
    if (project.scenes.some((scene) => scene.shot) || !project.scenes.some(outlined)) return;
    if (shotsAskedFor.current === project.id) return;
    shotsAskedFor.current = project.id;
    const id = project.id;
    void submitShots(project).then((promptId) => {
      setProject((previous) =>
        previous?.id !== id
          ? previous
          : promptId
            ? { ...previous, shotsPromptId: promptId }
            : // Not queued: the outline stands in for the shots.
              {
                ...previous,
                scenes: previous.scenes.map((scene) => ({ ...scene, shot: outlineShot(scene) })),
              },
      );
    });
  }, [project, workflow, submitShots]);

  // The shots arriving. A scene the writers left blank gets its outline line,
  // which is something to render or edit rather than an empty box.
  useEffect(() => {
    if (!project || !shotsJob || project.scenes.some((scene) => scene.shot)) return;
    const done = shotsJob.phase === "done";
    if (!done && !failed(shotsJob)) return;
    const shots = done ? readShots(shotsJob.briefs ?? {}, project.scenes.length) : [];
    if (!done) {
      setError(
        `${shotsJob.error ?? "The shots were not written."} Each scene has its line of the outline instead — edit them, or plan again.`,
      );
    }
    setProject({
      ...project,
      scenes: project.scenes.map((scene, index) => ({
        ...scene,
        shot: shots[index] || outlineShot(scene),
      })),
    });
    jobs.remove(shotsJob.promptId);
  }, [project, shotsJob, jobs]);

  // A scene's shot rewritten from its line arriving, into that scene alone.
  useEffect(() => {
    if (!project) return;
    project.scenes.forEach((scene, index) => {
      const job = scene.rewritePromptId ? byId.get(scene.rewritePromptId) : undefined;
      if (!job || (job.phase !== "done" && !failed(job))) return;
      const shot = job.phase === "done" ? readShots(job.briefs ?? {}, project.scenes.length)[index] : "";
      if (!shot) setError(job.error ?? `Scene ${index + 1}'s shot was not rewritten.`);
      setProject((previous) =>
        previous
          ? {
              ...previous,
              scenes: previous.scenes.map((s, i) =>
                i === index ? { ...s, shot: shot || s.shot, rewritePromptId: undefined } : s,
              ),
            }
          : previous,
      );
      jobs.remove(job.promptId);
    });
  }, [project, byId, jobs]);

  /** Write one scene's shot again from its outline line, as it reads now. */
  const rewriteShot = useCallback(
    async (index: number) => {
      if (!project || project.scenes[index]?.rewritePromptId) return;
      setError(null);
      const promptId = await submitShots(project, {
        scene: index,
        take: Math.floor(Math.random() * 1_000_000),
      });
      if (!promptId) return;
      setProject((previous) =>
        previous?.id !== project.id
          ? previous
          : {
              ...previous,
              scenes: previous.scenes.map((scene, i) =>
                i === index ? { ...scene, rewritePromptId: promptId } : scene,
              ),
            },
      );
    },
    [project, submitShots],
  );

  const stitchJob = project?.stitchPromptId ? byId.get(project.stitchPromptId) : undefined;
  const final = stitchJob?.phase === "done" ? stitchJob : undefined;
  const upscaledStitchJob = project?.upscaledStitchPromptId
    ? byId.get(project.upscaledStitchPromptId)
    : undefined;
  const upscaledFinal = upscaledStitchJob?.phase === "done" ? upscaledStitchJob : undefined;

  const step: MusicVideoStep = useMemo(() => {
    if (busy) return busy;
    if (!project) return "idle";
    if (final) return "done";
    if (stitchJob && !failed(stitchJob)) return "stitching";
    if (!project.scenes.some((scene) => scene.shot)) {
      return project.planPromptId || project.shotsPromptId ? "planning" : "idle";
    }
    const sceneJobs = project.scenes.map(jobFor);
    if (sceneJobs.every((job) => job?.phase === "done")) return "rendered";
    if (sceneJobs.some((job) => job && !failed(job))) return "rendering";
    return "planned";
  }, [busy, project, jobFor, final, stitchJob]);

  // A stitch that failed says so and lets the button be pressed again.
  useEffect(() => {
    if (!project || !stitchJob || !failed(stitchJob)) return;
    setError(stitchJob.error ?? "The scenes could not be joined.");
    setProject({ ...project, stitchPromptId: undefined });
  }, [project, stitchJob]);
  useEffect(() => {
    if (!project || !upscaledStitchJob || !failed(upscaledStitchJob)) return;
    setError(upscaledStitchJob.error ?? "The upscaled scenes could not be joined.");
    setProject({ ...project, upscaledStitchPromptId: undefined });
  }, [project, upscaledStitchJob]);

  const plan = useCallback(async () => {
    if (!workflow) return;
    setError(null);

    // A story has no song to cut: as many scenes as were asked for, each at
    // a placeholder length until the planner gives it its own.
    if (kind === "story") {
      const count = Math.max(2, Math.round(Number(values.scene_count ?? 6)));
      const windows = storyWindows(Array.from({ length: count }, () => STORY_SCENE_SECONDS.initial));
      const next: MusicVideoProject = {
        id: Date.now().toString(36),
        createdAt: Date.now(),
        kind: "story",
        song: "",
        songSeconds: windows.at(-1)?.end ?? 0,
        values: { ...values },
        scenes: windows.map((window) => ({ ...window, shot: "" })),
      };
      const promptId = await jobs.submit(
        workflow,
        {
          ...values,
          prompt: String(values.prompt ?? "").trim() || "A short story told in a few scenes.",
          scene_list: storySceneList(count),
        },
        {
          localDirector: modes.localDirector,
          rewriteModel: modes.rewriteModel,
          musicVideo: tagFor(next, "plan"),
        },
      );
      if (promptId) setProject({ ...next, planPromptId: promptId });
      return;
    }

    const song = String(values.reference_audio ?? "").trim();
    if (!song) {
      setError("Add the song first.");
      return;
    }

    setBusy("cutting");
    try {
      // The song from ComfyUI's input directory, where the upload put it.
      const query = new URLSearchParams({ filename: song, subfolder: "", type: "input" });
      const headers = new Headers();
      const token = getToken();
      if (token) headers.set("x-app-token", token);
      const response = await fetch(`/api/media?${query}`, { headers });
      if (!response.ok) throw new Error("Could not load the song to cut it.");
      const analysis = await analyseSong(await response.arrayBuffer());

      const windows = splitSong(
        analysis.seconds,
        analysis.onsets,
        {
          min: Number(values.scene_min_seconds ?? 4),
          max: Number(values.scene_max_seconds ?? 9),
        },
        analysis.loudness,
      );

      const next: MusicVideoProject = {
        id: Date.now().toString(36),
        createdAt: Date.now(),
        song,
        songSeconds: analysis.seconds,
        values: { ...values },
        scenes: windows.map((window) => ({ ...window, shot: "" })),
      };

      const promptId = await jobs.submit(
        workflow,
        {
          ...values,
          prompt: String(values.prompt ?? "").trim() || "A performance video for this song.",
          scene_list: sceneList(windows),
        },
        {
              localDirector: modes.localDirector,
              rewriteModel: modes.rewriteModel,
              musicVideo: tagFor(next, "plan"),
            },
      );
      if (!promptId) return;
      setProject({ ...next, planPromptId: promptId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cut the song.");
    } finally {
      setBusy(null);
    }
  }, [kind, workflow, values, jobs, modes.localDirector, modes.rewriteModel]);

  const editShot = useCallback((index: number, shot: string) => {
    setProject((previous) =>
      previous
        ? {
            ...previous,
            scenes: previous.scenes.map((scene, i) => (i === index ? { ...scene, shot } : scene)),
          }
        : previous,
    );
  }, []);

  /** Change a scene's outline line: where it is, what happens, whether anyone sings. */
  const editOutline = useCallback(
    (index: number, patch: Partial<Pick<ProjectScene, "place" | "happens" | "sings" | "lines">>) => {
      setProject((previous) =>
        previous
          ? {
              ...previous,
              scenes: previous.scenes.map((scene, i) => (i === index ? { ...scene, ...patch } : scene)),
            }
          : previous,
      );
    },
    [],
  );

  /** How the subjects look in every scene. Read by each scene as it is sent. */
  const editLook = useCallback((look: string) => {
    setProject((previous) => (previous ? { ...previous, look } : previous));
  }, []);

  const editReferences = useCallback<MusicVideoController["editReferences"]>((index, references) => {
    setProject((previous) =>
      previous
        ? {
            ...previous,
            scenes: previous.scenes.map((scene, i) =>
              i === index
                ? {
                    ...scene,
                    references: typeof references === "function" ? references(scene.references) : references,
                  }
                : scene,
            ),
          }
        : previous,
    );
  }, []);

  /** One scene of the project changed, from what it is now. */
  const editScene = useCallback(
    (index: number, change: (scene: ProjectScene) => ProjectScene) => {
      setProject((previous) =>
        previous
          ? {
              ...previous,
              scenes: previous.scenes.map((scene, i) => (i === index ? change(scene) : scene)),
            }
          : previous,
      );
    },
    [],
  );

  const editVoices = useCallback<MusicVideoController["editVoices"]>(
    (index, voices) =>
      editScene(index, (scene) => ({
        ...scene,
        voices: typeof voices === "function" ? voices(scene.voices) : voices,
      })),
    [editScene],
  );

  const editOpener = useCallback(
    (index: number, opener: VoiceOpener | undefined) => editScene(index, (scene) => ({ ...scene, opener })),
    [editScene],
  );

  const editLength = useCallback((index: number, seconds: number) => {
    setProject((previous) =>
      previous
        ? {
            ...previous,
            // The join was of the scenes as they were timed.
            stitchPromptId: undefined,
            upscaledStitchPromptId: undefined,
            scenes: retimed(previous.scenes.map((scene, i) => (i === index ? { ...scene, seconds } : scene))),
          }
        : previous,
    );
  }, []);

  /** Which form ids every scene run inherits — the ones scoped to scenes. */
  const scoped = useMemo(
    () => (workflow?.params ?? []).filter((param) => param.scope === "scenes").map((param) => param.id),
    [workflow],
  );

  const submitScene = useCallback(
    async (current: MusicVideoProject, index: number, fresh: boolean) => {
      const scene = current.scenes[index];
      // Nothing for Reference to Video to build from: Text to Video, with
      // the values it has controls for.
      const bare = !sceneHasReferences(current, scene);
      const target = bare ? bareSceneWorkflow : sceneWorkflow;
      if (!target) return null;
      const values = sceneValues(current, scene, index, scoped);
      if (bare) {
        const known = new Set(target.params.map((param) => param.id));
        for (const id of Object.keys(values)) if (!known.has(id)) delete values[id];
      }
      if (fresh) values.seed = -1;
      // Under the first scene in the history, so a video's scenes read as one
      // family rather than forty unrelated clips.
      const first = current.scenes[0]?.promptId;
      return jobs.submit(target, values, {
        ...modes,
        derivedFrom: index > 0 ? first : undefined,
        musicVideo: tagFor(current, "scene", index),
      });
    },
    [sceneWorkflow, bareSceneWorkflow, scoped, jobs, modes],
  );

  /**
   * A scene whose brief never got written because the gateway was briefly
   * unavailable is put straight back in the queue, twice at most.
   *
   * Over a song's worth of scenes the rewrite is called a dozen times or more,
   * and a 503 on one of them — seen on the first full test, four scenes in a
   * row — would otherwise leave a hole for someone to notice and fill. Only
   * the gateway's own transient answers count: anything else that fails a
   * scene is worth a person looking at.
   */
  const retrying = useRef(new Set<string>());
  useEffect(() => {
    if (!project || !sceneWorkflow) return;
    project.scenes.forEach((scene, index) => {
      const job = jobFor(scene);
      if (!job || job.phase !== "error" || !TRANSIENT.test(job.error ?? "")) return;
      if ((scene.retries ?? 0) >= MAX_RETRIES || retrying.current.has(job.promptId)) return;
      retrying.current.add(job.promptId);
      void submitScene(project, index, false).then((promptId) => {
        if (!promptId) return;
        setProject((previous) =>
          previous
            ? {
                ...previous,
                scenes: previous.scenes.map((s, i) =>
                  i === index ? { ...s, promptId, retries: (s.retries ?? 0) + 1 } : s,
                ),
              }
            : previous,
        );
      });
    });
  }, [project, sceneWorkflow, jobFor, submitScene]);

  const renderAll = useCallback(async () => {
    if (!project) return;
    setError(null);
    // One at a time, so the queue receives them in song order and each id is
    // recorded as it arrives — a refusal part-way leaves the rest unsubmitted
    // rather than half-tracked.
    let current = project;
    for (let index = 0; index < current.scenes.length; index += 1) {
      const scene = current.scenes[index];
      const job = jobFor(scene);
      if (scene.promptId && !failed(job)) continue;
      const promptId = await submitScene(current, index, failed(job));
      if (!promptId) {
        setError(`Scene ${index + 1} was refused — see the message above.`);
        break;
      }
      current = {
        ...current,
        scenes: current.scenes.map((s, i) => (i === index ? { ...s, promptId } : s)),
      };
      setProject(current);
    }
  }, [project, jobFor, submitScene]);

  const redo = useCallback(
    async (index: number) => {
      if (!project) return;
      const old = jobFor(project.scenes[index]);
      if (old && (old.phase === "queued" || old.phase === "running")) {
        await jobs.cancel(old.promptId);
      }
      const promptId = await submitScene(project, index, true);
      if (!promptId) return;
      setProject((previous) =>
        previous
          ? {
              ...previous,
              stitchPromptId: undefined,
              upscaledStitchPromptId: undefined,
              // Its upscale was of the take being put down, which stays in
              // `takesFor` with that upscale for picking back up.
              scenes: previous.scenes.map((s, i) =>
                i === index ? { ...s, promptId, upscalePromptId: undefined } : s,
              ),
            }
          : previous,
      );
    },
    [project, jobFor, jobs, submitScene],
  );

  /**
   * Join a set of clips, one per scene, under the song. The same graph for the
   * original takes and for their upscales: each is trimmed to its scene's
   * window by time, so a clip at another size or frame rate joins the same way.
   */
  const join = useCallback(
    async (
      current: MusicVideoProject,
      pick: (scene: ProjectScene) => Job | undefined,
      part: "join" | "upscaled-join",
    ) => {
      if (!stitchWorkflow) return null;
      const story = current.kind === "story";
      const clips = current.scenes.map((scene) => {
        // A story keeps each scene's sound; a music video lays the song over
        // silent ones.
        const saved = story ? soundtracked(pick(scene)) : savedVideo(pick(scene));
        if (!saved) return null;
        const output = story ? saved : silentCopy(saved);
        // As LoadVideo names a file in another of ComfyUI's folders.
        const path = output.subfolder ? `${output.subfolder}/${output.filename}` : output.filename;
        return { file: `${path} [${output.type || "output"}]`, seconds: keptFrames(scene) / FPS };
      });
      if (clips.some((clip) => clip === null)) {
        setError("Every scene needs a finished clip before they can be joined.");
        return null;
      }
      const idea = String(current.values.prompt ?? "").trim();
      return jobs.submit(
        stitchWorkflow,
        story
          ? { scenes: JSON.stringify(clips), prompt: `Multi-scene video: ${idea}` }
          : {
              scenes: JSON.stringify(clips),
              song: current.song,
              song_seconds: Math.round(current.songSeconds * 1000) / 1000,
              prompt: `Music video: ${idea}`,
            },
        // Under the first scene in the history, with the rest of the video.
        { derivedFrom: current.scenes[0]?.promptId, musicVideo: tagFor(current, part) },
      );
    },
    [stitchWorkflow, jobs],
  );

  const stitch = useCallback(async () => {
    if (!project) return;
    setError(null);
    const promptId = await join(project, jobFor, "join");
    if (promptId) setProject({ ...project, stitchPromptId: promptId });
  }, [project, join, jobFor]);

  /**
   * Upscale the video: every scene through the upscale workflow at its
   * defaults bar the size, then a join of the upscaled clips — a second video beside the
   * original rather than in place of it.
   *
   * Scene by scene rather than the joined file, for two reasons. The upscale
   * takes a minute of video at most, and most songs are longer. And a scene is
   * a job of a few minutes: a failure, or a reset of the box, costs that scene
   * and not hours of work, and a redone scene needs only its own upscale again.
   */
  const sendUpscales = useCallback(async (
    size: number,
    frameRate: number,
    /** Send only these scenes, rather than every one without a good upscale. */
    only?: number[],
  ) => {
    if (!project || !upscaleWorkflow) return;
    setError(null);
    let current: MusicVideoProject = {
      ...project,
      upscaleRequested: true,
      upscaleSize: project.upscaleSize ?? size,
      // A project upscaled before the choice existed kept the clip's own rate.
      upscaleFrameRate:
        project.upscaleFrameRate ?? (project.upscaleSize ? 1 : frameRate),
      upscaleResumed: only
        ? [...new Set([...(project.upscaleResumed ?? []), ...only])]
        : project.upscaleResumed,
    };
    setProject(current);
    for (let index = 0; index < current.scenes.length; index += 1) {
      const scene = current.scenes[index];
      const existing = upscaleFor(scene);
      if (only ? !only.includes(index) : scene.upscalePromptId && !failed(existing)) continue;
      const output = savedVideo(jobFor(scene));
      if (!output) {
        setError(`Scene ${index + 1} has no finished clip to upscale yet.`);
        return;
      }
      try {
        // Into ComfyUI's input folder, where the upscale's loader reads — the
        // same copy the Upscale button makes.
        const { ref } = await api<{ ref: string }>("/api/remix", {
          method: "POST",
          body: JSON.stringify({
            filename: output.filename,
            subfolder: output.subfolder,
            type: output.type,
          }),
        });
        const promptId = await jobs.submit(
          upscaleWorkflow,
          {
            ...defaultValuesFor(upscaleWorkflow),
            source_video: ref,
            shorter_side: current.upscaleSize ?? size,
            frame_rate: String(current.upscaleFrameRate ?? 1),
          },
          { derivedFrom: scene.promptId, musicVideo: tagFor(current, "upscale", index) },
        );
        if (!promptId) return;
        current = {
          ...current,
          upscaledStitchPromptId: undefined,
          scenes: current.scenes.map((s, i) =>
            i === index ? { ...s, upscalePromptId: promptId } : s,
          ),
        };
        setProject(current);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : `Scene ${index + 1} could not be sent to the upscale.`);
        return;
      }
    }
  }, [project, upscaleWorkflow, upscaleFor, jobFor, jobs]);
  const upscaleAll = useCallback(
    (size: number, frameRate: number) => sendUpscales(size, frameRate),
    [sendUpscales],
  );

  // Once every scene's upscale is done, join them — once. The person asked for
  // an upscaled video, not for forty upscaled clips. Once per set of upscales,
  // too: a join that failed waits for `joinUpscaled` rather than going again,
  // because one that took ComfyUI down would go again the moment it was back
  // up, and take it down again, for as long as the page stayed open.
  const joiningUpscaled = useRef(false);
  const upscaleJobs = project?.scenes.map(upscaleFor) ?? [];
  const upscalesDone = upscaleJobs.filter((job) => job?.phase === "done").length;
  const allUpscaled =
    project !== null && upscaleJobs.length > 0 && upscalesDone === upscaleJobs.length;
  const upscaleSet = upscaleJobs.map((job) => job?.promptId ?? "").join(",");
  const joinUpscaledNow = useCallback(
    async (current: MusicVideoProject) => {
      if (joiningUpscaled.current) return;
      joiningUpscaled.current = true;
      setProject((previous) => (previous ? { ...previous, upscaledJoinTried: upscaleSet } : previous));
      try {
        const promptId = await join(current, upscaleFor, "upscaled-join");
        if (promptId) {
          setProject((previous) => (previous ? { ...previous, upscaledStitchPromptId: promptId } : previous));
        }
      } finally {
        joiningUpscaled.current = false;
      }
    },
    [join, upscaleFor, upscaleSet],
  );
  useEffect(() => {
    if (!project?.upscaleRequested || !allUpscaled || project.upscaledStitchPromptId) return;
    if (project.upscaledJoinTried === upscaleSet) return;
    void joinUpscaledNow(project);
  }, [project, allUpscaled, upscaleSet, joinUpscaledNow]);
  const joinUpscaled = useCallback(async () => {
    if (!project || !allUpscaled || project.upscaledStitchPromptId) return;
    setError(null);
    await joinUpscaledNow(project);
  }, [project, allUpscaled, joinUpscaledNow]);

  // Upscales ComfyUI forgot — it restarted, or the box did — picked back up
  // once it answers again: the finished ones found by name, the rest sent
  // again, each scene once. A real failure is left for the button, which says
  // what went wrong.
  const resuming = useRef(false);
  const upscaling = upscaleJobs.some((job) => job !== undefined && isActive(job));
  const { recover: recoverJobs } = jobs;
  useEffect(() => {
    if (!online || !project?.upscaleRequested || upscaling || resuming.current) return;
    const lost = project.scenes.flatMap((scene, index) => {
      const job = upscaleFor(scene);
      return job && lostTrackOf(job) && !project.upscaleResumed?.includes(index) ? [index] : [];
    });
    if (lost.length === 0) return;
    resuming.current = true;
    void (async () => {
      try {
        const { found } = await recoverUpscales(project, jobs.jobs).catch(() => ({
          found: {} as Record<string, never>,
        }));
        recoverJobs(found);
        const resend = lost.filter((index) => {
          const promptId = project.scenes[index].upscalePromptId;
          return !promptId || !found[promptId];
        });
        if (resend.length > 0 && project.upscaleSize) {
          await sendUpscales(project.upscaleSize, project.upscaleFrameRate ?? 1, resend);
        }
      } finally {
        resuming.current = false;
      }
    })();
  }, [online, project, upscaling, upscaleFor, jobs.jobs, recoverJobs, sendUpscales]);

  const lostCount = project
    ? lostScenes(project, (id) => byId.get(id)).length +
      lostUpscales(project, (id) => byId.get(id)).length
    : 0;
  const [recovering, setRecovering] = useState(false);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const recover = useCallback(async () => {
    if (!project) return;
    setError(null);
    setRecoveryNote(null);
    setRecovering(true);
    try {
      // The upscales first: found by name, they need nothing the scenes'
      // search can fail for.
      const upscales = await recoverUpscales(project, jobs.jobs);
      recoverJobs(upscales.found);
      const scenes = await recoverScenes(project, jobs.jobs);
      recoverJobs(scenes.found);
      const lost = scenes.lost + upscales.lost;
      const stillMissing = scenes.stillMissing + upscales.stillMissing;
      const count = lost - stillMissing;
      setRecoveryNote(
        stillMissing === 0
          ? `Found all ${lost} on the ComfyUI machine.`
          : `Found ${count} of ${lost} on the ComfyUI machine. Render or Upscale sends the rest again.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not look for the lost scenes.");
    } finally {
      setRecovering(false);
    }
  }, [project, jobs.jobs, recoverJobs]);

  const clear = useCallback(() => {
    setProject(null);
    setError(null);
    setRecoveryNote(null);
  }, []);

  return {
    kind,
    project,
    step,
    error,
    jobFor,
    plan,
    editShot,
    editOutline,
    rewriteShot,
    editLook,
    editReferences,
    editVoices,
    editOpener,
    editLength,
    renderAll,
    redo,
    takesFor,
    pickTake,
    final,
    upscaledFinal,
    upscaleFor,
    upscale: {
      done: upscalesDone,
      active: upscaleJobs.some((job) => job && (job.phase === "queued" || job.phase === "running")),
      joining: Boolean(upscaledStitchJob && !upscaledFinal && !failed(upscaledStitchJob)),
    },
    upscaleAll,
    joinUpscaled,
    stitch,
    lostCount,
    recovering,
    recover,
    recoveryNote,
    clear,
    dismissError: useCallback(() => setError(null), []),
  };
}
