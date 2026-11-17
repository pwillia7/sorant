import {
  leadingReferences,
  referenceKeep,
  referencesIn,
  referenceValues,
} from "@/lib/workflows/minimax-common";
import type { ParamValue } from "@/lib/workflows/types";
import {
  clock,
  MAX_SHOTS_PER_SCENE,
  MAX_STORY_SCENES,
  MUSIC_VIDEO_PICTURES,
  renderSeconds,
  SCENES_HEADING,
  shotBrief,
  STORY_SCENE_SECONDS,
  type OutlineScene,
  type PlannedKind,
  type PlanRevision,
  type SceneLengths,
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
  /** Absent on a music video, which every project was before there was a second kind. */
  kind?: PlannedKind;
  /** The song as ComfyUI's input directory names it. Empty for a multi-scene video. */
  song: string;
  /** The song's length; for a multi-scene video, its scenes' together. */
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
  /**
   * The planner revising the whole plan to an ask, while it runs. The ask
   * waits in `revising` for the shots to be written to it once it is in.
   */
  revisePromptId?: string;
  revising?: string;
  /**
   * What has been asked of the director, oldest first: of the whole video,
   * or of one scene. Shown back, so asking is a conversation rather than a
   * box that forgets.
   */
  asks?: DirectorAsk[];
  /**
   * The outline, look and shots as they were before the last ask changed
   * them, for putting back. One step: an ask is a small thing to redo.
   */
  beforeAsk?: AskSnapshot;
  /** The run that joins the scenes, once every one of them has a clip. */
  stitchPromptId?: string;
  /** Set once someone asks for the upscaled video; the join of it follows. */
  upscaleRequested?: boolean;
  /** The run that joins the upscaled scenes. */
  upscaledStitchPromptId?: string;
  /**
   * The upscales the join last went ahead with on its own, as their prompt ids
   * in scene order. It goes ahead once per set: a join that fails is offered
   * again rather than sent again, since one that took ComfyUI down with it
   * would do so every time the box came back.
   */
  upscaledJoinTried?: string;
  /**
   * The scenes whose upscale was sent again on its own after ComfyUI forgot
   * it. Once each: a scene whose upscale is what brings the box down is left
   * for someone to look at.
   */
  upscaleResumed?: number[];
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
  /**
   * A key for a scene put in by hand, which has no place in the plan to be
   * told apart by. See `addScene`.
   */
  id?: string;
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
  /**
   * The pictures this scene renders from instead of the video's, once someone
   * gives it its own: someone who appears only here, a place, a prop. Absent
   * means the video's, so a change to those still reaches it.
   */
  references?: SceneReference[];
  /** A multi-scene video's: the voices this scene speaks with instead of the video's. */
  voices?: SceneVoice[];
  /**
   * Which voice's speaker has this scene's first line, where it has two. Absent,
   * it is read off the scene's lines. See `openerOf`.
   */
  opener?: VoiceOpener;
  /**
   * For a scene that carries on from the one before: the run of that scene it
   * was rendered from. A new take of the scene before leaves this one carrying
   * on from a clip that is no longer in the video. See `chainStale`.
   */
  continuedFrom?: string;
  /**
   * Asked to render, and waiting for the scene before it to finish first: it
   * starts from that scene's last frames, so it cannot be sent until they exist.
   */
  waiting?: boolean;
}

/** One thing asked of the director. */
export interface DirectorAsk {
  ask: string;
  /** The scene it was asked of, from 0; absent for the whole video. */
  scene?: number;
  at: number;
}

/** What an ask can change, kept to put back. */
export interface AskSnapshot {
  concept?: string;
  look?: string;
  scenes: Array<Pick<ProjectScene, "place" | "happens" | "lines" | "sings" | "part" | "shot">>;
}

/** The outline, look and shots as they stand, for undoing an ask. */
export function askSnapshot(project: MusicVideoProject): AskSnapshot {
  return {
    concept: project.concept,
    look: project.look,
    scenes: project.scenes.map(({ place, happens, lines, sings, part, shot }) => ({
      place,
      happens,
      lines,
      sings,
      part,
      shot,
    })),
  };
}

