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
  /**
   * A multi-scene video's scene that carries straight on from the one before:
   * the same moment and camera, rendered from the last second of that
   * scene's own render rather than drawn afresh. See SCENE_JOINS_PARAM.
   */
  continues?: boolean;
}

/**
 * How a multi-scene video's scenes meet: where the director decides, scene by
 * scene, whether one carries straight on from the last; every scene carrying
 * on, one unbroken take; or every scene its own render with a cut between.
 *
 * A scene that carries on is rendered from the end of the scene before — its
 * last 22 frames and their sound, as the sampler left them — so the bike, the
 * light and the motion go through the join instead of being drawn again. On
 * a POV motorbike run told in four scenes, made apart, the bike was a
 * different model in each and every scene ended parked and the next started
 * cruising; chained, it was one bike and one ride (2026-11-16). The cost is
 * order: a scene that carries on waits for the one before it to finish, and a
 * new take of that one leaves it behind. See `chainStale`.
 */
export const SCENE_JOINS_PARAM = "scene_joins";
export type SceneJoins = "director" | "continuous" | "cuts";
export const sceneJoins = (values: Record<string, unknown>): SceneJoins => {
  const value = values[SCENE_JOINS_PARAM];
  return value === "continuous" || value === "cuts" ? value : "director";
};

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
  /**
   * What the user asked the director to change, when the shots in `only` are
   * revised rather than written fresh: "make it more like a Monty Python
   * sketch". Each is written again from the shot it has now, in `current`.
   */
  ask?: string;
  /** The shots being revised as they stand, by scene index from 0. */
  current?: Record<number, string>;
  /** How the people and recurring things look, for the writer's pronouns only. */
  look?: string;
}

/**
 * What the plan graph is handed to revise a plan rather than make one: the
 * user's ask, and the plan as it stands in the shape the planner writes. See
 * REVISION_PARAM.
 */
export interface PlanRevision {
  ask: string;
  plan: {
    concept: string;
    scenes: Array<Record<string, unknown>>;
    look?: string;
  };
}

/**
 * What a planned video is made to: a song, cut on its beats, or a story the
 * planner times scene by scene with each scene's own sound. A project with no
 * kind is a music video, as every project was before there was a second.
 */
export type PlannedKind = "music" | "story";

/**
 * The multi-scene switch that lets the planner decide how many scenes the
 * story needs. On, the Scenes slider stands down and the project is rebuilt
 * with however many scenes the plan comes back with; off, the slider is the
 * exact count.
 */
export const CHOOSE_SCENE_COUNT_PARAM = "choose_scene_count";

/**
 * The most scenes a multi-scene video may have: the Scenes slider's top, and
 * the ceiling on a plan whose director picked the count, since the project
 * holds a placeholder for each scene the plan could fill.
 */
export const MAX_STORY_SCENES = 40;

/**
 * How long a multi-scene video's scene may be: H3's trained range, about 5 to
 * 15 seconds. Below it the sound is the first thing to go, and a short
 * talking clip is where lip sync falls apart (see tips.ts).
 */
export const STORY_SCENE_SECONDS = { min: 5, max: 15, initial: 8 } as const;

/** The range a multi-scene video's planner is held to unless the form says otherwise. */
export const DEFAULT_STORY_LENGTHS: SceneLengths = { min: 5, max: 10 };

/**
 * The range a multi-scene video's scenes are planned in: the form's sliders,
 * held to H3's trained range. A video of one scene may run to the top of that
 * range whatever the Longest scene slider says — the slider is there to stop
 * a video of many scenes padding each one, and a single take with its cuts in
 * it is the case a long run is for.
 */
export function storyLengths(values: Record<string, unknown>, scenes?: number): SceneLengths {
  const { min, max } = sceneLengths(values, DEFAULT_STORY_LENGTHS);
  const held = (seconds: number) =>
    Math.min(STORY_SCENE_SECONDS.max, Math.max(STORY_SCENE_SECONDS.min, seconds));
  return { min: held(min), max: scenes === 1 ? STORY_SCENE_SECONDS.max : Math.max(held(min), held(max)) };
}

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

/**
 * An outline line made one continuous shot: each "Cut to:" turned into the
 * next thing that happens. For a scene that carries on from the one before,
 * which is one take by what it is — the local planner wrote "Cut to:" into
 * three of four such scenes anyway, and the writer, told to write a cut for
 * each, wrote them.
 */
export function withoutCuts(happens: string): string {
  return happens.replace(/\s*\bcut to\s*:\s*(\S)/gi, (_, first: string) => ` Then ${first.toLowerCase()}`).trim();
}

/**
 * An outline's lines with every scene that is part of one take made one
 * shot: each scene that carries on, and — when every scene after the first
 * carries on — the first as well, since the whole video is then one take.
 * Asked for one continuous take, the local planner still opened a helmet-cam
 * TT run with "Cut to: a close-up of the dashboard", and three seconds of a
 * speedometer from a camera the footage does not have went into the video
 * (2026-11-16).
 */
