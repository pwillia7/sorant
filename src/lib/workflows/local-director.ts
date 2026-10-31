import type { ComfyGraph } from "@/lib/comfy";
import { pruneUnreachable, terminals } from "./director";
import { REWRITE_CLASSES, REWRITE_IMAGE_INPUT } from "./rewrite-model";

/**
 * Where the prompt rewrite runs: on the Vercel AI Gateway, or on the ComfyUI
 * machine itself.
 *
 * The gateway is the default and the better writer, but every model on it is
 * someone's hosted model with someone's content policy, and a director that
 * declines to describe the shot is a run that never starts. The local option
 * exists for exactly that: a model with its refusals taken out, run by
 * ComfyUI's own `TextGenerate` node on the same card that renders the video.
 *
 * In-process rather than a llama.cpp or Ollama server beside ComfyUI, and that
 * is the decision everything else here follows from. The card is full during a
 * render — H3's text encoder alone is a 32B Qwen3-VL — so a director cannot sit
 * resident next to the video models; it has to be loaded, used and evicted
 * before they arrive. Loaded through `CLIPLoader`, it is a model ComfyUI's own
 * memory manager knows about and evicts like any other. A separate server is
 * memory ComfyUI cannot see, and the hand-off between the two is a race.
 *
 * The price is speed, and less of it than it first looked. A full H3 brief
 * takes about twenty seconds on a 3090, with the model loaded cold, where the
 * gateway takes ten or twenty — but only from a plain build of the model. The
 * same weights packaged as an LTX text encoder took eighty. That was measured,
 * not guessed — see `scripts/spike-local-director.ts` and `slower` below.
 *
 * Not a param. Which machine writes the brief is a fact about the person's
 * setup rather than about any one workflow, so it is chosen once, beside the
 * gateway key, and travels with the run as a mode. See `RunMode.localDirector`.
 */
export type DirectorEngine = "gateway" | "local";


/** A language model the box can run as a director, found by its filename. */
export interface LocalDirectorModel {
  id: string;
  label: string;
  /**
   * How to recognise it in ComfyUI's `text_encoders` list.
   *
   * A pattern rather than a filename because the filename is not stable: the
   * upstream one has spaces in it, and browsers and download managers each
   * mangle those differently — the copy on the machine this was built against
   * arrived with every space turned into "20". Matching on what the file *is*
   * keeps working whatever it was saved as.
   */
  match: RegExp;
  /**
   * Files `match` accepts that are the same model in a worse package — taken
   * only when nothing better is installed, so a box that has both runs the
   * good one, and a box that has only this keeps working.
   */
  slower?: RegExp;
  /** Where to get it, for the error that says it is missing. */
  download: string;
  /** What choosing it means, for the picker: what it is good at, what it costs. */
  about: string;
  /** What one brief adds to a run, for a first estimate. See `LOCAL_DIRECTOR_SECONDS`. */
  seconds: number;
  /**
   * Big enough to fill a 24 GB card, so that VRAM held back from it is weights
   * streamed from system RAM on every token. `check:nodes` warns of
   * `--vram-headroom` for these.
   */
  fillsCard?: boolean;
  /** `TextGenerate` inputs of its own, over the ones every model gets. */
  inputs?: Record<string, unknown>;
}

/**
 * The models known to work, best first — a browser that has not chosen gets
 * the first one the machine has.
 *
 * Chosen in a bake-off on a 3090 (2026-10-31): four models through the app's
 * own plan, shot and brief paths, the replies through its own parsers. Two
 * made it. A Qwen3-VL 8B dropped scenes from long plans and never released a
 * style picture's subject; a Gemma 4 E4B was slower than the 12B on a card
 * without native fp8, and no better than the gateway.
 *
 * Qwen 3.8 27B writes the best plans and shots of any of them — every place
 * distinct, the idea followed closest — at about twice Gemma's time and 20 GB
 * at its peak, so it wants a 24 GB card. It is the stock model, not one with
 * its refusals taken out, but it wrote everything the refusal probes asked
 * for. Its multi-token prediction made it no faster, so it is off.
 *
 * At 20 GB it is also what fills the card, and a launch line with
 * `--vram-headroom` takes away the room it needs: Dynamic VRAM then leaves
 * part of it in system RAM and streams those weights over PCIe for every
 * token, and half its replies took six minutes instead of forty seconds — the
 * same text, nine times slower. Without the flag, none did. `check:nodes`
 * says when the flag is there.
 *
 * Then Heretic's uncensored Gemma 4 12B (6 refusals in 100, against 99
 * for the stock model), as a single-file int8 build made for ComfyUI's
 * `TextGenerate`. Gemma 4 because it is what ComfyUI's own LTX prompt enhancer
 * runs, so the format of these briefs is work it is known to do; and it can
 * see, so the graphs that show their director a picture keep doing so. A bf16
 * build is 24 GB or more and does not fit on a 24 GB card, which is why the
 * pattern insists on int8.
 *
 * The first build used was an LTX-2.5 text encoder — the same weights with
 * LTX's conditioning projections added. It writes the same briefs, but the
 * projections make ComfyUI load it through the LTX encoder wrapper, and a
 * reference brief took 79–82 seconds from it against 20–24 from the plain
 * build, warm or cold. It still matches, as `slower`.
 */
