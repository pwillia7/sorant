import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import {
  aspectRatioParam,
  directorTarget,
  leadingReferences,
  lookParam,
  referenceKeep,
  referenceSlot,
  styleReferences,
  type MinimaxNodeIds,
} from "./minimax-common";
import { REWRITE_IMAGE_INPUT, rewriteModelParam, rewriteNode } from "./rewrite-model";
import {
  CAST_BRIEF,
  MUSIC_VIDEO_PICTURES,
  PLAN_BRIEF,
  SCENES_HEADING,
  SHOT_BRIEF,
  type ShotRequest,
} from "@/lib/music-video/scenes";
import type { ParamDef, ParamTarget, ParamValue, WorkflowDef } from "./types";

/**
 * The graph a planned video is planned with: the music video, and the
 * multi-scene video. Both are the same three steps — an outline of every
 * scene, a description of the people in the pictures, then a shot written
 * for each scene from the outline — and differ only in what the planner and
 * the writers are told, and in what the form asks for. Each workflow brings
 * those; the graph, the pictures and the checks are here, once.
 *
 * The graph only plans. The browser submits each scene as a run of its own
 * and joins them. See src/lib/music-video/.
 */

const PROMPT_NODE = "1";
export const DIRECTOR_NODE = "2";
const BATCH_NODE = "4";
const REF_NODES = ["3", "5", "6", "7"].slice(0, MUSIC_VIDEO_PICTURES);
/** Describes the people in the pictures, from the pictures alone. */
const CAST_NODE = "8";
const CAST_PROMPT_NODE = "9";
/** The planner's own batch, when a style picture is left out of it. */
const PLAN_BATCH_NODE = "10";

const ids: Pick<MinimaxNodeIds, "director"> = { director: DIRECTOR_NODE };

/** How a slot names its input on the batch. Slot 1 is index 0. */
const batchInput = (index: number) => `images.image${index - 1}`;

/**
 * How the people in the pictures look, written once for the whole video.
 *
 * Its own call, shown the pictures and never the user's idea, because the
 * idea is where the drift came from. Each scene's director used to describe
 * the singer for itself, from the pictures and from an idea that described him
 * differently, and settled the conflict a different way almost every time: of
 * one video's 41 scenes, 23 dressed him as the idea said, 6 as the picture
 * showed, and 11 in both hats at once. Telling the planner the picture wins
 * was not enough either — on the local model it followed the idea's outfit on
 * one plan in two. A describer that never sees the idea cannot follow it.
 */
export const castDescriber = (noun: string) => `You describe the reference pictures of ${noun} — the people in them, and the style of any picture that is there for its style — so that every scene of it shows them the same way.

You are shown the pictures, in order: <Picture 1>, <Picture 2> and so on. Below, you are told what each one is for.

Return only the description, as plain text with no heading, list or markdown: one short paragraph per picture you are asked to describe, each opening with who it is and which picture — "The man in <Picture 1>: ..." — or, for a style picture, "The style of <Picture 2>: ...".

Be concrete and exact about what you can see: skin, hair and facial hair, build and apparent age; every garment with its colour, pattern and cut; hats, glasses, jewellery and anything carried. Do not spell out lettering or logos: say there is lettering, where, and in what colour. The video model reads the words off the picture itself, and a misreading written here would compete with them in every scene. Describe only what is visible. Do not guess at what is out of frame, and do not name the person, the setting, the mood or the style of the picture.

Describe how they look, never what they are doing. Leave out pose, gesture, expression and where their hands are: every scene is a different moment, and anything you write here is repeated in all of them.

A style picture is there for how it is made, not for what is in it. Name its medium, and the tradition or genre it belongs to when you recognise one (a Persian miniature, ukiyo-e, 1980s anime, a Pixar-style 3D render, Super 8 film), then describe its line and edges, texture and grain, the palette, the contrast and how light falls, so that a scene with entirely different content could be made in it. Never name or describe anything it shows — no person, place, object or subject matter — because every scene would then show it too.

Any other picture may have no person or character in it at all — a place, a game screen, an object. Write nothing for that picture: no paragraph, and no note that there is nobody in it.`;

/** What to describe in each picture, by what the picture is set to keep. */
function castBlock(values: Record<string, ParamValue>): string {
  const filled = leadingReferences(values, REF_NODES.length);
  const lines: string[] = [];
  for (let index = 1; index <= filled; index += 1) {
    const ask = {
      everything: "describe the person's face, hair, build, and everything they wear and carry.",
      identity:
        "describe only the person's face, hair and build. What they wear is chosen elsewhere, so say nothing about their clothes.",
      costume:
        "describe only what the person wears and carries, which goes onto someone else. Say nothing about their face, hair or build.",
      style:
        "a style reference. Describe only its style, in a paragraph of its own, and nothing that is in it.",
    }[referenceKeep(values, index)];
    lines.push(`<Picture ${index}>: ${ask}`);
  }
  return lines.length ? `THE PICTURES

${lines.join("\n")}` : "";
}

