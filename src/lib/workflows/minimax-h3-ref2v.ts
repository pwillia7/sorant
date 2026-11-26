import { isSilentClip } from "@/lib/audio-track";
import { CHAIN_FPS, chainPartOf, MAX_CHAIN_SECONDS } from "./chain";
import type { ComfyGraph } from "@/lib/comfy";
import { hideDirectorOnly } from "./director";
import { latentTailNodes } from "./latent-tail";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import type { ParamDef, ParamValue, WorkflowDef, TextParam } from "./types";
import {
  CLIP_WORDS,
  directorBypassFor,
  directorTarget,
  audioKeep,
  audioKeepHidesWords,
  audioKeepParam,
  audioKeepReusesWords,
  clipDurationParam,
  h3ContentLora,
  h3Patches,
  h3StepSampler,
  h3Turbo,
  literalPromptParam,
  promptParam,
  promptTarget,
  REMIX_DIRECTOR,
  samplingParams,
  wordsBlocks,
  wordsParam,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 remix: rebuild a clip you already have.
 *
 * The clip goes in at node 154 and everything else follows from it:
 *
 * - 154 is VHS's loader, reading the clip at 24 fps. Its frames and its
 *   soundtrack go to the reference node as `ref_videos.ref_video_0` and
 *   `ref_video_audios.ref_video_audio_0` — the soundtrack slot that pairs by
 *   index with the video, not the standalone one. That pair is the only visual
 *   input the sampler gets.
 * - 155 takes every nth frame for the prompt director alone, at a stride 157
 *   works out from the frame count the loader reports — so the rewrite can see
 *   the clip it is editing rather than working blind from the filename. Nothing
 *   from that sample reaches the sampler; an earlier version wired it into
 *   `ref_images.*` as well; that graph is in the history at 16ee0de.
 * - 163 measures the clip's own frames and supplies all three dimensions of
 *   the output: width, height, and length as a frame count. So a remix comes
 *   back the same shape and the same length as what went in, and there is
 *   neither a ResolutionSelector nor a duration node in this graph. That is
 *   also why the loader forces a frame rate: a count taken at one rate and
 *   written out at another is a remix that comes back the wrong length.
 *
 * So the clip is the one input the form offers, with one exception: **Words in
 * the clip**. That is not a second input to the graph — it writes no node the
 * clip does not already fill — but the clip's audio is a recording H3 is asked
 * to work over, and nothing on this side can hear it. Typing the words out is
 * the only way they reach either the director or the model. Same control, same
 * two blocks and the same reasoning as Reference to Video's attached track;
 * see `wordsBlocks`.
 *
 * Otherwise the reference audio and the output size are consequences of the clip
 * rather than choices, and controls for them would misrepresent what this graph
 * does. It can be filled either by the
 * Remix button (`clipTarget` below) or by an upload — see video-upload.tsx
 * for the limits that keeps within, which matter more here than elsewhere
 * because the clip decides what gets generated.
 */
const ids: Omit<MinimaxNodeIds, "duration"> = {
  prompt: { node: "138", input: "value" },
  director: "145",
  noise: "129",
  scheduler: "124",
};

const VIDEO_NODE = "154";
const REFERENCE_NODE = "136";
const CLIP_AUDIO_INPUT = "ref_video_audios.ref_video_audio_0";

/**
 * The rate the clip is read at, and the rate the result is written at.
 *
 * One constant because the two must agree: this graph takes the output's frame
 * count from the source, so a source read at any other rate comes back the
 * wrong length. 24 is what `CreateVideo` writes and what H3 reads a reference
 * video at.
 */
const SOURCE_FPS = 24;

/** Roughly how many frames the director is shown. See node 157. */
const DIRECTOR_FRAMES = 5;
const VIDEO_PARAM = "reference_video";
const WORDS_PARAM = "clip_words";
const AUDIO_KEEP_PARAM = "clip_audio_keep";
/** One window of a long clip, written by the page. See chain.ts. */
const SEGMENT_PARAM = "segment";
const LENGTH_PARAM = "source_seconds";
/** A remix keeps its clip whole unless told otherwise. */
const AUDIO_KEEP_DEFAULT = "exact" as const;

/**
 * Whether this run reuses the speech that is already in the clip.
 *
 * Only the answer that keeps the recording whole does. "Voices only" keeps how
 * it is spoken and replaces what is said, and the three below it keep less than
 * that — so on any of them the words the user typed out describe audio that is
 * not being carried over.
 */
const keepsClipSpeech = (values: Record<string, ParamValue>): boolean =>
  clipHasAudio(values) &&
  audioKeepReusesWords(values, AUDIO_KEEP_PARAM, AUDIO_KEEP_DEFAULT);

/**
 * Whether the clip has a soundtrack to hand over. Every generation does; a
 * silent film or a screen recording does not, and was stored under a name that
 * says so. See storedClipName.
 */
const clipHasAudio = (values: Record<string, ParamValue>): boolean =>
  !isSilentClip(values[VIDEO_PARAM]);

/**
 * What the director is told in place of the soundtrack it was promised.
 *
 * REMIX_DIRECTOR opens by saying there is always a source video and its own
 * audio, because there always was. On a silent clip that sentence names a
 * recording the model was never given, so this corrects it — last, so it
 * lands after what it overrules.
 */
const silentClipBlock = (values: Record<string, ParamValue>): string =>
  clipHasAudio(values)
    ? ""
    : `THE SOURCE IS SILENT

This clip has no audio track, so there is no <Audio 1> this run, whatever is said above. Nothing about the sound carries over and nothing in it can be preserved. Write the soundtrack the new video should have — what is heard, and when — from the picture and the user's instruction, as you would for a video made from nothing.`;

/**
 * What the director is told when this run is one window of a longer clip.
 *
 * Each window is remixed on its own and the takes are joined end to end, so
 * the one thing that shows at a join is a change made two different ways — a
 * coat that is red here and maroon there. The director cannot see the other
 * windows, so the most it can do is describe the change the same way every
 * time: plainly, from the user's words, without inventing particulars a
 * neighbour would invent differently.
 */
const segmentBlock = (values: Record<string, ParamValue>): string => {
  const part = chainPartOf(values[SEGMENT_PARAM]);
  if (!part) return "";
  const from = part.start / CHAIN_FPS;
  const words = keepsClipSpeech(values) && String(values[WORDS_PARAM] ?? "").trim()
    ? " The words typed out for the clip cover the whole of it, not only this part: keep to the ones this part's frames show being spoken, and leave the rest out rather than squeezing them in."
    : "";
  return `ONE PART OF A LONGER CLIP

This video is part ${part.part} of ${part.parts} of a longer clip, starting ${from.toFixed(1)} seconds in. Every part is remixed separately with the same instruction, and the parts are joined end to end — so whatever the instruction changes has to come out the same in every part. Describe the change in the user's own terms and no more specifically than they did: the colour, garment, creature or place they named, as they named it. Do not add particulars of your own to it — an exact shade, a pattern, a make, a hairstyle — because the other parts will invent different ones, and the difference shows at the join. Do not open or close as though this were a whole video: no establishing shot, no ending beat; it begins and ends mid-action, as the source does here.${words}`;
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
      steps: 16,
      denoise: 1,
      model: ["127", 0],
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
    inputs: { model: ["127", 0], conditioning: ["136", 0] },
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
    inputs: { noise_seed: 147913421715932 },
    _meta: { title: "RandomNoise" },
  },
  "130": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["122", 0],
      audio: ["121", 0],
    },
    _meta: { title: "Create Video" },
  },
  "136": {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      prompt: ["145", 0],
      // All three measured off the clip: outputs 1, 2 and 3 of node 163 are
      // width, height and frame count.
      width: ["163", 1],
      height: ["163", 2],
      length: ["163", 3],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      // No ref_images here — the clip is the only reference the sampler gets.
      //
      // The soundtrack goes in `ref_video_audios`, not `ref_audios`, because it
      // is this clip's own audio rather than a second reference that happens to
      // be sound. The node pairs `ref_video_audio_N` with `ref_video_N` by
      // index and emits one fused `video_audio` conditioning block for the two;
      // `ref_audios` would emit a `video` block and an unrelated `audio` one,
      // which is a different thing to hand the model — a clip and a sound
      // beside it, rather than a clip that sounds like this.
      //
      // The labels are the same either way. References are presented as images,
      // then each video preceded by its own soundtrack, then standalone audio,
      // numbered 1-based per type — so with one video and nothing else this is
      // <Video 1> and <Audio 1> in both wirings, and REMIX_DIRECTOR's names for
      // them still hold.
      "ref_videos.ref_video_0": ["154", 0],
      "ref_video_audios.ref_video_audio_0": ["154", 2],
    },
    _meta: { title: "MiniMax H3 Reference to Video" },
  },
  "138": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },

  // The prompt-rewrite stage: 138 holds what the user typed and 145 expands it
  // into what node 136 actually reads.
  //
  // The system prompt is what sets this graph apart from the other three.
  // REMIX_DIRECTOR reads the input as a change to an existing video rather
  // than a scene to invent, and writes out instructions to hold everything
  // else to the source — which is the whole point of the workflow. Which model
  // it runs on is the `rewrite_model` param below; the key lives on the ComfyUI
  // host.
  //
  // The `system_prompt` is overwritten per run by `source_seconds` below, which
  // appends how long the clip runs — measured in the browser, since nothing
  // here knows it until ComfyUI decodes the file. The sampled frames at 156 are
  // used here and nowhere else.
  "145": rewriteNode({
    prompt: ["138", 0],
    system: REMIX_DIRECTOR,
    images: ["155", 0],
    title: "AI Gateway - Rewrite Prompt",
  }),

  // The clip, read at 24 fps.
  //
  // VHS's loader rather than ComfyUI's own, for the two reasons the reference
  // workflow moved to it. `force_rate` matters more here than anywhere: this
  // graph takes the output's *frame count* from the source (node 163) and
  // writes the result at 24 fps, so a clip at any other rate came back the
  // wrong length — a 30 fps ten-second clip is 300 frames, and 300 frames at 24
  // fps is a twelve-and-a-half-second remix, a quarter long and slowed to
  // match. Nothing noticed because the usual source is a generation from this
  // app, which is already 24.
  //
  // And VHS reads a file the core loader cannot measure: a browser's
  // MediaRecorder writes a fragmented MP4 whose header says duration 0 and
  // whose sample tables are empty. See minimax-h3-ref.ts, where that is what
  // reduced a fifteen-second clip to a single frame.
  //
  // No `frame_load_cap` of its own: a remix is the whole clip by definition,
  // which is what separates it from a clip attached as a reference. The one
  // exception is a window of a long clip, which `segment` writes into it.
  //
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

  // A handful of frames spread across the clip, for the director to look at.
  //
  // By stride over the decoded batch rather than by sampling the video, because
  // every node that selects frames from a VIDEO asks the container how many it
  // has — the question a MediaRecorder file answers wrongly. 157 works the
  // stride out from the frame count the loader actually returned.
  "155": {
    class_type: "VHS_SelectEveryNthImage",
    inputs: {
      images: ["154", 0],
      select_every_nth: ["157", 1],
      skip_first_images: 0,
    },
    _meta: { title: "Select Every Nth Image" },
  },
  "157": {
    class_type: "ComfyMathExpression",
    // Output 1 is the INT.
    inputs: {
      expression: `max(1, round(a / ${DIRECTOR_FRAMES}))`,
      "values.a": ["154", 1],
    },
    _meta: { title: "Math Expression" },
  },

  // Reads the clip's full frame sequence, not the five-frame sample: the count
  // has to be the length of the source, not the size of the director's peek.
  "163": {
    class_type: "GetImageSizeAndCount",
    inputs: { image: ["154", 0] },
    _meta: { title: "Get Image Size & Count" },
  },

  // The run's last 0.9 s of latents, for Extend to carry on from. See
  // latent-tail.ts.
  ...latentTailNodes("125"),
};

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
/**
 * The words heard in the source clip, in the prompt and in the director's brief.
 *
 * The clip's own audio is wired straight into the reference node, so this graph
 * hands H3 a recording to work over exactly as Reference to Video does with an
 * attached track — and nothing here can hear either of them. Same problem, same
 * pair of blocks, different noun for where the sound came from.
 */
