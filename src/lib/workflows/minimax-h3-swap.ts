import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * MiniMax H3 character swap: one person in a clip you have becomes the
 * character in a picture, and everything else about the clip stays.
 *
 * Built on akatz-ai's Character Swap LoRA,
 * <https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA>, run the
 * way its author runs it: through H3 Relay 2.0 (<https://github.com/akatz-ai/h3-relay>,
 * pinned at e2a7665, v2.0.1), whose toolkit graph `H3-Character-Swap.api.json`
 * this one follows node for node. The graph is ours; Relay is a node pack the
 * ComfyUI machine installs, and nothing of its code is copied here.
 *
 * **Why Relay (2026-11-06).** The earlier graph was the LoRA's core-nodes
 * example, with VHS's Meta Batch Manager cutting a long clip into five-second
 * passes. Each pass was a fresh swap, so every join was a cold restart — the
 * face and costume shifted there, and a pass could go flat for a moment. And
 * with nothing telling the model *where* the person was, a shot without them
 * got the character anyway, or the picture's own background. Relay fixes both
 * the way the LoRA's author does:
 *
 * - **A mask.** SAM 3.1 finds "who to replace" on the first frame, tracks
 *   them through the clip and grows the mask by `expansion_px`; the edit is
 *   confined to it (`H3RelayApplyEditMask`) and the rest of the frame comes
 *   from the source latent.
 * - **Windows that continue.** The clip is planned into windows on H3's 17k+5
 *   grid (`H3RelayWindowPlan`, the "adaptive" schedule). From the second on,
 *   each window carries the last `history_frames` of what was already made as
 *   its history (`H3RelayApplyHistory`), so it picks up where the one before
 *   left off rather than starting over. One native StartLoop/EndLoop runs them
 *   all inside a single ComfyUI job.
 *
 * **Window length.** 124 frames, 5.2 s, with an 18-frame history: the
 * author's tested window, and the only one offered. Relay takes any 17k+5
 * window up to 362 frames (15 s), and 10 and 15 s were tried as a choice
 * (2026-11-06), but the 5 s result was clean and the longer ones need far
 * more memory than a 24 GB card has at 1 MP, so they were left out untested.
 * `H3RelaySamplingMemory` is told the activation memory to reserve, scaled
 * from the author's measured 17 GiB at 124 frames and 1 MP — see
 * `activationGib`.
 *
 * **The recipe is the author's, not this app's Turbo switch.** The FL2V
 * Turbo 8-step LoRA at 1.0 under the swap LoRA at 1.0, 8 steps of
 * `er_sde`/`normal`, CFG 1, sigma shift 12/3 and Comfy Kitchen attention. The
 * app's own Turbo (`turbo_v4` through MiniMaxH3TurboLoRA) and its patches are
 * not offered on this graph: neither was tested with Relay's windows and
 * masks, and the LoRA was trained against this pairing.
 *
 * **The int8 base, on purpose.** Everywhere else a LoRA moves the graph off
 * `_pruned_int8_convrot` (see H3_FL2VA_LORA_BASES); this LoRA was *trained* on
 * `minimax_h3_ref2va_pruned_int8_convrot`, so that is the base it is right on.
 *
 * **No prompt director.** The LoRA was trained on one shape of instruction, so
 * the prompt is the author's template filled from short fields, not something
 * a model rewrites.
 */

const VIDEO_PARAM = "source_video";
const IMAGE_PARAM = "character_image";
const CLIP_SECONDS_PARAM = "clip_seconds";
const KEEP_SOUND_PARAM = "keep_sound";
const RESOLUTION_PARAM = "resolution";

/** The author's: no trigger word, and 1.0 is what it was trained at. */
const SWAP_LORA = "h3_character_swap_v1.5.safetensors";
/** The distilled LoRA the author's recipe pairs with it, also at 1.0. */
const TURBO_LORA = "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors";
const SAM_MODEL = "sam3.1_multiplex_fp16.safetensors";

