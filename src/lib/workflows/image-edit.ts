import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import {
  EDIT_SAMPLER_NODE,
  IMAGE_EDIT_SETTINGS,
} from "./image-edit-settings";
import type { ParamDef, WorkflowDef } from "./types";

/**
 * MiniMax H3 Image's edit mode: a reference picture, changed by a sentence.
 *
 * Not a generator — the Edit button on an image control queues it and writes
 * the result back into that control. Laid out as Comfy-Org's template
 * (image_minimax_h3_image_edit): the picture is <Picture 1>, anchored as a
 * reference latent through the VAE, and the canvas is its own size; the
 * CFG-distilled checkpoint runs 6 steps of Euler on the simple schedule at
 * CFG 1, with a zeroed negative CFG 1 never reads.
 *
 * It replaced FLUX.1 Kontext dev on 2026-11-23, after six edits on both, two
 * seeds each for three of them: an outfit change, adding an object, a scene
 * change, a relight, new words on a chalkboard. H3 held faces and hair where
 * Kontext straightened curls and once changed the hair and the jacket colour,
 * followed the instruction as closely or closer, and took about 28 s warm
 * where Kontext took 49 — 9 s for another take of the same edit, since the
 * encoded picture and instruction are reused. It is also the model Text to
 * Image already loads, so the Edit button no longer needs a 29 GB model of its
 * own.
 *
 * Choices kept from the Kontext graph:
 * 1. **The picture's own shape.** `ImageScaleToTotalPixels` to 1 MP on a 32 px
 *    grid. The template upscales to 16 MP; an image-to-video run inherits this
 *    frame, and 1 MP is where H3 video stops, so nothing past it would be used.
 * 2. **No rewrite.** The template's prompt enhancer is off: the instruction
 *    goes in as typed, which is what the comparison ran.
 */

const IMAGE_NODE = "10";
const SCALE_NODE = "11";
const COND_NODE = "4";
const SAMPLER_NODE = EDIT_SAMPLER_NODE;
const SAVE_NODE = "9";
const INSTRUCTION_PARAM = "instruction";

const graph: ComfyGraph = {
  "1": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_image_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
  },
  "2": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
  },
  "3": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_image_vae_fp16.safetensors" },
  },
  [IMAGE_NODE]: {
    class_type: "LoadImage",
    inputs: { image: "example.png" },
  },
  [SCALE_NODE]: {
    class_type: "ImageScaleToTotalPixels",
    inputs: {
      image: [IMAGE_NODE, 0],
      upscale_method: "lanczos",
      megapixels: 1,
      resolution_steps: 32,
    },
  },
  "12": {
    class_type: "GetImageSize",
    inputs: { image: [SCALE_NODE, 0] },
  },
  [COND_NODE]: {
    class_type: "MiniMaxH3ImageConditioning",
    inputs: {
      clip: ["2", 0],
      vae: ["3", 0],
      prompt: "",
      width: ["12", 0],
      height: ["12", 1],
      "images.image_1": [SCALE_NODE, 0],
    },
  },
  "5": {
    class_type: "ConditioningZeroOut",
    inputs: { conditioning: [COND_NODE, 0] },
  },
  [SAMPLER_NODE]: {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      seed: 0,
      steps: 6,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      positive: [COND_NODE, 0],
      negative: ["5", 0],
      latent_image: [COND_NODE, 1],
      denoise: 1,
    },
  },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: [SAMPLER_NODE, 0], vae: ["3", 0] },
  },
  [SAVE_NODE]: {
    class_type: "SaveImage",
    inputs: { images: ["8", 0], filename_prefix: "edits/edit" },
  },
};

const params: ParamDef[] = [
  {
    id: "image",
    label: "Image",
    type: "image",
    default: "",
    required: true,
    targets: [{ node: IMAGE_NODE, input: "image" }],
  },
  {
    id: INSTRUCTION_PARAM,
    label: "Change",
    type: "text",
    default: "",
    maxLength: 1000,
    targets: [{ node: COND_NODE, input: "prompt" }],
  },
  {
    id: "seed",
    label: "Seed",
    type: "seed",
    default: -1,
    targets: [{ node: SAMPLER_NODE, input: "seed" }],
  },
  ...IMAGE_EDIT_SETTINGS,
];

export const imageEdit: WorkflowDef = {
  id: "image-edit",
  name: "Edit image",
  description: "Changes a reference picture by a sentence.",
  estimatedSeconds: 30,
  graph,
  params,
  tool: true,
  finalize: (graph, values) => {
    // An empty instruction, which the model would answer with a lightly
    // redrawn copy of the picture — half a minute for nothing.
    if (!String(values[INSTRUCTION_PARAM] ?? "").trim()) {
      throw new ParamError("Say what should change.", INSTRUCTION_PARAM);
    }
    // A name of the run's own. The result is copied into the input directory
    // by name, overwriting, and an output counter restarts when that directory
    // is cleared — so a shared prefix could land a new edit on top of an old
    // one a slot still points at.
    graph[SAVE_NODE].inputs.filename_prefix =
      `edits/edit_${crypto.randomUUID().slice(0, 8)}`;
  },
  finalizeCases: [
    {
      name: "an instruction",
      values: { image: "example.png", [INSTRUCTION_PARAM]: "make it night" },
    },
    {
      name: "tuned settings",
      values: {
        image: "example.png",
        [INSTRUCTION_PARAM]: "make it night",
        steps: 10,
      },
    },
    {
      name: "no instruction",
      values: { image: "example.png", [INSTRUCTION_PARAM]: "  " },
      rejects: "Say what should change",
    },
  ],
};
