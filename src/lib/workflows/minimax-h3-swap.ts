import { isSilentClip } from "@/lib/audio-track";
import type { ComfyGraph } from "@/lib/comfy";
import { latentTailNodes } from "./latent-tail";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";
import { h3Patches, h3Turbo, samplingParams } from "./minimax-common";
import { clipSlices, SLICE_FRAMES } from "./slices";

/**
 * MiniMax H3 character swap: one person in a clip you have becomes the
 * character in a picture, and everything else about the clip stays.
 *
 * Built on akatz-ai's Character Swap LoRA,
 * <https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA>, and on the
 * core-nodes-only workflow it ships (`examples/H3 Character Swap v1 Ref2VA.json`)
 * rather than the H3 Relay 2.0 one. Relay adds a SAM mask, windowed sampling
 * for long clips and its own memory nodes; all of that is a custom node pack,
 * and the native reference node takes no mask at all, so the mask only means
 * something inside Relay. What is left is Remix's graph with a picture beside
 * the clip and the LoRA under the model:
 *
 * - 154 reads the clip at 24 fps, and 163 measures it, so the swap comes back
 *   the same size and length as the source — exactly as Remix does, for the
 *   same reasons; see minimax-h3-ref2v.ts.
 * - 137 is the character. It goes in as `ref_images.ref_image_0`, and since
 *   the node numbers each kind of reference separately that is <Picture 1>
 *   while the clip is <Video 1> — the two names the LoRA's prompt uses.
 * - 147 is the LoRA, between the UNET and both the scheduler and the guider.
 *
 * **On the int8 base, on purpose.** Everywhere else a LoRA moves the graph off
 * `_pruned_int8_convrot`, because a LoRA trained on the plain weights lands in
 * the wrong basis on a rotated checkpoint — see H3_FL2VA_LORA_BASES. This one
 * was *trained* on `minimax_h3_ref2va_pruned_int8_convrot` (its
 * `training/base-model-files.json`), so that is the base it is right on, and
 * the bf16 checkpoint would be the mismatch.
 *
 * **No prompt director.** The LoRA was trained on one shape of instruction —
 * replace this person in <Video 1> with the character in <Picture 1>, keep the
 * picture's identity, keep everything else — and the author's note is that
 * more wording does not buy more adherence. So the prompt is that template,
 * filled from two short fields, rather than something a model rewrites into
 * whatever it thinks reads better.
 *
 * **Turbo, at eight steps.** The author's core-nodes recipe runs turbo off at
 * 20 steps of `res_multistep`/`simple`, and their Turbo8 recipe pairs the LoRA
 * with a different distilled LoRA (`minimax_h3_fl2v_turbo_8step`), both at
 * 1.0, on `er_sde`/`normal`. Ours stacked under it works. Tested on a 3090
 * (2026-11-05), one person in shot, 640×1120: `turbo_v4` at 1.0, then Sage,
 * then the swap LoRA at 1.0, 8 steps of `res_multistep`/`simple`. The swap
 * held as well as the 20-step run, in 515 s against 1900. The same graph on
 * `er_sde`/`normal` took 969 s and grew a fourth leg late in the clip, so the
 * graph's own sampler stays. There is no four-step form here (no
 * `stepSampler`): the bf16 pair it loads is the wrong base for this LoRA, and
 * four steps is untested.
 */

const VIDEO_NODE = "154";
const REFERENCE_NODE = "136";
const CLIP_AUDIO_INPUT = "ref_video_audios.ref_video_audio_0";
const VIDEO_PARAM = "source_video";
const IMAGE_PARAM = "character_image";
const KEEP_SOUND_PARAM = "keep_sound";

/** The author's: no trigger word, and 1.0 is what it was trained at. */
const SWAP_LORA = "h3_character_swap_v1.5.safetensors";

/** The rate the clip is read at and the result is written at. See Remix. */
const SOURCE_FPS = 24;

