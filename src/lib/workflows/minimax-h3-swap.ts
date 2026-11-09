import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import {
  CHAIN_HISTORY,
  CHAIN_OVER_SECONDS,
  FRESH_EVERY_PARAM,
  SPLIT_SHOTS_PARAM,
  MAX_SWAP_SECONDS,
  PASS_THROUGH_PARAM,
  SLICE_FPS,
} from "./slices";
import {
  boxInPixels,
  CARRY_MASK_PREFIX,
  END_MASK_PREFIX,
  parsePick,
  pointsInPixels,
  PICK_PARAM,
  SUBJECT_BOX_PARAM,
  SUBJECT_MASK_PARAM,
} from "./subject-box";
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
const MEGAPIXELS_PARAM = "megapixels";
/**
 * One run of a chained swap: "start:frames:history", written by the page
 * (use-long-swap.ts), empty for an ordinary run. See `segmentOf`.
 */
export const SEGMENT_PARAM = "segment";
/** The previous segment's saved video, "video/name.mp4 [output]", for its history. */
export const HISTORY_CLIP_PARAM = "history_clip";
export { CARRY_MASK_PREFIX, END_MASK_PREFIX, PICK_PARAM, SUBJECT_BOX_PARAM, SUBJECT_MASK_PARAM };

/** The author's: no trigger word, and 1.0 is what it was trained at. */
const SWAP_LORA = "h3_character_swap_v1.5.safetensors";
/** The distilled LoRA the author's recipe pairs with it, also at 1.0. */
const TURBO_LORA = "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors";
const SAM_MODEL = "sam3.1_multiplex_fp16.safetensors";

/**
 * Past this, the clip control warns about the wait rather than refusing.
 * A clip over CHAIN_OVER_SECONDS is swapped as a chain of runs (see
 * slices.ts), so length costs time, not the box's memory: about 13 minutes per
 * 5 s at 1 MP on a 3090. The hard limit is MAX_SWAP_SECONDS, the join's 100
 * clips; the 100 MB upload limit still applies.
 */
const LONG_CLIP_SECONDS = 60;

/**
 * The run a chained swap's segment is, or null for an ordinary run.
 *
 * A segment is one Relay window on Relay's "segment" schedule: its source is
 * the clip from `start - history` for `history + frames` frames (`frames` 0:
 * to the end), and its history is the last `history` frames of the segment
 * before's output, so it carries on from them. Relay drops the history again
 * when it finishes, so the segment delivers exactly its own frames.
 */
export function segmentOf(
  values: Record<string, ParamValue>,
): { start: number; frames: number; history: number } | null {
  const match = /^(\d+):(\d+):(\d+)$/.exec(String(values[SEGMENT_PARAM] ?? ""));
  if (!match) return null;
  const [start, frames, history] = match.slice(1).map(Number);
  return history <= start ? { start, frames, history } : null;
}

/** Seconds of source a segment run loads, history included; 0 for "to the end". */
const segmentSeconds = (segment: { frames: number; history: number }) =>
  // Half a frame over, so Prepare Source's floor(seconds × 24) lands on the
  // count rather than one under it.
  segment.frames ? (segment.history + segment.frames + 0.5) / SLICE_FPS : 0;

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
  const pixels = frameMegapixels(values);
  const gib = 17 * (WINDOW_FRAMES / 124) * pixels;
  return Math.min(22, Math.round(gib * 2) / 2);
}