/**
 * A project with an ask undone: each scene's outline and shot as they were,
 * where the scene is still there. Its renders are left alone — a scene
 * rendered from the revised shot keeps that take until it is rendered again.
 */
export function restoreSnapshot(project: MusicVideoProject, snapshot: AskSnapshot): MusicVideoProject {
  return {
    ...project,
    concept: snapshot.concept,
    look: snapshot.look,
    beforeAsk: undefined,
    scenes: project.scenes.map((scene, index) =>
      snapshot.scenes[index] ? { ...scene, ...snapshot.scenes[index] } : scene,
    ),
  };
}

/**
 * The plan as it stands, in the shape the planner writes it, with the ask:
 * what a revision of the whole video is handed. A story's carries its look,
 * which its planner writes; a music video's look is the describer's, from the
 * pictures, and is left as it is.
 */
export function planRevision(project: MusicVideoProject, ask: string): string {
  const story = project.kind === "story";
  const revision: PlanRevision = {
    ask: ask.trim(),
    plan: {
      concept: project.concept ?? "",
      scenes: project.scenes.map((scene, index) =>
        story
          ? {
              scene: index + 1,
              place: scene.place ?? "",
              happens: scene.happens ?? "",
              lines: scene.lines ?? "",
              seconds: Math.round(scene.end - scene.start),
              ...(carriesOn(project, index) ? { continues: true } : {}),
            }
          : {
              scene: index + 1,
              part: scene.part ?? "",
              sings: scene.sings === true,
              place: scene.place ?? "",
              happens: scene.happens ?? "",
            },
      ),
      ...(story ? { look: project.look ?? "" } : {}),
    },
  };
  return JSON.stringify(revision);
}

/**
 * A story's look after a revision: the paragraphs about pictures as they
 * were — the describer wrote those from the pictures, and the planner is told
 * not to touch them — and everything else as the revision has it. A revision
 * that came back with no look keeps the old one whole.
 */
export function revisedLook(current: string | undefined, revised: string): string {
  const paragraphs = (text: string | undefined) =>
    (text ?? "")
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
  const pictured = (paragraph: string) => /<\s*picture\s+\d+\s*>|^the style of\b/i.test(paragraph);
  const fresh = paragraphs(revised).filter((paragraph) => !pictured(paragraph));
  if (fresh.length === 0) return current ?? "";
  return [...paragraphs(current).filter(pictured), ...fresh].join("\n\n");
}

/**
 * A recording of how someone sounds, as a scene is handed it: up to two, the
 * Reference to Video slots a scene runs with.
 */
export interface SceneVoice {
  audio: string;
  /** Who speaks with it, in the scene's own words: "Mara", "the old man". */
  owner: string;
  /** Where in the recording its few seconds are taken from. */
  start: number;
  /** How many seconds of it the model hears. */
  seconds: number;
  /** The recording's whole length, as the player measured it; 0 if not yet. */
  length: number;
}

export type VoiceOpener = "first" | "second";

/** How many voices a scene takes: Reference to Video's two slots. */
export const SCENE_VOICES = 2;

/** The form's ids for each voice slot, as Reference to Video names them. */
const VOICE_IDS = [
  {
    audio: "reference_voice",
    owner: "reference_voice_owner",
    start: "reference_voice_start",
    seconds: "reference_voice_seconds",
    length: "reference_voice_length",
  },
  {
    audio: "reference_voice_2",
    owner: "reference_voice_2_owner",
    start: "reference_voice_2_start",
    seconds: "reference_voice_2_seconds",
    length: "reference_voice_2_length",
  },
] as const;
const OPENER_ID = "reference_voice_opener";
/** What Reference to Video takes from a voice when nothing says: 5 seconds. */
const VOICE_SECONDS = 5;

/** The voices every scene speaks with unless it has its own. A second only beside a first. */
export function videoVoices(project: MusicVideoProject): SceneVoice[] {
  const voices: SceneVoice[] = [];
  for (const ids of VOICE_IDS) {
    const audio = String(project.values[ids.audio] ?? "").trim();
    if (!audio) break;
    voices.push({
      audio,
      owner: String(project.values[ids.owner] ?? "").trim(),
      start: Number(project.values[ids.start] ?? 0) || 0,
      seconds: Number(project.values[ids.seconds] ?? VOICE_SECONDS) || VOICE_SECONDS,
      length: Number(project.values[ids.length] ?? 0) || 0,
    });
  }
  return voices;
}

