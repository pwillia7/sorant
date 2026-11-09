/**
 * Finding the camera cuts in a clip, so a Character swap can start each shot
 * fresh rather than carry a person's mask and last frames across a cut.
 *
 * Works on tiny thumbnails of the clip, on the 24 fps grid the swap reads it
 * at, through a `grab` callback: in the browser, a <video> seeked and drawn to
 * a canvas (`grabFromVideo`); in a test, frames decoded by FFmpeg. Nothing
 * here touches the DOM, so the same code runs in both.
 *
 * Two passes. A coarse one compares frames a third of a second apart; where
 * those differ enough to be a cut, a fine one finds the first frame of the new
 * shot between them by bisection, then keeps it only if that frame differs
 * from the one before it the way a cut does. Motion — a pan, someone walking
 * past — changes a frame little from the one before it; a cut changes it all.
 * Dissolves and fades are gradual, so they are not found; the shot list lets
 * someone add a cut by hand.
 */

/** The rate the swap reads a clip at: frames here are on its grid. */
export const CUT_FPS = 24;
/** Frames between the coarse pass's samples: a third of a second. */
export const COARSE_STEP = 8;
/** Thumbnail size the frames are compared at. */
export const THUMB_WIDTH = 64;
export const THUMB_HEIGHT = 36;
/** Shots shorter than this are folded into a neighbour: 1 s, the shortest swap segment tested. */
export const MIN_SHOT_FRAMES = 24;

/**
 * Frames a third of a second apart that differ this much may have a cut
 * between them. Tuned on a 45 s film scene with 12 cuts (2026-11-08): within a
 * shot, frames 8 apart differed by at most 0.08; across a cut, at least 0.16.
 */
const COARSE_THRESHOLD = 0.12;
/** Neighbouring frames that differ this much are a cut: there, cuts were 0.17 and up, motion 0.03 at most. */
const CUT_THRESHOLD = 0.1;

/** A frame as RGBA bytes, THUMB_WIDTH × THUMB_HEIGHT. */
export type Thumb = Uint8ClampedArray;

const BINS = 16;

function histogram(frame: Thumb): Float32Array {
  const counts = new Float32Array(BINS * 3);
  const pixels = frame.length / 4;
  for (let i = 0; i < frame.length; i += 4) {
    counts[(frame[i] * BINS) >> 8] += 1;
    counts[BINS + ((frame[i + 1] * BINS) >> 8)] += 1;
    counts[2 * BINS + ((frame[i + 2] * BINS) >> 8)] += 1;
  }
  for (let i = 0; i < counts.length; i += 1) counts[i] /= pixels;
  return counts;
}

/**
 * How different two frames are, 0 (the same) to 1. The larger of two
 * measures, each scaled to 0–1: how far apart their colour histograms are
 * (what is in the picture), and how far each 8×6 block's brightness moved
 * (where it is). A cut moves both; a pan moves the second only a little,
 * since blocks shift rather than change, and the histogram hardly at all.
 * Taking the smaller would miss a cut between two shots of the same colours,
 * so the block measure is damped instead: it counts half.
 */
export function frameDistance(a: Thumb, b: Thumb): number {
  const ha = histogram(a);
  const hb = histogram(b);
  let colour = 0;
  for (let i = 0; i < ha.length; i += 1) colour += Math.abs(ha[i] - hb[i]);
  colour /= 6; // three channels, each summing to at most 2

  const cols = 8;
  const rows = 6;
  const bw = THUMB_WIDTH / cols;
  const bh = THUMB_HEIGHT / rows;
  let moved = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let la = 0;
      let lb = 0;
      for (let y = Math.floor(r * bh); y < Math.floor((r + 1) * bh); y += 1) {
        for (let x = Math.floor(c * bw); x < Math.floor((c + 1) * bw); x += 1) {
          const i = (y * THUMB_WIDTH + x) * 4;
          la += a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
          lb += b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
        }
      }
      const n = Math.floor(bw) * (Math.floor((r + 1) * bh) - Math.floor(r * bh)) || 1;
      moved += Math.abs(la - lb) / n / 255;
    }
  }
  moved /= cols * rows;
  return Math.min(1, Math.max(colour, moved * 0.5 + colour * 0.5) * 1.5);
}

export interface CutProgress {
  /** 0–1. */
  fraction: number;
}

/**
 * The frames, on the 24 fps grid, where a new shot starts, in order. Never 0.
 * `grab(frame)` gives that frame's thumbnail; `frames` is the clip's length.
 */
export async function findCuts(
  frames: number,
  grab: (frame: number) => Promise<Thumb>,
  {
    onProgress,
    signal,
  }: { onProgress?: (progress: CutProgress) => void; signal?: AbortSignal } = {},
): Promise<number[]> {
  const cache = new Map<number, Thumb>();
  const at = async (frame: number) => {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const cached = cache.get(frame);
    if (cached) return cached;
    const thumb = await grab(frame);
    cache.set(frame, thumb);
    return thumb;
  };

  const last = frames - 1;
  const samples: number[] = [];
  for (let frame = 0; frame < last; frame += COARSE_STEP) samples.push(frame);
  samples.push(last);

  const cuts: number[] = [];
  for (let s = 1; s < samples.length; s += 1) {
    const before = samples[s - 1];
    const after = samples[s];
    onProgress?.({ fraction: s / samples.length });
    const a = await at(before);
    const b = await at(after);
    if (frameDistance(a, b) < COARSE_THRESHOLD) continue;
    // The first frame closer to `after` than to `before`, by bisection.
    let low = before; // known old shot
    let high = after; // known new shot
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      const m = await at(mid);
      if (frameDistance(m, b) < frameDistance(m, a)) high = mid;
      else low = mid;
    }
    if (frameDistance(await at(high - 1), await at(high)) >= CUT_THRESHOLD) cuts.push(high);
    // Only the thumbnails either side of the sample still to come are needed.
    for (const key of cache.keys()) if (key < before) cache.delete(key);
  }
  onProgress?.({ fraction: 1 });
  return cuts;
}

/**
 * Cuts with every shot at least MIN_SHOT_FRAMES long: a cut too close to the
 * one before (or to the start) is dropped, folding the short shot into the
 * one before it; one too close to the end is dropped too.
 */
export function tidyCuts(cuts: number[], frames: number): number[] {
  const kept: number[] = [];
  for (const cut of [...new Set(cuts)].sort((x, y) => x - y)) {
    const previous = kept.at(-1) ?? 0;
    if (cut - previous < MIN_SHOT_FRAMES) continue;
    if (frames - cut < MIN_SHOT_FRAMES) continue;
    kept.push(cut);
  }
  return kept;
}
