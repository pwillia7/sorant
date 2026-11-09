import { createHash } from "node:crypto";
import { COMFY_TESTED } from "../comfy-version";
import { collect } from "./needs";

/**
 * What a version of this app needs from the ComfyUI machine, written to
 * `machine-requirements.json` at the repo root by `pnpm requirements:write`.
 *
 * It exists for updating. An update that leaves this file's fingerprint alone
 * is an app-only change, safe to deploy from any machine; one that moves it
 * needs something on the ComfyUI machine first — a node pack, a newer pack, a
 * model file — and deploying the app ahead of that is how a workflow ends up
 * failing on a class nobody recognises, minutes after Generate. The update
 * runbook compares fingerprints between versions, the app compares its own
 * against the latest release's, and `/api/compat` checks the live machine
 * against the entries.
 *
 * Committed rather than computed on demand so that an agent can read the
 * answer for any two versions with `git show`, without installing either.
 * `check:workflows` fails while it is stale.
 */
export interface MachineRequirements {
  /**
   * A hash of what the machine must have: each class with the inputs the
   * graphs drive, each model file with whether it is optional. Nothing else —
   * not which workflow asks — so renaming or regrouping workflows does not
   * read as a change the machine has to make.
   */
  fingerprint: string;
  /**
   * The oldest ComfyUI the workflows are known to work on (comfy-version.ts).
   * In the fingerprint, so raising it reads as a change to the machine.
   */
  comfyui: { min: string };
  classes: Record<
    string,
    { inputs: string[]; optional: boolean; workflows: string[] }
  >;
  models: Record<
    string,
    { loader: string; input: string; optional: boolean; workflows: string[] }
  >;
}

const sorted = <T>(values: Iterable<T>) => [...values].sort();

export function buildRequirements(): MachineRequirements {
  const { classes, models } = collect();

  const classEntries = Object.fromEntries(
    sorted(classes.keys()).map((name) => {
      const need = classes.get(name)!;
      return [
        name,
        {
          inputs: sorted(need.inputs),
          optional: need.optional,
          workflows: sorted(need.workflows),
        },
      ];
    }),
  );
  const modelEntries = Object.fromEntries(
    sorted(models.keys()).map((file) => {
      const need = models.get(file)!;
      return [
        file,
        {
          loader: need.loader,
          input: need.input,
          optional: need.optional,
          workflows: sorted(need.workflows),
        },
      ];
    }),
  );

  return {
    fingerprint: fingerprintOf(classEntries, modelEntries, COMFY_TESTED.min),
    comfyui: { min: COMFY_TESTED.min },
    classes: classEntries,
    models: modelEntries,
  };
}

function fingerprintOf(
  classes: MachineRequirements["classes"],
  models: MachineRequirements["models"],
  minComfy: string,
): string {
  const essence = {
    classes: Object.entries(classes).map(([name, c]) => [name, c.inputs, c.optional]),
    models: Object.entries(models).map(([file, m]) => [file, m.loader, m.input, m.optional]),
    comfyui: minComfy,
  };
  return createHash("sha256")
    .update(JSON.stringify(essence))
    .digest("hex")
    .slice(0, 16);
}

/** The file as `requirements:write` writes it, so the check can compare bytes. */
export function serializeRequirements(requirements: MachineRequirements): string {
  return `${JSON.stringify(requirements, null, 2)}\n`;
}
