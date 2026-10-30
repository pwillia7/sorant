import { leadingReferences, referenceKeep } from "@/lib/workflows/minimax-common";
import type { ParamValue } from "@/lib/workflows/types";
import {
  clock,
  renderSeconds,
  SCENES_HEADING,
  shotBrief,
  type OutlineScene,
  type SceneWindow,
  type ShotRequest,
} from "./scenes";

/**
 * One music video in progress, as the browser keeps it.
 *
 * The scenes and the stitch are ordinary jobs — submitted, polled, kept in the
 * history and retried like any other run — so this holds only what ties them
 * together: where each scene sits in the song, what it was asked to show, and
 * which job made it. Kept in localStorage beside the jobs, so a reload in the
 * middle of a forty-scene render picks up where it was.
 */
export interface MusicVideoProject {
  id: string;
  createdAt: number;
  /** The song as ComfyUI's input directory names it. */
  song: string;
  songSeconds: number;
  /** The form values the plan was made from. Every scene run starts from them. */
  values: Record<string, ParamValue>;
  /** The planning run, while it is running and after. */
  planPromptId?: string;
  /**
   * The run that writes each scene's shot from the outline, once the plan is
   * in. Absent on a project planned before shots were written separately.
   */
  shotsPromptId?: string;
  /** The planner's few sentences on the whole video, which every shot is written against. */
  concept?: string;
  scenes: ProjectScene[];
  /**
   * How the referenced subjects look, fixed once for the whole video: the
   * planner's, until someone edits it. Empty without pictures, and absent on a
   * project planned before there was one. See `sceneValues`.
   */
  look?: string;
  /** The run that joins the scenes, once every one of them has a clip. */
  stitchPromptId?: string;
  /** Set once someone asks for the upscaled video; the join of it follows. */
  upscaleRequested?: boolean;
  /** The run that joins the upscaled scenes. */
  upscaledStitchPromptId?: string;
  /**
   * The shorter side the scenes are upscaled to. Fixed when the first one is
   * sent, so a scene upscaled later — a redo, or one that failed — comes out
   * the same size as the rest and the join has one size to work with.
   */
  upscaleSize?: number;
  /**
   * The frame-rate multiplier the scenes are upscaled with — 1 keeps H3's 24
   * fps, 2 makes 48 with RIFE in-betweens. Fixed with the size, for the same
   * reason: one scene at a different rate would stutter against the rest.
   */
  upscaleFrameRate?: number;
}

/**
 * The sizes a music video can be upscaled to, and roughly what each costs:
 * seconds of work per second of song on the 3090 with RTX Video Super
 * Resolution, the upscale and the join of the upscaled scenes together. From
 * 5-second scenes: 1080 px about 15 s to upscale; 4K about 49 s, and a 4K
 * join of two of them took under 30 s more (2026-10-23).
 *
 * The first is the default. A 4K song is a big file — about 5 MB a second, so
 * nearly a gigabyte for three minutes.
 */
export const MUSIC_VIDEO_UPSCALE_SIZES = [
  { px: 1080, secondsPerSecond: 4 },
  { px: 2160, secondsPerSecond: 13 },
] as const;

/**
 * The frame rates a music video can be upscaled to: H3's own 24 fps, or 48
 * with a RIFE frame made between every pair. `timeFactor` is what the
 * in-betweens add to the upscale's time; RIFE's cost grows with the picture,
 * so it is measured per size.
 */
export const MUSIC_VIDEO_FRAME_RATES = [
  { multiplier: 1, label: "24 fps", timeFactor: { 1080: 1, 2160: 1 } },
  { multiplier: 2, label: "48 fps", timeFactor: { 1080: 1.7, 2160: 1.6 } },
] as const;

export interface ProjectScene extends SceneWindow, Partial<OutlineScene> {
  /** What happens in it: written from the outline, until someone edits it. */
  shot: string;
  /** The job that rendered it, if it has been submitted. */
  promptId?: string;
  /** The run rewriting its shot from its outline line, while it runs. */
  rewritePromptId?: string;
  /** How many times it has been put back after a transient gateway failure. */
  retries?: number;
  /** The job that upscaled its clip, if the video has been upscaled. */
  upscalePromptId?: string;
}

/**
 * The scenes the planner has to fill, with each one's place in the song and
 * how loud it is.
 *
 * Its own param on the plan graph rather than written under the idea: a song
 * of forty scenes is two thousand characters of list, and appended to the idea
 * it counted against the idea's limit, so an idea well under it was refused.
 */
export function sceneList(scenes: SceneWindow[]): string {
  const lines = scenes.map((scene, index) => `${index + 1}. ${sceneLine(scene)}`);
  return `${SCENES_HEADING}

The song is cut into ${scenes.length} scenes:

${lines.join("\n")}`;
}

