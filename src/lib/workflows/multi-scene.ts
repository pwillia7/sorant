import {
  CHOOSE_SCENE_COUNT_PARAM,
  DEFAULT_STORY_LENGTHS,
  MAX_SHOTS_PER_SCENE,
  MAX_STORY_SCENES,
  MIN_SHOT_SECONDS,
  SCENES_HEADING,
  STORY_SCENE_SECONDS,
  type ShotRequest,
} from "@/lib/music-video/scenes";
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

export const MULTI_SCENE_PLANNER = `You are the director of a short video told in one or more scenes, laying out the whole of it before anyone writes a shot.

You are given the user's idea, how many scenes it has — or the most it may have, when the number is yours to choose — and, when there are any, reference pictures.

Each scene will be generated separately by a video model, as a short clip of the length you give it, with its own sound — voices, effects and the sound of the place. Nothing carries from one scene to the next except the pictures and the words written for it. A writer will later turn each of your lines into a full shot, seeing your whole outline but writing one scene at a time — so your outline is what makes the scenes one video.

Return ONLY a JSON object, with no markdown fence and nothing before or after it:

{"concept":"...","scenes":[{"scene":1,"place":"...","happens":"...","lines":"...","seconds":6}],"look":"..."}

"concept": three to five sentences on the video as a whole — who is in it, what happens, how it opens, where it turns and how it ends, and the places it moves through in order.

Then exactly one entry per scene, in order, and "look" last, after every scene (see THE LOOK):

"scene": its number, from 1, with none skipped. The last entry's number is the number of scenes, which the scene list sets or bounds.

"place": the place, made specific in one sentence — what kind of place, the exact spot in it, the time of day, where the light comes from and what colour it is, and one or two things that are always there ("a hospital corridor at 3 a.m., under flickering green-white strip lights, a row of orange plastic chairs along one wall"). This sentence is given word for word to every scene set there, and the scene is drawn to match it, so leave out nothing that has to look the same each time. When scenes return to a place, copy the sentence exactly — the same light, the same things — so it looks like the same place. Never write "the same studio as before" or "as in scene 2": each scene is read on its own, and sees only its own sentence.

"happens": who is in the scene and what they do, one short sentence for each thing that happens. The event, not the camera. Name everyone who is there.

A scene can be more than one shot. It is made in one take, so its shots share the same room, light and people — which two separate scenes do not. When the story turns, inside one place and moment, to someone or something new — the person they are talking to, a reveal, a reaction — write "Cut to:" and then the new shot, in the same "happens": "The two men creep in through the front door. Cut to: the landlord, on the sofa, watching them." At most ${MAX_SHOTS_PER_SCENE} shots in a scene. A new place, or a jump in time, is a new scene, never a cut. And only those: two scenes in a row in the same place, with no jump in time between them, are one scene — write them as one, running as long as both, up to the longest the range allows. Each scene is a separate render that draws its people and its place afresh, so every scene you split off is a chance for them to change. A continuous moment longer than the longest a scene may be is split where it has to be, and nowhere else.

"lines": what is said in the scene, as described below.

"seconds": how long the scene runs, a whole number inside the range given with the scene list. The video model is trained on clips of about ${STORY_SCENE_SECONDS.min} to ${STORY_SCENE_SECONDS.max} seconds. A take that holds several things happening in a row, or cuts, can use up to ${STORY_SCENE_SECONDS.max}; fewer, longer scenes are better than many short ones of the same moment. Shorter than ${STORY_SCENE_SECONDS.min} seconds, speech comes back garbled and lips stop matching the words. Decide it last, from the "happens" and "lines" you have just written for that scene — never pick a length first and fill it. Add up what the scene holds:
- one second to start;
- a second and a half for each thing that happens — someone enters, a door opens, a look, a reaction — and at least ${MIN_SHOT_SECONDS} for each shot;
- half a second for every word of its lines, and half a second for each turn of speech;
- nothing more. Time with nothing in it is not calm on screen: the video model fills it with people standing still, a frozen stare, or cuts and things nobody asked for.
So one action and a five-word line is about five seconds, and a view of a place is the shortest the range allows. The length is checked against this sum and cut down when it is longer. When what you wrote needs more than the longest the range allows, cut the scene down to what fits — fewer events, fewer words. Scenes of a video differ in length; if every scene came out the same, you counted none of them.

WHAT MAKES A GOOD OUTLINE

One story, not a collection of clips. It sets up who and where, builds or complicates it, and resolves it — across several scenes, or inside one. Give each key moment — a meeting, a turning point, a reveal, an ending — its own shot, and tell them in order. A moment in a new place, or later in time, is a new scene; a moment in the same place and moment is a "Cut to:" inside the scene it belongs to.

Each scene is made on its own, so it can only show what its own line says. Anything that has to carry across a cut — something someone is holding, an injury, rain, the time of day, who is in the room — is written again in every scene it is true of.

Give each person one name or one plain description and use exactly those words for them in every scene. Use the names the user's idea gives. When it gives none, use a plain description — "the snooker player", "the old fisherman" — and never make up a name. In "place", "happens" and "lines", never describe anyone's face, hair, build or clothes: how everyone looks is written once, in "look", and given to every scene.

Use what the user gave you. Every concrete thing in the idea — each person, place, object and event — should appear somewhere in the outline, where it belongs in the story.

Vary the shots the way a film does: a view that shows where we are before closer ones on the people in it, quiet scenes against busy ones, and no two scenes that are the same event.

Show technology and screens as solid, physical things: a screen set into a fridge door, a panel beside a door, a television on a wall, a phone in a hand. No holograms, projections or images floating in the air unless the user's idea asks for them — the video model draws them as see-through layers over the people and copies the people's faces into them. A screen shows words, a logo or a product, never a person.

No picture label appears anywhere in "place", "happens" or "lines".

THE LOOK

Every scene is drawn by a video model that has never seen the others. Anyone it is not told the look of comes out a different person in every scene — a different face, age and build each time — and the footage a different kind of footage. "look" is what holds them: it is given word for word to every scene, ahead of everything else about how anyone or anything looks.

Write it after the scenes, as short paragraphs separated by a blank line, so that it describes the people exactly as the scenes name them:

- One for each person in the story who is in no picture and is seen in any scene, under the exact words "happens" uses for them: "The snooker player: a heavyset man in his fifties with a red, puffy face, thinning sandy hair combed over, and heavy jowls; he wears a creased white shirt, a loose black bow tie and a grey waistcoat with one button undone." Apparent age, build, face, hair and facial hair, and every garment with its colour — concrete enough that two strangers drawing him would draw the same man, and never a famous person's name. Only how they look: never what they do, feel or hold, since every scene is a different moment. Take what the idea says about them, and decide the rest. Make each one easy to tell apart from the others at a glance. A crowd, or someone only passing, needs none.
- When a picture is set to keep only who someone is, what they wear, once for the whole video: "The man in <Picture 1> wears ...".
- Last, one paragraph for the footage, opening "The footage:": what it is shot on and when — 1980s broadcast videotape, 16 mm film, a phone video, a modern digital film — with its colour, contrast and grain, from what the idea asks for. Unless a picture sets the style: then leave it out.

Never describe the face, hair or clothes of anyone in a picture that is kept whole: the picture defines them. With no pictures and nobody to describe, "look" is still the footage paragraph.`;

