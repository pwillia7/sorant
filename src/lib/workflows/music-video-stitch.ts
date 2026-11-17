import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * Joins a music video's scenes and lays the song over them, on the box.
 *
 * Core ComfyUI does this without decoding the scenes into memory:
 * `ConcatenateVideo` joins encoded clips as they are, `VideoTrim` cuts each to
 * its window, and `complete_audio` replaces the scenes' own sound with one
 * read of the song from the top — so there is no seam in the audio however
 * the picture is cut. A song's worth of scenes as decoded frames would be tens
 * of gigabytes; this is a remux and a few short trims.
 *
 * Every scene came back on H3's frame grid, a little longer than its window,
 * so each is trimmed to its window before the join, and the scenes then tile
 * the song exactly.
 *
 * The scenes are read where they were saved — `LoadVideo` takes an
 * `[output]`-annotated name — so nothing is copied first.
 *
 * Not in the picker: the music video's panel queues it once every scene is
 * done. See src/lib/music-video/.
 */

const SONG_NODE = "song";
const SONG_TRIM_NODE = "song_trim";
const JOIN_NODE = "join";
const LIST_NODE = "scenes";

/** At most as many scenes as `ConcatenateVideo` takes. */
export const MAX_SCENES = 100;

export interface StitchScene {
  /** The clip, as `LoadVideo` reads it: "video/name.mp4 [output]". */
  file: string;
  /** How much of it to keep, from its first frame. */
  seconds: number;
  /**
   * Another clip whose sound this scene carries instead of its own, for a
   * multi-scene join. See `multiSceneStitch`.
   */
  sound?: string;
}

/** A name in output or input, nothing that climbs out of either. */
function isClipName(file: string): boolean {
  return /^[\w\-./ ]+\.(mp4|webm|mov|mkv)( \[(output|input)\])?$/i.test(file) && !file.includes("..");
}

/** The scene list as the browser sends it. */
export function parseScenes(value: ParamValue | undefined): StitchScene[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? "[]"));
  } catch {
    throw new ParamError("The scene list is not readable.", "scenes");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ParamError("There are no scenes to join.", "scenes");
  }
  if (parsed.length > MAX_SCENES) {
    throw new ParamError(`At most ${MAX_SCENES} scenes can be joined.`, "scenes");
  }
  return parsed.map((scene) => {
    const file = String((scene as StitchScene)?.file ?? "");
    const seconds = Number((scene as StitchScene)?.seconds);
    const sound = (scene as StitchScene)?.sound;
    if (!isClipName(file) || (sound !== undefined && !isClipName(String(sound)))) {
      throw new ParamError("One of the scenes is not a clip this can join.", "scenes");
    }
    if (!(seconds > 0)) {
      throw new ParamError("One of the scenes has no length.", "scenes");
    }
    return sound === undefined ? { file, seconds } : { file, seconds, sound: String(sound) };
  });
}

const graph: ComfyGraph = {
  // The list itself, kept as text in the graph: nothing reads it at run time —
  // `finalize` builds a loader and a trim per scene from it — but it is how the
  // history records what was joined.
  [LIST_NODE]: {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "[]" },
    _meta: { title: "Scenes" },
  },
  [SONG_NODE]: {
    class_type: "LoadAudio",
    inputs: { audio: "" },
    _meta: { title: "Load Audio (song)" },
  },
  [SONG_TRIM_NODE]: {
    class_type: "TrimAudioDuration",
    inputs: { audio: [SONG_NODE, 0], start_index: 0, duration: 60 },
    _meta: { title: "Trim Audio Duration (the song, to the video)" },
  },
  [JOIN_NODE]: {
    class_type: "ConcatenateVideo",
    inputs: { codec: "auto", complete_audio: [SONG_TRIM_NODE, 0] },
    _meta: { title: "Concatenate Video" },
  },
  save: {
    class_type: "SaveVideo",
    inputs: {
      video: [JOIN_NODE, 0],
      filename_prefix: "video/music_video",
      format: "auto",
      codec: "auto",
    },
    _meta: { title: "Save Video" },
  },
};

