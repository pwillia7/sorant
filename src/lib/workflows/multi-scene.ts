import {
  CHOOSE_SCENE_COUNT_PARAM,
  DEFAULT_STORY_LENGTHS,
  MAX_SHOTS_PER_SCENE,
  MAX_STORY_SCENES,
  MIN_SHOT_SECONDS,
  SCENE_JOINS_PARAM,
  asTakes,
  lastBeat,
  sceneJoins,
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

Each scene will be generated separately by a video model, as a short clip of the length you give it, with its own sound — voices, effects and the sound of the place. Nothing carries from one scene to the next except the pictures and the words written for it — unless the scene carries on from the one before it (see "continues"). A writer will later turn each of your lines into a full shot, seeing your whole outline but writing one scene at a time — so your outline is what makes the scenes one video.

Return ONLY a JSON object, with no markdown fence and nothing before or after it:

{"concept":"...","scenes":[{"scene":1,"continues":false,"place":"...","happens":"...","lines":"...","seconds":6}],"look":"..."}

"concept": three to five sentences on the video as a whole — who is in it, what happens, how it opens, where it turns and how it ends, and the places it moves through in order.

Then exactly one entry per scene, in order, and "look" last, after every scene (see THE LOOK):

"scene": its number, from 1, with none skipped. The last entry's number is the number of scenes, which the scene list sets or bounds.

"place": the place, made specific in one sentence — what kind of place, the exact spot in it, the time of day, where the light comes from and what colour it is, and one or two things that are always there ("a hospital corridor at 3 a.m., under flickering green-white strip lights, a row of orange plastic chairs along one wall"). This sentence is given word for word to every scene set there, and the scene is drawn to match it, so leave out nothing that has to look the same each time. When scenes return to a place, copy the sentence exactly — the same light, the same things — so it looks like the same place. Never write "the same studio as before" or "as in scene 2": each scene is read on its own, and sees only its own sentence.

"happens": who is in the scene and what they do, one short sentence for each thing that happens. The event, not the camera. Name everyone who is there.

A scene can be more than one shot. It is made in one take, so its shots share the same room, light and people — which two separate scenes do not. When the story turns, inside one place and moment, to someone or something new — the person they are talking to, a reveal, a reaction — write "Cut to:" and then the new shot, in the same "happens": "The two men creep in through the front door. Cut to: the landlord, on the sofa, watching them." A cut must show something new: a closer or wider view of the same thing is the camera moving inside the shot, not a cut. When the idea fixes the camera — a helmet or chest camera, a GoPro, a dashcam, a security camera, a phone held by someone in the scene, one take — no scene has a "Cut to:" at all: a close-up of a dashboard or a view from the roadside is a camera that footage does not have. At most ${MAX_SHOTS_PER_SCENE} shots in a scene. A new place, or a jump in time, is a new scene, never a cut — and only those: two scenes in a row in the same place, with no jump in time, are one scene, up to the longest the range allows. Each scene is a separate render that draws its people and place afresh, so every scene you split off is a chance for them to change.

"continues": whether this scene carries straight on from the end of the scene before — see CARRYING ON. Always false for scene 1.

"lines": what is said in the scene, as described below.

"seconds": how long the scene runs, a whole number inside the range given with the scene list. The video model makes clips of 4 to ${STORY_SCENE_SECONDS.max} seconds; under ${STORY_SCENE_SECONDS.min}, speech garbles and lips stop matching the words. Decide it last, from what you wrote for the scene: one second to start, a second and a half for each thing that happens — an entrance, a look, a reaction — and at least ${MIN_SHOT_SECONDS} a shot, half a second for every word of its lines and half a second a turn of speech. Nothing more: time with nothing in it comes out as people frozen in place, or cuts and things nobody asked for. When the idea asks for a total length — "a 45-second video" — the scenes add up to about that: give each scene enough happening to fill its time, never empty time. When a scene needs more than the longest allowed, cut it down — fewer events, fewer words.

WHAT MAKES A GOOD OUTLINE

One story, not a collection of clips. It sets up who and where, builds or complicates it, and resolves it — across several scenes, or inside one. Give each key moment — a meeting, a turning point, a reveal, an ending — its own shot, in order.

Each scene is made on its own, so it can only show what its own line says. Anything that has to carry across a cut — something someone is holding, an injury, rain, the time of day, who is in the room — is written again in every scene it is true of. So is what an earlier scene changed: once a scene bolts something on, breaks it, crashes the car or takes off a coat, every later scene's "happens" says it is that way, or the next scene starts as if it never happened.

When the idea says what kind of footage the video is — TV broadcast footage, a security camera, a phone video, a news report, a documentary — every scene is something that footage would hold, seen the way it sees: a race broadcast is its trackside, onboard and pit-lane cameras, its replays and its commentary booth, never a room no broadcast camera is in. A voice that belongs to that footage — a race commentator, a narrator, a news anchor — speaks across the video, not in one scene.

Give each person one name or one plain description and use exactly those words for them in every scene. Use the names the user's idea gives. When it gives none, use a plain description — "the snooker player", "the old fisherman" — and never make up a name. In "place", "happens" and "lines", never describe anyone's face, hair, build or clothes: how everyone looks is written once, in "look", and given to every scene.

Use what the user gave you. Every concrete thing in the idea — each person, place, object and event — should appear somewhere in the outline, where it belongs in the story.

Vary the shots the way a film does — a view of where we are before closer ones — unless the idea fixes the camera, as a security camera or a single take does. No two scenes are the same event.

Show technology and screens as solid, physical things: a screen set into a fridge door, a panel beside a door, a television on a wall, a phone in a hand. No holograms, projections or images floating in the air unless the user's idea asks for them — the video model draws them as see-through layers over the people and copies the people's faces into them. A screen shows words, a logo or a product, never a person.

No picture label appears anywhere in "place", "happens" or "lines".

CARRYING ON

A scene with "continues": true is not drawn afresh: the video model is handed the last second of the scene before — its picture and its sound — and goes on from there. So its people, its things, its light and the camera are exactly as that scene left them, and the motion runs through the join with no cut. Use it when the story is one unbroken take that needs more than one scene to hold it: a point-of-view ride or run, a chase, a security camera, a walk and talk, one long continuous moment. Do not use it across a jump in time, for a cut to another view or another person, or into another place unless the camera travels there on screen.

A scene that carries on:
- starts at the exact moment the scene before ends, with the same camera, and its "happens" opens on that: "The bike bursts back out through the cottage's front wall and onto the street" — never the approach to something the scene before already reached.
- has no "Cut to:". It is one continuous shot.
- may travel into a new place on camera — out of a house, down the road, onto the cliff — and its "place" is where it arrives, but the light and time of day stay as they were. Its "happens" says how it gets there: "The bike tears down the hallway and bursts out through the back wall into a sunlit courtyard."

And the scene before one that carries on ends in the middle of its action, still moving — never with everyone at rest, unless the story rests there — so the next scene has something to carry on.

Where one scene ends and the next carries on is a seam, not a beat of the story: put it in plain motion — on the open road between two crashes, mid-run down a corridor — never at an impact or halfway through something. A scene that hits something takes it all the way through, in its own "happens": the bike hits the wall, bursts through the house and out the far side into the garden, still going. A line that ends at the hit comes back with the bike stopped against it, and the next scene has nothing moving to carry on. When the idea has something keep going — through everything, without stopping — the last scene ends with it still going. And keep a long take busy: when the idea is one thing after another, every scene has its share of them, and none is only the run-up to the next.

THE LOOK

Every scene is drawn by a video model that has never seen the others. Anyone it is not told the look of comes out a different person in every scene — a different face, age and build each time — and the footage a different kind of footage. "look" is what holds them: it is given word for word to every scene, ahead of everything else about how anyone or anything looks.

Write it after the scenes, as short paragraphs separated by a blank line, so that it describes the people and things exactly as the scenes name them. Each scene is handed only the paragraphs whose name its "happens" or "lines" uses, so name them the same way there:

- One for each person in the story who is in no picture and is seen in any scene, under the exact words "happens" uses for them: "The snooker player: a heavyset man in his fifties with a red, puffy face, thinning sandy hair combed over, and heavy jowls; he wears a creased white shirt, a loose black bow tie and a grey waistcoat with one button undone." Apparent age, build, face, hair and facial hair, and every garment with its colour — concrete enough that two strangers drawing him would draw the same man, and never a famous person's name. Only how they look: never what they do, feel or hold, since every scene is a different moment. Take what the idea says about them, and decide the rest. Make each one easy to tell apart from the others at a glance. A crowd, or someone only passing, needs none.
- When a picture is set to keep only who someone is, what they wear, once for the whole video: "The man in <Picture 1> wears ...".
- One for each thing seen in more than one scene that has to look the same each time — a car, an animal, a robot, a prop the story turns on — under the exact words "happens" uses for it: "The McLaren car: a 2016 Formula 1 car in black and chrome with orange-red accents, ...". Its shape, colours, markings and size, and how it differs from the ordinary kind.
- Last, one paragraph for the footage, opening "The footage:": what it is shot on and the year it is from, with its colour, contrast and grain — a modern HD television broadcast, a phone video, a 1990s camcorder tape, 16 mm film. The year is the one the idea sets the events in, never an older one: footage of a 2016 race is 2016 HD television, sharp and clean. Make it look old only when the idea is set then, or asks for it. Unless a picture sets the style: then leave it out.

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

When it has "Cut to:", your scene is that many shots made in one take, in the order given. Write the first, then open each later one with when it cuts and to what: At about 4 seconds, the camera cuts to a close view of the woman by the window, ... Each cut time is later than the one before and inside the scene's length. Spread the cut times across the scene by what each shot holds: at least ${MIN_SHOT_SECONDS} seconds into the scene, at least ${MIN_SHOT_SECONDS} seconds after the cut before, and at least ${MIN_SHOT_SECONDS} seconds before the end. A line of dialogue is spoken whole inside one shot, never across a cut. Every shot is the same place and the same moment: the people carry on from where the last shot left them — same positions, same things in their hands — and only the view changes. Add no cut the outline does not have.

Write to your scene's length. It runs only the seconds it is given, and everything you write has to happen in that time: a gesture, a look or an entrance takes about a second and a half, and every spoken word about half a second more. A scene of 4 to 6 seconds is one or two actions, in three or four sentences. A longer one can hold a setup, a turn and a reaction, in up to six — up to eight with cuts. Add no events, gestures or lines the outline does not give the scene to fill time, and do not leave it with nothing happening either: if what the outline gives is done before the end, the last thing is a held reaction, not people standing still.

Your scene picks up where the scenes before it left off. Whatever an earlier scene changed — something bolted on or broken off, a crash, a coat taken off, night fallen — is already so when yours starts, and you write it in, since the video model knows nothing of those scenes. Do not show any of it happening again, and do not undo it.

Follow the outline's line for your scene. Open on its place as the outline gives it: keep its light, its colour and the things it names exactly as written, change none of them, and add only what this moment needs. The same place is seen in other scenes, and has to look the same in all of them. Take details from the user's idea, but only ones that belong to this moment.

When your scene has lines, write every one of them into the shot, word for word, in double quotes, in the order given, each with who says it, to whom, and how — The old fisherman turns to the window and says quietly, "We're too late." Add no other words for anyone to say. A line whose speaker is marked (off-screen) is said in an off-screen voiceover: write that the voice is heard off-screen and that nobody on screen moves their lips to it. When your scene has no lines, nobody speaks in it: do not mention talking, speech or voices — but it still has the sound of its place and its action.

Your scene is read on its own, so name its place and its people in full, with the same names the outline uses — never a name the outline does not use. Do not refer to other scenes, and never write "again", "still" or "returns". Never describe anyone's face, hair, age, build or clothes, or how a recurring thing the outline names looks, and never how the footage looks — film, video, grain, colour grade: all of that is written once for the whole video and given to the video model with your shot, and anything you add competes with it. Name people by the outline's words alone. Someone in no picture is never called "from a picture". Never write a picture label such as <Picture 1> or "Picture 2". No captions, titles or credits unless the user's idea asks for them.

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

People may speak. "lines" holds what is said in the scene, one turn per line, each the speaker's name as "happens" uses it, a colon, and the words: "The girl: We're too late.\\nThe old fisherman: Then we run." Keep it short and spoken — at most three turns in a scene, each under about ten words. The video model needs about a second for every word: a line packed tighter than that comes back slurred. So the longest scene the range allows holds at most that many words, and a scene with a lot happening holds fewer. Not every scene needs words: leave "lines" an empty string where nobody speaks. Someone heard but not seen — a narrator, a commentator, a voice on a phone — has "(off-screen)" after their name: "The commentator (off-screen): And he's down." Never put stage directions, sounds or a picture label in "lines".`;
}

