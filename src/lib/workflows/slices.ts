import type { ParamValue } from "./types";

/**
 * How Character swap cuts a long clip into slices, shared by the graph (which
 * sets the batch size from it) and by every estimate of the run, in the server
 * and in the browser. No imports beyond types, so the browser can use it.
 *
 * A clip up to `SINGLE_PASS_FRAMES` goes in one pass. A longer one is cut into
 * slices of about `SLICE_FRAMES`, made equal, each padded by `SLICE_SLACK` so
 * that a clip measured a few frames short of what VHS loads still ends in the
 * planned number of passes. Without that padding, it could end with a pass of
 * a frame or two, which the reference node refuses.
 */

/** The rate a clip is read at: H3's. */
export const SLICE_FPS = 24;
/** Up to 5.875 s goes in one pass: 141 frames, the grid length of a 5-second H3 run. */
export const SINGLE_PASS_FRAMES = 141;
/** About what each slice should be: 124 frames, 5.17 s, a length on H3's 17k+5 grid. */
export const SLICE_FRAMES = 124;
export const SLICE_SLACK = 4;

/**
 * Frames per pass and how many passes for a clip this long, or null for one
 * ordinary pass. A clip not measured yet (0, or not a number) counts as short.
 */
export function clipSlices(
  seconds: ParamValue | undefined,
): { framesPerBatch: number; passes: number } | null {
  const value = Number(seconds);
  const frames = Number.isFinite(value) ? Math.round(value * SLICE_FPS) : 0;
  if (frames <= SINGLE_PASS_FRAMES) return null;
  const slices = Math.ceil(frames / SLICE_FRAMES);
  const framesPerBatch = Math.ceil(frames / slices) + SLICE_SLACK;
  return { framesPerBatch, passes: Math.ceil(frames / framesPerBatch) };
}

/**
 * How many runs' worth of work a submission is, for a workflow that names its
 * clip-length param in `slicedBy`: the passes, or 1.
 */
export function estimateScale(
  slicedBy: string | undefined,
  values: Record<string, ParamValue> | undefined,
): number {
  if (!slicedBy || !values) return 1;
  return clipSlices(values[slicedBy])?.passes ?? 1;
}

/**
 * Clips longer than this are swapped as a chain of runs, one window each, and
 * joined at the end (use-long-swap.ts). Up to it, the whole clip is one run
 * whose windows continue inside it — but that run holds the whole prepared
 * clip, its masks and every finished frame in the box's RAM at once, and a
 * minute at 1 MP asked for 17 GB more than a 64 GB machine had left
 * (2026-11-06). A 12 s clip at 1 MP ran fine as one.
 */
export const CHAIN_OVER_SECONDS = 20;

/**
 * As long as a clip may be, at all. The join is one `ConcatenateVideo`, which
 * takes at most 100 clips (MAX_SEGMENTS, below), and 100
 * segments of about 123 frames is 8.5 minutes.
 */
export const MAX_SWAP_SECONDS = 480;

/**
 * "1" on a chained segment that is the clip's own footage rather than a swap:
 * written by the page when SAM found no one to replace in it. See
 * `passThrough` in minimax-h3-swap.ts.
 */
export const PASS_THROUGH_PARAM = "pass_through";
/**
 * How often a chained swap starts a segment fresh, from the clip and the
 * picture alone, instead of carrying on from the one before: seconds, "0" for
 * never. Read by the page (use-long-swap.ts); it changes no graph.
 */
export const FRESH_EVERY_PARAM = "fresh_every";
/**
 * Whether a Character swap is split at the clip's camera cuts, each shot
 * swapped fresh: a toggle, read by the page (use-long-swap.ts); it changes no
 * graph.
 */
export const SPLIT_SHOTS_PARAM = "split_shots";
/** Clips shorter than this cannot hold two shots worth splitting: two seconds. */
export const SPLIT_OVER_SECONDS = 2;

/** Frames of the previous segment's output each segment carries on from: Relay's 18. */
export const CHAIN_HISTORY = 18;

/**
 * One run of a chained swap: the source frames it delivers, and the history it
 * starts from. `frames` 0 means "to the end of the clip", so a clip measured a
 * frame or two out still ends where the file does.
 *
 * The run's source is the clip from `start - history` — Relay's segment
 * schedule takes a source that includes its history — and the history itself
 * is the last `history` frames of the segment before's output.
 */
export interface ChainSegment {
  start: number;
  frames: number;
  history: number;
  /**
   * The first segment of a shot after a camera cut: it starts fresh, with no
   * history and no mask from the segment before, which showed another shot.
   */
  cut?: boolean;
  /**
   * Seconds: exactly where a shot after a camera cut starts, when the cut was
   * found in the clip rather than typed in. Set on the shot's first segment;
   * its slice starts here rather than at `start / 24`.
   */
  startTime?: number;
  /**
   * Seconds: exactly where the next shot starts, on a shot's last segment;
   * its slice ends here rather than half a frame past its last grid frame.
   * See `Cut.time` in scene-cuts.ts for why both are needed.
   */
  endTime?: number;
  /**
   * Starts fresh at a cut the user added on a redo (`splitSegment`), not at
   * one found in the clip: no history, no mask carried from the segment
   * before, and who to replace picked anew on its own first frame.
   */
  fresh?: boolean;
  /**
   * The history tag its runs carry (`MusicVideoTag.scene`); its index when
   * unset. Set on every segment once one is split, so the segments after the
   * split keep finding their own takes though their index moved on by one.
   */
  tag?: number;
}

/** A tail shorter than this is folded into the segment before it. */
const MIN_LAST_SEGMENT = 24;