/**
 * Long clips, in slices.
 *
 * The LoRA holds best on about five seconds, and a run's cost grows faster
 * than its length, so a longer clip is swapped a slice at a time by VHS's Meta
 * Batch Manager, the way Upscale works through a clip. Each pass loads the
 * next slice, runs the whole graph on it, and appends its frames to one file
 * that `VHS_VideoCombine` holds open. VHS queues the passes itself, under one
 * run this app follows by the combine's prefix (meta-batch.ts).
 *
 * Every slice is a fresh swap from the same picture, description and seed,
 * not a continuation of the slice before it. The source supplies the motion,
 * so the joins hold up. Small details of the costume can still shift at a
 * join.
 *
 * In batched mode the loader gives every pass the whole clip's soundtrack
 * (VHS's `lazy_get_audio` reads from the start with no cap), which is right
 * for the combine's audio but wrong as a slice's reference. So the slices get
 * no audio reference, and the result always carries the clip's own sound. H3's
 * audio for a slice is never used.
 *
 * H3 makes a run's length on a 17k+5 frame grid, so a slice comes back up to a
 * second longer than it went in. Each pass keeps only as many frames as it
 * loaded (`trim`), so the slices tile the source exactly and the sound lines
 * up.
 */
const BATCH_NODE = "batch";
const TRIM_NODE = "trim";
const COMBINE_NODE = "combine";
const CLIP_SECONDS_PARAM = "clip_seconds";
/** How long a clip may be: at about ten minutes a slice, a minute is two hours. */
const MAX_CLIP_SECONDS = 60;
const COMBINE_PREFIX = "video/MiniMax_H3_swap";

/** How this submission's clip is cut, or null for one pass. See slices.ts. */
const swapSlices = (values: Record<string, ParamValue>) => clipSlices(values[CLIP_SECONDS_PARAM]);

const clipHasAudio = (values: Record<string, ParamValue>): boolean =>
  !isSilentClip(values[VIDEO_PARAM]);

const text = (value: ParamValue | undefined): string =>
  String(value ?? "")
    .trim()
    .replace(/[.\s]+$/, "");

/**
 * The instruction, in the shape the LoRA's own example uses — sentence for
 * sentence, with the person to replace and the character filled in.
 *
 * Every control that shapes it writes the whole of it, because a target write
 * is an assignment and the last one wins. See `ParamTarget.transform`.
 */
export function swapPrompt(values: Record<string, ParamValue>): string {
  const who = text(values.prompt) || "the main person";
  const character = text(values.character);
  const extra = String(values.extra ?? "").trim();
  return [
    `Replace only ${who} in <Video 1> with the character in <Picture 1>${character ? `, ${character}` : ""}.`,
    "Keep the replacement character's identity, outfit, and art style from <Picture 1>.",
    "Preserve the source video's camera, framing, background, lighting, objects, and all other people.",
    `Match ${who}'s position, scale, pose, and movement throughout the clip.`,
    "Do not show the reference sheet or its background.",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

const promptTarget = {
  node: "138",
  input: "value",
  transform: (_value: ParamValue, values: Record<string, ParamValue>) =>
    swapPrompt(values),
};

const graph: ComfyGraph = {
  "92": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      "video-preview": "",
      video: ["130", 0],
    },
    _meta: { title: "Save Video" },
  },
  "119": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "120": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "121": {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["125", 0], vae: ["120", 0] },
    _meta: { title: "VAE Decode Audio" },
  },
  "122": {
    class_type: "VAEDecode",
    inputs: { samples: ["125", 0], vae: ["119", 0] },
    _meta: { title: "VAE Decode" },
  },
  "123": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "res_multistep" },
    _meta: { title: "KSamplerSelect" },
  },
  "124": {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "simple",
      steps: 20,
      denoise: 1,
      model: ["147", 0],
    },
    _meta: { title: "BasicScheduler" },
  },
  "125": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["129", 0],
      guider: ["126", 0],
      sampler: ["123", 0],
      sigmas: ["124", 0],
      latent_image: ["136", 1],
    },
    _meta: { title: "SamplerCustomAdvanced" },
  },
  "126": {
    class_type: "BasicGuider",
    inputs: { model: ["147", 0], conditioning: ["136", 0] },
    _meta: { title: "Basic Guider" },
  },
  "127": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  "128": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  "129": {
    class_type: "RandomNoise",
    inputs: { noise_seed: 904234 },
    _meta: { title: "RandomNoise" },
  },
  "130": {
    class_type: "CreateVideo",
    inputs: {
      fps: SOURCE_FPS,
      bit_depth: 8,
      images: ["122", 0],
      // The clip's own soundtrack unless told otherwise — see `keep_sound`.
      audio: ["154", 2],
    },
    _meta: { title: "Create Video" },
  },
  "136": {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      prompt: ["138", 0],
      width: ["163", 1],
      height: ["163", 2],
      length: ["163", 3],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      "ref_images.ref_image_0": ["137", 0],
      "ref_videos.ref_video_0": ["154", 0],
      // Paired with the clip by index, as in Remix, so the performance comes
      // with its timing. Taken out for a silent clip — see finalize.
      "ref_video_audios.ref_video_audio_0": ["154", 2],
    },
    _meta: { title: "MiniMax H3 Reference to Video" },
  },
  "137": {
    class_type: "LoadImage",
    inputs: { image: "" },
    _meta: { title: "Load Image (character)" },
  },
  "138": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },
  "147": {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      lora_name: SWAP_LORA,
      strength_model: 1,
      model: ["127", 0],
    },
    _meta: { title: "Character Swap LoRA" },
  },
  // Outputs: 0 is the frames, 1 is how many there are, 2 is the soundtrack.
  "154": {
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
  "163": {
    class_type: "GetImageSizeAndCount",
    inputs: { image: ["154", 0] },
    _meta: { title: "Get Image Size & Count" },
  },
  // The run's last 0.9 s of latents, for Extend to carry on from.
  ...latentTailNodes("125"),

  // Batched mode only; `finalize` takes these out of a one-pass run, and
  // wires them in for a long clip. See "Long clips, in slices" above.
  [BATCH_NODE]: {
    class_type: "VHS_BatchManager",
    inputs: { frames_per_batch: SLICE_FRAMES },
    _meta: { title: "Meta Batch Manager" },
  },
  // The pass's frames, cut back to as many as the slice it loaded.
  [TRIM_NODE]: {
    class_type: "ImageFromBatch",
    inputs: { image: ["122", 0], batch_index: 0, length: ["163", 3] },
    _meta: { title: "Image From Batch (the slice's own length)" },
  },
  [COMBINE_NODE]: {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: [TRIM_NODE, 0],
      audio: ["154", 2],
      frame_rate: SOURCE_FPS,
      loop_count: 0,
      filename_prefix: COMBINE_PREFIX,
      format: "video/h264-mp4",
      pix_fmt: "yuv420p",
      crf: 17,
      save_metadata: false,
      trim_to_audio: false,
      pingpong: false,
      save_output: true,
      meta_batch: [BATCH_NODE, 0],
    },
    _meta: { title: "Video Combine" },
  },
};

