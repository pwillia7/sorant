import { SCENES_HEADING, type ShotRequest } from "@/lib/music-video/scenes";
import { picturesBlock, plannedVideo } from "./planned-video";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * A video told in several scenes, from one idea and no song: a short film, a
 * sketch, an ad, a story.
 *
 * The music video's machinery with the song taken out (see planned-video.ts).
 * The planner chooses how long each scene runs, as well as what happens in it
 * and what is said, and every scene keeps the sound H3 makes for it —
 * dialogue, effects, the room — so the join lays the scenes' own audio end to
 * end rather than one track over the top (multi-scene-stitch.ts).
 *
 * The same pictures go under every scene unless a scene is given its own, and
 * so do up to two voice recordings: a voice is how two scenes of one person
 * sound like one person, which nothing written can do. Like the pictures, a
 * scene can have voices of its own — the voice of someone who appears only
 * there, or none, for a scene its speakers are not in. A scene with neither
 * pictures nor voices renders as Text to Video, since Reference to Video
 * refuses a run with nothing to build from. See `scenes.bare`.
 */

export const MULTI_SCENE_PLANNER = `You are the director of a short video told in several scenes, laying out the whole of it before anyone writes a shot.

You are given the user's idea, how many scenes it has, and, when there are any, reference pictures.

Each scene will be generated separately by a video model, as a clip of 4 to 15 seconds with its own sound — voices, effects and the sound of the place. Nothing carries from one scene to the next except the pictures and the words written for it. A writer will later turn each of your lines into a full shot, seeing your whole outline but writing one scene at a time — so your outline is what makes the scenes one video.

Return ONLY a JSON object, with no markdown fence and nothing before or after it:

{"concept":"...","look":"...","scenes":[{"scene":1,"seconds":8,"place":"...","happens":"...","lines":"..."}]}

"concept": three to five sentences on the video as a whole — who is in it, what happens, how it opens, where it turns and how it ends, and the places it moves through in order.

Then exactly one entry per scene, in order:

"scene": its number. The last entry's number is the number of scenes — no more, no fewer.

"seconds": how long the scene runs, a whole number from 4 to 15. Give each scene the time its action and its words need, and no more: a view of a place or a single look is 4 to 6; one clear action is 6 to 9; a short exchange of lines is 8 to 13. Speech runs at about two and a half words a second, with a beat before the first line and after the last.

"place": the place, made specific in a few words — what kind of place, the exact spot in it, the time of day, the light ("a hospital corridor at 3 a.m., under flickering strip lights"). When scenes return to a place, use the same words for it each time, so it looks like the same place.

"happens": one or two sentences — who is in the scene and what they do. The event, not the camera. Name everyone who is there.

"lines": what is said in the scene, as described below.

WHAT MAKES A GOOD OUTLINE

One story, not a collection of clips. The first scenes set up who and where, the middle ones build or complicate it, and the last ones resolve it. Give each key moment — a meeting, a turning point, a reveal, an ending — a scene of its own, and tell them in order.

Each scene is made on its own, so it can only show what its own line says. Anything that has to carry across a cut — something someone is holding, an injury, rain, the time of day, who is in the room — is written again in every scene it is true of.

Give each person one short name, or one plain description ("Mara", "the old fisherman"), and use exactly those words for them in every scene. Never describe their face, hair or clothes: the pictures, or the shots, define them.

Use what the user gave you. Every concrete thing in the idea — each person, place, object and event — should appear somewhere in the outline, where it belongs in the story.

Vary the scenes the way a film does: a scene that shows where we are before scenes close on the people in it, quiet scenes against busy ones, and no two scenes that are the same event.

No picture label appears anywhere in "place", "happens" or "lines".

THE LOOK

How the people in the pictures look, and the style of any picture there for its style, is written up separately, from the pictures alone. "look" is only for what a picture releases: when one is set to keep only who someone is, choose what they wear here, once, for the whole video, in one or two concrete sentences ("The man in <Picture 1> wears ..."). When every picture keeps everything, or there are no pictures, "look" is an empty string.`;

/**
 * One scene's shot, from the outline. A call per scene, for the reasons the
 * music video's writer is one (see SHOT_WRITER there); unlike it, this one
 * carries the scene's lines into the shot word for word, since a shot is all
 * the scene's director is given.
 */