const params: ParamDef[] = [
  {
    id: "scenes",
    label: "Scenes",
    type: "textarea",
    default: "[]",
    maxLength: 20000,
    group: "Scenes",
    targets: [{ node: LIST_NODE, input: "value" }],
  },
  {
    id: "song",
    label: "Song",
    type: "audio",
    default: "",
    required: true,
    group: "Scenes",
    targets: [{ node: SONG_NODE, input: "audio" }],
  },
  {
    id: "song_seconds",
    label: "Song length",
    type: "number",
    default: 60,
    min: 1,
    max: 3600,
    step: 0.001,
    unit: "sec",
    group: "Scenes",
    targets: [{ node: SONG_TRIM_NODE, input: "duration" }],
  },
];

export const musicVideoStitch: WorkflowDef = {
  id: "music-video-stitch",
  name: "Music video",
  description: "Joins a music video's scenes and lays the song over them.",
  estimatedSeconds: 30,
  hasAudio: true,
  tool: true,
  graph,
  params,

  finalizeCases: [
    {
      name: "three scenes",
      values: {
        song: "song.mp3",
        song_seconds: 14.8,
        scenes: JSON.stringify([
          { file: "video/a.mp4 [output]", seconds: 4.5 },
          { file: "video/b.mp4 [output]", seconds: 6.1 },
          { file: "video/c.mp4 [output]", seconds: 4.2 },
        ]),
      },
    },
    {
      name: "a scene list that climbs out of the output folder",
      values: {
        song: "song.mp3",
        scenes: JSON.stringify([{ file: "../secrets.mp4 [output]", seconds: 4 }]),
      },
      rejects: "not a clip this can join",
    },
  ],

  finalize(graph, values) {
    parseScenes(values.scenes).forEach((scene, index) => {
      const load = `load_${index}`;
      const trim = `trim_${index}`;
      graph[load] = {
        class_type: "LoadVideo",
        inputs: { file: scene.file },
        _meta: { title: `Load Video (scene ${index + 1})` },
      };
      graph[trim] = {
        class_type: "VideoTrim",
        inputs: {
          video: [load, 0],
          // The widget's own shape: a window from the first frame.
          trim: { trim: { start_time: 0, duration: scene.seconds } },
          strict_duration: false,
        },
        _meta: { title: `Video Trim (scene ${index + 1})` },
      };
      graph[JOIN_NODE].inputs[`videos.video${index}`] = [trim, 0];
    });
  },
};

/**
 * Joins a multi-scene video's scenes with the sound each one was made with.
 *
 * No song: `ConcatenateVideo` without `complete_audio` carries every scene's
 * own track, decoded and written again as one. And no trims — a multi-scene
 * scene is run at a length H3 makes exactly (see `storySeconds`), so the clip
 * is the scene. A trim is a re-encode of each scene's sound on its own,
 * which is the step FFmpeg's AAC encoder once aborted in (see `silentCopy`
 * in the music video's hook), so leaving it out is one fewer.
 *
 * Every scene has to have sound for this — the node refuses a mix of clips
 * with and without — and every H3 run has.
 *
 * A scene with a `sound` clip carries that clip's sound instead: the Upscale
 * workflow's copies of a long swap's segments come back with each one's sound
 * 4–19 ms short of its picture (VHS drops the last part-block of AAC), and
 * laid end to end those gaps were a stutter at every join and a soundtrack
 * 0.6 s ahead of the picture by the end of a 52-segment swap (2026-11-17). So
 * the upscaled join takes each segment's sound from the take it upscaled,
 * whose sound is its picture's length. `LoadAudio` keeps a file's AAC end
 * padding, about 17 ms that FFmpeg would strip, so each is trimmed to the
 * scene's length before they are joined into one track for `complete_audio`.
 * It is all scenes or none: a track only part made of `sound` clips would
 * have nothing to fill the rest.
 */
