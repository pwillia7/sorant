import { isSilentClip } from "@/lib/audio-track";
import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import {
  latentTailNodes,
  TAIL_FRAMES,
  TAIL_TOKENS,
  tailFileFor,
} from "./latent-tail";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import type { ParamDef, ParamValue, WorkflowDef, TextParam } from "./types";
import {
  directorBypassFor,
  directorTarget,
  FRAME_EXPRESSION,
  durationParam,
  EXTEND_DIRECTOR,
  h3Patches,
  h3ContentLora,
  h3StepSampler,
  h3Turbo,
  literalPromptParam,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 extend: keep a clip running past where it stopped.
 *
 * Structurally this is the image-to-video graph with the end of the clip
 * standing in for an upload, plus a join on the way out. Three parts:
 *
 * 1. **The seam.** It is built one of two ways, and `finalize` picks per run.
 *
 *    - **From the latents**, when the clip is a generation from this app and
 *      the hand-off brought its latent tail along (latent-tail.ts). 141 and 142
 *      load the last 22 frames' worth of video and audio latents exactly as
 *      the previous run's sampler left them; 145 pads the video to the new
 *      segment's length with a denoise mask that keeps those 7 tokens fixed,
 *      and 148 freezes the audio the same way. So the new segment *starts
 *      with* the end of the old one, sound included, and is sampled onward from
 *      it — nothing decoded and re-encoded in between. That is what keeps the
 *      colour from drifting pass after pass and the voice from resetting at
 *      the join.
 *    - **From the last frame**, for anything else — an upload has pixels
 *      only. 128 takes the last frame of the clip (`start_index: -1`) and
 *      105:104 receives it as `first_frame`. This is how every extension
 *      worked before the tails existed.
 *
 *    Either way 126 loads the clip at 24 fps — frames on output 0, sound on
 *    output 2 — 120 measures the last frame for the output size, and 123 shows
 *    it to the prompt director.
 * 2. **The generation.** The 105:* nodes are the same sampler stack as the
 *    other generating graphs, and the same duration → frame-count expression.
 *    That duration times the *new segment only*, which is the one thing about
 *    this workflow that reliably surprises people: ask for 10 seconds on a
 *    12-second clip and 22 seconds come back.
 * 3. **The join.** 131 concatenates the source frames with the generated ones
 *    and 135 does the same to the two audio tracks, so 137/138 save the whole
 *    video rather than the addition on its own. That is what makes extending
 *    an extension work: the output is always a complete clip, so it can go
 *    straight back in through the Extend button. From the latents, the new
 *    segment's first 22 frames are the source's last 22 again, so 151 and 152
 *    drop them before the join.
 *
 * Which also means the file grows with each pass, and so does the time spent
 * decoding and re-encoding it — the sampling cost stays flat, since only the
 * new segment is ever generated.
 */
const ids: MinimaxNodeIds = {
  // Node 125, not the video node: what the user types is the *input* to the
  // rewrite stage, and 105:104.prompt is a link now, not a value.
  prompt: { node: "125", input: "value" },
  director: "123",
  duration: "105:111",
  noise: "105:15",
  scheduler: "105:9",
};

const VIDEO_NODE = "126";

/**
 * The rate the source is read at, and the rate the join is written at.
 *
 * One constant because the two must agree: this graph concatenates the source's
 * own frames with the generated ones and writes the result as a single video,
 * so a source read at another rate plays its half at the wrong speed inside the
 * finished file.
 */
const SOURCE_FPS = 24;

const graph: ComfyGraph = {
  // The clip, read at 24 fps.
  //
  // VHS's loader, forcing the rate, because this graph *joins* the source to
  // what it generates: 131 batches the source's frames ahead of the new ones
  // and 137 writes the pair out at 24 fps. A source at any other rate has its
  // own half of the finished video replayed at the wrong speed — a 30 fps clip
  // plays a quarter slow before the extension starts, inside one file, which
  // is worse than being uniformly wrong. Nothing noticed because the usual
  // source is a generation from this app, already at 24.
  //
  // It also reads the fragmented MP4 a browser's MediaRecorder writes, which
  // ComfyUI's own loader measures as a single frame. See minimax-h3-ref.ts.
  //
  // No `frame_load_cap`: an extension carries the whole source through to the
  // output. Outputs are 0 frames, 1 frame count, 2 audio.
  "126": {
    class_type: "VHS_LoadVideo",
    inputs: {
      video: "",
      force_rate: SOURCE_FPS,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    _meta: { title: "Load Video" },
  },

  // The last frame of the clip, and the only frame anything downstream sees.
  //
  // `start_index: -1` with `num_frames: 1` is what picks it; the randomness and
  // distance widgets are carried from the export and do nothing at that index.
  "128": {
    class_type: "RandomImageFromBatch",
    inputs: {
      start_index: -1,
      end_index: -1,
      num_frames: 1,
      randomness: 0,
      min_distance: 0,
      max_distance: 0,
      seed: 0,
      input: ["126", 0],
    },
    _meta: { title: "Random Image From Batch" },
  },
  // Reading the frame rather than the clip: same numbers either way, and this
  // is the image the continuation is actually generated against.
  "120": {
    class_type: "GetImageSize",
    inputs: { image: ["128", 0] },
    _meta: { title: "Get Image Size" },
  },

  // The prompt-rewrite stage: 125 holds what the user typed and 123 turns it
  // into what node 105:104 reads, with the last frame in view.
  //
  // EXTEND_DIRECTOR is what makes this a continuation rather than a new scene
  // sharing an opening image — it reads the input as what happens next and
  // spends most of its instructions on not resetting at the seam. Which model
  // it runs on is the `rewrite_model` param below; the key lives on the
  // ComfyUI host.
  //
  // The `system_prompt` is overwritten per run by the duration param, which
  // appends the length of the segment being generated — not of the video that
  // comes out, since the source is concatenated on afterwards and never
  // reaches the model.
  "123": rewriteNode({
    prompt: ["125", 0],
    system: EXTEND_DIRECTOR,
    images: ["128", 0],
    title: "AI Gateway - Rewrite Prompt",
  }),
  "125": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },

  "105:11": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "105:24": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "105:23": {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["105:14", 0], vae: ["105:24", 0] },
    _meta: { title: "VAE Decode Audio" },
  },
  "105:10": {
    class_type: "VAEDecode",
    inputs: { samples: ["105:14", 0], vae: ["105:11", 0] },
    _meta: { title: "VAE Decode" },
  },
  "105:17": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "res_multistep" },
    _meta: { title: "KSamplerSelect" },
  },
  "105:9": {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "simple",
      steps: 20,
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
    inputs: { noise_seed: 689734481905865 },
    _meta: { title: "RandomNoise" },
  },
  "105:91": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["105:10", 0],
      audio: ["105:23", 0],
    },
    _meta: { title: "Create Video" },
  },
  "105:104": {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: {
      prompt: ["123", 0],
      width: ["120", 0],
      height: ["120", 1],
      length: ["105:107", 1],
      clip: ["105:13", 0],
      vae: ["105:11", 0],
      first_frame: ["128", 0],
    },
    _meta: { title: "MiniMax H3 Image to Video" },
  },
  "105:107": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: FRAME_EXPRESSION(24),
      "values.a": ["105:111", 0],
    },
    _meta: { title: "Math Expression" },
  },
  "105:111": {
    class_type: "PrimitiveFloat",
    inputs: { value: 5 },
    _meta: { title: "Float (duration)" },
  },

  // The latent seam — see the top of the file. Present in every stored graph,
  // and either wired in or deleted by `finalize`, so check:nodes and the
  // requirements see the classes it needs.
  //
  // The two tail files, by name. The `source_tail` param writes both.
  "141": {
    class_type: "LoadLatent",
    inputs: { latent: "" },
    _meta: { title: "Load Latent (video tail)" },
  },
  "142": {
    class_type: "LoadLatent",
    inputs: { latent: "" },
    _meta: { title: "Load Latent (audio tail)" },
  },
  // The segment is one 17-frame group longer than from a frame, because its
  // first 22 frames are the carried ones and get dropped at the join: 5 s of
  // added time is 124 + 17 = 141 frames generated, 119 of them new.
  "143": {
    class_type: "ComfyMathExpression",
    inputs: { expression: "a + 17", "values.a": ["105:107", 1] },
    _meta: { title: "Math Expression (frames with tail)" },
  },
  // KJ's mask node works in LTX's time units: at a nominal 8 fps it addresses
  // H3's tokens one to one, and an end time of T - 7/8 pads the 7 carried
  // tokens out to the T this frame count has. Tokens are 5 per 17 frames, plus
  // 2.
  "144": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: "((a - 5) // 17) * 5 + 2 - 0.875",
      "values.a": ["143", 1],
    },
    _meta: { title: "Math Expression (mask end)" },
  },
  // Generate from the token after the tail onward; the tail itself and nothing
  // else is held. The padding is all masked in.
  "145": {
    class_type: "LTXVAudioVideoMask",
    inputs: {
      video_latent: ["141", 0],
      video_fps: 8,
      video_start_time: (8 * (TAIL_TOKENS - 1) + 1) / 8,
      video_end_time: ["144", 0],
      audio_start_time: 0,
      audio_end_time: 0,
      max_length: "pad",
      existing_mask_mode: "add",
    },
    _meta: { title: "LTXV Audio Video Mask" },
  },
  // An empty AV latent of the new length, only for its audio stream's shape:
  // 150 lays the frozen audio tail over the start of it.
  "146": {
    class_type: "EmptyMiniMaxH3LatentAV",
    inputs: { width: ["120", 0], height: ["120", 1], length: ["143", 1] },
    _meta: { title: "Empty MiniMax H3 Latent AV" },
  },
  "147": {
    class_type: "LTXVSeparateAVLatent",
    inputs: { av_latent: ["146", 0] },
    _meta: { title: "Separate AV Latent" },
  },
  "148": {
    class_type: "LTXVFreezeLatent",
    inputs: { latent: ["142", 0] },
    _meta: { title: "LTXV Freeze Latent (audio tail)" },
  },
  "149": {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: ["145", 0], audio_latent: ["147", 1] },
    _meta: { title: "Concat AV Latent" },
  },
  // Concat onto an AV latent swaps its audio stream for this one and pads it
  // to length, the padding left to be generated.
  "150": {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: ["149", 0], audio_latent: ["148", 0] },
    _meta: { title: "Concat AV Latent (audio tail)" },
  },
  // The carried 22 frames and their sound, off the front of the new segment.
  // Both lengths run past the end on purpose and are clamped to it.
  "151": {
    class_type: "ImageFromBatch",
    inputs: { image: ["132", 0], batch_index: TAIL_FRAMES, length: 4096 },
    _meta: { title: "Image From Batch (after the tail)" },
  },
  "152": {
    class_type: "TrimAudioDuration",
    inputs: {
      audio: ["132", 1],
      start_index: TAIL_FRAMES / SOURCE_FPS,
      duration: 3600,
    },
    _meta: { title: "Trim Audio Duration (after the tail)" },
  },

  // The join. 132 splits the generated segment back into frames and audio so
  // both can be appended to the source's own — pictures in 131, sound in 135 —
  // and 137 re-encodes the pair as one video at the same 24fps.
  "132": {
    class_type: "GetVideoComponents",
    inputs: { video: ["105:91", 0] },
    _meta: { title: "Get Video Components" },
  },
  "131": {
    class_type: "BatchImagesNode",
    inputs: {
      "images.image0": ["126", 0],
      "images.image1": ["132", 0],
    },
    _meta: { title: "Batch Images" },
  },
  "135": {
    class_type: "AudioConcatenate",
    inputs: {
      direction: "right",
      audio1: ["126", 2],
      audio2: ["132", 1],
    },
    _meta: { title: "AudioConcatenate" },
  },
  "137": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["131", 0],
      audio: ["135", 0],
    },
    _meta: { title: "Create Video" },
  },
  "138": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/minimax_extend",
      format: "auto",
      codec: "auto",
      "video-preview": "",
      video: ["137", 0],
    },
    _meta: { title: "Save Video" },
  },

  // Silence the length of the source, standing in for its soundtrack when it
  // has none. Present in every stored graph and wired in or deleted by
  // `finalize`, like the seam above.
  //
  // Needed because 135 joins the source's audio to the new audio, and VHS
  // decodes a clip's soundtrack the first time something reads it — which on
  // a file with no audio stream raises and ends the run. Leaving the input out
  // is not an option the way it is on Remix: the join would then have nothing
  // to put ahead of the new sound, which would start at the first frame of the
  // source rather than the first frame of the extension.
  //
  // 32 kHz stereo because that is what H3's audio VAE writes, and 135 refuses
  // two audios at different rates.
  "153": {
    class_type: "ComfyMathExpression",
    // Output 0 is the FLOAT.
    inputs: { expression: `a / ${SOURCE_FPS}`, "values.a": ["126", 1] },
    _meta: { title: "Source seconds" },
  },
  "154": {
    class_type: "EmptyAudio",
    inputs: { duration: ["153", 0], sample_rate: 32000, channels: 2 },
    _meta: { title: "Empty Audio (silent source)" },
  },

  // This run's own tail, so the extension can itself be extended the same way.
  ...latentTailNodes("105:14"),
};

