import { effectiveSeconds, FPS } from "@/lib/workflows/minimax-common";

/**
 * Cutting a song into the scenes of a music video.
 *
 * Every scene is its own Reference to Video run with the song locked in under
 * it, made fresh from the same references rather than continued from the scene
 * before. That is what keeps a long video from drifting: nothing is carried
 * from one scene to the next except the pictures the user supplied, so scene
 * forty starts from the same face scene one did. The cuts between them are
 * hard, which is what a music video does anyway.
 *
 * The scenes tile the song exactly — each one's window starts where the last
 * ended — and the stitch reads the song once over the joined picture, so there
 * is no seam in the sound however the picture is cut. A run comes back on H3's
 * frame grid, which is a little longer than the window asked for; the stitch
 * keeps the window and drops the rest.
 */

/**
 * Where the scene list starts in the planner's prompt. The plan graph refuses a
 * prompt without it: that is a submission made before the song was cut.
 */
export const SCENES_HEADING = "THE SCENES";

/**
 * The user's word that the song has no vocal, which the planner cannot work
 * out for itself: it cannot hear the song, and left to guess it has written
 * someone singing through a fully instrumental intro. The plan's arrival holds
 * every scene to it as well (see useMusicVideo), so one stray "sings" in the
 * reply does not put a mouth moving to nothing on screen.
 */
export const INSTRUMENTAL_PARAM = "instrumental";

/**
 * The titles the music video planner's two replies come back under: the scene
 * plan, and how the people in the pictures look. See briefsFrom, which drops
 * the "AI Gateway - " prefix off a node's title.
 */
export const PLAN_BRIEF = "Plan Scenes";
export const CAST_BRIEF = "Describe Cast";

/**
 * The title each scene's shot comes back under, numbered from 1: "Write Shot
 * 7". See `shotBrief`.
 */
export const SHOT_BRIEF = "Write Shot";
export const shotBrief = (index: number) => `${SHOT_BRIEF} ${index + 1}`;

/** What the planner's outline says about one scene. */
export interface OutlineScene {
  /** Where in the song it falls, as the planner reads it: "intro", "chorus". */
  part: string;
  /**
   * Whether anyone on screen sings in it. The planner's guess — it cannot hear
   * the song — from the lyrics' sections and the loudness.
   */
  sings: boolean;
  place: string;
  happens: string;
  /**
   * How long the scene runs, as a multi-scene video's planner chose it. A
   * music video's scenes are as long as the song's cuts, so it has none.
   */
  seconds?: number;
  /**
   * What is said in a multi-scene video's scene, a line per turn as "Name:
   * words"; empty where nobody speaks.
   */
  lines?: string;
}

/**
 * The outline, as the plan graph is handed it back to write the shots from.
 * Each scene carries its line of the scene list, so the writer knows its
 * length and loudness without the list.
 */
export interface ShotRequest {
  concept: string;
  scenes: Array<OutlineScene & { timing: string }>;
  /**
   * Which scenes to write, from 0, when not all of them: one scene rewritten
   * from its edited line, with the rest of the outline still there for it to
   * be written against.
   */
  only?: number[];
  /**
   * Added to the writers' seed. A rewrite of an unchanged line would otherwise
   * be the same request, and ComfyUI would hand back the cached shot.
   */
  take?: number;
}

/**
 * What a planned video is made to: a song, cut on its beats, or a story the
 * planner times scene by scene with each scene's own sound. A project with no
 * kind is a music video, as every project was before there was a second.
 */
export type PlannedKind = "music" | "story";

/**
 * The multi-scene switch that lets the planner decide how many scenes the
 * story needs, with the Scenes slider as the most it may use. On, the project
 * is rebuilt with however many scenes the plan comes back with.
 */
export const CHOOSE_SCENE_COUNT_PARAM = "choose_scene_count";

/** How long a multi-scene video's scene may be: H3's trained range. */
export const STORY_SCENE_SECONDS = { min: 4, max: 15, initial: 8 } as const;

/** The range a multi-scene video's planner is held to unless the form says otherwise. */
export const DEFAULT_STORY_LENGTHS: SceneLengths = { min: 4, max: 10 };

/**
 * How fast a scene's lines may be spoken: about twenty words in fifteen
 * seconds. The scene's own director is held to the same budget (see
 * LENGTH_RULES in minimax-common.ts) — the planner used to be told two and a
 * half words a second, a natural speaking pace, and so handed scenes more
 * lines than the director would let H3 say, which came back slurred or cut.
 */
