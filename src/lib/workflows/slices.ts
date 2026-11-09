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
 * takes at most 100 clips (MAX_SCENES in music-video-stitch.ts), and 100
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
}

/** A tail shorter than this is folded into the segment before it. */
const MIN_LAST_SEGMENT = 24;

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
export function shotSegments(seconds: number, cuts: number[]): ChainSegment[] {
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
    segments.push(...shot);
  }
  const last = segments.at(-1);
  if (last) last.frames = 0;
  return segments;
}