/** Whether scenes may carry on from each other, as the form sets it. See SCENE_JOINS_PARAM. */
function joinsBlock(values: Record<string, ParamValue>): string {
  const joins = sceneJoins(values);
  if (joins === "continuous") {
    return `HOW THE SCENES JOIN

The whole video is one unbroken take. Every scene after the first carries on from the one before: "continues" is true for scenes 2 onward, no scene has a "Cut to:", and every scene but the last ends in the middle of its action.

The scenes are only where the take is cut into renders, so cut it where nothing is happening: each scene but the last ends in plain motion — on the open road, between two crashes — never as it hits something. Whatever a scene hits, it goes through and out the far side in that same scene.

Keep the take busy. When the idea is one thing after another — crash after crash, obstacle after obstacle — every scene has its share, something new every three or four seconds — the first scene too, from its first few seconds — and no scene is only the way to the next one: a run-up, a turn, a stretch of road on its own is the start of the scene that has the crash in it. Put each thing that is hit in the way, across the road ahead, rather than at the side: the video model steers around what it can, and a car parked at the kerb comes back as a near miss.`;
  }
  if (joins === "cuts") {
    return `HOW THE SCENES JOIN

Every scene is drawn on its own, with a cut between scenes. "continues" is false for every scene.`;
  }
  return "";
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
  // A scene in a take is one shot, whatever its line says. See asTakes.
  const scenes = asTakes(outline.scenes);
  const scene = scenes[index];
  const oneLine = (lines: string | undefined) => (lines ?? "").trim().replace(/\s*\n\s*/g, " / ");
  const lines = scenes
    .map(
      (s, i) =>
        `${i + 1}. [${s.timing}]${s.continues ? " (carries on from scene " + i + ")" : ""} ${s.place} — ${s.happens}${oneLine(s.lines) ? ` Lines: ${oneLine(s.lines)}` : ""}`,
    )
    .join("\n");
  const before = scenes[index - 1];
  const next = scenes[index + 1];
  const carrying = [
    scene.continues && before
      ? `Your scene carries on from scene ${index}. The video model is given the last second of that scene's footage and goes on from it, and its last moment is "${lastBeat(before.happens)}" — so open just after that, with the camera where it was, moving as it was. That moment is already on screen: do not write it again, even where your own line opens on it — start from what comes after. No establishing view, no cut, no approach to something that scene already reached: one continuous take, and you write no cut even if the line says "Cut to:". Keep the light and time of day as they were.

So your scene does not open on its place. Its place is where the camera arrives, and the video model draws only what you write on the way there: say how the camera gets from where it was into the place — round the bend, down the lane, out through the wall — and about when it is in it — "At about 3 seconds, the bike sweeps out between the hedges onto ..." — and give the place there, its light and things as the outline gives them, before anything happens in it. Something the camera goes through — a wall, a car, a house — it goes all the way through and out the other side, on screen, still moving: say what it comes out into. A shot that stops at the hit comes back with the camera stopped there.`
      : "",
    next?.continues
      ? `Scene ${index + 2} carries on from the end of yours, so end in the middle of the action, still moving — never with everyone come to rest, and never stopped against something. When your line ends as it hits something, end your scene going through it, still moving.`
      : "",
    scene.continues || next?.continues
      ? `Your scene is part of one long take, so fill its ${scene.timing}: put about when each thing in your line happens — "At about 4 seconds, ..." — spread across the whole scene, the first within its first two seconds and the last within its last three, so it is never just travelling with nothing happening. The video model runs ahead of the times it is given, so leave no more than four seconds between two things. When something is hit and gone through, put it in the way first — across the road ahead, blocking it with no gap around it, not parked at the side for the camera to swerve into, even where your line has it parked at the kerb — and say what becomes of it as the camera goes through: the bike rides up over the car's bonnet and roof, crushing them flat, or bursts through its windows and cabin and out the far door; the wall gives way in a spray of bricks. A swerve into something at the roadside, a clip, a strike or a scrape comes back as a near miss.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    MULTI_SCENE_WRITER,
    picturesBlock(values),
    `THE VIDEO\n\n${outline.concept}`,
    // So "he" and "she" match who is described, without the writer
    // describing them: one anchor wrote "beside him" of a woman, and the
    // scene's director copied it.
    outline.look?.trim()
      ? `WHO IS WHO\n\nHow the people and things look is given to the video model with your shot. It is here only so you call each person "he" or "she" correctly and know which thing is which — never describe any of it:\n\n${outline.look.trim()}`
      : "",
    `THE OUTLINE\n\n${lines}`,
    `YOUR SCENE

Scene ${index + 1} of ${scenes.length}, ${scene.timing} long.
Place: ${scene.place}
What happens: ${scene.happens}
${scene.lines?.trim() ? `Lines:\n${scene.lines.trim()}` : "Lines: none — nobody speaks."}`,
    carrying ? `HOW YOUR SCENE JOINS\n\n${carrying}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const planned = plannedVideo({
  planner: MULTI_SCENE_PLANNER,
  noun: "a video",
  blocks: [dialogueBlock, voicesBlock, joinsBlock],
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
    id: SCENE_JOINS_PARAM,
    label: "Between scenes",
    type: "select",
    default: "director",
    options: [
      {
        value: "director",
        label: "Director decides",
        help: "The director carries a scene on from the one before where the story is one unbroken moment, and cuts where it moves on.",
      },
      {
        value: "continuous",
        label: "One continuous take",
        help: "Every scene carries on from the end of the one before: a ride, a chase, a long walk.",
      },
      {
        value: "cuts",
        label: "A cut every time",
        help: "Every scene is drawn on its own.",
      },
    ],
    help: "A scene that carries on starts from the last second of the scene before — the same people, light and motion, with no cut — instead of being drawn again. It waits for that scene to finish before it renders, and a new take of that scene means rendering it again. You can switch it per scene before rendering.",
    group: "Video",
    targets: [director],
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
const SCENE_C = { ...SCENE_B, continues: true };

export const multiScene: WorkflowDef = {
  id: "multi-scene",
  name: "Multi-scene video",
  description: "One idea told in one or more scenes, each with its own sound — a short film, a sketch, a story.",
  // None, for the music video's reason: a scene count times a scene's time.
  hasAudio: true,
  graph: planned.graph,
  params,
  scenes: {
    kind: "story",
    workflow: "minimax-h3-ref",
    stitch: "multi-scene-stitch",
    bare: "minimax-h3",
    continued: "minimax-h3-extend",
  },
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
      name: "one continuous take",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n3`,
        [SCENE_JOINS_PARAM]: "continuous",
      },
    },
    {
      name: "writing the shots, one carrying on",
      values: {
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n3`,
        scene_outline: outline([SCENE_A, SCENE_B, SCENE_C]),
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