export function asTakes<T extends { continues?: boolean; happens?: string }>(scenes: T[]): T[] {
  const oneTake = scenes.length > 1 && scenes.slice(1).every((scene) => scene.continues === true);
  return scenes.map((scene) =>
    scene.continues || oneTake ? { ...scene, happens: withoutCuts(scene.happens ?? "") } : scene,
  );
}

/**
 * The last thing an outline line has happen: where its scene ends, for the
 * scene that carries on from it to open on. The whole line was quoted once,
 * and the writer opened the next scene back at its first sentence.
 */
export function lastBeat(happens: string | undefined): string {
  const beats = withoutCuts(happens ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((beat) => beat.trim())
    .filter(Boolean);
  return beats.at(-1) ?? "";
}

/** The most shots one scene's take is planned to hold. */
export const MAX_SHOTS_PER_SCENE = 3;

/** The shortest a shot inside a scene is worth: less and the cut reads as a glitch. */
export const MIN_SHOT_SECONDS = 2.5;

/** How many shots an outline line plans for its scene. */
export function sceneShots(happens: string | undefined): number {
  return Math.min(MAX_SHOTS_PER_SCENE, 1 + ((happens ?? "").match(CUT_MARK)?.length ?? 0));
}

/**
 * Whether two outline lines are the same place, as the planner is told to
 * write a place it returns to: the same words, give or take case and
 * punctuation.
 */
export function samePlace(a: string | undefined, b: string | undefined): boolean {
  const plain = (text: string | undefined) =>
    (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return plain(a) !== "" && plain(a) === plain(b);
}

/**
 * A story's planned scenes with each run of scenes in one place made into
 * as few renders as fit.
 *
 * The planner is told that one place and one moment is one scene, and splits
 * them anyway: a 45-second security-camera fall into a koi pond — one place,
 * one fixed camera, one continuous moment — came back as four scenes with the
 * same place word for word, each held to six seconds by its estimate. Four
 * renders of one moment draw the man, the pond and the light four times; one
 * render draws them once. So two scenes in a row in the same place become one
 * take when together they still fit the longest a scene may be, their shots
 * fit a take, and their lines can be said in the time — what happens in the
 * second follows on from the first in the same take, with no cut between.
 *
 * Lengths are the scenes' own, already worked out (see plannedStorySeconds),
 * added together.
 */
export function mergeContinuousScenes<
  T extends { place?: string; happens?: string; lines?: string; seconds?: number },
>(scenes: T[], longest: number): T[] {
  const merged: T[] = [];
  const shots = (happens: string | undefined) => 1 + ((happens ?? "").match(CUT_MARK)?.length ?? 0);
  for (const scene of scenes) {
    const last = merged.at(-1);
    if (last && samePlace(last.place, scene.place)) {
      const seconds = (last.seconds ?? 0) + (scene.seconds ?? 0);
      const lines = [last.lines?.trim(), scene.lines?.trim()].filter(Boolean).join("\n");
      const fits =
        seconds <= longest &&
        shots(last.happens) + shots(scene.happens) - 1 <= MAX_SHOTS_PER_SCENE &&
        Math.ceil(spokenWords(lines) / SPOKEN_WORDS_PER_SECOND) <= seconds;
      if (fits) {
        merged[merged.length - 1] = {
          ...last,
          happens: [last.happens?.trim(), scene.happens?.trim()].filter(Boolean).join(" "),
          lines,
          seconds,
        };
        continue;
      }
    }
    merged.push(scene);
  }
  return merged;
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
  /**
   * Take the planner's length as it is, not cut to the estimate: when the
   * idea asks for a total length (see requestedSeconds), which the estimate
   * knows nothing of. A 45-second koi-pond fall was cut to four six-second
   * scenes, 24 seconds in all, because each scene's two long sentences
   * counted as two beats.
   */
  trustChosen = false,
): number {
  const estimate = estimatedStorySeconds(scene?.happens, scene?.lines);
  const chosen = Number(scene?.seconds);
  const wanted =
    Number.isFinite(chosen) && chosen > 0 ? (trustChosen ? chosen : Math.min(chosen, estimate)) : estimate;
  const needed = Math.max(
    Math.ceil(spokenWords(scene?.lines) / SPOKEN_WORDS_PER_SECOND),
    MIN_SHOT_SECONDS * sceneShots(scene?.happens),
  );
  return Math.round(Math.min(lengths.max, Math.max(lengths.min, wanted, needed)));
}

/**
 * The total length the user's idea asks for, in seconds — "a 45-second
 * video", "60 seconds long", "a 2-minute short" — or null when it names none.
 * The first such length in the idea; a length of under ten seconds is taken
 * to be about something inside the story ("a 3-second pause"), not the video.
 */
export function requestedSeconds(idea: string | undefined): number | null {
  const match = (idea ?? "").match(/\b(\d+(?:\.\d+)?)[\s-]*(seconds?|secs?|minutes?|mins?)\b/i);
  if (!match) return null;
  const seconds = Number(match[1]) * (/^min/i.test(match[2]) ? 60 : 1);
  return seconds >= 10 ? seconds : null;
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