/** A scene's voices: its own, or the video's. */
export const voicesOf = (project: MusicVideoProject, scene: ProjectScene): SceneVoice[] =>
  scene.voices ?? videoVoices(project);

/**
 * Which voice's speaker has the scene's first line. Reference to Video gives
 * the opening line to whichever recording is wired last, and wires the
 * opener's last — so getting this wrong swaps the two voices. Set on the scene
 * when someone has said; otherwise the first line's speaker, matched against
 * whose each voice is.
 */
export function openerOf(scene: ProjectScene, voices: SceneVoice[]): VoiceOpener {
  if (scene.opener) return scene.opener;
  if (voices.length < 2) return "first";
  const speaker = (scene.lines ?? "").split("\n").find((line) => line.includes(":"))?.split(":")[0];
  const name = speaker?.trim().toLowerCase();
  if (!name) return "first";
  const owns = (voice: SceneVoice) => {
    const owner = voice.owner.toLowerCase();
    return owner !== "" && (owner.includes(name) || name.includes(owner));
  };
  return owns(voices[1]) && !owns(voices[0]) ? "second" : "first";
}

/**
 * Whether a scene has anything for Reference to Video to build from. One
 * that does not — a multi-scene video with no pictures and no voices — is a
 * Text to Video run, since Reference to Video refuses a run with nothing.
 */
export function sceneHasReferences(project: MusicVideoProject, scene: ProjectScene): boolean {
  if (project.kind !== "story") return true;
  return (
    (scene.references ?? videoReferences(project)).length > 0 ||
    voicesOf(project, scene).length > 0
  );
}

/** One of a scene's own pictures, as ComfyUI's input directory names it. */
export interface SceneReference {
  image: string;
  keep: string;
}

/** The pictures every scene renders from unless it has its own. */
export function videoReferences(project: MusicVideoProject): SceneReference[] {
  return referencesIn(project.values, MUSIC_VIDEO_PICTURES);
}

/**
 * Whether the video's look is still true of a scene's pictures.
 *
 * The look is written from the video's pictures and names them by slot —
 * "the man in <Picture 1>" — so it holds for a scene whose own pictures
 * still start with the video's, in the same slots and keeping the same
 * things, whatever is added after them. Swap or drop one and the look would
 * describe a picture the scene does not have, so that scene's director is
 * left to describe its own.
 */