const params: ParamDef[] = [
  {
    id: VIDEO_PARAM,
    label: "Clip",
    type: "video",
    default: "",
    required: true,
    help: "The performance to keep. Its size and length become the result's. Up to 768×1344 and a minute long. A clip longer than about 6 seconds is swapped in 5-second slices, each about 10 minutes with Turbo.",
    group: "Source",
    maxSeconds: MAX_CLIP_SECONDS,
    measures: CLIP_SECONDS_PARAM,
    targets: [{ node: VIDEO_NODE, input: "video" }],
  },
  {
    id: CLIP_SECONDS_PARAM,
    label: "Clip length",
    type: "measured",
    // Nothing measured yet: one pass, as every clip had before slices.
    default: 0,
    group: "Source",
    targets: [
      {
        node: BATCH_NODE,
        input: "frames_per_batch",
        transform: (_value, values) => swapSlices(values)?.framesPerBatch ?? SLICE_FRAMES,
      },
    ],
  },
  {
    id: IMAGE_PARAM,
    label: "Character",
    type: "image",
    default: "",
    required: true,
    help: "Who they become — face, hair, outfit and art style all come from here. A full-body picture on a plain background works best.",
    group: "Source",
    targets: [{ node: "137", input: "image" }],
  },
  {
    id: "prompt",
    label: "Who to replace",
    type: "text",
    default: "",
    placeholder: "the woman in the foreground",
    help: "Name the one person in the clip to swap, by where they are or what they wear. Works reliably with one person in shot; with two, the costume can land on the wrong one or on both.",
    group: "Prompt",
    targets: [promptTarget],
  },
  {
    id: "character",
    label: "Describe the character",
    type: "text",
    default: "",
    required: true,
    placeholder: "a knight in silver armour with a red cloak",
    help: "A few words on who is in the picture: headwear, clothes, colours. In testing, leaving this out returned the clip unchanged.",
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
    id: KEEP_SOUND_PARAM,
    label: "Keep the clip's sound",
    type: "toggle",
    default: true,
    help: "On, the result carries the clip's own soundtrack untouched. Off, it gets the audio H3 generates alongside the picture. A clip swapped in slices always keeps its own sound.",
    group: "Source",
    // Which wire the output's audio comes from. A silent clip has no sound to
    // keep, and finalize moves it to H3's whatever this says.
    targets: [
      {
        node: "130",
        input: "audio",
        transform: (value) => (value === false ? ["121", 0] : ["154", 2]),
      },
    ],
  },
  {
    id: "lora_strength",
    label: "Swap strength",
    type: "slider",
    default: 1,
    min: 0,
    max: 1.5,
    step: 0.05,
    help: "1 is what the LoRA was trained at. 0 runs the plain model, for comparison.",
    group: "Sampling",
    advanced: true,
    targets: [{ node: "147", input: "strength_model" }],
  },
  // 20, the author's recipe with turbo off. Turbo retunes it to 8.
  ...samplingParams({ noise: "129", scheduler: "124" }, { steps: 20 }),
];