function describeEnergy(energy: number): string {
  if (energy < 0.35) return "quiet";
  if (energy < 0.6) return "medium";
  if (energy < 0.8) return "loud";
  return "very loud";
}

/** One scene's line of the scene list. */
export function sceneLine(scene: SceneWindow): string {
  const seconds = (scene.end - scene.start).toFixed(1);
  return `${clock(scene.start)}–${clock(scene.end)} (${seconds} s), loudness ${describeEnergy(scene.energy)}`;
}

export interface Plan {
  look: string;
  concept: string;
  /** One per scene, in order; blank where the reply had nothing for it. */
  outline: OutlineScene[];
  /**
   * Finished shots, from a reply in the shape the planner used to write — a
   * `shot` per scene. A plan with these needs no shots written.
   */
  shots: string[];
}

/**
 * The outline out of the planner's reply.
 *
 * Forgiving about everything but the count: a fence around the JSON, a
 * sentence before it, a trailing comma — all things a model does — are got
 * past. So is JSON broken partway: the local director once wrote a stray quote
 * after one shot of twenty-seven (`.","},{"shot":`), and one bad scene threw
 * away the other twenty-six. When the whole will not parse, each entry is read
 * out of the reply on its own.
 *
 * Each entry is placed by its own `scene` number where it has one, so a reply
 * that skipped or doubled a scene puts the rest where they belong rather than
 * one along. Before the planner numbered them it got the count wrong on four
 * plans in six, and every scene after the slip was planned for the wrong
 * stretch of the song. A reply with too few is padded and one with too many is
 * cut, since every scene is editable before anything renders and an empty one
 * says plainly what is missing.
 */
export function parsePlan(reply: string, count: number): Plan {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  let entries: Record<string, unknown>[] = [];
  let look = "";
  let concept = "";
  if (start !== -1 && end > start) {
    const body = reply.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
    try {
      const parsed = JSON.parse(body) as {
        look?: unknown;
        concept?: unknown;
        scenes?: Array<Record<string, unknown> | string>;
      };
      entries = (parsed.scenes ?? []).map((scene) =>
        typeof scene === "string" ? { shot: scene } : (scene ?? {}),
      );
      look = typeof parsed.look === "string" ? parsed.look.trim() : "";
      concept = typeof parsed.concept === "string" ? parsed.concept.trim() : "";
    } catch {
      entries = readEntries(body);
      look = stringField(body, "look");
      concept = stringField(body, "concept");
    }
  }
  if (entries.length === 0) {
    // Not JSON at all: one scene per numbered line, if it numbered them.
    entries = reply
      .split("\n")
      .map((line) => line.match(/^\s*\d+[.)]\s*(.+)$/)?.[1] ?? "")
      .filter(Boolean)
      .map((shot) => ({ shot }));
  }

  const placed: Array<Record<string, unknown> | undefined> = new Array(count);
  const numbered = entries.every((entry) => Number.isInteger(entry.scene));
  entries.forEach((entry, index) => {
    const at = numbered ? Number(entry.scene) - 1 : index;
    if (at >= 0 && at < count && !placed[at]) placed[at] = entry;
  });

  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return {
    look,
    concept,
    outline: Array.from(placed, (entry) => ({
      part: text(entry?.part),
      sings: entry?.sings === true,
      place: text(entry?.place),
      happens: text(entry?.happens),
    })),
    shots: Array.from(placed, (entry) => text(entry?.shot)),
  };
}

/**
 * Each scene entry of a reply whose JSON is broken, read field by field.
 * An entry runs from one `"scene":` (or `"shot":`, in the older shape) to the
 * next.
 */
function readEntries(body: string): Record<string, unknown>[] {
  const marker = /"scene"\s*:\s*\d+/.test(body) ? /"scene"\s*:\s*\d+/g : /"shot"\s*:/g;
  const starts = [...body.matchAll(marker)].map((match) => match.index ?? 0);
  return starts.map((at, index) => {
    const chunk = body.slice(at, starts[index + 1] ?? body.length);
    const scene = chunk.match(/"scene"\s*:\s*(\d+)/);
    return {
      ...(scene ? { scene: Number(scene[1]) } : {}),
      part: stringField(chunk, "part"),
      sings: /"sings"\s*:\s*true/.test(chunk),
      place: stringField(chunk, "place"),
      happens: stringField(chunk, "happens"),
      shot: stringField(chunk, "shot"),
    };
  });
}

function stringField(body: string, name: string): string {
  const found = body.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return found ? unescapeJson(found[1]).trim() : "";
}

/** Whether the outline has anything to write a shot from. */
export const outlined = (scene: Partial<OutlineScene>) => Boolean(scene.place || scene.happens);

