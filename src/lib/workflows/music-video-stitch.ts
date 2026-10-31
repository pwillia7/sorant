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
    // A name in output or input, nothing that climbs out of either.
    if (!/^[\w\-./ ]+\.(mp4|webm|mov|mkv)( \[(output|input)\])?$/i.test(file) || file.includes("..")) {
      throw new ParamError("One of the scenes is not a clip this can join.", "scenes");
    }
    if (!(seconds > 0)) {
      throw new ParamError("One of the scenes has no length.", "scenes");
    }
    return { file, seconds };
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
      name: "a scene list that climbs out of the output folder",
      values: { scenes: JSON.stringify([{ file: "../secrets.mp4 [output]", seconds: 4 }]) },
      rejects: "not a clip this can join",
    },
  ],

  finalize(graph, values) {
    parseScenes(values.scenes).forEach((scene, index) => {
      const load = `load_${index}`;
      graph[load] = {
        class_type: "LoadVideo",
        inputs: { file: scene.file },
        _meta: { title: `Load Video (scene ${index + 1})` },
      };
      graph[JOIN_NODE].inputs[`videos.video${index}`] = [load, 0];
    });
  },
};
