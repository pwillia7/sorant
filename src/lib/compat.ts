import requirements from "../../machine-requirements.json";
import { enumValuesFor, probeNodeSchema } from "./comfy";
import {
  findLocalDirectorFile,
  LOCAL_DIRECTOR_MODELS,
  LOCAL_LOADER_CLASS,
} from "./workflows/local-director";
import type { MachineRequirements } from "./workflows/requirements";

/**
 * Whether the ComfyUI machine can run what this version of the app asks of
 * it, workflow by workflow — the in-app half of `pnpm check:nodes`.
 *
 * Its job is the state an update can leave behind: the app redeployed, the
 * machine not. A new graph naming a class the machine lacks, or a model file
 * it has not downloaded, otherwise fails several minutes after Generate with
 * ComfyUI's own error. Said on the workflow card instead, before anyone
 * presses anything. Node classes and model files only — see below for why not
 * inputs.
 *
 * Reads the committed manifest rather than recomputing it, so it checks the
 * same list the update runbook compared. Only certain answers count: a class
 * ComfyUI could not be asked about is "unknown", never "missing".
 */

export interface CompatProblem {
  kind: "node" | "model";
  /** The class or model filename. */
  name: string;
  /** What to do about it, on the ComfyUI machine. */
  fix: string;
}

export interface WorkflowCompat {
  /** Problems with the graph every run of the workflow uses. */
  blocking: CompatProblem[];
  /** Problems that only stop one mode — Turbo, a patch, the reference weights. */
  modes: { mode: string; problems: CompatProblem[] }[];
}

export interface CompatReport {
  /** False when ComfyUI could not be asked at all; nothing else is meaningful then. */
  checked: boolean;
  /** Some classes could not be asked about, so the report may be missing problems. */
  incomplete: boolean;
  workflows: Record<string, WorkflowCompat>;
  /**
   * Which local director models the machine has a file for, by id — or null
   * when its text encoders could not be listed. What decides whether a
   * browser that has never chosen starts on the local director. See
   * `readStoredDirectorEngine`.
   */
  localDirectors: string[] | null;
}

const MANIFEST = requirements as MachineRequirements;

/**
 * The node packs the runbook installs, by the classes they provide — so a
 * missing class can be traced to a pack without ComfyUI's help, which it
 * cannot give for a class it does not have.
 */
const PACKS: { name: string; owns: (cls: string) => boolean }[] = [
  {
    name: "ComfyUI-VideoHelperSuite",
    owns: (c) => c.startsWith("VHS_"),
  },
  {
    name: "ComfyUI-MiniMax-H3-Turbo",
    owns: (c) => c.startsWith("MiniMaxH3Turbo"),
  },
  {
    name: "ComfyUI-Spectrum-MiniMax-H3",
    owns: (c) => c.startsWith("Spectrum"),
  },
  {
    name: "comfyui-vercel-ai-gateway",
    owns: (c) => c.startsWith("VercelAIGateway"),
  },
  {
    name: "ComfyUI_Nvidia_VFX_Nodes",
    owns: (c) => c.startsWith("RTXVideo"),
  },
  {
    name: "ComfyUI-KJNodes",
    owns: (c) =>
      c.endsWith("KJ") ||
      ["AudioConcatenate", "GetImageSizeAndCount", "RandomImageFromBatch"].includes(c),
  },
];

function missingClassFix(cls: string): string {
  const pack = PACKS.find((p) => p.owns(cls));
  return pack
    ? `Install the ${pack.name} node pack on the ComfyUI machine, then restart ComfyUI.`
    : "Install the node pack that provides it on the ComfyUI machine, or update ComfyUI if it is a core node.";
}

/** "minimax-h3 (turbo)" -> ["minimax-h3", "turbo"]; "minimax-h3" -> ["minimax-h3", null]. */
function splitLabel(label: string): [string, string | null] {
  const match = /^(.*?) \((.*)\)$/.exec(label);
  return match ? [match[1], match[2]] : [label, null];
}

