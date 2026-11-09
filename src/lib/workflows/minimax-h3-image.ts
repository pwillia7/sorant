import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import type { TurboSpec } from "./turbo";
import type { ParamDef, TextParam, WorkflowDef } from "./types";
import {
  aspectRatioParam,
  directorBypassFor,
  directorTarget,
  h3ContentLora,
  h3Patches,
  h3Turbo,
  literalPromptParam,
  lookBlock,
  lookParam,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 text-to-image: the Text to Video graph, made to stop at a still.
 *
 * H3 is a video model with no image mode of its own. A still is the first
 * frame of the shortest clip it makes — five frames, two latents — which is
 * the community's "recommended" still profile (MiniMax-H3-Image-Studio) and
 * needs nothing but core nodes.
 *
 * Why not one latent, which is what a true single-frame still would be: the
 * H3 VAE decodes groups of latents, and one decoded alone comes back dark and
 * banded. Core fixed that on 2026-10-10 (ComfyUI #16881, from v0.40), but
 * `EmptyMiniMaxH3LatentAV` and the conditioning node still floor the length
 * at five frames, so a one-latent graph needs a custom latent node too
 * (ComfyUI-Fizgig-H3-Still). Two latents decode as an ordinary clip on any
 * version, and the extra one costs a second or two at these sizes.
 *
 * The sampling is not Text to Video's. Turbo at full strength, as the video
 * graphs run it, gives a still the oversaturated, crunchy look; Fizgig's
 * still recipe — the same LoRA at 0.38, `er_sde`, 20 steps — came out
 * natural at the same seed, in about 50 s at 2.5 MP on a 3090. Without turbo,
 * `er_sde` at 50 steps took 80 s and was as natural. And a still wants far
 * more pixels than a frame of video: past H3's ~1 MP video canvas it keeps
 * gaining detail, where a clip would only get slower.
 */

const PROMPT_NODE = "123";
const DIRECTOR_NODE = "121";
const SAVE_NODE = "save";

/**
 * The director for a still. Short beside the video directors: there is no
 * timeline, no cut, no sound and no motion to direct — only one frame to
 * describe completely. It still writes H3's own three fields, because that is
 * the shape the text encoder was trained on.
 */
export const STILL_DIRECTOR = `You are a prompt director for MiniMax H3, writing for a single still image.

H3 is a video model; here it renders one frame, and the frame is the whole result. Your job is to turn the user's idea into a complete description of that one picture.

Write exactly this, and nothing before or after it:

integrated_multimodal_description: [Shot 1] <the picture>

overall_soundscape: Silence.

non_diegetic_music: N/A

THE PICTURE

Open with the style and medium — "Live-action, naturalistic photograph", "2D-animated illustration", "watercolor painting", or whatever the user asked for — then the framing: the shot size, the angle, and that it is a static shot.

Then the subject: who or what it is, what they look like, what they are wearing and holding, their pose and expression. Then where they are: the setting, the foreground and the background, and what is in each. Then the light: where it comes from, its quality and colour, the time of day. Then the lens: depth of field, what is sharp and what falls away.

Describe one held moment. Nobody moves, nothing happens next, and there is no camera move. A pose can be dynamic — mid-stride, mid-jump — but it is described as the instant it is, not as an action.

Keep everything the user specified, exactly. Add only what a photographer or illustrator would have to decide anyway, and keep it consistent with their idea. Write in plain present-tense English, one paragraph, no lists.

No captions, titles, logos, watermarks or on-screen text unless the user asks for them; if they do, quote the words exactly.`;

const graph: ComfyGraph = {
  [SAVE_NODE]: {
    class_type: "SaveImage",
    inputs: {
      images: ["first", 0],
      filename_prefix: "image/MiniMax_H3",
    },
    _meta: { title: "Save Image" },
  },
  first: {
    class_type: "ImageFromBatch",
    inputs: { image: ["105:10", 0], batch_index: 0, length: 1 },
    _meta: { title: "Image From Batch (the first frame)" },
  },
  "115": {
    class_type: "ResolutionSelector",
    inputs: {
      aspect_ratio: "16:9 (Widescreen)",
      megapixels: 2.5,
      multiple: 32,
    },
    _meta: { title: "Resolution Selector" },
  },

  // The prompt rewrite, as on Text to Video: 123 holds what the user typed,
  // 121 writes it out as a description of the frame, and 105:104 reads that.
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

  "105:11": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "105:10": {
    class_type: "VAEDecode",
    inputs: { samples: ["105:14", 0], vae: ["105:11", 0] },
    _meta: { title: "VAE Decode" },
  },
  "105:17": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "er_sde" },
    _meta: { title: "KSamplerSelect" },
  },
  "105:9": {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "simple",
      steps: 50,
      denoise: 1,
      model: ["105:6", 0],
    },
    _meta: { title: "BasicScheduler" },
  },
  "105:14": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["105:15", 0],
      guider: ["105:16", 0],
      sampler: ["105:17", 0],
      sigmas: ["105:9", 0],
      latent_image: ["105:104", 1],
    },
    _meta: { title: "SamplerCustomAdvanced" },
  },
  "105:16": {
    class_type: "BasicGuider",
    inputs: { model: ["105:6", 0], conditioning: ["105:104", 0] },
    _meta: { title: "Basic Guider" },
  },
  "105:6": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  "105:13": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  "105:15": {
    class_type: "RandomNoise",
    inputs: { noise_seed: 368623947151307 },
    _meta: { title: "RandomNoise" },
  },
  "105:104": {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: {
      prompt: [DIRECTOR_NODE, 0],
      width: ["115", 0],
      height: ["115", 1],
      // The node's floor, and the whole clip: two latents, of which the
      // first frame is kept.
      length: 5,
      clip: ["105:13", 0],
      vae: ["105:11", 0],
    },
    _meta: { title: "MiniMax H3 Image to Video" },
  },
};

