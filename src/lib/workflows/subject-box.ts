/**
 * A box drawn around the person to replace, on the frame SAM looks at first.
 *
 * Stored as fractions of the frame it was drawn on, with that frame's size, so
 * the browser never needs to know what size the run's frames will be. The
 * graph needs pixels — SAM3_Detect divides a box by the size of the image it
 * is given — and those come from `swapFrameSize`, which works out the run's
 * frame size the way Prepare Source and the Frame size scale do.
 *
 * Client-safe: no server imports. The swap's param ids the page writes live
 * here for the same reason.
 */

/**
 * A box drawn around who to replace, on the frame SAM looks at first. See
 * `pickSubject` in minimax-h3-swap.ts.
 */
export const SUBJECT_BOX_PARAM = "subject_box";
/**
 * The person's mask on this run's first frame, carried from the segment
 * before: "swap_mask/carry_00001_.png [output]". The page writes it for a
 * chained segment, and tracking starts from it rather than from a fresh pick.
 */
export const SUBJECT_MASK_PARAM = "subject_mask";
/** Which rule picks between several matches. */
export const PICK_PARAM = "pick";
/**
 * Where a chained segment saves the person's mask for the one after it: the
 * frame the next segment starts its source on when it carries on, and its own
 * last frame for when the next starts fresh. See `saveMaskForNext` in minimax-h3-swap.ts.
 */
/** The mask check's workflow id and its own controls. See swap-mask-check.ts. */
export const MASK_CHECK_ID = "swap-mask-check";
/** Where the look starts in the clip, seconds. */
export const CHECK_START_PARAM = "check_start";
/** How much of the clip to look at, seconds. */
export const CHECK_SECONDS_PARAM = "check_seconds";
/** The most a check looks at: four of the swap's windows. */
export const MAX_CHECK_SECONDS = 20;
/** What the check paints on the person tracked, and on frames re-picked by the rule. */
export const CHECK_TRACKED_COLOR = "#22dd66";
export const CHECK_RECOVERED_COLOR = "#ff3344";

export const CARRY_MASK_PREFIX = "swap_mask/carry";
export const END_MASK_PREFIX = "swap_mask/end";

export interface SubjectBox {
  /** Left, top, width and height, as fractions of the frame (0–1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The frame it was drawn on, in display pixels. */
  sw: number;
  sh: number;
}

/** A point on the frame, as fractions of it (0–1). */
export type PickPoint = [number, number];

/**
 * Who to replace, pointed out on the frame SAM looks at first: a box drawn
 * around them, or points clicked on them (`include`) and on anyone SAM should
 * leave out (`exclude`). One or the other, never both — no SAM node takes a
 * box and points together while keeping both through its refinement.
 *
 * Stored as `{x,y,w,h,sw,sh}` for a box (the shape boxes always had) or
 * `{in:[[x,y]…],out:[[x,y]…],sw,sh}` for points.
 */
export interface SubjectPick {
  box: Omit<SubjectBox, "sw" | "sh"> | null;
  include: PickPoint[];
  exclude: PickPoint[];
  sw: number;
  sh: number;
}

/** The most points of either kind a pick keeps. */
export const MAX_PICK_POINTS = 8;

/** The longest a pick value can be, for the param's length check. */
export const BOX_MAX_LENGTH = 600;

const round = (value: number) => Math.round(value * 10000) / 10000;

/** A box as the param stores it. */
export function boxValue(box: SubjectBox): string {
  return JSON.stringify({
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h: round(box.h),
    sw: Math.round(box.sw),
    sh: Math.round(box.sh),
  });
}

/** Points as the param stores them; "" for none to include. */
export function pointsValue(include: PickPoint[], exclude: PickPoint[], sw: number, sh: number): string {
  if (!include.length) return "";
  const tidy = (points: PickPoint[]) =>
    points.slice(0, MAX_PICK_POINTS).map(([x, y]) => [round(x), round(y)]);
  return JSON.stringify({ in: tidy(include), out: tidy(exclude), sw: Math.round(sw), sh: Math.round(sh) });
}

const isFraction = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function pointsOf(value: unknown): PickPoint[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PICK_POINTS) return null;
  const points: PickPoint[] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(isFraction)) return null;
    points.push([point[0], point[1]]);
  }
  return points;
}

/** A stored pick, box or points, or null for none or anything unusable. */
export function parsePick(value: unknown): SubjectPick | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { x, y, w, h, sw, sh } = parsed as Record<string, unknown>;
  if (![sw, sh].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 16 && n <= 8192)) return null;
  const record = parsed as Record<string, unknown>;
  if ("in" in record || "out" in record) {
    const include = pointsOf(record.in);
    const exclude = pointsOf(record.out);
    if (!include || !exclude || !include.length) return null;
    return { box: null, include, exclude, sw: sw as number, sh: sh as number };
  }
  if (![x, y, w, h].every(isFraction)) return null;
  const box = { x, y, w, h } as { x: number; y: number; w: number; h: number };
  if (box.w < 0.01 || box.h < 0.01 || box.x + box.w > 1.0001 || box.y + box.h > 1.0001) return null;
  return { box, include: [], exclude: [], sw: sw as number, sh: sh as number };
}