export function keepsVideoLook(project: MusicVideoProject, scene: ProjectScene): boolean {
  if (!scene.references) return true;
  return videoReferences(project).every(
    (reference, index) =>
      scene.references?.[index]?.image === reference.image &&
      scene.references[index].keep === reference.keep,
  );
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

/**
 * A multi-scene video's scene list: how many there are — or, with the planner
 * choosing, that the number is its own — and the range the user allows each
 * one. The planner chooses each one's length within it.
 */
export function storySceneList(
  count: number,
  lengths: SceneLengths,
  chooseCount = false,
  oneTake = false,
): string {
  const scenes = chooseCount && oneTake
    ? `The video has as many scenes as its story needs: one, or more, up to ${MAX_STORY_SCENES} at the very most. The whole video is one take, with no cuts, split into scenes only because one render holds no more than the longest a scene may be: a scene is as much of the take as fits in one. Number the scenes from 1 with none skipped.`
    : chooseCount
    ? `The video has as many scenes as its story needs: one, or more, up to ${MAX_STORY_SCENES} at the very most. A scene is one place and one moment, made in one take, and a take can hold up to ${MAX_SHOTS_PER_SCENE} shots: a reveal, a reaction, or a cut to the person being spoken to is a "Cut to:" inside its scene, not a new scene. Only a new place, or a jump in time, needs a new scene. So a story that happens in one place and moment, and fits the longest a scene may be, is one scene — a single take with its cuts — and that is the best way to tell it, since a single take keeps the room, the light and the people exactly the same. Give nothing a scene that only repeats another or fills time; a short idea is a short video. Number the scenes from 1 with none skipped.`
    : count === 1
      ? `The video is one scene long: a single take, with up to ${MAX_SHOTS_PER_SCENE} shots inside it. Return exactly one entry.`
      : `The video is ${count} scenes long. Return exactly ${count} entries.`;
  // The planner choosing may land on one scene, which may be a longer take.
  const singleTake =
    chooseCount && lengths.max < STORY_SCENE_SECONDS.max
      ? ` A video told in one scene is the exception: that one scene may run up to ${STORY_SCENE_SECONDS.max} seconds when its shots fill it.`
      : "";
  const range =
    lengths.min === lengths.max
      ? `Every scene is ${lengths.min} seconds long: give each one exactly that, and plan only what fits in it.`
      : `Each scene is from ${lengths.min} to ${lengths.max} seconds long — no shorter and no longer. Plan only what fits in that.${singleTake}`;
  // The local planner twice wrote "concept" and then "look", with no scenes
  // at all, under a long prompt (2026-11-16); this is the last thing it reads.
  return `${SCENES_HEADING}

${scenes}

${range}

Return "concept", then "scenes" with every scene in it, then "look" last.`;
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
      place: standalonePlace(text(entry?.place)),
      happens: text(entry?.happens),
      ...(Number(entry?.seconds) > 0 ? { seconds: Number(entry?.seconds) } : {}),
      lines: text(entry?.lines),
      continues: entry?.continues === true,
    })),
    shots: Array.from(placed, (entry) => text(entry?.shot)),
  };
}

/**
 * A place sentence with its pointers to other scenes taken out.
 *
 * Each scene sees only its own place, word for word, and the planner is told
 * so — and still wrote "the same concrete floor and yellow grid markings" for
 * a garage it returned to, which the writer turned into "as before". The
 * things are named; the "same" only points at a scene this one cannot see.
 */
export function standalonePlace(place: string): string {
  return place
    .replace(/,?\s*(?:just\s+)?(?:as|like)\s+(?:before|earlier|in (?:the )?(?:scene|shot) \d+|in the (?:first|last|previous|earlier) (?:scene|shot))\b/gi, "")
    .replace(/\b(the|its|their|his|her)\s+same\s+/gi, "$1 ")
    .replace(/\bthe same\s+/gi, "the ")
    .replace(/\s{2,}/g, " ")
    .trim();
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
    const seconds = chunk.match(/"seconds"\s*:\s*(\d+(?:\.\d+)?)/);
    return {
      ...(scene ? { scene: Number(scene[1]) } : {}),
      ...(seconds ? { seconds: Number(seconds[1]) } : {}),
      lines: stringField(chunk, "lines"),
      part: stringField(chunk, "part"),
      sings: /"sings"\s*:\s*true/.test(chunk),
      continues: /"continues"\s*:\s*true/.test(chunk),
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
  rewrite?: { scenes: number[]; take: number; ask?: string },
): string {
  const ask = rewrite?.ask?.trim();
  const request: ShotRequest = {
    ...(rewrite ? { only: rewrite.scenes, take: rewrite.take } : {}),
    ...(rewrite && ask
      ? {
          ask,
          current: Object.fromEntries(
            rewrite.scenes
              .map((index) => [index, project.scenes[index]?.shot?.trim() ?? ""] as const)
              .filter(([, shot]) => shot),
          ),
        }
      : {}),
    concept: project.concept ?? "",
    ...(project.kind === "story" && project.look?.trim() ? { look: project.look.trim() } : {}),
    scenes: project.scenes.map((scene, index) => ({
      part: scene.part ?? "",
      sings: scene.sings === true,
      place: scene.place ?? "",
      happens: scene.happens ?? "",
      ...(project.kind === "story"
        ? {
            lines: scene.lines ?? "",
            timing: `${(scene.end - scene.start).toFixed(1)} s`,
            ...(carriesOn(project, index) ? { continues: true } : {}),
          }
        : { timing: sceneLine(scene) }),
    })),
  };
  return JSON.stringify(request);
}

/** Each scene's shot, out of the writing run's briefs; blank where it wrote none. */
export function readShots(briefs: Record<string, string>, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const shot = (briefs[shotBrief(index)] ?? "").trim();
    // A shot the model put in quotes, and only that: a story's shot can end
    // on a line of dialogue, whose closing quote is its own.
    return /^"[^"]*"$/.test(shot) ? shot.slice(1, -1) : shot;
  });
}

