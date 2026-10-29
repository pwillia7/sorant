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