export const SPOKEN_WORDS_PER_SECOND = 4 / 3;

/** The words a scene's lines say, not counting who says them. */
export function spokenWords(lines: string | undefined): number {
  return (lines ?? "")
    .split("\n")
    .map((line) => line.replace(/^[^:]{1,60}:\s*/, ""))
    .join(" ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * The range from the form's Shortest and Longest scene sliders, with the
 * longest never below the shortest.
 */
export function sceneLengths(
  values: Record<string, unknown>,
  fallback: SceneLengths = DEFAULT_SCENE_LENGTHS,
): SceneLengths {
  const read = (value: unknown, otherwise: number) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : otherwise;
  };
  const min = read(values.scene_min_seconds, fallback.min);
  return { min, max: Math.max(min, read(values.scene_max_seconds, fallback.max)) };
}

/**
 * What a multi-scene outline writes between the shots of one scene: "The man
 * creeps in. Cut to: Jerry, on the sofa, watching him." A scene is one run of
 * the video model, and a run can hold cuts — two views of one place and moment
 * made in one take share its room, its light and its people, which two scenes
 * made apart do not, and cost one run rather than two.
 */
export const CUT_MARK = /\bcut to\s*:/gi;

/** The most shots one scene's take is planned to hold. */
export const MAX_SHOTS_PER_SCENE = 3;

/** The shortest a shot inside a scene is worth: less and the cut reads as a glitch. */
export const MIN_SHOT_SECONDS = 2.5;

/** How many shots an outline line plans for its scene. */
export function sceneShots(happens: string | undefined): number {
  return Math.min(MAX_SHOTS_PER_SCENE, 1 + ((happens ?? "").match(CUT_MARK)?.length ?? 0));
}

/** The separate things an outline line has happen: its sentences, and its shots. */
function sceneBeats(happens: string | undefined): number {
  const beats = (happens ?? "")
    .split(/[.!?;]+|\bcut to\s*:/i)
    .filter((part) => /\p{L}/u.test(part)).length;
  return Math.max(1, sceneShots(happens), beats);
}

/**
 * How long a scene's outline needs, worked out rather than asked for.
 *
 * The planner is told the same arithmetic and is not held to it by anything
 * but this: the local planner handed scenes of one wave and a five-word line
 * nine and ten seconds, and H3 filled the rest with men standing still, and
 * with cuts of its own nobody planned. The rates are what H3 takes to play a
 * beat — about a second and a half for a gesture, a look or an entrance, half
 * a second a word plus a breath between speakers — with a second to settle in.
 */
export function estimatedStorySeconds(happens: string | undefined, lines: string | undefined): number {
  const turns = (lines ?? "").split("\n").filter((line) => /\p{L}/u.test(line)).length;
  const worked = 1 + 1.5 * sceneBeats(happens) + 0.5 * spokenWords(lines) + 0.5 * turns;
  return Math.max(worked, MIN_SHOT_SECONDS * sceneShots(happens));
}

/**
 * How long a planned scene of a multi-scene video runs: the planner's choice
 * where it is no longer than what the outline needs (see estimatedStorySeconds), never too short for its
 * lines at SPOKEN_WORDS_PER_SECOND or its shots, and held to the user's range.
 */
export function plannedStorySeconds(
  scene: { seconds?: number; happens?: string; lines?: string } | undefined,
  lengths: SceneLengths,
): number {
  const estimate = estimatedStorySeconds(scene?.happens, scene?.lines);
  const chosen = Number(scene?.seconds);
  const wanted = Number.isFinite(chosen) && chosen > 0 ? Math.min(chosen, estimate) : estimate;
  const needed = Math.max(
    Math.ceil(spokenWords(scene?.lines) / SPOKEN_WORDS_PER_SECOND),
    MIN_SHOT_SECONDS * sceneShots(scene?.happens),
  );
  return Math.round(Math.min(lengths.max, Math.max(lengths.min, wanted, needed)));
}

/**
 * A multi-scene video's scene length as it is run: the planner's or the
 * user's, held to the range and snapped up to a length H3 makes exactly, so
 * the clip that comes back is the scene and nothing has to be trimmed off it.
 */
export function storySeconds(seconds: number | undefined): number {
  const wanted = Number.isFinite(seconds) ? Number(seconds) : STORY_SCENE_SECONDS.initial;
  const held = Math.min(STORY_SCENE_SECONDS.max, Math.max(STORY_SCENE_SECONDS.min, wanted));
  return effectiveSeconds(held);
}

/**
 * A multi-scene video's scenes laid end to end from their lengths. They have
 * no song to sit against, but the panel shows where each falls, and the join
 * keeps each scene's whole run.
 */
export function storyWindows(lengths: Array<number | undefined>): SceneWindow[] {
  let at = 0;
  return lengths.map((length) => {
    const start = at;
    at = round3(at + storySeconds(length));
    return { start: round3(start), end: at, energy: 0.5 };
  });
}

/** How many reference pictures a music video takes. The plan graph has a loader per slot. */
export const MUSIC_VIDEO_PICTURES = 4;

/** A point in the song worth cutting on, from `analyseBeats`. */
export interface Onset {
  /** Seconds from the start of the song. */
  time: number;
  /** 0–1, relative to the strongest onset in the song. */
  strength: number;
}

export interface SceneWindow {
  /** Seconds into the song this scene starts. */
  start: number;
  /** Seconds into the song this scene ends, and the next one starts. */
  end: number;
  /**
   * How loud the song is across this window, 0–1 relative to its loudest
   * stretch. Given to the planner, which cannot hear the song: a quiet intro
   * and a full chorus want different pictures, and this is the one thing about
   * them the app can measure.
   */
  energy: number;
}

export interface SceneLengths {
  /** The shortest scene, in seconds. */
  min: number;
  /** The longest scene, in seconds. */
  max: number;
}

export const DEFAULT_SCENE_LENGTHS: SceneLengths = { min: 4, max: 9 };

/**
 * The longest a single run may be. H3's trained range tops out at about 15 s,
 * and a last scene is allowed past `max` only as far as this, rather than
 * leaving a sliver of a scene at the end of the song.
 */
export const MAX_RUN_SECONDS = 15;

/**
 * How long a scene's run is: the window, snapped up to the next length H3
 * accepts. Never shorter than the window, so the stitch always has the frames
 * it needs.
 */
export function renderSeconds(window: Pick<SceneWindow, "start" | "end">): number {
  return effectiveSeconds(window.end - window.start);
}

/** The frames of a run the stitch keeps: the window, at the output rate. */
export function keptFrames(window: Pick<SceneWindow, "start" | "end">): number {
  return Math.round((window.end - window.start) * FPS);
}

/**
 * Cut points for a song, preferring strong onsets near the middle of the
 * allowed range.
 *
 * Greedy rather than optimal, on purpose: each cut is chosen looking only
 * forward, which is how an editor cuts to music, and it never revisits a scene
 * already placed. A song with no usable onsets — a drone, a measurement that
 * failed — still cuts, at the middle of the range, so the plan never depends on
 * the analysis having worked.
 */
export function splitSong(
  songSeconds: number,
  onsets: Onset[],
  lengths: SceneLengths = DEFAULT_SCENE_LENGTHS,
  loudness?: (start: number, end: number) => number,
): SceneWindow[] {
  const min = Math.max(1, lengths.min);
  const max = Math.max(min, lengths.max);
  const target = (min + max) / 2;
  const cuts: number[] = [0];

  let at = 0;
  while (songSeconds - at > max) {
    const remaining = songSeconds - at;
    // Never leave a tail too short to be a scene of its own: if the next cut
    // would, take the rest as one scene when that fits in a run, and otherwise
    // split what is left evenly.
    if (remaining - min < min) {
      if (remaining <= MAX_RUN_SECONDS) break;
      at += remaining / 2;
      cuts.push(at);
      continue;
    }

    const lo = at + min;
    const hi = Math.min(at + max, songSeconds - min);
    let best: number | null = null;
    let bestScore = -Infinity;
    for (const onset of onsets) {
      if (onset.time < lo || onset.time > hi) continue;
      // Strength first, closeness to the target length second: a strong beat a
      // second off the middle beats a weak one on it.
      const closeness = 1 - Math.abs(onset.time - at - target) / (max - min || 1);
      const score = onset.strength * 2 + closeness;
      if (score > bestScore) {
        bestScore = score;
        best = onset.time;
      }
    }

    at = best ?? Math.min(at + target, hi);
    cuts.push(at);
  }
  cuts.push(songSeconds);

  const windows: SceneWindow[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = round3(cuts[i]);
    const end = round3(cuts[i + 1]);
    windows.push({ start, end, energy: loudness ? loudness(start, end) : 0.5 });
  }
  return windows;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Seconds as the plan shows them — "1:05.4". */
export function clock(seconds: number): string {
  const whole = Math.floor(seconds / 60);
  const rest = seconds - whole * 60;
  return `${whole}:${rest.toFixed(1).padStart(4, "0")}`;
}