/** Ask a handful at a time: ComfyUI answers /object_info on its generation loop. */
async function probeAll(names: string[]) {
  const results = new Map<string, Awaited<ReturnType<typeof probeNodeSchema>>>();
  const queue = [...names];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let name = queue.shift(); name; name = queue.shift()) {
        results.set(name, await probeNodeSchema(name));
      }
    }),
  );
  return results;
}

async function buildReport(): Promise<CompatReport> {
  const probes = await probeAll(Object.keys(MANIFEST.classes));
  const answers = [...probes.values()];
  if (answers.every((answer) => answer === "unknown")) {
    return { checked: false, incomplete: true, workflows: {}, localDirectors: null };
  }

  const workflows: Record<string, WorkflowCompat> = {};
  const add = (labels: string[], problem: CompatProblem) => {
    for (const label of labels) {
      const [id, mode] = splitLabel(label);
      const entry = (workflows[id] ??= { blocking: [], modes: [] });
      if (mode === null) {
        if (!entry.blocking.some((p) => p.name === problem.name)) entry.blocking.push(problem);
        continue;
      }
      let slot = entry.modes.find((m) => m.mode === mode);
      if (!slot) entry.modes.push((slot = { mode, problems: [] }));
      if (!slot.problems.some((p) => p.name === problem.name)) slot.problems.push(problem);
    }
  };

  for (const [cls, need] of Object.entries(MANIFEST.classes)) {
    const schema = probes.get(cls);
    if (schema === "unknown" || schema === undefined) continue;
    if (schema === "absent") {
      add(need.workflows, { kind: "node", name: cls, fix: missingClassFix(cls) });
      continue;
    }
    // Present. Its inputs are not checked here: ComfyUI's schema leaves out
    // the ones that grow (`images.image0`), the ones that appear per setting
    // (VideoHelperSuite's per-format `crf`), and front-end widgets that ride
    // along in an export (`SaveVideo.video-preview`), so a check by input name
    // flags a correct machine. The manifest still records them, which is where
    // they earn their keep: a release that changes them moves the fingerprint,
    // and the update runbook takes that to the ComfyUI machine.
  }

  for (const [file, need] of Object.entries(MANIFEST.models)) {
    // An optional file is the other side of a choice; its absence is fine.
    if (need.optional) continue;
    const schema = probes.get(need.loader);
    if (!schema || typeof schema === "string") continue;
    const installed = enumValuesFor(schema, need.input);
    if (installed === null || installed.includes(file)) continue;
    const ids = [...new Set(need.workflows.map((label) => splitLabel(label)[0]))];
    add(need.workflows, {
      kind: "model",
      name: file,
      fix: `Run pnpm models:download --comfy <your ComfyUI folder> --workflows ${ids.join(",")} on the ComfyUI machine.`,
    });
  }

  const loader = probes.get(LOCAL_LOADER_CLASS) ?? (await probeNodeSchema(LOCAL_LOADER_CLASS));
  const encoders = typeof loader === "string" ? null : enumValuesFor(loader, "clip_name");
  const localDirectors = encoders
    ? LOCAL_DIRECTOR_MODELS.filter((model) => findLocalDirectorFile(model, encoders)).map(
        (model) => model.id,
      )
    : null;

  return {
    checked: true,
    incomplete: answers.includes("unknown"),
    workflows,
    localDirectors,
  };
}

/**
 * Held for a few minutes: what is installed changes only when someone restarts
 * ComfyUI, and asking costs it seventy schema lookups. An incomplete answer is
 * kept briefly, so a busy machine is asked again soon.
 */
const COMPLETE_TTL_MS = 5 * 60_000;
const INCOMPLETE_TTL_MS = 30_000;
let cache: { at: number; report: CompatReport } | null = null;
let inflight: Promise<CompatReport> | null = null;

export async function compatReport(): Promise<CompatReport> {
  if (cache) {
    const ttl = cache.report.incomplete ? INCOMPLETE_TTL_MS : COMPLETE_TTL_MS;
    if (Date.now() - cache.at < ttl) return cache.report;
  }
  inflight ??= buildReport()
    .then((report) => {
      cache = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