/** The nodes only a silent source uses, deleted when the source has sound. */
const SILENT_SOURCE = ["153", "154"];

/** The nodes only the latent seam uses, deleted when it is not taken. */
const LATENT_SEAM = [
  "141",
  "142",
  "143",
  "144",
  "145",
  "146",
  "147",
  "148",
  "149",
  "150",
  "151",
  "152",
];

const TAIL_PARAM = "source_tail";

/**
 * What the clip already showed: the prompt that made it and every Extend line
 * since, oldest first, filled in by the hand-off. See `storyBlock`.
 */
const STORY_PARAM = "source_story";

/**
 * The story so far, for the director to read as background.
 *
 * Told as history it must not replay, never as the instruction: a segment given
 * the whole prompt again restarts it. Without it the director knows the clip
 * only from its last frame and re-describes the people in it from that alone,
 * and the description, the grade and the camera drift a little further with
 * each pass. With it they hold.
 *
 * Only for the clip it was written about — the one the tail names, which an
 * upload over the source slot no longer is.
 */
function storyBlock(values: Record<string, ParamValue>): string {
  const story = String(values[STORY_PARAM] ?? "").trim();
  const source = String(values.source_video ?? "");
  if (!story || !source || values[TAIL_PARAM] !== source) return "";
  return `WHAT THE CLIP ALREADY SHOWED

The source video was made from these instructions, oldest first. They are background only: use them for who these people are, what they wear, where this is, and how the clip looks and is shot. Do not repeat, replay or summarise any of it — the continuation describes only what happens next.

${story}`;
}