/**
 * Clips longer than this are refused. Relay holds the whole prepared clip, its
 * masks and every finished window in memory until the end, and SAM tracks the
 * whole clip in one go; a minute at 1 MP is already ~1,440 frames of each.
 */
const MAX_CLIP_SECONDS = 60;

/** The author's tested window: 124 frames, 5.2 s. */
const WINDOW_FRAMES = 124;

/**
 * Activation memory to reserve for one window, in GiB.
 *
 * The author measured 17 GiB at 124 frames and 1 MP ("768"); the stock
 * estimate there loaded 19.3 GiB of weights and failed on its first step. H3's
 * tokens grow with frames times pixels, so the estimate is scaled by both
 * (the frames are fixed today; the scaling stays for a longer window).
 * Capped below the card's 24 GB, past which reserving more only forces every
 * weight off the GPU without making room for anything.
 */
export function activationGib(values: Record<string, ParamValue>): number {
  const pixels = String(values[RESOLUTION_PARAM] ?? "768") === "480" ? 0.5 : 1;
  const gib = 17 * (WINDOW_FRAMES / 124) * pixels;
  return Math.min(22, Math.round(gib * 2) / 2);
}

const text = (value: ParamValue | undefined): string =>
  String(value ?? "")
    .trim()
    .replace(/[.\s]+$/, "");

/**
 * The instruction, in the shape of the LoRA card's own example, with the
 * person to replace and the character filled in.
 *
 * Every control that shapes it writes the whole of it, because a target write
 * is an assignment and the last one wins. See `ParamTarget.transform`.
 */
