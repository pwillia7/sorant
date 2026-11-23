import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, ParamTarget, ParamValue, WorkflowDef } from "./types";
import { samplingParams } from "./minimax-common";

/**
 * Character swap on a still: one person in a picture becomes the character in
 * another picture, keeping the pose, the framing and everything around them.
 *
 * MiniMax H3 Image's edit mode with akatz-ai's character-swap LoRA
 * (MiniMax-H3-Image-Character-Swap-LoRA, v1), laid out as the author's example
 * workflow, which is the official H3 Image Edit template plus a LoRA loader:
 * <Picture 1> is the picture to change and sets the canvas, <Picture 2> is the
 * character. The author's tested settings — LoRA 1.0, 6 steps of Euler on the
 * simple schedule, CFG 1, about 1 MP at the source's aspect, no prompt
 * enhancer — are the defaults here, and the instruction is the author's own,
 * with the target filled in.
 *
 * Tested on the 3090 (2026-11-23): the author's Rain Rosette replay matched
 * their result, and a photographed courier swapped for a bearded older man
 * kept the bike, the bag, the pose and the backdrop, and took the man's navy
 * sweater for his yellow jacket. The base model alone, without the LoRA, swaps
 * the face and keeps the old clothes. About 40 s at 1 MP.
 *
 * The video Character swap is a different model (H3 Relay on the video
 * weights) and takes a clip; this one takes a still, and is what to use for a
 * poster, a thumbnail, or a reference picture of the character in a scene.
 */

const SOURCE_NODE = "source";
const CHARACTER_NODE = "character";
const SCALE_NODE = "scale";
const COND_NODE = "cond";
const SAVE_NODE = "save";

export const SWAP_LORA = "h3_image_character_swap_v1.safetensors";

/** The author's instruction, with who to replace filled in. */
export function swapInstruction(target: string, extra = ""): string {
  const who = target.trim() || "the main person";
  const tail = extra.trim() ? ` ${extra.trim()}` : "";
  return `Swap only ${who} in <Picture 1> with the character from <Picture 2>. Keep the original scene, framing, other people, and the target's placement and action. Preserve the reference character's appearance, anatomy, proportions, and rendering style, adapting the pose to the source action and matching the scene lighting. If the reference shows several views, they depict the same character. Produce one edited scene.${tail}`;
}

const graph: ComfyGraph = {
  [SAVE_NODE]: {
    class_type: "SaveImage",
    inputs: { images: ["decode", 0], filename_prefix: "image/MiniMax_H3_Image_Swap" },
    _meta: { title: "Save Image" },
  },
  [SOURCE_NODE]: {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image (Picture 1: the picture to change)" },
  },
  [CHARACTER_NODE]: {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image (Picture 2: the character)" },
  },
  // The canvas is the source's own shape at the chosen size; the conditioning
  // reads its width and height off the scaled picture.
  [SCALE_NODE]: {
    class_type: "ImageScaleToTotalPixels",
    inputs: {
      image: [SOURCE_NODE, 0],
      upscale_method: "lanczos",
      megapixels: 1,
      resolution_steps: 32,
    },
    _meta: { title: "Scale Image to Total Pixels" },
  },
  size: {
    class_type: "GetImageSize",
    inputs: { image: [SCALE_NODE, 0] },
    _meta: { title: "Get Image Size" },
  },
  unet: {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_image_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  lora: {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["unet", 0], lora_name: SWAP_LORA, strength_model: 1 },
    _meta: { title: "Character swap LoRA" },
  },
  clip: {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  vae: {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_image_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  [COND_NODE]: {
    class_type: "MiniMaxH3ImageConditioning",
    inputs: {
      clip: ["clip", 0],
      vae: ["vae", 0],
      prompt: swapInstruction(""),
      width: ["size", 0],
      height: ["size", 1],
      "images.image_1": [SCALE_NODE, 0],
      "images.image_2": [CHARACTER_NODE, 0],
    },
    _meta: { title: "MiniMax H3 Image Conditioning" },
  },
  noise: {
    class_type: "RandomNoise",
    inputs: { noise_seed: 904234 },
    _meta: { title: "RandomNoise" },
  },
  guider: {
    class_type: "BasicGuider",
    inputs: { model: ["lora", 0], conditioning: [COND_NODE, 0] },
    _meta: { title: "Basic Guider" },
  },
  sampler: {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "euler" },
    _meta: { title: "KSamplerSelect" },
  },
  scheduler: {
    class_type: "BasicScheduler",
    inputs: { scheduler: "simple", steps: 6, denoise: 1, model: ["lora", 0] },
    _meta: { title: "BasicScheduler" },
  },
  sample: {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["noise", 0],
      guider: ["guider", 0],
      sampler: ["sampler", 0],
      sigmas: ["scheduler", 0],
      latent_image: [COND_NODE, 1],
    },
    _meta: { title: "SamplerCustomAdvanced" },
  },
  decode: {
    class_type: "VAEDecode",
    inputs: { samples: ["sample", 0], vae: ["vae", 0] },
    _meta: { title: "VAE Decode" },
  },
};