/**
 * Takes the latent seam when the loaded clip has a tail, and the last-frame one
 * otherwise. See the top of the file.
 *
 * A tail counts only when it is named after the clip in the source slot: the
 * hand-off writes the clip's reference into both, and an upload over it
 * afterwards changes only the one. Gluing another clip's ending onto this one
 * would start the extension on frames that are not there.
 */
function finalize(graph: ComfyGraph, values: Record<string, ParamValue>) {
  const source = String(values.source_video ?? "");
  const tail = String(values[TAIL_PARAM] ?? "");

  // A source stored as having no soundtrack. See storedClipName.
  if (isSilentClip(source)) graph["135"].inputs.audio1 = ["154", 0];
  else for (const id of SILENT_SOURCE) delete graph[id];

  if (!source || tail !== source) {
    for (const id of LATENT_SEAM) delete graph[id];
    return;
  }

  const i2v = graph["105:104"].inputs;
  delete i2v.first_frame;
  i2v.length = ["143", 1];
  graph["105:14"].inputs.latent_image = ["150", 0];
  graph["131"].inputs["images.image1"] = ["151", 0];
  graph["135"].inputs.audio2 = ["152", 0];
}

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
const director = directorTarget(ids, EXTEND_DIRECTOR, [storyBlock]);

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  {
    id: "source_video",
    label: "Clip to continue",
    type: "video",
    default: "",
    required: true,
    help: "A clip made here carries on from its own latents; an upload, from its last frame. Up to 768×1344, 20s, 100 MB.",
    group: "Source",
    targets: [{ node: VIDEO_NODE, input: "video" }],
  },
  {
    id: TAIL_PARAM,
    label: "Latent tail",
    type: "carried",
    default: "",
    group: "Source",
    targets: [
      { node: "141", input: "latent", transform: (v) => tailFileFor(String(v), "video") },
      { node: "142", input: "latent", transform: (v) => tailFileFor(String(v), "audio") },
    ],
  },

  {
    ...(promptParam(
      ids,
      "He turns to her and says we need to leave.",
      "Say what happens next, not what the clip already showed. It can see the last frame and the story so far.",
      6,
    ) as TextParam),
    label: "What happens next",
    hint: "The next beat. The clip's people, place and camera carry over.",
    placeholder: "Then she opens the door and steps out into the rain.",
  },
  {
    id: STORY_PARAM,
    label: "Story so far",
    type: "textarea",
    default: "",
    maxLength: 4000,
    rows: 4,
    help: "What the clip already showed, filled in by Extend. The rewrite reads it as background and won't replay it.",
    group: "Source",
    revealedBy: TAIL_PARAM,
    targets: [director],
  },
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  // Times the addition, not the result — the source's own length is whatever it
  // already was, and the two are concatenated afterwards. Worth saying on the
  // control itself, because every other workflow's duration is the duration of
  // the file that comes back.
  durationParam(ids, director, {
    label: "Added time",
    help: "How much new footage to generate. The result is the source clip plus this.",
    default: 5,
  }),

  ...samplingParams(ids),
];

