import type { ParamValue } from "./types";

/**
 * A clip too long for one run, sent as windows of it and joined at the end.
 *
 * Remix is the case. Its graph rebuilds whatever clip it is given at that
 * clip's own length, and one run holding 20 s or more of reference frames,
 * their soundtrack and the whole generated take is what the box runs out of
 * RAM on (see slices.ts for the 2026-11-21 failure). So past one window the
 * page cuts the clip into windows on the model's frame grid, sends each as an
 * ordinary run of the same graph — the loader reads only that stretch, picture
 * and sound — and the multi-scene join lays the takes end to end
 * (use-clip-chain.ts).
 *
 * Unlike a long Character swap, the windows do not carry on from one another:
 * each is a remix of its own stretch of the clip, so they can all be queued
 * at once and any one redone on its own. The cost is that a join between two
 * windows is a cut between two takes — the same change, made twice.
 *
 * No imports beyond types, so the browser can use it.
 */

/** The rate windows are counted at: H3's, and what the loader forces. */
export const CHAIN_FPS = 24;

/**
 * Up to this, a clip is one run, as it always was: 20 s, what Remix took
 * before it could chain. Past it, windows.
 */
export const CHAIN_OVER_FRAMES = 480;

/**
 * The most frames a window takes: 311, 12.96 s, a length on H3's 17k+5 grid.
 * Inside what the model was trained at (about 15 s) and short enough not to
 * run the box out of RAM, which a 20 s remix has done.
 */
export const CHAIN_WINDOW_FRAMES = 311;

/** The longest clip a chained remix takes: eight minutes, like Character swap. */
export const MAX_CHAIN_SECONDS = 480;

export interface ClipChain {
  /** The `measured` param holding the clip's length in seconds. */
  lengthParam: string;
  /** The `written` param a window's run carries, as `chainValue` writes it. */
  segmentParam: string;
  /** The `video` param holding the clip. */
  clipParam: string;
  /**
   * The select whose answer decides whose sound the join keeps, and the
   * answer that means the clip's own: then the join lays the clip's
   * soundtrack under every window, cut by time, and there is no seam in it.
   * Any other answer keeps each take's own sound.
   */
  keepsClipSound?: { param: string; value: string; fallback: string };
}

/** One window of the clip: where it starts and how many frames, at 24 fps. */
export interface ChainWindow {
  start: number;
  frames: number;
}

/** Whether a clip this long is sent as a chain rather than one run. */
export function isChained(seconds: ParamValue | undefined): boolean {
  const value = Number(seconds);
  return Number.isFinite(value) && Math.round(value * CHAIN_FPS) > CHAIN_OVER_FRAMES;
}

/** The 17k+5 length nearest `frames`. */
const onGrid = (frames: number) => Math.max(5, Math.round((frames - 5) / 17) * 17 + 5);

/**
 * A clip as the fewest windows of at most CHAIN_WINDOW_FRAMES, as near equal
 * as H3's grid allows — so a 21 s clip is two of about 10.5 s, not 13 and 8.
 * Every window but the last is on the grid, so it comes back the length it
 * went in; the last takes what is left, which stays near the others.
 */
export function chainWindows(seconds: number): ChainWindow[] {
  const total = Math.max(1, Math.round(seconds * CHAIN_FPS));
  const count = Math.ceil(total / CHAIN_WINDOW_FRAMES);
  const windows: ChainWindow[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const left = total - start;
    const frames =
      index === count - 1 ? left : Math.min(CHAIN_WINDOW_FRAMES, onGrid(left / (count - index)));
    windows.push({ start, frames });
    start += frames;
  }
  return windows;
}

/**
 * A window as its run's segment param: "index/count:start:frames". The last
 * window's frames are 0, "to the end of the clip", so a clip measured a frame
 * or two out still ends where the file does.
 */
export function chainValue(windows: ChainWindow[], index: number): string {
  const window = windows[index];
  const frames = index === windows.length - 1 ? 0 : window.frames;
  return `${index + 1}/${windows.length}:${window.start}:${frames}`;
}

/** A segment param read back, or null for an ordinary run of the whole clip. */
export function chainPartOf(
  value: ParamValue | undefined,
): { part: number; parts: number; start: number; frames: number } | null {
  const match = /^(\d+)\/(\d+):(\d+):(\d+)$/.exec(String(value ?? ""));
  if (!match) return null;
  const [part, parts, start, frames] = match.slice(1).map(Number);
  if (part < 1 || part > parts) return null;
  return { part, parts, start, frames };
}
