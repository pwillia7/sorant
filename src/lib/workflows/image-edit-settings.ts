import type { ParamDef, ParamValue } from "./types";

/**
 * The Edit image controls someone may tune, kept apart from the graph so the
 * edit bar can render them: the graph is server-only, and the edit workflow is
 * a tool, so it never reaches the browser through /api/workflows.
 *
 * Node ids are the image-edit graph's. `pnpm check:workflows` holds every
 * target to that graph, so a renumbered node fails there rather than here.
 *
 * One control. H3 Image is CFG-distilled: guidance is fixed at 1, and Euler on
 * the simple schedule is what it was distilled for. Kontext's guidance,
 * sampler, schedule and redraw went with Kontext (2026-11-23); a browser that
 * stored them keeps nothing it sends, because the edit bar drops any stored
 * id no longer declared here.
 */

export const EDIT_SAMPLER_NODE = "7";

export const IMAGE_EDIT_SETTINGS: ParamDef[] = [
  {
    id: "steps",
    label: "Steps",
    help: "6 is what the model is made for. More rarely helps and takes longer.",
    type: "slider",
    default: 6,
    min: 4,
    max: 16,
    step: 1,
    targets: [{ node: EDIT_SAMPLER_NODE, input: "steps" }],
  },
];

/** What every tunable control is at when nobody has touched it. */
export const IMAGE_EDIT_DEFAULTS: Record<string, ParamValue> =
  Object.fromEntries(
    IMAGE_EDIT_SETTINGS.map((param) => [param.id, param.default]),
  );