export const minimaxH3Extend: WorkflowDef = {
  id: "minimax-h3-extend",
  name: "Extend",
  description: "Carries on from where a clip you already have left off.",
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  turbo: h3Turbo(220),
  // The content LoRA first, matching the order they stack in: it is a LoRA on
  // the model, and the other two wrap whatever weights are in play by then.
  // Only the fl2va graphs offer it — see h3ContentLora, and the ref2va bases
  // its LoRAs are not made for.
  patches: [h3ContentLora(), ...h3Patches()],
  stepSampler: h3StepSampler(),
  /**
   * No `carry`, unlike Remix. The prompt that made the source describes the
   * source, and this graph reads what you type as what happens *next* — so
   * carrying it into the prompt box would ask the director to continue the clip
   * by doing again what it just did. It travels as the story instead, which
   * the director is told is history.
   */
  clipTarget: {
    action: "extend",
    accepts: "video",
    sourceParam: "source_video",
    carriedParam: TAIL_PARAM,
    storyParam: STORY_PARAM,
  },
  finalize,
  finalizeCases: [
    {
      name: "a generation with its latent tail",
      values: {
        source_video: "clip.mp4",
        [TAIL_PARAM]: "clip.mp4",
        [STORY_PARAM]: "She walks along the pier.",
      },
    },
    { name: "an upload, no tail", values: { source_video: "clip.mp4" } },
    {
      name: "a silent upload",
      values: { source_video: "noaudio--clip.mp4" },
    },
    {
      name: "a tail left over from another clip",
      values: { source_video: "upload.mp4", [TAIL_PARAM]: "clip.mp4" },
    },
    {
      name: "a generation with its latent tail, turbo",
      values: { source_video: "clip.mp4", [TAIL_PARAM]: "clip.mp4" },
      mode: { turbo: true },
    },
  ],
};
