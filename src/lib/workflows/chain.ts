import { TAIL_FRAMES } from "./latent-tail";
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
 * By default the windows do not carry on from one another: each is a remix of
 * its own stretch of the clip, so they can all be queued at once and any one
 * redone on its own. The cost is that a join between two windows is a cut
 * between two takes — the same change, made twice.
 *
 * **Continuous parts** trade that for a seam that holds. Every window after
 * the first starts LEAD frames early, re-reading the end of the window before
 * it from the source, and the run holds those frames fixed at the previous
 * take's own latents — the tail every H3 run saves (latent-tail.ts), the same
 * seam Extend carries on from. The take then drops them again, so it still
 * delivers exactly its window and the join is unchanged. The price is order:
 * a window cannot start until the one before it is done, and redoing one
 * means redoing every window after it.
 *
 * Imports only constants and types, so the browser can use it.
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

/**
 * Frames a continuous window re-reads from before its start: the 22 the
 * previous take's latent tail decodes to, so the two line up frame for frame.
 */
export const CHAIN_LEAD = TAIL_FRAMES;

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
  /**
   * The toggle that makes the windows continuous, and the `written` param a
   * continuous window's run takes the previous take's tail in — named as the
   * clip hand-off names it (`tailFileFor`). See the top of this file.
   */
  continuous?: { param: string; tailParam: string };
}

/**
 * One window of the clip: where it starts and how many frames, at 24 fps. A
 * continuous window also re-reads `lead` frames before its start.
 */
export interface ChainWindow {
  start: number;
  frames: number;
  lead?: number;
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
export function chainWindows(seconds: number, continuous = false): ChainWindow[] {
  const total = Math.max(1, Math.round(seconds * CHAIN_FPS));
  if (continuous) {
    const windows = continuousWindows(total);
    if (windows) return windows;
  }
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
 * Continuous windows, or null when the clip will not split that way.
 *
 * Each run has to land on H3's 17k+5 grid, or its latent tail would not be
 * the window's last 22 frames: the model rounds a length up and invents the
 * rest. The first window is on the grid as it is; every later one runs its
 * frames plus the 22 re-read, so its own frames are a multiple of 17 — and
 * at most 289, so the run stays within CHAIN_WINDOW_FRAMES. The last takes
 * what is left, with its 22 inside the same cap.
 */
function continuousWindows(total: number): ChainWindow[] | null {
  const most = CHAIN_WINDOW_FRAMES - CHAIN_LEAD;
  for (let count = Math.max(2, Math.ceil(total / most)); count < 400; count += 1) {
    const target = total / count;
    const windows: ChainWindow[] = [{ start: 0, frames: Math.min(CHAIN_WINDOW_FRAMES, onGrid(target)) }];
    let start = windows[0].frames;
    for (let index = 1; index < count - 1; index += 1) {
      const frames = Math.min(most, Math.max(17, Math.round(target / 17) * 17));
      windows.push({ start, frames, lead: CHAIN_LEAD });
      start += frames;
    }
    const last = total - start;
    if (last >= 17 && last <= most) {
      windows.push({ start, frames: last, lead: CHAIN_LEAD });
      return windows;
    }
  }
  return null;
}

/**
 * A window as its run's segment param: "index/count:start:frames", and
 * ":lead" after it for a continuous window. The last window's frames are 0,
 * "to the end of the clip", so a clip measured a frame or two out still ends
 * where the file does.
 */
export function chainValue(windows: ChainWindow[], index: number): string {
  const window = windows[index];
  const frames = index === windows.length - 1 ? 0 : window.frames;
  const lead = window.lead ? `:${window.lead}` : "";
  return `${index + 1}/${windows.length}:${window.start}:${frames}${lead}`;
}

/** A segment param read back, or null for an ordinary run of the whole clip. */
export function chainPartOf(
  value: ParamValue | undefined,
): { part: number; parts: number; start: number; frames: number; lead: number } | null {
  const match = /^(\d+)\/(\d+):(\d+):(\d+)(?::(\d+))?$/.exec(String(value ?? ""));
  if (!match) return null;
  const [part, parts, start, frames] = match.slice(1, 5).map(Number);
  const lead = Math.min(Number(match[5] ?? 0), start);
  if (part < 1 || part > parts) return null;
  return { part, parts, start, frames, lead };
}