export function swapPrompt(values: Record<string, ParamValue>): string {
  const who = text(values.prompt) || "the selected person";
  const character = text(values.character);
  const extra = String(values.extra ?? "").trim();
  return [
    `Replace ${who} in <Video 1> with the character in <Picture 1>${character ? `, ${character}` : ""}.`,
    "Keep the reference character's face, hair and clothing.",
    "Follow the source performance's pose, gaze, expression and movement.",
    "Preserve the scene and the other people.",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What SAM looks for: a short noun phrase. */
export function samSubject(values: Record<string, ParamValue>): string {
  return text(values.prompt).replace(/^(the|a|an)\s+/i, "") || "person";
}

const promptTarget = {
  node: "reference_conditioning",
  input: "prompt",
  transform: (_value: ParamValue, values: Record<string, ParamValue>) => swapPrompt(values),
};

const graph: ComfyGraph = {
  model: {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  shift: {
    class_type: "MiniMaxH3SigmaShift",
    inputs: { model: ["model", 0], shift_video: 12, shift_audio: 3 },
    _meta: { title: "MiniMax H3 Sigma Shift" },
  },
  attention: {
    class_type: "ModelAttentionBackend",
    inputs: { model: ["shift", 0], attention: "comfy kitchen attention" },
    _meta: { title: "Attention Backend" },
  },
  turbo: {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["attention", 0], lora_name: TURBO_LORA, strength_model: 1 },
    _meta: { title: "FL2V Turbo 8-step LoRA" },
  },
  adapter: {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["turbo", 0], lora_name: SWAP_LORA, strength_model: 1 },
    _meta: { title: "Character Swap LoRA" },
  },
  text: {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  text_device: {
    class_type: "SelectCLIPDevice",
    inputs: { clip: ["text", 0], device: "gpu:0" },
    _meta: { title: "Select CLIP Device" },
  },
  // Releases the VAEs before Qwen's peak and Qwen before sampling; the
  // author's 24 GB test ran out of memory without it.
  text_memory: {
    class_type: "H3RelayTextMemory",
    inputs: { clip: ["text_device", 0] },
    _meta: { title: "Text Stage Memory" },
  },
  video_vae: {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  audio_vae: {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    _meta: { title: "Load VAE" },
  },
  source: {
    class_type: "LoadVideo",
    inputs: { file: "" },
    _meta: { title: "Load Video" },
  },
  // 24 fps, a 32-pixel canvas within the pixel budget, and silence for a clip
  // with no sound. Outputs: 0 frames, 1 audio, 5 the source frame count.
  prepare: {
    class_type: "H3RelayPrepareSource",
    inputs: {
      video: ["source", 0],
      resolution: "768",
      duration_seconds: 0,
      missing_audio: "silence",
    },
    _meta: { title: "Prepare Source" },
  },
  dimensions: {
    class_type: "GetImageSize",
    inputs: { image: ["prepare", 0] },
    _meta: { title: "Get Image Size" },
  },
  reference: {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image (character)" },
  },
  sam: {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: SAM_MODEL },
    _meta: { title: "Load SAM 3.1" },
  },
  subject: {
    class_type: "CLIPTextEncode",
    inputs: { clip: ["sam", 1], text: "person" },
    _meta: { title: "Who to replace (SAM)" },
  },
  first_frame: {
    class_type: "ImageFromBatch",
    inputs: { image: ["prepare", 0], batch_index: 0, length: 1 },
    _meta: { title: "First Frame" },
  },
  detect: {
    class_type: "SAM3_Detect",
    inputs: {
      model: ["sam", 0],
      image: ["first_frame", 0],
      conditioning: ["subject", 0],
      threshold: 0.35,
      refine_iterations: 2,
      individual_masks: true,
    },
    _meta: { title: "SAM3 Detect" },
  },
  select: {
    class_type: "H3RelaySelectMask",
    inputs: { masks: ["detect", 0], selection: "largest", index: 0 },
    _meta: { title: "Select Person" },
  },
  track: {
    class_type: "SAM3_VideoTrack",
    inputs: {
      model: ["sam", 0],
      images: ["prepare", 0],
      initial_mask: ["select", 0],
      conditioning: ["subject", 0],
      detection_threshold: 0.5,
      max_objects: 1,
      detect_interval: 1,
    },
    _meta: { title: "SAM3 Video Track" },
  },
  mask: {
    class_type: "SAM3_TrackToMask",
    inputs: { track_data: ["track", 0], object_indices: "" },
    _meta: { title: "Track To Mask" },
  },
  recover: {
    class_type: "H3RelayRecoverMasks",
    inputs: {
      masks: ["mask", 0],
      images: ["prepare", 0],
      source_frames: ["prepare", 5],
      model: ["sam", 0],
      conditioning: ["subject", 0],
      selection: ["select", 1],
      recover_empty_frames: true,
    },
    _meta: { title: "Recover Masks" },
  },
  expand_mask: {
    class_type: "H3RelayExpandMask",
    inputs: {
      masks: ["recover", 0],
      images: ["prepare", 0],
      source_frames: ["prepare", 5],
      expansion_px: 64,
    },
    _meta: { title: "Expand Mask" },
  },
  plan: {
    class_type: "H3RelayWindowPlan",
    inputs: {
      source_frames: ["prepare", 5],
      window_frames: String(WINDOW_FRAMES),
      history_frames: "18",
      seed: 904239,
      schedule: "adaptive",
      seed_mode: "fixed",
      seed_overrides: "{}",
    },
    _meta: { title: "Window Plan" },
  },
  start: {
    class_type: "StartLoop",
    inputs: { mode: "simple", "mode.num_iterations": ["plan", 2], cache_iterations: false },
    _meta: { title: "Start Loop" },
  },
  window: {
    class_type: "H3RelayWindowInputs",
    inputs: {
      source: ["prepare", 0],
      window: ["plan", 3],
      iteration_index: ["start", 0],
      previous: ["start", 4],
      reference_history: true,
      fps: 24,
      resize_anchor: true,
      history_audio_mode: "source",
      source_audio: ["prepare", 1],
      mask: ["expand_mask", 0],
    },
    _meta: { title: "Window Inputs" },
  },
  reference_conditioning: {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      clip: ["text_memory", 0],
      prompt: "",
      width: ["dimensions", 0],
      height: ["dimensions", 1],
      length: ["window", 8],
      ref_image_size: "match",
      "ref_videos.ref_video_0": ["window", 5],
      "ref_images.ref_image_0": ["reference", 0],
      vae: ["video_vae", 0],
      audio_vae: ["audio_vae", 0],
      "ref_audios.ref_audio_0": ["window", 6],
    },
    _meta: { title: "MiniMax H3 Reference to Video" },
  },
  history: {
    class_type: "H3RelayApplyHistory",
    inputs: {
      positive: ["reference_conditioning", 0],
      latent: ["reference_conditioning", 1],
      vae: ["video_vae", 0],
      audio_vae: ["audio_vae", 0],
      frames: ["window", 3],
      history_frames: ["window", 7],
      first_frame_guide: false,
      target_audio_guide: true,
      audio: ["window", 4],
    },
    _meta: { title: "Apply History" },
  },
  encode_source: {
    class_type: "VAEEncode",
    inputs: { pixels: ["window", 0], vae: ["video_vae", 0] },
    _meta: { title: "VAE Encode (source window)" },
  },
  edit_mask: {
    class_type: "H3RelayApplyEditMask",
    inputs: { latent: ["history", 1], source_latent: ["encode_source", 0], mask: ["window", 1] },
    _meta: { title: "Apply Edit Mask" },
  },
  guide: {
    class_type: "MiniMaxH3AddGuide",
    inputs: {
      positive: ["history", 0],
      latent: ["edit_mask", 0],
      frame_idx: 0,
      audio_vae: ["audio_vae", 0],
      audio: ["window", 2],
    },
    _meta: { title: "MiniMax H3 Add Guide" },
  },
  sampling_memory: {
    class_type: "H3RelaySamplingMemory",
    inputs: {
      model: ["adapter", 0],
      latent: ["edit_mask", 0],
      conditioning: ["guide", 0],
      activation_memory_gib: 17,
    },
    _meta: { title: "Sampling Workspace" },
  },
  noise: {
    class_type: "RandomNoise",
    inputs: { noise_seed: ["window", 10] },
    _meta: { title: "RandomNoise" },
  },
  guider: {
    class_type: "CFGGuider",
    inputs: { model: ["sampling_memory", 0], positive: ["guide", 0], negative: ["guide", 0], cfg: 1 },
    _meta: { title: "CFG Guider" },
  },
  sampler: {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "er_sde" },
    _meta: { title: "KSamplerSelect" },
  },
  schedule: {
    class_type: "BasicScheduler",
    inputs: { model: ["adapter", 0], scheduler: "normal", steps: 8, denoise: 1 },
    _meta: { title: "BasicScheduler" },
  },
  sample: {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["noise", 0],
      guider: ["guider", 0],
      sampler: ["sampler", 0],
      sigmas: ["schedule", 0],
      latent_image: ["edit_mask", 0],
    },
    _meta: { title: "SamplerCustomAdvanced" },
  },
  separate: {
    class_type: "LTXVSeparateAVLatent",
    inputs: { av_latent: ["sample", 0] },
    _meta: { title: "Separate AV Latent" },
  },
  decode: {
    class_type: "VAEDecode",
    inputs: { samples: ["separate", 0], vae: ["video_vae", 0] },
    _meta: { title: "VAE Decode" },
  },
  // H3's own sound for the window, kept only when the clip's is not — see
  // `keep_sound` and finalize.
  decode_audio: {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["separate", 1], vae: ["audio_vae", 0] },
    _meta: { title: "VAE Decode Audio" },
  },
  append: {
    class_type: "H3RelayAppendWindow",
    inputs: { frames: ["decode", 0], window: ["window", 12], previous: ["start", 4], audio: ["decode_audio", 0] },
    _meta: { title: "Append Window" },
  },
  end: {
    class_type: "EndLoop",
    inputs: { output_value: ["append", 0], next_iteration_value: ["append", 0], accumulate: false },
    _meta: { title: "End Loop" },
  },
  finish: {
    class_type: "H3RelayFinishWindows",
    inputs: { state: ["end", 0], audio_mode: "source", source_audio: ["prepare", 1] },
    _meta: { title: "Finish Windows" },
  },
  video: {
    class_type: "CreateVideo",
    inputs: { images: ["finish", 0], fps: ["finish", 2], audio: ["finish", 1] },
    _meta: { title: "Create Video" },
  },
  save: {
    class_type: "SaveVideo",
    inputs: {
      video: ["video", 0],
      filename_prefix: "video/MiniMax_H3_swap",
      format: "mp4",
      "format.codec": "h264",
      "format.codec.encoding": "re-encode",
      "format.codec.encoding.crf": 16,
    },
    _meta: { title: "Save Video" },
  },
};