export const MULTI_SCENE_WRITER = `You write one scene of a short video as a direction to a filmmaker.

You are given the user's idea for the whole video, the director's outline of every scene, and which scene is yours. Write only yours. A video model will generate it on its own, with its sound, seeing nothing but your words and the reference pictures.

Return only the shot: three to six full, flowing sentences of plain present-tense English, with no heading, label or list. Cover:
- The place, made specific: what kind of place it is, the time of day, where the light comes from, and two or three concrete things in it.
- Who is there and what they do: clear physical actions — what their hands do, what they hold, where they look, how they move.
- The camera: the framing, the angle and at most one move, in a full sentence of its own wording — never a fragment like "Medium shot, static."
- What the scene sounds like: the sound of the place, and any sound the action makes.

Follow the outline's line for your scene. Its words are notes, not text to copy: describe the place in your own words, with what is there and how it is lit. Take details from the user's idea, but only ones that belong to this moment.

When your scene has lines, write every one of them into the shot, word for word, in double quotes, in the order given, each with who says it, to whom, and how — Mara turns to the window and says quietly, "We're too late." Add no other words for anyone to say. When your scene has no lines, nobody speaks in it: do not mention talking, speech or voices.

Your scene is read on its own, so name its place and its people in full, with the same names the outline uses. Do not refer to other scenes, and never write "again", "still" or "returns". Do not describe anyone's face, hair or clothes: the pictures define them. Never write a picture label such as <Picture 1>. No captions, titles or credits unless the user's idea asks for them.

Begin with whatever makes the scene vivid — the place, an object, the action, something moving through the frame — not with the framing.`;

const DIALOGUE_PARAM = "dialogue";

/** Whether anyone speaks, and how lines are written when they do. */
function dialogueBlock(values: Record<string, ParamValue>): string {
  if (values[DIALOGUE_PARAM] === false) {
    return `NO DIALOGUE

Nobody speaks anywhere in this video. Every "lines" is an empty string. Tell it with what people do, the places, and what can be heard — a door, rain, a crowd, music playing in the room.`;
  }
  return `THE LINES

People may speak. "lines" holds what is said in the scene, one turn per line, each the speaker's name as "happens" uses it, a colon, and the words: "Mara: We're too late.\\nJon: Then we run." Keep it short and spoken — at most three turns in a scene, each under about twelve words, and never more words than the scene's seconds hold at two and a half a second. Not every scene needs words: leave "lines" an empty string where nobody speaks. Never put stage directions, sounds or a picture label in "lines".`;
}

/** Who the voice recordings belong to, so their lines are written for them by name. */
function voicesBlock(values: Record<string, ParamValue>): string {
  if (values[DIALOGUE_PARAM] === false) return "";
  const owners = [
    ["reference_voice", "reference_voice_owner"],
    ["reference_voice_2", "reference_voice_2_owner"],
  ]
    .filter(([audio]) => String(values[audio] ?? "").trim())
    .map(([, owner]) => String(values[owner] ?? "").trim())
    .filter(Boolean);
  if (owners.length === 0) return "";
  return `THE VOICES

There are recordings of how ${owners.length > 1 ? "these people sound" : "this person sounds"}: ${owners.join("; ")}. Give them lines under those same names, so each line is spoken in the right voice. In a scene where two of them speak, say in "happens" which of them speaks first.`;
}