const DEFAULT_PROMPT =
  "An elderly fisherman mending a bright orange net on a wooden dock at dawn, mist over the harbour behind him.";

const ids: Pick<MinimaxNodeIds, "prompt" | "director" | "noise" | "scheduler"> = {
  prompt: { node: PROMPT_NODE, input: "value" },
  director: DIRECTOR_NODE,
  noise: "105:15",
  scheduler: "105:9",
};

// No length block: there is no duration for the director to time anything to.
const director = directorTarget(ids, STILL_DIRECTOR, [lookBlock], () => "");

const bypass = directorBypassFor(ids);

/**
 * Turbo as a still wants it: the video graphs' LoRA and node, at Fizgig's
 * strength and step count rather than the video ones. At full strength the
 * still is oversaturated and over-sharpened; at 0.38 it is natural and still
 * converges in 20 steps.
 */
const video = h3Turbo(50);
const turbo: TurboSpec = {
  ...video,
  node: {
    ...video.node,
    inputs: { ...video.node.inputs, strength: 0.38 },
  },
  steps: {
    param: "steps",
    default: 20,
    min: 8,
    max: 30,
    help: "20 is where the still recipe converges. Fewer is faster and rougher.",
  },
  strength: {
    ...video.strength!,
    default: 0.38,
    min: 0.2,
    max: 1,
    help: "0.38 keeps colour and skin natural. Toward 1 is punchier and more over-sharpened — the video graphs' setting.",
  },
};

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
  aspectRatioParam("115"),
  {
    id: "megapixels",
    label: "Image size",
    type: "slider",
    default: 2.5,
    // Not the video graphs' 1 MP cap. That cap is about a clip, where frames
    // past H3's native canvas only cost time; a still keeps gaining detail
    // well past it, and is two latents rather than a hundred, so the time
    // stays small.
    min: 1,
    max: 4,
    step: 0.1,
    unit: "MP",
    help: "Stills come out best from about 2.5 MP up. 1 MP is quicker for trying ideas.",
    group: "Output",
    targets: [{ node: "115", input: "megapixels" }],
  },

  ...samplingParams(ids, { steps: 50 }),
];

export const minimaxH3Image: WorkflowDef = {
  id: "minimax-h3-image",
  name: "Text to Image",
  description: "A still image from a text prompt.",
  estimatedSeconds: 90,
  makes: "image",
  graph,
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  turbo,
  patches: [h3ContentLora(), ...h3Patches()],
};