const ownSoundGraph: ComfyGraph = {
  [LIST_NODE]: graph[LIST_NODE],
  [JOIN_NODE]: {
    class_type: "ConcatenateVideo",
    inputs: { codec: "auto" },
    _meta: { title: "Concatenate Video" },
  },
  save: {
    class_type: "SaveVideo",
    inputs: {
      video: [JOIN_NODE, 0],
      filename_prefix: "video/multi_scene",
      format: "auto",
      codec: "auto",
    },
    _meta: { title: "Save Video" },
  },
};

export const multiSceneStitch: WorkflowDef = {
  id: "multi-scene-stitch",
  name: "Multi-scene video",
  description: "Joins a multi-scene video's scenes, each with its own sound.",
  estimatedSeconds: 30,
  hasAudio: true,
  tool: true,
  graph: ownSoundGraph,
  params: [params[0]],

  finalizeCases: [
    {
      name: "three scenes",
      values: {
        scenes: JSON.stringify([
          { file: "video/a.mp4 [output]", seconds: 8.04 },
          { file: "video/b.mp4 [output]", seconds: 5.04 },
          { file: "video/c-audio.mp4 [output]", seconds: 12.04 },
        ]),
      },
    },
    {
      name: "one scene",
      values: { scenes: JSON.stringify([{ file: "video/a-audio.mp4 [output]", seconds: 12.04 }]) },
    },
    {
      name: "upscaled scenes with their takes' sound",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "video/a.mp4 [output]" },
          { file: "video/b-audio.mp4 [output]", seconds: 4.25, sound: "video/b.mp4 [output]" },
          { file: "video/c-audio.mp4 [output]", seconds: 2.5, sound: "video/c.mp4 [output]" },
        ]),
      },
    },
    {
      name: "one upscaled scene with its take's sound",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "video/a.mp4 [output]" },
        ]),
      },
    },
    {
      name: "only some scenes with another clip's sound",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "video/a.mp4 [output]" },
          { file: "video/b-audio.mp4 [output]", seconds: 4.25 },
        ]),
      },
      rejects: "every scene takes its sound",
    },
    {
      name: "a sound clip that climbs out of the output folder",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "../secrets.mp4 [output]" },
        ]),
      },
      rejects: "not a clip this can join",
    },
    {
      name: "a scene list that climbs out of the output folder",
      values: { scenes: JSON.stringify([{ file: "../secrets.mp4 [output]", seconds: 4 }]) },
      rejects: "not a clip this can join",
    },
  ],

  finalize(graph, values) {
    const scenes = parseScenes(values.scenes);
    const withSound = scenes.filter((scene) => scene.sound !== undefined).length;
    if (withSound > 0 && withSound < scenes.length) {
      throw new ParamError("Either every scene takes its sound from another clip, or none does.", "scenes");
    }
    let soundtrack: [string, number] | null = null;
    scenes.forEach((scene, index) => {
      const load = `load_${index}`;
      graph[load] = {
        class_type: "LoadVideo",
        inputs: { file: scene.file },
        _meta: { title: `Load Video (scene ${index + 1})` },
      };
      graph[JOIN_NODE].inputs[`videos.video${index}`] = [load, 0];

      if (scene.sound === undefined) return;
      const sound = `sound_${index}`;
      const trim = `sound_trim_${index}`;
      graph[sound] = {
        class_type: "LoadAudio",
        inputs: { audio: scene.sound },
        _meta: { title: `Load Audio (scene ${index + 1})` },
      };
      graph[trim] = {
        class_type: "TrimAudioDuration",
        inputs: { audio: [sound, 0], start_index: 0, duration: scene.seconds },
        _meta: { title: `Trim Audio Duration (scene ${index + 1})` },
      };
      if (soundtrack === null) {
        soundtrack = [trim, 0];
        return;
      }
      const joined = `sound_join_${index}`;
      graph[joined] = {
        class_type: "AudioConcat",
        inputs: { audio1: soundtrack, audio2: [trim, 0], direction: "after" },
        _meta: { title: `Audio Concat (to scene ${index + 1})` },
      };
      soundtrack = [joined, 0];
    });
    if (soundtrack) graph[JOIN_NODE].inputs.complete_audio = soundtrack;
  },
};