/**
 * One scene's shot, from the outline. A call per scene, for the reasons the
 * music video's writer is one (see SHOT_WRITER there); unlike it, this one
 * carries the scene's lines into the shot word for word, since a shot is all
 * the scene's director is given.
 */
export const MULTI_SCENE_WRITER = `You write one scene of a short video as a direction to a filmmaker.

You are given the user's idea for the whole video, the director's outline of every scene, and which scene is yours. Write only yours. A video model will generate it on its own, with its sound, seeing nothing but your words and the reference pictures.

Return only the shot: full, flowing sentences of plain present-tense English, with no heading, label or list. Cover:
- The place, as the outline gives it: what kind of place it is, the time of day, where the light comes from, and the things in it.
- Who is there and what they do: clear physical actions — what their hands do, what they hold, where they look, how they move.
- The camera: the framing, the angle and at most one move for each shot, in a full sentence of its own wording — never a fragment like "Medium shot, static."
- What the scene sounds like: the sound of the place, and any sound the action makes.

YOUR SCENE'S SHOTS

When your scene's "What happens" has no "Cut to:", it is one continuous shot: write no cut, and say once that the camera stays on one continuous take.

When it has "Cut to:", your scene is that many shots made in one take, in the order given. Write the first, then open each later one with when it cuts and to what: At about 4 seconds, the camera cuts to a close view of the woman by the window, ... Spread the cut times across the scene by what each shot holds: at least ${MIN_SHOT_SECONDS} seconds into the scene, at least ${MIN_SHOT_SECONDS} seconds after the cut before, and at least ${MIN_SHOT_SECONDS} seconds before the end. A line of dialogue is spoken whole inside one shot, never across a cut. Every shot is the same place and the same moment: the people carry on from where the last shot left them — same positions, same things in their hands — and only the view changes. Add no cut the outline does not have.

Write to your scene's length. It runs only the seconds it is given, and everything you write has to happen in that time: a gesture, a look or an entrance takes about a second and a half, and every spoken word about half a second more. A scene of 4 to 6 seconds is one or two actions, in three or four sentences. A longer one can hold a setup, a turn and a reaction, in up to six — up to eight with cuts. Add no events, gestures or lines the outline does not give the scene to fill time, and do not leave it with nothing happening either: if what the outline gives is done before the end, the last thing is a held reaction, not people standing still.

Follow the outline's line for your scene. Open on its place as the outline gives it: keep its light, its colour and the things it names exactly as written, change none of them, and add only what this moment needs. The same place is seen in other scenes, and has to look the same in all of them. Take details from the user's idea, but only ones that belong to this moment.

When your scene has lines, write every one of them into the shot, word for word, in double quotes, in the order given, each with who says it, to whom, and how — The old fisherman turns to the window and says quietly, "We're too late." Add no other words for anyone to say. When your scene has no lines, nobody speaks in it: do not mention talking, speech or voices.

Your scene is read on its own, so name its place and its people in full, with the same names the outline uses — never a name the outline does not use. Do not refer to other scenes, and never write "again", "still" or "returns". Never describe anyone's face, hair, age, build or clothes, and never how the footage looks — film, video, grain, colour grade: all of that is written once for the whole video and given to the video model with your shot, and anything you add competes with it. Name people by the outline's words alone. Someone in no picture is never called "from a picture". Never write a picture label such as <Picture 1> or "Picture 2". No captions, titles or credits unless the user's idea asks for them.

Keep the space between the camera and the people clear. Nothing passes in front of them or sits over them — no glass, smoke, screen, hologram or object crossing the frame — and light falls on them from the place, not from something glowing in front of them. Show technology as solid, physical things: a screen set into a fridge door, a panel beside a door, a television on a wall. Never write a hologram, a projection or an image floating in the air unless the user's idea asks for one: the video model draws it as a see-through layer over the people and copies their faces into it. A screen shows words, a logo or a product, never a person.

Begin with whatever makes the scene vivid — the place, an object, the action — not with the framing.`;

