import type { WorkflowSummary } from "./types";

/**
 * Roughly how long a run of this workflow takes in the modes it is in: the
 * last switch with an estimate of its own, then Turbo's, then the plain one.
 */
export function runEstimate(
  workflow: WorkflowSummary,
  turbo: boolean | undefined,
  on: string[] | undefined,
): number | undefined {
  const isTurbo = Boolean(turbo) && Boolean(workflow.turbo);
  return (
    workflow.patches
      .filter((patch) => (on ?? []).includes(patch.id))
      .map((patch) => patch.estimatedSeconds)
      .findLast((seconds) => seconds !== undefined) ??
    (isTurbo ? workflow.turbo?.estimatedSeconds : undefined) ??
    workflow.estimatedSeconds
  );
}

/** An estimate as the picker and the run summary show it: "50s", "4m". */
export function formatEstimate(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}
