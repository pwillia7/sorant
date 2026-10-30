import type { OutputFile } from "@/app/api/outputs/route";
import { api } from "@/lib/client";
import { lostTrackOf, type Job, type JobOutput } from "@/lib/jobs";
import type { MusicVideoProject } from "./project";
import { renderSeconds } from "./scenes";

/**
 * Finding the clips of scenes this device lost track of.
 *
 * A scene whose run was abandoned when the server went quiet, or forgotten by
 * a ComfyUI restart, often finished anyway: the clip is on the box, and nothing
 * left says which run wrote it. Three things tie a clip back to its scene
 * without that record. The save node numbers its files, so the clips after the
 * last one this device does know are the candidates. The queue runs in the
 * order the scenes were sent, so their clips come in that order. And a scene's
 * length is fixed before it renders, so a clip of another length belongs to
 * something else — another run sharing the save name, sent while the video
 * was rendering.
 *
 * A scene with no clip that fits is left as it was, for Render to send again.
 *
 * Every search matches the scenes found by earlier ones over again, beside the
 * ones still missing. The answer only holds for the whole sequence: a scene
 * that once missed its own clip took the next one of its length, which was
 * another scene's, and a later search that finds the missed clip has to be
 * able to move both.
 */

const COUNTED = /^(.+)_(\d{5,})_\.([a-z0-9]+)$/i;
const VIDEO = /\.(mp4|webm|mov|mkv)$/i;

/**
 * How far the box's clock and this one may disagree. A clip is only a scene's
 * if it was written after the scene was sent, and the two times come from
 * different machines.
 */
const CLOCK_SLACK_MS = 5 * 60_000;

/**
 * How close a clip's length has to be to the scene's. H3 lengths come in steps
 * of 17 frames, about 0.7 s, so this tells one step from the next while
 * allowing for a container that rounds its duration, or a soundtrack a little
 * longer than the picture.
 */
const LENGTH_TOLERANCE_S = 0.2;

export interface RecoveryResult {
  /** Outputs to finish each lost scene job with, by prompt id. */
  found: Record<string, { outputs: JobOutput[]; completedAt: number }>;
  /** How many scenes were lost before looking. */
  lost: number;
  /** How many of those are lost still. */
  stillMissing: number;
}

/** The scenes of a project whose runs this device lost track of, in the order they were sent. */
export function lostScenes(
  project: MusicVideoProject,
  jobFor: (promptId: string) => Job | undefined,
): Job[] {
  return project.scenes
    .map((scene) => (scene.promptId ? jobFor(scene.promptId) : undefined))
    .filter((job): job is Job => job !== undefined && lostTrackOf(job))
    .sort((a, b) => a.submittedAt - b.submittedAt);
}

export async function recoverScenes(
  project: MusicVideoProject,
  jobs: Job[],
): Promise<RecoveryResult> {
  const byId = new Map(jobs.map((job) => [job.promptId, job]));
  const missing = lostScenes(project, (id) => byId.get(id));
  if (missing.length === 0) return { found: {}, lost: 0, stillMissing: 0 };
  const lost = project.scenes
    .map((scene) => (scene.promptId ? byId.get(scene.promptId) : undefined))
    .filter((job): job is Job => job !== undefined && (lostTrackOf(job) || job.recovered === true))
    .sort((a, b) => a.submittedAt - b.submittedAt);

  // The newest numbered clip this device knows of from the same workflow,
  // sent no later than the first lost scene: the queue ran that one first, so
  // everything the lost scenes wrote is numbered after it.
  const first = lost[0];
  let anchor: { output: JobOutput; counter: number } | undefined;
  for (const job of jobs) {
    // Not one an earlier search found: that is a guess, and one of the scenes
    // being matched again.
    if (job.phase !== "done" || job.recovered || job.workflowId !== first.workflowId) continue;
    if (job.submittedAt > first.submittedAt) continue;
    for (const output of job.outputs) {
      if ((output.type || "output") !== "output" || !VIDEO.test(output.filename)) continue;
      const match = COUNTED.exec(output.filename);
      if (!match) continue;
      const counter = Number(match[2]);
      if (!anchor || counter > anchor.counter) anchor = { output, counter };
    }
  }
  if (!anchor) {
    throw new Error(
      "There is no earlier finished clip from this workflow to search on from, so the lost scenes cannot be found.",
    );
  }

  const query = new URLSearchParams({
    after: anchor.output.filename,
    subfolder: anchor.output.subfolder ?? "",
  });
  const { files } = await api<{ files: OutputFile[] }>(`/api/outputs?${query}`);

  // A file some other run in the history already reported is that run's. One
  // only found by an earlier search is up for matching again.
  const claimed = new Set(
    jobs
      .filter((job) => !job.recovered)
      .flatMap((job) => job.outputs.map((output) => `${output.subfolder}/${output.filename}`)),
  );
  const candidates = files.filter(
    (file) =>
      !claimed.has(`${file.subfolder}/${file.filename}`) &&
      file.modifiedAt >= first.submittedAt - CLOCK_SLACK_MS,
  );

  const found: RecoveryResult["found"] = {};
  let next = 0;
  for (const job of lost) {
    const scene = project.scenes.find((s) => s.promptId === job.promptId);
    if (!scene) continue;
    const expected = renderSeconds(scene);
    for (let index = next; index < candidates.length; index += 1) {
      const file = candidates[index];
      if (file.modifiedAt < job.submittedAt - CLOCK_SLACK_MS) continue;
      if (file.seconds === null || Math.abs(file.seconds - expected) > LENGTH_TOLERANCE_S) {
        continue;
      }
      found[job.promptId] = {
        outputs: [
          { url: file.url, filename: file.filename, subfolder: file.subfolder, type: file.type },
        ],
        completedAt: file.modifiedAt,
      };
      next = index + 1;
      break;
    }
  }

  return {
    found,
    lost: missing.length,
    stillMissing: missing.filter((job) => !found[job.promptId]).length,
  };
}

/**
 * The scenes' upscales this device lost track of, which can be looked for.
 *
 * Simpler than a scene's: an upscale writes under a file name of its own run
 * (`Job.runKey`), so its file is found by name rather than matched by order
 * and length. One sent before the name was kept has nothing to look for.
 */
export function lostUpscales(
  project: MusicVideoProject,
  jobFor: (promptId: string) => Job | undefined,
): Job[] {
  return project.scenes
    .map((scene) => (scene.upscalePromptId ? jobFor(scene.upscalePromptId) : undefined))
    .filter((job): job is Job => job !== undefined && lostTrackOf(job) && Boolean(job.runKey));
}

export async function recoverUpscales(
  project: MusicVideoProject,
  jobs: Job[],
): Promise<RecoveryResult> {
  const byId = new Map(jobs.map((job) => [job.promptId, job]));
  const missing = lostUpscales(project, (id) => byId.get(id));
  const found: RecoveryResult["found"] = {};
  for (const job of missing) {
    const query = new URLSearchParams({ run: job.runKey ?? "" });
    const { files } = await api<{ files: OutputFile[] }>(`/api/outputs?${query}`);
    if (files.length === 0) continue;
    found[job.promptId] = {
      outputs: files.map(({ url, filename, subfolder, type }) => ({ url, filename, subfolder, type })),
      completedAt: Math.max(...files.map((file) => file.modifiedAt)),
    };
  }
  return {
    found,
    lost: missing.length,
    stillMissing: missing.filter((job) => !found[job.promptId]).length,
  };
}
