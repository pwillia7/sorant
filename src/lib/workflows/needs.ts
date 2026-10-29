/**
 * What the registered workflows need from a ComfyUI install: every node class
 * and every model file, across every form a graph can take — turbo, each
 * patch, the step-count swap and the reference weights — since those name
 * classes and files no stored graph does.
 *
 * Shared by `check:nodes`, which asks a live install whether it has them,
 * `models:download`, which fetches the files, and the machine requirements
 * manifest the app and the update runbook read — so none of them can disagree
 * about what a workflow needs.
 */
import type { ComfyGraph } from "@/lib/comfy";
import { WORKFLOWS } from "./index";
import { patchVariants } from "./patches";
import { promptConsumer } from "./director";
import { stepSamplerGraph } from "./step-sampler";
import { modelSwapGraph } from "./model-swap";
import { turboGraph } from "./turbo";

/** Loader class -> the inputs naming files, for checking models are present. */
const MODEL_INPUTS: Record<string, string | string[]> = {
  VAELoader: "vae_name",
  UNETLoader: "unet_name",
  CLIPLoader: "clip_name",
  // Edit image's FLUX encoders: two files in one loader.
  DualCLIPLoader: ["clip_name1", "clip_name2"],
  // Upscale's frame interpolation. In the stored graph, so reported as needed,
  // though a run with the frame rate kept removes it.
  FrameInterpolationModelLoader: "model_name",
  // Neither of these is in any stored graph — both are spliced in by a switch.
  // See below.
  MiniMaxH3TurboLoRA: "lora_name",
  LoraLoaderModelOnly: "lora_name",
};

export interface Need {
  workflows: Set<string>;
  /**
   * True while nothing that *has* to run has named this file.
   *
   * For a switch that offers a choice of checkpoint: you download one of the
   * two, so reporting both as required would leave this check permanently red
   * on a correctly set-up machine and train everyone to ignore it. An optional
   * file that is absent is a line of information, not a failure.
   *
   * Cleared rather than set, so a file named by both a required graph and an
   * optional one stays required — being offered as somebody's fallback is not a
   * reason to stop needing it.
   */
  optional: boolean;
}

/**
 * A node class, and every input the graphs drive it through. The inputs are
 * what catch a pack that is installed but too old: the class is there, and the
 * input a newer graph sets on it is not.
 */
export interface ClassNeed extends Need {
  inputs: Set<string>;
}

/**
 * Every class and file the workflows need, or only the ones `ids` names — an
 * install set up for some workflows is asked about those, not failed over the
 * files of the ones it left out.
 */
export function collect(ids?: readonly string[]) {
  const classes = new Map<string, ClassNeed>();
  /** filename -> which loader input it has to appear in. */
  const models = new Map<string, { loader: string; input: string } & Need>();

  /** A graph to check, and whether the run can do without the files it names. */
  interface Candidate {
    label: string;
    graph: ComfyGraph;
    optional?: boolean;
  }

  for (const workflow of WORKFLOWS) {
    if (ids && !ids.includes(workflow.id)) continue;
    // Each mode's graph as well as the stored one. Both are modes rather than
    // second workflows, so the nodes they splice in — and the LoRA files turbo
    // and the style switch name — appear in no graph on disk, and they are
    // exactly the pieces most likely to be missing, since they are the ones
    // that need a custom pack or a separate download.
    //
    // A patch that swaps the base carries its checkpoint the same way: the
    // patched graph loads the bf16 weights the LoRA needs, so this asks whether
    // that file is there rather than only about the quantised one the stored
    // graph names. See `base` on PatchDef.
    //
    // The two are checked separately rather than stacked: what is being asked
    // is whether each class and file exists, and neither node's presence
    // affects the answer for the other.
    const graphs: Candidate[] = [{ label: workflow.id, graph: workflow.graph }];
    if (workflow.turbo) {
      graphs.push({
        label: `${workflow.id} (turbo)`,
        graph: turboGraph(workflow.graph, workflow.turbo),
      });
    }
    for (const patch of workflow.patches ?? []) {
      // Every form the switch can take: one per LoRA it offers, and one more
      // per LoRA that offers a second checkpoint. A switch carrying a list
      // reports each of them optional — see `optional` on Need.
      const promptInput = workflow.directorBypass
        ? (promptConsumer(workflow.graph, workflow.directorBypass) ?? undefined)
        : undefined;
      for (const variant of patchVariants(workflow.graph, patch, promptInput)) {
        graphs.push({
          label: `${workflow.id} (${patch.id}${variant.suffix})`,
          graph: variant.graph,
          optional: variant.optional,
        });
      }
    }
    // And the form the graph takes at the step count that swaps its sampler,
    // which needs no switch at all — so its class would otherwise go unasked
    // about until someone dragged the slider to the end.
    if (workflow.stepSampler) {
      graphs.push({
        label: `${workflow.id} (${workflow.stepSampler.atValue}-step)`,
        graph: stepSamplerGraph(workflow.graph, workflow.stepSampler),
      });
    }
    // And the form it takes with a reference attached, which names model files
    // no stored graph does — so without this the bf16 pair would go unasked
    // about until a run needed it.
    if (workflow.modelSwap) {
      graphs.push({
        label: `${workflow.id} (reference weights)`,
        graph: modelSwapGraph(workflow.graph, workflow.modelSwap),
      });
    }
    for (const { label: used, graph, optional: optionalGraph = false } of graphs) {
      for (const [id, node] of Object.entries(graph)) {
        const optional =
          optionalGraph || (workflow.optionalNodes?.includes(id) ?? false);
        const existing = classes.get(node.class_type);
        if (existing) {
          existing.workflows.add(used);
          if (!optional) existing.optional = false;
          for (const input of Object.keys(node.inputs)) existing.inputs.add(input);
        } else {
          classes.set(node.class_type, {
            workflows: new Set([used]),
            optional,
            inputs: new Set(Object.keys(node.inputs)),
          });
        }

        for (const input of [MODEL_INPUTS[node.class_type] ?? []].flat()) {
          const filename = node.inputs[input];
          if (typeof filename !== "string" || !filename) continue;

          const model = models.get(filename);
          if (model) {
            model.workflows.add(used);
            if (!optional) model.optional = false;
          } else {
            models.set(filename, {
              loader: node.class_type,
              input,
              workflows: new Set([used]),
              optional,
            });
          }
        }
      }
    }
  }

  return { classes, models };
}