/** The frame size asked for, in MP, held to what H3 makes (0.1–1). */
export function frameMegapixels(values: Record<string, ParamValue>): number {
  const mp = Number(values[MEGAPIXELS_PARAM] ?? 1);
  return Number.isFinite(mp) ? Math.min(1, Math.max(0.1, mp)) : 1;
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
  // A chained segment's stretch of the clip, history included. Taken out of
  // an ordinary run by finalize. See `segmentOf`.
  segment_slice: {
    class_type: "Video Slice",
    inputs: { video: ["source", 0], start_time: 0, duration: 0, strict_duration: false },
    _meta: { title: "Segment of the clip" },
  },
  // The segment before's output, and its last frames as this one's history.
  // Chained segments after the first only.
  history_clip: {
    class_type: "LoadVideo",
    inputs: { file: "" },
    _meta: { title: "Load Video (the segment before)" },
  },
  history_parts: {
    class_type: "GetVideoComponents",
    inputs: { video: ["history_clip", 0] },
    _meta: { title: "Get Video Components" },
  },
  history_frames: {
    class_type: "ImageFromBatch",
    inputs: { image: ["history_parts", 0], batch_index: -18, length: 18 },
    _meta: { title: "History (its last frames)" },
  },
  // 24 fps, a 32-pixel canvas within the pixel budget, and silence for a clip
  // with no sound. Outputs: 0 frames, 1 audio, 5 the source frame count.
  prepare: {
    class_type: "H3RelayPrepareSource",
    inputs: {
      video: ["segment_slice", 0],
      resolution: "768",
      duration_seconds: 0,
      missing_audio: "silence",
    },
    _meta: { title: "Prepare Source" },
  },
  // Prepare Source has two pixel budgets, 0.5 and 1 MP. Its frames are
  // scaled from there to the Frame size asked for, on the 32-pixel grid Relay's
  // masks need, and everything after reads these. Taken out by finalize at
  // either budget exactly, where there is nothing to scale.
  scale: {
    class_type: "ImageScaleToTotalPixels",
    inputs: { image: ["prepare", 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 32 },
    _meta: { title: "Scale to Frame size" },
  },
  dimensions: {
    class_type: "GetImageSize",
    inputs: { image: ["scale", 0] },
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
    inputs: { image: ["scale", 0], batch_index: 0, length: 1 },
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
  // The rule Recover Masks re-picks by on a frame where the track drops. Its
  // own node, because with a box the person is picked by index — the box's
  // mask comes first — and an index means nothing on a frame detected afresh.
  recover_select: {
    class_type: "H3RelaySelectMask",
    inputs: { masks: ["detect", 0], selection: "largest", index: 0 },
    _meta: { title: "Recovery rule" },
  },
  track: {
    class_type: "SAM3_VideoTrack",
    inputs: {
      model: ["sam", 0],
      images: ["scale", 0],
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
      images: ["scale", 0],
      source_frames: ["prepare", 5],
      model: ["sam", 0],
      conditioning: ["subject", 0],
      selection: ["recover_select", 1],
      recover_empty_frames: true,
    },
    _meta: { title: "Recover Masks" },
  },
  expand_mask: {
    class_type: "H3RelayExpandMask",
    inputs: {
      masks: ["recover", 0],
      images: ["scale", 0],
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
      source: ["scale", 0],
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

/**
 * The nodes that find and track who to replace, copied fresh: the mask check
 * (swap-mask-check.ts) runs them alone, under the same names, so what it shows
 * is what a swap would edit.
 */
export const SAM_STAGE = [
  "source",
  "segment_slice",
  "prepare",
  "sam",
  "subject",
  "first_frame",
  "detect",
  "select",
  "recover_select",
  "track",
  "mask",
  "recover",
] as const;

export function samStage(): ComfyGraph {
  const stage: ComfyGraph = {};
  for (const id of SAM_STAGE) stage[id] = structuredClone(graph[id]);
  return stage;
}

/** A carried mask's file, as LoadImage names one in ComfyUI's output folder. */
const CARRIED_MASK = /^swap_mask\/(carry|end)_\d{5,}_\.png \[output\]$/;

/**
 * Who the run follows, by what it was given. A carried mask is the person
 * exactly as the segment before tracked them on this very frame, so tracking
 * starts from it and nothing is picked. Points clicked on them are segmented by
 * H3 Relay's Refine Mask, which keeps the clicks — on them and on anyone to
 * leave out — through both of its passes. A box is drawn around them: SAM
 * segments whatever is in it, with no text, and that mask comes first. With
 * none of these, the description and the rule pick, as before. The rule still
 * picks on a frame where the track drops (`recover_select`), whichever
 * started it.
 *
 * A box gets one SAM pass, not the two a description gets: core SAM3 Detect's
 * second pass re-prompts with the mask alone and drops the box, which lets the
 * mask wander onto whoever stands beside them.
 *
 * Shared with the mask check (swap-mask-check.ts), whose graph has the same
 * SAM nodes under the same names.
 */
export function pickSubject(graph: ComfyGraph, values: Record<string, ParamValue>, megapixels: number) {
  const carried = String(values[SUBJECT_MASK_PARAM] ?? "");
  if (carried) {
    if (!CARRIED_MASK.test(carried)) {
      throw new ParamError("The person's mask from the segment before is not one this can load.", SUBJECT_MASK_PARAM);
    }
    graph.carried_mask_image = {
      class_type: "LoadImage",
      inputs: { image: carried },
      _meta: { title: "Load Image (the person, from the segment before)" },
    };
    graph.carried_mask = {
      class_type: "ImageToMask",
      inputs: { image: ["carried_mask_image", 0], channel: "red" },
      _meta: { title: "Image To Mask" },
    };
    graph.track.inputs.initial_mask = ["carried_mask", 0];
    return;
  }
  const pick = parsePick(values[SUBJECT_BOX_PARAM]);
  if (pick?.include.length) {
    graph.pick_points = {
      class_type: "H3RelayRefineMask",
      inputs: {
        model: ["sam", 0],
        image: ["first_frame", 0],
        positive_coords: JSON.stringify(pointsInPixels(pick.include, pick, megapixels)),
        negative_coords: JSON.stringify(pointsInPixels(pick.exclude, pick, megapixels)),
        prior_file: "",
        frame: 0,
      },
      _meta: { title: "The person, from the points clicked on them" },
    };
    graph.track.inputs.initial_mask = ["pick_points", 0];
    return;
  }
  if (pick?.box) {
    graph.detect.inputs.bboxes = boxInPixels({ ...pick.box, sw: pick.sw, sh: pick.sh }, megapixels);
    // Text and a box together make the box a hint to the text detector; alone,
    // it is segmented as it is.
    delete graph.detect.inputs.conditioning;
    graph.detect.inputs.refine_iterations = 1;
    graph.select.inputs.selection = "index";
    graph.select.inputs.index = 0;
  }
}

/**
 * Keep the clip's own footage wherever the track is lost. Relay's Expand Mask
 * refuses a timeline with an empty frame, by design; downstream an empty frame
 * is only an edit mask of zeros, which keeps the source latent there
 * (`pool_edit_mask`, `H3RelayApplyEditMask`). So the mask is grown by core
 * Grow Mask instead, which leaves an empty frame empty. Its growth is a 3×3
 * step repeated, an octagon rather than Relay's circle, and about half a
 * minute a segment on the CPU. The track's masks already cover every prepared
 * frame, so nothing needs padding.
 */
function leaveLostFrames(graph: ComfyGraph, values: Record<string, ParamValue>) {
  const grow = Number(values.mask_grow ?? 64);
  graph.grow_mask = {
    class_type: "GrowMask",
    inputs: { mask: ["recover", 0], expand: Number.isFinite(grow) ? Math.round(grow) : 64, tapered_corners: true },
    _meta: { title: "Grow Mask (lost frames left empty)" },
  };
  graph.window.inputs.mask = ["grow_mask", 0];
  delete graph.expand_mask;
}

/**
 * Save the person's mask where the next segment will need it: on the frame its
 * source starts when it carries on (CHAIN_HISTORY before this segment's end),
 * and on this segment's last frame, one before where a fresh start begins.
 * Indices are into this run's source, which starts `history` frames early.
 */
function saveMaskForNext(graph: ComfyGraph, segment: { frames: number; history: number }) {
  graph.mask_frames = {
    class_type: "MaskToImage",
    inputs: { mask: ["recover", 0] },
    _meta: { title: "Mask To Image" },
  };
  const frames: Array<[string, number, string]> = [
    ["carry", segment.history + segment.frames - CHAIN_HISTORY, CARRY_MASK_PREFIX],
    ["end", segment.history + segment.frames - 1, END_MASK_PREFIX],
  ];
  for (const [name, index, prefix] of frames) {
    graph[`${name}_mask_frame`] = {
      class_type: "ImageFromBatch",
      inputs: { image: ["mask_frames", 0], batch_index: index, length: 1 },
      _meta: { title: `The person, for the next segment (${name})` },
    };
    graph[`${name}_mask_save`] = {
      class_type: "SaveImage",
      inputs: { images: [`${name}_mask_frame`, 0], filename_prefix: prefix },
      _meta: { title: "Save Image" },
    };
  }
}

/**
 * A chained segment as the clip's own footage: its stretch of the source,
 * fitted to the same canvas as the swapped segments and with its own sound, so
 * the join takes it like any other. Used where SAM finds no one to replace —
 * the shot has moved off them — so the chain carries on rather than stopping
 * at a segment that cannot be swapped.
 *
 * Prepare Source's `prepared_video` is the source at the canvas, trimmed to
 * the frames it was given (its IMAGE output is padded to H3's grid). At a
 * frame size between its two budgets it is scaled the way the swap's frames
 * are, so the sizes match at the join.
 */
function passThrough(graph: ComfyGraph, values: Record<string, ParamValue>) {
  const keep = new Set(["source", "segment_slice", "prepare", "scale", "save"]);
  for (const node of Object.keys(graph)) if (!keep.has(node)) delete graph[node];
  graph.original_parts = {
    class_type: "GetVideoComponents",
    inputs: { video: ["prepare", 8] },
    _meta: { title: "Get Video Components (the clip's own footage)" },
  };
  const mp = frameMegapixels(values);
  if (mp === 1 || mp === 0.5) delete graph.scale;
  else graph.scale.inputs.image = ["original_parts", 0];
  graph.original_video = {
    class_type: "CreateVideo",
    inputs: {
      images: graph.scale ? ["scale", 0] : ["original_parts", 0],
      fps: ["original_parts", 2],
      audio: ["original_parts", 1],
    },
    _meta: { title: "Create Video (the clip's own footage)" },
  };
  graph.save.inputs.video = ["original_video", 0];
}

export const swapParams: ParamDef[] = [
  {
    id: VIDEO_PARAM,
    label: "Clip",
    type: "video",
    default: "",
    required: true,
    help: `Up to ${MAX_SWAP_SECONDS / 60} minutes. Over ${CHAIN_OVER_SECONDS} seconds, or with camera cuts in it, it is swapped as a chain of runs, about 5 seconds each, and joined at the end — keep this tab open while they run. With “Split at camera cuts” on, each shot starts fresh and you choose who to replace in each.`,
    group: "Source",
    // Not H3's 768×1344: Prepare Source fits the clip to the pixel budget
    // itself, so a phone's 1080p clip is fine.
    maxShortEdge: 1080,
    maxLongEdge: 1920,
    maxSeconds: MAX_SWAP_SECONDS,
    warnOverSeconds: LONG_CLIP_SECONDS,
    longClipWarning:
      "That works, but it is a long run: about 13 minutes per 5 seconds of clip at 1 MP on a 24 GB card (about a third of that at 0.5 MP), so a minute at 1 MP is over 2 hours. Queued runs wait behind it.",
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
    id: SEGMENT_PARAM,
    label: "Segment",
    type: "written",
    default: "",
    maxLength: 32,
    group: "Source",
    targets: [
      {
        node: "segment_slice",
        input: "start_time",
        transform: (_v, values) => {
          const segment = segmentOf(values);
          return segment ? (segment.start - segment.history) / SLICE_FPS : 0;
        },
      },
      {
        node: "segment_slice",
        input: "duration",
        transform: (_v, values) => {
          const segment = segmentOf(values);
          return segment ? segmentSeconds(segment) : 0;
        },
      },
    ],
  },
  {
    id: HISTORY_CLIP_PARAM,
    label: "History clip",
    type: "written",
    default: "",
    maxLength: 512,
    group: "Source",
    targets: [{ node: "history_clip", input: "file" }],
  },
  {
    id: PASS_THROUGH_PARAM,
    label: "Pass through",
    type: "written",
    default: "",
    maxLength: 1,
    group: "Source",
    // The rest of what it does is finalize's: see `passThrough`.
    targets: [
      {
        node: "save",
        input: "filename_prefix",
        transform: (value) => (value === "1" ? "video/swap_original" : "video/MiniMax_H3_swap"),
      },
    ],
  },
  {
    id: SPLIT_SHOTS_PARAM,
    label: "Split at camera cuts",
    type: "toggle",
    default: true,
    help: "Finds the cuts in the clip before anything runs, and swaps each shot fresh: tracking and the last frames are not carried across a cut, where they would show another shot. You then choose who to replace in each shot — or no one, for a shot without them.",
    group: "Source",
    scope: "browser",
    targets: [],
  },
  {
    id: FRESH_EVERY_PARAM,
    label: "Fresh start every",
    type: "select",
    // Never by default: tested on a 4-minute chain, a fresh start brought the
    // face back but dropped the costume where the mask did not reach it (the
    // source's own shirt came back), which the carry-on had been holding.
    default: "0",
    options: [
      { value: "0", label: "Never" },
      { value: "30", label: "30 seconds" },
      { value: "60", label: "Minute" },
    ],
    help: `For clips over ${CHAIN_OVER_SECONDS} seconds. Each segment carries on from the last frames of the one before, and over minutes small errors build up: the face darkens, gets grainier, drifts from the picture. A fresh start swaps a segment from the clip and the picture alone, which resets that. The cost is a jump where it happens, and clothing the mask does not cover can go back to the source's.`,
    group: "Quality",
    scope: "browser",
    targets: [],
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
    label: "Who to replace in the clip",
    type: "text",
    default: "",
    placeholder: "man in a red cap",
    hint: "A few words SAM can find them by — or click on them in Settings.",
    help: "A few words SAM can find them by on the first frame — \"man\", \"woman in a red coat\". SAM reads short names of things, not sentences: a longer description finds no one or everyone. With several people in shot, click on them in Settings (Or point them out) instead. Only they are changed; everyone else is kept.",
    group: "Prompt",
    targets: [promptTarget, { node: "subject", input: "text", transform: (_v, values) => samSubject(values) }],
  },
  {
    id: PICK_PARAM,
    label: "If several match",
    type: "select",
    default: "largest",
    options: [
      { value: "largest", label: "The biggest in frame" },
      { value: "leftmost", label: "The one furthest left" },
      { value: "rightmost", label: "The one furthest right" },
    ],
    help: "Which match on the first frame to follow, when the description fits more than one person. Drawing a box around them is surer.",
    group: "Prompt",
    targets: [
      { node: "select", input: "selection" },
      { node: "recover_select", input: "selection" },
    ],
  },
  {
    id: SUBJECT_BOX_PARAM,
    label: "Or point them out",
    type: "box",
    default: "",
    on: VIDEO_PARAM,
    help: "On the clip's first frame: click on the person to replace — face, body, legs — and on anyone else SAM should leave out, or drag a box around all of them. Either beats the description and rule when several people are in shot. Check who SAM picks before you swap: it takes seconds, the swap takes many minutes.",
    group: "Prompt",
    revealedBy: VIDEO_PARAM,
    readBy: "finalize",
    targets: [],
  },
  {
    id: SUBJECT_MASK_PARAM,
    label: "Carried mask",
    type: "written",
    default: "",
    maxLength: 512,
    group: "Prompt",
    readBy: "finalize",
    targets: [],
  },
  {
    // Was "track_drop", defaulting to Find them again. Renamed with the new
    // default (2026-11-09) because stored form values outvote a default, and
    // re-picking by the rule was what swapped strangers in for a few frames.
    id: "lost_frames",
    label: "If SAM loses them",
    type: "select",
    default: "leave",
    options: [
      { value: "leave", label: "Leave those frames as they are" },
      { value: "recover", label: "Find them again" },
      { value: "stop", label: "Stop with an error" },
    ],
    help: "When the track drops — a cut to a shot without them, someone walking in front — Leave those frames as they are keeps the clip's own footage wherever they are lost, and picks them up again when they come back; a brief drop shows the original person for a moment. Find them again looks on each lost frame alone, by the description and rule, with no memory of who you pointed out — in a crowd that swaps someone else for those frames. Stop fails the run, naming the frames.",
    group: "Prompt",
    advanced: true,
    targets: [{ node: "recover", input: "recover_empty_frames", transform: (value) => value === "recover" }],
  },
  {
    id: "sam_threshold",
    label: "Match threshold",
    type: "slider",
    default: 0.35,
    min: 0.1,
    max: 0.9,
    step: 0.05,
    hint: "Lower finds more; higher only sure matches.",
    help: "How sure SAM has to be that someone matches the description on the first frame. Lower finds a small, turned or half-hidden person, and more things that are not them; higher ignores weak matches like someone in the background or on a poster. A drawn box does not use it, and nor does the re-find when the track drops, which stays at 0.35.",
    group: "Prompt",
    advanced: true,
    targets: [{ node: "detect", input: "threshold" }],
  },
  {
    id: "character",
    label: "Describe the person in your picture",
    type: "text",
    default: "",
    required: true,
    placeholder: "a man with a beard in a backwards black cap and a camo shirt",
    hint: "Who they become: face, hair, clothes — as the picture shows them, not the person in the clip.",
    help: "Who they become: face, hair, headwear, clothes and colours, as your picture shows them — not the person in the clip, which tells the model nothing should change. They wear what the picture shows: to change the outfit, use Edit on the picture first. Add the clip's look if it differs (\"in grainy black and white\").",
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
    id: MEGAPIXELS_PARAM,
    label: "Frame size",
    type: "slider",
    // 1, as tested: the 12 s test at 1 MP was clean, and H3 is native at about
    // 1 MP, so there is no more detail past it.
    default: 1,
    min: 0.1,
    max: 1,
    step: 0.05,
    unit: "MP",
    hint: "Higher is sharper and slower. H3 uses about 1 MP at most.",
    help: "The clip is fitted to this many pixels, keeping its shape. 1 MP takes about three times as long as 0.5 MP.",
    group: "Quality",
    targets: [
      // The smaller budget wherever it is enough, so a long clip is not held
      // in memory at 1 MP only to be scaled down.
      { node: "prepare", input: "resolution", transform: (_v, values) => (frameMegapixels(values) <= 0.5 ? "480" : "768") },
      { node: "scale", input: "megapixels", transform: (_v, values) => frameMegapixels(values) },
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
  params: swapParams,
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
    const segment = segmentOf(values);
    if (segment && values[PASS_THROUGH_PARAM] === "1") {
      graph.prepare.inputs.duration_seconds = segmentSeconds(segment);
      passThrough(graph, values);
      return;
    }
    if (!segment) {
      // An ordinary run: the whole clip, no history.
      graph.prepare.inputs.video = ["source", 0];
      for (const node of ["segment_slice", "history_clip", "history_parts", "history_frames"]) delete graph[node];
    } else {
      // One run of a chain. Prepare Source keeps exactly the segment's frames,
      // and the window plan is Relay's one-window "segment" schedule.
      graph.prepare.inputs.duration_seconds = segmentSeconds(segment);
      graph.plan.inputs.schedule = "segment";
      // The joined video carries each segment's own stretch of the clip's
      // sound. H3's would need the history's generated audio too, which a
      // saved segment does not keep.
      delete graph.decode_audio;
      delete graph.append.inputs.audio;
      graph.finish.inputs.audio_mode = "source";
      if (segment.history === 0) {
        for (const node of ["history_clip", "history_parts", "history_frames"]) delete graph[node];
      } else {
        const file = String(values[HISTORY_CLIP_PARAM] ?? "");
        if (!/^[\w\-./ ]+\.(mp4|webm|mov|mkv) \[output\]$/i.test(file) || file.includes("..")) {
          throw new ParamError("The segment before this one is not a clip this can carry on from.", HISTORY_CLIP_PARAM);
        }
        graph.history_frames.inputs.batch_index = -segment.history;
        graph.history_frames.inputs.length = segment.history;
        for (const node of ["plan", "window", "append"]) {
          graph[node].inputs.initial_history = ["history_frames", 0];
        }
      }
    }
    pickSubject(graph, values, frameMegapixels(values));
    if ((values.lost_frames ?? "leave") === "leave") leaveLostFrames(graph, values);
    if (segment && segment.frames > 0) saveMaskForNext(graph, segment);
    // At either of Prepare Source's own budgets the frames are already that
    // size, and scaling them again would only nudge the shape off by a few
    // pixels. The scale node's readers read Prepare Source instead.
    const mp = frameMegapixels(values);
    if (mp === 1 || mp === 0.5) {
      delete graph.scale;
      for (const node of Object.values(graph)) {
        for (const [input, link] of Object.entries(node.inputs)) {
          if (Array.isArray(link) && link[0] === "scale") node.inputs[input] = ["prepare", 0];
        }
      }
    }
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
      name: "0.75 MP, scaled from the 1 MP budget",
      values: { [VIDEO_PARAM]: "clip.mp4", [IMAGE_PARAM]: "c.png", character: "a knight", [MEGAPIXELS_PARAM]: 0.75 },
    },
    {
      name: "the first segment of a chain",
      values: { [VIDEO_PARAM]: "clip.mp4", [IMAGE_PARAM]: "c.png", character: "a knight", [SEGMENT_PARAM]: "0:124:0" },
    },
    {
      name: "a middle segment, carrying on from the one before",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "124:123:18",
        [HISTORY_CLIP_PARAM]: "video/MiniMax_H3_swap_00001_.mp4 [output]",
        [MEGAPIXELS_PARAM]: 0.75,
      },
    },
    {
      name: "the last segment, to the end of the clip",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "1354:0:18",
        [HISTORY_CLIP_PARAM]: "video/MiniMax_H3_swap_00011_.mp4 [output]",
      },
    },
    {
      name: "a box drawn around who to replace",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SUBJECT_BOX_PARAM]: '{"x":0.4,"y":0.1,"w":0.25,"h":0.85,"sw":1280,"sh":720}',
        [MEGAPIXELS_PARAM]: 0.7,
        lost_frames: "stop",
        sam_threshold: 0.5,
      },
    },
    {
      name: "points clicked on who to replace, and on someone to leave out",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SUBJECT_BOX_PARAM]: '{"in":[[0.5,0.3],[0.52,0.62]],"out":[[0.2,0.5]],"sw":1920,"sh":1080}',
      },
    },
    {
      name: "lost frames found again by the rule",
      values: { [VIDEO_PARAM]: "clip.mp4", [IMAGE_PARAM]: "c.png", character: "a knight", lost_frames: "recover" },
    },
    {
      name: "lost frames left as they are, in a carried-on segment",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "247:123:18",
        [HISTORY_CLIP_PARAM]: "video/MiniMax_H3_swap_00002_.mp4 [output]",
        lost_frames: "leave",
        mask_grow: 48,
      },
    },
    {
      name: "a middle segment, tracking from the mask the one before saved",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "247:123:18",
        [HISTORY_CLIP_PARAM]: "video/MiniMax_H3_swap_00002_.mp4 [output]",
        [SUBJECT_MASK_PARAM]: "swap_mask/carry_00001_.png [output]",
      },
    },
    {
      name: "a carried mask from outside the mask folder",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "247:123:18",
        [HISTORY_CLIP_PARAM]: "video/MiniMax_H3_swap_00002_.mp4 [output]",
        [SUBJECT_MASK_PARAM]: "../secrets.png [output]",
      },
      rejects: "not one this can load",
    },
    {
      name: "a segment whose history climbs out of the output folder",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "124:123:18",
        [HISTORY_CLIP_PARAM]: "../secrets.mp4 [output]",
      },
      rejects: "not a clip this can carry on from",
    },
    {
      name: "a segment passed through as the clip's own footage",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "5782:0:0",
        [PASS_THROUGH_PARAM]: "1",
      },
    },
    {
      name: "a segment passed through at 0.75 MP",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [SEGMENT_PARAM]: "247:123:0",
        [PASS_THROUGH_PARAM]: "1",
        [MEGAPIXELS_PARAM]: 0.75,
      },
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