const params: ParamDef[] = [
  {
    id: VIDEO_PARAM,
    label: "Clip",
    type: "video",
    default: "",
    required: true,
    help: "One continuous shot, up to a minute, with the person in it from the first frame. A cut to a shot without them confuses the tracking — trim those out first.",
    group: "Source",
    maxSeconds: MAX_CLIP_SECONDS,
    measures: CLIP_SECONDS_PARAM,
    targets: [{ node: "source", input: "file" }],
  },
  {
    id: CLIP_SECONDS_PARAM,
    label: "Clip length",
    type: "measured",
    default: 0,
    group: "Source",
    // Read for the estimate (`slicedBy`). In the graph, zero is "the whole
    // clip": Prepare Source measures it exactly itself, and a length rounded
    // in the browser could drop the last frame.
    targets: [{ node: "prepare", input: "duration_seconds", transform: () => 0 }],
  },
  {
    id: IMAGE_PARAM,
    label: "Character",
    type: "image",
    default: "",
    required: true,
    help: "Who they become — face, hair and outfit come from here. Crop to the person on a plain background: what is behind them can leak in.",
    group: "Source",
    targets: [{ node: "reference", input: "image" }],
  },
  {
    id: "prompt",
    label: "Who to replace",
    type: "text",
    default: "",
    placeholder: "man in a cowboy hat",
    help: "A short description SAM can find them by on the first frame — what they are and what they wear. Only they are changed; everyone else is kept.",
    group: "Prompt",
    targets: [promptTarget, { node: "subject", input: "text", transform: (_v, values) => samSubject(values) }],
  },
  {
    id: "pick",
    label: "If several match",
    type: "select",
    default: "largest",
    options: [
      { value: "largest", label: "The biggest in frame" },
      { value: "leftmost", label: "The one furthest left" },
      { value: "rightmost", label: "The one furthest right" },
    ],
    help: "Which match on the first frame to follow, when the description fits more than one person.",
    group: "Prompt",
    targets: [{ node: "select", input: "selection" }],
  },
  {
    id: "character",
    label: "Describe the character",
    type: "text",
    default: "",
    required: true,
    placeholder: "a man with a beard in a backwards black cap and a camo shirt",
    help: "Who is in the picture: hair, headwear, clothes, colours, and the clip's look if it differs (\"in grainy black and white\"). Describe what the picture shows — when the two disagree, the description wins.",
    group: "Prompt",
    targets: [promptTarget],
  },
  {
    id: "extra",
    label: "Anything else",
    type: "textarea",
    default: "",
    rows: 2,
    help: "Optional, added to the end of the instruction. More words do not make the swap hold better — keep it short.",
    group: "Prompt",
    advanced: true,
    targets: [promptTarget],
  },
  {
    id: RESOLUTION_PARAM,
    label: "Resolution",
    type: "select",
    default: "768",
    options: [
      { value: "768", label: "1 MP (about 1024×1024, or 1344×768)" },
      { value: "480", label: "0.5 MP (faster)" },
    ],
    help: "The clip is fitted to this pixel budget, keeping its shape. 0.5 MP is about twice as fast.",
    group: "Quality",
    targets: [
      { node: "prepare", input: "resolution" },
      { node: "sampling_memory", input: "activation_memory_gib", transform: (_v, values) => activationGib(values) },
    ],
  },
  {
    id: KEEP_SOUND_PARAM,
    label: "Keep the clip's sound",
    type: "toggle",
    default: true,
    help: "On, the result carries the clip's own soundtrack. Off, it gets the audio H3 makes alongside the picture.",
    group: "Source",
    targets: [
      { node: "finish", input: "audio_mode", transform: (value) => (value === false ? "generated" : "source") },
    ],
  },
  {
    id: "history_frames",
    label: "Carry-over between windows",
    type: "select",
    default: "18",
    options: [
      { value: "18", label: "18 frames (the author's)" },
      { value: "35", label: "35 frames" },
      { value: "52", label: "52 frames" },
    ],
    help: "How much of the last window each new one starts from. More keeps the joins steadier and costs a little time per window.",
    group: "Quality",
    advanced: true,
    targets: [{ node: "plan", input: "history_frames" }],
  },
  {
    id: "mask_grow",
    label: "Mask margin",
    type: "slider",
    default: 64,
    min: 0,
    max: 256,
    step: 8,
    help: "How far past the tracked person the edit may reach, in pixels. More gives a costume room to be bigger than the original's outline (a hat, a cape); less keeps the background closer to the source.",
    group: "Quality",
    advanced: true,
    targets: [{ node: "expand_mask", input: "expansion_px" }],
  },
  {
    id: "lora_strength",
    label: "Swap strength",
    type: "slider",
    default: 1,
    min: 0,
    max: 1.5,
    step: 0.05,
    help: "1 is what the LoRA was trained at.",
    group: "Sampling",
    advanced: true,
    targets: [{ node: "adapter", input: "strength_model" }],
  },
  {
    id: "seed",
    label: "Seed",
    type: "seed",
    default: -1,
    help: "Reuse one to get the same take again. Every window uses it.",
    group: "Sampling",
    targets: [{ node: "plan", input: "seed" }],
  },
  {
    id: "steps",
    label: "Steps",
    type: "slider",
    default: 8,
    min: 4,
    max: 20,
    step: 1,
    help: "8 is what the Turbo LoRA in this recipe is distilled for.",
    group: "Sampling",
    advanced: true,
    targets: [{ node: "schedule", input: "steps" }],
  },
];