/** The writer's instruction for one scene of a multi-scene outline. */
function shotSystem(
  outline: ShotRequest,
  index: number,
  values: Record<string, ParamValue>,
): string {
  const scene = outline.scenes[index];
  const oneLine = (lines: string | undefined) => (lines ?? "").trim().replace(/\s*\n\s*/g, " / ");
  const lines = outline.scenes
    .map(
      (s, i) =>
        `${i + 1}. [${s.timing}] ${s.place} — ${s.happens}${oneLine(s.lines) ? ` Lines: ${oneLine(s.lines)}` : ""}`,
    )
    .join("\n");
  return [
    MULTI_SCENE_WRITER,
    picturesBlock(values),
    `THE VIDEO\n\n${outline.concept}`,
    `THE OUTLINE\n\n${lines}`,
    `YOUR SCENE

Scene ${index + 1} of ${outline.scenes.length}, ${scene.timing} long.
Place: ${scene.place}
What happens: ${scene.happens}
${scene.lines?.trim() ? `Lines:\n${scene.lines.trim()}` : "Lines: none — nobody speaks."}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const planned = plannedVideo({
  planner: MULTI_SCENE_PLANNER,
  noun: "a video",
  blocks: [dialogueBlock, voicesBlock],
  shotSystem,
  unplanned: {
    message: "The scenes have not been counted yet. Press Plan again.",
    field: "prompt",
  },
});
const { director } = planned;

/** A voice recording's controls, under Reference to Video's ids. See SceneVoice. */
function voiceParams(slot: 1 | 2): ParamDef[] {
  const base = slot === 1 ? "reference_voice" : "reference_voice_2";
  const revealedBy = slot === 1 ? base : ["reference_voice", base];
  return [
    {
      id: base,
      label: slot === 1 ? "Voice" : "Second voice",
      type: "audio",
      default: "",
      compact: true,
      help:
        slot === 1
          ? "Optional. A recording of how someone in the video sounds, so they sound the same in every scene. 4–6 seconds of it are used — one person, talking steadily, no music or other voices."
          : "Optional. A voice for a second person. With two, each scene gives the first line to whoever the lines say speaks first.",
      group: "Voices",
      noun: "voice recording",
      limitNote: "Up to 100 MB, at least 4 seconds long. Only 4–6 seconds of it is used.",
      measures: `${base}_length`,
      revealedBy: slot === 1 ? undefined : "reference_voice",
      scope: "scenes",
      // The planner is told whose voice it is, not what it sounds like: it
      // cannot hear it.
      targets: [director],
    },
    {
      id: `${base}_owner`,
      label: "Whose voice",
      type: "text",
      default: "",
      placeholder: slot === 1 ? "Mara" : "the old fisherman",
      maxLength: 200,
      help: "Who speaks with it, by the name the idea uses for them. Their lines get this voice and nobody else's do.",
      group: "Voices",
      revealedBy,
      scope: "scenes",
      targets: [director],
    },
    {
      id: `${base}_start`,
      label: "Start at",
      type: "number",
      default: 0,
      min: 0,
      max: 3600,
      step: 0.5,
      unit: "sec",
      help: "Where in the recording its few seconds are taken from: the cleanest stretch of steady speech.",
      group: "Voices",
      revealedBy,
      scope: "scenes",
      targets: [],
    },
    {
      id: `${base}_seconds`,
      label: "Seconds to use",
      type: "slider",
      default: 5,
      min: 4,
      max: 6,
      step: 0.5,
      unit: "sec",
      help: "How much of it the model hears: 4 to 6 seconds. Longer makes the recording bleed into the new speech.",
      group: "Voices",
      revealedBy,
      advanced: true,
      scope: "scenes",
      targets: [],
    },
    {
      id: `${base}_length`,
      label: slot === 1 ? "Voice length" : "Second voice length",
      type: "measured",
      default: 0,
      group: "Voices",
      scope: "scenes",
      targets: [],
    },
  ];
}

const params: ParamDef[] = [
  planned.ideaParam({
    placeholder:
      "Two kids find a lost robot dog in a junkyard, sneak it home past their mother, and lose it again to the men who come looking for it.",
    help: "The story, in a sentence or a paragraph. A director splits it into scenes and writes each one, which you can edit before anything renders.",
  }),
  {
    id: "scene_count",
    label: "Scenes",
    type: "slider",
    default: 6,
    min: 2,
    max: 40,
    step: 1,
    help: "How many scenes the story is told in. The director chooses how long each one is, 4 to 15 seconds, so six scenes is roughly 45 seconds to a minute.",
    group: "Video",
    scope: "browser",
    targets: [],
  },
  {
    id: DIALOGUE_PARAM,
    label: "Dialogue",
    type: "toggle",
    default: true,
    help: "Off for a video nobody speaks in: told with action and sound alone. On, the director writes lines where a scene needs them, and you can change any of them before rendering.",
    group: "Video",
    targets: [director],
  },
  ...planned.plumbing,
  ...planned.pictureParams,
  ...voiceParams(1),
  ...voiceParams(2),
  ...planned.outputParams("a video"),
];

const outline = (scenes: ShotRequest["scenes"], extra: Partial<ShotRequest> = {}) =>
  JSON.stringify({ concept: "x", scenes, ...extra } satisfies ShotRequest);
const SCENE_A = { part: "", sings: false, place: "a", happens: "b", lines: "Mara: Hi.", timing: "8.0 s" };
const SCENE_B = { part: "", sings: false, place: "c", happens: "d", lines: "", timing: "5.0 s" };

export const multiScene: WorkflowDef = {
  id: "multi-scene",
  name: "Multi-scene video",
  description: "One idea told in several scenes, each with its own sound — a short film, a sketch, a story.",
  // None, for the music video's reason: a scene count times a scene's time.
  hasAudio: true,
  graph: planned.graph,
  params,
  scenes: { kind: "story", workflow: "minimax-h3-ref", stitch: "multi-scene-stitch", bare: "minimax-h3" },
  jumpsQueue: (values) => String(values.scene_outline ?? "").trim() !== "",

  finalizeCases: [
    {
      name: "no pictures",
      values: { prompt: "x", scene_list: `${SCENES_HEADING}\n6` },
    },
    {
      name: "two pictures and a voice",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n6`,
        reference_image_1: "a.png",
        reference_image_2: "b.png",
        reference_voice: "v.mp3",
        reference_voice_owner: "Mara",
      },
    },
    {
      name: "no dialogue",
      values: { prompt: "x", scene_list: `${SCENES_HEADING}\n6`, [DIALOGUE_PARAM]: false },
    },
    {
      name: "writing the shots, with a picture",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n2`,
        reference_image_1: "a.png",
        scene_outline: outline([SCENE_A, SCENE_B]),
      },
    },
    {
      name: "rewriting one shot",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n2`,
        scene_outline: outline([SCENE_A, SCENE_B], { only: [1], take: 7 }),
      },
    },
    {
      name: "writing the shots, only a style picture",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n1`,
        reference_image_1: "a.png",
        reference_1_keep: "style",
        scene_outline: outline([SCENE_A]),
      },
    },
    {
      name: "a run before the scenes were counted",
      values: { prompt: "x" },
      rejects: "have not been counted",
    },
  ],

  finalize: planned.finalize,
};