/** The most segments a swap may have: the join's 100 clips (MAX_SCENES in music-video-stitch.ts). */
export const MAX_SEGMENTS = 100;

/** Neither side of a cut added on a redo may be shorter than this: a second. */
export const MIN_SPLIT_FRAMES = MIN_LAST_SEGMENT;

/** The history tag a segment's runs carry. See `ChainSegment.tag`. */
export function segmentTag(segments: ChainSegment[], index: number): number {
  return segments[index]?.tag ?? index;
}

/**
 * The frames a cut may be added at in a segment, as [first, last] on the 24
 * fps grid, or null when it is too short to make two of. The frame is where
 * the second part starts.
 */
export function splitRange(segment: ChainSegment, seconds: number): [number, number] | null {
  const first = segment.start + MIN_SPLIT_FRAMES;
  const last = segment.start + segmentFrames(segment, seconds) - MIN_SPLIT_FRAMES;
  return first <= last ? [first, last] : null;
}

/**
 * The segments with one cut in two at frame `at`. The first part keeps the
 * segment's start, history and tag, so its takes are still its own; the second
 * starts at `at` with a new tag, between this one's and the next one's so the
 * history lists it in order. It carries on from the first part's last frames,
 * or with `fresh`, starts over — for a cut the finder missed, or a first part
 * whose take is kept, which runs past `at` and has no frames to carry on from.
 */
export function splitSegment(
  segments: ChainSegment[],
  index: number,
  at: number,
  fresh: boolean,
  seconds: number,
): ChainSegment[] | null {
  const segment = segments[index];
  const range = segment ? splitRange(segment, seconds) : null;
  if (!range || at < range[0] || at > range[1] || segments.length >= MAX_SEGMENTS) return null;
  const tagged = segments.map((each, i) => ({ ...each, tag: segmentTag(segments, i) }));
  const tag = tagged[index].tag;
  const next = tagged[index + 1]?.tag ?? tag + 1;
  const { endTime, ...head } = tagged[index];
  const first: ChainSegment = { ...head, frames: at - segment.start };
  const second: ChainSegment = {
    start: at,
    frames: segment.frames ? segment.start + segment.frames - at : 0,
    history: fresh ? 0 : CHAIN_HISTORY,
    ...(fresh ? { fresh: true } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
    tag: (tag + next) / 2,
  };
  return [...tagged.slice(0, index), first, second, ...tagged.slice(index + 1)];
}

/**
 * A long clip as a chain of single-window runs. The first delivers 124 frames,
 * Relay's tested window. Each one after delivers 123: its 124-frame window
 * starts on the last frame of the history (regenerated, then dropped), so
 * that it carries on from it exactly. See `plan_segment` in Relay's planning.py.
 */
export function chainSegments(seconds: number): ChainSegment[] {
  const total = Math.round(seconds * SLICE_FPS);
  const segments: ChainSegment[] = [];
  let start = 0;
  while (start < total) {
    const history = start === 0 ? 0 : CHAIN_HISTORY;
    const frames = start === 0 ? SLICE_FRAMES : SLICE_FRAMES - 1;
    segments.push({ start, frames, history });
    start += frames;
  }
  const last = segments.at(-1);
  if (last && segments.length > 1 && total - last.start < MIN_LAST_SEGMENT) segments.pop();
  const tail = segments.at(-1);
  if (tail) tail.frames = 0;
  return segments;
}

/** How many frames a segment delivers, the last one included. */
export function segmentFrames(segment: ChainSegment, seconds: number): number {
  return segment.frames || Math.max(1, Math.round(seconds * SLICE_FPS) - segment.start);
}

/**
 * A clip as a chain of single-window runs, cut at the camera cuts (frames on
 * the 24 fps grid where a new shot starts; see scene-cuts.ts). Each shot is
 * chained as `chainSegments` chains a clip, and its first segment starts
 * fresh. A shot's last segment is never shorter than MIN_LAST_SEGMENT: a
 * short tail takes frames from the segment before it rather than being added
 * to it, so no window is ever longer than the 124 frames Relay's tested at.
 */
export function shotSegments(
  seconds: number,
  cuts: number[],
  /** Exactly when each cut happens, by its frame, where that is known. */
  cutTimes: Record<number, number> = {},
): ChainSegment[] {
  const total = Math.round(seconds * SLICE_FPS);
  const bounds = [0, ...cuts.filter((cut) => cut > 0 && cut < total), total];
  const segments: ChainSegment[] = [];
  for (let s = 0; s + 1 < bounds.length; s += 1) {
    const shot: ChainSegment[] = [];
    const end = bounds[s + 1];
    let start = bounds[s];
    while (start < end) {
      const first = shot.length === 0;
      const frames = Math.min(first ? SLICE_FRAMES : SLICE_FRAMES - 1, end - start);
      shot.push({ start, frames, history: first ? 0 : CHAIN_HISTORY, ...(first && s > 0 ? { cut: true } : {}) });
      start += frames;
    }
    const tail = shot.at(-1)!;
    if (shot.length > 1 && tail.frames < MIN_LAST_SEGMENT) {
      const short = MIN_LAST_SEGMENT - tail.frames;
      shot[shot.length - 2].frames -= short;
      tail.start -= short;
      tail.frames += short;
    }
    const startTime = s > 0 ? cutTimes[bounds[s]] : undefined;
    if (startTime !== undefined) shot[0].startTime = startTime;
    const endTime = s + 2 < bounds.length ? cutTimes[end] : undefined;
    if (endTime !== undefined) shot[shot.length - 1].endTime = endTime;
    segments.push(...shot);
  }
  const last = segments.at(-1);
  if (last) last.frames = 0;
  return segments;
}