export const LOCAL_DIRECTOR_MODELS: LocalDirectorModel[] = [
  {
    id: "qwen38-27b",
    label: "Qwen 3.8 27B (W4A8)",
    match: /qwen3\.8[-_ ]?27b.*w4a8/i,
    download: "https://huggingface.co/beycanai/Qwen-LM",
    about:
      "The best writer of the local models: richer shots, closer to your idea. Needs a 24 GB card. Adds about 40 seconds to every video; a music video takes about 2 minutes to plan and 3 to write 20 shots. The stock model rather than an uncensored one, though it has refused nothing in testing.",
    seconds: 45,
    fillsCard: true,
    inputs: { mtp: "off" },
  },
  {
    id: "gemma-4-12b-heretic",
    label: "Gemma 4 12B uncensored (heretic, int8)",
    match: /gemma[-_ ]?4[-_ ]?12b.*heretic.*int8/i,
    // The publisher's name as well as the format's: the copy this was measured
    // on lost "LTX" when its spaces were mangled, and kept "DeepNeuralNerd".
    slower: /ltx|deepneuralnerd/i,
    download:
      "https://huggingface.co/radiatingreverberations/Gemma-4-12B-It-Uncensored-Heretic-INT8-ConvRot-ComfyUI",
    about:
      "Uncensored, and twice as fast: adds about 20 seconds to every video, and a music video takes about 45 seconds to plan and 1 minute to write 20 shots. Fits a 16 GB card. Plainer writing than the 27B, and a little more given to repeating places across a music video.",
    seconds: 25,
  },
];

export const DEFAULT_LOCAL_DIRECTOR = LOCAL_DIRECTOR_MODELS[0].id;

/**
 * The model a run on the local director was made with when the history does
 * not say: until there were two, Gemma was the only one.
 */
export const EARLIEST_LOCAL_DIRECTOR = "gemma-4-12b-heretic";

export function localDirectorModel(id: unknown): LocalDirectorModel {
  return (
    LOCAL_DIRECTOR_MODELS.find((model) => model.id === id) ??
    LOCAL_DIRECTOR_MODELS[0]
  );
}

/** Which model a file is, if any — for a graph that knows only the file. */
function modelForFile(file: string): LocalDirectorModel | undefined {
  const name = file.split(/[\\/]/).pop() ?? file;
  return LOCAL_DIRECTOR_MODELS.find((model) => model.match.test(name));
}

/**
 * The file on this install that is the chosen model, if there is one.
 * `available` is CLIPLoader's live `clip_name` list.
 */
export function findLocalDirectorFile(
  model: LocalDirectorModel,
  available: string[],
): string | undefined {
  // Basename only: ComfyUI lists files in subfolders with the folder prefixed,
  // and a folder name is not part of what the file is.
  const matches = available.filter((file) =>
    model.match.test(file.split(/[\\/]/).pop() ?? file),
  );
  return (
    matches.find((file) => !model.slower?.test(file)) ?? matches[0]
  );
}

/**
 * What a local brief adds to a run, for the first estimate in a combination
 * before this device has timings of its own. Measured on a 3090 with the model
 * loaded cold: 20–24 seconds for a reference brief from Gemma, 36–43 from the
 * 27B. A model the app does not know gets Gemma's.
 */
export const LOCAL_DIRECTOR_SECONDS = 25;

export function localDirectorSeconds(file: string): number {
  return modelForFile(file)?.seconds ?? LOCAL_DIRECTOR_SECONDS;
}

export const LOCAL_CLASS = "TextGenerate";
export const LOCAL_LOADER_CLASS = "CLIPLoader";
/**
 * The node that holds the director's instruction for it.
 *
 * Needed because `TextGenerate`'s `system_prompt` is socket-only — it will not
 * take a typed value, only a link — where the gateway nodes take the
 * instruction as a plain widget. The instruction is still written per run by
 * the duration param onto the director node; the conversion moves whatever
 * ended up there into this node.
 */
