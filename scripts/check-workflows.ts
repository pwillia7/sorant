/**
 * Verifies every registered workflow's param targets resolve against its graph.
 * Run after editing a workflow file or swapping in a new ComfyUI export:
 *
 *   pnpm check:workflows
 */
import { validateWorkflow } from "../src/lib/params";
import { WORKFLOWS } from "../src/lib/workflows";
import { collect } from "../src/lib/workflows/needs";
import { MODEL_SOURCES } from "./lib/model-sources";
import { readFileSync } from "node:fs";
import {
  buildRequirements,
  serializeRequirements,
} from "../src/lib/workflows/requirements";

let failed = false;

for (const workflow of WORKFLOWS) {
  const problems = validateWorkflow(workflow);
  const nodeCount = Object.keys(workflow.graph).length;
  const spliced = [
    ...(workflow.turbo ? ["turbo"] : []),
    ...(workflow.patches ?? []).map((patch) => patch.id),
  ];

  if (problems.length === 0) {
    console.log(
      `  ok   ${workflow.id} — ${workflow.params.length} params over ${nodeCount} nodes` +
        // validateWorkflow proves the splices work as well as the targets do —
        // each on its own, and all of them stacked.
        (spliced.length > 0 ? `, ${spliced.join(" + ")} splice cleanly` : "") +
        (workflow.stepSampler
          ? `, ${workflow.stepSampler.atValue}-step sampler resolves`
          : "") +
        // Only where there are any: most graphs have nothing for `finalize` to
        // branch on, and a "0 cases" on every line would read as a gap.
        (workflow.finalizeCases?.length
          ? `, ${workflow.finalizeCases.length} finalize cases queue cleanly`
          : ""),
    );
    continue;
  }

  failed = true;
  console.error(`  FAIL ${workflow.id}`);
  for (const problem of problems) console.error(`       ${problem}`);
}

// A workflow that runs another one hands it values by id, so every control it
// scopes to the scenes has to be one the scene workflow has, of the same kind —
// a renamed control there would otherwise drop the value without a word.
for (const workflow of WORKFLOWS) {
  if (!workflow.scenes) continue;
  const target = WORKFLOWS.find((other) => other.id === workflow.scenes!.workflow);
  const problems: string[] = [];
  if (!target) {
    problems.push(`scenes names workflow "${workflow.scenes.workflow}", which is not registered`);
  } else {
    for (const param of workflow.params) {
      if (param.scope !== "scenes") continue;
      const there = target.params.find((other) => other.id === param.id);
      if (!there) {
        problems.push(`"${param.id}" is scoped to the scenes, but ${target.id} has no such control`);
      } else if (there.type !== param.type && !(there.type === "select" && param.type === "select")) {
        problems.push(`"${param.id}" is a ${param.type} here and a ${there.type} on ${target.id}`);
      }
    }
  }
  // A bare scene is sent the same values, and drops whatever its graph has no
  // control for — the pictures and voices it has none of. What it does have
  // has to be the same kind of control.
  const bare = workflow.scenes.bare;
  const bareTarget = bare ? WORKFLOWS.find((other) => other.id === bare) : undefined;
  if (bare && !bareTarget) {
    problems.push(`scenes.bare names workflow "${bare}", which is not registered`);
  } else if (bareTarget) {
    for (const param of workflow.params) {
      if (param.scope !== "scenes") continue;
      const there = bareTarget.params.find((other) => other.id === param.id);
      if (there && there.type !== param.type) {
        problems.push(`"${param.id}" is a ${param.type} here and a ${there.type} on ${bareTarget.id}`);
      }
    }
    for (const id of ["prompt", "duration", "seed"]) {
      if (!bareTarget.params.some((param) => param.id === id)) {
        problems.push(`${bareTarget.id} has no "${id}" control for a bare scene to set`);
      }
    }
  }
  if (problems.length > 0) {
    failed = true;
    console.error(`  FAIL ${workflow.id} scenes`);
    for (const problem of problems) console.error(`       ${problem}`);
  } else {
    console.log(`  ok   ${workflow.id} — every scene-scoped control is one ${target!.id} has`);
  }
}

// Every file a graph can name has to say where it comes from, or
// `models:download` cannot fetch it and a new workflow ships with a download
// nobody can find.
const unsourced = [...collect().models.keys()].filter(
  (file) => !(file in MODEL_SOURCES),
);
if (unsourced.length > 0) {
  failed = true;
  console.error("  FAIL model sources");
  for (const file of unsourced) {
    console.error(
      `       ${file} is named by a graph but has no entry in scripts/lib/model-sources.ts`,
    );
  }
}

// The manifest the update runbook and the app read. Stale, it would tell an
// update that needs the ComfyUI machine that it does not.
let written = "";
try {
  written = readFileSync("machine-requirements.json", "utf8");
} catch {
  // Missing reads as stale.
}
// Compared without line endings as well as through .gitattributes: a clone
// made before that file existed, or with eol overrides of its own, still has
// CRLF, and that is not staleness.
const lf = (text: string) => text.replace(/\r\n/g, "\n");
if (lf(written) !== serializeRequirements(buildRequirements())) {
  failed = true;
  console.error("  FAIL machine-requirements.json");
  console.error(
    "       is stale — run `pnpm requirements:write` and commit the result",
  );
}

if (failed) {
  console.error(
    "\nOne or more workflows are out of sync with their graph. Fix the declaration in the workflow file — the `targets`, or whichever rule the line above names.",
  );
  process.exit(1);
}

console.log(`\n${WORKFLOWS.length} workflow(s) valid.`);
