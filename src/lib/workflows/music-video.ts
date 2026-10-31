import {
  INSTRUMENTAL_PARAM,
  type ShotRequest,
  SCENES_HEADING,
} from "@/lib/music-video/scenes";
import { picturesBlock, plannedVideo } from "./planned-video";
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

Refer to the subject plainly — "the singer", "the woman", or the name the user gives them — never by a picture label, and never describe their face, hair or clothes. No picture label appears anywhere in "place" or "happens".

THE LOOK

How the people in the pictures look, and the style of any picture there for its style, is written up separately, from the pictures alone. "look" is only for what a picture releases: when one is set to keep only who someone is, choose what they wear here, once, for the whole video, in one or two concrete sentences ("The man in <Picture 1> wears ..."). When every picture keeps everything, or there are no pictures, "look" is an empty string.`;

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
 * The lyrics, as context for the plan rather than as anything to perform.
 *
 * The planner does not know when any line is sung — nothing here can hear the
 * song — so it is told they set the subject and the mood, and that the scenes
 * do not carry them.
 */
function lyricsBlock(values: Record<string, ParamValue>): string {
  const lyrics = String(values[LYRICS_PARAM] ?? "").trim();
  // Hidden behind the switch, but kept: words typed before it was turned on.
  if (!lyrics || values[INSTRUMENTAL_PARAM] === true) return "";
  return `THE LYRICS

These are the song's words, for what the song is about and how it feels. You do not know when each line is sung, so do not assign lines to scenes or write them into any shot. Let them shape the concept, the places and the moments.

${lyrics}`;
}

const LYRICS_PARAM = "song_lyrics";

function instrumentalBlock(values: Record<string, ParamValue>): string {
  if (values[INSTRUMENTAL_PARAM] !== true) return "";
  return `THE SONG IS INSTRUMENTAL

There is no vocal anywhere in this song. Nobody on screen sings, raps or mouths words in any scene, so every "sings" is false, whatever the idea says about performing. "part" follows the music alone. Let the subject carry the song in other ways — how they move, dance, play, travel or react to it.`;
}

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

const planned = plannedVideo({
  planner: MUSIC_VIDEO_PLANNER,
  noun: "a music video",
  blocks: [lyricsBlock, instrumentalBlock],
  shotSystem,
  unplanned: {
    message: "The song has not been cut into scenes yet. Load it again and wait for the scene list.",
    field: "reference_audio",
  },
});
const { director } = planned;

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
    id: INSTRUMENTAL_PARAM,
    label: "Instrumental",
    type: "toggle",
    default: false,
    help: "No vocal in the song: every scene is planned with Sings off, so no one mouths words to it. You can still turn Sings on for a scene in the outline.",
    group: "Song",
    targets: [director],
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
    hiddenBy: { param: INSTRUMENTAL_PARAM, is: true },
    targets: [director],
  },
  planned.ideaParam({
    placeholder: "The singer walks home through a city at night, from an empty train platform to a packed rooftop party.",
    help: "One idea for the whole video. A director turns it into a scene for every cut in the song, which you can edit before anything renders.",
  }),
  ...planned.plumbing,
  ...planned.pictureParams,
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
  ...planned.outputParams("a song"),
];

export const musicVideo: WorkflowDef = {
  id: "music-video",
  name: "Music video",
  description: "A whole song and one idea, made into a video scene by scene.",
  // None: what a music video costs is a scene count times a scene's time,
  // which the picker cannot know before the song is cut. Each scene job
  // carries Reference to Video's own estimate.
  hasAudio: true,
  graph: planned.graph,
  params,
  scenes: { kind: "music", workflow: "minimax-h3-ref", stitch: "music-video-stitch" },

  // Writing shots is a minute of text, and a rewrite is asked for while the
  // video's own scenes may be queued: neither should wait behind them.
  jumpsQueue: (values) => String(values.scene_outline ?? "").trim() !== "",

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
      name: "rewriting one shot",
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
          only: [1],
          take: 7,
        } satisfies ShotRequest),
      },
    },
    {
      name: "a style picture before a person",
      values: {
        reference_audio: "song.mp3",
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n1.`,
        reference_image_1: "a.png",
        reference_1_keep: "style",
        reference_image_2: "b.png",
      },
    },
    {
      name: "writing the shots, only a style picture",
      values: {
        reference_audio: "song.mp3",
        prompt: "x",
        scene_list: `${SCENES_HEADING}\n1.`,
        reference_image_1: "a.png",
        reference_1_keep: "style",
        scene_outline: JSON.stringify({
          concept: "x",
          scenes: [{ part: "intro", sings: false, place: "a", happens: "b", timing: "0:00.0–0:05.0 (5.0 s), loudness quiet" }],
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

  finalize: planned.finalize,
};