const words = wordsBlocks({
  sourceParam: VIDEO_PARAM,
  wordsParam: WORDS_PARAM,
  source: CLIP_WORDS,
  // Only while the clip's own speech is being reused. Every other answer
  // replaces it, and a transcript of the old lines would then be the prompt
  // carrying exactly what the rest of the brief says to write anew.
  when: (values) => keepsClipSpeech(values),
});

const director = directorTarget(ids, REMIX_DIRECTOR, [
  words.director,
  // Last, so it lands after the standing preservation rules it overrides.
  audioKeep({
    param: AUDIO_KEEP_PARAM,
    // A remix keeps the clip's sound unless told otherwise, which is what the
    // director already assumed before this control existed.
    fallback: AUDIO_KEEP_DEFAULT,
    // The clip is required here, so its audio is attached whenever it has
    // any.
    attached: clipHasAudio,
  }),
  silentClipBlock,
  // After the words, which it narrows to this part of the clip.
  segmentBlock,
]);

/** Written by the prompt and by the words below. See `promptTarget`. */
const promptText = promptTarget(ids, [words.prompt]);

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  {
    id: VIDEO_PARAM,
    label: "Clip to remix",
    type: "video",
    default: "",
    required: true,
    help: `Its size and length become the new video's. Up to 768×1344, ${MAX_CHAIN_SECONDS / 60} minutes, 100 MB. Over 20 seconds it is remixed in parts of about 10–13 seconds, joined at the end — each part is its own run, so expect a small jump at each join.`,
    group: "Source",
    targets: [{ node: VIDEO_NODE, input: "video" }],
    // The clip is the only thing that knows how long the output will be, so
    // the control that loads it reports that onward to the param below.
    measures: LENGTH_PARAM,
    maxSeconds: MAX_CHAIN_SECONDS,
    warnOverSeconds: 60,
    longClipWarning:
      "A long clip is many runs, each about as long as a 13-second remix. They are all queued at once.",
  },

  // One window of a long clip, written by the page for each run of the chain
  // (use-clip-chain.ts) and empty for an ordinary run. The loader reads only
  // that stretch, picture and sound — checked on the box 2026-11-26: a
  // 24-frame skip and 48-frame cap came back 2.0 s of both, the sound starting
  // exactly 1.0 s in — and node 163 then measures the window, so the take is
  // the window's length.
  {
    id: SEGMENT_PARAM,
    label: "Part of the clip",
    type: "written",
    default: "",
    maxLength: 32,
    group: "Source",
    targets: [
      {
        node: VIDEO_NODE,
        input: "skip_first_frames",
        transform: (v) => chainPartOf(v)?.start ?? 0,
      },
      {
        node: VIDEO_NODE,
        input: "frame_load_cap",
        transform: (v) => chainPartOf(v)?.frames ?? 0,
      },
      director,
    ],
  },

  // No control of its own: filled in by the clip above, and read only by the
  // prompt director. See clipDurationParam for why it exists at all.
  clipDurationParam(director),

  audioKeepParam(director, {
    id: AUDIO_KEEP_PARAM,
    label: "What to keep from the clip's sound",
    fallback: AUDIO_KEEP_DEFAULT,
    group: "Source",
    help: "The clip's own audio is given to the model whatever this says. This decides what the new soundtrack owes it — turn it down to have the sound change with the picture.",
  }),

  wordsParam({
    id: WORDS_PARAM,
    label: "Words in the clip",
    help: "What is said or sung in the clip's own audio. Nothing here can hear it, so without this the model writes its own words over the ones already there — and with the voices being replaced, these are the only copy of the lines there is.",
    // Beside the clip they belong to rather than in a section of their own.
    group: "Source",
    // And only while they are wanted: the answers that write new words have no
    // use for the old ones. See `keepsClipSpeech`.
    revealedBy: VIDEO_PARAM,
    hiddenBy: audioKeepHidesWords(AUDIO_KEEP_PARAM),
    targets: [promptText, director],
  }),

  {
    ...(promptParam(
      ids,
      "Make it snow, and dress the man in a heavy winter coat.",
      "Say only what should change. Everything you leave out is held to the clip.",
      6,
      promptText,
    ) as TextParam),
    label: "What should change",
    hint: "Only the change. Everything you leave out is held to the clip.",
    placeholder: "Make it night, dress him as a pirate…",
  },
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  // No output controls at all on this one. Size and length come from the clip,
  // and the frame rate is fixed at the 24 the model works in.
  //
  // Far fewer steps than the generating graphs: a remix is holding to a source
  // rather than inventing from noise, so it converges quickly. This is the
  // number that ships; node 124's literal is whatever the export happened to
  // carry and never reaches ComfyUI.
  //
  // It is also the number turbo retunes this control to, so switching modes on
  // this graph moves the range without moving the value.
  ...samplingParams(ids, { steps: 8 }),
];

