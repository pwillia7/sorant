import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import {
  aspectRatioParam,
  directorTarget,
  leadingReferences,
  lookParam,
  referenceKeep,
  referenceSlot,
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
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * A music video from a whole song and one prompt.
 *
 * This graph only plans. The browser cuts the song into scenes on its beats
 * (src/lib/music-video/), and this graph runs twice: once to outline what
 * happens in each scene, then again with that outline to write each scene's
 * shot, a call per scene (see `SHOT_WRITER`). Then every scene is a Reference
 * to Video run of its own with the song locked
 * in under it, followed by a stitch that joins them and lays the song over the
 * top (music-video-stitch.ts). See `scenes`.
 *
 * Fresh scenes rather than one take extended forty times, which is how the
 * vrgamedevgirl pack's music videos hold together over four minutes: nothing
 * is carried from scene to scene except the references, so there is nothing to
 * drift. What holds the video together is the plan — one story told across the
 * scenes — and the same pictures under every one of them.
 *
 * The planner is shown the references, so it can write scenes for the subject
 * that is actually there, and is told each scene's place in the song and how
 * loud the song is across it. It cannot hear the song; the scene runs can,
 * because the song is in their latents.
 */

const PROMPT_NODE = "1";
const DIRECTOR_NODE = "2";
const BATCH_NODE = "4";
const REF_NODES = ["3", "5", "6", "7"].slice(0, MUSIC_VIDEO_PICTURES);
/** Describes the people in the pictures, from the pictures alone. */
const CAST_NODE = "8";
const CAST_PROMPT_NODE = "9";

const ids: Pick<MinimaxNodeIds, "director"> = { director: DIRECTOR_NODE };

/** How a slot names its input on the batch. Slot 1 is index 0. */
const batchInput = (index: number) => `images.image${index - 1}`;


export const MUSIC_VIDEO_PLANNER = `You are the director of a music video, laying out the whole video against the song before anyone writes a shot.

You are given the user's idea for the video, the scenes the song has already been cut into — each with its place in the song, its length and how loud the song is across it — and, when there are any, reference pictures. You may also be given the song's lyrics.

You cannot hear the song. Each scene will be generated separately by a video model that can: the song is laid under every scene. A writer will later turn each of your lines into a full shot, seeing your whole outline but writing one scene at a time — so your outline is what makes the scenes one video.

Return ONLY a JSON object, with no markdown fence and nothing before or after it:

{"concept":"...","look":"...","scenes":[{"scene":1,"part":"...","sings":false,"place":"...","happens":"..."}]}

"concept": three to five sentences on the video as a whole — what it is about, how it opens, how it builds, how it ends, and the places it moves through in order.

Then exactly one entry per scene you were given, in the same order:

"scene": its number in the scene list. The last entry's number is the number of scenes — no more, no fewer.

"part": where in the song the scene falls — intro, verse, pre-chorus, chorus, bridge, instrumental or outro. Read the lyrics' section labels in order against the scenes' times and loudness: a song usually spends 10 to 20 seconds on an intro, 20 to 40 on a verse and 15 to 30 on a chorus. Without lyrics, judge from loudness and position.

"sings": true only when someone on screen should be singing or rapping in this scene. False in the intro, instrumental breaks and outro, and whenever the subject is busy with something else. Follow the user's idea on how much they perform: when it says "occasionally", most scenes are false.

"place": the place, made specific in a few words — what kind of place, the exact spot in it, the time of day, the light ("the back alley of a laundromat at dusk, under a sodium lamp"). Every scene's place is worded afresh. When several scenes share one world — a city, a house, a game — each names a different spot in it (a rooftop, a kitchen doorway, a flooded underpass) and different light, so that no two places read alike.

"happens": one sentence — what the subject does, and the one thing that makes this scene unlike every other (a prop, a gag, a colour, weather, something behind them). The event, not the camera.

WHAT MAKES A GOOD OUTLINE

One video, not a collection of clips. Its first scenes set up the concept, the middle builds it, and the last ones resolve it. When the idea tells a story, tell that story in order, and give its key moments — a turning point, a reveal, an ending — a scene each.

Use what the user gave you. Every concrete thing in the idea — each place, prop, colour, activity, period detail, gag and supporting character — should appear somewhere in the outline, spread across the scenes rather than piled into one, and none used more than twice.

Follow the song's shape. Quiet scenes are intimate, still or atmospheric; loud ones are big, moving, performed. The choruses are the video's peaks; when a chorus comes back, echo the first one in a new place or a new way.

No two scenes are the same event, and no two place lines are the same words. Unless the idea keeps to one place, use at least four different places across the video and spend no more than three scenes in a row in one of them.

Refer to the subject plainly — "the singer", "the woman", or the name the user gives them — never by a picture label, and never describe their face, hair or clothes.

THE LOOK

How the people in the pictures look is written up separately, from the pictures alone. "look" is only for what a picture releases: when one is set to keep only who someone is, choose what they wear here, once, for the whole video, in one or two concrete sentences ("The man in <Picture 1> wears ..."). When every picture keeps everything, or there are no pictures, "look" is an empty string.`;

/**
 * One scene's shot, from the outline.
 *
 * Its own call per scene, after the plan, rather than every shot in the plan's
 * one reply. Tested on three users' ideas on the local director (2026-10-29):
 * the one long reply got the scene count wrong on four plans in six, wrote
 * shorter shots the further it got into the song, and is the reply that has
 * come back as broken JSON. An outline is a third the length, and a shot
 * written on its own is plain text with nothing to parse. What holds the
 * scenes together is that each writer is shown the whole outline.
 */
export const SHOT_WRITER = `You write one scene of a music video as a direction to a filmmaker.

You are given the user's idea for the whole video, the director's outline of every scene, and which scene is yours. Write only yours. A video model will generate it on its own, seeing nothing but your words, the reference pictures and the song under it.

Return only the shot: three to five full, flowing sentences of plain present-tense English, with no heading, label, list or quotation marks. Cover:
- The place, made specific: what kind of place it is, the time of day, where the light comes from, and two or three concrete things in it.
- What the subject does: one clear physical action — what their hands do, what they hold, where they look, how they move.
- The camera: the framing, the angle and at most one move, in a full sentence of its own wording — never a fragment like "Medium shot, static."
- The one thing the outline gives this scene that no other scene has.

Follow the outline's line for your scene: its place and what happens. The outline's words are notes, not text to copy: describe the place in your own words, with what is there and how it is lit, rather than repeating its line. Take details for it from the user's idea — props, period, effects, how the footage looks — but only ones that belong to this moment. Do not reuse the props, gags or images the outline gives to other scenes.

When your scene sings, say the subject sings or raps, and to whom, with a gesture. When it does not, do not mention singing, rapping, lyrics or their mouth at all.

Your scene is read on its own, so name its place in full. Never write "the same", "again", "still", "now", "returns" or "continues", and do not refer to other scenes. Do not describe anyone's face, hair or clothes: the pictures define them. Refer to the subject plainly — "the singer", "the woman", or the name the user gives them — and never write a picture label such as <Picture 1>. Never write lyrics or dialogue. No captions, titles or credits unless the user's idea asks for them.

Begin with whatever makes the scene vivid — the place, an object, the action, something moving through the frame — not with the framing.`;

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
export const CAST_DESCRIBER = `You describe the people in reference pictures for a music video, so that every scene of it shows them the same way.

You are shown the pictures, in order: <Picture 1>, <Picture 2> and so on. Below, you are told what each one is for.

Return only the description, as plain text with no heading, list or markdown: one short paragraph per picture you are asked to describe, each opening with who it is and which picture — "The man in <Picture 1>: ...".

Be concrete and exact about what you can see: skin, hair and facial hair, build and apparent age; every garment with its colour, pattern and cut; hats, glasses, jewellery and anything carried. Do not spell out lettering or logos: say there is lettering, where, and in what colour. The video model reads the words off the picture itself, and a misreading written here would compete with them in every scene. Describe only what is visible. Do not guess at what is out of frame, and do not name the person, the setting, the mood or the style of the picture.

Describe how they look, never what they are doing. Leave out pose, gesture, expression and where their hands are: every scene is a different moment, and anything you write here is repeated in all of them.

A picture may have no person or character in it at all — a place, a game screen, an object. Write nothing for that picture: no paragraph, and no note that there is nobody in it.`;

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
      style: "a style reference with no one in it to hold. Skip it.",
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
 */
function picturesBlock(values: Record<string, ParamValue>): string {
  const filled = leadingReferences(values, REF_NODES.length);
  const lines: string[] = [];
  for (let index = 1; index <= filled; index += 1) {
    const says = {
      everything: "whoever is in it, kept exactly as they are — face, hair and clothes. Do not describe them.",
      identity:
        "who is in it, kept as they are; what they wear is the video's to choose (see the look).",
      costume: "what is worn in it, put onto whoever the scene casts.",
      style: "a style: how the video looks, not anything in it.",
    }[referenceKeep(values, index)];
    lines.push(`<Picture ${index}>: ${says}`);
  }
  return lines.length
    ? `THE PICTURES

Every scene is given these same pictures.

${lines.join("\n")}

A picture with no one in it shows a place, an object or a look: put what it shows into the scenes where it belongs.`
    : "";
}

/**
 * The lyrics, as context for the plan rather than as anything to perform.
 *
 * The planner does not know when any line is sung — nothing here can hear the
 * song — so it is told they set the subject and the mood, and that the scenes
 * do not carry them.
 */
function lyricsBlock(values: Record<string, ParamValue>): string {
  const lyrics = String(values[LYRICS_PARAM] ?? "").trim();
  if (!lyrics) return "";
  return `THE LYRICS

These are the song's words, for what the song is about and how it feels. You do not know when each line is sung, so do not assign lines to scenes or write them into any shot. Let them shape the concept, the places and the moments.

${lyrics}`;
}

const LYRICS_PARAM = "song_lyrics";

/** The scene list the browser wrote from cutting the song. See `sceneList`. */
const SCENES_PARAM = "scene_list";

/**
 * The outline, handed back once the plan has come in. Set, it makes this run
 * write a shot for every scene instead of planning. See `finalize`.
 */
const OUTLINE_PARAM = "scene_outline";

/** The shot writer's instruction for one scene of an outline. */
function shotSystem(
  outline: ShotRequest,
  index: number,
  values: Record<string, ParamValue>,
): string {
  const scene = outline.scenes[index];
  const lines = outline.scenes
    .map(
      (s, i) =>
        `${i + 1}. [${s.part}${s.sings ? ", sings" : ""}] ${s.place} — ${s.happens}`,
    )
    .join("\n");
  return [
    SHOT_WRITER,
    picturesBlock(values),
    `THE VIDEO\n\n${outline.concept}`,
    `THE OUTLINE\n\n${lines}`,
    `YOUR SCENE

Scene ${index + 1} of ${outline.scenes.length}: ${scene.timing}.
Part: ${scene.part}. Sings: ${scene.sings ? "yes" : "no"}.
Place: ${scene.place}
What happens: ${scene.happens}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

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

/** Last, after the lyrics: it is what the reply has to match one for one. */
const scenesBlock = (values: Record<string, ParamValue>) => String(values[SCENES_PARAM] ?? "");

const graph: ComfyGraph = {
  [PROMPT_NODE]: {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Idea)" },
  },
  [DIRECTOR_NODE]: rewriteNode({
    prompt: [PROMPT_NODE, 0],
    system: MUSIC_VIDEO_PLANNER,
    images: [BATCH_NODE, 0],
    title: `AI Gateway - ${PLAN_BRIEF}`,
    // Every scene of a long song in one reply: forty shots of a hundred-odd
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
    system: CAST_DESCRIBER,
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

const director = directorTarget(
  ids,
  MUSIC_VIDEO_PLANNER,
  [picturesBlock, lyricsBlock, scenesBlock],
  // No length block: the planner is not writing one clip of a known length,
  // and each scene's own length is in the scene list.
  () => "",
);

/** Written by every reference control, from the whole submission. */
const cast = directorTarget({ director: CAST_NODE }, CAST_DESCRIBER, [castBlock], () => "");

const params: ParamDef[] = [
  {
    id: "reference_audio",
    label: "Song",
    type: "audio",
    default: "",
    required: true,
    help: "The whole song. It is cut into scenes on its beats, and each scene is made to its own stretch of it.",
    group: "Song",
    measures: "reference_track_seconds",
    scope: "scenes",
    targets: [],
  },
  {
    id: "reference_track_seconds",
    label: "Song length",
    type: "measured",
    default: 0,
    group: "Song",
    scope: "scenes",
    targets: [],
  },
  {
    id: LYRICS_PARAM,
    label: "Lyrics",
    type: "textarea",
    rows: 6,
    default: "",
    placeholder: "[Verse]\nthe words of the song",
    maxLength: 6000,
    help: "Optional. What the song is about, for the plan — nothing here knows when each line is sung, so they shape the scenes rather than being placed in them.",
    group: "Song",
    targets: [director],
  },
  {
    id: "prompt",
    label: "What the video is",
    type: "textarea",
    rows: 4,
    default: "",
    placeholder: "The singer walks home through a city at night, from an empty train platform to a packed rooftop party.",
    maxLength: 4000,
    help: "One idea for the whole video. A director turns it into a scene for every cut in the song, which you can edit before anything renders.",
    group: "Video",
    targets: [{ node: PROMPT_NODE, input: "value" }],
  },
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
  ...REF_NODES.flatMap((node, position) =>
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
  ),
  {
    id: "scene_min_seconds",
    label: "Shortest scene",
    type: "slider",
    default: 4,
    min: 3,
    max: 10,
    step: 0.5,
    unit: "sec",
    help: "Cuts land on the song's beats somewhere between these two lengths.",
    group: "Video",
    scope: "browser",
    targets: [],
  },
  {
    id: "scene_max_seconds",
    label: "Longest scene",
    type: "slider",
    default: 9,
    min: 4,
    max: 15,
    step: 0.5,
    unit: "sec",
    help: "Longer scenes mean fewer runs, and each one slower. The model's sweet spot is 5 to 10 seconds.",
    group: "Video",
    scope: "browser",
    targets: [],
  },
  { ...lookParam(director), scope: "scenes" },
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
    help: "Per scene. 1 MP takes about three times as long as 0.5 MP, and a song is a dozen or more scenes.",
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
    help: "Per scene. More steps is a slower scene, and a song is a dozen or more of them.",
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

export const musicVideo: WorkflowDef = {
  id: "music-video",
  name: "Music video",
  description: "A whole song and one idea, made into a video scene by scene.",
  // None: what a music video costs is a scene count times a scene's time,
  // which the picker cannot know before the song is cut. Each scene job
  // carries Reference to Video's own estimate.
  hasAudio: true,
  graph,
  params,
  scenes: { workflow: "minimax-h3-ref", stitch: "music-video-stitch" },

  /** A finished song's "Music video" button. Nothing carries: see ClipTarget. */
  clipTarget: {
    action: "musicvideo",
    accepts: "audio",
    sourceParam: "reference_audio",
  },

  finalizeCases: [
    {
      name: "a song and no pictures",
      values: { reference_audio: "song.mp3", prompt: "x", scene_list: `${SCENES_HEADING}\n1.` },
    },
    {
      name: "a song and two pictures",
      values: {
        reference_audio: "song.mp3",
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n1.`,
        reference_image_1: "a.png",
        reference_image_2: "b.png",
      },
    },
    {
      name: "writing the shots, with a picture",
      values: {
        reference_audio: "song.mp3",
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n1.\n2.`,
        reference_image_1: "a.png",
        scene_outline: JSON.stringify({
          concept: "x",
          scenes: [
            { part: "intro", sings: false, place: "a", happens: "b", timing: "0:00.0–0:05.0 (5.0 s), loudness quiet" },
            { part: "chorus", sings: true, place: "c", happens: "d", timing: "0:05.0–0:10.0 (5.0 s), loudness loud" },
          ],
        } satisfies ShotRequest),
      },
    },
    {
      name: "writing the shots, no pictures",
      values: {
        reference_audio: "song.mp3",
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n1.`,
        scene_outline: JSON.stringify({
          concept: "x",
          scenes: [{ part: "intro", sings: false, place: "a", happens: "b", timing: "0:00.0–0:05.0 (5.0 s), loudness quiet" }],
        } satisfies ShotRequest),
      },
    },
  ],

  finalize(graph, values) {
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
    if (!String(values[SCENES_PARAM] ?? "").includes(SCENES_HEADING)) {
      throw new ParamError(
        "The song has not been cut into scenes yet. Load it again and wait for the scene list.",
        "reference_audio",
      );
    }

    // The second run of a plan: the outline has come back, and this one
    // writes each scene's shot from it, a writer per scene. Each is the
    // planner's node over again — the same model, the same pictures, the same
    // idea as its prompt — with its own instruction.
    const outline = readOutline(values);
    if (outline) {
      const template = graph[DIRECTOR_NODE];
      outline.scenes.forEach((_, index) => {
        const node = structuredClone(template);
        node.inputs.system_prompt = shotSystem(outline, index, values);
        // One shot, not a plan.
        node.inputs.max_tokens = 1024;
        node._meta = { title: `AI Gateway - ${SHOT_BRIEF} ${index + 1}` };
        graph[`shot${index + 1}`] = node;
      });
      delete graph[DIRECTOR_NODE];
      // The look was settled with the outline.
      delete graph[CAST_NODE];
      delete graph[CAST_PROMPT_NODE];
    }
  },
};
