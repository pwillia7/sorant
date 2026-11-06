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
