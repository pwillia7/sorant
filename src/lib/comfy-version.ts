/**
 * Which ComfyUI versions this release of Soran't is tested on. Client-safe —
 * no imports — so the status panel, the health route and `check:nodes` read
 * the same range.
 *
 * The node and model checks (compat.ts, `check:nodes`) catch a ComfyUI too old
 * to have a class the graphs name. They cannot catch one that has every class
 * but predates a fix a workflow relies on: that runs, and comes out wrong.
 * This range is for that.
 *
 * - `min` is the oldest version the workflows are known to work on. Raise it
 *   only when a workflow starts to depend on something newer; it is part of
 *   the machine-requirements fingerprint, so raising it makes the release one
 *   that needs the ComfyUI machine first, and the update runbook says so.
 * - `testedThrough` is the newest version tested. Newer is not a problem, only
 *   untested, so it is said quietly and is not in the fingerprint: moving it
 *   after a test asks nothing of anyone's machine.
 *
 * After testing a new ComfyUI (the update check), move `testedThrough` and the
 * "Tested on" line in docs/agent-setup.md together.
 */
export const COMFY_TESTED = { min: "0.38.0", testedThrough: "0.44.0" } as const;

/** "0.44.0" → [0, 44, 0]; null for anything that is not a version. */
export function parseVersion(value: unknown): number[] | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** Negative when a is older than b, positive when newer, 0 when equal. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export type ComfyVersionStatus = "older" | "tested" | "newer" | "unknown";

/** Where a ComfyUI version falls against the tested range. */
export function comfyVersionStatus(version: unknown): ComfyVersionStatus {
  const parsed = parseVersion(version);
  if (!parsed) return "unknown";
  if (compareVersions(parsed, parseVersion(COMFY_TESTED.min)!) < 0) return "older";
  if (compareVersions(parsed, parseVersion(COMFY_TESTED.testedThrough)!) > 0) return "newer";
  return "tested";
}

/** The sentence for an install below the range, shared by the panel and `check:nodes`. */
export function olderComfyMessage(version: string): string {
  return `ComfyUI ${version} is older than Soran’t is tested on (${COMFY_TESTED.min} and later). Update ComfyUI on that machine: a workflow can run on it and still come out wrong.`;
}