const DIALOGUE_PARAM = "dialogue";

/** Whether anyone speaks, and how lines are written when they do. */
function dialogueBlock(values: Record<string, ParamValue>): string {
  if (values[DIALOGUE_PARAM] === false) {
    return `NO DIALOGUE

Nobody speaks anywhere in this video. Every "lines" is an empty string. Tell it with what people do, the places, and what can be heard — a door, rain, a crowd, music playing in the room.`;
  }
  return `THE LINES

People may speak. "lines" holds what is said in the scene, one turn per line, each the speaker's name as "happens" uses it, a colon, and the words: "The girl: We're too late.\\nThe old fisherman: Then we run." Keep it short and spoken — at most three turns in a scene, each under about ten words. The video model needs about a second for every word: a line packed tighter than that comes back slurred. So the longest scene the range allows holds at most that many words, and a scene with a lot happening holds fewer. Not every scene needs words: leave "lines" an empty string where nobody speaks. Never put stage directions, sounds or a picture label in "lines".`;
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
    hint: "The story, in a sentence or a paragraph — a director splits it into scenes you can edit.",
  }),
  {
    id: CHOOSE_SCENE_COUNT_PARAM,
    label: "Director picks the number of scenes",
    type: "toggle",
    default: true,
    help: "On, the director uses as few scenes as tell the story — just one, a single take with cuts inside it, when the story stays in one place and moment. Off, you set the number of scenes yourself. Either way you see every scene, and can add or remove one, before anything renders.",
    group: "Video",
    scope: "browser",
    targets: [],
  },
  {
    id: "scene_count",
    label: "Scenes",
    type: "slider",
    default: 8,
    min: 1,
    max: MAX_STORY_SCENES,
    step: 1,
    help: "How many scenes the story is told in. Each scene is its own render, so this is what sets how long the whole video takes. The director chooses how long each one is, between the shortest and longest below.",
    group: "Video",
    // The director's own count needs no number from the user.
    hiddenBy: { param: CHOOSE_SCENE_COUNT_PARAM, is: true },
    scope: "browser",
    targets: [],
  },
  {
    id: "scene_min_seconds",
    label: "Shortest scene",
    type: "slider",
    default: DEFAULT_STORY_LENGTHS.min,
    min: STORY_SCENE_SECONDS.min,
    max: 10,
    step: 1,
    unit: "sec",
    help: "No scene is planned shorter than this. The model is trained on about 5 to 15 seconds: shorter, speech garbles and lip sync slips. A scene with lines is made longer if its words need it.",
    group: "Video",
    scope: "browser",
    targets: [],
  },
  {
    id: "scene_max_seconds",
    label: "Longest scene",
    type: "slider",
    default: DEFAULT_STORY_LENGTHS.max,
    min: STORY_SCENE_SECONDS.min,
    max: STORY_SCENE_SECONDS.max,
    step: 1,
    unit: "sec",
    help: "No scene is planned longer than this; the director cuts a scene down to what fits rather than going over. The model's sweet spot is 5 to 10 seconds, and long scenes with little in them come out slow or frozen. A video the director tells in one scene may run up to 15 seconds whatever this says, for a single take with cuts in it.",
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
  // Landscape: a story is a film, a sketch or a broadcast far more often
  // than a phone video, and the 1985 TV segment and the 1970s race that
  // came out portrait looked wrong for it.
  ...planned.outputParams("a video", { aspect: "16:9 (Widescreen)" }),
];