/** What a scene says when no shot was written for it: its outline line. */
export function outlineShot(scene: Partial<OutlineScene>): string {
  return [scene.place, scene.happens]
    .map((part) => part?.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean)
    .map((part) => `${part!.charAt(0).toUpperCase()}${part!.slice(1)}.`)
    .join(" ");
}

/** The outline as the plan graph takes it back, to write the shots from. */
export function shotRequest(
  project: MusicVideoProject,
  rewrite?: { scene: number; take: number },
): string {
  const request: ShotRequest = {
    ...(rewrite ? { only: [rewrite.scene], take: rewrite.take } : {}),
    concept: project.concept ?? "",
    scenes: project.scenes.map((scene) => ({
      part: scene.part ?? "",
      sings: scene.sings === true,
      place: scene.place ?? "",
      happens: scene.happens ?? "",
      timing: sceneLine(scene),
    })),
  };
  return JSON.stringify(request);
}

/** Each scene's shot, out of the writing run's briefs; blank where it wrote none. */
export function readShots(briefs: Record<string, string>, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    (briefs[shotBrief(index)] ?? "").trim().replace(/^"|"$/g, ""),
  );
}

/**
 * One scene's Reference to Video submission.
 *
 * Starts from the form's own values — every one of them scoped to the scenes
 * shares its id with the scene workflow's control, so it lands on the right
 * one — and sets what is the scene's own: its stretch of the song, locked in;
 * its length; its shot; its seed.
 *
 * The prompt carries the whole video's idea as well as the scene, marked as
 * background, so each scene's director knows what it is a part of without
 * writing the whole video into one shot.
 *
 * And the look, word for word, ahead of that. Each scene's director describes
 * the people in the pictures for itself, and given the pictures and an idea
 * that described them differently, it settled the conflict a different way in
 * nearly every scene: of one video's 41, 23 dressed the singer as the idea
 * said, 6 as the picture showed, and 11 in both hats at once. One description
 * for all of them is what holds the costume across the cuts.
 */
export function sceneValues(
  project: MusicVideoProject,
  scene: ProjectScene,
  index: number,
  scoped: string[],
): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const id of scoped) {
    if (id in project.values) values[id] = project.values[id];
  }

  const seed = Number(project.values.seed ?? -1);
  const idea = String(project.values.prompt ?? "").trim();
  const look = project.look?.trim() ?? "";
  const lookNote = look
    ? `\n\n(How they look, in this scene and every other one in the video: ${look} — use these words as the observed detail in each subject's definition, and describe them no other way. They outrank anything below about anyone's appearance or how the video is rendered.)`
    : "";
  const shot = `${scene.shot}${lookNote}`;
  return {
    ...values,
    reference_audio: project.song,
    reference_track_seconds: project.songSeconds,
    reference_track_lock: true,
    reference_trim: "match",
    reference_trim_start: scene.start,
    duration: renderSeconds(scene),
    prompt: idea
      ? `${shot}\n\n(This is scene ${index + 1} of ${project.scenes.length} in a music video. The video as a whole: ${idea} — background only; this scene shows only what is described above${look ? ", and its people look only as described above" : ""}.)`
      : shot,
    // A fixed offset per scene from one base, so a whole video can be made
    // again exactly; a random base stays random per scene.
    seed: seed >= 0 ? seed + index : -1,
  };
}

/**
 * The look every scene is handed: what the describer saw in the pictures,
 * then what the planner chose for anything they release.
 *
 * The planner's half is used only when a picture does release something — is
 * set to keep the person and not their clothes, or the clothes and not the
 * person. Told to leave it empty otherwise, the local model wrote the user's
 * idea's outfit into it anyway, which handed the scenes the very conflict the
 * describer exists to keep out.
 */
export function composeLook(
  cast: string | undefined,
  planned: string,
  values: Record<string, ParamValue>,
  pictures: number,
): string {
  const filled = leadingReferences(values, pictures);
  let releases = false;
  for (let index = 1; index <= filled; index += 1) {
    const keep = referenceKeep(values, index);
    if (keep === "identity" || keep === "costume") releases = true;
  }
  // Told to write nothing for a picture with nobody in it, the local
  // describer has still written "There is no man in this picture." — which
  // would then be handed to every scene as how someone looks.
  // A style picture's paragraph is about no one, and is kept whatever it says.
  const described = (cast ?? "")
    .split(/\n\s*\n/)
    .filter((paragraph) => /^\s*the style of\b/i.test(paragraph) || !/\b(is|are) no (one|body|person|people|man|woman|character)\b|\bnobody\b/i.test(paragraph))
    .join("\n\n")
    .trim();
  return [described, releases ? planned.trim() : ""].filter(Boolean).join("\n\n");
}

/** A JSON string's contents, as written between its quotes. */
function unescapeJson(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Whether a scene is still to be (re)submitted. */
export const needsRender = (scene: ProjectScene): boolean => !scene.promptId;