export const minimaxH3Swap: WorkflowDef = {
  id: "minimax-h3-swap",
  name: "Character swap",
  description: "Puts the character from a picture in place of one person in a clip.",
  /**
   * One five-second window at 1 MP on a 3090, with SAM and the model loads.
   * A longer clip is scaled by its windows (`slicedBy`). The first finished
   * runs replace this with the machine's own median.
   */
  estimatedSeconds: 600,
  hasAudio: true,
  graph,
  params,
  /**
   * Swap on a finished video loads it as the clip. Nothing is carried: the
   * prompt that made the source describes a scene, and this one's prompt names
   * a person in it.
   */
  clipTarget: {
    action: "swap",
    accepts: "video",
    sourceParam: VIDEO_PARAM,
  },
  /** The estimate is one window's, times the windows. */
  slicedBy: CLIP_SECONDS_PARAM,
  finalize(graph, values) {
    // H3's sound is only decoded when it is the one kept.
    if (values[KEEP_SOUND_PARAM] !== false) {
      delete graph.decode_audio;
      delete graph.append.inputs.audio;
    }
  },
  finalizeCases: [
    {
      name: "the clip's own sound",
      values: { [VIDEO_PARAM]: "clip.mp4", [IMAGE_PARAM]: "c.png", character: "a knight" },
    },
    {
      name: "H3's own sound",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [KEEP_SOUND_PARAM]: false,
      },
    },
  ],
};