/** The scene workflows' prompt limit (promptParam in minimax-common.ts). */
const SCENE_PROMPT_LIMIT = 8000;

/**
 * One scene's Reference to Video submission.
 *
 * Starts from the form's own values — every one of them scoped to the scenes
 * shares its id with the scene workflow's control, so it lands on the right
 * one — and sets what is the scene's own: its stretch of the song, locked in;
 * its length; its shot; its seed; its pictures, where it has its own.
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
  const whole = keepsVideoLook(project, scene) ? (project.look?.trim() ?? "") : "";
  const look =
    project.kind === "story"
      ? lookForScene(whole, [scene.place, scene.happens, scene.lines, scene.shot].join(" "))
      : whole;
  const lookNote = look
    ? `\n\n(How ${project.kind === "story" ? "the people and things in this scene look, the same in every scene of the video" : "they look, in this scene and every other one in the video"}: ${look} — use these words as the observed detail in each subject's definition, and describe them no other way. They outrank anything below about anyone's appearance or how the video is rendered.)`
    : "";
  const own = scene.references ? referenceValues(scene.references, MUSIC_VIDEO_PICTURES) : {};
  const pictures = leadingReferences({ ...values, ...own }, MUSIC_VIDEO_PICTURES);
  const shot = `${withoutMissingPictures(scene.shot ?? "", pictures)}${lookNote}`;
  const background = (noun: string, note = "") => {
    if (!idea) return `${shot}${note ? `\n\n(${note.trim()})` : ""}`;
    const framed = (about: string) =>
      `${shot}\n\n(This is scene ${index + 1} of ${project.scenes.length} in a ${noun}. The video as a whole: ${about} — background only; this scene shows only what is described above${look ? ", and its people look only as described above" : ""}.${note})`;
    // The idea is background, so it is what gives way when a long look and a
    // long idea together would pass the scene's prompt limit.
    const over = framed(idea).length - SCENE_PROMPT_LIMIT;
    return over > 0 ? framed(`${idea.slice(0, Math.max(0, idea.length - over - 1)).trimEnd()}…`) : framed(idea);
  };
  // A fixed offset per scene from one base, so a whole video can be made
  // again exactly; a random base stays random per scene.
  const sceneSeed = seed >= 0 ? seed + index : -1;

  if (project.kind === "story") {
    const voices = voicesOf(project, scene);
    // The outline's place, word for word, after the shot: each scene's
    // writer and director re-lit it for themselves, and one interview area
    // came back under four different lights in four scenes.
    const place = scene.place?.trim()
      ? ` Where it happens, exactly as every scene set there shows it: ${scene.place.trim().replace(/\.?$/, ".")}`
      : "";
    return {
      ...values,
      ...own,
      ...voiceValues(voices, openerOf(scene, voices)),
      // Its own length, made whole: the join keeps every frame of it.
      duration: renderSeconds(scene),
      // Without lines the scene's director is free to write some, and a
      // silent video would come back talking.
      prompt: background("video", `${place}${scene.lines?.trim() ? "" : " Nobody speaks in this scene, but it has the sound of its place and action, not silence."}`),
      seed: sceneSeed,
    };
  }

  return {
    ...values,
    ...own,
    reference_audio: project.song,
    reference_track_seconds: project.songSeconds,
    reference_track_lock: true,
    reference_trim: "match",
    reference_trim_start: scene.start,
    duration: renderSeconds(scene),
    prompt: background("music video"),
    seed: sceneSeed,
  };
}

/**
 * A story's look, cut to the paragraphs one scene has a use for: the footage,
 * whatever a picture's describer wrote, and each named person or thing the
 * scene's own words mention.
 *
 * Handed every paragraph, the scene's director put everyone in: a pit-lane
 * scene of the driver alone came back with the engineer from the garage
 * standing beside the cockpit, because he was in the list of how people look
 * "in this scene and every other one". A name is found by its last word as
 * well as whole — "the engineer" for "The race engineer", "the car" for "The
 * McLaren car" — so a scene that shortens it still gets its description.
 */