/**
 * What each picture is for, as the planner and the shot writers need it.
 *
 * Not the scene director's own reference block, which the planner used to be
 * sent: that one is written for a director filling in `subject_definitions`
 * and `retention_analysis`, neither of which a plan has, and it cannot say the
 * one thing a plan needs — that a picture with no one in it, a game screen or
 * a place, is something to put in the shots rather than somebody to cast.
 *
 * A style picture is named but not shown: see `shownToPlanner`.
 */
export function picturesBlock(values: Record<string, ParamValue>): string {
  const filled = leadingReferences(values, REF_NODES.length);
  if (filled === 0) return "";
  const shown = shownToPlanner(values);
  const styles = styleReferences(values);
  const lines = shown.map((index) => {
    const says = {
      everything: "whoever is in it, kept exactly as they are — face, hair and clothes. Do not describe them.",
      identity:
        "who is in it, kept as they are; what they wear is the video's to choose (see the look).",
      costume: "what is worn in it, put onto whoever the scene casts.",
      style: "",
    }[referenceKeep(values, index)];
    return `<Picture ${index}>: ${says}`;
  });
  const labels = (indexes: number[]) => indexes.map((index) => `<Picture ${index}>`).join(", ");
  // Numbered as every scene numbers them, which is not the order shown once a
  // style picture before them has been left out.
  const order =
    shown.length > 0 && shown.some((index, position) => index !== position + 1)
      ? `\n\nYou are shown ${labels(shown)}, in that order.`
      : "";
  const style =
    styles.length > 0
      ? `${labels(styles)}, which you are not shown, ${styles.length > 1 ? "set" : "sets"} only the style every scene is drawn in. That is written up separately and handled for you: never mention ${styles.length > 1 ? "them" : "it"}, and do not describe how the footage looks.`
      : "";
  return [
    `THE PICTURES\n\nEvery scene is given these same pictures.${order}`,
    lines.join("\n"),
    style,
    shown.length > 0
      ? "A picture with no one in it shows a place or an object: put what it shows into the scenes where it belongs."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The pictures the planner and the shot writers are shown: all but the style
 * ones. Shown a Persian miniature as a style, the local planner put "dancers
 * like the figures in <Picture 2>" into the outline on two plans in four,
 * however plainly it was told the picture's content was not the video's. The
 * describer is the one that needs to see it, and its words reach every scene.
 */
function shownToPlanner(values: Record<string, ParamValue>): number[] {
  const filled = leadingReferences(values, REF_NODES.length);
  const styles = new Set(styleReferences(values));
  return Array.from({ length: filled }, (_, i) => i + 1).filter((index) => !styles.has(index));
}

/** The scene list the browser writes before planning. See `sceneList`. */
export const SCENES_PARAM = "scene_list";

/**
 * The outline, handed back once the plan has come in. Set, it makes this run
 * write a shot for every scene instead of planning. See `finalize`.
 */
export const OUTLINE_PARAM = "scene_outline";

function readOutline(values: Record<string, ParamValue>): ShotRequest | null {
  const raw = String(values[OUTLINE_PARAM] ?? "").trim();
  if (!raw) return null;
  try {
    const outline = JSON.parse(raw) as ShotRequest;
    if (Array.isArray(outline.scenes) && outline.scenes.length > 0) return outline;
  } catch {
    // Falls through to the refusal below.
  }
  throw new ParamError("The outline to write the shots from could not be read. Plan again.", "prompt");
}

/** Last, after everything else: it is what the reply has to match one for one. */
const scenesBlock = (values: Record<string, ParamValue>) => String(values[SCENES_PARAM] ?? "");

type Block = (values: Record<string, ParamValue>) => string;

export interface PlannedVideoSpec {
  /** The planner's instruction. */
  planner: string;
  /** What the describer is told the pictures are of: "a music video". */
  noun: string;
  /** The planner's blocks between the pictures and the scene list. */
  blocks: Block[];
  /** One scene's shot writer's instruction, from the outline. */
  shotSystem: (outline: ShotRequest, index: number, values: Record<string, ParamValue>) => string;
  /** Said when a run arrives before there is a scene list, and on which control. */
  unplanned: { message: string; field: string };
}

/**
 * The plan graph for one kind of planned video, with the controls every kind
 * shares and the `finalize` that turns it into the outline's run or the
 * shots' run.
 */
export function plannedVideo(spec: PlannedVideoSpec) {
  const describer = castDescriber(spec.noun);
  const graph: ComfyGraph = {
    [PROMPT_NODE]: {
      class_type: "PrimitiveStringMultiline",
      inputs: { value: "" },
      _meta: { title: "Input Text (Idea)" },
    },
    [DIRECTOR_NODE]: rewriteNode({
      prompt: [PROMPT_NODE, 0],
      system: spec.planner,
      images: [BATCH_NODE, 0],
      title: `AI Gateway - ${PLAN_BRIEF}`,
      // Every scene of a long video in one reply: forty lines of a hundred-odd
      // tokens is more than the usual brief's ceiling.
      maxTokens: 12288,
    }),
    [CAST_PROMPT_NODE]: {
      class_type: "PrimitiveStringMultiline",
      inputs: { value: "Describe the people in these pictures." },
      _meta: { title: "Input Text (Describe cast)" },
    },
    [CAST_NODE]: rewriteNode({
      prompt: [CAST_PROMPT_NODE, 0],
      system: describer,
      images: [BATCH_NODE, 0],
      title: `AI Gateway - ${CAST_BRIEF}`,
    }),
    [BATCH_NODE]: {
      class_type: "BatchImagesNode",
      inputs: {
        "images.image0": ["3", 0],
        "images.image1": ["5", 0],
        "images.image2": ["6", 0],
        "images.image3": ["7", 0],
      },
      _meta: { title: "Batch Images" },
    },
    ...Object.fromEntries(
      REF_NODES.map((node) => [
        node,
        {
          class_type: "LoadImage",
          inputs: { image: "" },
          _meta: { title: "Load Image" },
        },
      ]),
    ),
  };

  const director: ParamTarget = directorTarget(
    ids,
    spec.planner,
    [picturesBlock, ...spec.blocks, scenesBlock],
    // No length block: the planner is not writing one clip of a known length.
    () => "",
  );

  /** Written by every reference control, from the whole submission. */
  const cast = directorTarget({ director: CAST_NODE }, describer, [castBlock], () => "");

  const ideaParam = (fields: Pick<ParamDef, "help"> & { placeholder: string }): ParamDef => ({
    id: "prompt",
    label: "What the video is",
    type: "textarea",
    rows: 4,
    default: "",
    placeholder: fields.placeholder,
    maxLength: 4000,
    help: fields.help,
    group: "Video",
    targets: [{ node: PROMPT_NODE, input: "value" }],
  });

  const plumbing: ParamDef[] = [
    {
      id: SCENES_PARAM,
      label: "Scene list",
      type: "written",
      default: "",
      // About sixty characters a scene; this is several hundred scenes.
      maxLength: 20000,
      targets: [director],
    },
    {
      id: OUTLINE_PARAM,
      label: "Outline",
      type: "written",
      default: "",
      // Two or three hundred characters a scene, with its line of the list.
      maxLength: 60000,
      // Through the planner's node, which `finalize` turns into the writers:
      // each one's instruction is built from this there.
      targets: [director],
    },
  ];

  const pictureParams: ParamDef[] = REF_NODES.flatMap((node, position) =>
    referenceSlot({
      index: position + 1,
      node,
      director,
      firstRequired: false,
    }).map(
      (param): ParamDef => ({
        ...param,
        // Every scene is its own run, so whatever a picture releases is
        // decided again in each one — a costume left to the scene changes at
        // every cut.
        ...(param.type === "select"
          ? {
              help: "Keep Everything for one consistent character. Each scene is rendered separately, so anything else lets their look change at every cut — “Identity only” re-dresses them scene by scene.",
            }
          : {}),
        // The same pictures go under every scene, with what each one keeps.
        scope: "scenes",
        // And to the describer, which is told what to describe in each.
        targets: [...param.targets, cast],
      }),
    ),
  );

  const outputParams = (unit: string): ParamDef[] => [
    { ...lookParam(director, { references: true }), scope: "scenes" },
    { ...aspectRatioParam("unused"), scope: "scenes", targets: [] },
    {
      id: "megapixels",
      label: "Frame size",
      type: "slider",
      default: 0.5,
      min: 0.1,
      max: 1,
      step: 0.05,
      unit: "MP",
      help: `Per scene. 1 MP takes about three times as long as 0.5 MP, and ${unit} is a dozen or more scenes.`,
      group: "Output",
      scope: "scenes",
      targets: [],
    },
    {
      // Reference to Video's own control, under its id, so every scene takes it.
      // Same default and range as there; Turbo retunes it to that graph's 4–8
      // in the form, because the scenes run in that graph's modes. See
      // `effectiveWorkflow`.
      id: "steps",
      label: "Steps",
      type: "slider",
      default: 12,
      min: 4,
      max: 60,
      step: 1,
      help: `Per scene. More steps is a slower scene, and ${unit} is a dozen or more of them.`,
      group: "Output",
      scope: "scenes",
      targets: [],
    },
    {
      id: "seed",
      label: "Seed",
      type: "seed",
      default: -1,
      help: "-1 picks one at random. Each scene adds its own number to it, so a whole video can be made again exactly.",
      group: "Output",
      advanced: true,
      scope: "scenes",
      // The plan's too: at a fixed seed every director gives the same reply to
      // the same request, and ComfyUI hands back the cached one, so planning
      // again after an unreadable plan would only bring the same plan back.
      targets: [{ node: DIRECTOR_NODE, input: "seed" }],
    },
    {
      ...rewriteModelParam(graph, [DIRECTOR_NODE, CAST_NODE]),
      // The same model writes the plan and every scene's brief.
      scope: "scenes",
    },
  ];

  const finalize: NonNullable<WorkflowDef["finalize"]> = (graph, values) => {
    const filled = leadingReferences(values, REF_NODES.length);
    for (let index = filled + 1; index <= REF_NODES.length; index += 1) {
      delete graph[BATCH_NODE].inputs[batchInput(index)];
      delete graph[REF_NODES[index - 1]];
    }
    // No pictures, no batch: the planner works from the idea alone, and the
    // node becomes a text rewrite centrally. See the reference graph.
    if (filled === 0) {
      delete graph[DIRECTOR_NODE].inputs[REWRITE_IMAGE_INPUT];
      delete graph[BATCH_NODE];
      // Nobody to describe.
      delete graph[CAST_NODE];
      delete graph[CAST_PROMPT_NODE];
    }
    // The planner, and the writers made from it below, see every picture but
    // the style ones, which only the describer needs. See `shownToPlanner`.
    const shown = shownToPlanner(values);
    if (filled > 0 && shown.length < filled) {
      if (shown.length === 0) {
        delete graph[DIRECTOR_NODE].inputs[REWRITE_IMAGE_INPUT];
      } else {
        graph[PLAN_BATCH_NODE] = {
          class_type: "BatchImagesNode",
          inputs: Object.fromEntries(
            shown.map((index, position) => [batchInput(position + 1), [REF_NODES[index - 1], 0]]),
          ),
          _meta: { title: "Batch Images (Planner)" },
        };
        graph[DIRECTOR_NODE].inputs[REWRITE_IMAGE_INPUT] = [PLAN_BATCH_NODE, 0];
      }
    }
    if (!String(values[SCENES_PARAM] ?? "").includes(SCENES_HEADING)) {
      throw new ParamError(spec.unplanned.message, spec.unplanned.field);
    }

    // The second run of a plan: the outline has come back, and this one
    // writes each scene's shot from it, a writer per scene. Each is the
    // planner's node over again — the same model, the same pictures, the same
    // idea as its prompt — with its own instruction.
    const outline = readOutline(values);
    if (outline) {
      const template = graph[DIRECTOR_NODE];
      const seed = (Number(template.inputs.seed) || 0) + (outline.take ?? 0);
      outline.scenes.forEach((_, index) => {
        if (outline.only && !outline.only.includes(index)) return;
        const node = structuredClone(template);
        node.inputs.system_prompt = spec.shotSystem(outline, index, values);
        // One shot, not a plan.
        node.inputs.max_tokens = 1024;
        node.inputs.seed = seed + index;
        node._meta = { title: `AI Gateway - ${SHOT_BRIEF} ${index + 1}` };
        graph[`shot${index + 1}`] = node;
      });
      delete graph[DIRECTOR_NODE];
      // The look was settled with the outline.
      delete graph[CAST_NODE];
      delete graph[CAST_PROMPT_NODE];
    }

    // A style picture only the describer sees is left with nothing to read it
    // once the describer is gone, and so is the batch it was in.
    const read = (id: string) =>
      Object.values(graph).some((node) =>
        Object.values(node.inputs).some((value) => Array.isArray(value) && value[0] === id),
      );
    if (graph[BATCH_NODE] && !read(BATCH_NODE)) delete graph[BATCH_NODE];
    for (const node of REF_NODES) {
      if (graph[node] && !read(node)) delete graph[node];
    }
  };

  return { graph, director, ideaParam, plumbing, pictureParams, outputParams, finalize };
}