const SYSTEM_CLASS = "PrimitiveStringMultiline";

/**
 * How much the local director may write.
 *
 * The same ceiling as the gateway's and for the same reason — a truncated brief
 * renders, and simply stops following the prompt partway through. `TextGenerate`
 * defaults to 512, which is under half of a ten-second H3 brief.
 */
const MAX_LENGTH = 4096;

/**
 * Turn every gateway director in the graph into a local one, in place. Call it
 * on a clone — `applyParams` does, after `finalize` and before
 * `applyTextOnlyRewrite`.
 *
 * The node keeps its id. That is what lets everything downstream go on working
 * untouched: the links that read the brief off output 0, the bypass that
 * rewires them to the raw prompt, the trigger words a LoRA adds where the
 * prompt reaches the model. `TextGenerate` returns the text on output 0 just as
 * the gateway nodes do.
 *
 * Before the text-only pass rather than after, because that pass exists for
 * models that cannot see and this one can: a converted node is no longer a
 * gateway class, so the text-only pass leaves it alone and the pictures stay
 * wired. Where `finalize` left nothing to show, there is simply no image input
 * — `TextGenerate`'s is optional, where `DescribeImage`'s is not.
 *
 * The gateway node's seed, which is 0 bar the music video's plan: ComfyUI
 * caches a node whose inputs have not changed, so re-queueing the same prompt
 * reuses the brief rather than spending another twenty seconds on a new one.
 */
export function applyLocalRewrite(graph: ComfyGraph, file: string): void {
  const roots = terminals(graph);
  const model = modelForFile(file);
  let converted = false;
  // One loader for every director in the graph, named after the first. A
  // loader each would load the model once per director and hold every copy
  // until the run ends: twice for the music video's plan, and once per scene
  // for the run that writes its shots.
  let loader: string | undefined;

  for (const [id, node] of Object.entries(graph)) {
    if (!REWRITE_CLASSES.includes(node.class_type)) continue;

    const system = `${id}:local-system`;
    if (!loader) {
      loader = `${id}:local-loader`;
      graph[loader] = {
        class_type: LOCAL_LOADER_CLASS,
        // The type only picks among encoders that share an architecture; a
        // generating model is recognised from its weights whichever is given.
        inputs: { clip_name: file, type: "ltxv" },
        _meta: { title: "Load Local Director" },
      };
    }

    const instruction = node.inputs.system_prompt;
    const systemLink: [string, number] | undefined = Array.isArray(instruction)
      ? (instruction as [string, number])
      : typeof instruction === "string" && instruction.trim()
        ? [system, 0]
        : undefined;
    if (systemLink?.[0] === system) {
      graph[system] = {
        class_type: SYSTEM_CLASS,
        inputs: { value: instruction },
        _meta: { title: "Local Director Instruction" },
      };
    }

    const image = node.inputs[REWRITE_IMAGE_INPUT];
    node.class_type = LOCAL_CLASS;
    node.inputs = {
      clip: [loader, 0],
      prompt: node.inputs.prompt,
      // A director given more room on the gateway keeps it here.
      max_length: Math.max(MAX_LENGTH, Number(node.inputs.max_tokens) || 0),
      // Gemma's own recommended sampling.
      sampling_mode: "on",
      "sampling_mode.temperature": 1,
      "sampling_mode.top_k": 64,
      "sampling_mode.top_p": 0.95,
      "sampling_mode.min_p": 0.05,
      "sampling_mode.repetition_penalty": 1.05,
      // The gateway node's own, which is 0 bar a director that asks for a
      // fresh reply every run — the music video's plan.
      "sampling_mode.seed": Number(node.inputs.seed) || 0,
      // Thinking would double the slowest part of the run for a brief that is
      // already structured by the instruction.
      thinking: false,
      use_default_template: true,
      ...(systemLink ? { system_prompt: systemLink } : {}),
      ...(image !== undefined ? { image } : {}),
      ...model?.inputs,
    };
    converted = true;
  }

  // Nothing becomes unreachable today — the pictures stay wired — but the pass
  // is the same shape as the text-only one, and a director input that stopped
  // being carried across would otherwise leave its feeder looking like output.
  if (converted) pruneUnreachable(graph, roots);
}

/**
 * The graph a local run would queue, for `check:workflows`. The filename is a
 * stand-in: what is being checked is the wiring, not the file.
 */
export function localGraph(graph: ComfyGraph): ComfyGraph {
  const clone = structuredClone(graph);
  applyLocalRewrite(clone, "local-director.safetensors");
  return clone;
}