/**
 * The instruction, written whole by both controls that shape it — the target
 * and the extra line — for the reason `directorTarget` gives: a target write
 * is an assignment, so each writes the complete string from the whole
 * submission and the order they run in stops mattering.
 */
const instruction: ParamTarget = {
  node: COND_NODE,
  input: "prompt",
  transform: (_value: ParamValue, values: Record<string, ParamValue>) =>
    swapInstruction(String(values.target ?? ""), String(values.extra ?? "")),
};

const params: ParamDef[] = [
  {
    id: "image",
    label: "The picture",
    type: "image",
    default: "",
    required: true,
    help: "The picture to change. Its framing, pose, light and everyone else are kept.",
    group: "Pictures",
    targets: [{ node: SOURCE_NODE, input: "image" }],
  },
  {
    id: "character_image",
    label: "The character",
    type: "image",
    default: "",
    required: true,
    help: "Who they become: a portrait, a full-body shot or a character sheet. Their face, costume and style are carried over.",
    group: "Pictures",
    targets: [{ node: CHARACTER_NODE, input: "image" }],
  },
  {
    id: "target",
    label: "Who to replace",
    type: "text",
    default: "",
    required: true,
    placeholder: "the woman in the dark jacket in the foreground",
    hint: "Name them by position, clothes or what they are doing.",
    help: "Which person in the picture becomes the character. With more than one person in it, say where they are or what they wear — the model can otherwise pick the wrong one.",
    group: "Prompt",
    targets: [instruction],
  },
  {
    id: "extra",
    label: "Anything else",
    type: "textarea",
    default: "",
    rows: 2,
    help: "Optional, added to the end of the instruction — e.g. \"Keep the original jacket.\"",
    group: "Prompt",
    advanced: true,
    targets: [instruction],
  },
  {
    id: "megapixels",
    label: "Image size",
    type: "slider",
    default: 1,
    min: 0.5,
    max: 4,
    step: 0.25,
    unit: "MP",
    help: "The LoRA was trained and tested at about 1 MP. Larger is slower and untested.",
    group: "Output",
    targets: [{ node: SCALE_NODE, input: "megapixels" }],
  },
  {
    id: "lora_strength",
    label: "Swap strength",
    type: "slider",
    default: 1,
    min: 0,
    max: 1.5,
    step: 0.05,
    help: "1 is the author's setting. Lower keeps more of the original outfit; 0 is the base model, which swaps little more than the face.",
    group: "Sampling",
    advanced: true,
    targets: [{ node: "lora", input: "strength_model" }],
  },
  ...samplingParams({ noise: "noise", scheduler: "scheduler" }, { steps: 6 }).map(
    (param) =>
      param.id === "steps" && param.type === "slider"
        ? { ...param, min: 4, max: 16, help: "6 is the author's setting." }
        : param,
  ),
];

export const minimaxH3ImageSwap: WorkflowDef = {
  id: "minimax-h3-image-swap",
  name: "Picture character swap",
  description: "Puts the character from one picture in place of a person in another.",
  estimatedSeconds: 45,
  makes: "image",
  graph,
  params,
};
