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

/** The longest a box value can be, for the param's length check. */
export const BOX_MAX_LENGTH = 160;

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

/** A stored box, or null for none or anything unusable. */
export function parseBox(value: unknown): SubjectBox | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { x, y, w, h, sw, sh } = parsed as Record<string, unknown>;
  const fractions = [x, y, w, h];
  if (!fractions.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  if (![sw, sh].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 16 && n <= 8192)) return null;
  const box = { x, y, w, h, sw, sh } as SubjectBox;
  if (box.w < 0.01 || box.h < 0.01 || box.x + box.w > 1.0001 || box.y + box.h > 1.0001) return null;
  return box;
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

/** A box in the run's frame pixels, as SAM3_Detect's `bboxes` takes it. */
export function boxInPixels(
  box: SubjectBox,
  megapixels: number,
): { x: number; y: number; width: number; height: number } {
  const [width, height] = swapFrameSize(box.sw, box.sh, megapixels);
  return {
    x: Math.round(box.x * width),
    y: Math.round(box.y * height),
    width: Math.max(1, Math.round(box.w * width)),
    height: Math.max(1, Math.round(box.h * height)),
  };
}