const outline = (scenes: ShotRequest["scenes"], extra: Partial<ShotRequest> = {}) =>
  JSON.stringify({ concept: "x", scenes, ...extra } satisfies ShotRequest);
const SCENE_A = { part: "", sings: false, place: "a", happens: "b", lines: "Mara: Hi.", timing: "8.0 s" };
const SCENE_B = { part: "", sings: false, place: "c", happens: "d", lines: "", timing: "5.0 s" };

export const multiScene: WorkflowDef = {
  id: "multi-scene",
  name: "Multi-scene video",
  description: "One idea told in one or more scenes, each with its own sound — a short film, a sketch, a story.",
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
      name: "the director choosing the count",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\nThe video has as many scenes as its story needs, up to 40 at the very most.`,
        [CHOOSE_SCENE_COUNT_PARAM]: true,
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
      name: "revising the plan to an ask",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n2`,
        reference_image_1: "a.png",
        plan_revision: JSON.stringify({
          ask: "Make it funnier.",
          plan: { concept: "x", scenes: [{ scene: 1, place: "a", happens: "b", lines: "", seconds: 6 }], look: "" },
        }),
      },
    },
    {
      name: "revising one shot to an ask",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n2`,
        scene_outline: outline([SCENE_A, SCENE_B], {
          only: [0],
          take: 3,
          ask: "Make it funnier.",
          current: { 0: "Mara waves." },
        }),
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