export const minimaxH3ReferenceVideo: WorkflowDef = {
  id: "minimax-h3-ref2v",
  name: "Remix",
  description: "Rebuilds a clip you have already made into a new take.",
  estimatedSeconds: 480,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  /**
   * The same switch as every other video graph, on the same `ref2va` UNET
   * Reference to Video applies it to.
   *
   * It was withheld here for a while on the argument that this graph already
   * samples at 8, the top of the LoRA's range, so the LoRA would spend quality
   * per step and save no time. That was only ever an argument about the number
   * this workflow ships at, and it left the other end of the range broken: at 4
   * steps the graph takes the pack's four-step form — distilled sampler, no
   * Spectrum — and the sampler in that form exists to be paired with
   * the distilled LoRA. Four steps without one is not a usable take, so the
   * cheap end of the control was reachable and worthless.
   *
   * **It starts at four steps**, not at the eight this graph ships at with the
   * switch off. Four is where the node pack's own form is complete — its
   * four-step sampler, no Spectrum — and with the LoRA under it
   * that form is the fast one and the intended one at once. Eight is still a
   * drag of the control away for a take worth the extra minutes.
   *
   * 270s is scaled from this graph's own 480 on the fit Reference to Video's
   * numbers imply: about 60s of everything that is not sampling, and the rest
   * per step — so 480 at eight steps puts a step near 52s, and four of them at
   * 60 + 210. Measured on nothing; the first finished run in this combination
   * replaces it with this machine's median.
   */
  turbo: h3Turbo(270, 4),
  /**
   * The patches do apply, though, and for the reason turbo does not: they
   * change how a step is arrived at rather than how many there are, so a low
   * step count is no argument against either of them.
   */
  // The content LoRA first, matching the order they stack in. Same ref2va
  // backbone and same caveat as Reference to Video — see h3ContentLora.
  patches: [h3ContentLora(), ...h3Patches()],
  /**
   * The same four-step form as Reference to Video, because it is the same model
   * under the same node class: `minimax_h3_ref2va` through
   * `MiniMaxH3ReferenceToVideo`, given a reference to work over — pictures and a
   * track there, a clip and its audio here.
   *
   * So at four steps this graph is the pack's four-step form: the distilled
   * sampler, and no Spectrum.
   *
   * It stays on the quantised pair the stored graph names. It used to load the
   * bf16 diffusion model and text encoder at four steps — 118 GB between them,
   * streamed from system RAM on a 24 GB card, which is slow whenever RAM runs
   * short —
   * on the strength of a tensor-size failure the quantised pair had with
   * references. That failure was the turbo pack's AdaLN injection on a pruned
   * base, fixed upstream (Larryvrh/ComfyUI-MiniMax-H3-Turbo #16), and on
   * 2026-11-24 this graph ran at four steps on the quantised pair with a clip
   * and its soundtrack, cleanly. See minimax-h3-ref.ts for the rest.
   */
  stepSampler: h3StepSampler({
    suppresses: ["spectrum"],
    note: "It also leaves Spectrum out, which the four-step form does not use.",
  }),
  /**
   * The prompt is the one thing the clip cannot supply, so it comes across
   * from the generation being remixed. See ClipTarget for what deliberately
   * does not.
   */
  /**
   * Past one window the page sends the clip as a chain of windows and joins
   * them. "Keep it exactly" joins under the clip's own soundtrack, so the
   * sound has no seams; anything else keeps each take's own.
   */
  chain: {
    lengthParam: LENGTH_PARAM,
    segmentParam: SEGMENT_PARAM,
    clipParam: VIDEO_PARAM,
    keepsClipSound: { param: AUDIO_KEEP_PARAM, value: "exact", fallback: AUDIO_KEEP_DEFAULT },
  },
  clipTarget: {
    action: "remix",
    accepts: "video",
    sourceParam: "reference_video",
    carry: ["prompt"],
  },
  /**
   * A silent clip goes in without its soundtrack input, rather than with one
   * that fails: VHS decodes a clip's audio the first time something reads it,
   * and on a file with no audio stream that decode raises and ends the run.
   * Reference to Video sends a clip with no sound the same way, through the
   * same node class, so this is a combination the model already takes.
   */
  finalize(graph, values) {
    if (!clipHasAudio(values)) {
      delete graph[REFERENCE_NODE].inputs[CLIP_AUDIO_INPUT];
    }
  },
  finalizeCases: [
    { name: "a clip with sound", values: { [VIDEO_PARAM]: "clip.mp4" } },
    {
      name: "a silent clip",
      values: { [VIDEO_PARAM]: "noaudio--clip.mp4" },
    },
    {
      name: "one window of a long clip",
      values: { [VIDEO_PARAM]: "clip.mp4", [SEGMENT_PARAM]: "2/3:243:243", [LENGTH_PARAM]: 10.125 },
    },
    {
      name: "the last window of a long silent clip, turbo",
      values: { [VIDEO_PARAM]: "noaudio--clip.mp4", [SEGMENT_PARAM]: "3/3:486:0", [LENGTH_PARAM]: 4 },
      mode: { turbo: true },
    },
    {
      name: "a silent clip, turbo",
      values: { [VIDEO_PARAM]: "noaudio--clip.mp4" },
      mode: { turbo: true },
    },
  ],
};
