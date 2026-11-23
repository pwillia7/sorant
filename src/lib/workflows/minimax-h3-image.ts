import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import { REFERENCE_PARAM } from "./reference-param";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import type { ParamDef, ParamValue, TextParam, WorkflowDef } from "./types";
import {
  aspectRatioParam,
  directorBypassFor,
  directorTarget,
  literalPromptParam,
  lookBlock,
  lookParam,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 Image: the still-image model, not the video model stopped early.
 *
 * Until ComfyUI 0.45 the only H3 in core was the video model, and a still was
 * the first frame of its shortest clip — turbo at 0.38, ER-SDE, 20 steps, about
 * a minute at 2.5 MP on a 3090. H3 Image replaced it on a same-seed comparison
 * (2026-11-23, four prompts: a portrait, chalkboard lettering, a storybook
 * illustration, two people at a table): far finer texture — knit, skin, stubble
 * that the video model smeared — the lettering exact, and three to four times
 * faster. 16 s at 4 MP, 24 s at 8, 47 s at its native 16 MP.
 *
 * Laid out as Comfy-Org's template (image_minimax_h3_image_t2i): the CFG-
 * distilled checkpoint at 6 steps of Euler on the simple schedule, CFG 1. The
 * template's negative is a zeroed conditioning that CFG 1 never reads, so this
 * graph samples with a BasicGuider and has none — the same sampling, and the
 * same seed and steps targets every other H3 graph's controls already know.
 *
 * The text encoder is the video graphs' nvfp4 Qwen3-VL, which the swap LoRA's
 * author also used; the template's 27 GB int8 one would be a second download
 * of the same encoder for no difference anyone has shown.
 *
 * The template's prompt enhancer (Qwen 3.5 9B through TextGenerate) is this
 * app's director instead, on the gateway or the machine as chosen. Its system
 * prompt is the official one cut down to a still and told the canvas shape —
 * the official one picks the aspect ratio itself, and here the user does.
 */

const PROMPT_NODE = "123";
const DIRECTOR_NODE = "121";
const SAVE_NODE = "save";
const SIZE_NODE = "115";
const COND_NODE = "cond";


/**
 * The director for a still on H3 Image. Adapted from MiniMax's own prompt
 * enhancer system prompt for this model (MiniMaxAI/MiniMax-H3-Image-PE,
 * prompt/t2i): the same idea — preserve every hard fact, then make every part
 * of the picture visible and inspectable — without its JSON envelope or its
 * aspect-ratio policy, since the canvas is chosen in the form.
 */
export const STILL_DIRECTOR = `You are the prompt writer for MiniMax H3 Image, a still-image model. Rewrite the user's idea into one detailed, natural English caption of the finished picture.

Write the caption and nothing else: one paragraph, plain present-tense English, no heading, no list, no quotation marks around the whole thing, no commentary before or after.

Act like an expert photographer, illustrator or visual designer, not a word expander. Keep every hard fact from the user exactly: named people and things, counts, colours, clothing, style, medium, left and right order, and any words that must appear in the picture. Then complete the picture with visible, inspectable content. The goal is not more words; it is that someone looking at any important part of the picture finds a real subject, material or detail there.

First decide what kind of picture this is.

A scene or photograph: open with the style and medium — "Live-action, naturalistic photograph", "2D-animated illustration", "watercolor painting", or whatever the user asked for — and the framing: the shot size and the camera angle. Then the subject: who or what it is, what they look like, what they wear and hold, their pose, which way they face relative to the camera, and their expression. Then where they are: the setting, and what is in the foreground and background. Then the light: where it comes from, its quality and colour, the time of day. Then the lens: depth of field, what is sharp and what falls away. For hands, grips, hugs, tools or anything touching, choose a framing that makes the contact readable and say which hand touches what. Keep faces and bodies anatomically natural for the viewpoint.

A designed thing — a poster, a cover, a character sheet, a product board, a label, a sign, a page, a screen, a chart: build it as a finished layout, not a scene containing it. Go through it in reading order — title, subtitle, main image, panels, captions, footer — and give each part its position, its exact text, and what it shows.

Text in the picture: only when the user asks for it, or when the thing itself would carry it (a shop sign, a book cover). Quote the exact words in double quotes and say where they sit and how they are lettered. Otherwise, no captions, titles, logos, watermarks or on-screen text.

Keep the number of main subjects to what the user asked for; anyone else is background. Use world knowledge only as visible evidence — materials, tools, clothing, architecture, cultural motifs — never as backstory that cannot be seen. Replace vague mood words and generic adjectives with specific things the eye can find.

It is one held moment. A pose can be dynamic — mid-stride, mid-jump — but describe it as the instant it is.`;

/**
 * The canvas, told to the director so a portrait subject is not composed for a
 * landscape frame. Last, like the video graphs' length: the one constraint the
 * whole caption has to fit.
 */
function canvasBlock(values: Record<string, ParamValue>): string {
  const ratio = String(values.aspect_ratio ?? "").split(" ")[0];
  if (!/^\d+:\d+$/.test(ratio)) return "";
  const [w, h] = ratio.split(":").map(Number);
  const shape =
    w === h ? "square" : w > h ? "landscape (wider than tall)" : "portrait (taller than wide)";
  return `CANVAS

The picture is ${ratio}, ${shape}. Compose the subject and framing for that shape.`;
}

const graph: ComfyGraph = {
  [SAVE_NODE]: {
    class_type: "SaveImage",
    inputs: {
      images: ["decode", 0],
      filename_prefix: "image/MiniMax_H3_Image",
    },
    _meta: { title: "Save Image" },
  },
  [SIZE_NODE]: {
    class_type: "ResolutionSelector",
    inputs: {
      aspect_ratio: "16:9 (Widescreen)",
      megapixels: 4,
      multiple: 32,
    },
    _meta: { title: "Resolution Selector" },
  },

  // The prompt rewrite, as on Text to Video: 123 holds what the user typed,
  // 121 writes it out as a caption, and the conditioning reads that.
  [DIRECTOR_NODE]: rewriteNode({
    prompt: [PROMPT_NODE, 0],
    system: STILL_DIRECTOR,
    title: "AI Gateway - Rewrite Prompt",
  }),
  [PROMPT_NODE]: {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },

  unet: {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_image_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
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
      prompt: [DIRECTOR_NODE, 0],
      width: [SIZE_NODE, 0],
      height: [SIZE_NODE, 1],
    },
    _meta: { title: "MiniMax H3 Image Conditioning" },
  },
  noise: {
    class_type: "RandomNoise",
    inputs: { noise_seed: 42 },
    _meta: { title: "RandomNoise" },
  },
  guider: {
    class_type: "BasicGuider",
    inputs: { model: ["unet", 0], conditioning: [COND_NODE, 0] },
    _meta: { title: "Basic Guider" },
  },
  sampler: {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "euler" },
    _meta: { title: "KSamplerSelect" },
  },
  scheduler: {
    class_type: "BasicScheduler",
    inputs: { scheduler: "simple", steps: 6, denoise: 1, model: ["unet", 0] },
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

const DEFAULT_PROMPT =
  "An elderly fisherman mending a bright orange net on a wooden dock at dawn, mist over the harbour behind him.";

const ids: Pick<MinimaxNodeIds, "prompt" | "director" | "noise" | "scheduler"> = {
  prompt: { node: PROMPT_NODE, input: "value" },
  director: DIRECTOR_NODE,
  noise: "noise",
  scheduler: "scheduler",
};

const director = directorTarget(ids, STILL_DIRECTOR, [lookBlock], canvasBlock);

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  {
    ...(promptParam(
      ids,
      DEFAULT_PROMPT,
      "One line is enough. A director model fills in the framing, light and detail, and keeps whatever you do specify.",
      6,
    ) as TextParam),
    label: "The picture",
    hint: "One line is enough — a director fills in the framing, light and detail.",
    placeholder: "Describe the picture: the subject, where they are, the light.",
  },
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  lookParam(director),
  // The aspect ratio is also what the director is told the canvas is, so it
  // writes the whole instruction too — see `directorTarget`.
  (() => {
    const aspect = aspectRatioParam(SIZE_NODE);
    return { ...aspect, targets: [...aspect.targets, director] };
  })(),
  {
    id: "megapixels",
    label: "Image size",
    type: "slider",
    default: 4,
    // H3 Image is native at about 16 MP; the template's effective range is 4
    // to 20, and its node is tuned for 2048×2048. 1 MP is allowed for drafts
    // and for references, which the video models read at about 1 MP anyway.
    min: 1,
    max: 16,
    step: 0.5,
    unit: "MP",
    help: "4 MP takes about 16 s on a 3090 and is plenty for references. 16 MP is the model's native size, about 50 s, and the sharpest.",
    group: "Output",
    targets: [{ node: SIZE_NODE, input: "megapixels" }],
  },

  ...samplingParams(ids, { steps: 6 }).map((param) =>
    param.id === "steps" && param.type === "slider"
      ? {
          ...param,
          min: 4,
          max: 16,
          help: "6 is what the distilled model is made for. More rarely helps.",
        }
      : param,
  ),

  {
    id: REFERENCE_PARAM,
    label: "For a reference picture",
    type: "toggle",
    default: false,
    help: "Set by the Create button on a picture. Queues it ahead of anything rendering.",
    group: "Output",
    // Always hidden: a run from the form is a picture to keep, and only the
    // reference bar has a reason to jump the queue.
    hiddenBy: [
      { param: REFERENCE_PARAM, is: false },
      { param: REFERENCE_PARAM, is: true },
    ],
    readBy: "finalize",
    targets: [],
  },
];

export const minimaxH3Image: WorkflowDef = {
  id: "minimax-h3-image",
  name: "Text to Image",
  description: "A still image from a text prompt.",
  estimatedSeconds: 30,
  makes: "image",
  graph,
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  jumpsQueue: (values) => values[REFERENCE_PARAM] === true,
  finalize: (graph, values) => {
    if (values[REFERENCE_PARAM] !== true) return;
    // A name of the run's own, for the reason the Edit tool gives: the result
    // is copied into the input directory by name, overwriting, and a shared
    // prefix's counter restarts whenever that directory is cleared — a new
    // reference could land on an old one a slot still points at.
    graph[SAVE_NODE].inputs.filename_prefix =
      `references/ref_${crypto.randomUUID().slice(0, 8)}`;
  },
  finalizeCases: [
    { name: "a picture to keep", values: { prompt: "a lighthouse at dusk" } },
    {
      name: "a reference picture",
      values: { prompt: "a lighthouse at dusk", [REFERENCE_PARAM]: true },
    },
  ],
};