export const minimaxH3Swap: WorkflowDef = {
  id: "minimax-h3-swap",
  name: "Character swap",
  description: "Puts the character from a picture in place of one person in a clip.",
  /**
   * With turbo off. Measured on a 3090: a 5.3 s clip at 736×1280 took 32 minutes at 20 steps,
   * about 89 s a step — slower per step than Remix, since the picture's tokens
   * ride through every step and the LoRA is applied at run time. The first
   * finished runs replace this with the machine's own median.
   */
  estimatedSeconds: 1900,
  hasAudio: true,
  graph,
  params,
  patches: h3Patches(),
  /**
   * On by default at eight steps; see the top of this file for the test. 515 s
   * was measured at 0.7 MP (55 s a step), so 720 allows for a full-size clip.
   */
  turbo: h3Turbo(720, 8),
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
  /** A long clip's estimate is one slice's, times the slices. */
  slicedBy: CLIP_SECONDS_PARAM,
  finalize(graph, values) {
    const sliced = swapSlices(values);
    if (!sliced) {
      for (const node of [BATCH_NODE, TRIM_NODE, COMBINE_NODE]) delete graph[node];
      if (!clipHasAudio(values)) {
        // VHS raises decoding audio from a file that has none, so a silent clip
        // neither conditions on its sound nor hands it to the output.
        delete graph[REFERENCE_NODE].inputs[CLIP_AUDIO_INPUT];
        graph["130"].inputs.audio = ["121", 0];
      }
      return;
    }

    // In slices: the loader driven by the batch manager, and the combine in
    // place of CreateVideo and SaveVideo. See "Long clips, in slices" above.
    graph[VIDEO_NODE].inputs.meta_batch = [BATCH_NODE, 0];
    // Unique per submission: VHS re-queues this graph under new prompt ids,
    // and the prefix is how the status and cancel routes find the passes.
    graph[COMBINE_NODE].inputs.filename_prefix =
      `${COMBINE_PREFIX}_${crypto.randomUUID().slice(0, 8)}`;
    // Every pass would be handed the whole clip's sound, not its slice's.
    delete graph[REFERENCE_NODE].inputs[CLIP_AUDIO_INPUT];
    if (!clipHasAudio(values)) delete graph[COMBINE_NODE].inputs.audio;
    // A pass's latent tail is of padded frames past its slice, so there is
    // nothing true for Extend to carry on from. It picks up from the last
    // frame instead, as it does for any clip without one.
    for (const node of Object.keys(graph)) {
      if (node.startsWith("tail:")) delete graph[node];
    }
    for (const node of ["92", "130", "121"]) delete graph[node];
  },
  finalizeCases: [
    {
      name: "a clip with sound",
      values: { [VIDEO_PARAM]: "clip.mp4", [IMAGE_PARAM]: "c.png", character: "a knight" },
    },
    {
      name: "a clip with sound, H3's own audio",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [KEEP_SOUND_PARAM]: false,
      },
    },
    {
      name: "a clip with sound, turbo",
      values: { [VIDEO_PARAM]: "clip.mp4", [IMAGE_PARAM]: "c.png", character: "a knight" },
      mode: { turbo: true },
    },
    {
      name: "a silent clip",
      values: { [VIDEO_PARAM]: "noaudio--clip.mp4", [IMAGE_PARAM]: "c.png", character: "a knight" },
    },
    {
      name: "a 30-second clip, in slices, turbo",
      values: {
        [VIDEO_PARAM]: "clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [CLIP_SECONDS_PARAM]: 30,
      },
      mode: { turbo: true },
    },
    {
      name: "a silent 12-second clip, in slices",
      values: {
        [VIDEO_PARAM]: "noaudio--clip.mp4",
        [IMAGE_PARAM]: "c.png",
        character: "a knight",
        [CLIP_SECONDS_PARAM]: 12,
        [KEEP_SOUND_PARAM]: false,
      },
    },
  ],
};