export function lookForScene(look: string, sceneText: string): string {
  const text = ` ${sceneText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const has = (words: string) => words !== "" && text.includes(` ${words} `);
  return lookParagraphs(look)
    .filter((paragraph) => {
      const label = paragraph.match(/^\s*([^:<\n]{1,60}):/)?.[1];
      if (!label) return true;
      const words = label
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/^(the|a|an) /, "");
      if (words === "footage" || words.startsWith("style")) return true;
      return has(words) || has(words.split(" ").at(-1) ?? "");
    })
    .join("\n\n")
    .trim();
}

/**
 * A shot with every mention of a picture the scene does not have taken out.
 *
 * The writers are told to write no picture labels at all, and the local one
 * writes them anyway — harmlessly for a picture that is there, but given two
 * pictures and a third person in the story it called him "the man from
 * Picture 3". H3 has no third picture to bind that to, and drew the man from
 * the first one twice, with the second sat where the third should have been.
 * "the man from Picture 3" becomes "the man"; a bare label, "someone".
 */
export function withoutMissingPictures(shot: string, pictures: number): string {
  const missing = (n: string) => Number(n) > pictures;
  return shot
    .replace(/\s+(?:from|in|of|shown in)\s+(?:the\s+)?<?\s*picture\s+(\d+)(?:\s*>)?/gi, (all, n: string) =>
      missing(n) ? "" : all,
    )
    .replace(/(^|[.!?]\s+)?(?:<\s*)?\bpicture\s+(\d+)(?:\s*>)?/gi, (all, start: string | undefined, n: string) =>
      missing(n) ? `${start ?? ""}${start !== undefined ? "Someone" : "someone"}` : all,
    );
}

/** A scene's voices as Reference to Video's controls, emptying a slot it leaves free. */
function voiceValues(voices: SceneVoice[], opener: VoiceOpener): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  VOICE_IDS.forEach((ids, slot) => {
    const voice = voices[slot];
    values[ids.audio] = voice?.audio ?? "";
    values[ids.owner] = voice?.owner ?? "";
    values[ids.start] = voice?.start ?? 0;
    values[ids.seconds] = voice?.seconds ?? VOICE_SECONDS;
    values[ids.length] = voice?.length ?? 0;
  });
  values[OPENER_ID] = opener;
  return values;
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
  story = false,
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
  if (!story) return [described, releases ? planned.trim() : ""].filter(Boolean).join("\n\n");
  return [described, withoutPictured(storyLook(planned, values, filled), described, values)]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A multi-scene planner's look, kept whole but for what a picture settles.
 *
 * A story's people are mostly in no picture, and its planner describes each
 * of them once, with the footage, for every scene to be handed: with nothing
 * holding them, the 1985 snooker segment's drunk player was five different
 * men in seven scenes, and its presenter four. A paragraph about someone in a
 * picture is kept only where that picture releases their clothes, for the
 * reason above.
 */
function storyLook(planned: string, values: Record<string, ParamValue>, filled: number): string {
  return lookParagraphs(planned)
    .filter((paragraph) => {
      const named = [...paragraph.matchAll(/<\s*picture\s+(\d+)\s*>/gi)].map((match) => Number(match[1]));
      return named.every((index) => {
        if (index > filled) return false;
        const keep = referenceKeep(values, index);
        return keep === "identity" || keep === "costume";
      });
    })
    .join("\n\n")
    .trim();
}

/**
 * A story planner's look without its own description of someone a picture
 * already shows whole.
 *
 * The planner never sees the pictures, and the outline calls the pictured
 * person by a plain name: a driver given in <Picture 1> was "The McLaren
 * driver" in every scene, and the planner described him too — dark visor
 * where the picture's was clear. Both went to every scene, and its director
 * gave him one visor in one scene and both in the next. The describer's
 * "The driver in <Picture 1>" says who the picture holds; a planner paragraph
 * whose name ends in the same word is the same person, and the picture wins.
 */
function withoutPictured(planned: string, described: string, values: Record<string, ParamValue>): string {
  const pictured = new Set<string>();
  for (const match of described.matchAll(/(?:^|\n)\s*the\s+([^\n:<]{1,40}?)\s+(?:in|from|of)\s+<\s*picture\s+(\d+)\s*>/gi)) {
    const keep = referenceKeep(values, Number(match[2]));
    if (keep === "identity" || keep === "costume" || keep === "style") continue;
    const head = match[1].toLowerCase().split(/\s+/).at(-1);
    if (head) pictured.add(head);
  }
  if (pictured.size === 0) return planned;
  return lookParagraphs(planned)
    .filter((paragraph) => {
      const label = paragraph.match(/^\s*([^:<\n]{1,60}):/)?.[1];
      const head = label?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").at(-1);
      return !head || !pictured.has(head);
    })
    .join("\n\n");
}

/**
 * A story look's paragraphs, one per person or thing and one for the footage.
 *
 * A paragraph a line: the local planner separates them with one newline as
 * often as with the blank line it is asked for — and has run them all into
 * one, "...white helmet. The McLaren F1 car: a 2016 ... The footage: ...",
 * which reads as a single paragraph about the first person. So a sentence
 * that opens on a name and a colon starts a new one too.
 */
export function lookParagraphs(look: string): string[] {
  return look
    .split(/\n+|(?<=[.!?])\s+(?=(?:The |A |An )?[\p{Lu}][^.:!?<\n]{0,50}:\s)/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
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

/**
 * Whether a scene is rendered carrying on from the one before it rather than
 * drawn afresh: a multi-scene video's, marked to, and never the first.
 */
export function carriesOn(project: Pick<MusicVideoProject, "kind" | "scenes">, index: number): boolean {
  return project.kind === "story" && index > 0 && project.scenes[index]?.continues === true;
}

/**
 * Whether a scene that carries on was rendered from a take of the scene
 * before that the video no longer uses — a redo, or another take picked — so
 * its first second no longer matches the end of the scene ahead of it.
 */
export function chainStale(project: Pick<MusicVideoProject, "kind" | "scenes">, index: number): boolean {
  const scene = project.scenes[index];
  if (!carriesOn(project, index) || !scene?.promptId) return false;
  return scene.continuedFrom !== project.scenes[index - 1]?.promptId;
}

/** The Extend control a chained scene's run turns on. See minimax-h3-extend.ts. */
export const SEGMENT_ONLY_PARAM = "segment_only";

/** Extend's "Story so far" limit. */
const STORY_LIMIT = 4000;

/**
 * A scene that carries on, as an Extend run of the scene before it: the same
 * prompt, length and seed its own render would have had, handed the earlier
 * clip and its latent tail to start from, and only the new part saved.
 *
 * The story so far is the shots of the scenes this one continues, back to the
 * start of the take, most recent kept when they run long: Extend's director
 * reads them as what the clip already showed, so it keeps who and where
 * without playing any of it again.
 */
export function chainValues(
  project: MusicVideoProject,
  scene: ProjectScene,
  index: number,
  scoped: string[],
  source: { ref: string; tail: string | null },
): Record<string, ParamValue> {
  const own = sceneValues(project, scene, index, scoped);
  const earlier: string[] = [];
  for (let at = index - 1; at >= 0; at -= 1) {
    const shot = project.scenes[at]?.shot?.trim();
    if (shot) earlier.unshift(shot);
    if (!carriesOn(project, at)) break;
  }
  let story = earlier.join("\n\n");
  while (story.length > STORY_LIMIT && earlier.length > 1) {
    earlier.shift();
    story = earlier.join("\n\n");
  }
  return {
    ...own,
    source_video: source.ref,
    // Extend takes the tail only when it is named after the clip; one
    // ComfyUI no longer had (a restart forgets it) starts from the last frame.
    source_tail: source.tail ?? "",
    source_story: story.slice(-STORY_LIMIT),
    [SEGMENT_ONLY_PARAM]: true,
  };
}