/** A stored box, or null for none, points, or anything unusable. */
export function parseBox(value: unknown): SubjectBox | null {
  const pick = parsePick(value);
  return pick?.box ? { ...pick.box, sw: pick.sw, sh: pick.sh } : null;
}

const PIXEL_BUDGETS = { "480": 500_000, "768": 1_000_000 } as const;

/**
 * Prepare Source's canvas for a source: H3 Relay's `canvas_dimensions`
 * (h3_relay/video_prep.py), with `preserve_aligned` on as its Prepare Source
 * has it. The nearest 32-pixel shape to the area-scaled ideal, within budget.
 */
export function canvasDimensions(width: number, height: number, resolution: "480" | "768"): [number, number] {
  const budget = PIXEL_BUDGETS[resolution];
  if (width * height <= budget && width % 32 === 0 && height % 32 === 0) return [width, height];
  const ratio = width / height;
  const idealWidth = Math.sqrt(budget * ratio);
  const idealHeight = Math.sqrt(budget / ratio);
  let best: [number, number, number, number] | null = null; // score, -area, w, h
  for (let w = 32; w <= Math.min(16384, Math.floor(budget / 32)); w += 32) {
    const maxH = Math.min(16384, Math.floor(Math.floor(budget / w) / 32) * 32);
    const heights = new Set([
      Math.max(32, Math.min(maxH, Math.floor(idealHeight / 32) * 32)),
      Math.max(32, Math.min(maxH, Math.ceil(idealHeight / 32) * 32)),
    ]);
    for (const h of heights) {
      const score = Math.log(w / idealWidth) ** 2 + Math.log(h / idealHeight) ** 2;
      const candidate: [number, number, number, number] = [score, -(w * h), w, h];
      if (
        !best ||
        candidate[0] < best[0] ||
        (candidate[0] === best[0] && (candidate[1] < best[1] || (candidate[1] === best[1] && candidate[2] < best[2])))
      ) {
        best = candidate;
      }
    }
  }
  return best ? [best[2], best[3]] : [width, height];
}

/**
 * The size of a swap run's frames: Prepare Source's canvas at its budget, then
 * ComfyUI's ImageScaleToTotalPixels to the Frame size on a 32-pixel grid —
 * except at either budget exactly, where the swap leaves the scale out.
 */
export function swapFrameSize(sourceWidth: number, sourceHeight: number, megapixels: number): [number, number] {
  const [w, h] = canvasDimensions(sourceWidth, sourceHeight, megapixels <= 0.5 ? "480" : "768");
  if (megapixels === 1 || megapixels === 0.5) return [w, h];
  const scaleBy = Math.sqrt((megapixels * 1024 * 1024) / (w * h));
  return [Math.round((w * scaleBy) / 32) * 32, Math.round((h * scaleBy) / 32) * 32];
}

/**
 * A point on the frame the user saw, in the run's frame pixels.
 *
 * Prepare Source scales the clip to cover its canvas, keeping the shape, then
 * crops the overhang evenly off both sides (FFmpeg `scale` then `crop`, in
 * h3_relay/video_prep.py); the Frame size scale after it only resizes. So a
 * fraction of the source is not quite the same fraction of the canvas — up to
 * a couple of percent at the edges — and this follows the same steps.
 */
function framePoint(fx: number, fy: number, sw: number, sh: number, megapixels: number): [number, number] {
  const [cw, ch] = canvasDimensions(sw, sh, megapixels <= 0.5 ? "480" : "768");
  const [fw, fh] = swapFrameSize(sw, sh, megapixels);
  const dar = sw / sh;
  const scaledW = Math.ceil(Math.max(cw, ch * dar) - 1e-6);
  const scaledH = Math.ceil(Math.max(ch, cw / dar) - 1e-6);
  const left = Math.floor((scaledW - cw) / 2);
  const top = Math.floor((scaledH - ch) / 2);
  const x = Math.min(cw, Math.max(0, fx * scaledW - left)) * (fw / cw);
  const y = Math.min(ch, Math.max(0, fy * scaledH - top)) * (fh / ch);
  return [x, y];
}

/** A box in the run's frame pixels, as SAM3_Detect's `bboxes` takes it. */
export function boxInPixels(
  box: SubjectBox,
  megapixels: number,
): { x: number; y: number; width: number; height: number } {
  const [x0, y0] = framePoint(box.x, box.y, box.sw, box.sh, megapixels);
  const [x1, y1] = framePoint(box.x + box.w, box.y + box.h, box.sw, box.sh, megapixels);
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    width: Math.max(1, Math.round(x1 - x0)),
    height: Math.max(1, Math.round(y1 - y0)),
  };
}

/** Points in the run's frame pixels, as H3 Relay's Refine Mask takes them. */
export function pointsInPixels(
  points: PickPoint[],
  frame: { sw: number; sh: number },
  megapixels: number,
): Array<{ x: number; y: number }> {
  return points.map(([fx, fy]) => {
    const [x, y] = framePoint(fx, fy, frame.sw, frame.sh, megapixels);
    return { x: Math.round(x), y: Math.round(y) };
  });
}
